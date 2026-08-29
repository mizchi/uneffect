/*
 * A service shutdown model: once shutdown starts, in-flight work must drain
 * and remain drained. The wait action represents an event-loop turn that does
 * not complete work; weak fairness on completion excludes infinite starvation.
 *
 * uneffect:temporal
 * state shuttingDown: bool
 * state pending: int
 * init shuttingDown = false
 * init pending = 2
 * action startShutdown: shuttingDown' = true
 * action_when startShutdown: !shuttingDown
 * action complete: pending' = pending - 1
 * action_when complete: shuttingDown && pending > 0
 * action_fair complete: weak
 * action wait: pending' = pending
 * action_when wait: shuttingDown && pending > 0
 * action stopped: shuttingDown' = shuttingDown, pending' = pending
 * action_when stopped: shuttingDown && pending === 0
 * invariant pendingNonnegative: pending >= 0
 * stabilizes remainsDrained: !shuttingDown || pending === 0
 */

export {};
