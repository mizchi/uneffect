/* uneffect:refinement_from "./telemetry-routing-accounting.uneffect.ts#default" */
import { hasExactlyOneOutcome } from "./telemetry-routing-predicates.js";

/* uneffect:state delivered: int */ /* uneffect:state dropped: int */ /* uneffect:state buffered: int */ /* uneffect:state attempted: int */ /* uneffect:state postProcessed: int */ /* uneffect:state recovered: int */ /* uneffect:state finalized: int */ /* uneffect:state auditArmed: bool */ /* uneffect:init delivered = 0 */ /* uneffect:init dropped = 0 */ /* uneffect:init buffered = 0 */ /* uneffect:init attempted = 0 */ /* uneffect:init postProcessed = 0 */ /* uneffect:init recovered = 0 */ /* uneffect:init finalized = 0 */ /* uneffect:init auditArmed = false */ /* uneffect:action deliver: delivered' = delivered + 1, attempted' = attempted + 1, postProcessed' = auditArmed ? postProcessed : postProcessed + 1 */ /* uneffect:action drop: dropped' = dropped + 1, attempted' = attempted + 1 */ /* uneffect:action buffer: buffered' = buffered + 1, attempted' = attempted + 1 */ /* uneffect:action reject: delivered' = auditArmed ? delivered : delivered + 1, dropped' = auditArmed ? dropped + 1 : dropped, attempted' = attempted + 1, auditArmed' = true */ /* uneffect:action nestedReject: postProcessed' = (auditArmed ? attempted > 0 : false) ? postProcessed + 1 : postProcessed */ /* uneffect:action returnOrReject: postProcessed' = !auditArmed ? (auditArmed ? postProcessed + 1 : postProcessed) + 2 : auditArmed ? postProcessed + 1 : postProcessed, recovered' = auditArmed ? recovered : recovered + 1 */ /* uneffect:action recoverOrStop: recovered' = auditArmed ? recovered : recovered + 1, postProcessed' = auditArmed ? postProcessed : postProcessed + 1 */ /* uneffect:action recoverOrRethrow: recovered' = auditArmed ? recovered : recovered + 1, postProcessed' = auditArmed ? postProcessed : postProcessed + 1 */ /* uneffect:action finalizeRecovery: recovered' = recovered + 1, postProcessed' = (auditArmed ? postProcessed + 1 : attempted < 0 ? postProcessed : postProcessed + 1), finalized' = (auditArmed || attempted < 0) ? finalized : finalized + 1 */ /* uneffect:action routeRecovery: recovered' = attempted === 0 ? recovered + 1 : attempted === 1 ? recovered + 2 : recovered + 3, dropped' = attempted === 1 ? dropped + 1 : dropped, attempted' = attempted === 1 ? attempted + 1 : attempted, finalized' = finalized + 1, postProcessed' = attempted === 0 ? postProcessed : postProcessed + 1 */ /* uneffect:action stagedReject: recovered' = auditArmed ? recovered : recovered + 1, finalized' = (auditArmed ? true : attempted < 0) ? finalized + 1 : finalized, postProcessed' = auditArmed ? postProcessed : attempted < 0 ? postProcessed : postProcessed + 1 */ /* uneffect:action scanConfigured: recovered' = auditArmed ? recovered : (auditArmed ? recovered : recovered + 1) + 2, finalized' = auditArmed || !auditArmed && auditArmed ? finalized + 1 : finalized */ /* uneffect:action nestedRecovery: recovered' = auditArmed ? recovered : recovered + 1, finalized' = auditArmed && attempted < 0 ? (auditArmed ? finalized + 1 : finalized) + 1 : auditArmed ? finalized + 1 : finalized, postProcessed' = auditArmed && attempted < 0 ? postProcessed : postProcessed + 1 */ /* uneffect:action stagedNestedRecovery: recovered' = attempted < 0 ? (auditArmed ? recovered : recovered + 1) + 2 : auditArmed ? recovered : recovered + 1, finalized' = attempted < 0 && auditArmed ? (attempted < 0 && auditArmed ? auditArmed ? finalized + 1 : finalized : (auditArmed ? finalized + 1 : finalized) + 1) + 1 : (auditArmed ? finalized + 1 : finalized) + 1, postProcessed' = attempted < 0 ? postProcessed : postProcessed + 1 */ /* uneffect:action armAudit: auditArmed' = attempted <= 0 ? auditArmed : true */ /* uneffect:action nestedPostProcess: postProcessed' = attempted > 0 ? auditArmed ? postProcessed : postProcessed + 1 : postProcessed + 1 */ /* uneffect:action observeLostOutcome: auditArmed' = auditArmed */ /* uneffect:action_when observeLostOutcome: auditArmed && delivered + dropped + buffered < attempted */ /* uneffect:always allAttemptsHaveOneOutcome: delivered + dropped + buffered === attempted */

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

