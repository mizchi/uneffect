/* uneffect:temporal state accepted: int */ /* uneffect:temporal state rejected: int */ /* uneffect:temporal state attemptedCost: int */ /* uneffect:temporal state auditArmed: bool */ /* uneffect:temporal init accepted = 0 */ /* uneffect:temporal init rejected = 0 */ /* uneffect:temporal init attemptedCost = 0 */ /* uneffect:temporal init auditArmed = false */ /* uneffect:temporal action accept: accepted' = accepted + 1, attemptedCost' = attemptedCost + 2 */ /* uneffect:temporal action reject: rejected' = rejected + 1, attemptedCost' = attemptedCost + 1 */ /* uneffect:temporal action armAudit: auditArmed' = true */ /* uneffect:temporal action observeAccountingDrift: auditArmed' = auditArmed */ /* uneffect:temporal action_when observeAccountingDrift: auditArmed && 2 * accepted + rejected !== attemptedCost */ /* uneffect:temporal invariant accountingConserved: 2 * accepted + rejected === attemptedCost */

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
