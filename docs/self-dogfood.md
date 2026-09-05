# Self dogfood

Uneffect adopts its own checks from leaf utilities toward effectful boundaries.
This is intentionally separate from `just dogfood`: the existing command is an
inference-coverage gate, while `just dogfood-leaf` requires explicit,
constraint-bearing annotations and a load-bearing negative control.
The repository-wide gate does not run every analysis domain over one giant
Program. The dogfood suite uses focused project boundaries for effect,
contract, async, ownership, and temporal checks; its self-effect case still
loads all `src/*.ts` together. Open callback-timing summaries remain
intentionally unknown: reused intermediates and nested optional callback
paths still lack a stable-container proof. Iterator-parameter and generator-
consumption unknowns in `src/` were closed by bounded iterator forwarding and
omitted default-argument instantiation; arbitrary `Iterable<T>` values stay
fail-closed. That case requires zero effect diagnostics and an explicit
allow-listed reason code on every unknown summary, so they cannot silently
become proof.

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

The constraint-bearing gate uses `--typescript-program --infer` deliberately.
Default `uneffect check` is Corsa plus Oxc and fail-closes unsupported syntax;
it does not enforce Node builtin annotations. A separate Corsa baseline remains
on the currently supported self-hosted subset, `static-evaluation.ts` and
`ownership-evidence-cache.ts`. Object-member functions and computed properties
keep the other leaf files outside that Corsa baseline instead of being silently
accepted. The annotation gate loads a TypeScript Program so its Node and
callable-parameter annotations stay load-bearing. Runtime imports load
a wider internal Program whose unannotated dependencies are still adoption
candidates. Inference mode continues to enforce every annotation in the selected
files while not requiring unrelated dependencies to be annotated in the same
change. `src/cli-runner.ts` is now in the `--assurance no-unknown` file list;
runtime-selected command and loader calls use an explicit opaque callable
contract. The `no-unknown` profile still rejects unknown summaries elsewhere in
the analyzed Program.

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
`FsRead`. `runCli` declares `FsRead | Env<"UNEFFECT_DEBUG"> | InvokeUserCode` with
`effect_parameter io extends Console`. `CliStreams` uses readonly function
properties so `io.out` / `io.err` are reviewed nested callable parameters
rather than `Console` on the dispatcher itself. `CliCommand.run` and command
loader `load` are readonly function properties with an exact
`effect InvokeUserCode` contract. The dispatcher is therefore verified against
one coarse runtime-code boundary without unioning every command implementation
into its body row. Removing the property contract returns `runCli` to
`unresolved-call`; adding `Console` to `runCli` remains unused.

Making property signatures fail closed exposed a previously hidden dynamic
call in `scoreDiagnostic`. The exported criterion callbacks remain compatible,
but internal scoring now dispatches over the closed criterion-id union through
static callback identities. Its existing pure dogfood contract is verified
again instead of relying on the old property-signature omission.

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

## Tenth boundary: model replay persistence

`src/model-replay.ts` verifies counterexample loading as `FsRead` plus its
validation/clone effects. Atomic persistence is `FsWrite | Random` because its
exclusive temporary filename contains `randomUUID()`, and also retains the
validation and rethrow effects. `Throw<unknown>` and `Throw<Error>` are both
listed: the current throw lattice treats them as distinct tracked alternatives,
not as TypeScript-style assignability where `unknown` is automatically an
upper bound.

## Eleventh boundary: project optimization evidence

`src/project-optimizer.ts` verifies persisted-proof parsing as `FsRead` and the
full regeneration boundary as `FsRead | FsWrite | InvokeUserCode`. The latter
retains `InvokeUserCode` because it traverses values supplied by the external
TypeScript compiler API; this is not presented as a filesystem effect.

Dogfooding also generalized the reviewed fresh-result contract from
`Object.keys` to `Object.entries`. Sorting the newly allocated entries array no
longer leaks a fictitious mutation of caller-owned state, with a direct
regression test for both builtins. The optimizer itself uses `toSorted()` to
state its non-mutating intent. Its reviewed contract preserves synchronous
comparator timing metadata and marks the returned array fresh; `sort()` remains
modeled as a destructive mutation of its receiver. Propagating an inline
comparator's own effects through an enclosing function is not claimed by this
dogfood case and remains part of the general callback-composition work.

## Twelfth boundary: doctor command

`src/doctor-command.ts` now declares the composite environment boundary used by
its `run` method: manifest reads, solver environment reads, retained solver
evidence writes, Java probing, the native-driver cache mutation, and reviewed
external calls below those checks. Its `io` parameter separately allows
`Console`, so terminal output is not collapsed into the command body's effect
row. Removing `FsRead` produces a missing-effect diagnostic in the focused
Program regression.

## Thirteenth boundary: TODO hierarchy consistency

`src/todo-consistency.ts` declares both Markdown task parsing and stale-parent
detection as `effect none`. They only construct local task trees and return
values; sorting the fresh result does not mutate caller-owned state. A negative
control replaces the parser's empty bound with `Console` and requires the
unused-effect diagnostic.

## Fourteenth boundary: refinement fixed point

`src/refinement-flow.ts` constrains `solveBasicBlockFixedPoint` to
`InvokeUserCode | Throw<Error>`. The caller-defined lattice and transfer
functions are deliberately opaque `InvokeUserCode` boundaries; that does not
authorize host effects in the engine itself. A negative control inserts
`console.log` into the engine and requires a missing `Console` diagnostic, so
the contract is narrower than an arbitrary-effect escape hatch.

Adoption exposed a runtime topology-validation bug. A transfer callback could
mutate the array that originally supplied a block's readonly `edges` property,
then return the newly inserted successor after validation. The engine now
snapshots each declared successor set before invoking caller code. A regression
test preserves the counterexample and requires `invalid-cfg` after one
iteration. TypeScript `readonly` remains a compile-time API promise; the
verifier no longer relies on it as runtime immutability.

## Deep-core counterexample: construction freshness

Reviewing the remaining `src/call-graph.ts` unknowns did not justify replacing
them with an opaque annotation: an injected `FrontendSymbolAdapter` is an
actual extension boundary, and the default adapter may perform package
resolution. That unknown remains explicit instead of understating it as pure
or as generic `InvokeUserCode`.

The same review found a separate false negative in fresh-receiver handling.
`new Registry(entries)` was treated as deeply fresh even when a constructor
parameter property retained the caller's mutable array, so a later mutation of
`this.entries` disappeared. Freshness now requires owned nested state for
source-local classes. Both parameter-property and explicit-assignment
counterexamples fail closed as `Mutate<unknown-alias>`, while literal-owned
builder state keeps the existing construction-phase optimization.

## Next adoption order

Choose the next boundary from an observed, currently classified unknown in a
real command or application path. Treat a false positive or false negative
found during adoption as a product bug, and preserve its smallest
counterexample before expanding the allow-list. Do not widen opaque callable
contracts beyond `InvokeUserCode`; a more precise row requires
implementation-linked evidence.

Only add a file to `dogfood-leaf` after its positive evidence and a deliberately
broken variant are both tested. Later tiers should group effects by boundary:
filesystem and environment reads, solver subprocess/backend access, terminal
output, network access, and mutable caches.
