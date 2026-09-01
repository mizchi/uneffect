/* uneffect:state active: int */ /* uneffect:state queued: int */ /* uneffect:state remaining: int */ /* uneffect:state auditArmed: bool */ /* uneffect:init active = 0 */ /* uneffect:init queued = 0 */ /* uneffect:init remaining = 100 */ /* uneffect:init auditArmed = false */ /* uneffect:action startImmediately: active' = active + 1, remaining' = remaining - 1 */ /* uneffect:action enqueue: queued' = queued + 1, remaining' = remaining - 1 */ /* uneffect:action promote: active' = active + 1, queued' = queued - 1 */ /* uneffect:action armAudit: auditArmed' = true */ /* uneffect:action observeCapacityDrift: auditArmed' = auditArmed */ /* uneffect:action_when observeCapacityDrift: auditArmed && active + queued + remaining !== 100 */ /* uneffect:always capacityConserved: active + queued + remaining === 100 */

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
