/* uneffect:
 * state queued: int
 * state pressure: int
 * state deferred: int
 * state paused: bool
 * init queued = 0
 * init pressure = 0
 * init deferred = 0
 * init paused = false
 * action drain: queued' = queued > 0 ? (paused ? queued : 0) : queued, pressure' = pressure + (queued > 0 ? (paused ? 0 : queued * (queued - 1) / 2) : 0), deferred' = deferred + (queued > 0 ? (paused ? queued : 0) : 0)
 */

export interface PausedTelemetryBacklog {
  queued: number;
  pressure: number;
  deferred: number;
  paused: boolean;
}

/* uneffect: refinement pausedTelemetry@1 create */
export function createPausedTelemetryBacklog(initial: PausedTelemetryBacklog): PausedTelemetryBacklog {
  return initial;
}

/* uneffect: refinement pausedTelemetry@1 observe */
export function observePausedTelemetryBacklog(runtime: PausedTelemetryBacklog): PausedTelemetryBacklog {
  return runtime;
}

/* uneffect: refinement pausedTelemetry@1 action drain */
export function drainPausedTelemetryBacklog(runtime: PausedTelemetryBacklog): void {
  // A deployment pause leaves the queued batch untouched and records its size
  // exactly once. Once draining starts, each removal contributes the remaining
  // depth to pressure.
  while (runtime.queued > 0) {
    if (runtime.paused) {
      runtime.deferred += runtime.queued;
      break;
    }
    runtime.queued--;
    runtime.pressure += runtime.queued;
  }
}
