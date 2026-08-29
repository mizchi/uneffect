/* uneffect:temporal state queued: int */ /* uneffect:temporal state pressure: int */ /* uneffect:temporal state deferred: int */ /* uneffect:temporal state deferredWeight: int */ /* uneffect:temporal state paused: bool */ /* uneffect:temporal init queued = 0 */ /* uneffect:temporal init pressure = 0 */ /* uneffect:temporal init deferred = 0 */ /* uneffect:temporal init deferredWeight = 0 */ /* uneffect:temporal init paused = false */ /* uneffect:temporal action drain: queued' = queued > 0 ? (paused ? queued : 0) : queued, pressure' = pressure + (queued > 0 ? (paused ? 0 : queued * (queued - 1) / 2) : 0), deferred' = deferred + (queued > 0 ? (paused ? queued : 0) : 0), deferredWeight' = deferredWeight + (queued > 0 ? (paused ? 2 * queued : 0) : 0) */

export interface PausedTelemetryBacklog {
  queued: number;
  pressure: number;
  deferred: number;
  deferredWeight: number;
  paused: boolean;
}

/* uneffect:refinement refinement pausedTelemetry@1 create */
export function createPausedTelemetryBacklog(initial: PausedTelemetryBacklog): PausedTelemetryBacklog {
  return initial;
}

/* uneffect:refinement refinement pausedTelemetry@1 observe */
export function observePausedTelemetryBacklog(runtime: PausedTelemetryBacklog): PausedTelemetryBacklog {
  return runtime;
}

/* uneffect:refinement refinement pausedTelemetry@1 action drain */
export function drainPausedTelemetryBacklog(runtime: PausedTelemetryBacklog): void {
  // A deployment pause leaves the queued batch untouched and records its size
  // exactly once. Once draining starts, each removal contributes the remaining
  // depth to pressure.
  while (runtime.queued > 0) {
    if (runtime.paused) {
      runtime.deferred += runtime.queued;
      runtime.deferredWeight += 2 * runtime.queued;
      break;
    }
    runtime.queued--;
    runtime.pressure += runtime.queued;
  }
}
