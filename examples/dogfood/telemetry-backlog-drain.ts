/* uneffect:
 * state queued: int
 * state accounted: int
 * state flushes: int
 * init queued = 0
 * init accounted = 0
 * init flushes = 0
 * action drain: queued' = queued > 0 ? 0 : queued, accounted' = accounted + (queued > 0 ? queued : 0), flushes' = flushes + 1
 */

export interface TelemetryBacklog {
  queued: number;
  accounted: number;
  flushes: number;
}

/* uneffect: refinement telemetryBacklog@1 create */
export function createTelemetryBacklog(initial: TelemetryBacklog): TelemetryBacklog {
  return initial;
}

/* uneffect: refinement telemetryBacklog@1 observe */
export function observeTelemetryBacklog(runtime: TelemetryBacklog): TelemetryBacklog {
  return runtime;
}

/* uneffect: refinement telemetryBacklog@1 action drain */
export function drainTelemetryBacklog(runtime: TelemetryBacklog): void {
  // This is the accounting core after a delivery adapter has selected the
  // backlog. External I/O remains a separate capability effect boundary.
  while (runtime.queued > 0) {
    runtime.queued--;
    runtime.accounted++;
  }
  runtime.flushes++;
}
