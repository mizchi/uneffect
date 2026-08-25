export interface TelemetryRecord {
  readonly name: string;
  readonly bytes: number;
}

/* uneffect: effect Console | Throw<RangeError> */
export function* buildTelemetryBatches(records: readonly TelemetryRecord[]): Generator<string> {
  for (const record of records) {
    console.log(`queueing ${record.name}`)
    if (record.bytes > 64 * 1024) throw new RangeError("telemetry batch exceeds 64 KiB")
    yield `${record.name}:${record.bytes}`
  }
}

/* uneffect: effect_parameter batches extends Console | Throw<RangeError> */
export function drainTelemetryBatches(batches: IteratorObject<unknown>): void {
  for (const _batch of batches) {
    // The production sink is intentionally outside this focused lazy-effect example.
  }
}

/* uneffect: effect Console | Throw<RangeError> */
export function flushTelemetry(records: readonly TelemetryRecord[]): void {
  drainTelemetryBatches(buildTelemetryBatches(records))
}
