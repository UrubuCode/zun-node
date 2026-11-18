//! `zun-node-run` — a `node`-shaped launcher, so that a Node test which runs
//! `process.execPath` as a child works against the Zun engine.
//!
//! # The problem
//!
//! Most of Node's `child_process` tests re-run **themselves**:
//!
//! ```js
//! cp.spawnSync(process.execPath, [__filename, 'child']);
//! cp.exec(`"${process.execPath}" -p "'a'.repeat(1024)"`);
//! ```
//!
//! `process.execPath` is the `zun` binary, and `zun run` accepts a Zun
//! TypeScript program, not a raw CommonJS file (the engine has no `require`:
//! <https://github.com/UrubuCode/zun/issues/4>), and has no `-e`/`-p`.
//!
//! # The decision
//!
//! `process.execPath` is **this launcher** whenever the test harness asks for
//! it (the `ZUN_NODE_SHIM` variable, set by `tools/run_node_tests.sh`; without
//! it `execPath` stays the `zun` binary, which is the honest answer outside a
//! test run). The launcher speaks Node's command line and does what the harness
//! does for a test: it puts the script (or the `-e` / `-p` text) through
//! `tools/bundle_node_test.sh` and runs the bundle with `zun run --ext`.
//!
//! ```text
//! zun-node-run [node flags] <script.js> [args...]
//! zun-node-run [node flags] -e <code> [args...]
//! zun-node-run [node flags] -p <expression> [args...]
//! ```
//!
//! It is configured by three variables the runner exports (and the TypeScript
//! layer re-adds when a test replaces the child's environment):
//!
//! - `ZUN_NODE_ZUN`      the `zun` binary,
//! - `ZUN_NODE_EXT`      the extension library (also read by the bundler),
//! - `ZUN_NODE_BUNDLER`  `tools/bundle_node_test.sh`,
//! - `ZUN_NODE_BASH`     the `bash` that runs it (optional; `PATH` otherwise —
//!   on Windows `PATH` may name WSL's `bash.exe` before Git's).
//!
//! The bundle is cached by the script's path and content, so a test that
//! spawns itself several times pays for one bundling. `process.argv[1]` in the
//! child is the bundle (not the original file); `__filename` and `__dirname`
//! are the original's, because the bundler embeds them.
//!
//! `zun-node-run --test [flags] [files...]` is Node's test-runner CLI: the
//! launcher writes a two-line script that hands the `--test-*` flags and the
//! files (none: Node's default discovery from the working directory) to
//! `node:test`'s `run()` (src/test/run.ts' `__ntCli`), and runs that script as
//! above.
//!
//! Every Node flag the launcher sees before the script reaches the child as
//! its `process.execArgv`, through `ZUN_NODE_EXEC_ARGV` (`"A"` then the flags,
//! `U+001F`-separated: the `ZUN_NODE_ARGV` convention).
//!
//! What this is **not**: a Node. Node flags other than `-e`/`-p`/`--test` are
//! accepted and passed on as `execArgv`, but otherwise ignored; there is no REPL
//! and no stdin script, and `--require`/`--import` preloads are skipped. It
//! exists for the harness; it is a development tool.

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode};

/// Flags that take a separate value, which must not be mistaken for the script.
const VALUE_FLAGS: &[&str] = &[
    "-r",
    "--require",
    "--import",
    "--input-type",
    "-C",
    "--conditions",
    "--max-old-space-size",
    "--stack-size",
    "--title",
    "--test-reporter",
    "--test-reporter-destination",
    "--test-name-pattern",
    "--test-skip-pattern",
    "--test-concurrency",
    "--test-timeout",
    "--test-shard",
    "--test-isolation",
    "--test-coverage-include",
    "--test-coverage-exclude",
    "--experimental-config-file",
];

/// The Node flags before the script: every flag in `--test` mode, where the
/// positional arguments are test files rather than a script.
fn exec_flags(args: &[String]) -> Vec<String> {
    let test_mode = args.iter().any(|a| a == "--test");
    let mut out = Vec::new();
    let mut index = 0;
    while index < args.len() {
        let arg = args[index].as_str();
        if arg == "--" || matches!(arg, "-e" | "--eval" | "-p" | "--print" | "-pe" | "-ep") {
            break;
        }
        if VALUE_FLAGS.contains(&arg) {
            out.push(arg.to_owned());
            if let Some(value) = args.get(index + 1) {
                out.push(value.clone());
            }
            index += 2;
        } else if arg.starts_with('-') && arg != "-" {
            out.push(arg.to_owned());
            index += 1;
        } else if test_mode {
            index += 1;
        } else {
            break;
        }
    }
    out
}

