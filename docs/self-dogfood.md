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
mode continues to enforce every annotation in the six selected files while not
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

## Next adoption order

1. `environment.ts`: separate environment and tool probing from pure report
   formatting, then constrain its process/environment boundaries.
2. `cli-runner.ts`: propagate the reviewed CLI stream and command effects into
   the command dispatch boundary without treating arbitrary injected streams as
   the standard terminal.

Only add a file to `dogfood-leaf` after its positive evidence and a deliberately
broken variant are both tested. Later tiers should group effects by boundary:
filesystem and environment reads, solver subprocess/backend access, terminal
output, network access, and mutable caches.
