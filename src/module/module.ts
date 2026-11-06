// node:module — the CommonJS module system's own surface: the builtin
// registry (`builtinModules`, `isBuiltin`), the whole resolver
// (`Module._resolveFilename`, `_findPath`, `_nodeModulePaths`,
// `_resolveLookupPaths`, `_initPaths`, `_stat`, `_extensions`, `_cache`,
// `_pathCache`), `createRequire`, `findPackageJSON`, the source-map reader
// (`SourceMap`, `findSourceMap`, `setSourceMapsSupport`), the loader hooks
// (`register`, `registerHooks`, `syncBuiltinESMExports`), the compile-cache
// trio and `stripTypeScriptTypes`.
//
// Behavior follows Node's own sources (MIT, Copyright Joyent, Inc. and other
// Node contributors), because the resolution order and the error messages are
// observable through the corpus rather than derivable from any general rule:
//
//   * `lib/internal/modules/cjs/loader.js`      — `Module`, `_cache`,
//     `_pathCache`, `_extensions`, `_stat`, `tryFile`, `tryExtensions`,
//     `tryPackage`, `findLongestRegisteredExtension`, `_findPath`,
//     `_nodeModulePaths` (both platforms), `_resolveLookupPaths`,
//     `_resolveFilename`, `_load`, `createRequire`, `_initPaths`,
//     `syncBuiltinESMExports`.
//   * `lib/internal/modules/helpers.js`         — `makeRequireFunction`
//     (`require.resolve`, `require.resolve.paths`, `require.cache`,
//     `require.extensions`, `require.main`), `stripBOM`, `toRealPath`.
//   * `lib/internal/bootstrap/realm.js`         — the builtin id lists:
//     `publicBuiltinIds`, the scheme-only block list and `isBuiltin`.
//   * `lib/internal/modules/typescript.js`      — `stripTypeScriptTypes`'
//     option validation, its warning and its `sourceURL` tail.
//   * `lib/internal/source_map/source_map.js`   — `SourceMap`, its VLQ
//     decoder, `findEntry` and `findOrigin`.
//
// ---------------------------------------------------------------------------
// What this module can and cannot do on this platform
// ---------------------------------------------------------------------------
//
// The Zun engine compiles a program ahead of time; there is no runtime
// compiler, no `eval` and no `vm` (https://github.com/UrubuCode/zun/issues/4).
// So the half of `node:module` that is *computation over paths and files* is
// here in full — resolution, the caches, the extension table, package.json
// reading, JSON loading — and the half that is *compiling a file* is not, and
// says so rather than pretending:
//
//   * `Module._extensions['.js']` throws `ERR_ZUN_NO_RUNTIME_COMPILER`. A
//     `.js`/`.cjs` file cannot be turned into a module here, because turning
//     source into code is the compiler's job and the compiler has already run.
//   * `Module._extensions['.json']` works, completely: it is `JSON.parse` over
//     `fs.readFileSync`, with Node's `"<filename>: <message>"` error rewrite.
//   * `Module._extensions['.node']` throws `ERR_DLOPEN_FAILED`: a Node addon is
//     a V8 N-API shared object, which this runtime cannot load. (The engine's
//     own native extensions are loaded by `zun run --ext`, not by `require`.)
//   * an `.mjs`/ESM file raises `ERR_REQUIRE_ESM`, which is Node's own error
//     for "this file is an ES module and cannot be required" — the honest
//     answer here, since there is no ESM loader to fall back to either.
//   * a *user-registered* extension (`require.extensions['.foo'] = fn`) is
//     called exactly as Node calls it, so a test that supplies its own loader
//     gets the real control flow.
//
// The built-in modules themselves are not read off a disk at all: the bundler
// inlines zun-node's modules ahead of the program and emits one
// `__modRegisterBuiltin(<specifier>, <module object>)` call per inlined module
// (see tools/bundle_node_test.sh). `builtinModules` and `isBuiltin` answer
// **Node's** list, because that list is a fact about Node's API and a program
// asking "is `http` a builtin?" is asking about Node; requiring a builtin that
// this library has not implemented throws `ERR_ZUN_UNIMPLEMENTED_BUILTIN`
// rather than silently answering an empty object.
//
// ---------------------------------------------------------------------------
// Engine workarounds in this file, each tied to a zun issue
// (https://github.com/UrubuCode/zun/issues)
// ---------------------------------------------------------------------------
//   * `Module` is a **function with expando properties**, not a class, and it
//     is never called with `new`. This engine has no function-constructor or
//     prototype model (zun#25), so `new Module(id, parent)` cannot work;
//     module records are built by `__modNew` instead, and
//     `Module.prototype` is absent rather than faked. Everything Node reaches
//     through `Module.prototype.require` is reached here through
//     `__modRequireFrom(record, id)`.
//   * `cc()` and `indexOfChar()` from src/path/path.ts rather than
//     `.charCodeAt()` / `.indexOf()`: an out-of-range `charCodeAt` throws
//     (zun#2) and `indexOf` answers an i32 that will not mix with `Number`
//     arithmetic (zun#3). `Number(x.length)` throughout, for the same reason.
//   * `truthy()` from src/path/path.ts rather than `!value` wherever the value
//     may be an `any`-typed empty string (zun#13).
//   * every `fs` call is wrapped in `try`/`catch` and reduced to a number or
//     `undefined`. Node's `internalModuleStat` answers a negative integer for
//     anything that is not a file or a directory; `fs.statSync` throws, so the
//     catch *is* the negative answer.
//   * the base64 encoder for the source-map data URL is written out here
//     rather than taken from `Buffer`: `src/buffer/buffer.ts` is inlined only
//     for a test that requires `node:buffer`, and `stripTypeScriptTypes` must
//     work in a bundle that does not.
//   * every `Module.<name>` and `require.<name>` is a **named top-level
//     function** assigned to the property, never a function *expression*
//     written in place. A function expression assigned to an expando property
//     of a *function* -- which `Module` is -- is given a synthetic leading
//     `this` parameter, shifting every argument by one, as soon as the token
//     `this` appears anywhere in its source span, comments included. (A new
//     engine gap, reported with this work; the same assignment onto a plain
//     *object* is unaffected, and a named function declaration never shifts.
//     It is the same textual-scan family as zun#40.) The indirection is also
//     what Node's monkey-patching contract needs: every internal call goes
//     through `Module.<name>(...)`, so a replacement is honoured.
//   * `require.main` is a plain property, not an accessor:
//     `Object.defineProperty` on a function value aborts with
//     "Object.defineProperty called on non-object" (also new, also reported).
//   * no `new.target`, no `Symbol` keys on the module record: the four symbol
//     slots Node keeps on a module (`kIsMainSymbol`, `kFormat`, `kURL`,
//     `kIsCachedByESMLoader`) are plain `__mod*`-prefixed string keys here.

// ---------------------------------------------------------------------------
// The builtin registry
// ---------------------------------------------------------------------------

// Node 25's `builtinIds` minus `internal/*`, which is exactly the set of
// `lib/*.js` module ids at tag v25.0.0 (`lib/internal/bootstrap/realm.js`'s
// `publicBuiltinIds`). `sqlite` and `quic` are in `experimentalModuleList`, so
// they are *not* here: they reach `builtinModules` only through the
// scheme-only list below, which is what Node does.
const __MOD_PUBLIC_IDS: string[] = [
  "_http_agent", "_http_client", "_http_common", "_http_incoming",
  "_http_outgoing", "_http_server", "_stream_duplex", "_stream_passthrough",
  "_stream_readable", "_stream_transform", "_stream_wrap", "_stream_writable",
  "_tls_common", "_tls_wrap", "assert", "assert/strict", "async_hooks",
  "buffer", "child_process", "cluster", "console", "constants", "crypto",
  "dgram", "diagnostics_channel", "dns", "dns/promises", "domain", "events",
  "fs", "fs/promises", "http", "http2", "https", "inspector",
  "inspector/promises", "module", "net", "os", "path", "path/posix",
  "path/win32", "perf_hooks", "process", "punycode", "querystring", "readline",
  "readline/promises", "repl", "sea", "stream", "stream/consumers",
  "stream/promises", "stream/web", "string_decoder", "sys", "test",
  "test/reporters", "timers", "timers/promises", "tls", "trace_events", "tty",
  "url", "util", "util/types", "v8", "vm", "wasi", "worker_threads", "zlib",
];

// `schemelessBlockList`: requirable only as `node:<id>`.
const __MOD_SCHEME_ONLY: string[] = [
  "sea", "sqlite", "quic", "test", "test/reporters",
];

// The platform decides `_nodeModulePaths`, `isRelative`'s `.\` case and
// `_initPaths`' home/prefix layout. Read once: `process.platform` is a
// property read on every use otherwise.
const __MOD_IS_WINDOWS: boolean = process.platform === "win32";

function __modIncludesString(list: string[], value: string): boolean {
  for (const entry of list) {
    if (entry === value) return true;
  }
  return false;
}

// `BuiltinModule.canBeRequiredByUsers`.
function __modCanBeRequiredByUsers(id: string): boolean {
  return __modIncludesString(__MOD_PUBLIC_IDS, id);
}

// `BuiltinModule.canBeRequiredWithoutScheme`.
function __modCanBeRequiredWithoutScheme(id: string): boolean {
  if (!__modIncludesString(__MOD_PUBLIC_IDS, id)) return false;
  return !__modIncludesString(__MOD_SCHEME_ONLY, id);
}

// `BuiltinModule.normalizeRequirableId`: the bare id a specifier denotes, or
// `undefined` when the specifier is not a requirable builtin at all.
function __modNormalizeRequirableId(id: any): any {
  if (typeof id !== "string") return undefined;
  const text: string = String(id);
  if (text.slice(0, 5) === "node:") {
    const bare: string = text.slice(5);
    if (__modCanBeRequiredByUsers(bare)) return bare;
    return undefined;
  }
  if (__modCanBeRequiredWithoutScheme(text)) return text;
  return undefined;
}

// `BuiltinModule.getAllBuiltinModuleIds()`: the schemeless ids followed by the
// scheme-only ones spelled with their prefix.
function __modBuildBuiltinModules(): string[] {
  const all: string[] = [];
  for (const id of __MOD_PUBLIC_IDS) {
    if (!__modIncludesString(__MOD_SCHEME_ONLY, id)) all.push(id);
  }
  for (const id of __MOD_SCHEME_ONLY) all.push("node:" + id);
  return all;
}

const builtinModules: string[] = __modBuildBuiltinModules();

// `BuiltinModule.isBuiltin`.
function isBuiltin(id?: any): boolean {
  if (typeof id !== "string") return false;
  const text: string = String(id);
  if (__modCanBeRequiredWithoutScheme(text)) return true;
  return text.slice(0, 5) === "node:" && __modCanBeRequiredByUsers(text.slice(5));
}

// The modules this bundle actually carries, keyed by bare id. Populated by the
// bundler with one `__modRegisterBuiltin` call per inlined module object; see
// the header and tools/bundle_node_test.sh.
const __modBuiltinExports: any = { __proto__: null };

