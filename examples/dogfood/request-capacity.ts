/* uneffect:
  state active: int
  state queued: int
  state remaining: int
  state auditArmed: bool
  init active = 0
  init queued = 0
  init remaining = 100
  init auditArmed = false
  action startImmediately: active' = active + 1, remaining' = remaining - 1
  action enqueue: queued' = queued + 1, remaining' = remaining - 1
  action promote: active' = active + 1, queued' = queued - 1
  action armAudit: auditArmed' = true
  action observeCapacityDrift: auditArmed' = auditArmed
  action_when observeCapacityDrift: auditArmed && active + queued + remaining !== 100
  temporal capacityConserved: active + queued + remaining === 100
*/

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
