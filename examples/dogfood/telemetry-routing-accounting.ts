/* uneffect:
  state delivered: int
  state dropped: int
  state buffered: int
  state attempted: int
  state auditArmed: bool
  init delivered = 0
  init dropped = 0
  init buffered = 0
  init attempted = 0
  init auditArmed = false
  action deliver: delivered' = delivered + 1, attempted' = attempted + 1
  action drop: dropped' = dropped + 1, attempted' = attempted + 1
  action buffer: buffered' = buffered + 1, attempted' = attempted + 1
  action armAudit: auditArmed' = true
  action observeLostOutcome: auditArmed' = auditArmed
  action_when observeLostOutcome: auditArmed && delivered + dropped + buffered < attempted
  temporal allAttemptsHaveOneOutcome: delivered + dropped + buffered === attempted
*/

export type TelemetryOutcome = "delivered" | "dropped" | "buffered";

export class TelemetryRoutingAccounting {
  delivered = 0;
  dropped = 0;
  buffered = 0;
  attempted = 0;

  record(outcome: TelemetryOutcome): void {
    this.attempted += 1;
    this[outcome] += 1;
  }
}
