import { hasExactlyOneOutcome } from "./telemetry-routing-predicates.js";

/* uneffect:
  state delivered: int
  state dropped: int
  state buffered: int
  state attempted: int
  state postProcessed: int
  state auditArmed: bool
  init delivered = 0
  init dropped = 0
  init buffered = 0
  init attempted = 0
  init postProcessed = 0
  init auditArmed = false
  action deliver: delivered' = delivered + 1, attempted' = attempted + 1, postProcessed' = auditArmed ? postProcessed : postProcessed + 1
  action drop: dropped' = dropped + 1, attempted' = attempted + 1
  action buffer: buffered' = buffered + 1, attempted' = attempted + 1
  action reject: delivered' = auditArmed ? delivered : delivered + 1, dropped' = auditArmed ? dropped + 1 : dropped, attempted' = attempted + 1, auditArmed' = true
  action armAudit: auditArmed' = attempted <= 0 ? auditArmed : true
  action nestedPostProcess: postProcessed' = attempted > 0 ? auditArmed ? postProcessed : postProcessed + 1 : postProcessed + 1
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
  postProcessed: number;
  auditArmed: boolean;
}

export class TelemetryRoutingAccounting {
  delivered = 0;
  dropped = 0;
  buffered = 0;
  attempted = 0;
  postProcessed = 0;
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
  const { delivered, dropped, buffered, attempted, postProcessed, auditArmed } = runtime;
  return { delivered, dropped, buffered, attempted, postProcessed, auditArmed };
}

/* uneffect: refinement telemetryRouting@1 observe */
export function observeTelemetryRouting(runtime: TelemetryRoutingAccounting): TelemetryRoutingState {
  return snapshotTelemetryRouting(runtime);
}

/* uneffect: refinement telemetryRouting@1 action deliver */
export function deliverTelemetry(runtime: TelemetryRoutingAccounting): void {
  try {
    runtime.delivered += 1;
    if (runtime.auditArmed) return;
  } finally {
    runtime.attempted += 1;
  }
  runtime.postProcessed += 1;
}

/* uneffect: refinement telemetryRouting@1 action drop */
export function dropTelemetry(runtime: TelemetryRoutingAccounting): void {
  try {
    runtime.dropped += 1;
  } finally {
    runtime.attempted += 1;
    return;
  }
  runtime.postProcessed += 1;
}

/* uneffect: refinement telemetryRouting@1 action buffer */
export function bufferTelemetry(runtime: TelemetryRoutingAccounting): void { runtime.record("buffered"); }

/* uneffect: refinement telemetryRouting@1 action reject */
export function rejectTelemetry(runtime: TelemetryRoutingAccounting): void {
  try {
    runtime.attempted += 1;
    if (runtime.auditArmed) throw "telemetry delivery rejected";
    runtime.delivered += 1;
  } catch {
    runtime.dropped += 1;
  } finally {
    runtime.auditArmed = true;
  }
}

/* uneffect: refinement telemetryRouting@1 action armAudit */
export function armTelemetryAudit(runtime: TelemetryRoutingAccounting): void {
  if (runtime.attempted <= 0) return;
  runtime.auditArmed = true;
}

/* uneffect: refinement telemetryRouting@1 action nestedPostProcess */
export function nestedPostProcessTelemetry(runtime: TelemetryRoutingAccounting): void {
  if (runtime.attempted > 0) {
    if (runtime.auditArmed) return;
  }
  runtime.postProcessed += 1;
}

/* uneffect: refinement telemetryRouting@1 action observeLostOutcome */
export function observeLostTelemetryOutcome(runtime: TelemetryRoutingAccounting): void {
  if (!(runtime.delivered + runtime.dropped + runtime.buffered < runtime.attempted && runtime.auditArmed)) return;
}

const telemetryOutcomeInvariant = hasExactlyOneOutcome;

/* uneffect: refinement telemetryRouting@1 invariant allAttemptsHaveOneOutcome */
export function allTelemetryAttemptsHaveOneOutcome(runtime: TelemetryRoutingAccounting): boolean {
  return telemetryOutcomeInvariant(runtime);
}
