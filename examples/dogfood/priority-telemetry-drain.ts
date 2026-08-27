/* uneffect:
 * state queued: int
 * state pressure: int
 * state priority: bool
 * init queued = 0
 * init pressure = 0
 * init priority = false
 * action drain: queued' = queued > 0 ? 0 : queued, pressure' = pressure + (queued > 0 ? (priority ? queued * (queued - 1) / 2 : 0) : 0)
 */

export interface PriorityTelemetryBacklog {
  queued: number;
  pressure: number;
  priority: boolean;
}

/* uneffect: refinement priorityTelemetry@1 create */
export function createPriorityTelemetryBacklog(initial: PriorityTelemetryBacklog): PriorityTelemetryBacklog {
  return initial;
}

/* uneffect: refinement priorityTelemetry@1 observe */
export function observePriorityTelemetryBacklog(runtime: PriorityTelemetryBacklog): PriorityTelemetryBacklog {
  return runtime;
}

/* uneffect: refinement priorityTelemetry@1 action drain */
export function drainPriorityTelemetryBacklog(runtime: PriorityTelemetryBacklog): void {
  // The pressure score sums the backlog remaining after each priority sample
  // is removed. Non-priority drains deliberately avoid this accounting path.
  while (runtime.queued > 0) {
    runtime.queued--;
    if (runtime.priority) runtime.pressure += runtime.queued;
  }
}
