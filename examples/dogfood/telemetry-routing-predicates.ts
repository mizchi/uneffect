export interface TelemetryOutcomeCounts {
  delivered: number;
  dropped: number;
  buffered: number;
  attempted: number;
}

function observedOutcomeCount(runtime: TelemetryOutcomeCounts): number {
  return runtime.delivered + runtime.dropped + runtime.buffered;
}

export function hasExactlyOneOutcome(runtime: TelemetryOutcomeCounts): boolean {
  return observedOutcomeCount(runtime) === runtime.attempted;
}
