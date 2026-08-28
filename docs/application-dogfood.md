# Application dogfood

Uneffect is periodically run against unmodified application code outside this
repository. These observations are compatibility probes, not claims that the
whole application was verified. Each entry records the source revision, chosen
boundary, command, machine result, and the regression it locked.

## vlmkit image-generation client

Observed on 2026-08-26 against `mizchi/vlmkit` revision
`bae6db2e85ad16b2e6bdcfc72d592798b691ac4b`, using the unmodified file
`packages/vlmkit-ai/src/image-gen-client.ts` and the repository root
`tsconfig.json`.

```sh
uneffect check \
  --project /path/to/vlmkit/tsconfig.json \
  --infer --evidence --assurance no-unknown \
  /path/to/vlmkit/packages/vlmkit-ai/src/image-gen-client.ts
```

The first observation found two checker defects:

1. the CLI could not consume the application's TypeScript configuration;
2. Program-wide effect analysis omitted `process.env` even though the
   single-file analyzer recognized it.

After the fixes, the client reports:

- `createImageGenClient`: `Env<"OPENAI_API_KEY"> | Throw<VrtConfigError>`;
- `generate`: `Fetch<POST, Unknown<dynamic-url>> |
  Net<Unknown<dynamic-origin>>`.

The default gradual check therefore remains useful and exits successfully. The
`no-unknown` profile now fails with two blockers for the dynamic URL and
origin. Before this dogfood pass it incorrectly returned `passed (verified)`
because it inspected only the summary evidence tag and not unknown sets nested
inside a capability. Unit and CLI regression tests retain both fixes.

The same boundary is also exercised through `check --json`. Its
`uneffect-check/v1` report returns `outcome: "failed"`, zero ordinary
diagnostic errors, `assurance.status: "unknown"`, and the two source-attributed
capability blockers. This distinction is intentional: the analyzed program is
well typed, while the requested assurance claim is not established.

The provenance field additionally reports analyzer TypeScript `6.0.3` versus
vlmkit's resolved `6.0.2`, producing a separate `typescript` unknown blocker.
This local cross-repository check is therefore not presented as compiler-parity
evidence; the network-authority blockers remain independently visible.

This result does not prove the OpenAI request succeeds, that the response parser
is complete, that every rejection is handled by callers, or that the dynamic
base URL is safe. A consumer can make the network authority finite by proving
or asserting a bounded configuration value at its own boundary; declaring a
broad `Fetch` effect alone must not erase the unknown origin.

## mnemo D1 telemetry wrapper

An observation of `mizchi/mnemo`'s unmodified
`mnemo-server/src/telemetry/d1-wrap.ts` exposed a compiler-version boundary.
The project configuration intentionally relied on TypeScript 5.x defaults,
while Uneffect currently declares a TypeScript 6 peer whose strict-family
defaults differ. `--project` loaded the configuration, but the run correctly
remained non-proof-grade due to TS7006 diagnostics and a missing local
Cloudflare type installation. Uneffect did not reinterpret those errors or
claim Proxy/Reflect semantics.

The machine report also records `consumerVersion: null` and
`parity: "unknown"` because TypeScript is not resolvable from the uninstalled
mnemo project boundary. That resolution blocker is distinct from the source
diagnostics and remains even if the file parses under Uneffect's development
compiler.

This is a compatibility finding, not an application defect. Reliable assurance
requires the consumer and Uneffect to agree on the TypeScript version and to
make version-sensitive compiler defaults explicit.

The new programmatic boundary was also run read-only against
`mnemo-server/tsconfig.json` at revision
`5cbf27107339dbbf92546065f3df5b6dec9dddce`:

```ts
await verifyUneffectProject({ projectFile: "/path/to/mnemo/mnemo-server/tsconfig.json" })
```

It returned `uneffect-project-workspace/v1` with one config/domain, no reference
edges, and `assurance.status: "violated"`. The aggregate retained 124 TypeScript
and 1,028 downstream unknown-effect/diagnostic blockers rather than allowing
the large inferred inventory to hide the invalid compiler boundary. These
counts describe this revision and local dependency state; they are regression
observations, not stable quality metrics for mnemo.
The config is not composite and produced no SolutionBuilder artifact status, so
`buildArtifacts.status` is `unknown`; freshness was not required for this probe.

## workhub solution graph

