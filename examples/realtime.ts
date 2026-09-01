/*
 * A discrete-time admission model. This is not a wall-clock guarantee.
 *
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
 * always deadlineSafe: !pending || clock <= deadline
 * response requestCompletes: pending => !pending
 * repeatedly returnsIdle: !pending
 */

export {};
