/* uneffect:temporal state accepted: int */ /* uneffect:temporal state dropped: int */ /* uneffect:temporal state attempted: int */ /* uneffect:temporal state auditArmed: bool */ /* uneffect:temporal init accepted = 0 */ /* uneffect:temporal init dropped = 0 */ /* uneffect:temporal init attempted = 0 */ /* uneffect:temporal init auditArmed = false */ /* uneffect:temporal action accept: accepted' = accepted + 1, attempted' = attempted + 1 */ /* uneffect:temporal action drop: dropped' = dropped + 1, attempted' = attempted + 1 */ /* uneffect:temporal action armAudit: auditArmed' = true */ /* uneffect:temporal action observeLostOutcome: auditArmed' = auditArmed */ /* uneffect:temporal action_when observeLostOutcome: auditArmed && accepted + dropped < attempted */ /* uneffect:temporal invariant allAttemptsAccountedFor: accepted + dropped === attempted */

export class TelemetryAccounting {
  accepted = 0;
  dropped = 0;
  attempted = 0;

  record(wasAccepted: boolean): void {
    this.attempted += 1;
    if (wasAccepted) this.accepted += 1;
    else this.dropped += 1;
  }
}
