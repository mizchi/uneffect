/* uneffect:
  state accepted: int
  state rejected: int
  state attemptedCost: int
  state auditArmed: bool
  init accepted = 0
  init rejected = 0
  init attemptedCost = 0
  init auditArmed = false
  action accept: accepted' = accepted + 1, attemptedCost' = attemptedCost + 2
  action reject: rejected' = rejected + 1, attemptedCost' = attemptedCost + 1
  action armAudit: auditArmed' = true
  action observeAccountingDrift: auditArmed' = auditArmed
  action_when observeAccountingDrift: auditArmed && 2 * accepted + rejected !== attemptedCost
  temporal accountingConserved: 2 * accepted + rejected === attemptedCost
*/

export class TelemetryWeightedAccounting {
  accepted = 0;
  rejected = 0;
  attemptedCost = 0;

  accept(): void {
    this.accepted += 1;
    this.attemptedCost += 2;
  }

  reject(): void {
    this.rejected += 1;
    this.attemptedCost += 1;
  }
}
