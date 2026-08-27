import { globSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { analyzeEffects, analyzeProgramEffects } from "../src/effects.js";
import { analyzeAsyncSafety, analyzeAsyncSafetyInProgram, generateUnifiedAsyncQuint } from "../src/async-safety.js";
import { analyzePromiseChains, generatePromiseChainsQuint } from "../src/promise-chains.js";
import { analyzeAsyncPatterns, analyzeAsyncPatternsInProgram, generateAsyncPatternsQuint, generateNodeEventLoopQuint, generateWebEventLoopQuint } from "../src/async-patterns.js";
import { auditBuiltinDeclarationDrift } from "../src/frontend-adapter.js";
import { verifyUneffectProject } from "../src/project-verification.js";
import { verifyTypedArraySafety } from "../src/typed-array-safety.js";
import { parseSpec } from "../src/spec-ir.js";
import { generateQuint } from "../src/spec-backends.js";
import { findTemporalCounterexampleWithZ3, lintTemporalReachabilityWithZ3, lintTemporalSpecWithZ3 } from "../src/spec-lint.js";
import { generateUneffectPropertyTests, generateUneffectPropertyTestsWithZ3 } from "../src/property-tests.js";
import { validateRefinementActionBodies, validateRefinementActionBodiesInProgramWithZ3, validateRefinementActionBodiesWithZ3, validateRefinementBindingCoverage, validateRefinementInvariantBodiesInProgramWithZ3, validateRefinementInvariantBodiesWithZ3, validateRefinementStateProjection, validateRefinementStateProjectionInProgram } from "../src/refinement-bindings.js";

const telemetryRoutingFileName = "examples/dogfood/telemetry-routing-accounting.ts";

function telemetryRoutingFixture() {
  const source = readFileSync(telemetryRoutingFileName, "utf8");
  return { fileName: telemetryRoutingFileName, source, temporal: parseSpec(telemetryRoutingFileName, source).temporal };
}

describe("Uneffect dogfood", () => {
  it("enforces a telemetry Generator lazy-effect budget through the project API", async () => {
    const fileName = "examples/dogfood/telemetry-generator-budget.ts";
    const source = readFileSync(fileName, "utf8");
    const verified = await verifyUneffectProject({ files: { [fileName]: source } });
    expect(verified.diagnostics).toEqual([]);
    expect(verified.effects.summaries.find((summary) => summary.functionName === "drainTelemetryBatches"))
      .toMatchObject({
        evidence: "verified",
        iteratorEffectBounds: [expect.objectContaining({ index: 0, name: "batches" })],
      });
    expect(verified.effects.summaries.find((summary) => summary.functionName === "flushTelemetry"))
      .toMatchObject({ evidence: "verified" });
    expect(verified.assurance).toMatchObject({ passed: true, blockers: [] });

    const broken = await verifyUneffectProject({ files: {
      [fileName]: source.replace("Console | Throw<RangeError> */\nexport function drainTelemetryBatches", "Console */\nexport function drainTelemetryBatches"),
    } });
    expect(broken.diagnostics).toContainEqual(expect.objectContaining({
      functionName: "flushTelemetry", effect: "Throw<RangeError>", kind: "missing",
      message: expect.stringContaining("outside its declared bound"),
    }));
    expect(broken.effects.summaries.find((summary) => summary.functionName === "flushTelemetry"))
      .toMatchObject({ evidence: "unknown" });
    expect(broken.assurance).toMatchObject({ passed: false });
  });

  it("refines generated zero-shot and one-shot migration control shells", async () => {
    const fileName = "examples/dogfood/generated-one-shot-migration.ts";
    const source = readFileSync(fileName, "utf8");
    const temporal = parseSpec(fileName, source).temporal;
    expect(validateRefinementBindingCoverage(fileName, source, "generatedMigration", temporal)).toEqual([]);
    expect(validateRefinementStateProjection(fileName, source, "generatedMigration", temporal)).toEqual([]);
    expect(await validateRefinementActionBodiesWithZ3(fileName, source, "generatedMigration", temporal)).toEqual([]);
    expect(await validateRefinementInvariantBodiesWithZ3(fileName, source, "generatedMigration", temporal)).toEqual([]);

    const dynamicLoop = source.replace("while (false) runtime.migrated += 1_000", "while (runtime.migrated < 2) runtime.migrated++");
    expect(await validateRefinementActionBodiesWithZ3(fileName, dynamicLoop, "generatedMigration", temporal)).toContainEqual(
      expect.objectContaining({ code: "action-update-mismatch", modelName: "migrate", target: "migrated" }),
    );
    const dynamicBatch = source.replace("migrationId < 4", "migrationId < runtime.migrated");
    expect(await validateRefinementActionBodiesWithZ3(fileName, dynamicBatch, "generatedMigration", temporal)).toContainEqual(
      expect.objectContaining({ code: "unsupported-action-body", modelName: "migrateBatch" }),
    );
    const missingReport = source.replace("  runtime.reported++;", "  // missing report");
    expect(await validateRefinementActionBodiesWithZ3(fileName, missingReport, "generatedMigration", temporal)).toContainEqual(
      expect.objectContaining({ code: "action-update-mismatch", modelName: "migrateUntil", target: "reported" }),
    );
    const missingSelectedReport = source.replace("  runtime.reported++; // selected migration report", "  // missing selected report");
    expect(await validateRefinementActionBodiesWithZ3(fileName, missingSelectedReport, "generatedMigration", temporal)).toContainEqual(
      expect.objectContaining({ code: "action-update-mismatch", modelName: "migrateSelected", target: "reported" }),
    );
  });

  it("proves telemetry backlog accounting through a symbolic countdown loop", async () => {
    const fileName = "examples/dogfood/telemetry-backlog-drain.ts";
    const source = readFileSync(fileName, "utf8");
    const temporal = parseSpec(fileName, source).temporal;
    expect(validateRefinementBindingCoverage(fileName, source, "telemetryBacklog", temporal)).toEqual([]);
    expect(validateRefinementStateProjection(fileName, source, "telemetryBacklog", temporal)).toEqual([]);
    expect(await validateRefinementActionBodiesWithZ3(fileName, source, "telemetryBacklog", temporal)).toEqual([]);

    const doubleAccounting = source.replace("runtime.accounted += 2;", "runtime.accounted += 4;");
    expect(await validateRefinementActionBodiesWithZ3(fileName, doubleAccounting, "telemetryBacklog", temporal)).toContainEqual(
      expect.objectContaining({ code: "action-update-mismatch", modelName: "drain", target: "accounted" }),
    );
    const nonTerminating = source.replace("runtime.queued -= 2;", "runtime.queued += 2;");
    expect(await validateRefinementActionBodiesWithZ3(fileName, nonTerminating, "telemetryBacklog", temporal)).toContainEqual(
      expect.objectContaining({ code: "unsupported-action-body", modelName: "drain" }),
    );
  });

  it("proves tiered telemetry pressure across symbolic branch joins", async () => {
    const fileName = "examples/dogfood/priority-telemetry-drain.ts";
    const source = readFileSync(fileName, "utf8");
    const temporal = parseSpec(fileName, source).temporal;
    expect(validateRefinementBindingCoverage(fileName, source, "priorityTelemetry", temporal)).toEqual([]);
    expect(validateRefinementStateProjection(fileName, source, "priorityTelemetry", temporal)).toEqual([]);
    expect(await validateRefinementActionBodiesWithZ3(fileName, source, "priorityTelemetry", temporal)).toEqual([]);

    const skippedRankingStep = source.replace(
      "runtime.queued--;\n    if (!runtime.priority && !runtime.sampled) continue;",
      "if (!runtime.priority && !runtime.sampled) continue;\n    runtime.queued--;",
    );
    expect(await validateRefinementActionBodiesWithZ3(
      fileName, skippedRankingStep, "priorityTelemetry", temporal,
    )).toContainEqual(expect.objectContaining({
      code: "unsupported-action-body", modelName: "drain",
    }));

    const mutablePriority = source.replace(
      "else runtime.pressure++;",
      "else { runtime.pressure++; runtime.sampled = false; }",
    );
    await expect(validateRefinementActionBodiesWithZ3(
      fileName, mutablePriority, "priorityTelemetry", temporal,
    )).resolves.toContainEqual(expect.objectContaining({
      code: "unsupported-action-body", modelName: "drain",
    }));
  });

  it("proves that a paused telemetry drain records the untouched backlog once", async () => {
    const fileName = "examples/dogfood/paused-telemetry-drain.ts";
    const source = readFileSync(fileName, "utf8");
    const temporal = parseSpec(fileName, source).temporal;
    expect(validateRefinementBindingCoverage(fileName, source, "pausedTelemetry", temporal)).toEqual([]);
    expect(validateRefinementStateProjection(fileName, source, "pausedTelemetry", temporal)).toEqual([]);
    expect(await validateRefinementActionBodiesWithZ3(fileName, source, "pausedTelemetry", temporal)).toEqual([]);

    const latePauseCheck = source.replace(
      "if (runtime.paused) {\n      runtime.deferred += runtime.queued;\n      runtime.deferredWeight += 2 * runtime.queued;\n      break;\n    }\n    runtime.queued--;",
      "runtime.queued--;\n    if (runtime.paused) {\n      runtime.deferred += runtime.queued;\n      runtime.deferredWeight += 2 * runtime.queued;\n      break;\n    }",
    );
    await expect(validateRefinementActionBodiesWithZ3(
      fileName, latePauseCheck, "pausedTelemetry", temporal,
    )).resolves.toContainEqual(expect.objectContaining({
      code: "action-update-mismatch", modelName: "drain",
    }));
  });

  it("proves caught telemetry retry/stop policy with one common attempt cleanup", async () => {
    const fileName = "examples/dogfood/failing-telemetry-drain.ts";
    const source = readFileSync(fileName, "utf8");
    const temporal = parseSpec(fileName, source).temporal;
    expect(validateRefinementBindingCoverage(fileName, source, "failingTelemetry", temporal)).toEqual([]);
    expect(validateRefinementStateProjection(fileName, source, "failingTelemetry", temporal)).toEqual([]);
    expect(await validateRefinementActionBodiesWithZ3(
      fileName, source, "failingTelemetry", temporal,
    )).toEqual([]);

    const inconsistentFatalStep = source.replace(
      "runtime.pending--;\n      runtime.attempts++;",
      "runtime.pending -= runtime.fatal ? 2 : 1;\n      runtime.attempts++;",
    );
    await expect(validateRefinementActionBodiesWithZ3(
      fileName, inconsistentFatalStep, "failingTelemetry", temporal,
    )).resolves.toContainEqual(expect.objectContaining({
      code: "unsupported-action-body", modelName: "drain",
    }));
  });

  it("proves path-wise accounting for nested sampled-urgent and circuit-open telemetry stops", async () => {
    const fileName = "examples/dogfood/circuit-breaker-telemetry-drain.ts";
    const source = readFileSync(fileName, "utf8");
    const temporal = parseSpec(fileName, source).temporal;
    expect(validateRefinementBindingCoverage(fileName, source, "circuitBreakerTelemetry", temporal)).toEqual([]);
    expect(validateRefinementStateProjection(fileName, source, "circuitBreakerTelemetry", temporal)).toEqual([]);
    await expect(validateRefinementActionBodiesWithZ3(
      fileName, source, "circuitBreakerTelemetry", temporal,
    )).resolves.toEqual([]);

    const coupledStopAccounting = source.replace(
      "runtime.stoppedWeight += runtime.pending;",
      "runtime.stoppedWeight += runtime.processed;",
    );
    await expect(validateRefinementActionBodiesWithZ3(
      fileName, coupledStopAccounting, "circuitBreakerTelemetry", temporal,
    )).resolves.toContainEqual(expect.objectContaining({
      code: "unsupported-action-body", modelName: "drain",
    }));
  });

  it("proves adaptive billing through sequential mutable-local joins", async () => {
    const fileName = "examples/dogfood/adaptive-batch-accounting.ts";
    const source = readFileSync(fileName, "utf8");
    const temporal = parseSpec(fileName, source).temporal;
    expect(validateRefinementBindingCoverage(fileName, source, "adaptiveBatchAccounting", temporal)).toEqual([]);
    expect(validateRefinementStateProjection(fileName, source, "adaptiveBatchAccounting", temporal)).toEqual([]);
    await expect(validateRefinementActionBodiesWithZ3(
      fileName, source, "adaptiveBatchAccounting", temporal,
    )).resolves.toEqual([]);

    const underbilledRetry = source.replace("units += 3;", "units += 2;");
    await expect(validateRefinementActionBodiesWithZ3(
      fileName, underbilledRetry, "adaptiveBatchAccounting", temporal,
    )).resolves.toContainEqual(expect.objectContaining({
      code: "action-update-mismatch", modelName: "record",
    }));

    const underbilledFailure = source.replace("units += failedUnits", "units += 1");
    await expect(validateRefinementActionBodiesWithZ3(
      fileName, underbilledFailure, "adaptiveBatchAccounting", temporal,
    )).resolves.toContainEqual(expect.objectContaining({
      code: "action-update-mismatch", modelName: "record",
    }));

    const billedFailure = source.replace(
      "return; // failed batches are audited in finally but never billed",
      "runtime.billedUnits += units;\n    return; // incorrectly bill the failed batch",
    );
    await expect(validateRefinementActionBodiesWithZ3(
      fileName, billedFailure, "adaptiveBatchAccounting", temporal,
    )).resolves.toContainEqual(expect.objectContaining({
      code: "action-update-mismatch", modelName: "record", target: "billedUnits",
    }));

    const underAuditedFailure = source.replace("runtime.auditedUnits += units", "runtime.auditedUnits += 1");
    await expect(validateRefinementActionBodiesWithZ3(
      fileName, underAuditedFailure, "adaptiveBatchAccounting", temporal,
    )).resolves.toContainEqual(expect.objectContaining({
      code: "action-update-mismatch", modelName: "record", target: "auditedUnits",
    }));

    const missingAttemptOverhead = source.replace(
      "units += 1; // common per-attempt overhead on normal, return, and recovered throw paths",
      "// missing per-attempt overhead",
    );
    await expect(validateRefinementActionBodiesWithZ3(
      fileName, missingAttemptOverhead, "adaptiveBatchAccounting", temporal,
    )).resolves.toContainEqual(expect.objectContaining({
      code: "action-update-mismatch", modelName: "record",
    }));

    const billedCancellation = source.replace(
      "units = 1;\n      return;",
      "units = 1;\n      runtime.billedUnits += units;\n      return;",
    );
    await expect(validateRefinementActionBodiesWithZ3(
      fileName, billedCancellation, "adaptiveBatchAccounting", temporal,
    )).resolves.toContainEqual(expect.objectContaining({
      code: "action-update-mismatch", modelName: "record", target: "billedUnits",
    }));
  });

  it("proves normalized batch recovery through mutable-local rethrow", async () => {
    const fileName = "examples/dogfood/rethrow-batch-accounting.ts";
    const source = readFileSync(fileName, "utf8");
    const temporal = parseSpec(fileName, source).temporal;
    expect(validateRefinementBindingCoverage(
      fileName, source, "rethrowBatchAccounting", temporal,
    )).toEqual([]);
    expect(validateRefinementStateProjection(
      fileName, source, "rethrowBatchAccounting", temporal,
    )).toEqual([]);
    await expect(validateRefinementActionBodiesWithZ3(
      fileName, source, "rethrowBatchAccounting", temporal,
    )).resolves.toEqual([]);

    const wrongNormalization = source.replace("units += validationUnits", "units += validationUnits + 1");
    await expect(validateRefinementActionBodiesWithZ3(
      fileName, wrongNormalization, "rethrowBatchAccounting", temporal,
    )).resolves.toContainEqual(expect.objectContaining({
      code: "action-update-mismatch", modelName: "record",
    }));

    const opaqueRethrow = source.replace("throw units;\n    } finally", "throw new Error('invalid batch');\n    } finally");
    expect(validateRefinementActionBodies(
      fileName, opaqueRethrow, "rethrowBatchAccounting", temporal,
    )).toContainEqual(expect.objectContaining({
      code: "unsupported-action-body", modelName: "record",
    }));
  });

  it("proves pairwise worker-pool scale-up including target overshoot", async () => {
    const fileName = "examples/dogfood/worker-pool-scale-up.ts";
    const source = readFileSync(fileName, "utf8");
    const temporal = parseSpec(fileName, source).temporal;
    expect(validateRefinementBindingCoverage(fileName, source, "workerPool", temporal)).toEqual([]);
    expect(validateRefinementStateProjection(fileName, source, "workerPool", temporal)).toEqual([]);
    expect(await validateRefinementActionBodiesWithZ3(fileName, source, "workerPool", temporal)).toEqual([]);

    const undercountedStarts = source.replace("pool.starts += 2;", "pool.starts++;");
    expect(await validateRefinementActionBodiesWithZ3(fileName, undercountedStarts, "workerPool", temporal)).toContainEqual(
      expect.objectContaining({ code: "action-update-mismatch", modelName: "reconcile", target: "starts" }),
    );
    const wrongDirection = source.replace("pool.active += 2;", "pool.active -= 2;");
    expect(await validateRefinementActionBodiesWithZ3(fileName, wrongDirection, "workerPool", temporal)).toContainEqual(
      expect.objectContaining({ code: "unsupported-action-body", modelName: "reconcile" }),
    );
  });

  it("accepts mandatory finally release of a loop-local upload session alias", () => {
    const fileName = "examples/dogfood/upload-session-finally.ts";
    const source = readFileSync(fileName, "utf8");
    const verified = analyzeAsyncSafety(fileName, source);
    expect(verified.diagnostics).not.toContainEqual(expect.objectContaining({
      functionName: "uploadConfiguredParts", kind: "disposed-resource-use",
    }));

    const missingClear = source.replace(
      "activeSession = undefined;",
      "// missing mandatory alias clear",
    );
    expect(analyzeAsyncSafety(fileName, missingClear).diagnostics).toContainEqual(expect.objectContaining({
      functionName: "uploadConfiguredParts", kind: "disposed-resource-use",
    }));
  });

  it("refines a finite telemetry batch across early return and per-sink finalization", async () => {
    const fileName = "examples/dogfood/finite-telemetry-batch.ts";
    const source = readFileSync(fileName, "utf8");
    const temporal = parseSpec(fileName, source).temporal;
    const program = ts.createProgram([fileName], {
      target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext, noEmit: true,
    });
    expect(validateRefinementBindingCoverage(fileName, source, "telemetryBatch", temporal)).toEqual([]);
    expect(validateRefinementStateProjectionInProgram(program, fileName, "telemetryBatch", temporal)).toEqual([]);
    expect(await validateRefinementActionBodiesInProgramWithZ3(program, fileName, "telemetryBatch", temporal)).toEqual([]);
    expect(await validateRefinementInvariantBodiesInProgramWithZ3(program, fileName, "telemetryBatch", temporal)).toEqual([]);

    const missingFinalization = source.replace("accounting.finalized++;", "// missing finalization");
    expect(await validateRefinementActionBodiesWithZ3(fileName, missingFinalization, "telemetryBatch", temporal)).toContainEqual(
      expect.objectContaining({ code: "action-update-mismatch", modelName: "sendBatch", target: "finalized" }),
    );
  });

  it("proves bounded batch billing through loop-carried local completion edges", async () => {
    const fileName = "examples/dogfood/bounded-batch-billing.ts";
    const source = readFileSync(fileName, "utf8");
    const temporal = parseSpec(fileName, source).temporal;
    expect(validateRefinementBindingCoverage(fileName, source, "boundedBatchBilling", temporal)).toEqual([]);
    expect(validateRefinementStateProjection(fileName, source, "boundedBatchBilling", temporal)).toEqual([]);
    await expect(validateRefinementActionBodiesWithZ3(
      fileName, source, "boundedBatchBilling", temporal,
    )).resolves.toEqual([]);

    const underbilled = source.replace("const perSinkOverhead = 1;", "const perSinkOverhead = 2;");
    await expect(validateRefinementActionBodiesWithZ3(
      fileName, underbilled, "boundedBatchBilling", temporal,
    )).resolves.toContainEqual(expect.objectContaining({
      code: "action-update-mismatch", modelName: "billBatch",
    }));
  });

  it("refines labeled telemetry cancellation through finally and audit continuation", async () => {
    const fileName = "examples/dogfood/labeled-telemetry-delivery.ts";
    const source = readFileSync(fileName, "utf8");
    const temporal = parseSpec(fileName, source).temporal;
    expect(await validateRefinementActionBodiesWithZ3(fileName, source, "labeledDelivery", temporal)).toEqual([]);

    const invertedBreak = source.replace("if (delivery.skip) {", "if (!delivery.skip) {");
    expect(await validateRefinementActionBodiesWithZ3(fileName, invertedBreak, "labeledDelivery", temporal)).toContainEqual(
      expect.objectContaining({ code: "action-update-mismatch", modelName: "deliver", target: "delivered" }),
    );

    const overchargedDelivery = source.replace("units += 2;\n        delivery.delivered++;", "units += 3;\n        delivery.delivered++;");
    expect(await validateRefinementActionBodiesWithZ3(fileName, overchargedDelivery, "labeledDelivery", temporal)).toContainEqual(
      expect.objectContaining({ code: "action-update-mismatch", modelName: "deliver", target: "charged" }),
    );
  });

  it("accepts grouped resource-release cases and catches an uncleared exit", () => {
    const fileName = "examples/dogfood/grouped-resource-release.ts";
    const source = readFileSync(fileName, "utf8");
    const verified = analyzeAsyncSafety(fileName, source);
    expect(verified.diagnostics).not.toContainEqual(expect.objectContaining({
      functionName: "finalizeDelivery", kind: "disposed-resource-use",
    }));
    expect(verified.diagnostics).not.toContainEqual(expect.objectContaining({
      functionName: "finalizeConditional", kind: "disposed-resource-use",
    }));
    expect(verified.diagnostics).not.toContainEqual(expect.objectContaining({
      functionName: "finalizeDeliveryBatch", kind: "disposed-resource-use",
    }));

    const broken = analyzeAsyncSafety(fileName, source.replace(
      "case \"expired\": pending = undefined; break;",
      "case \"expired\": break;",
    ));
    expect(broken.diagnostics).toContainEqual(expect.objectContaining({
      functionName: "finalizeDelivery", kind: "disposed-resource-use",
    }));

    const brokenConditional = analyzeAsyncSafety(fileName, source.replace(
      "else pending = undefined;",
      "else void alreadyClosed;",
    ));
    expect(brokenConditional.diagnostics).toContainEqual(expect.objectContaining({
      functionName: "finalizeConditional", kind: "disposed-resource-use",
    }));

    const brokenBatch = analyzeAsyncSafety(fileName, source.replace(
      "pending = undefined; // iteration cleanup",
      "void deliveryId; // missing iteration cleanup",
    ));
    expect(brokenBatch.diagnostics).toContainEqual(expect.objectContaining({
      functionName: "finalizeDeliveryBatch", kind: "disposed-resource-use",
    }));
  });

  it("refines renamed application state through an explicit abstraction relation", async () => {
    const fileName = "examples/dogfood/renamed-routing-state.ts";
    const source = readFileSync(fileName, "utf8");
    const temporal = parseSpec(fileName, source).temporal;
    const program = ts.createProgram([fileName], {
      target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext, noEmit: true,
    });
    expect(validateRefinementBindingCoverage(fileName, source, "routingState", temporal)).toEqual([]);
    expect(validateRefinementStateProjectionInProgram(program, fileName, "routingState", temporal)).toEqual([]);
    expect(await validateRefinementActionBodiesInProgramWithZ3(program, fileName, "routingState", temporal)).toEqual([]);
    expect(await validateRefinementInvariantBodiesInProgramWithZ3(program, fileName, "routingState", temporal)).toEqual([]);

    const directory = mkdtempSync(join(tmpdir(), "uneffect-routing-dogfood-"));
    const wrongFile = join(directory, "renamed-routing-state.ts");
    try {
      const wrongAction = source.replace("activeSubscriberIds.push(2)", "activeSubscriberIds.push(3)");
      writeFileSync(wrongFile, wrongAction);
      const wrongProgram = ts.createProgram([wrongFile], {
        target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext, noEmit: true,
      });
      expect(await validateRefinementActionBodiesInProgramWithZ3(wrongProgram, wrongFile, "routingState", temporal)).toContainEqual(
        expect.objectContaining({ code: "action-update-mismatch", modelName: "subscribeFallback", target: "subscribers" }),
      );
      const unsupportedFilter = source.replace("id !== primaryId", "id > primaryId");
      writeFileSync(wrongFile, unsupportedFilter);
      const unsupportedFilterProgram = ts.createProgram([wrongFile], {
        target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext, noEmit: true,
      });
      expect(await validateRefinementActionBodiesInProgramWithZ3(unsupportedFilterProgram, wrongFile, "routingState", temporal)).toContainEqual(
        expect.objectContaining({ code: "unsupported-action-body", modelName: "unsubscribePrimary" }),
      );
      const mutableFilterValue = source.replace("const primaryId = 1", "let primaryId = 1");
      writeFileSync(wrongFile, mutableFilterValue);
      const mutableFilterProgram = ts.createProgram([wrongFile], {
        target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext, noEmit: true,
      });
      expect(await validateRefinementActionBodiesInProgramWithZ3(mutableFilterProgram, wrongFile, "routingState", temporal)).toContainEqual(
        expect.objectContaining({ code: "unsupported-action-body", modelName: "unsubscribePrimary" }),
      );
      const wrongMembership = source.replace("id === 1", "id === 2");
      writeFileSync(wrongFile, wrongMembership);
      const wrongMembershipProgram = ts.createProgram([wrongFile], {
        target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext, noEmit: true,
      });
      expect(await validateRefinementInvariantBodiesInProgramWithZ3(wrongMembershipProgram, wrongFile, "routingState", temporal)).toContainEqual(
        expect.objectContaining({ code: "invariant-expression-mismatch", modelName: "primarySubscribed" }),
      );
      const mutableQuantifierLocal = source.replace("const minimum = 0", "let minimum = 0");
      writeFileSync(wrongFile, mutableQuantifierLocal);
      const mutableQuantifierProgram = ts.createProgram([wrongFile], {
        target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext, noEmit: true,
      });
      expect(await validateRefinementInvariantBodiesInProgramWithZ3(mutableQuantifierProgram, wrongFile, "routingState", temporal)).toContainEqual(
        expect.objectContaining({ code: "unsupported-invariant-body", modelName: "allSubscriberIdsPositive" }),
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
    const wrongObservation = source.replace("subscribers: new Set(runtime.routing.activeSubscriberIds)", "subscribers: new Set<number>()");
    expect(validateRefinementStateProjection(fileName, wrongObservation, "routingState", temporal)).toContainEqual(
      expect.objectContaining({ code: "unsupported-observe-body" }),
    );
  });

  it("refines Node Lease authority Set/Map mutations", async () => {
    const fileName = "examples/dogfood/lease-authority-refinement.ts";
    const source = readFileSync(fileName, "utf8");
    const temporal = parseSpec(fileName, source).temporal;
    const program = ts.createProgram([fileName], {
      target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext, types: ["node"], noEmit: true,
    });
    expect(validateRefinementBindingCoverage(fileName, source, "leaseAuthority", temporal)).toEqual([]);
    expect(await validateRefinementActionBodiesInProgramWithZ3(program, fileName, "leaseAuthority", temporal)).toEqual([]);
    expect(validateRefinementStateProjectionInProgram(program, fileName, "leaseAuthority", temporal)).toEqual([]);

    const wrong = source.replace("owners.add(2)", "owners.add(20)");
    expect(await validateRefinementActionBodiesWithZ3(fileName, wrong, "leaseAuthority", temporal)).toContainEqual(
      expect.objectContaining({ code: "action-update-mismatch", modelName: "admitOwner", target: "authority" }),
    );
    const wrongClear = source.replace("runtime.authority.owners.clear()", "runtime.authority.epochs.clear()");
    expect(await validateRefinementActionBodiesWithZ3(fileName, wrongClear, "leaseAuthority", temporal)).toContainEqual(
      expect.objectContaining({ code: "action-update-mismatch", modelName: "revokeOwners", target: "authority" }),
    );
    const wrongDelete = source.replace("runtime.authority.owners.delete(1)", "runtime.authority.owners.delete(2)");
    expect(await validateRefinementActionBodiesWithZ3(fileName, wrongDelete, "leaseAuthority", temporal)).toContainEqual(
      expect.objectContaining({ code: "action-update-mismatch", modelName: "revokeOwner", target: "authority" }),
    );
  });

  it("refines a persisted Map through mutable entry arrays", async () => {
    const fileName = "examples/dogfood/persisted-epoch-entries.ts";
    const source = readFileSync(fileName, "utf8");
    const temporal = parseSpec(fileName, source).temporal;
    const program = ts.createProgram([fileName], {
      target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext, noEmit: true,
    });
    expect(validateRefinementBindingCoverage(fileName, source, "persistedEpochs", temporal)).toEqual([]);
    expect(validateRefinementStateProjectionInProgram(program, fileName, "persistedEpochs", temporal)).toEqual([]);
    expect(await validateRefinementActionBodiesInProgramWithZ3(program, fileName, "persistedEpochs", temporal)).toEqual([]);
    expect(await validateRefinementInvariantBodiesInProgramWithZ3(program, fileName, "persistedEpochs", temporal)).toEqual([]);

    const directory = mkdtempSync(join(tmpdir(), "uneffect-map-entries-dogfood-"));
    const wrongFile = join(directory, "persisted-epoch-entries.ts");
    try {
      const wrong = source.replace("push([2, 1])", "push([2, 3])");
      writeFileSync(wrongFile, wrong);
      const wrongProgram = ts.createProgram([wrongFile], {
        target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext, noEmit: true,
      });
      expect(await validateRefinementActionBodiesInProgramWithZ3(wrongProgram, wrongFile, "persistedEpochs", temporal)).toContainEqual(
        expect.objectContaining({ code: "action-update-mismatch", modelName: "addFallback", target: "epochs" }),
      );
      const wrongRemoval = source.replace("entry[0] !== 1", "entry[0] !== 2");
      writeFileSync(wrongFile, wrongRemoval);
      const wrongRemovalProgram = ts.createProgram([wrongFile], {
        target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext, noEmit: true,
      });
      expect(await validateRefinementActionBodiesInProgramWithZ3(wrongRemovalProgram, wrongFile, "persistedEpochs", temporal)).toContainEqual(
        expect.objectContaining({ code: "action-update-mismatch", modelName: "removePrimary", target: "epochs" }),
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("proves nested Node Lease boundaries and an epoch transition", async () => {
    const fileName = "examples/dogfood/lease-projection.ts";
    const source = readFileSync(fileName, "utf8");
    const temporal = parseSpec(fileName, source).temporal;
    const program = ts.createProgram([fileName], {
      target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext, noEmit: true,
    });
    expect(validateRefinementBindingCoverage(fileName, source, "leaseProjection", temporal)).toEqual([]);
    expect(await validateRefinementActionBodiesWithZ3(fileName, source, "leaseProjection", temporal)).toEqual([]);
    expect(validateRefinementStateProjectionInProgram(program, fileName, "leaseProjection", temporal)).toEqual([]);

    const broken = source.replace("return snapshotLease(runtime);", "return { lease: { owner: runtime.lease.owner, epoch: runtime.lease.epoch } };");
    expect(validateRefinementStateProjection(fileName, broken, "leaseProjection", temporal)).toContainEqual(
      expect.objectContaining({ code: "observe-state-mismatch", field: "lease" }),
    );
    const wrongTransition = source.replace("epoch: runtime.lease.epoch + 1,", "owner: runtime.lease.owner + 1,");
    expect(await validateRefinementActionBodiesWithZ3(fileName, wrongTransition, "leaseProjection", temporal)).toContainEqual(
      expect.objectContaining({ code: "action-update-mismatch", modelName: "renew", target: "lease" }),
    );
    const incompleteTakeover = source.replace(
      "  runtime.lease.owner++;\n  runtime.lease.epoch++;\n}",
      "  runtime.lease.owner++;\n}",
    );
    expect(await validateRefinementActionBodiesWithZ3(fileName, incompleteTakeover, "leaseProjection", temporal)).toContainEqual(
      expect.objectContaining({ code: "action-update-mismatch", modelName: "takeover", target: "lease" }),
    );
  });

  it("distinguishes retry-loop resource generations before cleanup", () => {
    const fileName = "examples/dogfood/retry-attempts.ts";
    const result = analyzeAsyncSafety(fileName, readFileSync(fileName, "utf8"));
    expect(result.diagnostics).toEqual([]);
    const quint = generateUnifiedAsyncQuint("retry_attempts", result, "flushWithRetry");
    expect(quint).toMatch(/action acquire_attempt = all \{[\s\S]*?generation_0' = generation_0 \+ 1,/);
    expect(quint).toMatch(/action dispose_resume_attempt_handler_loop = all \{[\s\S]*?disposed_generation_0' = generation_0,/);
    expect(quint).toContain("disposed_generation_0 == generation_0");

    const brokenFile = "examples/dogfood/retry-attempt-escape.ts";
    const slotFile = "examples/dogfood/retry-slots.ts";
    const brokenProgram = ts.createProgram([slotFile, brokenFile], {
      target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      lib: ["lib.esnext.d.ts", "lib.esnext.disposable.d.ts"], types: ["node"], noEmit: true,
    });
    const broken = analyzeAsyncSafetyInProgram(brokenProgram, brokenProgram.getSourceFile(brokenFile)!);
    expect(broken.resourceAliases).toContainEqual(expect.objectContaining({
      owner: "brokenRetry", resource: "attempt", alias: "forwardedState.active[attemptSlot]",
      generation: expect.objectContaining({ acquisitionIndex: 0, repeated: true }),
    }));
    expect(broken.resourceAliases.find((alias) => alias.owner === "brokenRetry")?.generation.snapshot)
      .toMatch(/^generation_0@\d+$/);
    const brokenAliasQuint = generateUnifiedAsyncQuint("broken_retry_alias", broken, "brokenRetry");
    expect(brokenAliasQuint).toContain("var alias_generation_0: int");
    expect(brokenAliasQuint).toMatch(/action capture_alias_0 = all \{[\s\S]*?alias_generation_0' = generation_0,/);
    expect(brokenAliasQuint).toMatch(/action use_disposed_alias_0 = all \{[\s\S]*?disposed_generation_0 == alias_generation_0,/);
    const aliasAcquirePc = /action acquire_attempt = all \{\s*pc == (-?\d+),/.exec(brokenAliasQuint)?.[1];
    const aliasRepeatPc = /action alias_loop_0_repeat = all \{[\s\S]*?pc' = (-?\d+),/.exec(brokenAliasQuint)?.[1];
    expect(aliasRepeatPc).toBe(aliasAcquirePc);
    expect(brokenAliasQuint).toContain("action alias_loop_0_exit");
    const conditionalAliases = broken.resourceAliases.filter((alias) => alias.owner === "brokenConditionalRetry");
    expect(conditionalAliases).toHaveLength(2);
    expect(conditionalAliases[0]?.generation.controlPaths[0]?.[0]).toMatchObject({ expected: true });
    expect(conditionalAliases[1]?.generation.controlPaths[0]?.[0]).toMatchObject({
      id: conditionalAliases[0]?.generation.controlPaths[0]?.[0]?.id,
      expected: false,
    });
    const conditionalQuint = generateUnifiedAsyncQuint("broken_conditional_retry", broken, "brokenConditionalRetry");
    const firstCapture = /action capture_alias_0 = all \{([^}]*)\}/.exec(conditionalQuint)?.[1] ?? "";
    const latestCapture = /action capture_alias_1 = all \{([^}]*)\}/.exec(conditionalQuint)?.[1] ?? "";
    const branch = /branch_(\d+) == 1,/.exec(firstCapture)?.[1];
    expect(branch).toBeDefined();
    expect(latestCapture).toContain(`branch_${branch} == 0,`);
    const tryAliases = broken.resourceAliases.filter((alias) => alias.owner === "brokenTryRetry");
    expect(tryAliases).toHaveLength(2);
    expect(tryAliases[0]?.generation.controlPaths[0]?.[0]).toMatchObject({ expected: true });
    expect(tryAliases[1]?.generation.controlPaths[0]?.[0]).toMatchObject({
      id: tryAliases[0]?.generation.controlPaths[0]?.[0]?.id,
      expected: false,
    });
    const getterAliases = broken.resourceAliases.filter((alias) => alias.owner === "brokenGetterRetry");
    expect(getterAliases).toHaveLength(2);
    expect(getterAliases[0]?.generation.controlPaths[0]?.[0]).toMatchObject({ expected: true });
    expect(getterAliases[1]?.generation.controlPaths[0]?.[0]).toMatchObject({
      id: getterAliases[0]?.generation.controlPaths[0]?.[0]?.id,
      expected: false,
    });
    const proxyAliases = broken.resourceAliases.filter((alias) => alias.owner === "brokenProxyRetry");
    expect(proxyAliases).toHaveLength(2);
    expect(proxyAliases[0]?.generation.controlPaths[0]?.[0]).toMatchObject({ expected: true });
    expect(proxyAliases[1]?.generation.controlPaths[0]?.[0]).toMatchObject({
      id: proxyAliases[0]?.generation.controlPaths[0]?.[0]?.id,
      expected: false,
    });
    expect(broken.diagnostics).toContainEqual(expect.objectContaining({
      functionName: "brokenRetry", kind: "disposed-resource-use", severity: "error",
    }));
    expect(broken.resourceEscapes).toContainEqual(expect.objectContaining({
      owner: "brokenAttemptFactory", resource: "attempt", via: "return",
    }));
    expect(broken.diagnostics).toContainEqual(expect.objectContaining({
      functionName: "brokenAttemptFactory", kind: "disposed-resource-escape", severity: "error",
    }));
    expect(broken.resourceEscapes).toContainEqual(expect.objectContaining({
      owner: "brokenDeferredAttempt", resource: "attempt", via: "returned-closure",
    }));
    expect(broken.diagnostics).toContainEqual(expect.objectContaining({
      functionName: "brokenDeferredAttempt", kind: "disposed-resource-escape", severity: "error",
    }));
    expect(broken.resourceEscapes).toContainEqual(expect.objectContaining({
      owner: "brokenRegisteredAttempt", resource: "attempt", via: "retaining-call",
    }));
    expect(broken.diagnostics).toContainEqual(expect.objectContaining({
      functionName: "brokenRegisteredAttempt", kind: "disposed-resource-escape", severity: "error",
    }));
    expect(broken.resourceEscapes).toContainEqual(expect.objectContaining({
      owner: "brokenQueuedAttempt", resource: "attempt", via: "retaining-call",
    }));
    expect(broken.diagnostics).toContainEqual(expect.objectContaining({
      functionName: "brokenQueuedAttempt", kind: "disposed-resource-escape", severity: "error",
    }));
    expect(broken.resourceEscapes).toContainEqual(expect.objectContaining({
      owner: "brokenConditionalAttempt", resource: "attempt", via: "retaining-call",
    }));
    expect(broken.resourceEscapes).not.toContainEqual(expect.objectContaining({ owner: "safeDisabledAttempt" }));
    expect(broken.diagnostics).not.toContainEqual(expect.objectContaining({
      functionName: "safeClearedAttempt", kind: "disposed-resource-use",
    }));
    expect(broken.diagnostics).not.toContainEqual(expect.objectContaining({
      functionName: "safeFinallyClearedAttempt", kind: "disposed-resource-use",
    }));
    expect(broken.diagnostics).toContainEqual(expect.objectContaining({
      functionName: "brokenCatchOnlyCleanup", kind: "disposed-resource-use", severity: "error",
    }));
  });

  it("derives executable aligned shard and finite deployment boundaries from realistic contracts", async () => {
    const fileName = "examples/dogfood/shard-batch.ts";
    const result = generateUneffectPropertyTests({ files: { [fileName]: readFileSync(fileName, "utf8") } });
    expect(result.diagnostics).toEqual([]);
    expect(result.boundaries.find((boundary) => boundary.functionName === "shardBatch")?.generatorHints).toEqual([[0, 16, 1008]]);
    expect(result.boundaries.find((boundary) => boundary.functionName === "tenantShard")?.generatorHints).toEqual([[0, 16, 100, 116]]);
    expect(result.boundaries.find((boundary) => boundary.functionName === "partitionRoute")?.generatorHints).toEqual([[9, 21, 249]]);
    expect(result.boundaries.find((boundary) => boundary.functionName === "signedPartitionRoute")?.generatorHints).toEqual([[-45, -9, -3]]);
    expect(result.generatedFiles["examples/dogfood/shard-batch.uneffect.test.ts"]).toContain("const refinementValues = [[0,16,1008]]");
    const solved = await generateUneffectPropertyTestsWithZ3({ files: { [fileName]: readFileSync(fileName, "utf8") } });
    expect(solved.solverDiagnostics).toEqual([]);
    expect(solved.boundaries.find((boundary) => boundary.functionName === "supportedReplicaCount")?.generatorTuples)
      .toEqual([
        [4, false, "local"], [4, true, "edge"], [4, true, "local"],
        [9, true, "edge"], [9, true, "local"],
      ]);
    const rolloutValues = solved.boundaries.find((boundary) => boundary.functionName === "rolloutFloor")
      ?.generatorTuples.map(([value]) => value) ?? [];
    expect(rolloutValues).toContainEqual({});
    expect(rolloutValues).toContainEqual({ rollout: { maxReplicas: 9 } });
    expect(rolloutValues.some((value) => value !== null && typeof value === "object" && !Array.isArray(value)
      && value.rollout !== null && typeof value.rollout === "object" && !Array.isArray(value.rollout)
      && Number(value.rollout.minReplicas) >= 4 && value.rollout.maxReplicas === 9)).toBe(true);
  });

  it("proves that every telemetry attempt has exactly one outcome", async () => {
    const fileName = "examples/dogfood/telemetry-accounting.ts";
    const source = readFileSync(fileName, "utf8");
    const temporal = parseSpec(fileName, source).temporal;
    const diagnostics = await lintTemporalReachabilityWithZ3(temporal, {
      maxSteps: 2,
      synthesizeRelationalStrengtheningProperties: true,
    });
    expect(diagnostics).toContainEqual(expect.objectContaining({
      code: "strengthened-unreachable-action",
      name: "observeLostOutcome",
      relatedName: "<synth:accepted + dropped === attempted>",
    }));

    const broken = parseSpec(fileName, source.replace(
      "action drop: dropped' = dropped + 1, attempted' = attempted + 1",
      "action drop: attempted' = attempted + 1",
    )).temporal;
    const brokenDiagnostics = await lintTemporalReachabilityWithZ3(broken, {
      maxSteps: 2,
      synthesizeRelationalStrengtheningProperties: true,
    });
    expect(brokenDiagnostics).not.toContainEqual(expect.objectContaining({
      code: "strengthened-unreachable-action",
      name: "observeLostOutcome",
      relatedName: "<synth:accepted + dropped === attempted>",
    }));
  });

  it("models realtime request completion as a non-vacuous response property", async () => {
    const fileName = "examples/realtime.ts";
    const temporal = parseSpec(fileName, readFileSync(fileName, "utf8")).temporal;
    const diagnostics = await lintTemporalReachabilityWithZ3(temporal, { maxSteps: 3 });
    const semanticDiagnostics = await lintTemporalSpecWithZ3(temporal);
    expect(temporal.responses).toContainEqual(expect.objectContaining({
      name: "requestCompletes", trigger: "pending", response: "!pending",
    }));
    expect(temporal.recurrences).toContainEqual(expect.objectContaining({
      name: "returnsIdle", expression: "!pending",
    }));
    expect(diagnostics).not.toContainEqual(expect.objectContaining({ code: "initially-vacuous-liveness", name: "requestCompletes" }));
    expect(diagnostics).not.toContainEqual(expect.objectContaining({ code: "reachable-response-cycle", name: "requestCompletes" }));
    expect(diagnostics).not.toContainEqual(expect.objectContaining({ code: "bounded-unreachable-response-trigger", name: "requestCompletes" }));
    expect(diagnostics).not.toContainEqual(expect.objectContaining({ code: "reachable-recurrence-cycle", name: "returnsIdle" }));
    expect(diagnostics).not.toContainEqual(expect.objectContaining({ code: "bounded-unreachable-recurrence-target", name: "returnsIdle" }));
    expect(semanticDiagnostics).not.toContainEqual(expect.objectContaining({ code: "unsatisfiable-response-trigger", name: "requestCompletes" }));
    expect(semanticDiagnostics).not.toContainEqual(expect.objectContaining({ code: "statewise-vacuous-response", name: "requestCompletes" }));
    expect(semanticDiagnostics).not.toContainEqual(expect.objectContaining({ code: "statewise-vacuous-recurrence", name: "returnsIdle" }));
    expect(generateQuint("realtime_dogfood", temporal)).toContain("temporal requestCompletes = pending leadsTo not(pending)");
    expect(generateQuint("realtime_dogfood", temporal)).toContain("temporal returnsIdle = always(eventually(not(pending)))");
  });

  it("requires shutdown work to become and remain drained", async () => {
    const fileName = "examples/dogfood/shutdown-drain.ts";
    const source = readFileSync(fileName, "utf8");
    const temporal = parseSpec(fileName, source).temporal;
    const diagnostics = await lintTemporalReachabilityWithZ3(temporal, { maxSteps: 4 });
    expect(temporal.stabilizations).toContainEqual(expect.objectContaining({
      name: "remainsDrained", expression: "!shuttingDown || pending === 0",
    }));
    expect(diagnostics).not.toContainEqual(expect.objectContaining({
      code: "reachable-stabilization-cycle", name: "remainsDrained",
    }));
    expect(diagnostics).not.toContainEqual(expect.objectContaining({
      code: "bounded-unreachable-stabilization-target", name: "remainsDrained",
    }));

    const unfair = parseSpec(fileName, source.replace(" * action_fair complete: weak\n", "")).temporal;
    await expect(lintTemporalReachabilityWithZ3(unfair, { maxSteps: 4 })).resolves.toContainEqual(
      expect.objectContaining({ code: "reachable-stabilization-cycle", name: "remainsDrained" }),
    );
  });

  it("proves telemetry routing accounting and rejects basic control-flow regressions", async () => {
    const { fileName, source, temporal } = telemetryRoutingFixture();
    const program = ts.createProgram([fileName], {
      target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext, types: ["node"], noEmit: true,
    });
    expect(validateRefinementBindingCoverage(fileName, source, "telemetryRouting", temporal)).toEqual([]);
    expect(await validateRefinementActionBodiesWithZ3(fileName, source, "telemetryRouting", temporal)).toEqual([]);
    expect(await validateRefinementInvariantBodiesInProgramWithZ3(program, fileName, "telemetryRouting", temporal)).toEqual([]);
    expect(validateRefinementStateProjection(fileName, source, "telemetryRouting", temporal)).toEqual([]);
    const mutableMethodReceiver = source.replace("const accounting = runtime;", "let accounting = runtime;");
    expect(await validateRefinementActionBodiesWithZ3(fileName, mutableMethodReceiver, "telemetryRouting", temporal)).toContainEqual(
      expect.objectContaining({ code: "unsupported-action-body", modelName: "buffer" }),
    );
    const missingFinallyUpdate = source.replace("runtime.attempted += 1;", "// missing attempted update");
    expect(await validateRefinementActionBodiesWithZ3(fileName, missingFinallyUpdate, "telemetryRouting", temporal)).toContainEqual(
      expect.objectContaining({ code: "action-update-mismatch", modelName: "deliver", target: "attempted" }),
    );
    const missingFinallyReturn = source.replace("if (runtime.auditArmed) return;", "void runtime.auditArmed;");
    expect(await validateRefinementActionBodiesWithZ3(fileName, missingFinallyReturn, "telemetryRouting", temporal)).toContainEqual(
      expect.objectContaining({ code: "unsupported-action-body", modelName: "deliver" }),
    );
    const missingOverrideReturn = source.replace("    return;\n  }\n  runtime.postProcessed += 1;\n}\n\n/* uneffect: refinement telemetryRouting@1 action buffer */", "    // missing finally return\n  }\n  runtime.postProcessed += 1;\n}\n\n/* uneffect: refinement telemetryRouting@1 action buffer */");
    expect(await validateRefinementActionBodiesWithZ3(fileName, missingOverrideReturn, "telemetryRouting", temporal)).toContainEqual(
      expect.objectContaining({ code: "action-update-mismatch", modelName: "drop", target: "postProcessed" }),
    );
    const missingEarlyReturn = source.replace(
      "export function nestedPostProcessTelemetry(runtime: TelemetryRoutingAccounting): void {\n  if (runtime.attempted > 0) {\n    if (runtime.auditArmed) return;",
      "export function nestedPostProcessTelemetry(runtime: TelemetryRoutingAccounting): void {\n  if (runtime.attempted > 0) {\n    // missing nested return",
    );
    expect(await validateRefinementActionBodiesWithZ3(fileName, missingEarlyReturn, "telemetryRouting", temporal)).toContainEqual(
      expect.objectContaining({ code: "action-update-mismatch", modelName: "nestedPostProcess", target: "postProcessed" }),
    );
  });

  it("rejects telemetry routing throw and catch regressions", async () => {
    const { fileName, source, temporal } = telemetryRoutingFixture();
    const effectfulThrow = source.replace("throw runtime.auditArmed;", "throw makeTelemetryError(runtime);");
    expect(await validateRefinementActionBodiesWithZ3(fileName, effectfulThrow, "telemetryRouting", temporal)).toContainEqual(
      expect.objectContaining({ code: "unsupported-action-body", modelName: "reject" }),
    );
    const invertedFailurePath = source.replace("if (runtime.auditArmed) throw", "if (!runtime.auditArmed) throw");
    expect(await validateRefinementActionBodiesWithZ3(fileName, invertedFailurePath, "telemetryRouting", temporal)).toContainEqual(
      expect.objectContaining({ code: "action-update-mismatch", modelName: "reject" }),
    );
    const missingNestedThrow = source.replace('      if (runtime.attempted > 0) throw "nested telemetry rejection";\n', "      // missing nested throw\n");
    expect(await validateRefinementActionBodiesWithZ3(fileName, missingNestedThrow, "telemetryRouting", temporal)).toContainEqual(
      expect.objectContaining({ code: "action-update-mismatch", modelName: "nestedReject", target: "postProcessed" }),
    );
    const missingHeterogeneousReturn = source.replace("      return;\n    }\n    throw \"telemetry not armed\";", "      // missing heterogeneous return\n    }\n    throw \"telemetry not armed\";");
    expect(await validateRefinementActionBodiesWithZ3(fileName, missingHeterogeneousReturn, "telemetryRouting", temporal)).toContainEqual(
      expect.objectContaining({ code: "action-update-mismatch", modelName: "returnOrReject", target: "postProcessed" }),
    );
    const missingCaughtContinuation = source.replace("  runtime.recovered += 1;", "  // missing caught-path continuation");
    expect(await validateRefinementActionBodiesWithZ3(fileName, missingCaughtContinuation, "telemetryRouting", temporal)).toContainEqual(
      expect.objectContaining({ code: "action-update-mismatch", modelName: "returnOrReject", target: "recovered" }),
    );
    const missingCatchReturn = source.replace(
      "export function recoverOrStopTelemetry(runtime: TelemetryRoutingAccounting): void {\n  try {\n    throw \"telemetry recovery required\";\n  } catch {\n    if (runtime.auditArmed) return;",
      "export function recoverOrStopTelemetry(runtime: TelemetryRoutingAccounting): void {\n  try {\n    throw \"telemetry recovery required\";\n  } catch {\n    // missing catch return",
    );
    expect(await validateRefinementActionBodiesWithZ3(fileName, missingCatchReturn, "telemetryRouting", temporal)).toContainEqual(
      expect.objectContaining({ code: "action-update-mismatch", modelName: "recoverOrStop", target: "recovered" }),
    );
    const missingCatchRethrow = source.replace('    if (runtime.auditArmed) throw "telemetry recovery rejected";', "    // missing catch rethrow");
    expect(await validateRefinementActionBodiesWithZ3(fileName, missingCatchRethrow, "telemetryRouting", temporal)).toContainEqual(
      expect.objectContaining({ code: "action-update-mismatch", modelName: "recoverOrRethrow", target: "recovered" }),
    );
    const effectfulCatchRethrow = source.replace('throw "telemetry recovery rejected";', 'throw new Error("telemetry recovery rejected");');
    expect(await validateRefinementActionBodiesWithZ3(fileName, effectfulCatchRethrow, "telemetryRouting", temporal)).toContainEqual(
      expect.objectContaining({ code: "unsupported-action-body", modelName: "recoverOrRethrow" }),
    );
  });

  it("rejects telemetry routing finally and switch regressions", async () => {
    const { fileName, source, temporal } = telemetryRoutingFixture();
    const missingFinallyOverride = source.replace("      return;\n    }\n    if (runtime.attempted < 0) throw \"telemetry cleanup failed\";", "      // missing finally override\n    }\n    if (runtime.attempted < 0) throw \"telemetry cleanup failed\";");
    expect(await validateRefinementActionBodiesWithZ3(fileName, missingFinallyOverride, "telemetryRouting", temporal)).toContainEqual(
      expect.objectContaining({ code: "action-update-mismatch", modelName: "finalizeRecovery", target: "finalized" }),
    );
    const missingFinallyThrow = source.replace('    if (runtime.attempted < 0) throw "telemetry cleanup failed";', "    // missing finally throw");
    expect(await validateRefinementActionBodiesWithZ3(fileName, missingFinallyThrow, "telemetryRouting", temporal)).toContainEqual(
      expect.objectContaining({ code: "action-update-mismatch", modelName: "finalizeRecovery", target: "finalized" }),
    );
    const effectfulFinallyThrow = source.replace('throw "telemetry cleanup failed";', 'throw new Error("telemetry cleanup failed");');
    expect(await validateRefinementActionBodiesWithZ3(fileName, effectfulFinallyThrow, "telemetryRouting", temporal)).toContainEqual(
      expect.objectContaining({ code: "unsupported-action-body", modelName: "finalizeRecovery" }),
    );
    const missingSwitchReturn = source.replace("        return runtime.recovered;", "        break;");
    expect(await validateRefinementActionBodiesWithZ3(fileName, missingSwitchReturn, "telemetryRouting", temporal)).toContainEqual(
      expect.objectContaining({ code: "action-update-mismatch", modelName: "routeRecovery", target: "postProcessed" }),
    );
    const effectfulSwitchReturn = source.replace("return runtime.recovered;", "return computeRecovery(runtime);");
    expect(await validateRefinementActionBodiesWithZ3(fileName, effectfulSwitchReturn, "telemetryRouting", temporal)).toContainEqual(
      expect.objectContaining({ code: "unsupported-action-body", modelName: "routeRecovery" }),
    );
    const missingSwitchThrow = source.replace("        throw runtime.recovered;", "        break;");
    expect(await validateRefinementActionBodiesWithZ3(fileName, missingSwitchThrow, "telemetryRouting", temporal)).toContainEqual(
      expect.objectContaining({ code: "action-update-mismatch", modelName: "routeRecovery", target: "dropped" }),
    );
    const effectfulSwitchThrow = source.replace("throw runtime.recovered;", 'throw new Error("telemetry recovery failed")');
    expect(await validateRefinementActionBodiesWithZ3(fileName, effectfulSwitchThrow, "telemetryRouting", temporal)).toContainEqual(
      expect.objectContaining({ code: "unsupported-action-body", modelName: "routeRecovery" }),
    );
  });

  it("proves telemetry routing conservation and rejects an unbalanced action", async () => {
    const { fileName, source, temporal } = telemetryRoutingFixture();
    const inheritedEvidenceDirectory = process.env.UNEFFECT_SOLVER_EVIDENCE_DIR;
    const evidenceDirectory = inheritedEvidenceDirectory ?? mkdtempSync(join(tmpdir(), "uneffect-routing-solver-budget-"));
    try {
      const diagnostics = await lintTemporalReachabilityWithZ3(temporal, {
        maxSteps: 2,
        synthesizeRelationalStrengtheningProperties: true,
        relationalStrengtheningMaxArity: 4,
        z3: { evidence: { directory: evidenceDirectory, source: fileName, obligation: "routing conservation" } },
      });
      expect(diagnostics).toContainEqual(expect.objectContaining({
        code: "strengthened-unreachable-action",
        name: "observeLostOutcome",
        relatedName: "<synth:delivered + dropped + buffered === attempted>",
      }));
      expect(globSync(join(evidenceDirectory, "*.jsonl")).length).toBeLessThanOrEqual(32);
    } finally {
      if (!inheritedEvidenceDirectory) rmSync(evidenceDirectory, { recursive: true, force: true });
    }

    const broken = parseSpec(fileName, source.replace(
      "action buffer: buffered' = buffered + 1, attempted' = attempted + 1",
      "action buffer: attempted' = attempted + 1",
    )).temporal;
    const brokenDiagnostics = await lintTemporalReachabilityWithZ3(broken, {
      maxSteps: 2,
      synthesizeRelationalStrengtheningProperties: true,
      relationalStrengtheningMaxArity: 4,
    });
    expect(brokenDiagnostics).not.toContainEqual(expect.objectContaining({
      code: "strengthened-unreachable-action",
      relatedName: "<synth:delivered + dropped + buffered === attempted>",
    }));
  });

  it("refines nested telemetry batches with outer continue and mandatory finalization", async () => {
    const fileName = "examples/dogfood/nested-telemetry-scan.ts";
    const source = readFileSync(fileName, "utf8");
    const temporal = parseSpec(fileName, source).temporal;

    await expect(validateRefinementActionBodiesWithZ3(
      fileName, source, "nestedTelemetryScan", temporal,
    )).resolves.toEqual([]);

    const wrongOwner = source.replace("continue batch", "continue missing");
    await expect(validateRefinementActionBodiesWithZ3(
      fileName, wrongOwner, "nestedTelemetryScan", temporal,
    )).resolves.toContainEqual(expect.objectContaining({
      code: "unsupported-action-body", modelName: "flush",
    }));

    const missingAudit = source.replace("    runtime.audited++;", "    // missing audit");
    await expect(validateRefinementActionBodiesWithZ3(
      fileName, missingAudit, "nestedTelemetryScan", temporal,
    )).resolves.toContainEqual(expect.objectContaining({
      code: "action-update-mismatch", modelName: "flush", target: "audited",
    }));
  });

  it("proves an imported runtime class method through its immutable receiver alias", async () => {
    const fileName = "examples/dogfood/imported-runtime-refinement.ts";
    const runtimeFile = "examples/dogfood/imported-telemetry-runtime.ts";
    const source = readFileSync(fileName, "utf8");
    const runtimeSource = readFileSync(runtimeFile, "utf8");
    const temporal = parseSpec(fileName, source).temporal;
    const compilerOptions: ts.CompilerOptions = {
      target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext, types: ["node"], noEmit: true,
    };
    const program = ts.createProgram([fileName, runtimeFile], compilerOptions);
    expect(await validateRefinementActionBodiesInProgramWithZ3(program, fileName, "importedTelemetry", temporal)).toEqual([]);
    expect(await validateRefinementInvariantBodiesInProgramWithZ3(program, fileName, "importedTelemetry", temporal)).toEqual([]);
    expect(validateRefinementStateProjectionInProgram(program, fileName, "importedTelemetry", temporal)).toEqual([]);
    const audit = await verifyUneffectProject({
      files: { [fileName]: source, [runtimeFile]: runtimeSource },
      assumptionPolicy: { requireOwner: true, requireExpiration: true, denyExpired: true, asOf: "2026-08-26" },
    });
    expect(audit.assumptions.entries).toContainEqual(expect.objectContaining({
      domain: "dispatch-sealing", owner: "telemetry-platform", expiresOn: "2027-08-31",
    }));
    expect(audit.assumptions.violations).toEqual([]);

    const directory = mkdtempSync(join(tmpdir(), "uneffect-imported-runtime-dogfood-"));
    try {
      const wrongFile = join(directory, "imported-runtime-refinement.ts");
      const wrongRuntimeFile = join(directory, "imported-telemetry-runtime.ts");
      writeFileSync(wrongFile, source);
      writeFileSync(wrongRuntimeFile, runtimeSource.replace("this.attempted += 1;", "this.attempted += 2;"));
      const wrongProgram = ts.createProgram([wrongFile, wrongRuntimeFile], compilerOptions);
      expect(await validateRefinementActionBodiesInProgramWithZ3(wrongProgram, wrongFile, "importedTelemetry", temporal)).toContainEqual(
        expect.objectContaining({ code: "action-update-mismatch", modelName: "record", target: "attempted" }),
      );
      writeFileSync(wrongRuntimeFile, `${runtimeSource}\nexport class DerivedTelemetryRuntime extends ImportedTelemetryRuntime { record(): void { this.attempted += 2; this.sent += 2 } }\n`);
      const subclassProgram = ts.createProgram([wrongFile, wrongRuntimeFile], compilerOptions);
      expect(await validateRefinementActionBodiesInProgramWithZ3(subclassProgram, wrongFile, "importedTelemetry", temporal)).toContainEqual(
        expect.objectContaining({ code: "unsupported-action-body", modelName: "record" }),
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("proves a scaled telemetry capacity relation and catches unbalanced accounting", async () => {
    const fileName = "examples/dogfood/telemetry-capacity.ts";
    const source = readFileSync(fileName, "utf8");
    const temporal = parseSpec(fileName, source).temporal;
    const diagnostics = await lintTemporalReachabilityWithZ3(temporal, {
      maxSteps: 2,
      synthesizeRelationalStrengtheningProperties: true,
      relationalStrengtheningMaxCoefficient: 3,
    });
    expect(diagnostics).toContainEqual(expect.objectContaining({
      code: "strengthened-unreachable-action",
      name: "observeOverCapacity",
      relatedName: "<synth:3 * accepted === byteBudget>",
    }));

    const brokenSource = source.replaceAll("byteBudget + 3", "byteBudget + 1").replaceAll("byteBudget += 3", "byteBudget += 1");
    const broken = parseSpec(fileName, brokenSource).temporal;
    const brokenDiagnostics = await lintTemporalReachabilityWithZ3(broken, {
      maxSteps: 2,
      synthesizeRelationalStrengtheningProperties: true,
      relationalStrengtheningMaxCoefficient: 3,
    });
    expect(brokenDiagnostics).not.toContainEqual(expect.objectContaining({
      code: "strengthened-unreachable-action",
      relatedName: "<synth:3 * accepted === byteBudget>",
    }));
    await expect(findTemporalCounterexampleWithZ3(broken, "withinCapacity", { maxSteps: 1 }))
      .resolves.toMatchObject({ status: "counterexample", depth: 1 });
  });

  it("proves a two-counter telemetry quota conservation law", async () => {
    const fileName = "examples/dogfood/telemetry-quota.ts";
    const source = readFileSync(fileName, "utf8");
    const temporal = parseSpec(fileName, source).temporal;
    const diagnostics = await lintTemporalReachabilityWithZ3(temporal, {
      maxSteps: 2,
      synthesizeRelationalStrengtheningProperties: true,
    });
    expect(diagnostics).toContainEqual(expect.objectContaining({
      code: "strengthened-unreachable-action",
      name: "observeQuotaDrift",
      relatedName: "<synth:sent + remaining === 100>",
    }));

    const broken = parseSpec(fileName, source.replaceAll("remaining' = remaining - 1", "remaining' = remaining").replaceAll("this.remaining -= 1", "this.remaining += 0")).temporal;
    const brokenDiagnostics = await lintTemporalReachabilityWithZ3(broken, {
      maxSteps: 2,
      synthesizeRelationalStrengtheningProperties: true,
    });
    expect(brokenDiagnostics).not.toContainEqual(expect.objectContaining({
      code: "strengthened-unreachable-action",
      relatedName: "<synth:sent + remaining === 100>",
    }));
    await expect(findTemporalCounterexampleWithZ3(broken, "quotaConserved", { maxSteps: 1 }))
      .resolves.toMatchObject({ status: "counterexample", depth: 1 });
  });

  it("proves weighted telemetry accounting and catches a missing cost update", async () => {
    const fileName = "examples/dogfood/telemetry-weighted-accounting.ts";
    const source = readFileSync(fileName, "utf8");
    const temporal = parseSpec(fileName, source).temporal;
    const diagnostics = await lintTemporalReachabilityWithZ3(temporal, {
      maxSteps: 2,
      synthesizeRelationalStrengtheningProperties: true,
    });
    expect(diagnostics).toContainEqual(expect.objectContaining({
      code: "strengthened-unreachable-action",
      name: "observeAccountingDrift",
      relatedName: "<synth:2 * accepted + rejected === attemptedCost>",
    }));

    const broken = parseSpec(fileName, source.replace(
      "action accept: accepted' = accepted + 1, attemptedCost' = attemptedCost + 2",
      "action accept: accepted' = accepted + 1",
    )).temporal;
    const brokenDiagnostics = await lintTemporalReachabilityWithZ3(broken, {
      maxSteps: 2,
      synthesizeRelationalStrengtheningProperties: true,
    });
    expect(brokenDiagnostics).not.toContainEqual(expect.objectContaining({
      code: "strengthened-unreachable-action",
      name: "observeAccountingDrift",
    }));
    await expect(findTemporalCounterexampleWithZ3(broken, "accountingConserved", { maxSteps: 1 }))
      .resolves.toMatchObject({ status: "counterexample", depth: 1 });
  });

  it("proves a request pool fixed budget and catches capacity inflation", async () => {
    const fileName = "examples/dogfood/request-capacity.ts";
    const source = readFileSync(fileName, "utf8");
    const temporal = parseSpec(fileName, source).temporal;
    const diagnostics = await lintTemporalReachabilityWithZ3(temporal, {
      maxSteps: 2,
      synthesizeRelationalStrengtheningProperties: true,
    });
    expect(diagnostics).toContainEqual(expect.objectContaining({
      code: "strengthened-unreachable-action",
      name: "observeCapacityDrift",
      relatedName: "<synth:active + queued + remaining === 100>",
    }));

    const broken = parseSpec(fileName, source.replace(
      "action enqueue: queued' = queued + 1, remaining' = remaining - 1",
      "action enqueue: queued' = queued + 1",
    )).temporal;
    const brokenDiagnostics = await lintTemporalReachabilityWithZ3(broken, {
      maxSteps: 2,
      synthesizeRelationalStrengtheningProperties: true,
    });
    expect(brokenDiagnostics).not.toContainEqual(expect.objectContaining({
      code: "strengthened-unreachable-action",
      name: "observeCapacityDrift",
    }));
    await expect(findTemporalCounterexampleWithZ3(broken, "capacityConserved", { maxSteps: 1 }))
      .resolves.toMatchObject({ status: "counterexample", depth: 1 });
  });

  it("verifies a Node callback-checkpoint application model through the project API", async () => {
    const source = `
        import { nextTick } from "node:process"
        import { readFile } from "node:fs"
        function flushSuccess() { queueMicrotask(() => console.log("flushed")) }
        function flushFailure() { nextTick(() => console.log("retry")) }
        /* uneffect: effect Throw<SyntaxError> */
        function parseSettings() { throw new SyntaxError("invalid settings") }
        async function loadSettings() { throw new SyntaxError("async settings") }
        /* uneffect: effect Console */
        function* flushSteps() { console.log("prepare flush"); yield "ready" }
        /* uneffect: effect Throw<TypeError> */
        function* failedFlushSteps() { throw new TypeError("flush unavailable") }
        declare function externalFlushSteps(): Generator<string>
        function buildFlushSteps(preferCache: boolean) {
          if (preferCache) return flushSteps()
          return failedFlushSteps()
        }
        function consumeFlushSteps(iterator: IteratorObject<unknown>) { Array.from(iterator) }
        const flushDispatcher = {
          handlers: { success: flushSuccess, failure: flushFailure } as const,
          select(outcome: "success" | "failure") { return this.handlers[outcome] },
        } as const
        /* uneffect: effect FsRead<"settings.json"> | Console | Timer | InvokeUserCode */
        export function scheduleFlush(preferCache: boolean) {
          try { parseSettings() } catch { console.warn("using defaults") }
          void loadSettings().catch(() => console.warn("async defaults"))
          buildFlushSteps(true)
          let reassignedSteps: IteratorObject<unknown> = ["fallback"].values()
          reassignedSteps = buildFlushSteps(preferCache)
          try { Array.from(reassignedSteps) } catch { console.warn("skipping reassigned steps") }
          let conditionalSteps: IteratorObject<unknown> = ["fallback"].values()
          if (!preferCache) conditionalSteps = buildFlushSteps(preferCache)
          try { Array.from(conditionalSteps) } catch { console.warn("skipping conditional steps") }
          const stepHolder: { iterator: IteratorObject<unknown> } = { iterator: ["fallback"].values() }
          const stepHolderAlias = stepHolder
          stepHolder.iterator = buildFlushSteps(preferCache)
          try { Array.from(stepHolderAlias.iterator) } catch { console.warn("skipping stored steps") }
          try { consumeFlushSteps(buildFlushSteps(preferCache)) }
          catch { console.warn("skipping generic flush consumer") }
          void Promise.all(buildFlushSteps(preferCache))
            .catch(() => console.warn("skipping async flush steps"))
          try { Array.from(buildFlushSteps(preferCache)) }
          catch { console.warn("skipping materialized flush steps") }
          try { for (const _step of buildFlushSteps(preferCache)) {} }
          catch { console.warn("skipping flush steps") }
          readFile("settings.json", "utf8", () => {
            nextTick(() => console.log("tick"))
            queueMicrotask(() => console.log("microtask"))
            setImmediate(() => console.log("check"))
            setTimeout(flushDispatcher.select(preferCache ? "success" : "failure"), 0)
          })
        }
      `;
    const verified = await verifyUneffectProject({ temporalRuntime: "node", files: { "src/node-service.ts": source } });
    expect(verified.diagnostics).toEqual([]);
    const scheduleSummary = verified.effects.summaries.find((summary) => summary.functionName === "scheduleFlush");
    expect(scheduleSummary).toMatchObject({ fileName: "src/node-service.ts", evidence: "verified", id: expect.stringMatching(/^src\/node-service\.ts:\d+$/), span: { start: expect.any(Number), end: expect.any(Number) } });
    expect(scheduleSummary?.effects.map((effect) => effect.kind === "capability" ? effect.name : effect.kind)).toEqual(expect.arrayContaining(["FsRead", "Console", "Timer"]));
    expect(verified.temporal?.models).toContainEqual(expect.objectContaining({ kind: "node-event-loop", quint: expect.stringContaining("action run_poll_0") }));
    expect(verified.temporal?.models[0]?.quint).toContain("action drain_next_tick_1");
    expect(verified.temporal?.properties).toContainEqual(expect.objectContaining({ name: "nodeEventLoopSafe", result: "verified" }));
    expect(verified.effects.summaries.find((summary) => summary.functionName === "consumeFlushSteps"))
      .toMatchObject({ evidence: "inferred", iteratorEffectParameters: [expect.objectContaining({ index: 0 })] });
    expect(verified.assurance).toMatchObject({ passed: true, blockers: [] });
    const asyncModel = analyzeAsyncPatterns("src/node-service.ts", source);
    const selectedTimer = asyncModel.timers.findIndex((timer) => timer.callback === 'flushDispatcher.select(preferCache ? "success" : "failure")');
    expect(selectedTimer).toBeGreaterThanOrEqual(0);
    expect(asyncModel.timers.filter((timer) => timer.enqueuedBy === selectedTimer).map((timer) => timer.queue).sort())
      .toEqual(["microtask", "next-tick"]);

    const broken = await verifyUneffectProject({ temporalRuntime: "node", files: { "src/node-service.ts": source.replace(' | Console', '') } });
    expect(broken.diagnostics).toContainEqual(expect.objectContaining({ functionName: "scheduleFlush", effect: "Console" }));
    const partialFactory = await verifyUneffectProject({ temporalRuntime: "node", files: {
      "src/node-service.ts": source.replace("return failedFlushSteps()", "return externalFlushSteps()"),
    } });
    expect(partialFactory.effects.summaries.find((summary) => summary.functionName === "scheduleFlush"))
      .toMatchObject({ evidence: "unknown" });
  });

  it("classifies every unknown summary while analyzing its own implementation", () => {
    const program = ts.createProgram(globSync("src/*.ts"), {
      target: ts.ScriptTarget.ES2024,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      lib: ["lib.es2024.d.ts", "lib.dom.d.ts"],
      types: ["node"],
      noEmit: true,
    });
    const result = analyzeProgramEffects(program, { requireAnnotations: false });
    expect(result.summaries.length).toBeGreaterThan(200);
    expect(result.diagnostics).toEqual([]);
    const unknown = result.summaries.filter((summary) => summary.evidence === "unknown");
    expect(unknown).toHaveLength(0);
    expect(unknown.every((summary) => (summary.unknownReasons?.length ?? 0) > 0)).toBe(true);
    expect(Object.fromEntries([...new Set(unknown.flatMap((summary) => summary.unknownReasons?.map((reason) => reason.code) ?? []))]
      .map((code) => [code, unknown.filter((summary) => summary.unknownReasons?.some((reason) => reason.code === code)).length])))
      .toEqual({});
    expect(unknown.map((summary) => summary.fileName?.split("/").at(-1)).sort())
      .toEqual([]);
  }, 20_000);

  it("analyzes the independently maintained Effect Function module without frontend drift", () => {
    const entry = "node_modules/effect/src/Function.ts";
    const program = ts.createProgram([entry], {
      target: ts.ScriptTarget.ES2024,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      lib: ["lib.es2024.d.ts", "lib.dom.d.ts"],
      types: ["node"],
      noEmit: true,
      skipLibCheck: true,
    });
    const externalSources = program.getSourceFiles().filter((source) => source.fileName.includes("/effect/src/"));
    const result = analyzeProgramEffects(program, { requireAnnotations: false });
    expect(externalSources.length).toBeGreaterThanOrEqual(3);
    expect(result.summaries.length).toBeGreaterThanOrEqual(40);
    expect(result.diagnostics).toEqual([]);
    expect(result.summaries.filter((summary) => summary.evidence === "unknown")).toEqual([
      expect.objectContaining({
        functionName: "<module>",
        unknownReasons: [expect.objectContaining({ code: "unresolved-call" })],
      }),
    ]);
    expect(auditBuiltinDeclarationDrift(program)).toEqual([]);
  }, 20_000);

  it("enforces a Console boundary on an adapter using external Effect pipe", () => {
    const entry = "examples/dogfood/effect-adapter.ts";
    const compilerOptions: ts.CompilerOptions = {
      target: ts.ScriptTarget.ES2024,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      lib: ["lib.es2024.d.ts", "lib.dom.d.ts"],
      types: ["node"],
      noEmit: true,
      skipLibCheck: true,
    };
    const program = ts.createProgram([entry], compilerOptions);
    const result = analyzeProgramEffects(program, { requireAnnotations: true });
    const main = result.summaries.find((summary) => summary.functionName === "main");
    expect(result.diagnostics).toEqual([]);
    expect(main).toMatchObject({ evidence: "verified", effects: [expect.objectContaining({ kind: "capability", name: "Console" })] });

    const host = ts.createCompilerHost(compilerOptions);
    const source = readFileSync(entry, "utf8").replace("effect Console", "effect FsRead<\"$CWD/**\">");
    const original = host.getSourceFile.bind(host);
    host.getSourceFile = (name, languageVersion, onError, fresh) => name === entry
      ? ts.createSourceFile(entry, source, languageVersion, true, ts.ScriptKind.TS)
      : original(name, languageVersion, onError, fresh);
    const broken = analyzeProgramEffects(ts.createProgram([entry], compilerOptions, host), { requireAnnotations: true });
    expect(broken.diagnostics).toContainEqual(expect.objectContaining({ kind: "missing", functionName: "main", effect: "Console" }));
  }, 20_000);

  it("verifies a Hoare contract through the external Effect pipe adapter", async () => {
    const entry = "examples/dogfood/effect-adapter.ts";
    const source = readFileSync(entry, "utf8");
    const verified = await verifyUneffectProject({ files: { [entry]: source } });
    expect(verified.diagnostics).toEqual([]);
    expect(verified.obligations).toContainEqual(expect.objectContaining({ status: "verified", evidence: "verified" }));

    const broken = await verifyUneffectProject({ files: { [entry]: source.replace("current + 1", "current - 1") } });
    expect(broken.diagnostics).toContainEqual(expect.objectContaining({ functionName: "increment", clause: "ensures" }));
    expect(broken.obligations).toContainEqual(expect.objectContaining({ status: "counterexample", evidence: "unknown" }));
  }, 20_000);

  it("checks an external Effect adapter against the Web event-loop model", async () => {
    const entry = "examples/dogfood/effect-temporal-adapter.ts";
    const source = readFileSync(entry, "utf8");
    const verified = await verifyUneffectProject({ files: { [entry]: source }, temporalRuntime: "web" });
    expect(verified.temporal).toMatchObject({
      sourceLanguage: "uneffect-ts",
      backend: "quint",
      properties: [expect.objectContaining({ name: "eventLoopSafe", result: "verified" })],
    });
    expect(verified.temporal?.models[0]?.quint).toContain("action run_timer_task_0");
    expect(verified.temporal?.models[0]?.quint).toContain("action drain_microtask_1");
  }, 30_000);

  it("prevents a telemetry callback with an at-most-once contract from being queued twice", async () => {
    const entry = "examples/dogfood/telemetry-once.ts";
    const source = readFileSync(entry, "utf8");
    const verified = await verifyUneffectProject({ files: { [entry]: source }, temporalRuntime: "web" });
    expect(verified.temporal?.properties).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "eventLoopSafe", result: "verified" }),
      expect.objectContaining({ name: "sendsAtMostOnce", result: "verified" }),
    ]));

    const duplicated = source.replace("queueMicrotask(sendTelemetry);", "queueMicrotask(sendTelemetry); queueMicrotask(sendTelemetry);");
    const broken = await verifyUneffectProject({ files: { [entry]: duplicated }, temporalRuntime: "web" });
    expect(broken.temporal?.properties).toContainEqual(expect.objectContaining({ name: "eventLoopSafe", result: "counterexample" }));
  }, 30_000);

  it("proves a DNS binary codec and catches an off-by-one field offset", async () => {
    const entry = "examples/dogfood/binary-codec.ts";
    const source = readFileSync(entry, "utf8");
    const verified = await verifyTypedArraySafety(entry, source);
    expect(verified.diagnostics).toEqual([]);
    expect(verified.statistics.solverQueries).toBe(0);
    expect(verified.obligations).toEqual(expect.arrayContaining([
      expect.objectContaining({ functionName: "createDnsHeaderView", kind: "dataview-backing-bounds", result: "verified" }),
      expect.objectContaining({ functionName: "createDnsHeaderView", kind: "max-length", result: "verified" }),
    ]));
    expect(verified.obligations.filter((item) => item.kind === "dataview-bounds")).toHaveLength(12);
    expect(verified.obligations.filter((item) => item.kind === "dataview-value")).toHaveLength(6);

    const broken = await verifyTypedArraySafety(entry, source.replace("getUint16(10, false)", "getUint16(11, false)"));
    expect(broken.diagnostics).toContainEqual(expect.objectContaining({
      functionName: "decodeDnsHeader",
      kind: "dataview-bounds",
      message: expect.stringContaining("11 + 2 <= 12"),
    }));
  });

  it("invalidates fixed-buffer constructor evidence after Worker-style transfer", async () => {
    const fileName = "examples/dogfood/worker-codec-transfer.ts";
    const source = readFileSync(fileName, "utf8");
    const result = await verifyUneffectProject({ files: { [fileName]: source } });
    expect(result.ownership.diagnostics).toContainEqual(expect.objectContaining({
      fileName, resource: "buffer", state: "detached", operation: "read",
    }));
    expect(result.typedArrays.files[fileName]?.obligations).toContainEqual(expect.objectContaining({
      functionName: "transferThenDecode", kind: "dataview-backing-bounds", result: "counterexample",
    }));
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ fileName, kind: "ownership" }),
      expect.objectContaining({ fileName, kind: "dataview-backing-bounds" }),
    ]));
    expect(result.assurance.passed).toBe(false);
    expect(result.assurance.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ domain: "ownership", fileName }),
      expect.objectContaining({ domain: "typed-array", fileName }),
    ]));
  });

  it("checks telemetry Promise ownership across delivery modes and shutdown cleanup", () => {
    const fileName = "examples/dogfood/telemetry-delivery.ts";
    const source = readFileSync(fileName, "utf8");
    const verified = analyzeAsyncSafety(fileName, source);
    expect(verified.diagnostics).toEqual([]);
    expect(verified.promiseBindings.map(({ owner, status }) => ({ owner, status }))).toEqual([
      { owner: "deliverTelemetry", status: "observed" },
      { owner: "flushTelemetryBeforeExit", status: "observed" },
      { owner: "handOffTelemetryUntilOffline", status: "transferred" },
      { owner: "deliverTelemetryAtLeastOnce", status: "observed" },
      { owner: "recoverFromTelemetryGateFailure", status: "observed" },
    ]);

    const broken = analyzeAsyncSafety(fileName, source.replace(
      "delivery.catch(() => undefined);",
      'console.warn("telemetry dropped");',
    ));
    expect(broken.diagnostics).toContainEqual(expect.objectContaining({
      functionName: "deliverTelemetry",
      kind: "floating-promise",
      message: expect.stringContaining("delivery"),
    }));

    const brokenHeader = analyzeAsyncSafety(fileName, source.replace(
      "/* uneffect: consumes_rejection 0 */",
      "/* ownership contract removed */",
    ));
    expect(brokenHeader.diagnostics).toContainEqual(expect.objectContaining({
      functionName: "handOffTelemetryUntilOffline",
      kind: "floating-promise",
      message: expect.stringContaining("delivery"),
    }));

    const brokenAtLeastOnce = analyzeAsyncSafety(fileName, source.replace(
      "    await delivery;\n    break;",
      '    console.warn("telemetry not awaited");\n    break;',
    ));
    expect(brokenAtLeastOnce.diagnostics).toContainEqual(expect.objectContaining({
      functionName: "deliverTelemetryAtLeastOnce",
      kind: "floating-promise",
      message: expect.stringContaining("delivery"),
    }));

    const brokenGate = analyzeAsyncSafety(fileName, source.replace(
      "/* uneffect: effect Throw<Error> */",
      "/* throw contract removed */",
    ));
    expect(brokenGate.diagnostics).toContainEqual(expect.objectContaining({
      functionName: "recoverFromTelemetryGateFailure",
      kind: "floating-promise",
      message: expect.stringContaining("delivery"),
    }));
  });

  it("audits trusted telemetry boundaries with owner and expiration policy", async () => {
    const fileName = "examples/dogfood/telemetry-packet.ts";
    const source = readFileSync(fileName, "utf8");
    const policy = {
      requireOwner: true,
      requireExpiration: true,
      denyExpired: true,
      allowUnboundedDomains: ["builtin" as const],
      asOf: "2026-08-21",
    };
    const verified = await verifyUneffectProject({ files: { [fileName]: source }, assumptionPolicy: policy });
    expect(verified.assumptions.entries.map(({ domain }) => domain)).toEqual(["typed-array", "builtin", "temporal-summary"]);
    expect(verified.assumptions.violations).toEqual([]);

    const ownerless = await verifyUneffectProject({
      files: { [fileName]: source.replaceAll("/* uneffect: trust_owner telemetry-platform */\n", "") },
      assumptionPolicy: policy,
    });
    expect(ownerless.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "assumption-policy", domain: "typed-array", rule: "owner-required" }),
      expect.objectContaining({ kind: "assumption-policy", domain: "temporal-summary", rule: "owner-required" }),
    ]));
  });

  it("links a wrapped legacy Promise to the operation it adopts", () => {
    const fileName = "examples/dogfood/promise-adapter.ts";
    const source = readFileSync(fileName, "utf8");
    const model = analyzePromiseChains(fileName, source);
    expect(model.executors).toEqual([
      expect.objectContaining({ binding: "operation", possibleSettlements: ["rejected"] }),
      expect.objectContaining({ binding: "exposed", possibleSettlements: ["assimilating"], adoptedExecutor: 0 }),
      expect.objectContaining({ binding: "exposed", possibleSettlements: ["assimilating"], adoptedThenable: 0 }),
      expect.objectContaining({ binding: "exposed", possibleSettlements: ["assimilating"], adoptedThenable: 2 }),
    ]);
    expect(model.thenables).toEqual([
      expect.objectContaining({ binding: "legacy", thenAccess: "callable", possibleSettlements: ["fulfilled"], firstCallWins: true }),
      expect.objectContaining({ binding: "secondary", adoptedThenable: 2, mayRemainPending: true }),
      expect.objectContaining({ binding: "primary", adoptedThenable: 1, mayRemainPending: true }),
    ]);
    const quint = generatePromiseChainsQuint("legacy_adapter", model);
    expect(quint).toContain("assimilate_1_from_0_rejected");
    expect(quint).not.toContain("assimilate_1_fulfilled");
    expect(quint).toContain("assimilate_2_thenable_0_fulfilled");
    expect(quint).not.toContain("assimilate_2_thenable_0_rejected");
    expect(model.thenables.filter((thenable) => thenable.binding === "primary" || thenable.binding === "secondary")).toHaveLength(2);
    expect(quint).toContain("settle_3_assimilating");
    expect(quint).not.toMatch(/assimilate_3.*_(fulfilled|rejected)/);
  });

  it("selects an exact legacy thenable from an immutable routing table", () => {
    const fileName = "examples/dogfood/promise-routing.ts";
    const model = analyzePromiseChains(fileName, readFileSync(fileName, "utf8"));
    expect(model.executors[0]).toMatchObject({ adoptedThenables: [0, 1] });
    expect(model.executors[0].adoptedThenable).toBeUndefined();
    expect(model.executors[1]).toMatchObject({ adoptedThenables: [3], adoptedThenable: 3 });
    expect(model.executors[2]).toMatchObject({ adoptedThenables: [4], adoptedThenable: 4 });
    expect(model.executors[3]).toMatchObject({ adoptedThenables: [5], adoptedThenable: 5 });
    expect(model.thenables[4]).toMatchObject({ binding: "upstream", provenance: "proxy", possibleSettlements: ["rejected"], mayRemainPending: false });
    expect(model.thenables[5]).toMatchObject({ binding: "guarded", provenance: "proxy", thenAccess: "throws", possibleSettlements: ["rejected"], mayRemainPending: false });
    const quint = generatePromiseChainsQuint("promise_routing", model);
    expect(quint).toContain("assimilate_0_thenable_option_0_thenable_0_fulfilled");
    expect(quint).toContain("assimilate_0_thenable_option_1_thenable_1_rejected");
    expect(quint).toContain("assimilate_1_thenable_3_rejected");
    expect(quint).toContain("assimilate_2_thenable_4_rejected");
    expect(quint).not.toContain("assimilate_2_thenable_4_fulfilled");
    expect(quint).toContain("assimilate_3_thenable_5_getter_rejected");
    expect(quint).not.toContain("assimilate_3_thenable_5_fulfilled");
  });

  it("models cached values, sparse slots, and remote thenables in one batch", () => {
    const fileName = "examples/dogfood/mixed-promise-batch.ts";
    const source = readFileSync(fileName, "utf8");
    const model = analyzeAsyncPatterns(fileName, source);
    expect(model.combinators).toEqual([
      expect.objectContaining({
        combinator: "all",
        branches: ['"cached-profile"', "<hole>", "remote"],
        branchKinds: ["value", "value", "thenable"],
        staticIterable: true,
      }),
      expect.objectContaining({
        combinator: "all",
        branches: ["remote", '"cached-profile"'],
        branchKinds: ["thenable", "value"],
        staticIterable: true,
        iteratorKind: "set",
        iteratorEffects: [],
      }),
      expect.objectContaining({
        combinator: "all",
        branches: ["remote", '"cached-profile"'],
        branchKinds: ["thenable", "value"],
        staticIterable: true,
        iteratorKind: "array",
        iteratorEffects: [],
      }),
    ]);
    const quint = generateAsyncPatternsQuint("mixed_batch", model);
    expect(quint).not.toContain("action reject_0_0");
    expect(quint).not.toContain("action reject_0_1");
    expect(quint).toContain("action assimilate_0_2");
    expect(quint).toContain("action reject_0_2");
    expect(quint).toContain("action assimilate_1_0");
    expect(quint).not.toContain("action reject_1_1");
    expect(quint).toContain("action assimilate_2_0");
    expect(quint).not.toContain("action reject_2_1");
  });

  it("models a finite Promise batch supplied by an imported generator", () => {
    const entry = "examples/dogfood/imported-promise-batch.ts";
    const values = "examples/dogfood/dashboard-values.ts";
    const program = ts.createProgram([entry, values], {
      target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext, lib: ["lib.es2024.d.ts"], noEmit: true,
    });
    const model = analyzeAsyncPatternsInProgram(program, program.getSourceFile(entry)!);
    expect(model.combinators).toEqual([
      expect.objectContaining({
        owner: "loadDashboardReplicas",
        branches: ['"replica-a"', '"replica-b"', "network"],
        branchKinds: ["value", "value", "thenable"],
        staticIterable: true,
        iteratorKind: "local",
      }),
      expect.objectContaining({
        owner: "loadImportedDashboard",
        branches: ['"dashboard-header"', '"cached-profile"', "network"],
        branchKinds: ["value", "value", "thenable"],
        staticIterable: true,
        iteratorKind: "array",
        iteratorEffects: ["InvokeUserCode"],
      }),
      expect.objectContaining({
        owner: "loadImportedDashboardSnapshot",
        branches: ['"cached-snapshot"', 'Promise.resolve("network-snapshot")'],
        branchKinds: ["value", "thenable"],
        staticIterable: true,
        iteratorKind: "local",
        iteratorEffects: ["InvokeUserCode"],
      }),
      expect.objectContaining({
        owner: "loadImportedDashboardFallback",
        combinator: "any",
        aggregateErrorOrder: [0, 1],
        aggregateErrorReasons: [
          { kind: "literal", value: "cache-miss" },
          { kind: "error", errorType: "TypeError", message: "network-down" },
        ],
      }),
      expect.objectContaining({
        owner: "loadConditionalDashboard",
        branchAlternatives: [
          ['"conditional-metadata"', '"conditional-metadata"'],
          ['"dashboard-head"', '"dashboard-head"'],
          ["network", '"cached-primary"'],
          ["<absent>", '"cached-secondary"'],
          ["<absent>", '"dashboard-tail"'],
        ],
        branchPresence: ["always", "always", "always", "when-false", "when-false"],
        iteratorKind: "array",
        iteratorFailure: "step",
        iteratorFailurePresence: "when-true",
      }),
      expect.objectContaining({
        owner: "compareConditionalDashboards",
        staticIterable: true,
        iteratorKind: "array",
        iteratorEffects: ["InvokeUserCode"],
        iterablePaths: [
          expect.objectContaining({
            branches: ['"comparison-header"', '"dashboard-head"', "primaryNetwork"],
            iteratorFailure: "step",
          }),
          expect.objectContaining({
            branches: [
              '"comparison-header"', '"dashboard-head"', '"cached-primary"', '"cached-secondary"', '"dashboard-tail"',
              '"comparison-separator"', '"dashboard-head"', "secondaryNetwork",
            ],
            iteratorFailure: "step",
          }),
          expect.objectContaining({
            branches: [
              '"comparison-header"', '"dashboard-head"', '"cached-primary"', '"cached-secondary"', '"dashboard-tail"',
              '"comparison-separator"', '"dashboard-head"', '"cached-primary"', '"cached-secondary"', '"dashboard-tail"',
            ],
          }),
        ],
      }),
      expect.objectContaining({
        owner: "loadDelegatedDashboard",
        staticIterable: true,
        iteratorKind: "local",
        iterablePaths: [
          expect.objectContaining({
            branches: ['"delegated-head"', "network", '"delegated-tail"'],
            branchKinds: ["value", "thenable", "value"],
          }),
          expect.objectContaining({
            branches: ['"delegated-head"', '"regional-cache"', '"delegated-tail"'],
            branchKinds: ["value", "value", "value"],
          }),
        ],
      }),
    ]);
    const quint = generateAsyncPatternsQuint("imported_batch", model);
    expect(quint).toContain("action assimilate_0_2");
    expect(quint).not.toContain("action reject_1_0");
    expect(quint).toContain("action assimilate_1_2");
    expect(quint).toContain("action assimilate_2_1");
    expect(quint).toContain('val join_3_aggregate_error_reason_0 = "literal:string:cache-miss"');
    expect(quint).toContain('val join_3_aggregate_error_reason_1 = "error:TypeError:network-down"');
    expect(quint).toContain("action choose_iterable_4_path_0");
    expect(quint).toContain("action choose_iterable_4_path_1");
    expect(quint).toMatch(/action fail_iterator_4[\s\S]*join_4_iterable_choice == 0/);
    expect(quint).toContain("action choose_iterable_5_path_0");
    expect(quint).toContain("action choose_iterable_5_path_2");
    expect(quint).toMatch(/action fail_iterator_5[\s\S]*join_5_iterable_choice == 0 or join_5_iterable_choice == 1/);
    expect(quint).toContain("action choose_iterable_6_path_0");
    expect(quint).toContain("action choose_iterable_6_path_1");
  });

  it("rejects allSettled when the telemetry batch iterator itself fails", () => {
    const fileName = "examples/dogfood/iterable-batch.ts";
    const source = readFileSync(fileName, "utf8");
    const model = analyzeAsyncPatterns(fileName, source);
    expect(model.combinators).toEqual([
      expect.objectContaining({
        owner: "drainTelemetrySpool",
        combinator: "allSettled",
        branches: ["Promise.resolve(1)"],
        iteratorFailure: "step",
        catchesRejection: true,
      }),
    ]);
    const quint = generateAsyncPatternsQuint("iterable_batch", model);
    expect(quint).toContain("action fail_iterator_0");
    expect(quint).toMatch(/action fail_iterator_0[\s\S]*join_0_result' = 2/);
  });

  it("checks a fetch deadline as both Timer authority and a one-shot Web task", () => {
    const fileName = "examples/dogfood/fetch-timeout.ts";
    const source = readFileSync(fileName, "utf8");
    expect(analyzeEffects(fileName, source)).toEqual([]);
    const model = analyzeAsyncPatterns(fileName, source);
    expect(model.timers).toEqual([
      expect.objectContaining({ kind: "abort-timeout", delay: 5_000, handle: "timeout" }),
    ]);
    expect(model.abortCompositions).toEqual([
      expect.objectContaining({ handle: "deadline", sources: ["externalSignal", "timeout"], sourceTimers: [undefined, 0] }),
      expect.objectContaining({ handle: "signal", sources: ["deadline", "shutdownSignal"], sourceCompositions: [0, undefined] }),
    ]);
    const quint = generateAsyncPatternsQuint("fetch_timeout", model);
    expect(quint).toContain("action fire_abort_timeout_0");
    expect(quint).toContain("timer_0_fires <= 1");
    const web = generateWebEventLoopQuint("fetch_timeout_web", model);
    expect(web).toContain("action abort_0_from_external_0");
    expect(web).toContain("action abort_0_from_timer_0");
    expect(web).toContain("action abort_1_from_composition_0");
    expect(web).toContain("action abort_1_from_external_1");

    const missingTimer = source.replace("Timer | ", "");
    expect(analyzeEffects(fileName, missingTimer)).toContainEqual(expect.objectContaining({
      functionName: "fetchDashboard", kind: "missing", effect: "Timer",
    }));
  });

  it("checks a prioritized dashboard scheduler boundary", () => {
    const fileName = "examples/dogfood/scheduler-priority.ts";
    const source = readFileSync(fileName, "utf8");
    expect(analyzeEffects(fileName, source)).toEqual([]);
    const model = analyzeAsyncPatterns(fileName, source);
    expect(model.timers).toMatchObject([
      { kind: "abort-timeout", delay: 1_000 },
      { kind: "scheduler-post-task", priority: "user-visible", abortComposition: 0 },
      { kind: "scheduler-yield", priority: "user-visible", abortComposition: 0, enqueuedBy: 1, callback: "<continuation>" },
      { kind: "scheduler-post-task", priority: "background", abortComposition: 0, callback: "() => \"prefetch\"" },
    ]);
    const quint = generateWebEventLoopQuint("scheduler_priority", model);
    expect(quint).toMatch(/action run_scheduler_task_1[\s\S]*callback_2_pending' = true/);
    expect(quint).toContain("action run_scheduler_yield_2");
    expect(quint).toContain("action cancel_scheduler_task_2_from_composition_0");
    expect(quint).toMatch(/action run_scheduler_task_3[\s\S]*callback_1_pending and callback_1_due <= clock/);
    const wrongBoundary = source.replace("effect Timer", "effect Console");
    expect(analyzeEffects(fileName, wrongBoundary)).toEqual(expect.arrayContaining([
      expect.objectContaining({ functionName: "scheduleDashboardWork", kind: "missing", effect: "Timer" }),
      expect.objectContaining({ functionName: "scheduleDashboardWork", kind: "unused", effect: "Console" }),
    ]));
  });

  it("checks a Node server shutdown boundary through the close phase", () => {
    const fileName = "examples/dogfood/node-server-shutdown.ts";
    const source = readFileSync(fileName, "utf8");
    expect(analyzeEffects(fileName, source)).toEqual([]);
    const model = analyzeAsyncPatterns(fileName, source);
    expect(model.timers).toMatchObject([
      { queue: "poll", repeats: true, externallyReady: true },
      { queue: "close", externallyReady: true, enqueuedBy: 0 },
      { queue: "microtask", enqueuedBy: 1 },
    ]);
    const quint = generateNodeEventLoopQuint("node_server_shutdown", model);
    expect(quint).toContain("var callback_1_registered: int");
    expect(quint).toContain("var callback_0_source_open: bool");
    expect(quint).toMatch(/action run_poll_0[\s\S]*callback_1_registered' = callback_1_registered \+ 1/);
    expect(quint).toMatch(/action run_poll_0[\s\S]*callback_0_source_open' = false/);
    expect(quint).toMatch(/action complete_close_1[\s\S]*callback_1_registered > 0/);
    expect(quint).toMatch(/action run_close_1[\s\S]*node_phase == 4[\s\S]*callback_2_pending' = true/);

    const missingListenAuthority = source.replace('Net<"127.0.0.1:8081"> | ', "");
    expect(analyzeEffects(fileName, missingListenAuthority)).toContainEqual(expect.objectContaining({
      functionName: "startShutdownServer", kind: "missing", effect: 'Net<"127.0.0.1:8081">',
    }));
  });

  it("checks a Node DNS capability and poll-phase boundary", () => {
    const fileName = "examples/dogfood/node-dns-resolution.ts";
    const source = readFileSync(fileName, "utf8");
    expect(analyzeEffects(fileName, source)).toEqual([]);
    const model = analyzeAsyncPatterns(fileName, source);
    expect(model.timers).toMatchObject([{ queue: "poll", externallyReady: true }]);
    const quint = generateNodeEventLoopQuint("node_dns_resolution", model);
    expect(quint).toContain("action complete_poll_0");
    expect(quint).toMatch(/action run_poll_0[\s\S]*node_phase == 2/);
  });

  it("checks a Node TCP connection capability and poll-phase boundary", () => {
    const fileName = "examples/dogfood/node-net-connection.ts";
    const source = readFileSync(fileName, "utf8");
    expect(analyzeEffects(fileName, source)).toEqual([]);
    const model = analyzeAsyncPatterns(fileName, source);
    expect(model.timers).toMatchObject([
      { queue: "poll", externallyReady: true },
      { queue: "microtask", enqueuedBy: 0 },
    ]);
    const quint = generateNodeEventLoopQuint("node_net_connection", model);
    expect(quint).toContain("action complete_poll_0");
    expect(quint).toMatch(/action run_poll_0[\s\S]*node_phase == 2[\s\S]*callback_1_pending' = true/);

    const missingAuthority = source.replace("effect Net | Timer", "effect Timer");
    expect(analyzeEffects(fileName, missingAuthority)).toContainEqual(expect.objectContaining({
      functionName: "connectUpstream", kind: "missing", effect: "Net",
    }));
  });

  it("checks a Node Socket reconnect capability and poll-phase boundary", () => {
    const fileName = "examples/dogfood/node-socket-reconnect.ts";
    const source = readFileSync(fileName, "utf8");
    expect(analyzeEffects(fileName, source)).toEqual([]);
    const model = analyzeAsyncPatterns(fileName, source);
    expect(model.timers).toMatchObject([
      { queue: "poll", externallyReady: true },
      { queue: "microtask", enqueuedBy: 0 },
    ]);
    const quint = generateNodeEventLoopQuint("node_socket_reconnect", model);
    expect(quint).toContain("action complete_poll_0");
    expect(quint).toMatch(/action run_poll_0[\s\S]*node_phase == 2[\s\S]*callback_1_pending' = true/);

    const wrongHost = source.replace("api.example.com:443", "other.example:443");
    expect(analyzeEffects(fileName, wrongHost)).toContainEqual(expect.objectContaining({
      functionName: "reconnectUpstream", kind: "missing", effect: 'Net<"api.example.com:443">',
    }));
  });

  it("checks a Node cryptographic-token capability and poll-phase boundary", () => {
    const fileName = "examples/dogfood/node-random-token.ts";
    const source = readFileSync(fileName, "utf8");
    expect(analyzeEffects(fileName, source)).toEqual([]);
    const model = analyzeAsyncPatterns(fileName, source);
    expect(model.timers).toMatchObject([
      { queue: "poll", externallyReady: true },
      { queue: "microtask", enqueuedBy: 0 },
    ]);
    const quint = generateNodeEventLoopQuint("node_random_token", model);
    expect(quint).toContain("action complete_poll_0");
    expect(quint).toMatch(/action run_poll_0[\s\S]*node_phase == 2[\s\S]*callback_1_pending' = true/);

    const missingRandom = source.replace("effect Random | Timer", "effect Timer");
    expect(analyzeEffects(fileName, missingRandom)).toContainEqual(expect.objectContaining({
      functionName: "issueToken", kind: "missing", effect: "Random",
    }));
  });

  it("checks a Node HTTPS health-check authority and response boundary", () => {
    const fileName = "examples/dogfood/node-http-healthcheck.ts";
    const source = readFileSync(fileName, "utf8");
    expect(analyzeEffects(fileName, source)).toEqual([]);
    const model = analyzeAsyncPatterns(fileName, source);
    expect(model.timers).toMatchObject([
      { queue: "poll", externallyReady: true },
      { queue: "microtask", enqueuedBy: 0 },
    ]);
    const quint = generateNodeEventLoopQuint("node_http_healthcheck", model);
    expect(quint).toContain("action complete_poll_0");
    expect(quint).toMatch(/action run_poll_0[\s\S]*node_phase == 2[\s\S]*callback_1_pending' = true/);

    const wrongAuthority = source.replace("api.example.com:443", "other.example:443");
    expect(analyzeEffects(fileName, wrongAuthority)).toContainEqual(expect.objectContaining({
      functionName: "checkHealth", kind: "missing", effect: 'Net<"api.example.com:443">',
    }));
  });

  it("checks a scoped child-process authority and completion boundary", () => {
    const fileName = "examples/dogfood/node-git-status.ts";
    const source = readFileSync(fileName, "utf8");
    expect(analyzeEffects(fileName, source)).toEqual([]);
    const model = analyzeAsyncPatterns(fileName, source);
    expect(model.timers).toMatchObject([
      { queue: "poll", externallyReady: true },
      { queue: "microtask", enqueuedBy: 0 },
    ]);
    const quint = generateNodeEventLoopQuint("node_git_status", model);
    expect(quint).toContain("action complete_poll_0");
    expect(quint).toMatch(/action run_poll_0[\s\S]*node_phase == 2[\s\S]*callback_1_pending' = true/);

    const shellExecution = source.replaceAll("execFile", "exec");
    expect(analyzeEffects(fileName, shellExecution)).toContainEqual(expect.objectContaining({
      functionName: "readGitStatus", kind: "missing", effect: "Run",
    }));
  });

  it("checks scoped Node service configuration environment access", () => {
    const fileName = "examples/dogfood/node-service-config.ts";
    const source = readFileSync(fileName, "utf8");
    expect(analyzeEffects(fileName, source)).toEqual([]);

    const missingSecret = source.replace(' | "DD_API_KEY"', "");
    expect(analyzeEffects(fileName, missingSecret)).toContainEqual(expect.objectContaining({
      functionName: "loadServiceConfig", kind: "missing", effect: 'Env<"DD_API_KEY">',
    }));
  });

  it("checks Deno-compatible system authority in Node runtime metadata", () => {
    const fileName = "examples/dogfood/node-runtime-metadata.ts";
    const source = readFileSync(fileName, "utf8");
    expect(analyzeEffects(fileName, source)).toEqual([]);

    const missingMemoryAuthority = source.replace(" | systemMemoryInfo", "");
    expect(analyzeEffects(fileName, missingMemoryAuthority)).toContainEqual(expect.objectContaining({
      functionName: "collectRuntimeMetadata", kind: "missing", effect: "Sys<systemMemoryInfo>",
    }));
  });

  it("checks scoped listen authority for a Node HTTP health server", () => {
    const fileName = "examples/dogfood/node-health-server.ts";
    const source = readFileSync(fileName, "utf8");
    expect(analyzeEffects(fileName, source)).toEqual([]);

    const missingListenAuthority = source.replace('Net<"127.0.0.1:8080"> | ', "");
    expect(analyzeEffects(fileName, missingListenAuthority)).toContainEqual(expect.objectContaining({
      functionName: "startHealthServer", kind: "missing", effect: 'Net<"127.0.0.1:8080">',
    }));
    const missingHandlerAuthority = source.replace(" | Console", "");
    expect(analyzeEffects(fileName, missingHandlerAuthority)).toContainEqual(expect.objectContaining({
      functionName: "startHealthServer", kind: "missing", effect: "Console",
    }));
  });

  it("checks repeated filesystem watcher effects", () => {
    const fileName = "examples/dogfood/node-config-watcher.ts";
    const source = readFileSync(fileName, "utf8");
    expect(analyzeEffects(fileName, source)).toEqual([]);

    expect(analyzeEffects(fileName, source.replace(" | Console", ""))).toContainEqual(expect.objectContaining({
      functionName: "reportConfigChanges", kind: "missing", effect: "Console",
    }));
    expect(analyzeEffects(fileName, source.replace('FsRead<"config.json"> | ', ""))).toContainEqual(expect.objectContaining({
      functionName: "reportConfigChanges", kind: "missing", effect: 'FsRead<"config.json">',
    }));
    expect(analyzeEffects(fileName, source.replace('/* uneffect: effect FsRead<"config.json"> */\nexport function probe', "export function probe")))
      .toContainEqual(expect.objectContaining({
        functionName: "probeConfigWatcherLifecycle", kind: "missing", effect: 'FsRead<"config.json">',
      }));
  });

  it("keeps conditional cancellation policies path-correlated", () => {
    const fileName = "examples/dogfood/conditional-abort-task.ts";
    const source = readFileSync(fileName, "utf8");
    expect(analyzeEffects(fileName, source)).toEqual([]);
    const model = analyzeAsyncPatterns(fileName, source);
    expect(model.abortCompositions).toMatchObject([{
      sourcePaths: [[0], [1, 2]],
      initiallyAbortedSources: [0, undefined],
    }]);
    const quint = generateWebEventLoopQuint("conditional_abort_task", model);
    expect(quint).toContain("action choose_abort_0_path_0");
    expect(quint).toContain("action choose_abort_0_path_1");
    expect(quint).toMatch(/action abort_0_from_timer_0[\s\S]*abort_0_path == 1/);
  }, 20_000);

  it("keeps conditional timer callback jobs mutually exclusive", () => {
    const fileName = "examples/dogfood/conditional-timer-callback.ts";
    const source = readFileSync(fileName, "utf8");
    expect(analyzeEffects(fileName, source)).toEqual([]);
    const model = analyzeAsyncPatterns(fileName, source);
    expect(model.timers).toMatchObject([
      { queue: "timer", callbackAlternatives: ["afterCacheHit", "afterOriginFetch"] },
      { queue: "microtask", parentAlternative: 0 },
      { queue: "next-tick", parentAlternative: 1 },
    ]);
    const quint = generateNodeEventLoopQuint("conditional_timer_callback", model);
    const hit = quint.slice(quint.indexOf("action run_timer_0_alt_0"), quint.indexOf("action run_timer_0_alt_1"));
    const miss = quint.slice(quint.indexOf("action run_timer_0_alt_1"), quint.indexOf("action advance_timers_to_poll"));
    expect(hit).toContain("callback_1_pending' = true");
    expect(hit).not.toContain("callback_2_pending' = true");
    expect(miss).toContain("callback_2_pending' = true");
    expect(miss).not.toContain("callback_1_pending' = true");
  });
});