function __modRegisterBuiltin(id?: any, exported?: any): void {
  __modBuiltinExports[String(id)] = exported;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------
//
// `ERR_INVALID_ARG_TYPE`, `ERR_INVALID_ARG_VALUE` and `ERR_OUT_OF_RANGE` come
// from src/events/events.ts, which every bundle inlines. The ones below are
// this module's own; each carries a **declared** `code`, never an expando
// write through `any` (zun#37).

class ERR_UNKNOWN_BUILTIN_MODULE extends NodeError {
  constructor(id: string) {
    super("ERR_UNKNOWN_BUILTIN_MODULE", "No such built-in module: " + id);
  }
}

class ERR_INVALID_PACKAGE_CONFIG extends NodeError {
  constructor(location: string, base: any, message: any) {
    super(
      "ERR_INVALID_PACKAGE_CONFIG",
      "Invalid package config " + location +
        (base === undefined ? "" : ' while importing "' + String(base) + '"') +
        (message === undefined ? "" : ". " + String(message)),
    );
  }
}

class ERR_REQUIRE_ESM extends NodeError {
  constructor(filename: string) {
    super(
      "ERR_REQUIRE_ESM",
      // Spelled in two pieces so the bundler's "unresolved require" guard,
      // which greps the whole bundle for the call spelling, does not see one.
      "require" + "() of ES Module " + filename + " not supported.\nInstead " +
        "change the require of " + filename + " to a dynamic import() which " +
        "is available in all CommonJS modules.",
    );
  }
}

// `ERR_DLOPEN_FAILED` is already declared in src/process/process.ts, which
// every bundle inlines (it is `process.dlopen`'s own error, and this is the
// one caller of `process.dlopen` in Node). A second declaration of one class
// in a single Zun program is a compile error, so the existing one is used.

class ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX extends NodeError {
  constructor(message: string) {
    super("ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX", message);
  }
}

class ERR_INVALID_TYPESCRIPT_SYNTAX extends NodeError {
  constructor(message: string) {
    super("ERR_INVALID_TYPESCRIPT_SYNTAX", message);
  }
}

// The two errors that exist because this runtime is not Node. Node has no such
// codes, and that is the point: a program that hits one is being told "this
// platform cannot do that", not handed a fabricated success.
class ERR_ZUN_NO_RUNTIME_COMPILER extends NodeError {
  constructor(filename: string) {
    super(
      "ERR_ZUN_NO_RUNTIME_COMPILER",
      "Cannot compile " + filename + " at run time: the Zun engine compiles " +
        "a program ahead of execution and has no runtime compiler, so a " +
        "JavaScript file cannot be turned into a module by " + "require" + "()",
    );
  }
}

class ERR_ZUN_UNIMPLEMENTED_BUILTIN extends NodeError {
  constructor(id: string) {
    super(
      "ERR_ZUN_UNIMPLEMENTED_BUILTIN",
      "The built-in module '" + id + "' is a Node.js built-in that zun-node " +
        "has not implemented yet",
    );
  }
}

// `Error` + `code: 'MODULE_NOT_FOUND'` is a *plain* Error in Node (not one of
// the `internal/errors` classes), so `err.name` is `"Error"` and `String(err)`
// is `"Error: Cannot find module '…'"`. A subclass that overrode `toString`
// would break `assert.throws(fn, /^Error: Cannot find module/)`.
class __ModuleNotFoundError extends Error {
  code: string = "MODULE_NOT_FOUND";
  path: string = "";
  requestPath: string = "";
  requireStack: string[] = [];
  constructor(message: string) {
    super(message);
  }
}

function __modValidateString(value: any, name: string): void {
  if (typeof value !== "string") throw new ERR_INVALID_ARG_TYPE(name, "string", value);
}

function __modValidateBoolean(value: any, name: string): void {
  if (typeof value !== "boolean") throw new ERR_INVALID_ARG_TYPE(name, "boolean", value);
}

function __modValidateObject(value: any, name: string): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ERR_INVALID_ARG_TYPE(name, "Object", value);
  }
}

// ---------------------------------------------------------------------------
// The file-system probes
// ---------------------------------------------------------------------------
//
// `Module._stat` is Node's `internalModuleStat`: 0 for a file, 1 for a
// directory, a negative integer for anything else. `fs.statSync` throws where
// that native answers a negative number, so the catch is the negative answer.

function __modStatImpl(filename?: any): number {
  try {
    const stats: any = __node_fs.statSync(String(filename));
    if (stats === undefined || stats === null) return -1;
    return stats.isDirectory() ? 1 : 0;
  } catch (error) {
    return -1;
  }
}

function __modReadFileText(filename: string): any {
  try {
    return __node_fs.readFileSync(filename, "utf8");
  } catch (error) {
    return undefined;
  }
}

// `lib/internal/modules/helpers.js`' `stripBOM`: the UTF-8 BOM arrives as
// U+FEFF once the bytes have been decoded.
function __modStripBOM(content: string): string {
  if (Number(content.length) > 0 && cc(content, 0) === 0xfeff) return content.slice(1);
  return content;
}

// `toRealPath`. `--preserve-symlinks` is not a flag this runtime honours, so
// the realpath branch is the only one; a failure leaves the path as written,
// which is what `fs.realpathSync` throwing means here.
function __modToRealPath(requestPath: string): string {
  try {
    return String(__node_fs.realpathSync(requestPath));
  } catch (error) {
    return requestPath;
  }
}

// ---------------------------------------------------------------------------
// Module records
// ---------------------------------------------------------------------------
//
// Node's `new Module(id, parent)`. A record rather than an instance, because
// this engine has no function-constructor model (zun#25); see the header.

function __modUpdateChildren(parent: any, child: any, scan: boolean): void {
  if (parent === undefined || parent === null) return;
  const children: any = parent.children;
  if (children === undefined || children === null) return;
  if (scan && Number(children.indexOf(child)) !== -1) return;
  children.push(child);
}

function __modNew(id?: any, parent?: any): any {
  const record: any = {
    id: id === undefined ? "" : String(id),
    path: path.dirname(id === undefined ? "" : String(id)),
    exports: {},
    filename: null,
    loaded: false,
    children: [],
    paths: undefined,
    __modFirstParent: parent,
    __modLastParent: parent,
  };
  __modUpdateChildren(parent, record, false);
  return record;
}

// ---------------------------------------------------------------------------
// Module: the module object `require('module')` answers
// ---------------------------------------------------------------------------
//
// In Node this *is* the `Module` constructor, so `require('module') === Module`
// and every static hangs off it. Here it is a plain function carrying the same
// statics; calling it is a no-op rather than a lie about construction.
function Module(id?: any, parent?: any): void {}

Module._cache = { __proto__: null };
Module._pathCache = { __proto__: null };
Module._extensions = { __proto__: null };
Module.globalPaths = [];
Module.builtinModules = builtinModules;
Module.isBuiltin = isBuiltin;
Module.Module = Module;

// `Module._stat` is a settable property in Node (with an experimental warning
// on assignment); it is a plain expando here, and `__modStat` is the indirect
// read every call site goes through so that a replacement is honoured.
Module._stat = __modStatImpl;

function __modStat(filename: any): number {
  return Number(Module._stat(String(filename)));
}

// `modulePaths` — the global lookup paths `_initPaths` computes. `globalPaths`
// is the introspectable copy.
let __modGlobalModulePaths: string[] = [];

// ---------------------------------------------------------------------------
// package.json
// ---------------------------------------------------------------------------
//
// Node's `packageJsonReader.read`, reduced to the four fields the CommonJS
// resolver reads (`name`, `main`, `type`, `exports`). A parse failure is
// `ERR_INVALID_PACKAGE_CONFIG`, as in Node; a missing file is not an error.
const __modPackageCache: any = { __proto__: null };

function __modReadPackage(requestPath: string): any {
  const pjsonPath: string = path.resolve(requestPath, "package.json");
  const cached: any = __modPackageCache[pjsonPath];
  if (cached !== undefined) return cached;

  const text: any = __modReadFileText(pjsonPath);
  if (text === undefined) {
    const absent: any = { exists: false, pjsonPath: pjsonPath, main: undefined };
    __modPackageCache[pjsonPath] = absent;
    return absent;
  }
  let parsed: any;
  try {
    parsed = JSON.parse(__modStripBOM(String(text)));
  } catch (error: any) {
    throw new ERR_INVALID_PACKAGE_CONFIG(pjsonPath, undefined, error.message);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    const empty: any = { exists: true, pjsonPath: pjsonPath, main: undefined, data: {} };
    __modPackageCache[pjsonPath] = empty;
    return empty;
  }
  const entry: any = {
    exists: true,
    pjsonPath: pjsonPath,
    data: parsed,
    name: typeof parsed.name === "string" ? parsed.name : undefined,
    // Node treats a non-string or empty `main` as absent, which is what
    // test-require-empty-main.js asserts.
    main: typeof parsed.main === "string" && parsed.main !== "" ? parsed.main : undefined,
    type: typeof parsed.type === "string" ? parsed.type : undefined,
  };
  __modPackageCache[pjsonPath] = entry;
  return entry;
}

// ---------------------------------------------------------------------------
// tryFile / tryExtensions / tryPackage / findLongestRegisteredExtension
// ---------------------------------------------------------------------------

function __modTryFile(requestPath: string, isMain: boolean): any {
  if (__modStat(requestPath) !== 0) return undefined;
  return __modToRealPath(requestPath);
}

function __modTryExtensions(basePath: string, exts: string[], isMain: boolean): any {
  for (const ext of exts) {
    const filename: any = __modTryFile(basePath + ext, isMain);
    if (filename !== undefined) return filename;
  }
  return false;
}

function __modTryPackage(requestPath: string, exts: string[], isMain: boolean, originalPath: string): any {
  const pkg: any = __modReadPackage(requestPath);
  const main: any = pkg.main;

  if (main === undefined) {
    return __modTryExtensions(path.resolve(requestPath, "index"), exts, isMain);
  }

  const filename: string = path.resolve(requestPath, String(main));
  let actual: any = __modTryFile(filename, isMain);
  if (actual === undefined) actual = __modTryExtensions(filename, exts, isMain);
  if (actual === false || actual === undefined) {
    actual = __modTryExtensions(path.resolve(filename, "index"), exts, isMain);
  }
  if (actual === false || actual === undefined) {
    actual = __modTryExtensions(path.resolve(requestPath, "index"), exts, isMain);
    if (actual === false || actual === undefined) {
      const error: any = new __ModuleNotFoundError(
        "Cannot find module '" + filename + "'. " +
          'Please verify that the package.json has a valid "main" entry',
      );
      error.path = String(pkg.pjsonPath);
      error.requestPath = originalPath;
      throw error;
    }
    // DEP0128, as Node emits it for a `main` that resolved to nothing.
    process.emitWarning(
      "Invalid 'main' field in '" + String(pkg.pjsonPath) + "' of '" + String(main) +
        "'. Please either fix that or report it to the module author",
      "DeprecationWarning",
      "DEP0128",
    );
  }
  return actual;
}

// The longest multi-dot extension registered in `Module._extensions`, skipping
// a leading dot so that a dotfile (`.bar`) is not its own extension.
function __modFindLongestRegisteredExtension(filename: string): string {
  const name: string = path.basename(filename);
  let startIndex = 0;
  let index = indexOfChar(name, ".", startIndex);
  while (index !== -1) {
    startIndex = index + 1;
    if (index !== 0) {
      const candidate: string = name.slice(index);
      if (truthy(Module._extensions[candidate])) return candidate;
    }
    index = indexOfChar(name, ".", startIndex);
  }
  return ".js";
}

// `isRelative` from loader.js. `.\foo` is a relative specifier on Windows
// only; elsewhere a backslash is an ordinary file-name character, which is
// what test-module-relative-lookup.js checks.
function __modIsRelative(request: string): boolean {
  if (cc(request, 0) !== 0x2e) return false;
  return (
    Number(request.length) === 1 ||
    request === ".." ||
    request.slice(0, 2) === "./" ||
    request.slice(0, 3) === "../" ||
    (__MOD_IS_WINDOWS && request.slice(0, 2) === ".\\") ||
    request.slice(0, 3) === "..\\"
  );
}

