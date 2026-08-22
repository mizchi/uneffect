import { globSync, readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { analyzeEffects, analyzeProgramEffects } from "../src/effects.js";
import { analyzeAsyncSafety, analyzeAsyncSafetyInProgram, generateUnifiedAsyncQuint } from "../src/async-safety.js";
import { analyzePromiseChains, generatePromiseChainsQuint } from "../src/promise-chains.js";
import { analyzeAsyncPatterns, generateAsyncPatternsQuint, generateWebEventLoopQuint } from "../src/async-patterns.js";
import { auditBuiltinDeclarationDrift } from "../src/frontend-adapter.js";
import { verifyUneffectProject } from "../src/project-verification.js";
import { verifyTypedArraySafety } from "../src/typed-array-safety.js";
import { parseSpec } from "../src/spec-ir.js";
import { findTemporalCounterexampleWithZ3, lintTemporalReachabilityWithZ3 } from "../src/spec-lint.js";
import { generateUneffectPropertyTests } from "../src/property-tests.js";
import { validateRefinementActionBodiesInProgramWithZ3, validateRefinementActionBodiesWithZ3, validateRefinementBindingCoverage, validateRefinementInvariantBodiesInProgramWithZ3, validateRefinementInvariantBodiesWithZ3, validateRefinementStateProjection, validateRefinementStateProjectionInProgram } from "../src/refinement-bindings.js";

describe("Uneffect dogfood", () => {
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
    }));
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
  });

  it("derives executable aligned shard boundaries from a realistic contract", () => {
    const fileName = "examples/dogfood/shard-batch.ts";
    const result = generateUneffectPropertyTests({ files: { [fileName]: readFileSync(fileName, "utf8") } });
    expect(result.diagnostics).toEqual([]);
    expect(result.boundaries.find((boundary) => boundary.functionName === "shardBatch")?.generatorHints).toEqual([[0, 16, 1008]]);
    expect(result.boundaries.find((boundary) => boundary.functionName === "tenantShard")?.generatorHints).toEqual([[0, 16, 100, 116]]);
    expect(result.boundaries.find((boundary) => boundary.functionName === "partitionRoute")?.generatorHints).toEqual([[9, 21, 249]]);
    expect(result.boundaries.find((boundary) => boundary.functionName === "signedPartitionRoute")?.generatorHints).toEqual([[-45, -9, -3]]);
    expect(result.generatedFiles["examples/dogfood/shard-batch.uneffect.test.ts"]).toContain("const refinementValues = [[0,16,1008]]");
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

  it("proves four-way telemetry routing accounting and rejects a missing update", async () => {
    const fileName = "examples/dogfood/telemetry-routing-accounting.ts";
    const source = readFileSync(fileName, "utf8");
    const temporal = parseSpec(fileName, source).temporal;
    const program = ts.createProgram([fileName], {
      target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext, types: ["node"], noEmit: true,
    });
    expect(validateRefinementBindingCoverage(fileName, source, "telemetryRouting", temporal)).toEqual([]);
    expect(await validateRefinementActionBodiesWithZ3(fileName, source, "telemetryRouting", temporal)).toEqual([]);
    expect(await validateRefinementInvariantBodiesInProgramWithZ3(program, fileName, "telemetryRouting", temporal)).toEqual([]);
    expect(validateRefinementStateProjection(fileName, source, "telemetryRouting", temporal)).toEqual([]);
    const diagnostics = await lintTemporalReachabilityWithZ3(temporal, {
      maxSteps: 2,
      synthesizeRelationalStrengtheningProperties: true,
      relationalStrengtheningMaxArity: 4,
    });
    expect(diagnostics).toContainEqual(expect.objectContaining({
      code: "strengthened-unreachable-action",
      name: "observeLostOutcome",
      relatedName: "<synth:delivered + dropped + buffered === attempted>",
    }));

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

  it("proves a scaled telemetry capacity relation and catches unbalanced accounting", async () => {
    const fileName = "examples/dogfood/telemetry-capacity.ts";
    const source = readFileSync(fileName, "utf8");
    const temporal = parseSpec(fileName, source).temporal;
    const diagnostics = await lintTemporalReachabilityWithZ3(temporal, {
      maxSteps: 2,
      synthesizeRelationalStrengtheningProperties: true,
    });
    expect(diagnostics).toContainEqual(expect.objectContaining({
      code: "strengthened-unreachable-action",
      name: "observeOverCapacity",
      relatedName: "<synth:2 * accepted === byteBudget>",
    }));

    const brokenSource = source.replaceAll("byteBudget + 2", "byteBudget + 1").replaceAll("byteBudget += 2", "byteBudget += 1");
    const broken = parseSpec(fileName, brokenSource).temporal;
    const brokenDiagnostics = await lintTemporalReachabilityWithZ3(broken, {
      maxSteps: 2,
      synthesizeRelationalStrengtheningProperties: true,
    });
    expect(brokenDiagnostics).not.toContainEqual(expect.objectContaining({
      code: "strengthened-unreachable-action",
      relatedName: "<synth:2 * accepted === byteBudget>",
    }));
    await expect(findTemporalCounterexampleWithZ3(broken, "withinCapacity", { maxSteps: 1 }))
      .resolves.toMatchObject({ status: "counterexample", depth: 1 });
  });

  it("verifies a Node callback-checkpoint application model through the project API", async () => {
    const source = `
        import { nextTick } from "node:process"
        import { readFile } from "node:fs"
        /* uneffect: effect FsRead<"settings.json"> | Console | Timer */
        export function scheduleFlush() {
          readFile("settings.json", "utf8", () => {
            nextTick(() => console.log("tick"))
            queueMicrotask(() => console.log("microtask"))
            setImmediate(() => console.log("check"))
          })
        }
      `;
    const verified = await verifyUneffectProject({ temporalRuntime: "node", files: { "src/node-service.ts": source } });
    expect(verified.diagnostics).toEqual([]);
    const scheduleSummary = verified.effects.summaries.find((summary) => summary.functionName === "scheduleFlush");
    expect(scheduleSummary).toMatchObject({ fileName: "src/node-service.ts", id: expect.stringMatching(/^src\/node-service\.ts:\d+$/), span: { start: expect.any(Number), end: expect.any(Number) } });
    expect(scheduleSummary?.effects.map((effect) => effect.kind === "capability" ? effect.name : effect.kind)).toEqual(expect.arrayContaining(["FsRead", "Console", "Timer"]));
    expect(verified.temporal?.models).toContainEqual(expect.objectContaining({ kind: "node-event-loop", quint: expect.stringContaining("action run_poll_0") }));
    expect(verified.temporal?.models[0]?.quint).toContain("action drain_next_tick_1");
    expect(verified.temporal?.properties).toContainEqual(expect.objectContaining({ name: "nodeEventLoopSafe", result: "verified" }));

    const broken = await verifyUneffectProject({ temporalRuntime: "node", files: { "src/node-service.ts": source.replace(' | Console', '') } });
    expect(broken.diagnostics).toContainEqual(expect.objectContaining({ functionName: "scheduleFlush", effect: "Console" }));
  });

  it("analyzes its own implementation without diagnostics or unknown summaries in inference mode", () => {
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
    expect(result.summaries.filter((summary) => summary.evidence === "unknown")).toEqual([]);
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
    expect(result.summaries.filter((summary) => summary.evidence === "unknown")).toEqual([]);
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
  });

  it("checks telemetry Promise ownership across delivery modes and shutdown cleanup", () => {
    const fileName = "examples/dogfood/telemetry-delivery.ts";
    const source = readFileSync(fileName, "utf8");
    const verified = analyzeAsyncSafety(fileName, source);
    expect(verified.diagnostics).toEqual([]);
    expect(verified.promiseBindings.map(({ owner, status }) => ({ owner, status }))).toEqual([
      { owner: "deliverTelemetry", status: "observed" },
      { owner: "flushTelemetryBeforeExit", status: "observed" },
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
    ]);
    expect(model.thenables).toEqual([
      expect.objectContaining({ binding: "legacy", thenAccess: "callable", possibleSettlements: ["fulfilled"], firstCallWins: true }),
    ]);
    const quint = generatePromiseChainsQuint("legacy_adapter", model);
    expect(quint).toContain("assimilate_1_from_0_rejected");
    expect(quint).not.toContain("assimilate_1_fulfilled");
    expect(quint).toContain("assimilate_2_thenable_0_fulfilled");
    expect(quint).not.toContain("assimilate_2_thenable_0_rejected");
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
    ]);
    const quint = generateAsyncPatternsQuint("mixed_batch", model);
    expect(quint).not.toContain("action reject_0_0");
    expect(quint).not.toContain("action reject_0_1");
    expect(quint).toContain("action assimilate_0_2");
    expect(quint).toContain("action reject_0_2");
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
});