/* uneffect:trust trust dispatch-sealing telemetry-runtime-v1 */
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

export function createTelemetryRouting(initial: TelemetryRoutingState): TelemetryRoutingAccounting {
  return hydrateTelemetryRouting(initial);
}

function snapshotTelemetryRouting(runtime: TelemetryRoutingAccounting): TelemetryRoutingState {
  const { delivered, dropped, buffered, attempted, postProcessed, recovered, finalized, auditArmed } = runtime;
  return { delivered, dropped, buffered, attempted, postProcessed, recovered, finalized, auditArmed };
}

export function observeTelemetryRouting(runtime: TelemetryRoutingAccounting): TelemetryRoutingState {
  return snapshotTelemetryRouting(runtime);
}

export function deliverTelemetry(runtime: TelemetryRoutingAccounting): void {
  try {
    runtime.delivered += 1;
    if (runtime.auditArmed) return;
  } finally {
    runtime.attempted += 1;
  }
  runtime.postProcessed += 1;
}

export function dropTelemetry(runtime: TelemetryRoutingAccounting): void {
  try {
    runtime.dropped += 1;
  } finally {
    runtime.attempted += 1;
    return;
  }
  runtime.postProcessed += 1;
}

export function bufferTelemetry(runtime: TelemetryRoutingAccounting): void {
  const accounting = runtime;
  accounting.record("buffered");
}

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

export function nestedRejectTelemetry(runtime: TelemetryRoutingAccounting): void {
  try {
    if (runtime.auditArmed) {
      if (runtime.attempted > 0) throw "nested telemetry rejection";
    }
  } catch {
    runtime.postProcessed += 1;
  }
}

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

export function stagedRejectTelemetry(runtime: TelemetryRoutingAccounting): void {
  try {
    if (runtime.auditArmed) throw "telemetry already armed";
    runtime.recovered += 1;
    if (runtime.attempted < 0) throw "invalid telemetry attempt count";
    runtime.postProcessed += 1;
  } catch {
    runtime.finalized += 1;
  }
}

export function scanConfiguredTelemetry(runtime: TelemetryRoutingAccounting): void {
  try {
    for (const units of [1, 2] as const) {
      if (runtime.auditArmed) throw units;
      runtime.recovered += units;
    }
  } catch {
    runtime.finalized += 1;
  }
}

export function nestedTelemetryRecovery(runtime: TelemetryRoutingAccounting): void {
  try {
    try {
      if (runtime.auditArmed) throw "telemetry recovery required";
      runtime.recovered += 1;
    } catch {
      runtime.finalized += 1;
      if (runtime.attempted < 0) throw "telemetry recovery failed";
    }
    runtime.postProcessed += 1;
  } catch {
    runtime.finalized += 1;
  }
}

export function stagedNestedTelemetryRecovery(runtime: TelemetryRoutingAccounting): void {
  try {
    try {
      if (runtime.auditArmed) throw "telemetry already armed";
      runtime.recovered += 1;
    } catch {
      runtime.finalized += 1;
    }
    try {
      if (runtime.attempted < 0) throw "invalid telemetry attempts";
      runtime.postProcessed += 1;
    } catch {
      runtime.recovered += 2;
      if (runtime.auditArmed) throw "staged recovery failed";
    }
    runtime.finalized += 1;
  } catch {
    runtime.finalized += 1;
  }
}

export function armTelemetryAudit(runtime: TelemetryRoutingAccounting): void {
  if (runtime.attempted <= 0) return;
  runtime.auditArmed = true;
}

export function nestedPostProcessTelemetry(runtime: TelemetryRoutingAccounting): void {
  if (runtime.attempted > 0) {
    if (runtime.auditArmed) return;
  }
  runtime.postProcessed += 1;
}

export function observeLostTelemetryOutcome(runtime: TelemetryRoutingAccounting): void {
  if (!(runtime.delivered + runtime.dropped + runtime.buffered < runtime.attempted && runtime.auditArmed)) return;
}

const telemetryOutcomeInvariant = hasExactlyOneOutcome;

export function allTelemetryAttemptsHaveOneOutcome(runtime: TelemetryRoutingAccounting): boolean {
  return telemetryOutcomeInvariant(runtime);
}