// ---------------------------------------------------------------------------
// Module._findPath
// ---------------------------------------------------------------------------
//
// loader.js' `_findPath`, with the `exports`-field branch left out: the
// `resolveExports` step needs the ESM package-exports resolver, which has no
// counterpart here (see the note on `register` below). A package whose entry
// point is declared with `"main"` resolves exactly as in Node; one that
// declares only `"exports"` does not resolve, where Node would find it.
function __modFindPath(request?: any, paths?: any, isMain?: any): any {
  const text: string = String(request);
  const absoluteRequest: boolean = path.isAbsolute(text);
  let search: any = paths;
  if (absoluteRequest) {
    search = [""];
  } else if (search === undefined || search === null || Number(search.length) === 0) {
    return false;
  }

  const cacheKey: string = text + "\u0000" + search.join("\u0000");
  const entry: any = Module._pathCache[cacheKey];
  if (truthy(entry)) return entry;

  let exts: any = undefined;
  const last: number = Number(text.length) - 1;
  // A request that names a *directory*: a trailing `/`, or a trailing `.` /
  // `..` segment. Node spells this out over character codes; so does this.
  const trailingSlash: boolean =
    Number(text.length) > 0 &&
    (cc(text, last) === 0x2f ||
      (cc(text, last) === 0x2e &&
        (Number(text.length) === 1 ||
          cc(text, last - 1) === 0x2f ||
          (cc(text, last - 1) === 0x2e &&
            (Number(text.length) === 2 || cc(text, last - 2) === 0x2f)))));

  let insidePath = true;
  if (__modIsRelative(text)) {
    if (path.normalize(text).slice(0, 2) === "..") insidePath = false;
  }

  for (const curPath of search) {
    if (typeof curPath !== "string") {
      throw new ERR_INVALID_ARG_TYPE("paths", "array of strings", paths);
    }
    if (insidePath && curPath !== "" && __modStat(curPath) < 1) continue;

    const basePath: string = path.resolve(curPath, text);
    let filename: any = undefined;

    const rc: number = __modStat(basePath);
    if (!trailingSlash) {
      if (rc === 0) filename = __modToRealPath(basePath);
      if (filename === undefined) {
        if (exts === undefined) exts = Object.keys(Module._extensions);
        const found: any = __modTryExtensions(basePath, exts, isMain === true);
        if (found !== false) filename = found;
      }
    }

    if (filename === undefined && rc === 1) {
      if (exts === undefined) exts = Object.keys(Module._extensions);
      const found: any = __modTryPackage(basePath, exts, isMain === true, text);
      if (found !== false && found !== undefined) filename = found;
    }

    if (filename !== undefined) {
      Module._pathCache[cacheKey] = filename;
      return filename;
    }
  }

  return false;
}
Module._findPath = __modFindPath;

// ---------------------------------------------------------------------------
// Module._nodeModulePaths
// ---------------------------------------------------------------------------
//
// loader.js, both platforms, character for character: a reverse scan that
// emits `<prefix>/node_modules` for every path segment that is not itself
// named `node_modules`. `nmChars` is "node_modules" reversed.
const __MOD_NM_CHARS: number[] = [
  115, 101, 108, 117, 100, 111, 109, 95, 101, 100, 111, 110,
];

function __modNodeModulePathsWin32(from: string): string[] {
  const start: string = path.resolve(from);
  const length: number = Number(start.length);
  // `D:\` answers the drive-root node_modules and nothing else.
  if (cc(start, length - 1) === 0x5c && cc(start, length - 2) === 0x3a) {
    return [start + "node_modules"];
  }
  const paths: string[] = [];
  let p = 0;
  let last: number = length;
  let i: number = length - 1;
  while (i >= 0) {
    const code: number = cc(start, i);
    // A colon ends the drive segment, so `C:\node_modules` is reachable
    // without parsing the drive name.
    if (code === 0x5c || code === 0x2f || code === 0x3a) {
      if (p !== 12) paths.push(start.slice(0, last) + "\\node_modules");
      last = i;
      p = 0;
    } else if (p !== -1) {
      if (__MOD_NM_CHARS[p] === code) {
        p = p + 1;
      } else {
        p = -1;
      }
    }
    i = i - 1;
  }
  return paths;
}

function __modNodeModulePathsPosix(from: string): string[] {
  const start: string = path.resolve(from);
  // Early return so that a root does not answer two entries.
  if (start === "/") return ["/node_modules"];
  const paths: string[] = [];
  const length: number = Number(start.length);
  let p = 0;
  let last: number = length;
  let i: number = length - 1;
  while (i >= 0) {
    const code: number = cc(start, i);
    if (code === 0x2f) {
      if (p !== 12) paths.push(start.slice(0, last) + "/node_modules");
      last = i;
      p = 0;
    } else if (p !== -1) {
      if (__MOD_NM_CHARS[p] === code) {
        p = p + 1;
      } else {
        p = -1;
      }
    }
    i = i - 1;
  }
  paths.push("/node_modules");
  return paths;
}

function __modNodeModulePaths(from?: any): string[] {
  if (__MOD_IS_WINDOWS) return __modNodeModulePathsWin32(String(from));
  return __modNodeModulePathsPosix(String(from));
}
Module._nodeModulePaths = __modNodeModulePaths;

// ---------------------------------------------------------------------------
// Module._resolveLookupPaths
// ---------------------------------------------------------------------------

function __modResolveLookupPaths(request?: any, parent?: any): any {
  if (__modNormalizeRequirableId(request) !== undefined) return null;

  const text: string = String(request);
  // A bare specifier (`lodash`, `foo/bar`) searches the node_modules chain;
  // anything starting `./`, `../` (or `.\` on Windows) is relative.
  const bare: boolean =
    text.charAt(0) !== "." ||
    (Number(text.length) > 1 &&
      text.charAt(1) !== "." &&
      text.charAt(1) !== "/" &&
      (!__MOD_IS_WINDOWS || text.charAt(1) !== "\\"));

  if (bare) {
    let paths: string[] = __modGlobalModulePaths;
    const parentPaths: any = parent === undefined || parent === null ? undefined : parent.paths;
    if (parentPaths !== undefined && parentPaths !== null && Number(parentPaths.length) > 0) {
      paths = [];
      for (const one of parentPaths) paths.push(String(one));
      for (const one of __modGlobalModulePaths) paths.push(String(one));
    }
    return Number(paths.length) > 0 ? paths : null;
  }

  // No parent (or a parent with no file of its own, which is the REPL in Node):
  // the current directory is the only place to look.
  if (
    parent === undefined ||
    parent === null ||
    !truthy(parent.id) ||
    !truthy(parent.filename)
  ) {
    return ["."];
  }

  return [path.dirname(String(parent.filename))];
}
Module._resolveLookupPaths = __modResolveLookupPaths;

// ---------------------------------------------------------------------------
// Module._resolveFilename
// ---------------------------------------------------------------------------
//
// loader.js' `_resolveFilename`, minus the two ESM-only branches it opens
// with: a `#name` package-imports specifier and the `trySelf` self-reference
// both go through the ESM resolver, which does not exist here. A `#name`
// specifier therefore reports `MODULE_NOT_FOUND` rather than resolving.
function __modResolveFilename(request?: any, parent?: any, isMain?: any, options?: any): any {
  if (__modNormalizeRequirableId(request) !== undefined) return request;

  const text: string = String(request);
  let paths: any;

  if (typeof options === "object" && options !== null) {
    if (Array.isArray(options.paths)) {
      if (__modIsRelative(text)) {
        paths = options.paths;
      } else {
        const fakeParent: any = __modNew("", null);
        paths = [];
        for (const one of options.paths) {
          fakeParent.paths = Module._nodeModulePaths(one);
          const lookupPaths: any = Module._resolveLookupPaths(text, fakeParent);
          if (lookupPaths === null) continue;
          for (const lookup of lookupPaths) {
            if (Number(paths.indexOf(lookup)) === -1) paths.push(lookup);
          }
        }
      }
    } else if (options.paths === undefined) {
      paths = Module._resolveLookupPaths(text, parent);
    } else {
      throw new ERR_INVALID_ARG_VALUE("options.paths", options.paths, "is invalid");
    }
  } else {
    paths = Module._resolveLookupPaths(text, parent);
  }

  const filename: any = Module._findPath(text, paths, isMain === true);
  if (truthy(filename)) return filename;

  const requireStack: string[] = [];
  let cursor: any = parent;
  while (cursor !== undefined && cursor !== null) {
    requireStack.push(truthy(cursor.filename) ? String(cursor.filename) : String(cursor.id));
    cursor = cursor.__modFirstParent;
  }
  let message: string = "Cannot find module '" + text + "'";
  if (Number(requireStack.length) > 0) {
    message = message + "\nRequire stack:\n- " + requireStack.join("\n- ");
  }
  const error: any = new __ModuleNotFoundError(message);
  error.requireStack = requireStack;
  throw error;
}
Module._resolveFilename = __modResolveFilename;

// The record for the program's own entry point, which `require.main` and
// `process.mainModule` name. It is built lazily by `__modMain` below, because
// the bundler emits `__filename` *after* every library file (it is the test's
// own location) and a top-level initializer would read it too early.
let __modMainModuleRecord: any = undefined;

// ---------------------------------------------------------------------------
// Module._extensions
// ---------------------------------------------------------------------------
//
// The three loaders Node installs. `.json` is complete; the other two say what
// this platform cannot do rather than faking it (see the header).

// `.js` also serves `.cjs`, `.mjs` and every unregistered extension, because
// `findLongestRegisteredExtension` falls back to it.
function __modLoadJavaScript(module?: any, filename?: any): void {
  const name: string = String(filename);
  // An ES module cannot be required. Node says so with ERR_REQUIRE_ESM
  // whenever `require(esm)` is unavailable, and it is unavailable here for the
  // whole platform rather than behind a flag: there is no ESM loader either.
  if (name.slice(Number(name.length) - 4) === ".mjs") {
    throw new ERR_REQUIRE_ESM(name);
  }
  if (name.slice(Number(name.length) - 3) === ".js") {
    const pkg: any = __modNearestPackage(name);
    if (pkg !== undefined && pkg.type === "module") throw new ERR_REQUIRE_ESM(name);
  }
  // The file exists and is readable — `_findPath` just stat'ed it — but
  // turning its source into code is the compiler's job, and the compiler ran
  // before this program started.
  throw new ERR_ZUN_NO_RUNTIME_COMPILER(name);
}
Module._extensions[".js"] = __modLoadJavaScript;

function __modLoadJSON(module?: any, filename?: any): void {
  const name: string = String(filename);
  const content: any = __modReadFileText(name);
  if (content === undefined) {
    const error: any = new __ModuleNotFoundError("Cannot find module '" + name + "'");
    throw error;
  }
  try {
    module.exports = JSON.parse(__modStripBOM(String(content)));
  } catch (error: any) {
    // Node prefixes the file name onto the parser's own message and rethrows
    // the *same* error, so `err.name` stays `SyntaxError`.
    error.message = name + ": " + error.message;
    throw error;
  }
}
Module._extensions[".json"] = __modLoadJSON;

function __modLoadAddon(module?: any, filename?: any): void {
  throw new ERR_DLOPEN_FAILED(
    "Cannot load " + String(filename) + ": a Node.js addon is a V8 N-API " +
      "shared object, and this runtime has no V8 isolate to load one into " +
      "(the Zun engine's own native extensions are loaded with `zun run --ext`)",
  );
}
Module._extensions[".node"] = __modLoadAddon;

