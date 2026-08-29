/* uneffect:temporal state queued: int */ /* uneffect:temporal state accounted: int */ /* uneffect:temporal state flushes: int */ /* uneffect:temporal init queued = 0 */ /* uneffect:temporal init accounted = 0 */ /* uneffect:temporal init flushes = 0 */ /* uneffect:temporal action drain: queued' = queued + 1 >= 3 ? queued + 1 - 2 * ((queued - 1 - (queued - 1) % 2) / 2 + ((queued - 1) % 2 > 0 ? 1 : 0)) : queued + 1, accounted' = accounted + (queued + 1 >= 3 ? 2 * ((queued - 1 - (queued - 1) % 2) / 2 + ((queued - 1) % 2 > 0 ? 1 : 0)) : 0), flushes' = flushes + 1 */

export interface TelemetryBacklog {
  queued: number;
  accounted: number;
  flushes: number;
}

/* uneffect:refinement refinement telemetryBacklog@1 create */
export function createTelemetryBacklog(initial: TelemetryBacklog): TelemetryBacklog {
  return initial;
}

/* uneffect:refinement refinement telemetryBacklog@1 observe */
export function observeTelemetryBacklog(runtime: TelemetryBacklog): TelemetryBacklog {
  return runtime;
}

/* uneffect:refinement refinement telemetryBacklog@1 action drain */
export function drainTelemetryBacklog(runtime: TelemetryBacklog): void {
  // Account for the sample that triggered this pass, process pairs, and retain
  // the final one or two samples instead of emitting an undersized request.
  // The actual delivery remains a separate capability boundary.
  runtime.queued++;
  while (runtime.queued >= 3) {
    runtime.queued -= 2;
    runtime.accounted += 2;
  }
  runtime.flushes++;
}
