/* uneffect:state accepted: int */ /* uneffect:state rejected: int */ /* uneffect:state attemptedCost: int */ /* uneffect:state auditArmed: bool */ /* uneffect:init accepted = 0 */ /* uneffect:init rejected = 0 */ /* uneffect:init attemptedCost = 0 */ /* uneffect:init auditArmed = false */ /* uneffect:action accept: accepted' = accepted + 1, attemptedCost' = attemptedCost + 2 */ /* uneffect:action reject: rejected' = rejected + 1, attemptedCost' = attemptedCost + 1 */ /* uneffect:action armAudit: auditArmed' = true */ /* uneffect:action observeAccountingDrift: auditArmed' = auditArmed */ /* uneffect:action_when observeAccountingDrift: auditArmed && 2 * accepted + rejected !== attemptedCost */ /* uneffect:always accountingConserved: 2 * accepted + rejected === attemptedCost */

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