/// `value` as a JavaScript string literal.
fn js_string(value: &str) -> String {
    let mut out = String::from("\"");
    for ch in value.chars() {
        match ch {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

fn fail(message: &str) -> ExitCode {
    eprintln!("zun-node-run: {message}");
    ExitCode::from(1)
}

fn variable(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|value| !value.is_empty())
}

enum Source {
    File(PathBuf),
    /// `-e` (`false`) or `-p` (`true`): the program text and whether to print it.
    Text(String, bool),
    /// `--test [files...]`: the test-runner CLI over these files.
    Test(Vec<String>),
}

/// Split Node's command line into the program and the arguments it receives.
fn parse(args: &[String]) -> Option<(Source, Vec<String>)> {
    if args.iter().any(|a| a == "--test") {
        let mut files = Vec::new();
        let mut index = 0;
        while index < args.len() {
            let arg = args[index].as_str();
            if arg == "--" {
                files.extend(args[index + 1..].iter().cloned());
                break;
            }
            if VALUE_FLAGS.contains(&arg) {
                index += 2;
                continue;
            }
            if !(arg.starts_with('-') && arg != "-") {
                files.push(arg.to_owned());
            }
            index += 1;
        }
        return Some((Source::Test(files), Vec::new()));
    }
    let mut index = 0;
    while index < args.len() {
        let arg = args[index].as_str();
        match arg {
            "-e" | "--eval" | "-p" | "--print" | "-pe" | "-ep" => {
                let text = args.get(index + 1)?.clone();
                let print = matches!(arg, "-p" | "--print" | "-pe" | "-ep");
                return Some((Source::Text(text, print), args[index + 2..].to_vec()));
            }
            "--" => {
                let script = args.get(index + 1)?;
                return Some((Source::File(PathBuf::from(script)), args[index + 2..].to_vec()));
            }
            _ if VALUE_FLAGS.contains(&arg) => index += 2,
            _ if arg.starts_with('-') && arg != "-" => index += 1,
            _ => return Some((Source::File(PathBuf::from(arg)), args[index + 1..].to_vec())),
        }
    }
    None
}

/// The most recent modification time (in nanoseconds since the epoch) of any
/// file under `directory`.
fn newest_modification(directory: &Path) -> u128 {
    let mut newest = 0u128;
    let Ok(entries) = std::fs::read_dir(directory) else { return 0 };
    for entry in entries.flatten() {
        let path = entry.path();
        let stamp = if path.is_dir() {
            newest_modification(&path)
        } else {
            entry
                .metadata()
                .and_then(|meta| meta.modified())
                .ok()
                .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|elapsed| elapsed.as_nanos())
                .unwrap_or(0)
        };
        newest = newest.max(stamp);
    }
    newest
}

fn cache_dir() -> PathBuf {
    std::env::temp_dir().join("zun-node-run-cache")
}

/// Bundle `source` (a CommonJS file) and answer the path of the `.ts` bundle.
fn bundle(bundler: &str, source: &Path) -> Result<PathBuf, String> {
    // `absolute`, not `canonicalize`: on Windows the latter yields a `\?\`
    // verbatim path, which the bundler (a POSIX shell script) cannot use.
    let absolute = std::path::absolute(source)
        .map_err(|err| format!("cannot resolve {}: {err}", source.display()))?;
    let bytes = std::fs::read(&absolute).map_err(|err| format!("cannot read script: {err}"))?;
    let mut hasher = DefaultHasher::new();
    absolute.hash(&mut hasher);
    bytes.hash(&mut hasher);
    // A bundle is also a function of the library it inlines: without this a
    // cached bundle outlives an edit to `src/` and silently runs the old code.
    if let Some(root) = Path::new(bundler).parent().and_then(Path::parent) {
        newest_modification(&root.join("src")).hash(&mut hasher);
        newest_modification(&root.join("tools")).hash(&mut hasher);
    }
    let key = hasher.finish();

    let directory = cache_dir();
    std::fs::create_dir_all(&directory).map_err(|err| format!("cache directory: {err}"))?;
    let output = directory.join(format!("{key:016x}.ts"));
    if output.is_file() {
        return Ok(output);
    }

    // Bundle to a private name and rename, so two children racing on the same
    // script never see a half-written file.
    let partial = directory.join(format!("{key:016x}.{}.partial", std::process::id()));
    let bash = variable("ZUN_NODE_BASH").unwrap_or_else(|| "bash".to_owned());
    let status = Command::new(&bash)
        .arg(bundler)
        .arg(&absolute)
        .arg(&partial)
        .stdout(std::process::Stdio::null())
        .status()
        .map_err(|err| format!("cannot run bash {bundler}: {err}"))?;
    if !status.success() {
        return Err(format!("the bundler failed for {}", absolute.display()));
    }
    std::fs::rename(&partial, &output).or_else(|_| {
        // Lost a race with a sibling that finished first: its file is as good.
        if output.is_file() {
            let _ = std::fs::remove_file(&partial);
            Ok(())
        } else {
            Err(())
        }
    })
    .map_err(|()| "cannot publish the bundle".to_owned())?;
    Ok(output)
}

fn main() -> ExitCode {
    // A guard against runaway re-execution: a script that decides it is "the
    // parent" in every generation would otherwise fork-bomb the machine.
    let depth: u32 = variable("ZUN_NODE_DEPTH").and_then(|d| d.parse().ok()).unwrap_or(0);
    if depth >= 8 {
        return fail("re-execution depth limit (8) reached");
    }
    let args: Vec<String> = std::env::args().skip(1).collect();
    let (Some(zun), Some(bundler)) = (variable("ZUN_NODE_ZUN"), variable("ZUN_NODE_BUNDLER")) else {
        return fail("ZUN_NODE_ZUN and ZUN_NODE_BUNDLER must be set (see tools/run_node_tests.sh)");
    };
    let Some((source, rest)) = parse(&args) else {
        return fail("no script given (only a script file, -e and -p are supported)");
    };

    // `-e`/`-p` text becomes a file of its own so the bundler can take it.
    let flags = exec_flags(&args);
    let is_eval = matches!(source, Source::Text(..) | Source::Test(..));
    let script = match source {
        Source::File(path) => path,
        Source::Test(files) => {
            let files: Vec<String> = files.iter().map(|f| js_string(f)).collect();
            let quoted: Vec<String> = flags.iter().map(|f| js_string(f)).collect();
            let text = format!(
                "const {{ run }} = require('node:test');\n__ntCli(run, [{}], [{}]);\n",
                quoted.join(", "),
                files.join(", ")
            );
            let mut hasher = DefaultHasher::new();
            text.hash(&mut hasher);
            let directory = cache_dir();
            if std::fs::create_dir_all(&directory).is_err() {
                return fail("cannot create the cache directory");
            }
            let file = directory.join(format!("test-cli-{:016x}.js", hasher.finish()));
            if std::fs::write(&file, text).is_err() {
                return fail("cannot write the test-runner script");
            }
            file
        }
        Source::Text(text, print) => {
            let mut hasher = DefaultHasher::new();
            text.hash(&mut hasher);
            print.hash(&mut hasher);
            let directory = cache_dir();
            if std::fs::create_dir_all(&directory).is_err() {
                return fail("cannot create the cache directory");
            }
            let file = directory.join(format!("eval-{:016x}.js", hasher.finish()));
            let body = if print { format!("console.log(\n{text}\n);\n") } else { format!("{text}\n") };
            if std::fs::write(&file, body).is_err() {
                return fail("cannot write the eval script");
            }
            file
        }
    };

    let bundled = match bundle(&bundler, &script) {
        Ok(path) => path,
        Err(message) => return fail(&message),
    };

    let mut command = Command::new(&zun);
    command.arg("run");
    if let Some(ext) = variable("ZUN_NODE_EXT") {
        command.arg("--ext").arg(ext);
    }
    // The `zun` CLI takes no script arguments, so the child's `process.argv`
    // tail travels in `ZUN_NODE_ARGV` (read by `src/process/process.ts`): the
    // original script path for a file, then the arguments.
    let mut tail: Vec<String> = Vec::new();
    if !is_eval {
        let original = std::path::absolute(&script).unwrap_or_else(|_| script.clone());
        tail.push(original.to_string_lossy().into_owned());
    }
    tail.extend(rest.iter().cloned());
    command.env("ZUN_NODE_ARGV", format!("A{}", tail.join("\u{1f}")));
    command.env("ZUN_NODE_DEPTH", (depth + 1).to_string());
    command.env("ZUN_NODE_EXEC_ARGV", format!("A{}", flags.join("\u{1f}")));
    command.arg(&bundled);
    match command.status() {
        Ok(status) => match status.code() {
            Some(code) => ExitCode::from((code & 0xff) as u8),
            None => ExitCode::from(1),
        },
        Err(err) => fail(&format!("cannot run {zun}: {err}")),
    }
}
