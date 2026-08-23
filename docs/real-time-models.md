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

`AbortSignal.timeout(ms)` is resolved by builtin declaration identity and
lowers to a one-shot task on the timer task source. Its deadline uses the
model's **active-time** clock: suspension and bfcache pauses are environment
behavior, not elapsed wall-clock progress. The transition may run only at or
after the static deadline, aborts once with the abstract `TimeoutError` reason,
and contributes the `Timer` capability. Static delays outside
`0..Number.MAX_SAFE_INTEGER` are rejected. This follows the
[DOM timeout algorithm](https://dom.spec.whatwg.org/#dom-abortsignal-timeout)
and [MDN active-time description](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal/timeout_static).

`AbortSignal.any([...])` is also resolved by declaration identity for a static
array (including statically flattened array-literal spreads). The neutral IR
retains source order, links named `AbortSignal.timeout` bindings to their timer
tasks, and marks the first already-aborted `AbortSignal.abort` source. The Web
model permits unknown controller sources to abort nondeterministically and
known timeout sources only after their timer fires. Once aborted, the reason
source cannot be overwritten; a deliberately broken lowering produces a Quint
counterexample. This follows the [DOM dependent-signal algorithm](https://dom.spec.whatwg.org/#dom-abortsignal-any)
and [MDN's first-abort behavior](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal/any_static).
Reason values are retained as source text in IR but abstracted to a one-based
source index in Quint. Named and inline static `AbortSignal.timeout(...)`
sources link to their concrete timer tasks without duplicate extraction, while
inline `AbortSignal.abort(reason)` sources retain array order and initialize the
composition from the first already-aborted entry.
Statically resolved local `AbortSignal.any` results can feed later compositions;
the generated transition is enabled only after the source composition aborts,
and the outer composition still retains its own source index as the reason
identity. A negative-control generator can admit early propagation; the
`abort_source_broken` safety term then produces a Quint counterexample. Dynamic
iterables, imported compositions, and interprocedural signal
aliases remain conservative gaps.

Static `scheduler.postTask` calls lower to a distinct scheduler task queue with
`user-blocking`, `user-visible` (the default), or `background` priority and a
minimum static delay. Among eligible scheduler tasks, higher priority runs
first and equal priority preserves registration FIFO. A pre-aborted named
signal prevents initial enqueue. Priority ordering relative to other HTML task
sources is intentionally unconstrained because the scheduling specification
leaves that UA-dependent. A `TaskSignal` without an explicit immutable priority,
dynamic options, and later priority changes are rejected rather than silently
treated as `user-visible`. The returned Promise remains subject to the normal
rejection-ownership analysis. See the [Prioritized Task Scheduling specification](https://wicg.github.io/scheduling-apis/)
and [MDN `postTask`](https://developer.mozilla.org/en-US/docs/Web/API/Scheduler/postTask).

`scheduler.yield()` lowers to a scheduler continuation. At top level it uses
`user-visible`; inside a statically resolved `postTask` callback it inherits the
parent's static priority and becomes runnable only after that callback runs.
When the parent uses a statically resolved timeout or `AbortSignal.any`, the
task and its inline yield continuations also share that cancellation source.
Aborting removes pending jobs and execution guards reject an aborted source; a
negative control that runs such a job violates `scheduler_abort_broken`.
Direct external-signal state, dynamically selected callbacks, and complete
control flow for every statement after `await scheduler.yield()` remain
unmodeled. See [MDN `yield`](https://developer.mozilla.org/en-US/docs/Web/API/Scheduler/yield).

```sh
just spec-web-event-loop examples/async-patterns.ts
```

The generated `eventLoopSafe` invariant rejects a callback that executes in
the wrong phase. Direct `cancelAnimationFrame` handles prevent the corresponding
callback from becoming pending. Local identifier aliases retain the concrete
timer index they captured, so reassigning the source binding to a second timer
does not redirect cancellation of the earlier alias. Direct assignment from a
new timer updates only the assigned binding. Returning a handle, storing it in
a property, or passing it to a non-clear call creates an ordered
`TimerHandleEscape` IR event tied to the concrete timer generation. The Web
model then admits optional external cancellation; escape alone is never treated
as proof that cancellation occurred. Direct array/object aggregates are
traversed, including through immutable local bindings, and an inline closure
records the local handles it captures whether returned directly or through an
immutable local binding. Computed properties, imported closure factories, and
environment-specific Node/browser event-loop phases remain unknown. For direct
timer registrations, the IR preserves whether TypeScript exposes the handle as
a `number`, an object, or an unresolved union; this is metadata, not yet a proof
that a clear operation is valid across host boundaries. Promise
reactions from a synchronously and
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
same way; they are not also misclassified as initially queued jobs. Direct and
literal-computed methods and single-return source callback factories are also
resolved. A conditional scheduled callback is a finite callback set only when
both branches resolve; duplicate branches are collapsed, while a partially
external selection remains dynamic rather than attributing one known branch to
the parent job. Finite literal-key selections from an immutable `as const`
callback table are expanded through local `const` aliases under the same
all-members-resolved rule. Mutable tables, getters, missing keys, and general
dynamic property selection remain unknown. Callback factories support a
definite-return subset of sequential blocks and `if`/`else`, including early
returns and concise conditional arrow functions. Every returned expression must
resolve to a source callback. Parameter references are substituted by symbol
identity from the call arguments, enabling finite conditional keys and direct
callback identity forwarding without treating a dynamic typed value as finite;
immutable object-literal method receivers also bind `this` for nested callback
table selection, while mutable or polymorphic receivers remain unresolved;
fallthrough and unsupported control flow keep the factory result dynamic.
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

Because `pending` is initially false, the current Z3 lint reports
`requestCompletes` as `initially-vacuous-liveness`: the bare eventuality is true
before any request is released. This is intentional dogfood evidence for the
remaining response-property gap; it must not be presented as a proof that each
released request completes.

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

The logical-clock directive is implemented through the public temporal
semantic-domain registry. Applications can register additional directive packs
that expand into typed state, init constraints, generated actions, and protected
state ownership without adding parser conditionals. Registration does not make
a domain trustworthy by itself: its generated transition relation is still the
model being checked. `createPhysicalClockDomain()` optionally adds
`monotonic_clock mono: 1`, `wall_clock wall: 1`, and `clock_skew wall, mono: 1`.
Monotonic clocks only tick forward. Wall clocks can tick forward or roll back by
their declared step while remaining non-negative. A skew declaration generates
both a named invariant and guards on generated transitions, making the skew
bound an explicit environment assumption rather than an accidental theorem.
Finite variable rates use `monotonic_clock mono: 1..2` or
`wall_clock wall: 1..3`; the domain expands each permitted rate into a distinct
transition. `wall_clock_jump wall: 1..2` independently bounds rollback
magnitudes. Ranges contain at most 32 positive integer values, keeping the
generated transition system reviewable. Host-clock observation adapters and
platform conformance are exposed through `createNodeClockObserver`,
`createBrowserClockObserver`, `createDenoClockObserver`, and
`checkClockConformance`. Observers normalize `performance.now()` and
`Date.now()` to a shared local origin and quantize elapsed samples; injected
clock functions make platform tests deterministic. The pure checker reports
rate, rollback, and skew violations with the offending sample index. A finite
conformant trace validates only those observations—it does not prove that the
host will satisfy the assumptions forever. The core `clock` directive continues to mean
logical model time, not elapsed host time.

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
