/* uneffect:
  state sent: int
  state remaining: int
  state auditArmed: bool
  init sent = 0
  init remaining = 100
  init auditArmed = false
  action send: sent' = sent + 1, remaining' = remaining - 1
  action armAudit: auditArmed' = true
  action observeQuotaDrift: auditArmed' = auditArmed
  action_when observeQuotaDrift: auditArmed && sent + remaining !== 100
  temporal quotaConserved: sent + remaining === 100
*/

export class TelemetryQuota {
  sent = 0;
  remaining = 100;

  send(): void {
    this.sent += 1;
    this.remaining -= 1;
  }
}
