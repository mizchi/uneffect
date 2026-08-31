# Self dogfood

Uneffect adopts its own checks from leaf utilities toward effectful boundaries.
This is intentionally separate from `just dogfood`: the existing command is an
inference-coverage gate, while `just dogfood-leaf` requires explicit,
constraint-bearing annotations and a load-bearing negative control.

## First boundary: static evaluation

`src/static-evaluation.ts` declares both exported evaluators as `effect none`
and its own initialization as `module_effect none`. The regression test checks
that both functions are `verified` with an empty may-effect set. Replacing one
declaration with `Console` produces an unused-effect diagnostic, demonstrating
that the annotation is checked rather than accepted as documentation.

The module summary remains `trusted`, not `verified`, because the file has a
runtime import of `typescript` and Uneffect does not prove that package's module
initialization. Therefore the leaf gate uses `--assurance no-unknown`; it must
not be described as proof that importing the file has no effects. The exact
current claim is:

- calls to the two selected evaluator implementations have no inferred
  capability effect in the supported call-graph fragment;
- the selected file and its emitted summaries contain no unknown evidence;
- initialization of the external TypeScript dependency remains an assumption.

Run the gate with:

```sh
just dogfood-leaf
```

The gate uses `--infer` deliberately. Runtime imports load a wider internal
Program whose unannotated dependencies are still adoption candidates. Inference
mode continues to enforce every annotation in the ten selected files while not
requiring unrelated dependencies to be annotated in the same change. The
`no-unknown` profile still rejects unknown summaries in the analyzed Program.

## Second boundary: byte coordinates

`src/project-coordinates.ts` now declares pure construction and display-name
formatting. Its returned `base` and `offset` methods separately declare
`Throw<Error>` for unknown files. The initial run exposed
`Mutate<typeof Object.keys(files)>`: mutation of the freshly returned keys array
was incorrectly treated as observable state. The general fix adds a reviewed
`fresh` result contract and marks `Object.keys` accordingly. A negative control
keeps the pure factory annotation load-bearing.

## Third boundary: disposal symbol traversal

`src/disposal-symbols.ts` keeps `Mutate<typeof seen>` on its recursive helper,
but the exported resolver is verified with `effect none`: its omitted `seen`
argument is the helper's fresh standard-library `new Set()` default. Call
composition recognizes array/object literals and TypeChecker-resolved standard
collection constructors as fresh defaults. Supplying an explicit Set still
propagates its Mutation to the caller, and the broken helper annotation is a
load-bearing negative control.

## Fourth boundary: diagnostic values

`src/diagnostics.ts` and `src/diagnostic-quality.ts` explicitly constrain
TypeScript diagnostic normalization, hints, text formatting, evidence
formatting, scoring, and report rendering to `effect none`. These functions
return strings and records; they do not write them to a terminal. Replacing the
first quality helper declaration with `Console` produces an unused-effect
diagnostic.

## Fifth boundary: CLI support

`src/cli-support.ts` now separates pure help formatting from terminal sinks and
usage failure. `writeStdout` and `writeStderr` declare `Console`;
`parseCommandArgs` and `singleFileArgument` declare `Throw<CliUsageError>`;
`formatCommandHelp` declares `none`. Dogfooding exposed that standard
`process.stdout.write` and `process.stderr.write` were previously missed. They
are now recognized as `Console` only through TypeChecker-resolved `Process`
properties, with a negative boundary test.

## Sixth boundary: environment inspection

`src/environment.ts` separates pure version parsing, status aggregation, and
report formatting from host access. Package manifest reads and package
resolution declare `FsRead`; subprocess version probes declare `Run`. The
negative control keeps the pure version parser honest.

This adoption found a real coverage gap in `resolvePackage`: loading
`package.json` through a dynamically created CommonJS `require` was invisible
to effect inference. The implementation now resolves the manifest path and
reads it explicitly with `readFileSync`, so the declared filesystem boundary is
checked instead of merely trusted. The higher-level environment/solver check
remains an inferred composite boundary for now; its cache mutation and backend
selection have not yet received a complete explicit contract.

## Seventh boundary: CLI entry values

`src/cli-runner.ts` verifies help construction as `none` and version lookup as
`FsRead`. The central `runCli` dispatcher is intentionally still inferred: it
invokes injected stream methods and command implementations, so declaring it as
plain `Console` would falsely identify arbitrary callbacks as the standard
terminal. A general callable-parameter effect contract is required before that
boundary can be stated precisely.

## Eighth boundary: fixture filesystem access

`src/fixtures.ts` verifies recursive fixture discovery and report reads as
`FsRead`, report persistence as `FsWrite`, and first-line summary extraction as
`none`. `listFixtures` uses an explicit sequential loop: its previous local
`Promise.all` callback conservatively introduced `InvokeUserCode`, obscuring the
filesystem-only contract. This is a local simplification, not a claim that
arbitrary `Promise.all` callbacks are pure.

## Ninth boundary: ownership evidence cache

`src/ownership-evidence-cache.ts` verifies cache-key construction as `none`,
cache loading as `FsRead`, and its temporary-file plus atomic-rename persistence
path as `FsWrite`. The write contract intentionally does not include `FsRead`:
directory creation, file creation, and rename mutate filesystem state but do not
consume file contents through the modeled Node APIs.

## Next adoption order

1. Add callable-parameter effect summaries for `CliStreams` and `CliCommand.run`,
   then use them to constrain `runCli` without collapsing callbacks into
   `Console`.
2. `doctor-command.ts`: compose environment inspection with CLI rendering while
   preserving the distinction between `FsRead`, `Run`, and `Console`.

Only add a file to `dogfood-leaf` after its positive evidence and a deliberately
broken variant are both tested. Later tiers should group effects by boundary:
filesystem and environment reads, solver subprocess/backend access, terminal
output, network access, and mutable caches.
