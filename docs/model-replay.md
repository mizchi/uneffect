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

The trace accepts only JSON-safe finite state. Creation rejects disconnected
steps whose `before` state differs from the initial state or preceding `after`
state. Replay clones the trace, checks the initial observation, dispatches each
named action, compares every resulting observation, and records invariant
violations by step. A missing action, adapter exception, or state mismatch is
not reported as a successful replay.

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
and compact single-line finite Set, scalar-key Map/function, and closed-record
values. Collections normalize to JSON-safe sorted arrays (Maps use `[key,
value]` pairs), while records normalize to objects. TLC prints only the
generated `q_step` action,
so Uneffect re-evaluates every neutral-IR guard and update against each adjacent
state pair. Exactly one action must match; zero or multiple matches are rejected
instead of assigning a guessed action name. The integration test executes an
actual two-step TLC violation in CI. Quint 0.32 advertises `--out-itf` for
`verify --backend=tlc`, but its TLC implementation does not currently write or
return that trace, so this path necessarily consumes console text. Multiline
and general TLA+ values remain unsupported and are not silently approximated.

The result binds hashes of the full trace and adapter metadata. The adapter
digest covers its schema, name, version, action names, and invariant names; the
adapter version is therefore a deliberate trust boundary for implementation
code changes.

## Current limit

The executable Node Lease fixture runs Quint with MBT ITF output, parses the
produced broken trace, replays all clock/takeover/publish actions, and observes
`singleWriter` failing at the same final step. A deliberately incorrect runtime
also produces a step-local mismatch. The same fixture now exercises the direct
bounded-Z3 trace path. Compact collection-valued standalone TLC output is
covered as well. Uneffect does not yet generate adapters
from source annotations.

## Annotated implementation bindings

The `refinement` directive attaches model roles to existing exported functions.
`createAnnotatedRefinementAdapter` resolves the checked manifest against loaded
module exports for test tooling, and `generateRefinementAdapterModule` emits a
reviewable direct-reference module for build integration. The acceptance test
parses one annotated source into temporal IR, asks Z3 for its shortest
counterexample, builds the adapter from the same source annotations, and
replays the violation through the implementation functions.

These bindings are structural refinement plumbing, not a proof that the
implementation refines the model. A successful replay confirms the selected
counterexample only. Function bodies, source hashes, and generated module type
checking must still participate in any proof-grade evidence policy.
