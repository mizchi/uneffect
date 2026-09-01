# Model refinement replay

Uneffect has a versioned neutral counterexample format and a TypeScript API for
checking whether an implementation follows the same action/state trace:

```ts
const trace = createModelCounterexample({
  backend: "quint",
  modelHash: "sha256-of-generated-model",
  initialState: { epoch: 1, owner: "A" },
  steps: [
    {
      action: "takeoverB",
      before: { epoch: 1, owner: "A" },
      after: { epoch: 2, owner: "B" },
    },
  ],
})

const result = await replayModelCounterexample(trace, {
  schema: "uneffect-refinement-adapter/v1",
  name: "lease-runtime",
  version: "1",
  create: (state) => new LeaseRuntime(state),
  observe: (runtime) => runtime.observe(),
  actions: {
    takeoverB: (runtime) => runtime.takeoverB(),
  },
  invariants: {
    singleWriter: (runtime) => runtime.singleWriter(),
  },
})
```

Generated adapters also retain their source-level `abstractions` record. This
is audit metadata: replay executes only the create/observe/action bindings
whose refinement was already checked and never evaluates abstraction strings.

The trace accepts only JSON-safe finite state. Creation rejects disconnected
steps whose `before` state differs from the initial state or preceding `after`
state. Replay clones the trace, checks the initial observation, dispatches each
named action, compares every resulting observation, and records invariant
violations by step. A missing action, adapter exception, or state mismatch is
not reported as a successful replay.

Normalized traces can be persisted and replayed in a later process:

```ts
writeModelCounterexample(".uneffect/counterexamples/lease.json", trace)

const persisted = readModelCounterexample(
  ".uneffect/counterexamples/lease.json",
  { expectedModelHash: "sha256-of-generated-model" },
)
const result = await replayModelCounterexample(persisted, adapter)
```

Writes use a same-directory temporary file and atomic rename. Both writing and
reading revalidate JSON-safe state and step continuity. Reading additionally
validates the artifact schema, backend, and optional expected model hash, so a
counterexample from an older generated model is reported as stale instead of
being silently replayed.

Quint integration uses its machine-readable path rather than scraping console
text:

```sh
quint run model.qnt --mbt --out-itf='trace_{seq}.itf.json' \
  --invariant=singleWriter
```

`parseQuintItfCounterexample` checks the ITF violation metadata, removes ITF
and MBT metadata from observed state, uses `mbt::actionTaken` for transitions,
and converts `#bigint` values to JavaScript numbers only when they are safe.
Larger integers remain tagged JSON objects and must be projected deliberately
by an adapter.

The temporal Z3 path does not scrape a printed model. Instead,
`findTemporalCounterexampleWithZ3` unrolls the neutral transition IR from depth
zero to the configured bound, constrains an explicit action selector at every
step, and returns the first satisfiable invariant violation as the same
normalized trace. Its result is one of `counterexample`, `safe-within-bound`,
or `unknown`; bounded safety is deliberately not reported as an unbounded
proof. The Node Lease fixture extracts the eleven-action skew violation and
replays it against TypeScript, while the skew-grace variant has no violation
within twelve steps.

`parseTlcCounterexample` supports TLC's console trace for scalar `int`/`bool`
and single- or multiline finite Set, scalar-key Map/function, and closed-record
values. Collections normalize to JSON-safe sorted arrays (Maps use `[key,
value]` pairs), while records normalize to objects. TLC prints only the
generated `q_step` action,
so Uneffect re-evaluates every neutral-IR guard and update against each adjacent
state pair. Exactly one action must match; zero or multiple matches are rejected
instead of assigning a guessed action name. The integration test executes an
actual two-step TLC violation in CI. Quint 0.32 advertises `--out-itf` for
`verify --backend=tlc`, but its TLC implementation does not currently write or
return that trace, so this path necessarily consumes console text. General
TLA+ values outside the declared Uneffect state fragment remain unsupported and
are not silently approximated.

The result binds hashes of the full trace and adapter metadata. The adapter
digest covers its schema, name, version, action names, and invariant names; the
adapter version is therefore a deliberate trust boundary for implementation
code changes.

## Current limit

The executable Node Lease fixture runs Quint with MBT ITF output, parses the
produced broken trace, replays all clock/takeover/publish actions, and observes
`singleWriter` failing at the same final step. A deliberately incorrect runtime
also produces a step-local mismatch. The same fixture now exercises the direct
bounded-Z3 trace path. Collection-valued standalone TLC output for the supported fragment is
covered as well. Uneffect generates replay adapters from typed refinement
manifests, not from implementation comments.

## Typed implementation bindings

