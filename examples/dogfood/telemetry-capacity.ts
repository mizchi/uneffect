/* uneffect:state accepted: int */ /* uneffect:state byteBudget: int */ /* uneffect:state auditArmed: bool */ /* uneffect:init accepted = 1 */ /* uneffect:init byteBudget = 3 */ /* uneffect:init auditArmed = false */ /* uneffect:action acceptBalanced: accepted' = accepted + 1, byteBudget' = byteBudget + 3 */ /* uneffect:action armAudit: auditArmed' = true */ /* uneffect:action observeOverCapacity: auditArmed' = auditArmed */ /* uneffect:action_when observeOverCapacity: auditArmed && 3 * accepted > byteBudget */ /* uneffect:always withinCapacity: 3 * accepted <= byteBudget */

export class TelemetryCapacity {
  accepted = 1;
  byteBudget = 3;

  accept(): void {
    this.accepted += 1;
    this.byteBudget += 3;
  }
}
