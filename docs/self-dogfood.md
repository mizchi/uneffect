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

## Native migration dogfood

The [diagnostic review evaluation](dogfood-evaluation.md) separates coverage
gaps, manually confirmed product bugs, and injected negative controls. Its
first review reproduced and fixed two existing replay bugs: inherited action
dispatch and reference-based collection equality during TLC action recovery.
`just dogfood-native` also runs their public-API regression tests.

`just dogfood-native` runs the default Corsa/Oxc CLI against the actual
`src/support/diagnostic-quality.ts`, `src/support/environment.ts`, and
`src/evidence/model-replay.ts` sources with JavaScript TypeScript imports
blocked. `dogfood/native-syntax-baseline.json` caps syntax blockers per file
and unknown summaries; a minimum summary count and named criterion checks
guard against silently dropping analyzed functions. This is a migration
regression gate: the checked application still exits 1 under `no-unknown`.

The first iteration found unsupported object handlers and literal member
accesses. Oxc now records ordinary object methods, arrow/function-valued
properties, and string/number literal member names. Dynamic keys and object
accessors remain excluded. Corsa still authenticates builtin identity:
`console["log"]` carries `Console`, while a shadowed parameter does not.
Boundary tests also found property reads disappearing when used as call or
constructor arguments; these reads now stay in the syntax facts.

| Measure, on the same three source files | Before | After |
| --- | ---: | ---: |
| Unsupported syntax diagnostics | 50 | 16 |
| Collected function summaries | 105 | 111 |
| Unknown effect summaries | 64 | 64 |

The remaining 16 syntax diagnostics concern dynamic property keys. The
argument-read fix exposes one of those that the old collector omitted.
The added six summaries belong to the real diagnostic criteria. A mutation
test inserts `console["log"]` into the actual `location` criterion and
requires its own summary to contain `Console`. Callback dispatch is still
unmigrated: `scoreDiagnostic` remains unknown. These results establish syntax
coverage and direct builtin effects, not annotation enforcement or body proof.

The next iteration carries known effects through direct calls to synchronous
top-level function declarations in the selected files. Corsa symbol identity
links same-file calls, renamed imports, and re-exports. The compiler-independent
`effects/effect-propagation.ts` uses the shared CFG fixed-point engine to union
effects through callers, including recursive cycles. A second real-source
mutation inserts Console into `environment.ts`'s `minimumMajor`; the effect
now reaches both `nodeCheck` and `runEnvironmentChecks` (previously only the
helper carried it). The packed CLI repeats a direct-call and shadowing check
with JavaScript compiler imports blocked.

This step preserves unknown evidence for local calls, including pure-looking
cycles. It accumulates known effects without claiming a complete upper bound;
the three-file unknown baseline remains 64. Mutable aliases, object dispatch,
async/generator callees, and unselected implementations remain unlinked.
Assignments exclude stale function bodies. Shorthand destructuring exposed a
native position query that returns a property symbol instead of the assigned
variable; those writes conservatively exclude same-name candidates until the
binding-specific query is connected. Direct eval excludes the file's body
candidates. These exclusions and a same-name parameter are regression tests.

