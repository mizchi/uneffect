export interface TelemetryOutcomeCounts {
  delivered: number;
  dropped: number;
  buffered: number;
  attempted: number;
}

export function hasExactlyOneOutcome(runtime: TelemetryOutcomeCounts): boolean {
  return runtime.delivered + runtime.dropped + runtime.buffered === runtime.attempted;
}
