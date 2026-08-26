/* uneffect:
 * state queued: int
 * state accounted: int
 * state flushes: int
 * init queued = 0
 * init accounted = 0
 * init flushes = 0
 * action drain: queued' = queued + 1 > 0 ? 0 : queued + 1, accounted' = accounted + (queued + 1 > 0 ? queued + 1 : 0), flushes' = flushes + 1
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
  // Account for the sample that triggered this flush before draining the
  // complete backlog. External I/O remains a separate capability boundary.
  runtime.queued++;
  while (runtime.queued > 0) {
    runtime.queued--;
    runtime.accounted++;
  }
  runtime.flushes++;
}
