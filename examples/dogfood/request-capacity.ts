/* uneffect:temporal state active: int */ /* uneffect:temporal state queued: int */ /* uneffect:temporal state remaining: int */ /* uneffect:temporal state auditArmed: bool */ /* uneffect:temporal init active = 0 */ /* uneffect:temporal init queued = 0 */ /* uneffect:temporal init remaining = 100 */ /* uneffect:temporal init auditArmed = false */ /* uneffect:temporal action startImmediately: active' = active + 1, remaining' = remaining - 1 */ /* uneffect:temporal action enqueue: queued' = queued + 1, remaining' = remaining - 1 */ /* uneffect:temporal action promote: active' = active + 1, queued' = queued - 1 */ /* uneffect:temporal action armAudit: auditArmed' = true */ /* uneffect:temporal action observeCapacityDrift: auditArmed' = auditArmed */ /* uneffect:temporal action_when observeCapacityDrift: auditArmed && active + queued + remaining !== 100 */ /* uneffect:temporal invariant capacityConserved: active + queued + remaining === 100 */

export class RequestCapacity {
  active = 0;
  queued = 0;
  remaining = 100;

  startImmediately(): void {
    this.active += 1;
    this.remaining -= 1;
  }

  enqueue(): void {
    this.queued += 1;
    this.remaining -= 1;
  }

  promote(): void {
    this.active += 1;
    this.queued -= 1;
  }
}
