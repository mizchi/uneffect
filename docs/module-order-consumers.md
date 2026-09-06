# Module-order evidence consumers: design notes

These notes retain reusable concepts from a discarded browser-player prototype.
They are design guidance for consumers of `uneffect-module-order/v2`, not an
implemented player, a new public API, or an expansion of #18's proof fragment.

## Separate the three claims

1. Parsing establishes that an artifact satisfies its versioned schema and
   references existing module/event identities.
2. Path selection chooses a represented branch and await outcome and produces
   one ordering consistent with the selected events and dependency constraints.
3. Verification establishes the claimed domain result from its bound source,
   compiler, and semantic rules. A serialized `verified` or `converged` field
   alone cannot establish that result for a consumer.

A deterministic path is not observed JavaScript execution, a host schedule,
elapsed-time evidence, selector feasibility, or a liveness proof. Structural
reachability also does not establish successful await settlement.

## Consumer invariants worth preserving

- Validate schema version, unique identities, source spans, and all referenced
  endpoints before following an edge. Bound artifact size and traversal work.
- For the current conditional fragment, preserve both false and resumed normal
  completion. The true branch must suspend and resume before completing.
- Rejection is terminal; it does not pass through the normal join. An importer
  cannot start while a required dependency has failed to complete normally.
- Keep alternate paths distinct from mandatory ordering constraints. Flattening
  every branch edge into one sequence invents dependencies between alternatives.
- Unknown evidence, failed domain checks, unsupported cycles, and exhausted
  budgets remain inspectable non-proofs. They must not become successful replay
  or verification merely because a consumer can draw a graph.
- Keep source/compiler provenance with the event or edge that uses it. Reading
  a digest is distinct from recomputing it against the source being consumed.
- Derive a replay frame from its selected event prefix so rewinding or changing
  scenarios cannot retain a previous rejection or completion state.

## Useful negative controls

Any future consumer or independently checked domain should retain controls for
a suspend-to-complete bypass, missing false branch, rejection-to-join edge,
early importer start, dangling or duplicate identities, inconsistent event/CFG
copies, stale provenance, and hidden cycles. Mutating a runtime selector from
`const` to `let` remains the existing analyzer-backed unsupported control.

The resume-bypass control exposed a domain-gate gap tracked in
[#71](https://github.com/mizchi/uneffect/issues/71): a predicted `await-resume`
label previously sufficed even when a consistently mutated CFG skipped that
event. The bounded fix tracks an outstanding resumption obligation separately
from the label. The production lowering itself already emitted the correct
path; the control tests the independent domain check under an implementation
fault, not a new source-language family.

The other controls can inform #18's future bounded children. They do not justify
activating general ESM, arbitrary CFG, host scheduling, or independently
checkable proof-certificate work without its own acceptance case and estimate.

A warm analyzer benchmark for the hardened domain measured 0.9747 ms mean
(513 samples, ±6.27% RME) on the local Node 24 / TypeScript 6.0.3 environment.
This is an observation, not a performance guarantee; the named 32-iteration
proof budget remains unchanged. See `bench/module-initialization-v2.bench.ts`.

The prototype UI, frontend dependencies, server tasks, and browser CI are not
part of this repository's maintained implementation.