// The nearest enclosing package.json, walking up from a file. Used by the
// `.js` loader for its `"type"` field and by `findPackageJSON`.
function __modNearestPackage(filename: string): any {
  let dir: string = path.dirname(filename);
  let previous: string = "";
  while (dir !== previous) {
    // `node_modules` is never itself a package root in Node's walk.
    if (path.basename(dir) !== "node_modules") {
      const pkg: any = __modReadPackage(dir);
      if (pkg.exists === true) return pkg;
    }
    previous = dir;
    dir = path.dirname(dir);
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Loading a resolved file
// ---------------------------------------------------------------------------
//
// `Module.prototype.load`: record the filename and the lookup paths, then hand
// the file to the extension loader that owns its longest registered suffix.
function __modLoadRecord(record: any, filename: string): void {
  record.filename = filename;
  if (record.paths === undefined) {
    record.paths = Module._nodeModulePaths(path.dirname(filename));
  }
  const extension: string = __modFindLongestRegisteredExtension(filename);
  const loader: any = Module._extensions[extension];
  if (loader === undefined || loader === null) {
    throw new ERR_ZUN_NO_RUNTIME_COMPILER(filename);
  }
  loader(record, filename);
  record.loaded = true;
}

// `getExportsForCircularRequire`, reduced to its return value. Node also
// swaps the exports object's prototype for a Proxy that warns on a missing
// property read ("Accessing non-existent property … inside circular
// dependency"); a Proxy is not reachable here, so the warning is a documented
// gap rather than a silent difference.
function __modExportsForCircularRequire(record: any): any {
  return record.exports;
}

// `loadBuiltinWithHooks`, over the registry the bundler fills.
function __modLoadBuiltin(id: string): any {
  const exported: any = __modBuiltinExports[id];
  if (exported === undefined) throw new ERR_ZUN_UNIMPLEMENTED_BUILTIN(id);
  return exported;
}

// ---------------------------------------------------------------------------
// Module._load
// ---------------------------------------------------------------------------

function __modLoad(request?: any, parent?: any, isMain?: any): any {
  const text: string = String(request);

  // A `node:`-prefixed specifier resolves and loads before the cache is
  // consulted, which is exactly why `require.cache.fs = …` is visible to
  // `require('fs')` and invisible to `require('node:fs')`.
  if (text.slice(0, 5) === "node:") {
    const normalized: any = __modNormalizeRequirableId(text);
    if (normalized === undefined) throw new ERR_UNKNOWN_BUILTIN_MODULE(text);
    return __modLoadBuiltin(String(normalized));
  }

  const filename: any = Module._resolveFilename(text, parent, isMain === true, undefined);

  const cachedModule: any = Module._cache[filename];
  if (cachedModule !== undefined) {
    __modUpdateChildren(parent, cachedModule, true);
    if (cachedModule.loaded === true) return cachedModule.exports;
    return __modExportsForCircularRequire(cachedModule);
  }

  if (__modCanBeRequiredWithoutScheme(String(filename))) {
    return __modLoadBuiltin(String(filename));
  }

  const record: any = __modNew(filename, parent);
  if (isMain === true) {
    record.id = ".";
    __modMainModuleRecord = record;
  }
  Module._cache[filename] = record;

  let threw = true;
  try {
    __modLoadRecord(record, String(filename));
    threw = false;
  } finally {
    if (threw) {
      delete Module._cache[filename];
      const children: any = parent === undefined || parent === null ? undefined : parent.children;
      if (children !== undefined && children !== null && Array.isArray(children)) {
        const at: number = Number(children.indexOf(record));
        if (at !== -1) children.splice(at, 1);
      }
    }
  }

  return record.exports;
}
Module._load = __modLoad;

// `Module.prototype.require`, with Node's two argument checks.
function __modRequireFrom(record: any, id?: any): any {
  __modValidateString(id, "id");
  if (id === "") {
    throw new ERR_INVALID_ARG_VALUE("id", id, "must be a non-empty string");
  }
  return Module._load(id, record, false);
}

// ---------------------------------------------------------------------------
// makeRequireFunction
// ---------------------------------------------------------------------------
//
// `lib/internal/modules/helpers.js`. `require` is a function carrying
// `resolve` (itself carrying `paths`), `cache`, `extensions` and `main` —
// which this engine supports as expando properties on a function value, the
// same shape `src/assert/assert.ts` gives `assert`.
//
// These three *are* function expressions, because each closes over `record`
// and a named top-level function could not. The rule from the header therefore
// applies by hand here: **do not write the word `this` anywhere inside them**,
// comments included, or every argument shifts by one.
function __modMakeRequire(record: any): any {
  const madeRequire: any = function (id?: any): any {
    return __modRequireFrom(record, id);
  };
  const madeResolve: any = function (request?: any, options?: any): any {
    __modValidateString(request, "request");
    return Module._resolveFilename(request, record, false, options);
  };
  madeResolve.paths = function (request?: any): any {
    __modValidateString(request, "request");
    return Module._resolveLookupPaths(request, record);
  };
  madeRequire.resolve = madeResolve;
  // The *same* objects `Module` holds, not copies: `require.cache ===
  // Module._cache` is observable, and Node's tests write through both names.
  madeRequire.cache = Module._cache;
  madeRequire.extensions = Module._extensions;
  madeRequire.main = __modMainModuleRecord;
  return madeRequire;
}

// ---------------------------------------------------------------------------
// createRequire
// ---------------------------------------------------------------------------

const __MOD_CREATE_REQUIRE_ERROR: string =
  "must be a file URL object, file URL string, or absolute path string";

// `fileURLToPath` for the two shapes `createRequire` accepts: a `URL`-like
// object with an `href`, and a `file:` URL string. `src/url/url.ts` is inlined
// into every bundle, so its own converter does the work; this wrapper only
// decides whether the argument is a URL at all, as Node's `isURL` does.
function __modIsURLLike(value: any): boolean {
  if (value === null || typeof value !== "object") return false;
  return typeof value.href === "string" && typeof value.protocol === "string";
}

function createRequire(filename?: any): any {
  let filepath: any;
  if (__modIsURLLike(filename) || (typeof filename === "string" && !path.isAbsolute(filename))) {
    try {
      filepath = __node_url.fileURLToPath(filename);
    } catch (error) {
      throw new ERR_INVALID_ARG_VALUE("filename", filename, __MOD_CREATE_REQUIRE_ERROR);
    }
  } else if (typeof filename !== "string") {
    throw new ERR_INVALID_ARG_VALUE("filename", filename, __MOD_CREATE_REQUIRE_ERROR);
  } else {
    filepath = filename;
  }
  return __modCreateRequireFromPath(String(filepath));
}

function __modCreateRequireFromPath(filename: string): any {
  const length: number = Number(filename.length);
  // A directory may be passed; Node appends a `noop.js` so that the record's
  // `path` is that directory.
  const trailingSlash: boolean =
    (length > 0 && filename.charAt(length - 1) === "/") ||
    (__MOD_IS_WINDOWS && length > 0 && filename.charAt(length - 1) === "\\");
  const proxyPath: string = trailingSlash ? path.join(filename, "noop.js") : filename;
  const record: any = __modNew(proxyPath, null);
  record.filename = proxyPath;
  record.paths = Module._nodeModulePaths(record.path);
  return __modMakeRequire(record);
}

// ---------------------------------------------------------------------------
// Module._initPaths and globalPaths
// ---------------------------------------------------------------------------

function __modInitPaths(): void {
  const homeDir: any = __MOD_IS_WINDOWS ? process.env.USERPROFILE : process.env.HOME;
  const nodePath: any = process.env.NODE_PATH;

  // `process.execPath` is `$PREFIX/bin/node` everywhere but Windows, where it
  // is `$PREFIX\node.exe`.
  const prefixDir: string = __MOD_IS_WINDOWS
    ? path.resolve(String(process.execPath), "..")
    : path.resolve(String(process.execPath), "..", "..");

  const paths: string[] = [path.resolve(prefixDir, "lib", "node")];

  if (truthy(homeDir)) {
    paths.unshift(path.resolve(String(homeDir), ".node_libraries"));
    paths.unshift(path.resolve(String(homeDir), ".node_modules"));
  }

  if (truthy(nodePath)) {
    const extra: string[] = [];
    for (const part of String(nodePath).split(path.delimiter)) {
      if (part !== "") extra.push(part);
    }
    for (let i = Number(extra.length) - 1; i >= 0; i = i - 1) paths.unshift(extra[i]);
  }

  __modGlobalModulePaths = paths;
  // A shallow copy, for introspection, exactly as in Node.
  const copy: string[] = [];
  for (const one of paths) copy.push(one);
  Module.globalPaths = copy;
}
Module._initPaths = __modInitPaths;

Module._initPaths();

// `Module._preloadModules` handles `--require`, which this runtime has no
// command line for; it validates its argument and then has nothing to load.
function __modPreloadModules(requests?: any): void {
  if (!Array.isArray(requests)) return;
  const parent: any = __modNew("internal/preload", null);
  parent.paths = Module._nodeModulePaths(String(process.cwd()));
  for (const request of requests) __modRequireFrom(parent, request);
}
Module._preloadModules = __modPreloadModules;

// ---------------------------------------------------------------------------
// Module.wrap / Module.wrapper
// ---------------------------------------------------------------------------
//
// The deprecated CommonJS wrapper (DEP0016). It is pure string concatenation,
// so it is exactly Node's — a caller that wants to *run* the result needs a
// compiler, which is the one thing this platform cannot hand it.
Module.wrapper = [
  "(function (exports, require, module, __filename, __dirname) { ",
  "\n});",
];

function __modWrap(script?: any): string {
  return String(Module.wrapper[0]) + String(script) + String(Module.wrapper[1]);
}
Module.wrap = __modWrap;

// `Module.runMain` is the entry point `--require`-based monkey patching
// replaces. There is no main script to run from inside a program that is
// already running, so this says so.
function __modRunMain(main?: any): void {
  throw new ERR_METHOD_NOT_IMPLEMENTED("Module.runMain");
}
Module.runMain = __modRunMain;

// ---------------------------------------------------------------------------
// SourceMap (lib/internal/source_map/source_map.js)
// ---------------------------------------------------------------------------
//
// A complete Source Map v3 reader: the base64 VLQ decoder, the `mappings`
// scanner (including an index map's `sections`), `findEntry`'s binary search
// and `findOrigin`. Node's version is derived from Chrome DevTools' (BSD,
// Copyright 2011 Google Inc.); this follows Node's, field for field.
//
// Three engine notes. The class carries ordinary fields rather than `#private`
// ones. The VLQ decoder uses `% 32`, `>= 32` and `Math.pow` where Node uses
// `&`, `<<` and `>>>`, because a shift past 31 bits is the one case the bit
// operators get wrong here and the arithmetic form is exact. And the mappings
// are arrays of six mixed slots (two numbers, a string, two numbers, a string
// or `undefined`), read back through `any`.

const __MOD_BASE64_DIGITS: string =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function __modBase64Value(char: string): number {
  const at: number = indexOfChar(__MOD_BASE64_DIGITS, char, 0);
  return at;
}

// A cursor over the `mappings` string: Node's `StringCharIterator`.
class __ModMappingCursor {
  text: string = "";
  position: number = 0;
  constructor(text: string) {
    this.text = text;
    this.position = 0;
  }
  next(): string {
    const char: string = this.text.charAt(this.position);
    this.position = this.position + 1;
    return char;
  }
  peek(): string {
    return this.text.charAt(this.position);
  }
  hasNext(): boolean {
    return this.position < Number(this.text.length);
  }
}

function __modIsMappingSeparator(char: string): boolean {
  return char === "," || char === ";";
}

function __modDecodeVLQ(cursor: any): number {
  let result = 0;
  let shift = 0;
  let digit = 0;
  let more = true;
  while (more) {
    digit = __modBase64Value(cursor.next());
    if (digit < 0) return 0;
    result = result + (digit % 32) * Math.pow(2, shift);
    shift = shift + 5;
    more = digit >= 32;
  }
  const negative: boolean = result % 2 === 1;
  result = Math.floor(result / 2);
  if (!negative) return result;
  // Node's `-result | (1 << 31)`: a negative zero cannot be represented, so
  // the sign bit is forced instead.
  if (result === 0) return -2147483648;
  return -result;
}

function __modCompareMappingEntry(a: any, b: any): number {
  if (Number(a[0]) !== Number(b[0])) return Number(a[0]) - Number(b[0]);
  return Number(a[1]) - Number(b[1]);
}

// `cloneSourceMapV3`: a shallow copy with every array value copied too.
function __modCloneSourceMapV3(payload: any): any {
  __modValidateObject(payload, "payload");
  const copy: any = {};
  for (const key of Object.keys(payload)) {
    const value: any = payload[key];
    if (Array.isArray(value)) {
      const list: any[] = [];
      for (const one of value) list.push(one);
      copy[key] = list;
    } else {
      copy[key] = value;
    }
  }
  return copy;
}

class SourceMap {
  __modPayload: any = undefined;
  __modMappings: any[] = [];
  __modSources: any = undefined;
  __modSourceContentByURL: any = undefined;
  __modLineLengths: any = undefined;
  // `payload` and `lineLengths` are **fields** here, where Node makes them
  // accessors that answer a fresh copy on every read. They have to be
  // declared: a member this engine's checker cannot see on the class is a
  // compile error on a typed receiver ("no field or getter `payload` on this
  // type"), so an accessor installed with `Object.defineProperty` would be
  // unreachable as `map.payload`. The copy is therefore made once, in the
  // constructor, and the one observable difference is that two reads answer
  // the same copy rather than two -- a caller that mutates what it reads sees
  // its own mutation back.
  payload: any = undefined;
  lineLengths: any = undefined;

  constructor(payload?: any, options?: any) {
    this.__modSources = {};
    this.__modSourceContentByURL = {};
    this.__modMappings = [];
    this.__modPayload = __modCloneSourceMapV3(payload);
    this.__modParseMappingPayload();
    const lineLengths: any =
      options === undefined || options === null ? undefined : options.lineLengths;
    if (Array.isArray(lineLengths) && Number(lineLengths.length) > 0) {
      this.__modLineLengths = lineLengths;
    }
    this.payload = __modCloneSourceMapV3(this.__modPayload);
    if (this.__modLineLengths === undefined) {
      this.lineLengths = undefined;
    } else {
      const copy: any[] = [];
      for (const one of this.__modLineLengths) copy.push(one);
      this.lineLengths = copy;
    }
  }

  __modParseMappingPayload(): void {
    const payload: any = this.__modPayload;
    if (truthy(payload.sections)) {
      for (const section of payload.sections) {
        this.__modParseMap(section.map, Number(section.offset.line), Number(section.offset.column));
      }
    } else {
      this.__modParseMap(payload, 0, 0);
    }
    this.__modMappings.sort(__modCompareMappingEntry);
  }

  __modParseMap(map: any, lineNumber?: any, columnNumber?: any): void {
    let line: number = Number(lineNumber);
    let column: number = Number(columnNumber);
    let sourceIndex = 0;
    let sourceLineNumber = 0;
    let sourceColumnNumber = 0;
    let nameIndex = 0;

    const sources: any[] = [];
    const mapSources: any = map.sources;
    const sourcesContent: any = map.sourcesContent;
    if (Array.isArray(mapSources)) {
      let i = 0;
      while (i < Number(mapSources.length)) {
        const url: any = mapSources[i];
        sources.push(url);
        this.__modSources[String(url)] = true;
        if (Array.isArray(sourcesContent) && truthy(sourcesContent[i])) {
          this.__modSourceContentByURL[String(url)] = sourcesContent[i];
        }
        i = i + 1;
      }
    }

    const cursor: any = new __ModMappingCursor(String(map.mappings));
    let sourceURL: any = sources[sourceIndex];
    const names: any = map.names;
    while (true) {
      if (cursor.peek() === ",") {
        cursor.next();
      } else {
        while (cursor.peek() === ";") {
          line = line + 1;
          column = 0;
          cursor.next();
        }
        if (!cursor.hasNext()) break;
      }

      column = column + __modDecodeVLQ(cursor);
      if (__modIsMappingSeparator(cursor.peek())) {
        this.__modMappings.push([line, column]);
        continue;
      }

      const sourceIndexDelta: number = __modDecodeVLQ(cursor);
      if (sourceIndexDelta !== 0) {
        sourceIndex = sourceIndex + sourceIndexDelta;
        sourceURL = sources[sourceIndex];
      }
      sourceLineNumber = sourceLineNumber + __modDecodeVLQ(cursor);
      sourceColumnNumber = sourceColumnNumber + __modDecodeVLQ(cursor);

      let name: any = undefined;
      if (!__modIsMappingSeparator(cursor.peek())) {
        nameIndex = nameIndex + __modDecodeVLQ(cursor);
        if (Array.isArray(names)) name = names[nameIndex];
      }

      this.__modMappings.push([
        line, column, sourceURL, sourceLineNumber, sourceColumnNumber, name,
      ]);
    }
  }

  findEntry(lineOffset?: any, columnOffset?: any): any {
    const line: number = Number(lineOffset);
    const column: number = Number(columnOffset);
    let first = 0;
    let count: number = Number(this.__modMappings.length);
    while (count > 1) {
      const step: number = Math.floor(count / 2);
      const middle: number = first + step;
      const mapping: any = this.__modMappings[middle];
      if (line < Number(mapping[0]) || (line === Number(mapping[0]) && column < Number(mapping[1]))) {
        count = step;
      } else {
        first = middle;
        count = count - step;
      }
    }
    const entry: any = this.__modMappings[first];
    if (entry === undefined) return {};
    if (
      first === 0 &&
      (line < Number(entry[0]) || (line === Number(entry[0]) && column < Number(entry[1])))
    ) {
      return {};
    }
    return {
      generatedLine: entry[0],
      generatedColumn: entry[1],
      originalSource: entry[2],
      originalLine: entry[3],
      originalColumn: entry[4],
      name: entry[5],
    };
  }

  findOrigin(lineNumber?: any, columnNumber?: any): any {
    const line: number = Number(lineNumber);
    const column: number = Number(columnNumber);
    const range: any = this.findEntry(line - 1, column - 1);
    if (
      range.originalSource === undefined ||
      range.originalLine === undefined ||
      range.originalColumn === undefined ||
      range.generatedLine === undefined ||
      range.generatedColumn === undefined
    ) {
      return {};
    }
    const lineDelta: number = line - Number(range.generatedLine);
    const columnDelta: number = column - Number(range.generatedColumn);
    return {
      name: range.name,
      fileName: range.originalSource,
      lineNumber: Number(range.originalLine) + lineDelta,
      columnNumber: Number(range.originalColumn) + columnDelta,
    };
  }
}

// ---------------------------------------------------------------------------
// Source-map support state
// ---------------------------------------------------------------------------
//
// `Module.setSourceMapsSupport` / `getSourceMapsSupport`
// (lib/internal/source_map/source_map_cache.js). The *state* is real and
// observable; what it enables is not, because nothing in this runtime compiles
// a file and so nothing registers a source map. `findSourceMap` therefore
// answers `undefined` for every path, which is also what Node answers for a
// file it has not loaded.
const __modSourceMapsState: any = {
  enabled: false,
  nodeModules: false,
  generatedCode: false,
};

function __modSetSourceMapsSupport(enabled?: any, options?: any): void {
  __modValidateBoolean(enabled, "enabled");
  const settings: any = options === undefined ? {} : options;
  __modValidateObject(settings, "options");
  const nodeModules: any = settings.nodeModules === undefined ? false : settings.nodeModules;
  const generatedCode: any = settings.generatedCode === undefined ? false : settings.generatedCode;
  __modValidateBoolean(nodeModules, "options.nodeModules");
  __modValidateBoolean(generatedCode, "options.generatedCode");
  __modSourceMapsState.enabled = enabled;
  __modSourceMapsState.nodeModules = nodeModules;
  __modSourceMapsState.generatedCode = generatedCode;
}

function __modGetSourceMapsSupport(): any {
  return {
    enabled: __modSourceMapsState.enabled,
    nodeModules: __modSourceMapsState.nodeModules,
    generatedCode: __modSourceMapsState.generatedCode,
  };
}

function __modFindSourceMap(location?: any): any {
  if (typeof location !== "string") {
    throw new ERR_INVALID_ARG_TYPE("path", "string", location);
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// findPackageJSON
// ---------------------------------------------------------------------------
//
// Node 25's `module.findPackageJSON(specifier, base)`: the path of the
// package.json that governs `specifier`, or `undefined`. A relative or
// absolute specifier is resolved against `base`; a bare specifier is resolved
// through the node_modules chain, which is `Module._resolveFilename`'s job.
function findPackageJSON(specifier?: any, base?: any): any {
  if (typeof specifier !== "string" && !__modIsURLLike(specifier)) {
    throw new ERR_INVALID_ARG_TYPE("specifier", ["string", "URL"], specifier);
  }
  let from: string = __modMain().filename === null ? String(process.cwd()) : String(__modMain().filename);
  if (base !== undefined) {
    from = __modIsURLLike(base) ? String(__node_url.fileURLToPath(base)) : String(base);
  }
  let target: string;
  if (__modIsURLLike(specifier)) {
    target = String(__node_url.fileURLToPath(specifier));
  } else {
    const text: string = String(specifier);
    if (path.isAbsolute(text)) {
      target = text;
    } else if (__modIsRelative(text)) {
      target = path.resolve(path.dirname(from), text);
    } else {
      const holder: any = __modNew(from, null);
      holder.filename = from;
      holder.paths = Module._nodeModulePaths(path.dirname(from));
      let resolved: any;
      try {
        resolved = Module._resolveFilename(text, holder, false, undefined);
      } catch (error) {
        return undefined;
      }
      if (__modCanBeRequiredWithoutScheme(String(resolved))) return undefined;
      target = String(resolved);
    }
  }
  // A directory of its own gets its own package.json; a file gets the nearest
  // one above it.
  if (__modStat(target) === 1) {
    const own: any = __modReadPackage(target);
    if (own.exists === true) return String(own.pjsonPath);
    target = path.join(target, "index.js");
  }
  const pkg: any = __modNearestPackage(target);
  if (pkg === undefined) return undefined;
  return String(pkg.pjsonPath);
}

// ---------------------------------------------------------------------------
// Loader hooks
// ---------------------------------------------------------------------------
//
// Both forms of loader hook exist to feed a module **compiler**: a `resolve`
// hook chooses which file a specifier names, and a `load` hook hands that
// file's source back for compilation. This platform has no runtime compiler
// (see the header), so a `load` hook could never be honoured, and honouring a
// `resolve` hook on its own would quietly change which file a specifier names
// while still refusing to load it — a worse answer than saying so.
//
// Both therefore report `ERR_METHOD_NOT_IMPLEMENTED`. `register` is Node's
// asynchronous ESM form (a second loader thread, which does not exist here
// either); `registerHooks` is the synchronous CommonJS-and-ESM form added in
// Node 22.
function register(specifier?: any, parentURL?: any, options?: any): void {
  throw new ERR_METHOD_NOT_IMPLEMENTED("module.register");
}

function registerHooks(hooks?: any): any {
  throw new ERR_METHOD_NOT_IMPLEMENTED("module.registerHooks");
}

// `syncBuiltinESMExports` reconciles a monkey-patched builtin's CommonJS
// exports with the named exports its ES module facade hands out. There is no
// ESM facade here, so the two can never disagree and the reconciliation has
// nothing to do — which is why this is a no-op rather than an error: a program
// calling it is asking for a state that already holds.
function syncBuiltinESMExports(): void {}

// ---------------------------------------------------------------------------
// The compile cache
// ---------------------------------------------------------------------------
//
// `enableCompileCache` asks the runtime to persist compiled bytecode between
// runs. The Zun engine has its own ahead-of-time pipeline and no
// V8-code-cache store for this to write into, so the call reports `FAILED`
// with a reason — the same shape Node reports when it cannot create the
// directory — and `getCompileCacheDir()` answers `undefined`. Nothing is
// silently dropped: a caller that checks `status` learns the truth.
const constants: any = {
  compileCacheStatus: {
    FAILED: 0,
    ENABLED: 1,
    ALREADY_ENABLED: 2,
    DISABLED: 3,
  },
};

function enableCompileCache(cacheDir?: any): any {
  return {
    status: constants.compileCacheStatus.FAILED,
    message:
      "The Zun engine compiles ahead of execution and keeps no V8 code cache, " +
      "so there is no compile cache to enable",
  };
}

function getCompileCacheDir(): any {
  return undefined;
}

function flushCompileCache(): void {}

// ---------------------------------------------------------------------------
// stripTypeScriptTypes
// ---------------------------------------------------------------------------
//
// Node's `stripTypeScriptTypes` (lib/internal/modules/typescript.js) is a thin
// wrapper over Amaro, which is SWC's TypeScript stripper compiled to Wasm. The
// *wrapper* is reproduced exactly here — the experimental warning, the option
// validation in Node's order, the `//# sourceURL=` tail and the inlined
// `//# sourceMappingURL=data:` tail. The stripper underneath it is this file's
// own, because there is no Wasm engine to run SWC in.
//
// What "strip" means is well defined and is what this implements: every byte
// of type syntax is replaced by **spaces**, newlines are preserved, and
// nothing else moves — so the output is byte-for-byte the same length as the
// input and every line and column still lines up with the source. That is the
// property `strip-only` mode exists for, and it is checkable without a parser.
//
// Scope, stated precisely rather than implied. Handled: type annotations on
// declarations, parameters, class members and return types; optional `?`
// markers; non-null `!`; `as` and `satisfies` expressions; generic parameter
// lists on declarations; `interface` and `type` declarations; `declare`
// statements; `import type` / `export type` and inline `{ type X }`
// specifiers; `implements` clauses; the `public` / `private` / `protected` /
// `readonly` / `override` / `abstract` member modifiers; and parameter
// properties. Rejected, as SWC's strip-only mode rejects them, because erasing
// them would change what the program does: `enum`, `namespace` and the
// `module X { … }` form. Four constructs are deliberately **left as written**,
// with no silent guess:
//
//   * call-site type arguments (`f<number>(x)`), because `a < b > (c)` is a
//     valid JavaScript expression and telling the two apart needs a parser
//     with backtracking;
//   * a labelled statement whose label shares a line with a declaration, which
//     is indistinguishable from an annotation by local context;
//   * an object *type* in return position (`function f(): { a: number } {}`),
//     where the first `{` is read as the function body;
//   * type syntax inside a template interpolation (`` `${ x as T }` ``), which
//     is copied verbatim -- see the note in `__modTsSkipString`.
//
// Each of those leaves TypeScript in the output rather than removing the wrong
// bytes, which is the failure mode a caller can see.

const __MOD_TS_STATEMENT_HEADS: string[] = [
  "", ";", "{", "}", "export", "declare", "default", ")", ":",
];

function __modTsIsIdentStart(code: number): boolean {
  return (
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x61 && code <= 0x7a) ||
    code === 0x5f ||
    code === 0x24 ||
    code > 0x7f
  );
}

function __modTsIsIdentPart(code: number): boolean {
  return __modTsIsIdentStart(code) || (code >= 0x30 && code <= 0x39);
}

function __modTsIsSpace(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d || code === 0x0c;
}

// The scanner's own state, kept in one record so the helpers below can share
// it without a seven-parameter signature (zun#10 refuses a dynamic call past
// six arguments, and these are all plain functions on one record).
function __modTsNewState(source: string): any {
  return {
    src: source,
    out: [],
    length: Number(source.length),
    i: 0,
    prev: "",
    // The brace stack: "block", "object" or "class".
    braces: [],
    // Depth of `(` and `[` groups, and whether a `?` is pending at the current
    // paren depth (which makes a later `:` a ternary arm, not a type).
    parens: [],
    brackets: 0,
    // Set after `const`/`let`/`var` until the statement ends: a `:` in that
    // span annotates the declarator.
    declarator: false,
    // Set after a `)` closed at statement level: a `:` there is a return type.
    afterParams: false,
    // Set by `class` until its body brace is pushed.
    pendingClass: false,
    // Where the last `import` / `export` keyword started, so that a following
    // `type` can blank from there.
    importAt: 0,
  };
}

function __modTsBlank(state: any, from: number, to: number): void {
  let at: number = from;
  while (at < to) {
    const code: number = cc(state.src, at);
    if (code !== 0x0a && code !== 0x0d) state.out[at] = " ";
    at = at + 1;
  }
}

// Skip whitespace and comments forward from `at`, answering the next code
// position. Used to look ahead without copying anything.
function __modTsSkipTrivia(state: any, at: number): number {
  let cursor: number = at;
  while (cursor < state.length) {
    const code: number = cc(state.src, cursor);
    if (__modTsIsSpace(code)) {
      cursor = cursor + 1;
    } else if (code === 0x2f && cc(state.src, cursor + 1) === 0x2f) {
      while (cursor < state.length && cc(state.src, cursor) !== 0x0a) cursor = cursor + 1;
    } else if (code === 0x2f && cc(state.src, cursor + 1) === 0x2a) {
      cursor = cursor + 2;
      while (cursor < state.length) {
        if (cc(state.src, cursor) === 0x2a && cc(state.src, cursor + 1) === 0x2f) {
          cursor = cursor + 2;
          break;
        }
        cursor = cursor + 1;
      }
    } else {
      return cursor;
    }
  }
  return cursor;
}

function __modTsWordAt(state: any, at: number): string {
  if (!__modTsIsIdentStart(cc(state.src, at))) return "";
  let end: number = at;
  while (end < state.length && __modTsIsIdentPart(cc(state.src, end))) end = end + 1;
  return state.src.slice(at, end);
}

// Scan a *type* starting at `at` (which is the first code character of the
// type) and answer the position just past it. `stopAtBrace` is true for a
// return-type annotation, where the next `{` is the function body.
function __modTsScanType(state: any, at: number, stopAtBrace: boolean): number {
  let cursor: number = at;
  let depth = 0;
  let lastGroupWasParen = false;
  while (cursor < state.length) {
    cursor = __modTsSkipTrivia(state, cursor);
    if (cursor >= state.length) break;
    const code: number = cc(state.src, cursor);
    if (code === 0x3c || code === 0x28 || code === 0x5b) {
      if (code === 0x28) lastGroupWasParen = true;
      depth = depth + 1;
      cursor = cursor + 1;
      continue;
    }
    if (code === 0x7b) {
      if (depth === 0 && stopAtBrace) return cursor;
      depth = depth + 1;
      cursor = cursor + 1;
      continue;
    }
    if (code === 0x3e || code === 0x29 || code === 0x5d || code === 0x7d) {
      if (depth === 0) return cursor;
      depth = depth - 1;
      cursor = cursor + 1;
      continue;
    }
    if (depth === 0) {
      // `=>` continues a function type, but only when a parenthesised
      // parameter list just closed; otherwise it ends an arrow's return type.
      if (code === 0x3d && cc(state.src, cursor + 1) === 0x3e) {
        if (!lastGroupWasParen) return cursor;
        cursor = cursor + 2;
        lastGroupWasParen = false;
        continue;
      }
      if (code === 0x3d || code === 0x2c || code === 0x3b) return cursor;
    }
    // A string inside a type (a literal type, or an `import("…")` type).
    if (code === 0x22 || code === 0x27 || code === 0x60) {
      cursor = __modTsSkipString(state, cursor, false);
      continue;
    }
    cursor = cursor + 1;
  }
  return cursor;
}

// Copy a string or template literal verbatim, answering the position past it.
// `emit` is false when the span is being skipped rather than kept.
function __modTsSkipString(state: any, at: number, emit: boolean): number {
  const quote: number = cc(state.src, at);
  let cursor: number = at + 1;
  while (cursor < state.length) {
    const code: number = cc(state.src, cursor);
    if (code === 0x5c) {
      cursor = cursor + 2;
      continue;
    }
    if (code === quote) return cursor + 1;
    // A template's `${...}` may hold arbitrary code, including type syntax.
    // The interpolation is copied **verbatim**: scanning into it would need the
    // scanner to re-enter itself with the brace stack it has, and a type inside
    // a template expression is rare enough that leaving it as written -- which
    // a caller can see -- is better than a guess it cannot. This is the fourth
    // documented gap, alongside the three in the header.
    if (quote === 0x60 && code === 0x24 && cc(state.src, cursor + 1) === 0x7b) {
      let depth = 1;
      cursor = cursor + 2;
      while (cursor < state.length && depth > 0) {
        const inner: number = cc(state.src, cursor);
        if (inner === 0x7b) depth = depth + 1;
        else if (inner === 0x7d) depth = depth - 1;
        else if (inner === 0x22 || inner === 0x27 || inner === 0x60) {
          cursor = __modTsSkipString(state, cursor, emit);
          continue;
        }
        cursor = cursor + 1;
      }
      continue;
    }
    cursor = cursor + 1;
  }
  return cursor;
}

// Blank a whole declaration from `at`.
//
// `braceIsBody` distinguishes the two shapes a type-only declaration takes.
// `interface X { … }` and `declare module "x" { … }` *end* with a braced body,
// so the first balanced `{ … }` group closes the statement. `type A = { x:
// number } | string;` and `import type { X } from "y";` only *contain* braces,
// so there the statement runs to its `;` (or, with no `;`, to the end of the
// line, which is where automatic semicolon insertion would put one) and the
// braces are nesting like any other bracket.
function __modTsBlankDeclaration(state: any, at: number, braceIsBody: boolean): number {
  let cursor: number = at;
  let depth = 0;
  while (cursor < state.length) {
    const code: number = cc(state.src, cursor);
    if (code === 0x22 || code === 0x27 || code === 0x60) {
      cursor = __modTsSkipString(state, cursor, false);
      continue;
    }
    if (code === 0x7b || code === 0x28 || code === 0x5b) {
      depth = depth + 1;
    } else if (code === 0x7d || code === 0x29 || code === 0x5d) {
      depth = depth - 1;
      if (depth === 0 && braceIsBody && code === 0x7d) {
        cursor = cursor + 1;
        break;
      }
      if (depth < 0) break;
    } else if (depth === 0 && code === 0x3b) {
      cursor = cursor + 1;
      break;
    } else if (depth === 0 && code === 0x0a) {
      break;
    }
    cursor = cursor + 1;
  }
  __modTsBlank(state, at, cursor);
  return cursor;
}

function __modTsPrevAllowsRegex(prev: string): boolean {
  if (prev === "") return true;
  const code: number = cc(prev, 0);
  if (__modTsIsIdentPart(code)) {
    // A keyword may precede a regex (`return /x/`), an identifier may not.
    return (
      prev === "return" || prev === "typeof" || prev === "case" || prev === "in" ||
      prev === "of" || prev === "delete" || prev === "void" || prev === "instanceof" ||
      prev === "new" || prev === "do" || prev === "else" || prev === "yield" ||
      prev === "await" || prev === "throw"
    );
  }
  return prev !== ")" && prev !== "]" && prev !== "}";
}

// The expression positions after which a `{` opens an object literal rather
// than a block, and after which a `/` starts a regular expression.
const __MOD_TS_EXPR_HEADS: string[] = [
  "(", ",", "=", ":", "[", "!", "&", "|", "?", "+", "-", "*", "/", "%", "<",
  ">", "return", "typeof", "new", "in", "of", "case", "do", "else", "yield",
  "await", "throw", "=>", "&&", "||", "??",
];

// The member-name positions inside a class body, after which an identifier is
// a member name (and so may carry a generic parameter list).
const __MOD_TS_MEMBER_HEADS: string[] = [
  "{", "}", ";", "static", "get", "set", "async", "*",
];

const __MOD_TS_MODIFIERS: string[] = [
  "public", "private", "protected", "readonly", "override", "abstract",
];

// The token after which `as` / `satisfies` / `!` is a *postfix* type operator
// rather than the start of something else: a value has just been written.
function __modTsPrevIsValue(prev: string): boolean {
  if (prev === "") return false;
  if (prev === ")" || prev === "]" || prev === "}" || prev === "x") return true;
  const code: number = cc(prev, 0);
  if (!__modTsIsIdentPart(code)) return false;
  return !__modIncludesString(__MOD_TS_EXPR_HEADS, prev);
}

function __modStripTypes(source: string): string {
  const state: any = __modTsNewState(source);
  let k = 0;
  while (k < state.length) {
    state.out.push(source.charAt(k));
    k = k + 1;
  }
  let afterDeclName = false;

  while (state.i < state.length) {
    const at: number = state.i;
    const code: number = cc(source, at);

    if (__modTsIsSpace(code)) {
      state.i = at + 1;
      continue;
    }
    // Comments are kept as written.
    if (code === 0x2f && cc(source, at + 1) === 0x2f) {
      let end: number = at;
      while (end < state.length && cc(source, end) !== 0x0a) end = end + 1;
      state.i = end;
      continue;
    }
    if (code === 0x2f && cc(source, at + 1) === 0x2a) {
      let end: number = at + 2;
      while (end < state.length) {
        if (cc(source, end) === 0x2a && cc(source, end + 1) === 0x2f) {
          end = end + 2;
          break;
        }
        end = end + 1;
      }
      state.i = end;
      continue;
    }
    if (code === 0x22 || code === 0x27 || code === 0x60) {
      state.i = __modTsSkipString(state, at, true);
      state.prev = "x";
      afterDeclName = false;
      continue;
    }
    if (code === 0x2f && __modTsPrevAllowsRegex(state.prev)) {
      let end: number = at + 1;
      let inClass = false;
      while (end < state.length) {
        const inner: number = cc(source, end);
        if (inner === 0x5c) {
          end = end + 2;
          continue;
        }
        if (inner === 0x5b) inClass = true;
        else if (inner === 0x5d) inClass = false;
        else if (inner === 0x2f && !inClass) {
          end = end + 1;
          break;
        } else if (inner === 0x0a) break;
        end = end + 1;
      }
      while (end < state.length && __modTsIsIdentPart(cc(source, end))) end = end + 1;
      state.i = end;
      state.prev = "x";
      afterDeclName = false;
      continue;
    }

    if (__modTsIsIdentStart(code)) {
      const word: string = __modTsWordAt(state, at);
      const end: number = at + Number(word.length);
      const atStatementHead: boolean = __modIncludesString(__MOD_TS_STATEMENT_HEADS, state.prev);
      const inClassBody: boolean =
        Number(state.braces.length) > 0 &&
        state.braces[Number(state.braces.length) - 1] === "class";

      // The three constructs strip-only refuses, because erasing them would
      // remove runtime behaviour rather than types.
      if (atStatementHead && (word === "enum" || (word === "namespace" && __modTsWordAt(state, __modTsSkipTrivia(state, end)) !== ""))) {
        throw new ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX(
          word === "enum"
            ? "TypeScript enum is not supported in strip-only mode"
            : "TypeScript namespace declaration is not supported in strip-only mode",
        );
      }
      if (state.prev === "const" && word === "enum") {
        throw new ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX(
          "TypeScript enum is not supported in strip-only mode",
        );
      }
      if (atStatementHead && word === "module") {
        const nameAt: number = __modTsSkipTrivia(state, end);
        const name: string = __modTsWordAt(state, nameAt);
        if (name !== "" && cc(source, __modTsSkipTrivia(state, nameAt + Number(name.length))) === 0x7b) {
          throw new ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX(
            "TypeScript namespace declaration is not supported in strip-only mode",
          );
        }
      }

      // `interface X { … }` and `declare …` are whole declarations.
      if (atStatementHead && (word === "interface" || word === "declare")) {
        state.i = __modTsBlankDeclaration(state, at, true);
        state.prev = ";";
        afterDeclName = false;
        continue;
      }
      // `type X = …` — but not the identifier `type` used as a name, so the
      // next two tokens have to look like a type alias.
      if (atStatementHead && word === "type") {
        const nameAt: number = __modTsSkipTrivia(state, end);
        const name: string = __modTsWordAt(state, nameAt);
        if (name !== "") {
          const afterName: number = __modTsSkipTrivia(state, nameAt + Number(name.length));
          const next: number = cc(source, afterName);
          if (next === 0x3d || next === 0x3c) {
            state.i = __modTsBlankDeclaration(state, at, false);
            state.prev = ";";
            afterDeclName = false;
            continue;
          }
        }
      }
      // `import type …` / `export type …`, and the inline `{ type X }` form.
      if (word === "type" && (state.prev === "import" || state.prev === "export")) {
        // The whole `import type \u2026;` statement goes, including the `import`
        // keyword that was already copied out, so the blanking starts there.
        state.i = __modTsBlankDeclaration(state, state.importAt, false);
        state.prev = ";";
        afterDeclName = false;
        continue;
      }
      // The inline `{ type X, y }` specifier. The *whole* specifier goes, not
      // just the keyword: leaving `X` in the list would turn a type-only
      // import into a value import of a binding the module does not export.
      // A following `,` goes with it; a preceding one is left, because a
      // trailing comma in a specifier list is valid JavaScript.
      if (word === "type" && (state.prev === "{" || state.prev === ",")) {
        const nameAt: number = __modTsSkipTrivia(state, end);
        const name: string = __modTsWordAt(state, nameAt);
        if (name !== "") {
          let stop: number = nameAt + Number(name.length);
          // `type X as Y` renames the type-only specifier; the alias goes too.
          const afterName: number = __modTsSkipTrivia(state, stop);
          if (__modTsWordAt(state, afterName) === "as") {
            const aliasAt: number = __modTsSkipTrivia(state, afterName + 2);
            const alias: string = __modTsWordAt(state, aliasAt);
            if (alias !== "") stop = aliasAt + Number(alias.length);
          }
          const afterStop: number = __modTsSkipTrivia(state, stop);
          if (cc(state.src, afterStop) === 0x2c) stop = afterStop + 1;
          __modTsBlank(state, at, stop);
          state.i = stop;
          continue;
        }
      }
      // `x as T` / `x satisfies T`.
      if ((word === "as" || word === "satisfies") && __modTsPrevIsValue(state.prev)) {
        const typeAt: number = __modTsSkipTrivia(state, end);
        const typeEnd: number = __modTsScanType(state, typeAt, true);
        __modTsBlank(state, at, typeEnd);
        state.i = typeEnd;
        state.prev = "x";
        afterDeclName = false;
        continue;
      }
      // `class C implements I, J {` — the whole clause.
      if (word === "implements") {
        let cursor: number = end;
        while (cursor < state.length && cc(source, cursor) !== 0x7b) cursor = cursor + 1;
        __modTsBlank(state, at, cursor);
        state.i = cursor;
        continue;
      }
      // Member modifiers, only inside a class body.
      if (inClassBody && __modIncludesString(__MOD_TS_MODIFIERS, word)) {
        __modTsBlank(state, at, end);
        state.i = end;
        continue;
      }
      // Parameter properties: a modifier inside a constructor's parameter
      // list is a type-only annotation on the parameter *name*, which is kept.
      if (Number(state.parens.length) > 0 && __modIncludesString(__MOD_TS_MODIFIERS, word)) {
        const nameAt: number = __modTsSkipTrivia(state, end);
        if (__modTsWordAt(state, nameAt) !== "") {
          __modTsBlank(state, at, end);
          state.i = end;
          continue;
        }
      }

      if (word === "const" || word === "let" || word === "var") state.declarator = true;
      if (word === "class") state.pendingClass = true;
      // Remembered so that a following `type` can blank the whole statement,
      // `import` keyword included.
      if (word === "import" || word === "export") state.importAt = at;

      afterDeclName =
        state.prev === "function" ||
        state.prev === "class" ||
        (inClassBody && __modIncludesString(__MOD_TS_MEMBER_HEADS, state.prev));
      state.prev = word;
      state.i = end;
      continue;
    }

    // A generic parameter list on a declaration.
    if (code === 0x3c && afterDeclName) {
      let depth = 0;
      let cursor: number = at;
      while (cursor < state.length) {
        const inner: number = cc(source, cursor);
        if (inner === 0x3c) depth = depth + 1;
        else if (inner === 0x3e) {
          depth = depth - 1;
          if (depth === 0) {
            cursor = cursor + 1;
            break;
          }
        }
        cursor = cursor + 1;
      }
      __modTsBlank(state, at, cursor);
      state.i = cursor;
      afterDeclName = false;
      continue;
    }
    afterDeclName = false;

    if (code === 0x7b) {
      let kind = "block";
      if (state.pendingClass) {
        kind = "class";
        state.pendingClass = false;
      } else if (__modIncludesString(__MOD_TS_EXPR_HEADS, state.prev)) {
        kind = "object";
      }
      state.braces.push(kind);
      state.declarator = false;
      state.afterParams = false;
      state.prev = "{";
      state.i = at + 1;
      continue;
    }
    if (code === 0x7d) {
      state.braces.pop();
      state.declarator = false;
      state.afterParams = false;
      state.prev = "}";
      state.i = at + 1;
      continue;
    }
    if (code === 0x28) {
      state.parens.push({ ternary: false });
      state.prev = "(";
      state.i = at + 1;
      continue;
    }
    if (code === 0x29) {
      state.parens.pop();
      state.afterParams = Number(state.parens.length) === 0;
      state.prev = ")";
      state.i = at + 1;
      continue;
    }
    if (code === 0x5b) {
      state.brackets = state.brackets + 1;
      state.prev = "[";
      state.i = at + 1;
      continue;
    }
    if (code === 0x5d) {
      state.brackets = state.brackets - 1;
      state.prev = "]";
      state.i = at + 1;
      continue;
    }
    if (code === 0x3b) {
      state.declarator = false;
      state.afterParams = false;
      state.prev = ";";
      state.i = at + 1;
      continue;
    }

    // An optional marker: `?` immediately before `:`, `)` or `,` cannot be a
    // ternary, because a ternary always has a consequent.
    if (code === 0x3f) {
      const next: number = cc(source, at + 1);
      const ahead: number = cc(source, __modTsSkipTrivia(state, at + 1));
      if (next !== 0x2e && next !== 0x3f && (ahead === 0x3a || ahead === 0x29 || ahead === 0x2c)) {
        __modTsBlank(state, at, at + 1);
        state.i = at + 1;
        continue;
      }
      if (Number(state.parens.length) > 0) {
        state.parens[Number(state.parens.length) - 1].ternary = true;
      } else {
        state.declarator = false;
      }
      state.prev = "?";
      state.i = at + 1;
      continue;
    }

    // A non-null assertion, which is a `!` after a value and not `!=`.
    if (code === 0x21 && __modTsPrevIsValue(state.prev) && cc(source, at + 1) !== 0x3d) {
      __modTsBlank(state, at, at + 1);
      state.i = at + 1;
      continue;
    }

    if (code === 0x3a) {
      const inParens: boolean = Number(state.parens.length) > 0;
      const topTernary: boolean =
        inParens && state.parens[Number(state.parens.length) - 1].ternary === true;
      const inClassBody: boolean =
        Number(state.braces.length) > 0 &&
        state.braces[Number(state.braces.length) - 1] === "class";
      let annotation = false;
      let stopAtBrace = false;
      if (inParens && !topTernary && state.brackets === 0) {
        annotation = true;
      } else if (!inParens && state.afterParams) {
        annotation = true;
        stopAtBrace = true;
      } else if (!inParens && state.declarator) {
        annotation = true;
      } else if (!inParens && inClassBody && state.brackets === 0) {
        annotation = true;
      }
      if (annotation) {
        const typeAt: number = __modTsSkipTrivia(state, at + 1);
        const typeEnd: number = __modTsScanType(state, typeAt, stopAtBrace);
        __modTsBlank(state, at, typeEnd);
        state.i = typeEnd;
        state.afterParams = false;
        state.prev = "x";
        continue;
      }
      if (inParens) state.parens[Number(state.parens.length) - 1].ternary = false;
      state.prev = ":";
      state.i = at + 1;
      continue;
    }

    if (code === 0x3d && cc(source, at + 1) === 0x3e) {
      state.prev = "=>";
      state.afterParams = false;
      state.i = at + 2;
      continue;
    }
    if (code === 0x26 && cc(source, at + 1) === 0x26) {
      state.prev = "&&";
      state.i = at + 2;
      continue;
    }
    if (code === 0x7c && cc(source, at + 1) === 0x7c) {
      state.prev = "||";
      state.i = at + 2;
      continue;
    }

    state.prev = source.charAt(at);
    state.afterParams = false;
    state.i = at + 1;
  }

  return state.out.join("");
}

// ---------------------------------------------------------------------------
// base64 and the identity source map
// ---------------------------------------------------------------------------
//
// Written out rather than taken from `Buffer`: `src/buffer/buffer.ts` is
// inlined only for a test that requires `node:buffer`, and this must work in a
// bundle that does not.
function __modBase64Encode(text: string): string {
  // The payload is JSON, which is ASCII here except for a source URL, so the
  // string is encoded as UTF-8 bytes first.
  const bytes: number[] = [];
  let at = 0;
  while (at < Number(text.length)) {
    const code: number = cc(text, at);
    if (code < 0x80) {
      bytes.push(code);
    } else if (code < 0x800) {
      bytes.push(0xc0 + Math.floor(code / 64));
      bytes.push(0x80 + (code % 64));
    } else {
      bytes.push(0xe0 + Math.floor(code / 4096));
      bytes.push(0x80 + (Math.floor(code / 64) % 64));
      bytes.push(0x80 + (code % 64));
    }
    at = at + 1;
  }
  let out = "";
  let i = 0;
  const total: number = Number(bytes.length);
  while (i < total) {
    const b0: number = bytes[i];
    const b1: number = i + 1 < total ? bytes[i + 1] : 0;
    const b2: number = i + 2 < total ? bytes[i + 2] : 0;
    out = out + __MOD_BASE64_DIGITS.charAt(Math.floor(b0 / 4));
    out = out + __MOD_BASE64_DIGITS.charAt((b0 % 4) * 16 + Math.floor(b1 / 16));
    if (i + 1 < total) {
      out = out + __MOD_BASE64_DIGITS.charAt((b1 % 16) * 4 + Math.floor(b2 / 64));
    } else {
      out = out + "=";
    }
    if (i + 2 < total) {
      out = out + __MOD_BASE64_DIGITS.charAt(b2 % 64);
    } else {
      out = out + "=";
    }
    i = i + 3;
  }
  return out;
}

// Strip-only output is position-preserving, so the map that describes it is
// the identity: one segment per line, at column 0, pointing at the same line
// and column of the one source. `AAAA` is four zero deltas in base64 VLQ.
function __modIdentitySourceMap(source: string, sourceUrl: string): any {
  let lines = 1;
  let at = 0;
  while (at < Number(source.length)) {
    if (cc(source, at) === 0x0a) lines = lines + 1;
    at = at + 1;
  }
  const segments: string[] = [];
  let line = 0;
  while (line < lines) {
    segments.push(line === 0 ? "AAAA" : "AACA");
    line = line + 1;
  }
  return {
    version: 3,
    sources: [sourceUrl],
    names: [],
    mappings: segments.join(";"),
  };
}

// ---------------------------------------------------------------------------
// The experimental warning
// ---------------------------------------------------------------------------
//
// `lib/internal/util.js`' `emitExperimentalWarning`: once per feature, with
// Node's exact wording.
const __modWarnedExperimental: any = { __proto__: null };

function __modEmitExperimentalWarning(feature: string): void {
  if (__modWarnedExperimental[feature] === true) return;
  __modWarnedExperimental[feature] = true;
  process.emitWarning(
    feature + " is an experimental feature and might change at any time",
    "ExperimentalWarning",
  );
}

function stripTypeScriptTypes(code?: any, options?: any): string {
  // Node warns *before* it validates, so an invalid call still warns once.
  __modEmitExperimentalWarning("stripTypeScriptTypes");
  __modValidateString(code, "code");
  const settings: any = options === undefined ? {} : options;
  __modValidateObject(settings, "options");

  const sourceMap: any = settings.sourceMap === undefined ? false : settings.sourceMap;
  const sourceUrl: any = settings.sourceUrl === undefined ? "" : settings.sourceUrl;
  const mode: any = settings.mode === undefined ? "strip" : settings.mode;
  if (mode !== "strip" && mode !== "transform") {
    throw new ERR_INVALID_ARG_VALUE("options.mode", mode, "must be one of: 'strip', 'transform'");
  }
  __modValidateBoolean(sourceMap, "options.sourceMap");
  __modValidateString(sourceUrl, "options.sourceUrl");
  if (mode === "strip" && sourceMap !== false) {
    throw new ERR_INVALID_ARG_VALUE("options.sourceMap", sourceMap, "must be one of: false, undefined");
  }

  const stripped: string = __modStripTypes(String(code));

  if (sourceMap === true) {
    const payload: string = JSON.stringify(__modIdentitySourceMap(String(code), String(sourceUrl)));
    return (
      stripped + "\n\n//# sourceMappingURL=data:application/json;base64," +
      __modBase64Encode(payload)
    );
  }
  if (sourceUrl !== "") return stripped + "\n\n//# sourceURL=" + String(sourceUrl);
  return stripped;
}

// ---------------------------------------------------------------------------
// The program's own `require`
// ---------------------------------------------------------------------------
//
// CommonJS gives every file a `require`, a `module` and an `exports`. The
// bundler rewrites the test body's `require` to `__zunRequire`
// (tools/bundle_node_test.sh), which is the `require` of the bundled file's
// own module record — so `require.cache`, `require.resolve`,
// `require.resolve.paths` and `require.extensions` are the real ones, shared
// with `Module._cache` and `Module._extensions`.
//
// The record is built on first use rather than at load time: the bundler emits
// `__filename` *after* every library file, so a top-level initializer here
// would read it before its declaration.
function __modMain(): any {
  if (__modMainModuleRecord === undefined) {
    const record: any = __modNew(__filename, undefined);
    record.id = ".";
    record.filename = __filename;
    record.paths = Module._nodeModulePaths(path.dirname(__filename));
    record.loaded = true;
    __modMainModuleRecord = record;
    Module._cache[__filename] = record;
  }
  return __modMainModuleRecord;
}

function __zunRequire(id?: any): any {
  return __modRequireFrom(__modMain(), id);
}

// The other half of what CommonJS gives a file: its own `module`, with `id`,
// `filename`, `path`, `paths`, `children`, `exports` and `loaded`. It is a
// `let` set by `__modInitMain()` for the same reason `require.main` is -- the
// record reads `__filename` -- and it is declared here rather than by the
// bundler so that a test which spells `module.paths` compiles.
//
// `module.parent` is **absent** rather than `null`. Node only has it under
// `--pending-deprecation`, where reading it emits DEP0144, and this runtime
// honours no command-line flags, so answering `null` would be claiming a flag
// state it cannot have. `exports` is not bound either: `module.exports` is,
// and a bare top-level `exports` would collide with a test that declares one.
let module: any = undefined;

function __modMainResolve(request?: any, options?: any): any {
  __modValidateString(request, "request");
  return Module._resolveFilename(request, __modMain(), false, options);
}
__zunRequire.resolve = __modMainResolve;

function __modMainRequirePaths(request?: any): any {
  __modValidateString(request, "request");
  return Module._resolveLookupPaths(request, __modMain());
}
__zunRequire.resolve.paths = __modMainRequirePaths;

__zunRequire.cache = Module._cache;
__zunRequire.extensions = Module._extensions;

// `require.main` is `process.mainModule`, and in Node it is set on every
// module's `require` when the main module is created. It cannot be a getter
// here: `Object.defineProperty` on a *function* value aborts with
// "Object.defineProperty called on non-object" in this engine (a new gap,
// reported with this work -- it works on a plain object), and a plain
// assignment cannot run at load time either, because the record it needs
// reads `__filename`, which the bundler emits after every library file.
//
// So the bundler emits one `__modInitMain();` call after that declaration (see
// tools/bundle_node_test.sh), which is the position Node's own
// `setOwnProperty(module.require, 'main', process.mainModule)` occupies: after
// the main module exists and before user code runs.
__zunRequire.main = undefined;

function __modInitMain(): void {
  const record: any = __modMain();
  __zunRequire.main = record;
  process.mainModule = record;
  module = record;
}

// ---------------------------------------------------------------------------
// The module object
// ---------------------------------------------------------------------------

Module.createRequire = createRequire;
Module.builtinModules = builtinModules;
Module.isBuiltin = isBuiltin;
Module.constants = constants;
Module.enableCompileCache = enableCompileCache;
Module.getCompileCacheDir = getCompileCacheDir;
Module.flushCompileCache = flushCompileCache;
Module.findPackageJSON = findPackageJSON;
Module.findSourceMap = __modFindSourceMap;
Module.getSourceMapsSupport = __modGetSourceMapsSupport;
Module.setSourceMapsSupport = __modSetSourceMapsSupport;
Module.register = register;
Module.registerHooks = registerHooks;
Module.stripTypeScriptTypes = stripTypeScriptTypes;
Module.syncBuiltinESMExports = syncBuiltinESMExports;
Module.SourceMap = SourceMap;

// In Node `require('module')` *is* the `Module` constructor, so every static
// above is reachable through the module object and `module.Module === module`.
const __node_module: any = Module;
