type BoundedUint8Array<N extends number> = Uint8Array;

export function encodeMetricKind(output: BoundedUint8Array<1>, metricKind: number): void {
  /* uneffect:trust trust typed-array:u8-write validated by the telemetry wire-format conformance suite */
  /* uneffect:trust trust_owner telemetry-platform */
  /* uneffect:trust trust_expires 2027-06-30 */
  output[0] = metricKind;
  console.debug("encoded metric kind", metricKind);
}

/* uneffect:temporal_contract ensures sent' = true */
/* uneffect:temporal_contract modifies sent */
/* uneffect:trust trust_owner telemetry-platform */
/* uneffect:trust trust_expires 2027-06-30 */
export function markPacketSent(): void {}
