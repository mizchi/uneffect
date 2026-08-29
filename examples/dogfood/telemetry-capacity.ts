/* uneffect:temporal state accepted: int */ /* uneffect:temporal state byteBudget: int */ /* uneffect:temporal state auditArmed: bool */ /* uneffect:temporal init accepted = 1 */ /* uneffect:temporal init byteBudget = 3 */ /* uneffect:temporal init auditArmed = false */ /* uneffect:temporal action acceptBalanced: accepted' = accepted + 1, byteBudget' = byteBudget + 3 */ /* uneffect:temporal action armAudit: auditArmed' = true */ /* uneffect:temporal action observeOverCapacity: auditArmed' = auditArmed */ /* uneffect:temporal action_when observeOverCapacity: auditArmed && 3 * accepted > byteBudget */ /* uneffect:temporal invariant withinCapacity: 3 * accepted <= byteBudget */

export class TelemetryCapacity {
  accepted = 1;
  byteBudget = 3;

  accept(): void {
    this.accepted += 1;
    this.byteBudget += 3;
  }
}
