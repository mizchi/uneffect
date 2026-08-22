/* uneffect:
  state accepted: int
  state byteBudget: int
  state auditArmed: bool
  init accepted = 1
  init byteBudget = 2
  init auditArmed = false
  action acceptBalanced: accepted' = accepted + 1, byteBudget' = byteBudget + 2
  action armAudit: auditArmed' = true
  action observeOverCapacity: auditArmed' = auditArmed
  action_when observeOverCapacity: auditArmed && 2 * accepted > byteBudget
  temporal withinCapacity: 2 * accepted <= byteBudget
*/

export class TelemetryCapacity {
  accepted = 1;
  byteBudget = 2;

  accept(): void {
    this.accepted += 1;
    this.byteBudget += 2;
  }
}