The review of those coverage reports reproduced two actual replay bugs; the
results and limits are recorded in [the evaluation](./dogfood-evaluation.md).
An opt-in CFG policy now automatically redetects the historical inherited-action
lookup: `cfg-lint --registry adapter.actions` flags the original unguarded read
and accepts the current same-expression own-property guard. This is regression
rediscovery of a known bug, not a new automatic discovery. `just dogfood-native`
includes both historical/current real-source checks with JS compiler imports
blocked. The policy's runtime assumptions and selectable expression/statement scopes are explicit
in [the linter documentation](./cfg-lint.md#registry-own-entry-policy).

The next evaluation applies the rule to six additional actual sites. It reports
three missing guarantees; execution reproduces two new bugs in diagnostic hints
and capability source selection. Both are fixed and included in `just dogfood-native`.
The remaining finding concerns inherited anchor configuration and is not counted
as a confirmed bug. Two other sites remain unknown. `just registry-dogfood`
prints the current results; before/after source digests and spans are checked in
under `dogfood/registry-evaluation-*.json`. The related runtime assertion emitter
also had collection reference equality and now has execution regressions for
content comparison. The evaluation separates this manual finding from the two
new linter-assisted discoveries.

The remaining anchor finding was subsequently reproduced as a digest mismatch:
different inherited/nonenumerable bindings generated different permission paths
with the same digest. Projection now snapshots explicit own bindings once for
both arguments and evidence. Const captures, template evaluation order, and
frozen-table `Object.keys` provenance extend the registry policy; all six selected
sites now pass under its explicit assumptions. The evaluation records which
improvements required analyzer changes and which required source fixes.

The annotation parser adds four function/table selections. Their findings led
to reproductions of exceptions on unknown dialects, accepted unknown temporal
clauses, and lost payloads for explicitly added directives named like inherited
properties. Own-entry checks fix these symptoms without banning those names.
Nine API regressions and all ten source selections run in `just dogfood-native`.
The current source results are nine clean and one unknown: the last lookup was
removed in favor of a membership check, and empty extraction deliberately does
not claim success. Before/after evidence and this limitation are recorded as
DF-007 in [the evaluation](./dogfood-evaluation.md).

Native effect propagation now links synchronous inline functions on authenticated
frozen module tables. The diagnostic criterion table is frozen, and an injected
Console effect reaches `criterionSatisfied`, `scoreDiagnostic`, and `evaluateQuality`.
The original purity regression still passes on the Program path. Unknown effect
bounds and the existing syntax/unknown baseline remain explicit. This is coverage
progress demonstrated by a mutation control, not an additional real bug discovery.
`just dogfood-native` also runs native Boolean branch/early-return contract proofs
against frozen Program results, including a wrong branch and its counterexample.

The next native contract slice admits safe integer literal parameters and finite
unions authenticated from native payloads, including imported aliases. Addition,
subtraction, multiplication, negation, and comparisons share BigInt range checks
between bodies and clauses. A bound on a broad `number` never implies integrality.
Unsafe intermediates remain unsupported even when a later operation cancels them
mathematically. Numeric proofs use `safe-integer-arithmetic` coverage, and fixed
Program cases preserve successful and violated contracts. General numbers, brands,
division, path-refined arithmetic bounds, and call-contract composition remain open.

## First boundary: static evaluation

`src/frontends/typescript/static-evaluation.ts` declares both exported evaluators as `effect none`
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
`ownership-evidence-cache.ts`. Dynamic computed properties, object accessors,
and unresolved calls still keep other leaf files outside that Corsa baseline.
Ordinary object handlers and literal member names are covered by the native
migration gate above. The annotation gate loads a TypeScript Program so its Node and
callable-parameter annotations stay load-bearing. Runtime imports load
a wider internal Program whose unannotated dependencies are still adoption
candidates. Inference mode continues to enforce every annotation in the selected
files while not requiring unrelated dependencies to be annotated in the same
change. `src/cli/cli-runner.ts` is now in the `--assurance no-unknown` file list;
runtime-selected command and loader calls use an explicit opaque callable
contract. The `no-unknown` profile still rejects unknown summaries elsewhere in
the analyzed Program.

## Second boundary: byte coordinates

`src/frontends/typescript/project-coordinates.ts` now declares pure construction and display-name
formatting. Its returned `base` and `offset` methods separately declare
`Throw<Error>` for unknown files. The initial run exposed
`Mutate<typeof Object.keys(files)>`: mutation of the freshly returned keys array
was incorrectly treated as observable state. The general fix adds a reviewed
`fresh` result contract and marks `Object.keys` accordingly. A negative control
keeps the pure factory annotation load-bearing.

## Third boundary: disposal symbol traversal

`src/resources/disposal-symbols.ts` keeps `Mutate<typeof seen>` on its recursive helper,
but the exported resolver is verified with `effect none`: its omitted `seen`
argument is the helper's fresh standard-library `new Set()` default. Call
composition recognizes array/object literals and TypeChecker-resolved standard
collection constructors as fresh defaults. Supplying an explicit Set still
propagates its Mutation to the caller, and the broken helper annotation is a
load-bearing negative control.

## Fourth boundary: diagnostic values

`src/support/diagnostics.ts` and `src/support/diagnostic-quality.ts` explicitly constrain
TypeScript diagnostic normalization, hints, text formatting, evidence
formatting, scoring, and report rendering to `effect none`. These functions
return strings and records; they do not write them to a terminal. Replacing the
first quality helper declaration with `Console` produces an unused-effect
diagnostic.

## Fifth boundary: CLI support

`src/cli/cli-support.ts` now separates pure help formatting from terminal sinks and
usage failure. `writeStdout` and `writeStderr` declare `Console`;
`parseCommandArgs` and `singleFileArgument` declare `Throw<CliUsageError>`;
`formatCommandHelp` declares `none`. Dogfooding exposed that standard
`process.stdout.write` and `process.stderr.write` were previously missed. They
are now recognized as `Console` only through TypeChecker-resolved `Process`
properties, with a negative boundary test.

## Sixth boundary: environment inspection

`src/support/environment.ts` separates pure version parsing, status aggregation, and
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

`src/cli/cli-runner.ts` verifies help construction as `none` and version lookup as
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

`src/support/fixtures.ts` verifies recursive fixture discovery and report reads as
`FsRead`, report persistence as `FsWrite`, and first-line summary extraction as
`none`. `listFixtures` uses an explicit sequential loop: its previous local
`Promise.all` callback conservatively introduced `InvokeUserCode`, obscuring the
filesystem-only contract. This is a local simplification, not a claim that
arbitrary `Promise.all` callbacks are pure.

## Ninth boundary: ownership evidence cache

`src/optimizer/ownership-evidence-cache.ts` verifies cache-key construction as `none`,
cache loading as `FsRead`, and its temporary-file plus atomic-rename persistence
path as `FsWrite`. The write contract intentionally does not include `FsRead`:
directory creation, file creation, and rename mutate filesystem state but do not
consume file contents through the modeled Node APIs.

## Tenth boundary: model replay persistence

`src/evidence/model-replay.ts` verifies counterexample loading as `FsRead` plus its
validation/clone effects. Atomic persistence is `FsWrite | Random` because its
exclusive temporary filename contains `randomUUID()`, and also retains the
validation and rethrow effects. `Throw<unknown>` and `Throw<Error>` are both
listed: the current throw lattice treats them as distinct tracked alternatives,
not as TypeScript-style assignability where `unknown` is automatically an
upper bound.

## Eleventh boundary: project optimization evidence

`src/optimizer/project-optimizer.ts` verifies persisted-proof parsing as `FsRead` and the
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

`src/cli/doctor-command.ts` now declares the composite environment boundary used by
its `run` method: manifest reads, solver environment reads, retained solver
evidence writes, Java probing, the native-driver cache mutation, and reviewed
external calls below those checks. Its `io` parameter separately allows
`Console`, so terminal output is not collapsed into the command body's effect
row. Removing `FsRead` produces a missing-effect diagnostic in the focused
Program regression.

## Thirteenth boundary: TODO hierarchy consistency

`src/support/todo-consistency.ts` declares both Markdown task parsing and stale-parent
detection as `effect none`. They only construct local task trees and return
values; sorting the fresh result does not mutate caller-owned state. A negative
control replaces the parser's empty bound with `Console` and requires the
unused-effect diagnostic.

## Fourteenth boundary: refinement fixed point

`src/cfg/fixed-point.ts` constrains `solveBasicBlockFixedPoint` to
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

Reviewing the remaining `src/effects/call-graph.ts` unknowns did not justify replacing
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
