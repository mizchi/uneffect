import { hasExactlyOneOutcome } from "./telemetry-routing-predicates.js";

/* uneffect:
  state delivered: int
  state dropped: int
  state buffered: int
  state attempted: int
  state postProcessed: int
  state recovered: int
  state finalized: int
  state auditArmed: bool
  init delivered = 0
  init dropped = 0
  init buffered = 0
  init attempted = 0
  init postProcessed = 0
  init recovered = 0
  init finalized = 0
  init auditArmed = false
  action deliver: delivered' = delivered + 1, attempted' = attempted + 1, postProcessed' = auditArmed ? postProcessed : postProcessed + 1
  action drop: dropped' = dropped + 1, attempted' = attempted + 1
  action buffer: buffered' = buffered + 1, attempted' = attempted + 1
  action reject: delivered' = auditArmed ? delivered : delivered + 1, dropped' = auditArmed ? dropped + 1 : dropped, attempted' = attempted + 1, auditArmed' = true
  action nestedReject: postProcessed' = (auditArmed ? attempted > 0 : false) ? postProcessed + 1 : postProcessed
  action returnOrReject: postProcessed' = !auditArmed ? (auditArmed ? postProcessed + 1 : postProcessed) + 2 : auditArmed ? postProcessed + 1 : postProcessed, recovered' = auditArmed ? recovered : recovered + 1
  action recoverOrStop: recovered' = auditArmed ? recovered : recovered + 1, postProcessed' = auditArmed ? postProcessed : postProcessed + 1
  action recoverOrRethrow: recovered' = auditArmed ? recovered : recovered + 1, postProcessed' = auditArmed ? postProcessed : postProcessed + 1
  action finalizeRecovery: recovered' = recovered + 1, postProcessed' = (auditArmed ? postProcessed + 1 : attempted < 0 ? postProcessed : postProcessed + 1), finalized' = (auditArmed || attempted < 0) ? finalized : finalized + 1
  action routeRecovery: recovered' = attempted === 0 ? recovered + 1 : attempted === 1 ? recovered + 2 : recovered + 3, dropped' = attempted === 1 ? dropped + 1 : dropped, attempted' = attempted === 1 ? attempted + 1 : attempted, finalized' = finalized + 1, postProcessed' = attempted === 0 ? postProcessed : postProcessed + 1
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
  recovered: number;
  finalized: number;
  auditArmed: boolean;
}

/* uneffect: trust dispatch-sealing application owns the complete class graph */
/* uneffect: trust_owner telemetry-platform */
/* uneffect: trust_expires 2027-08-31 */
export class TelemetryRoutingAccounting {
  delivered = 0;
  dropped = 0;
  buffered = 0;
  attempted = 0;
  postProcessed = 0;
  recovered = 0;
  finalized = 0;
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
  const { delivered, dropped, buffered, attempted, postProcessed, recovered, finalized, auditArmed } = runtime;
  return { delivered, dropped, buffered, attempted, postProcessed, recovered, finalized, auditArmed };
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
export function bufferTelemetry(runtime: TelemetryRoutingAccounting): void {
  const accounting = runtime;
  accounting.record("buffered");
}

/* uneffect: refinement telemetryRouting@1 action reject */
export function rejectTelemetry(runtime: TelemetryRoutingAccounting): void {
  try {
    runtime.attempted += 1;
    if (runtime.auditArmed) throw runtime.auditArmed;
    runtime.delivered += 1;
  } catch (armed) {
    if (armed) runtime.dropped += 1;
  } finally {
    runtime.auditArmed = true;
  }
}

/* uneffect: refinement telemetryRouting@1 action nestedReject */
export function nestedRejectTelemetry(runtime: TelemetryRoutingAccounting): void {
  try {
    if (runtime.auditArmed) {
      if (runtime.attempted > 0) throw "nested telemetry rejection";
    }
  } catch {
    runtime.postProcessed += 1;
  }
}

/* uneffect: refinement telemetryRouting@1 action returnOrReject */
export function returnOrRejectTelemetry(runtime: TelemetryRoutingAccounting): void {
  try {
    if (runtime.auditArmed) {
      runtime.postProcessed += 1;
      return;
    }
    throw "telemetry not armed";
  } catch {
    runtime.postProcessed += 2;
  } finally {
    // Both abrupt paths cross the same cleanup boundary.
  }
  runtime.recovered += 1;
}

/* uneffect: refinement telemetryRouting@1 action recoverOrStop */
export function recoverOrStopTelemetry(runtime: TelemetryRoutingAccounting): void {
  try {
    throw "telemetry recovery required";
  } catch {
    if (runtime.auditArmed) return;
    runtime.recovered += 1;
  } finally {
    // Recovery termination still crosses the cleanup boundary.
  }
  runtime.postProcessed += 1;
}

/* uneffect: refinement telemetryRouting@1 action recoverOrRethrow */
export function recoverOrRethrowTelemetry(runtime: TelemetryRoutingAccounting): void {
  try {
    throw "telemetry recovery required";
  } catch {
    if (runtime.auditArmed) throw "telemetry recovery rejected";
    runtime.recovered += 1;
  } finally {
    // A rethrow also crosses the cleanup boundary.
  }
  runtime.postProcessed += 1;
}

/* uneffect: refinement telemetryRouting@1 action finalizeRecovery */
export function finalizeTelemetryRecovery(runtime: TelemetryRoutingAccounting): void {
  try {
    runtime.recovered += 1;
  } finally {
    if (runtime.auditArmed) {
      runtime.postProcessed += 1;
      return;
    }
    if (runtime.attempted < 0) throw "telemetry cleanup failed";
    runtime.postProcessed += 1;
  }
  runtime.finalized += 1;
}

/* uneffect: refinement telemetryRouting@1 action routeRecovery */
export function routeTelemetryRecovery(runtime: TelemetryRoutingAccounting): number | void {
  try {
    switch (runtime.attempted) {
      case 0:
        runtime.recovered += 1;
        return runtime.recovered;
      case 1:
        runtime.recovered += 2;
        throw runtime.recovered;
      default:
        runtime.recovered += 3;
        break;
    }
  } catch {
    runtime.dropped += 1;
    runtime.attempted += 1;
  } finally {
    runtime.finalized += 1;
  }
  runtime.postProcessed += 1;
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
