/* uneffect:temporal state sent: int */ /* uneffect:temporal state remaining: int */ /* uneffect:temporal state auditArmed: bool */ /* uneffect:temporal init sent = 0 */ /* uneffect:temporal init remaining = 100 */ /* uneffect:temporal init auditArmed = false */ /* uneffect:temporal action send: sent' = sent + 1, remaining' = remaining - 1 */ /* uneffect:temporal action armAudit: auditArmed' = true */ /* uneffect:temporal action observeQuotaDrift: auditArmed' = auditArmed */ /* uneffect:temporal action_when observeQuotaDrift: auditArmed && sent + remaining !== 100 */ /* uneffect:temporal invariant quotaConserved: sent + remaining === 100 */

export class TelemetryQuota {
  sent = 0;
  remaining = 100;

  send(): void {
    this.sent += 1;
    this.remaining -= 1;
  }
}
