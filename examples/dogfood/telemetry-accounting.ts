/* uneffect:
  state accepted: int
  state dropped: int
  state attempted: int
  state auditArmed: bool
  init accepted = 0
  init dropped = 0
  init attempted = 0
  init auditArmed = false
  action accept: accepted' = accepted + 1, attempted' = attempted + 1
  action drop: dropped' = dropped + 1, attempted' = attempted + 1
  action armAudit: auditArmed' = true
  action observeLostOutcome: auditArmed' = auditArmed
  action_when observeLostOutcome: auditArmed && accepted + dropped < attempted
  temporal allAttemptsAccountedFor: accepted + dropped === attempted
*/

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
