# Real-time modeling boundary

Uneffect can model real-time protocols first as **discrete logical-time state
machines**. It does not infer a physical WCET or turn JavaScript timers into a
hard real-time guarantee.

```ts
/*
 * uneffect:
 * clock clock: 1
 * state pending: bool
 * state deadline: int
 * init pending = false
 * init deadline = 0
 * action release: pending' = true, deadline' = clock + 3
 * action_when release: !pending
 * action complete: pending' = false
 * action_when complete: pending && clock <= deadline
 * action_when tick_clock: !pending || clock < deadline
 * action_fair tick_clock: weak
 * temporal deadlineSafe: !pending || clock <= deadline
 * temporal_eventually requestCompletes: !pending
 */
```

`action_when name: predicate` is TypeScript-like Uneffect syntax. It is parsed
into the neutral expression AST and emitted as a Quint action guard; Quint
source is never accepted inline. Every omitted state assignment still
stutters explicitly.

`clock clock: 1` declares a protected, non-negative logical clock with an
implicit zero initial value and generated `tick_clock` action. The positive
integer is its tick granularity. User actions cannot assign the clock, so the
generated transition system preserves monotonicity by construction.
`action_fair tick_clock: weak` adds Quint weak fairness for the standalone
action. Strong fairness is available with `strong`: weak fairness requires an
action that remains continuously enabled to occur, while strong fairness also
covers actions enabled infinitely often.

## Expressible patterns

| Pattern | Current encoding | Meaningful claim |
|---|---|---|
| Timeout / lease / TTL | logical clock, expiry, guarded tick | expiry ordering and safety |
| Debounce / throttle | last-event time and guarded fire action | no early or duplicate fire |
| Periodic task | phase, next release, period | release order and bounded backlog |
| Sporadic task | minimum inter-arrival guard | releases are sufficiently separated |
| Deadline | release time, deadline, completion | no represented transition crosses a deadline |
| Heartbeat / watchdog | last-seen time and failure action | stale peers eventually become eligible for failure |
| Retry / backoff | attempt, next-attempt time | retry order and upper bounds |
| Cancellation race | pending/cancelled/completed state | forbidden double completion and post-cancel effects |
| Producer/consumer | queue depth and service ticks | bounded queue and overflow safety |
| Priority protocol | owner, waiter priority, scheduler action | abstract priority inversion protocols |

Safety and progress are separate. `deadlineSafe` can remain true in a
deadlocked model. Completion therefore needs an `eventually` property plus
explicit action fairness. Even then, fairness is a scheduler assumption in the
model, not evidence that the runtime scheduler enforces it.

## Not yet a hard real-time proof

The current model cannot establish:

- physical elapsed time, clock drift, timer resolution, or clock jumps;
- WCET/BCET derived from generated machine code;
- GC, JIT, OS scheduling, interrupt, I/O, or network latency bounds;
- dense time, simultaneous events, or sub-tick ordering;
- multicore memory ordering or a concrete scheduling policy;
- probabilistic latency or percentile SLOs.

Hard real-time claims need external evidence: target-specific WCET analysis,
a scheduler/platform contract, clock assumptions, and trace conformance. These
inputs should later become evidence-bound capability or temporal assumptions,
not implicit facts. For dense timed automata, a timed-automata backend such as
UPPAAL is a better fit than encoding fractional time in Z3 or Quint.

## Verification ledger

| Item | Status |
|---|---|
| Source of truth | Uneffect logical-time transition contract |
| Model question | Can a pending request reach `clock > deadline`? |
| Positive result | Quint finds no violation with the guarded tick |
| Negative control | Removing the tick guard yields a counterexample |
| Domain interpretation | The transition policy prevents modeled deadline crossing |
| Explicit non-claim | JavaScript execution completes within a wall-clock duration |
| Regression lock | `test/spec-backends.test.ts` and `just formal-realtime` |
