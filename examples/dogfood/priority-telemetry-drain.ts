/* uneffect:temporal state queued: int */ /* uneffect:temporal state pressure: int */ /* uneffect:temporal state priority: bool */ /* uneffect:temporal state sampled: bool */ /* uneffect:temporal init queued = 0 */ /* uneffect:temporal init pressure = 0 */ /* uneffect:temporal init priority = false */ /* uneffect:temporal init sampled = false */ /* uneffect:temporal action drain: queued' = queued > 0 ? 0 : queued, pressure' = pressure + (queued > 0 ? ((!priority && !sampled) ? 0 : (priority ? queued * (queued - 1) / 2 : queued)) : 0) */

export interface PriorityTelemetryBacklog {
  queued: number;
  pressure: number;
  priority: boolean;
  sampled: boolean;
}

/* uneffect:refinement refinement priorityTelemetry@1 create */
export function createPriorityTelemetryBacklog(initial: PriorityTelemetryBacklog): PriorityTelemetryBacklog {
  return initial;
}

/* uneffect:refinement refinement priorityTelemetry@1 observe */
export function observePriorityTelemetryBacklog(runtime: PriorityTelemetryBacklog): PriorityTelemetryBacklog {
  return runtime;
}

/* uneffect:refinement refinement priorityTelemetry@1 action drain */
export function drainPriorityTelemetryBacklog(runtime: PriorityTelemetryBacklog): void {
  // The pressure score sums the backlog remaining after each priority sample
  // is removed. Non-priority drains deliberately avoid this accounting path.
  while (runtime.queued > 0) {
    runtime.queued--;
    if (!runtime.priority && !runtime.sampled) continue;
    if (runtime.priority) runtime.pressure += runtime.queued;
    else runtime.pressure++;
  }
}
