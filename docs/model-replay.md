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

The result binds hashes of the full trace and adapter metadata. The adapter
digest covers its schema, name, version, action names, and invariant names; the
adapter version is therefore a deliberate trust boundary for implementation
code changes.

## Current limit

The executable Node Lease fixture runs Quint with MBT ITF output, parses the
produced broken trace, replays all clock/takeover/publish actions, and observes
`singleWriter` failing at the same final step. A deliberately incorrect runtime
also produces a step-local mismatch. Uneffect does not yet parse standalone TLC
or temporal Z3 output, nor generate adapters from source annotations.