`refinement_from` attaches a typed `.uneffect.ts` module that maps model roles
to exported implementation functions. `createRefinementAdapterFromManifest`
resolves the checked manifest against loaded module exports for test tooling,
and `generateRefinementAdapterModuleFromManifest` emits a reviewable
direct-reference module for build integration. The acceptance test parses the
temporal IR, asks Z3 for its shortest counterexample, builds the adapter from
the lowered typed manifest, and replays the violation through the
implementation functions.

Replay alone is structural refinement plumbing, not a proof that the
implementation refines the model. The separate action-body checker symbolically
compares the supported TypeScript update fragment with each model action. Its
scalar control-flow fragment includes `if`/`else`, bounded literal `for` loops,
and literal `switch` labels with JavaScript entry order, fallthrough, unlabeled
`break`, and `default`. A switch becomes conditional temporal expressions over
the discriminant evaluated before any clause update. Dynamic or duplicate
labels and labeled breaks fail closed as `unsupported-action-body`; they are
never accepted by replay evidence alone. Direct case-terminal returns and
supported pure throws also join through the same completion lattice. An
enclosing catch consumes only the selected throw entries, finally runs on every
selected entry, and statements after the switch run only for entries that
remain normal. A value-bearing non-call return is accepted only when its
expression normalizes in the pure refinement-expression fragment. The returned
value is intentionally not compared because a temporal action describes state
updates, not a TypeScript function result. A thrown state-backed expression is
likewise normalized and resolved for purity. Scalar `int`/`bool` payloads are
retained across direct and conditional `if` completion and may bind an immutable
catch local. Switch payload joins, untracked/string/object payloads, effectful
or unresolved return calls, effectful thrown expressions, and nested or labeled
switch transfers remain unsupported.
The checker also sequences a mandatory `finally` block after a normally
completing `try` update. Its first exception-aware fragment recognizes a direct
terminal supported pure `throw` in the try block, routes the accumulated state
through the catch body, and then applies an optional `finally`. The thrown
expression must be either a primitive literal or normalizable in the pure
refinement-expression fragment, so evaluating it cannot hide another effect.
A top-level conditional supported pure throw in the try block also
splits exceptional and normal paths: only the exceptional path executes catch,
the normal path executes the remaining try statements, both states are joined,
and `finally` plus statements after the try run on the join. Catch-value-
dependent code outside the tracked scalar payload fragment, implicit
exceptions, nested or nonterminal throws, and abrupt completion during
unwinding remain fail-closed. The telemetry
accounting dogfood selects delivered or dropped accounting through this join
and finalizes its audit state in `finally`.
Outside a `try`, a direct branch-final `return` is a supported completion:
the returned path keeps its updates while only the continuing path executes
the statements following the `if`. Updates made before the branch are retained
on both paths. A direct or top-level conditional void return inside `try` also
executes `finally` on every path; statements after the try execute only on the
normally continuing path before both states are joined. This is the first
resource-cleanup completion rule, not general disposal proof. Supported pure
value returns follow the same completion path as void returns after their
expression has been validated. Nested abrupt completion not represented by
these joins remains fail-closed. A return or supported pure throw originating in
`finally` overrides prior completion on its selected paths, applies preceding
finally updates, and suppresses statements after the try where it is abrupt.

Action collection now keeps symbolic state separate from an explicit
`normal | return | throw | mixed(returnWhen, throwWhen)` completion. A mixed
completion records separate pre-state predicates for paths that have already
completed in either way. Enclosing conditionals apply their remaining
statements only where neither predicate holds, then join state and completion.
This supports nested early-return and nested-throw branches without flattening
them into syntax-specific guards. A surrounding catch applies its updates only
to `throwWhen`, discharges that predicate after a normally completing catch,
and retains `returnWhen` across common `finally`. Statements after that try run
only on paths that still complete normally (including a throw path discharged
by catch), then their state and completion are joined with the retained return
path. A catch may itself end paths with a conditional return or a supported
pure rethrow; those predicates are composed under the original `throwWhen`,
and every resulting path still crosses a common finally. Pure non-call value
returns use the same predicates but do not establish a contract for the
returned result. Effectful or unresolved return calls, effectful rethrow
expressions, non-scalar or untracked catch-value-dependent control,
abrupt completion originating in finally beyond the supported conditional return/pure-throw fragment,
break, continue, labels, and general loops are still not represented. A finally
completion overrides a retained try/catch completion on
the paths where finally returns or throws; where finally is normal, the prior
completion survives. The Z3-backed validator can discharge syntactic
differences between equivalent boolean guards and integer action updates. The
syntax-only validator deliberately keeps exact normalized comparison as its
fast path.

Function bodies, source hashes, checked refinement results, and generated
module type checking must all participate in any proof-grade evidence policy.
