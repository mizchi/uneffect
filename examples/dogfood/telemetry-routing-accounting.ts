/* uneffect:
  state delivered: int
  state dropped: int
  state buffered: int
  state attempted: int
  state auditArmed: bool
  init delivered = 0
  init dropped = 0
  init buffered = 0
  init attempted = 0
  init auditArmed = false
  action deliver: delivered' = delivered + 1, attempted' = attempted + 1
  action drop: dropped' = dropped + 1, attempted' = attempted + 1
  action buffer: buffered' = buffered + 1, attempted' = attempted + 1
  action armAudit: auditArmed' = attempted > 0 ? true : auditArmed
  action observeLostOutcome: auditArmed' = auditArmed
  action_when observeLostOutcome: auditArmed && delivered + dropped + buffered < attempted
  temporal allAttemptsHaveOneOutcome: delivered + dropped + buffered === attempted
*/

export type TelemetryOutcome = "delivered" | "dropped" | "buffered";

export interface TelemetryRoutingState {
  delivered: number;
  dropped: number;
  buffered: number;
  attempted: number;
  auditArmed: boolean;
}

export class TelemetryRoutingAccounting {
  delivered = 0;
  dropped = 0;
  buffered = 0;
  attempted = 0;
  auditArmed = false;

  record(outcome: TelemetryOutcome): void {
    this.attempted += 1;
    this[outcome] += 1;
  }
}

function hydrateTelemetryRouting(initial: TelemetryRoutingState): TelemetryRoutingAccounting {
  return Object.assign(new TelemetryRoutingAccounting(), initial);
}

/* uneffect: refinement telemetryRouting@1 create */
export function createTelemetryRouting(initial: TelemetryRoutingState): TelemetryRoutingAccounting {
  return hydrateTelemetryRouting(initial);
}

function snapshotTelemetryRouting(runtime: TelemetryRoutingAccounting): TelemetryRoutingState {
  const { delivered, dropped, buffered, attempted, auditArmed } = runtime;
  return { delivered, dropped, buffered, attempted, auditArmed };
}

/* uneffect: refinement telemetryRouting@1 observe */
export function observeTelemetryRouting(runtime: TelemetryRoutingAccounting): TelemetryRoutingState {
  return snapshotTelemetryRouting(runtime);
}

/* uneffect: refinement telemetryRouting@1 action deliver */
export function deliverTelemetry(runtime: TelemetryRoutingAccounting): void { runtime.record("delivered"); }

/* uneffect: refinement telemetryRouting@1 action drop */
export function dropTelemetry(runtime: TelemetryRoutingAccounting): void { runtime.record("dropped"); }

/* uneffect: refinement telemetryRouting@1 action buffer */
export function bufferTelemetry(runtime: TelemetryRoutingAccounting): void { runtime.record("buffered"); }

function armAuditAfterAttempt(runtime: TelemetryRoutingAccounting): void {
  if (runtime.attempted > 0) runtime.auditArmed = true;
}

/* uneffect: refinement telemetryRouting@1 action armAudit */
export function armTelemetryAudit(runtime: TelemetryRoutingAccounting): void {
  return armAuditAfterAttempt(runtime);
}

/* uneffect: refinement telemetryRouting@1 action observeLostOutcome */
export function observeLostTelemetryOutcome(runtime: TelemetryRoutingAccounting): void {
  if (!(runtime.delivered + runtime.dropped + runtime.buffered < runtime.attempted && runtime.auditArmed)) return;
}

function hasExactlyOneTelemetryOutcome(runtime: TelemetryRoutingAccounting): boolean {
  return runtime.delivered + runtime.dropped + runtime.buffered === runtime.attempted;
}

/* uneffect: refinement telemetryRouting@1 invariant allAttemptsHaveOneOutcome */
export function allTelemetryAttemptsHaveOneOutcome(runtime: TelemetryRoutingAccounting): boolean {
  return hasExactlyOneTelemetryOutcome(runtime);
}
