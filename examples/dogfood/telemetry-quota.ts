/* uneffect:state sent: int */ /* uneffect:state remaining: int */ /* uneffect:state auditArmed: bool */ /* uneffect:init sent = 0 */ /* uneffect:init remaining = 100 */ /* uneffect:init auditArmed = false */ /* uneffect:action send: sent' = sent + 1, remaining' = remaining - 1 */ /* uneffect:action armAudit: auditArmed' = true */ /* uneffect:action observeQuotaDrift: auditArmed' = auditArmed */ /* uneffect:action_when observeQuotaDrift: auditArmed && sent + remaining !== 100 */ /* uneffect:always quotaConserved: sent + remaining === 100 */

export class TelemetryQuota {
  sent = 0;
  remaining = 100;

  send(): void {
    this.sent += 1;
    this.remaining -= 1;
  }
}
