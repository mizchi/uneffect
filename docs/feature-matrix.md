# Feature matrix

This is the release-boundary view of Uneffect as of 2026-08-24. It condenses
the historical checklist in `TODO.md` into user-visible capability areas.

Status has a deliberately narrow meaning:

- **Tested fragment**: executable regression tests cover the documented
  subset. This is not a claim about arbitrary TypeScript.
- **Partial**: useful end-to-end paths exist, but composition or language
  coverage still has a tracked soundness boundary.
- **Planned**: design or scaffolding may exist, but no user-facing proof claim
  should depend on it yet.

Unsupported syntax, unresolved symbols, stale evidence, and solver limits must
produce a diagnostic or an explicit `unknown`; they must not be interpreted as
successful verification.

## Current capability surface

| Area | Status | What can be relied on today | Main boundary / next issue |
| --- | --- | --- | --- |
| Gradual comment syntax | Tested fragment | `/* uneffect: ... */` annotations coexist with ordinary TypeScript and parse into capability, invariant, and temporal projections. Optional runtime assertions are separate from zero-runtime metadata. | The annotation expression language is intentionally smaller than TypeScript. |
| Capability effects | Tested fragment | Declared effects are upper bounds; inferred effects propagate through supported symbol-resolved call graphs; missing and unused effects are diagnosed. Builtin and registered user-defined effects use structured sets. | Dynamic dispatch, reflection, proxies, unknown callbacks, and native addons remain conservative boundaries. |
| Deno-compatible permissions | Tested fragment | `FsRead`, `FsWrite`, `Net`, `Env`, `Run`, `Sys`, `Ffi`, and `Import` share finite/unbounded authority-set semantics. Filesystem scopes support explicit symbolic anchors including `$TEMP`. | Deployment allow/deny policy is outside function effect unions. |
| Fetch, DOM, and transfer ownership | Tested fragment | Fetch method/URL scopes, DOM operation classes and identity regions, and Worker transferable invalidation have regression coverage. | Full shared-memory and Atomics semantics are not modeled. |
| User-defined effects and validators | Tested fragment | Versioned effect schemas and proof-backed validator specializations are available. The cardinality lattice covers supported local/cross-module and Generator paths. | Opaque callbacks, recursion, and unsupported iterator control flow remain `unknown`. |
| Hoare contracts and Z3 | Partial | Restricted integer/machine-number preconditions, postconditions, invariants, assignments, and selected control flow generate reviewable SMT-LIB and executable Z3 obligations. | Arbitrary TypeScript expressions, heap aliasing, termination, and general loops are not proved. See [#3](https://github.com/mizchi/uneffect/issues/3). |
| Temporal models and Quint | Partial | Typed state/actions, safety, bounded reachability, selected liveness fragments, replay, and reviewable Quint generation are implemented for documented finite/bounded models. | General formulas, synthesis, collection correlations, and broader TLC interoperability remain open. See [#2](https://github.com/mizchi/uneffect/issues/2) and [#5](https://github.com/mizchi/uneffect/issues/5). |
| TypeScript-to-model refinement | Partial | Selected scalar/record/Set/Map updates, conditionals, scalar switch fallthrough and direct return/throw entries, bounded literal loops, acyclic helpers, and a return/throw/catch/finally completion subset are compared with model actions. Pure return expressions are validated before their result is discarded; tracked `int`/`bool` throw payloads can bind catch-local scalar control flow across direct, conditional `if`, and scalar `switch` throws. | Return-result equivalence, untracked/string/object throw payloads, effectful or unresolved completion expressions, labels, general exception-aware CFG fixed points, mutable aliases, and dynamic dispatch remain fail-closed. See [#3](https://github.com/mizchi/uneffect/issues/3). |
| Promise and resource safety | Partial | Floating rejections, major Promise combinators, selected `try`/`catch`, `using`, `await using`, reverse disposal order, and selected exactly-once obligations have executable models. | These analyses do not yet share one general control-flow fixed point. See [#9](https://github.com/mizchi/uneffect/issues/9). |
| Event-loop semantics | Partial | Web timers, intervals, microtasks, animation frames, scheduler tasks, and a reviewed Node phase subset can generate bounded models. | Concrete host I/O ordering, repeated/dynamic parents, ESM details, abort composition, and polymorphic callbacks remain incomplete. See [#10](https://github.com/mizchi/uneffect/issues/10). |
| Contract-derived testing | Partial | Deterministic Vitest generation and shrinking cover scalar machine domains, literal unions, bounded arrays, selected records, optional fields, bounded Set/Map values, and supported refinements. | General constructive generators, recursive/user predicates, and solver-backed shrinking remain open. See [#4](https://github.com/mizchi/uneffect/issues/4). |
| Typed arrays and bit operations | Partial | Supported allocation/index/range checks, integer casts, shifts, and SHA-256 building blocks have regression coverage and optional runtime refinements. | Interprocedural alias/resize/control-flow composition and a complete SHA-256 proof are open. See [#6](https://github.com/mizchi/uneffect/issues/6). |
| Evidence and diagnostics | Partial | Artifacts bind inputs, configuration, tool versions, and outcomes. Diagnostics include source locations and replayable witnesses for supported checks. | Z3/Quint artifacts are reproducible evidence, not independently checkable proof certificates. See [#7](https://github.com/mizchi/uneffect/issues/7). |
| Native Rust/Corsa frontend | Partial | A neutral IR, Rust parser/lattice, source spans, and parity fixtures exist. | Inferred effects, call edges, ordered events, and real checker facts do not yet have full parity. See [#8](https://github.com/mizchi/uneffect/issues/8). |
| Proof-guided optimization | Planned | Narrow authorization and ownership-assertion-elision prototypes establish the fail-closed shape of a transformation. | General compression, mangling, reordering, and dead-code elimination are not implemented. See [#13](https://github.com/mizchi/uneffect/issues/13). |

## Verification confidence

The strongest current claims are local and fragment-specific:

1. the source construct is recognized by symbol identity or the documented
   syntax subset;
2. the generated obligation or model is retained for review;
3. the configured backend reports success for that obligation; and
4. a negative regression demonstrates that the check is load-bearing.

Bounded search, simulation, and controlled-corpus adoption metrics are reported
as such. They are never promoted to unbounded proofs or ecosystem-wide quality
claims.

## Where to continue

- Use [Implementation status](./implementation-status.md) for a narrative of
  completed functionality.
- Use [Roadmap and known gaps](./roadmap.md) for priority and dependency order.
- Use [GitHub Issues](https://github.com/mizchi/uneffect/issues) as the active
  queue for unfinished work.
- Use [`TODO.md`](../TODO.md) only as the detailed historical ledger.