Observed read-only on 2026-08-26 against `mizchi/workhub` revision
`089c385082644d30f4fceef88e41236b624a6b29`, using its unmodified root
`tsconfig.json`. The relevant config and package source paths were clean; other
unrelated paths in the repository were already modified.

```sh
uneffect check --project /path/to/workhub/tsconfig.json \
  --infer --assurance no-unknown --json
```

The workspace loader discovered eight compiler domains and thirteen reference
edges. The run failed closed rather than producing one flattened Program. It
reported 54 `duplicate-root-file` graph blockers because the solution root has
references but no explicit `files` or `include`, so TypeScript's default include
also selects package sources owned by referenced child configs. It separately
reported effect, coverage, TypeScript diagnostic, and unresolved compiler
provenance blockers.

This observation demonstrates that the graph and ownership boundary is useful;
it is not by itself evidence of an application bug. In particular, Uneffect has
not established that every duplicate is invalid under all intended `tsc`
workflows, nor has it composed effects across the packages. The actionable
result is narrower: the requested assurance boundary is ambiguous and therefore
cannot pass until the solution root's source ownership is made explicit and the
consumer TypeScript installation is resolvable.

The same revision was then exercised through
`verifyUneffectProject({ projectFile })`. The programmatic result retained all
eight configs and thirteen edges, ran eight independent verifier domains, and
failed with the same 54 duplicate-root blockers plus 308 TypeScript and 468
unknown-effect/diagnostic blockers. It recorded 207 trusted assumptions but did
not let them override the violations. This parity check locks the intended
relationship between the CLI graph decision and the richer verifier bundle;
it still does not establish cross-package semantic composition.
SolutionBuilder additionally reported eight TS6352 observations: every
configured buildinfo output was absent, so `buildArtifacts.status` was `stale`.
The adoption probe did not require prebuilt outputs. Enabling
`buildArtifacts: "require-fresh"` or the CLI flag would add a separate unknown
blocker before any result could authorize consumption of those artifacts.

### StateStore project-reference edge

The same revision has a real source-bearing edge from packages such as
`github-monitor` and `x-monitor` to `core`: consumers call the exported
`StateStore.get/set` methods. A repository-derived acceptance fixture preserves
the relevant class method, async suspension, dynamic record key, and
project-reference call shape. It adds only this attempted marker to `set`:

```ts
/* uneffect: refinement stateStore@1 action set */
async set(key: string, value: unknown): Promise<void> {
  const data = await this.load()
  data[key] = value
  // filesystem persistence follows
}
```

This is intentionally not accepted as a scalar cross-project proof. It requires
class-method bindings, an async completion model, dynamic-key record
abstraction, alias identity for `data`, and `FsWrite` composition. Previously
the marker was silently ignored because refinement extraction visited only
top-level function declarations, allowing the workspace ledger to appear
`not-applicable`. It now produces a source-attributed
`refinement-composition` violation stating that the declaration shape is
unsupported, and workspace assurance fails. Removing the attempted marker is a
load-bearing negative control and restores `not-applicable`; that result is not
a proof of `StateStore`.

The fixture is a compatibility/blocker probe, not a claim that the unmodified
Workhub application is verified. Class/dynamic alias support belongs to #24,
general async/resource completion remains outside the scalar #20 fragment, and
collection-valued temporal state belongs to #5. This result closes the immediate
dogfood question without widening any of those proof boundaries.

## luna.mbt bundled UI runtime

Observed read-only on 2026-08-26 against `mizchi/luna.mbt` revision
`9f36cd8d2d02cd82418cf96ce8aae7aee27975da`, selecting
`js/luna/tsconfig.json`. Unrelated MoonBit package manifests in the repository
were already modified and were not touched by this probe. The selected config
contains 34 TypeScript source roots, resolves the same TypeScript 6.0.3 package
version as Uneffect, enables `composite`, and deliberately sets `noEmit: true`.
Its checked-in `dist` directory is produced by a separate bundling pipeline.

```sh
uneffect check --project /path/to/luna.mbt/js/luna/tsconfig.json \
  --infer --assurance no-unknown \
  --require-exact-build-artifacts --json
```

SolutionBuilder reported `fresh` from `tsconfig.tsbuildinfo`, but exact output
assurance returned `outputIntegrity.status: "error"` with
`TypeScript project does not emit runtime JavaScript`. This is the intended
decision: the existing bundled `dist/*.js` files must not be equated with a
TypeScript emit merely because both are current. The same run also found many
unknown higher-order/dynamic Effect summaries, so it is not application-level
proof even apart from build mapping.

