/* uneffect:state accepted: int */ /* uneffect:state dropped: int */ /* uneffect:state attempted: int */ /* uneffect:state auditArmed: bool */ /* uneffect:init accepted = 0 */ /* uneffect:init dropped = 0 */ /* uneffect:init attempted = 0 */ /* uneffect:init auditArmed = false */ /* uneffect:action accept: accepted' = accepted + 1, attempted' = attempted + 1 */ /* uneffect:action drop: dropped' = dropped + 1, attempted' = attempted + 1 */ /* uneffect:action armAudit: auditArmed' = true */ /* uneffect:action observeLostOutcome: auditArmed' = auditArmed */ /* uneffect:action_when observeLostOutcome: auditArmed && accepted + dropped < attempted */ /* uneffect:always allAttemptsAccountedFor: accepted + dropped === attempted */

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
