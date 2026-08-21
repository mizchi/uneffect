# Real-time modeling boundary

Uneffect can model real-time protocols first as **discrete logical-time state
machines**. It does not infer a physical WCET or turn JavaScript timers into a
hard real-time guarantee.

## Web event-loop profile

The Web profile is separate from Node.js. It models a callback turn as these
phases:

```text
timer task -> drain microtasks to empty -> rendering opportunity
                                      -> animation-frame callbacks -> paint
                                      -> rendering skipped
```

This follows the HTML/MDN boundary: timeout and interval callbacks are tasks;
after a task the microtask queue drains to empty, including microtasks queued by
microtasks; rendering may then occur. `requestAnimationFrame` is a one-shot
callback before a repaint, not a deadline or a guaranteed periodic callback.
The model consequently permits a rendering opportunity to be skipped and does
not infer a refresh rate. Sources: [MDN microtask guide](https://developer.mozilla.org/en-US/docs/Web/API/HTML_DOM_API/Microtask_guide),
[MDN requestAnimationFrame](https://developer.mozilla.org/en-US/docs/Web/API/Window/requestAnimationFrame),
[MDN setTimeout](https://developer.mozilla.org/en-US/docs/Web/API/Window/setTimeout),
and the [HTML event-loop standard](https://html.spec.whatwg.org/multipage/webappapis.html#event-loops).

`setTimeout(0)` therefore remains a later task. Static timers from the same
timer task source are selected by due time and registration order. An interval
reschedules itself after firing; an animation-frame callback does not. Browser
throttling, background-tab suspension, and the 4 ms nested-timer clamp affect
eligibility and physical time, so they are deliberately not encoded as exact
latency guarantees in this finite safety model.

```sh
just spec-web-event-loop examples/async-patterns.ts
```

The generated `eventLoopSafe` invariant rejects a callback that executes in
the wrong phase. Direct `cancelAnimationFrame` handles prevent the corresponding
callback from becoming pending. Reassignment-free local identifier aliases of
timer handles are normalized before matching a clear operation. Handle escape,
reassignment, and environment-specific Node/browser handle identity remain
unknown. Promise reactions from a synchronously and
definitely settled local executor are placed in the same checkpoint as
`queueMicrotask`; running one reaction queues the next link before the
checkpoint may finish. External or possibly-pending Promise settlement is not
guessed. Every queued job receives a monotonically increasing ticket, and only
the pending job with the smallest ticket may run. A chained reaction receives
its ticket when the preceding reaction runs, so it cannot overtake an already
queued `queueMicrotask` callback. A negative lowering that removes this guard
sets `fifo_broken`, and Quint finds the ordering violation. Extracting new
`queueMicrotask` calls from inline timer, microtask, or animation-frame
callbacks creates dormant jobs that receive tickets only when their parent
callback runs. Named function declarations and arrow/function values, including
aliased imports, are resolved by TypeChecker symbol identity and scanned the
same way; they are not also misclassified as initially queued jobs. Methods,
callbacks returned by calls, and dynamically selected values remain unknown.
An animation-frame callback returns to a microtask checkpoint before the
remaining frame callbacks and paint continue.

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