This observation exposed a presentation-level vacuity: an empty
`effectComposition` ledger was previously labelled `verified`. It now reports
`not-applicable`; `verified` requires at least one accepted cross-project link.
Supporting Luna's bundled output requires an explicit, validated transform
mapping and remains open work rather than a trusted bypass.

The same run exposed a contradictory assurance payload: the failed
`no-unknown` assessment retained positive claim strings such as “no emitted
effect summary is unknown.” The decision was already fail-closed, but a consumer
reading only `claims` could receive a false signal. Failed assessments now emit
`claims: []`; their unmet conditions are represented only as blockers.

After adding structured unknown provenance, the same 34-file run reports 39
unknown summaries with no unexplained entries: 26 are
`unknown-callback-timing`, nine are `unreviewed-external-module`, and four are
`unknown-dependency` propagated from those modules. This is a classification,
not a proof improvement. It shows that the next useful semantic step is an
explicit callback-timing/effect-parameter contract, while the nine external
module initializers require reviewed version-bound contracts rather than a
broad Effect declaration.

The repository's own strict `just dogfood` gate also fails closed. Reviewed
ECMAScript synchronous-callback and pure helper contracts, Node helper
contracts, and export-equals named-import resolution reduced its unknown module
summaries from 39 to two. Exact-version external function contracts reviewed the
Valibot 1.4.2 schema factories. A version-bound callable-result contract then
modeled Corsa 1.12.4 `RuleCreator`, including its synchronously invoked captured
URL callback. The current repository self-analysis has zero unknown summaries.
This is a statement about the checked source and exact dependency versions, not
a claim that arbitrary package code or all JavaScript behavior is verified.
The same 67-file boundary records 3,694 builtin and module-initialization
assumption occurrences. Consequently `--assurance no-unknown` passes as
`assumed`, while the new `--assurance verified` profile rejects the boundary.
The count is an observation of this revision rather than a stable target; its
purpose is to keep reviewed semantics visible instead of hiding them behind
declaration-checked summaries.

### Root solution graph

The same revision was later checked read-only through the repository root
`tsconfig.json`, rather than only through `js/luna/tsconfig.json`. The root is a
well-formed solution config with `files: []` and six references, so it provides
a useful contrast with Workhub's ambiguous default-include root.

```ts
await verifyUneffectProject({
  projectFile: "/path/to/luna.mbt/tsconfig.json",
})
```

The workspace report retained seven configs (the empty solution root plus six
source-owning child domains), six reference edges, and the child-first build
order. It found 66 selected source roots and no TypeScript diagnostics. The
SolutionBuilder observation was `fresh`, but freshness was not required and
runtime output bytes were not checked. The aggregate remained `unknown` with
75 Effect blockers and 620 reviewed assumptions. These counts describe the
observed revision and are not stable quality targets.

Both `effectComposition` and `refinementComposition` were `not-applicable`, not
`verified`: this star-shaped solution has no annotated source-bearing parent to
child edge. In particular, the run does not exercise the supported guarded
scalar/`globalThis` refinement link. The later Workhub `StateStore` probe above
adds an attempted marker to an actual cross-project edge and correctly retains
the unsupported shape as a blocker without changing the analyzer's admitted
fragment merely to make it pass.

This run exposed one reporting defect. The workspace-level exclusions inherited
the child-only statement that referenced domains still required aggregation,
even though the workspace had already aggregated them. Workspace reports now
replace the two project-local scope statements with one exact statement: the
assessment covers selected source roots in every loaded tsconfig compiler
domain. A regression test locks this distinction.

## Cross-project top-level-await candidate survey

On 2026-08-28, the first `uneffect-workspace-module-order/v1` slice was checked
against the locally available `mizchi/workhub` and `mizchi/luna.mbt` solution
graphs. A TypeScript AST scan searched their non-generated `.ts`, `.tsx`,
`.mts`, and `.cts` sources for `AwaitExpression` nodes outside functions and
classes. It found no top-level await in either graph, so neither application is
an eligible positive case for the new cross-project TLA fragment.

