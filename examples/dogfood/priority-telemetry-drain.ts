/* uneffect:refinement_from "./priority-telemetry-drain.uneffect.ts#default" */
/* uneffect:state queued: int */ /* uneffect:state pressure: int */ /* uneffect:state priority: bool */ /* uneffect:state sampled: bool */ /* uneffect:init queued = 0 */ /* uneffect:init pressure = 0 */ /* uneffect:init priority = false */ /* uneffect:init sampled = false */ /* uneffect:action drain: queued' = queued > 0 ? 0 : queued, pressure' = pressure + (queued > 0 ? ((!priority && !sampled) ? 0 : (priority ? queued * (queued - 1) / 2 : queued)) : 0) */

export interface PriorityTelemetryBacklog {
  queued: number;
  pressure: number;
  priority: boolean;
  sampled: boolean;
}

export function createPriorityTelemetryBacklog(initial: PriorityTelemetryBacklog): PriorityTelemetryBacklog {
  return initial;
}

export function observePriorityTelemetryBacklog(runtime: PriorityTelemetryBacklog): PriorityTelemetryBacklog {
  return runtime;
}

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
