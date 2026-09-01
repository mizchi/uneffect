type BoundedUint8Array<N extends number> = Uint8Array;

export function encodeMetricKind(output: BoundedUint8Array<1>, metricKind: number): void {
  /* uneffect:trust trust typed-array:u8-write telemetry-wire-v1 */
  output[0] = metricKind;
  console.debug("encoded metric kind", metricKind);
}

/* uneffect:temporal_contract ensures sent' = true */
/* uneffect:temporal_contract modifies sent */
/* uneffect:trust trust assumption telemetry-temporal-v1 */
export function markPacketSent(): void {}