This is an honest negative dogfood result: the analyzer did not widen ordinary
async functions into module initialization merely to produce a success. The
load-bearing application-shaped acceptance case is therefore a two-project
NodeNext solution fixture with exact declaration and runtime output checks. It
accepts one child module with one straight-line TLA and rejects both a
conditional TLA and an await followed by unconditional throw. A real external
application claim remains absent until an application actually contains the
supported boundary.

## Budgeted refinement CFG seed

The application-shaped `examples/dogfood/telemetry-fixed-point-drain.ts` models
success/failure accounting around a telemetry-send boundary. Its dynamic
ranking loop has one normal delivery predecessor and one scalar throw/catch
failure predecessor. `analyzeRefinementActionBodies` verifies the exact affine
accounting and emits a converged `ranking-loop-fixed-point` obligation whose
reusable worklist retains normalized model payload `pending`, both normal
snapshot facts, their throw-specialized expression environments, and the
correlated joined environment within a 16-step budget. It also retains a stable
affine recurrence certificate for the `pending` countdown, its one-iteration
updates, and its closed-form summary. Dogfood now passes that certificate to the
async Z3 analysis, which independently proves the base case, every scalar
inductive step, and the countdown ranking obligation. A modified certificate
is covered by summary and ranking fault injections; unavailable solver evidence
is `unknown`, not a structural success.
Replacing the caught amount with the normal-path delivered counter keeps the
obligation `unknown` as an unsupported coupled recurrence.
The example deliberately does not model the network send itself, so it is not
evidence that a Datadog client or host I/O is bounded.

The application-shaped `routeTelemetryRecovery` action in
`telemetry-routing-accounting.ts` now emits a
`handler-join-fixed-point` obligation. Its direct finite switch contributes
normal, return, and throw completions; catch consumes the throw path; mandatory
finally receives both remaining normal and return paths. The shared worklist
converges under the named `cfg-fixed-point-iterations` budget. A one-step budget is `unknown`, and a
modified catch rethrow remains visible as an outgoing throw while action
validation fails. The reusable lowerer also consumes the existing
`nestedRejectTelemetry` nested-if/throw/catch action: its two source-keyed `if`
blocks retain normal and throw reachability and catch consumes the throw. A
loop substituted inside that attempted family is emitted as
`unknown: unsupported-control-flow`, not silently omitted. The focused
development-host benchmarks measured 2.1536 ms mean over 233 samples for the
switch family and 2.1111 ms over 237 samples for the nested-if family. This is
control-reachability evidence coupled to action validation, not general nested
try, loop, arbitrary-sequence, or independent value proof support.

The same builder now spans the prefix and suffix around the single control root
in `returnOrRejectTelemetry`. Its return branch reaches try completion directly
and therefore cannot enter the following throw statement; catch turns only the
throw branch into normal completion, while normally completing finally carries
both normal and return to exit. The focused benchmark measured 2.0640 ms mean
over 243 samples. Widening the application scan also discovers
`rejectTelemetry`: its control graph converges in 14 evaluations, but structural
value validation retains a redundant nested conditional and reports
`action-validation-failed`. That result is intentionally still `unknown`; P2.5
does not claim path-correlated value equivalence.

P2.6 feeds the exact caught predicate into the value phi for that retained
case. On the `auditArmed` catch path, an inner conditional guarded by the same
normalized expression is restricted to its true branch, reducing the dropped
update to the declared model expression. The artifact records
`caughtWhen: auditArmed` and the
`same-predicate-branch-restriction` rule. Replacing the catch guard with
`attempted > 0` is a load-bearing negative: no correlation evidence is emitted
and the action stays `unknown: action-validation-failed`. The focused benchmark
measured 2.1138 ms mean over 237 samples. This is exact syntactic path
correlation, not Z3-proved predicate equivalence.

The repository-wide `just dogfood` run on 2026-08-28 is green after retaining
the lexical owner of resource-free dynamic outer-loop `continue` completions.
The core CLI reports no diagnostics and the `no-unknown` assessment passes as
`assumed` (3,747 summaries, 4,336 reviewed assumption occurrences, 74 files).
This closes the seven previously observed
`async/unsupported-control-transfer` diagnostics with one reusable owner rule.
Unknown loop cardinality is represented in generated Quint by a
nondeterministic repeat-or-exit choice; this is not a termination or fairness
proof. Dynamic loops containing `using`/`await using`, unresolved labels, and
resource-generation joins remain explicit unsupported cases.
