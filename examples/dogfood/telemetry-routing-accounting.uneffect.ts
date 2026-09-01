import { defineRefinement } from "@mizchi/uneffect/spec";
import { allTelemetryAttemptsHaveOneOutcome, armTelemetryAudit, bufferTelemetry, createTelemetryRouting, deliverTelemetry, dropTelemetry, finalizeTelemetryRecovery, nestedPostProcessTelemetry, nestedRejectTelemetry, nestedTelemetryRecovery, observeLostTelemetryOutcome, observeTelemetryRouting, recoverOrRethrowTelemetry, recoverOrStopTelemetry, rejectTelemetry, returnOrRejectTelemetry, routeTelemetryRecovery, scanConfiguredTelemetry, stagedNestedTelemetryRecovery, stagedRejectTelemetry } from "./telemetry-routing-accounting.js";

export default defineRefinement({
  name: "telemetryRouting",
  version: "1",
  create: createTelemetryRouting,
  observe: observeTelemetryRouting,
  abstractions: {},
  actions: {
    "deliver": deliverTelemetry,
    "drop": dropTelemetry,
    "buffer": bufferTelemetry,
    "reject": rejectTelemetry,
    "nestedReject": nestedRejectTelemetry,
    "returnOrReject": returnOrRejectTelemetry,
    "recoverOrStop": recoverOrStopTelemetry,
    "recoverOrRethrow": recoverOrRethrowTelemetry,
    "finalizeRecovery": finalizeTelemetryRecovery,
    "routeRecovery": routeTelemetryRecovery,
    "stagedReject": stagedRejectTelemetry,
    "scanConfigured": scanConfiguredTelemetry,
    "nestedRecovery": nestedTelemetryRecovery,
    "stagedNestedRecovery": stagedNestedTelemetryRecovery,
    "armAudit": armTelemetryAudit,
    "nestedPostProcess": nestedPostProcessTelemetry,
    "observeLostOutcome": observeLostTelemetryOutcome,
  },
  invariants: {
    "allAttemptsHaveOneOutcome": allTelemetryAttemptsHaveOneOutcome,
  },
});
