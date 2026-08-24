# Command line

The package publishes one binary, `uneffect`. Every capability is a subcommand
of it, so `uneffect --help` is the complete entry point and each subcommand
documents its own options with `uneffect <command> --help`.

## Install

```sh
npm install --save-dev @mizchi/uneffect typescript
npx uneffect check src/*.ts
```

TypeScript is a peer dependency: the analyzer reads your program through the
same compiler you build with, so the project chooses the version. Node.js 24 or
newer is required.

`@informalsystems/quint` is an optional peer dependency. The model commands
generate Quint source with nothing installed; add the package only to run what
they generate, and its own `quint` binary comes with it:

```sh
npm install --save-dev @informalsystems/quint
npx uneffect spec quint src/protocol.ts > protocol.qnt
npx quint run protocol.qnt
```

## Commands

| Command | Purpose |
| --- | --- |
| `check <file.ts> [...]` | Effect, contract, and async-safety diagnostics. The default command, so `uneffect <file.ts>` runs it. |
| `doctor` | Check the toolchain a run depends on: Node, the peer TypeScript, `@types/node`, the Z3 WASM build, the optional Quint peer, and the optional `java` command. |
| `spec <backend> <file.ts> [function]` | The specification IR, or the verifier program a backend consumes: `ir`, `lint`, `z3`, `quint`, `compose`, `async-quint`, `web-loop-quint`, `node-loop-quint`, `promise-quint`. |
| `instrument <file.ts>` | The source with runtime assertions inserted for contracts or ownership. |
| `evidence <file.ts>` | The machine-readable effect evidence artifact, as JSON. |
| `resource-model <file.ts>` | The Quint resource-safety model. |
| `async-model <file.ts> <function>` | The unified Quint model of Promise, exception, and resource flow. |

`check` takes `--infer` (only check functions that already declare effects),
`--strict` (an unknown effect name is an error, not a warning), and
`--evidence` (also print the proved obligations and the inferred effect of every
function). `instrument` takes `--ownership`, `--verify-ownership`, and
`--ownership-evidence <cache.json>`. `spec lint` takes the strengthening and
synthesis options listed by its own `--help`.

## Checking the prerequisites

The toolchain has real requirements — Node 24, a TypeScript peer, and a working
Z3 WASM build — and most of them fail late and confusingly if they are missing.
`uneffect doctor` checks all of them before you depend on a run:

```
$ uneffect doctor
ok       node                    v24.4.0 (engines: >=24)
ok       typescript              6.0.3 at node_modules/typescript (peer: >=6.0.0-dev.20260820)
ok       @types/node             24.13.3 at node_modules/@types/node
ok       z3-solver               4.16.0, probe query answered in 380 ms
warn     @informalsystems/quint  not installed
           needed by: running the models `spec quint`, `resource-model`, and `async-model` generate
           fix: npm install --save-dev @informalsystems/quint, an optional peer; it brings its own `quint` binary, and generating the models needs nothing
warn     java (command)          not found on PATH
           needed by: exhaustive Quint verification through Apalache/TLC
           fix: install a JDK 21 or newer only if you run `quint verify`; simulation and every uneffect command work without it
```

Nothing in the list is a native install: every solver the toolchain runs itself
is the `z3-solver` WASM build, so `check`, `instrument --verify-ownership`, and
the evidence artifacts need no Z3 binary on the machine. The two optional
entries are for running what the model commands generate, not for producing it.

Packages are resolved from the project being checked first, then from this
installation, because a peer dependency belongs to the project and only the
project's copy is the one a run uses.

Every check names the commands it blocks and how to satisfy it. Unmet
requirements exit 1; missing optional tools are warnings and exit 0. `--json`
emits the same result for CI, and `--skip-solver-probe` skips loading the Z3
WASM build, which is the slow check.

When any other command fails for a reason that is not about your source, it
points at `uneffect doctor` rather than printing a bare stack; set
`UNEFFECT_DEBUG=1` to see the stack anyway.

## Streams and exit codes

Generated output — instrumented source, Quint modules, SMT-LIB, JSON artifacts —
goes to stdout, so it can be piped into a file or a verifier. Diagnostics and
progress go to stderr.

| Code | Meaning |
| --- | --- |
| 0 | Nothing to report. |
| 1 | The checked program failed: an error-severity diagnostic, or a lint that found something. |
| 2 | The command line was wrong: an unknown command, an unknown option, or a missing argument. |

Options are parsed strictly. A misspelled flag such as `--stict` is a usage
error rather than a silently ignored word, so a typo never turns a strict run
into a permissive one.

## Versions

`uneffect --version` reports the published npm version. The contract layers —
CLI surface, evidence schema, builtin registry, Corsa interchange, optimizer
obligations, and the Rust crate — carry their own version, which is what an
evidence artifact records as `uneffectVersion`; see
[native integration](./native-integration.md).
