// The global `console`, under two names.
//
// This is its own file because the declaration is what shadows the engine's
// prelude `console` — and because a test that declares its own top-level
// `console` cannot be bundled alongside it: two top-level declarations of one
// name are a compile error in a single Zun program.
// `tools/bundle_node_test.sh` leaves this file out for such a test and renames
// the test's own binding instead; ../console/console.ts owns everything except
// the names.
//
// Why there are two names for one object:
//
//   * `console` is the name Node programs read, destructure
//     (`const { Console } = console`) and index (`console[method]`), and it has
//     to exist for those.
//   * `__zunConsole` is the name every *dotted method call* is rewritten to,
//     because the identifier `console` is not usable as a receiver here. Two
//     engine behaviours make it so, and they compound:
//       - `console.log`, `info`, `debug`, `warn`, `error`, `group`,
//         `groupCollapsed`, `groupEnd`, `count`, `countReset` and `assert` are
//         intercepted by the checker and lowered to the prelude's own console
//         (`zun_sema/src/check.rs`' `check_console_variadic`) **with no
//         user-declaration guard** — unlike the sibling computed-key path,
//         which does check `cx.lookup(...)`. A program that declares `console`
//         still has those eleven calls taken away from it.
//       - a module-level `const console` is visible to `console.<method>` only
//         at *top level*: inside a function the same call resolves against the
//         prelude namespace and dies with `call did not resolve to a method`.
//     Both repros are in ../../test/console/README.md. Renaming the receiver
//     steps around both at once, and since both names denote the very same
//     object, `console === require('console')` and every mutation through one
//     name is visible through the other — which is exactly Node's relationship
//     between the global and the module.
const console: any = __node_console;
const __zunConsole: any = __node_console;
