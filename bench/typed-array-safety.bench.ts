import { bench, describe } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import ts from "typescript";
import { verifyTypedArraySafety, verifyTypedArraySafetyInProgram, verifyTypedArraySafetyInTypeScriptProgram } from "../src/typed-array-safety.js";
import { parseSpec } from "../src/spec-ir.js";
import { generateQuint } from "../src/spec-backends.js";
import { findTemporalCounterexampleWithZ3, lintTemporalReachabilityWithZ3, lintTemporalSpec, lintTemporalSpecWithZ3 } from "../src/spec-lint.js";
import { checkUneffectProperty, generateUneffectPropertyTests, generateUneffectPropertyTestsWithZ3 } from "../src/property-tests.js";
import { analyzeUneffectProject, defineUneffectValidator } from "../src/custom-validators.js";
import { createModelCounterexample, parseQuintItfCounterexample, parseTlcCounterexample, replayModelCounterexample } from "../src/model-replay.js";
import { generateRefinementAdapterModuleFromManifest, validateRefinementActionBodies, validateRefinementActionBodiesInProgram, validateRefinementActionBodiesWithManifest, validateRefinementBindingCoverage, validateRefinementInvariantBodies, validateRefinementStateProjection, type RefinementBindingManifest } from "../src/refinement-bindings.js";
import { verifyUneffectProject } from "../src/project-verification.js";
import { analyzeAsyncPatterns, generateNodeEventLoopQuint } from "../src/async-patterns.js";
import { analyzeAsyncSafety, analyzeAsyncSafetyInProgram, generateUnifiedAsyncQuint } from "../src/async-safety.js";
import { analyzePromiseChains } from "../src/promise-chains.js";
import { analyzeEffectsInProgram, analyzeProgramEffects } from "../src/effects.js";
import { analyzeProjectRefinements, composeWorkspaceRefinements, type CompletedRefinementProject } from "../src/workspace-refinements.js";
import type { TypeScriptProject } from "../src/typescript-project.js";
import { nodeCurrentRealmGlobalIdentity, SAME_REALM_GLOBAL_THIS_IDENTITY } from "../src/runtime-identities.js";

function validateGeneratedRefinementActionBodies(
  fileName: string,
  source: string,
  adapterName: string,
  temporal: ReturnType<typeof parseSpec>["temporal"],
): void {
  const actions = Object.fromEntries(temporal.actions.map(({ name }) => [name, name]));
  validateRefinementActionBodiesWithManifest(fileName, source, {
    schema: "uneffect-refinement-bindings/v1",
    fileName,
    adapterName,
    version: "1",
    create: "create",
    observe: "observe",
    abstractions: {},
    actions,
    invariants: {},
  }, temporal);
}

const SHA256_K = Array.from({ length: 64 }, (_, index) => `0x${((0x428a2f98 + index * 0x10101) >>> 0).toString(16)}`).join(",");
const chainedConstants = Array.from({ length: 128 }, (_, index) =>
  index === 0 ? "const C0 = 1" : `const C${index} = C${index - 1} + 1`,
).join("\n");
const indexedReads = Array.from({ length: 256 }, (_, index) => `void K[${index % 64}]`).join("\n");
const inferredIntegerWrites = Array.from({ length: 256 }, (_, index) =>
  `const value${index} = Math.floor(input); output[${index}] = value${index}`,
).join("\n");
const aliasedIntegerWrites = Array.from({ length: 256 }, (_, index) =>
  `const value${index} = ${index % 2 === 0 ? "floorAlias" : "truncate"}(input); output[${index}] = value${index}`,
).join("\n");
const boundedDataViewWrites = Array.from({ length: 64 }, (_, index) =>
  `view.setUint32(${index * 4}, word)`,
).join("\n");
const dnsCodecSource = readFileSync(new URL("../examples/dogfood/binary-codec.ts", import.meta.url), "utf8");
const workerCodecTransferSource = readFileSync(new URL("../examples/dogfood/worker-codec-transfer.ts", import.meta.url), "utf8");
const telemetryDeliverySource = readFileSync(new URL("../examples/dogfood/telemetry-delivery.ts", import.meta.url), "utf8");
const targetAwareRetryCleanupSource = readFileSync(new URL("../examples/dogfood/target-aware-retry-cleanup.ts", import.meta.url), "utf8");
const targetAwareBreakCleanupSource = readFileSync(new URL("../examples/dogfood/target-aware-break-cleanup.ts", import.meta.url), "utf8");
const rejectedAwaitMultipleDisposalSource = readFileSync(new URL("../examples/dogfood/rejected-await-multiple-disposal.ts", import.meta.url), "utf8");
const nestedRejectionCleanupSource = readFileSync(new URL("../examples/dogfood/nested-rejection-cleanup.ts", import.meta.url), "utf8");
const caughtDisposalRejectionSource = readFileSync(new URL("../examples/dogfood/caught-disposal-rejection.ts", import.meta.url), "utf8");
const suppressedDisposalRejectionsSource = readFileSync(new URL("../examples/dogfood/suppressed-disposal-rejections.ts", import.meta.url), "utf8");
const branchCorrelatedCleanupSource = readFileSync(new URL("../examples/dogfood/branch-correlated-cleanup.ts", import.meta.url), "utf8");
const switchCorrelatedCleanupSource = readFileSync(new URL("../examples/dogfood/switch-correlated-cleanup.ts", import.meta.url), "utf8");
const nestedBranchCorrelatedCleanupSource = readFileSync(new URL("../examples/dogfood/nested-branch-correlated-cleanup.ts", import.meta.url), "utf8");
const mixedDecisionCorrelatedCleanupSource = readFileSync(new URL("../examples/dogfood/mixed-decision-correlated-cleanup.ts", import.meta.url), "utf8");
const sequentialDecisionCleanupSource = readFileSync(new URL("../examples/dogfood/sequential-decision-cleanup.ts", import.meta.url), "utf8");
const nonUniformReturnCleanupSource = readFileSync(new URL("../examples/dogfood/nonuniform-return-cleanup.ts", import.meta.url), "utf8");
const nonUniformThrowCleanupSource = readFileSync(new URL("../examples/dogfood/nonuniform-throw-cleanup.ts", import.meta.url), "utf8");
const conditionalLoopResourceGenerationsSource = readFileSync(new URL("../examples/dogfood/conditional-loop-resource-generations.ts", import.meta.url), "utf8");
const dynamicOuterContinueSource = `
  async function deliver(items: string[]) {
    for (const item of items) {
      try {
        await Promise.resolve(item).then(value => { throw new Error(value) })
      } catch {
        continue
      }
    }
  }
`;
const importedRuntimeRefinementFile = "examples/dogfood/imported-runtime-refinement.ts";
const importedTelemetryRuntimeFile = "examples/dogfood/imported-telemetry-runtime.ts";
const importedRuntimeRefinementSource = readFileSync(importedRuntimeRefinementFile, "utf8");
const importedRuntimeRefinementSpec = parseSpec(importedRuntimeRefinementFile, importedRuntimeRefinementSource).temporal;
const importedRuntimeRefinementProgram = ts.createProgram([importedRuntimeRefinementFile, importedTelemetryRuntimeFile], {
  target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext, types: ["node"], noEmit: true,
});
const initializedTelemetryDeliverySource = telemetryDeliverySource.replace(
  "let delivery: Promise<void>;\n  delivery = sendTelemetryBatch();",
  "const delivery = sendTelemetryBatch();",
);
const explicitCatchOwnershipSource = `
  declare function task(): Promise<number>
  /* uneffect:effect Throw<Error> */ declare function fail(): never
  declare const flag: boolean
${Array.from({ length: 64 }, (_, index) => `
  async function caught${index}() {
    const pending = task()
    try { ${[
      `throw new Error("route-${index}")`,
      "fail()",
      "return fail()",
      "void fail()",
      "(void 0, fail())",
      "flag ? fail() : fail()",
      "fail() && void 0",
      "true && fail()",
      "false || fail()",
      "null ?? fail()",
      "void 0 ?? fail()",
      "undefined ?? fail()",
    ][index % 12]} } catch { await pending }
  }
`).join("\n")}`;
const loopCatchOwnershipSource = Array.from({ length: 64 }, (_, index) => `
  async function retry${index}(retry: boolean, mode: "primary" | "backup") {
    let pending = task()
    while (retry) {
      try {
        const attempt = ${index}; void attempt
        try {
          switch (mode) {
            case "primary":
            case "backup": { const value = await pending; recordAttempt(value); break }
          }
        } finally { recordAttempt(attempt) }
        break
      }
      catch { pending = task(); continue }
    }
    await pending
  }
`).join("\n");
const promiseAdapterSource = readFileSync(new URL("../examples/dogfood/promise-adapter.ts", import.meta.url), "utf8");
const dynamicThenableSource = `declare const flag: boolean; declare const external: PromiseLike<number>; function run() { const conditional = { get then() { if (flag) throw new Error(); return (resolve: (value: number) => void) => resolve(1) } }; const proxied = new Proxy({ then(resolve: (value: number) => void) { resolve(1) } }, {}); const a = new Promise<number>(resolve => resolve(conditional)); const b = new Promise<number>(resolve => resolve(proxied)); const c = new Promise<number>(resolve => resolve(external)); a.catch(() => 0); b.catch(() => 0); return c.catch(() => 0) }`;
const mixedPromiseBatchSource = readFileSync(new URL("../examples/dogfood/mixed-promise-batch.ts", import.meta.url), "utf8");
const finitePromisePathProductSource = `
  function* values(a: boolean, b: boolean, c: boolean, d: boolean, e: boolean) {
    if (a) yield Promise.resolve("a1"); else yield "a0"
    if (b) yield Promise.resolve("b1"); else yield "b0"
    if (c) yield Promise.resolve("c1"); else yield "c0"
    if (d) yield Promise.resolve("d1"); else yield "d0"
    if (e) yield Promise.resolve("e1"); else yield "e0"
  }
  async function load(a: boolean, b: boolean, c: boolean, d: boolean, e: boolean) {
    return Promise.all(values(a, b, c, d, e))
  }
`;
const fetchTimeoutSource = readFileSync(new URL("../examples/dogfood/fetch-timeout.ts", import.meta.url), "utf8");
const telemetryPacketSource = readFileSync(new URL("../examples/dogfood/telemetry-packet.ts", import.meta.url), "utf8");
const retryAttemptsSource = readFileSync(new URL("../examples/dogfood/retry-attempts.ts", import.meta.url), "utf8");
const retryAttemptEscapeFile = "examples/dogfood/retry-attempt-escape.ts";
const retryAttemptSlotFile = "examples/dogfood/retry-slots.ts";
const leaseAuthorityFile = "examples/dogfood/lease-authority-refinement.ts";
const leaseAuthoritySource = readFileSync(leaseAuthorityFile, "utf8");
const leaseAuthoritySpec = parseSpec(leaseAuthorityFile, leaseAuthoritySource).temporal;
const finiteTelemetryBatchFile = "examples/dogfood/finite-telemetry-batch.ts";
const finiteTelemetryBatchSource = readFileSync(finiteTelemetryBatchFile, "utf8");
const finiteTelemetryBatchSpec = parseSpec(finiteTelemetryBatchFile, finiteTelemetryBatchSource).temporal;
const labeledTelemetryFile = "examples/dogfood/labeled-telemetry-delivery.ts";
const labeledTelemetrySource = readFileSync(labeledTelemetryFile, "utf8");
const labeledTelemetrySpec = parseSpec(labeledTelemetryFile, labeledTelemetrySource).temporal;
const telemetryBacklogFile = "examples/dogfood/telemetry-backlog-drain.ts";
const telemetryBacklogSource = readFileSync(telemetryBacklogFile, "utf8");
const telemetryBacklogSpec = parseSpec(telemetryBacklogFile, telemetryBacklogSource).temporal;
const workerPoolFile = "examples/dogfood/worker-pool-scale-up.ts";
const workerPoolSource = readFileSync(workerPoolFile, "utf8");
const workerPoolSpec = parseSpec(workerPoolFile, workerPoolSource).temporal;
const triangularDrainFile = "bench/triangular-backlog-drain.ts";
const triangularDrainSource = `/* uneffect: state pending: int */ /* uneffect: state weighted: int */ /* uneffect: init pending = 0 */ /* uneffect: init weighted = 0 */ /* uneffect: action drain: pending' = pending > 0 ? 0 : pending, weighted' = weighted + (pending > 0 ? pending * (pending - 1) / 2 : 0) */
interface Runtime { pending: number; weighted: number }
export function drain(runtime: Runtime) {
  while (runtime.pending > 0) {
    runtime.pending--
    runtime.weighted += runtime.pending
  }
}`;
const triangularDrainSpec = parseSpec(triangularDrainFile, triangularDrainSource).temporal;
const priorityTelemetryFile = "examples/dogfood/priority-telemetry-drain.ts";
const priorityTelemetrySource = readFileSync(priorityTelemetryFile, "utf8");
const priorityTelemetrySpec = parseSpec(priorityTelemetryFile, priorityTelemetrySource).temporal;
const pausedTelemetryFile = "examples/dogfood/paused-telemetry-drain.ts";
const pausedTelemetrySource = readFileSync(pausedTelemetryFile, "utf8");
const pausedTelemetrySpec = parseSpec(pausedTelemetryFile, pausedTelemetrySource).temporal;
const failingTelemetryFile = "examples/dogfood/failing-telemetry-drain.ts";
const failingTelemetrySource = readFileSync(failingTelemetryFile, "utf8");
const failingTelemetrySpec = parseSpec(failingTelemetryFile, failingTelemetrySource).temporal;
const circuitBreakerTelemetryFile = "examples/dogfood/circuit-breaker-telemetry-drain.ts";
const circuitBreakerTelemetrySource = readFileSync(circuitBreakerTelemetryFile, "utf8");
const circuitBreakerTelemetrySpec = parseSpec(circuitBreakerTelemetryFile, circuitBreakerTelemetrySource).temporal;
const adaptiveBatchAccountingFile = "examples/dogfood/adaptive-batch-accounting.ts";
const adaptiveBatchAccountingSource = readFileSync(adaptiveBatchAccountingFile, "utf8");
const adaptiveBatchAccountingSpec = parseSpec(adaptiveBatchAccountingFile, adaptiveBatchAccountingSource).temporal;
const rethrowBatchAccountingFile = "examples/dogfood/rethrow-batch-accounting.ts";
const rethrowBatchAccountingSource = readFileSync(rethrowBatchAccountingFile, "utf8");
const rethrowBatchAccountingSpec = parseSpec(rethrowBatchAccountingFile, rethrowBatchAccountingSource).temporal;
const boundedBatchBillingFile = "examples/dogfood/bounded-batch-billing.ts";
const boundedBatchBillingSource = readFileSync(boundedBatchBillingFile, "utf8");
const boundedBatchBillingSpec = parseSpec(boundedBatchBillingFile, boundedBatchBillingSource).temporal;
const circuitBreakerBatchAccountingFile = "examples/dogfood/circuit-breaker-batch-accounting.ts";
const circuitBreakerBatchAccountingSource = readFileSync(circuitBreakerBatchAccountingFile, "utf8");
const circuitBreakerBatchAccountingSpec = parseSpec(
  circuitBreakerBatchAccountingFile, circuitBreakerBatchAccountingSource,
).temporal;
const retryBatchAccountingFile = "examples/dogfood/retry-batch-accounting.ts";
const retryBatchAccountingSource = readFileSync(retryBatchAccountingFile, "utf8");
const retryBatchAccountingSpec = parseSpec(retryBatchAccountingFile, retryBatchAccountingSource).temporal;
const finallyOverrideAccountingFile = "examples/dogfood/finally-override-accounting.ts";
const finallyOverrideAccountingSource = readFileSync(finallyOverrideAccountingFile, "utf8");
const finallyOverrideAccountingSpec = parseSpec(
  finallyOverrideAccountingFile, finallyOverrideAccountingSource,
).temporal;
const finallyEscalationAccountingFile = "examples/dogfood/finally-escalation-accounting.ts";
const finallyEscalationAccountingSource = readFileSync(finallyEscalationAccountingFile, "utf8");
const finallyEscalationAccountingSpec = parseSpec(
  finallyEscalationAccountingFile, finallyEscalationAccountingSource,
).temporal;
const finallyCircuitBreakAccountingFile = "examples/dogfood/finally-circuit-break-accounting.ts";
const finallyCircuitBreakAccountingSource = readFileSync(finallyCircuitBreakAccountingFile, "utf8");
const finallyCircuitBreakAccountingSpec = parseSpec(
  finallyCircuitBreakAccountingFile, finallyCircuitBreakAccountingSource,
).temporal;
const finallyRetryAccountingFile = "examples/dogfood/finally-retry-accounting.ts";
const finallyRetryAccountingSource = readFileSync(finallyRetryAccountingFile, "utf8");
const finallyRetryAccountingSpec = parseSpec(
  finallyRetryAccountingFile, finallyRetryAccountingSource,
).temporal;
const affineBranchBudgetFile = "bench/eight-leaf-affine-drain.ts";
const affineBranchFlags = Array.from({ length: 7 }, (_, index) => `flag${index}`);
const affineBranchTotal = affineBranchFlags.reduceRight(
  (otherwise, flag) => `${flag} ? pending * (pending - 1) / 2 : (${otherwise})`,
  "0",
);
const affineBranchBody = affineBranchFlags.map(
  (flag, index) => `${index === 0 ? "if" : "else if"} (runtime.${flag}) runtime.weighted += runtime.pending`,
).join("\n    ");
const affineBranchBudgetSource = `/* uneffect: state pending: int */ /* uneffect: state weighted: int */ /* uneffect: ${affineBranchFlags.map((flag) => `state ${flag}: bool`).join("\n  ")} */ /* uneffect: init pending = 0 */ /* uneffect: init weighted = 0 */ /* uneffect: ${affineBranchFlags.map((flag) => `init ${flag} = false`).join("\n  ")} */ /* uneffect: action drain: pending' = pending > 0 ? 0 : pending, weighted' = weighted + (pending > 0 ? (${affineBranchTotal}) : 0) */
interface Runtime { pending: number; weighted: number; ${affineBranchFlags.map((flag) => `${flag}: boolean`).join("; ")} }
export function drain(runtime: Runtime) {
  while (runtime.pending > 0) {
    runtime.pending--
    ${affineBranchBody}
  }
}`;
const affineBranchBudgetSpec = parseSpec(affineBranchBudgetFile, affineBranchBudgetSource).temporal;
const generatedMigrationFile = "examples/dogfood/generated-one-shot-migration.ts";
const uneffectSourceFiles = readdirSync("src").filter((name) => name.endsWith(".ts")).map((name) => `src/${name}`);
const uneffectEffectProgram = ts.createProgram(uneffectSourceFiles, {
  target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext, lib: ["lib.es2024.d.ts", "lib.dom.d.ts"], types: ["node"], noEmit: true,
});
const generatedMigrationSource = readFileSync(generatedMigrationFile, "utf8");
const generatedMigrationSpec = parseSpec(generatedMigrationFile, generatedMigrationSource).temporal;
const leaseAuthorityProgram = ts.createProgram([leaseAuthorityFile], {
  target: ts.ScriptTarget.ESNext,
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  types: ["node"],
  noEmit: true,
});
const asyncSafetyCompilerOptions: ts.CompilerOptions = {
  target: ts.ScriptTarget.ESNext,
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  lib: ["lib.esnext.d.ts", "lib.dom.d.ts", "lib.esnext.disposable.d.ts"],
  types: ["node"],
  noEmit: true,
};
function createAsyncSafetyBenchmarkProgram(): ts.Program {
  return ts.createProgram([retryAttemptSlotFile, retryAttemptEscapeFile], asyncSafetyCompilerOptions);
}
const warmAsyncSafetyProgram = createAsyncSafetyBenchmarkProgram();
const warmAsyncSafetySource = warmAsyncSafetyProgram.getSourceFile(retryAttemptEscapeFile)!;
const typedIntegerSourceName = "/bench/integer-casts.ts";
const typedIntegerSourceText = `type U8 = number; type BoundedUint8Array<N extends number> = Uint8Array; const floorAlias = Math.floor; const { trunc: truncate } = Math; function write(output: BoundedUint8Array<256>, input: U8) { ${aliasedIntegerWrites} }`;
const compilerOptions: ts.CompilerOptions = { target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, lib: ["lib.es2024.d.ts"] };
const indirectRefinementParentName = "/bench/indirect-parent.ts";
const indirectRefinementDeclarationName = "/bench/indirect-child.d.ts";
const indirectRefinementParentText = `
  import { increment as incrementChild, type Runtime } from "indirect-child"
  declare global { var armed: boolean; var count: number }
  /* uneffect: state armed: bool */ /* uneffect: state count: int */ /* uneffect: init armed = true */ /* uneffect: init count = 0 */ /* uneffect: action increment: count' = count + 1 */ /* uneffect: action_when increment: armed */
  export function create(initial: Runtime) { return initial }
  export function observe(runtime: Runtime) { return runtime }
  function bounce(runtime: Runtime) { incrementChild(runtime) }
  function apply(runtime: Runtime) { bounce(runtime) }
  export function increment(_runtime: Runtime) { apply(globalThis) }
`;
const indirectRefinementManifest = {
  schema: "uneffect-refinement-bindings/v1", fileName: indirectRefinementParentName,
  adapterName: "counter", version: "1", runtimeIdentity: SAME_REALM_GLOBAL_THIS_IDENTITY,
  create: "create", observe: "observe", abstractions: {},
  actions: { increment: "increment" }, invariants: {},
} satisfies RefinementBindingManifest;
const indirectRefinementDeclarationText = `declare module "indirect-child" {
  export interface Runtime { armed: boolean; count: number }
  export function increment(runtime: Runtime): void
}`;
const indirectRefinementHost = ts.createCompilerHost(compilerOptions);
const defaultIndirectGetSourceFile = indirectRefinementHost.getSourceFile.bind(indirectRefinementHost);
indirectRefinementHost.fileExists = (fileName) => [indirectRefinementParentName, indirectRefinementDeclarationName].includes(fileName)
  || ts.sys.fileExists(fileName);
indirectRefinementHost.readFile = (fileName) => fileName === indirectRefinementParentName ? indirectRefinementParentText
  : fileName === indirectRefinementDeclarationName ? indirectRefinementDeclarationText : ts.sys.readFile(fileName);
indirectRefinementHost.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) =>
  fileName === indirectRefinementParentName
    ? ts.createSourceFile(fileName, indirectRefinementParentText, languageVersion, true)
    : fileName === indirectRefinementDeclarationName
      ? ts.createSourceFile(fileName, indirectRefinementDeclarationText, languageVersion, true)
      : defaultIndirectGetSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile);
const indirectRefinementProgram = ts.createProgram(
  [indirectRefinementParentName, indirectRefinementDeclarationName], compilerOptions, indirectRefinementHost,
);
const exactCompiler = {
  analyzerVersion: ts.version, analyzerPackageFile: "/bench/typescript/package.json",
  consumerVersion: ts.version, consumerPackageFile: "/bench/typescript/package.json",
  consumerModuleFile: "/bench/typescript/index.js", parity: "exact" as const,
};
const indirectRefinementCurrent: TypeScriptProject = {
  projectFile: "/bench/parent-tsconfig.json", fileNames: [indirectRefinementParentName],
  compilerOptions, projectReferences: [],
  provenance: { projectFile: "/bench/parent-tsconfig.json", compiler: exactCompiler },
};
const indirectRefinementCompleted: CompletedRefinementProject = {
  project: {
    projectFile: "/bench/child-tsconfig.json", fileNames: [], compilerOptions, projectReferences: [],
    provenance: { projectFile: "/bench/child-tsconfig.json", compiler: exactCompiler },
  },
  summaries: [{
    adapterName: "counter", version: "1", modelName: "increment", exportName: "increment",
    runtimeIdentity: SAME_REALM_GLOBAL_THIS_IDENTITY,
    guard: { kind: "name", name: "armed" },
    assignments: [{ target: "count", expressionAst: { kind: "binary", operator: "add", left: { kind: "name", name: "count" }, right: { kind: "integer", value: 1n } } }],
    evidence: "verified", sourceFile: "/bench/child.ts",
  }],
  declarationOutputs: new Map([[indirectRefinementDeclarationName, {
    status: "verified", fileName: indirectRefinementDeclarationName,
  }]]),
};
const nodeRealmRefinementName = "/bench/node-realm-refinement.ts";
const nodeRealmRefinementText = `
  declare function incrementChild(runtime: typeof global): void
  /* uneffect: state count: int */ /* uneffect: init count = 0 */ /* uneffect: action increment: count' = count + 1 */
  export function create(initial: typeof global) { return initial }
  export function observe(runtime: typeof global) { return runtime }
  export function increment(_runtime: typeof global) { incrementChild(global) }
`;
const nodeRealmRefinementManifest = {
  schema: "uneffect-refinement-bindings/v1", fileName: nodeRealmRefinementName,
  adapterName: "counter", version: "1", runtimeIdentity: nodeCurrentRealmGlobalIdentity("24", "main"),
  create: "create", observe: "observe", abstractions: {},
  actions: { increment: "increment" }, invariants: {},
} satisfies RefinementBindingManifest;
const nodeRealmCompilerOptions: ts.CompilerOptions = { ...compilerOptions, types: ["node"] };
const nodeRealmHost = ts.createCompilerHost(nodeRealmCompilerOptions);
const defaultNodeRealmGetSourceFile = nodeRealmHost.getSourceFile.bind(nodeRealmHost);
nodeRealmHost.fileExists = (fileName) => fileName === nodeRealmRefinementName || ts.sys.fileExists(fileName);
nodeRealmHost.readFile = (fileName) => fileName === nodeRealmRefinementName ? nodeRealmRefinementText : ts.sys.readFile(fileName);
nodeRealmHost.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) => fileName === nodeRealmRefinementName
  ? ts.createSourceFile(fileName, nodeRealmRefinementText, languageVersion, true)
  : defaultNodeRealmGetSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile);
const nodeRealmProgram = ts.createProgram([nodeRealmRefinementName], nodeRealmCompilerOptions, nodeRealmHost);
const nodeRealmSource = nodeRealmProgram.getSourceFile(nodeRealmRefinementName)!;
const nodeRealmSpec = parseSpec(nodeRealmRefinementName, nodeRealmRefinementText).temporal;
const nodeRealmChild = nodeRealmSource.statements.find((statement): statement is ts.FunctionDeclaration =>
  ts.isFunctionDeclaration(statement) && statement.name?.text === "incrementChild")!;
const nodeRealmExternalActions = new Map([[
  `${nodeRealmRefinementName}:${nodeRealmChild.getStart(nodeRealmSource)}`,
  {
    adapterName: "counter", version: "1", modelName: "increment", exportName: "incrementChild",
    runtimeIdentity: {
      kind: "host" as const, host: "node" as const, root: "global" as const,
      version: "24", realm: "main", identity: "node:24:realm:main.global",
    },
    assignments: [{
      target: "count",
      expressionAst: {
        kind: "binary" as const, operator: "add" as const,
        left: { kind: "name" as const, name: "count" }, right: { kind: "integer" as const, value: 1n },
      },
    }],
    evidence: "verified" as const,
  },
]]);
const compilerHost = ts.createCompilerHost(compilerOptions);
const defaultGetSourceFile = compilerHost.getSourceFile.bind(compilerHost);
compilerHost.fileExists = (fileName) => fileName === typedIntegerSourceName || ts.sys.fileExists(fileName);
compilerHost.readFile = (fileName) => fileName === typedIntegerSourceName ? typedIntegerSourceText : ts.sys.readFile(fileName);
compilerHost.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) => fileName === typedIntegerSourceName
  ? ts.createSourceFile(fileName, typedIntegerSourceText, languageVersion, true)
  : defaultGetSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile);
const typedIntegerProgram = ts.createProgram([typedIntegerSourceName], compilerOptions, compilerHost);
const typedIntegerSource = typedIntegerProgram.getSourceFile(typedIntegerSourceName)!;
const domPropertySourceName = "/bench/dom-properties.ts";
const domPropertySourceText = Array.from({ length: 64 }, (_, index) => `
  /* uneffect:effect Dom<PropertyRead, typeof input> | Dom<PropertyWrite, typeof input> | Mutate<typeof input> | Dom<AttributeRead, typeof element> | Dom<AttributeWrite, typeof element> | Dom<NodeRead, typeof element> | Dom<NodeWrite, typeof element> | Dom<TextRead, typeof element> | Dom<TextWrite, typeof element> | Dom<LayoutRead, typeof element> | Dom<Create, typeof element> | Dom<Parse, typeof element> | Dom<NodeWrite, typeof element.parentNode> | Dom<Parse, typeof element.parentNode> | Mutate<typeof element.parentNode> | Mutate<typeof element> | InvokeUserCode | Dom<TextRead, typeof data> | Dom<TextWrite, typeof data> | Mutate<typeof data> */
  function update${index}(input: HTMLInputElement, element: Element, data: CharacterData) {
    input.value += "${index}"; data.data += input["value"]; data.replaceData(0, 0, "")
    const attrs = element.attributes; attrs.getNamedItem("data-active"); attrs.removeNamedItem("data-stale")
    element.toggleAttribute("data-active", element.hasAttribute("data-active")); element.normalize()
    element.innerHTML += "<span></span>"
    element.outerHTML = "<section></section>"
    return [element.cloneNode(false), element.attributes, element.children, element.clientWidth, element.contains(element.firstChild), data.substringData(0, 1)]
  }
`).join("\n");
const domCompilerOptions: ts.CompilerOptions = { ...compilerOptions, lib: ["lib.es2024.d.ts", "lib.dom.d.ts"] };
const domCompilerHost = ts.createCompilerHost(domCompilerOptions);
const defaultDomGetSourceFile = domCompilerHost.getSourceFile.bind(domCompilerHost);
domCompilerHost.fileExists = (fileName) => fileName === domPropertySourceName || ts.sys.fileExists(fileName);
domCompilerHost.readFile = (fileName) => fileName === domPropertySourceName ? domPropertySourceText : ts.sys.readFile(fileName);
domCompilerHost.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) => fileName === domPropertySourceName
  ? ts.createSourceFile(fileName, domPropertySourceText, languageVersion, true)
  : defaultDomGetSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile);
const domPropertyProgram = ts.createProgram([domPropertySourceName], domCompilerOptions, domCompilerHost);
const domPropertySource = domPropertyProgram.getSourceFile(domPropertySourceName)!;
const explicitCatchSourceName = "/bench/explicit-catch-ownership.ts";
const explicitCatchCompilerHost = ts.createCompilerHost(compilerOptions);
const defaultExplicitCatchGetSourceFile = explicitCatchCompilerHost.getSourceFile.bind(explicitCatchCompilerHost);
explicitCatchCompilerHost.fileExists = (fileName) => fileName === explicitCatchSourceName || ts.sys.fileExists(fileName);
explicitCatchCompilerHost.readFile = (fileName) => fileName === explicitCatchSourceName ? explicitCatchOwnershipSource : ts.sys.readFile(fileName);
explicitCatchCompilerHost.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) => fileName === explicitCatchSourceName
  ? ts.createSourceFile(fileName, explicitCatchOwnershipSource, languageVersion, true)
  : defaultExplicitCatchGetSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile);
const explicitCatchProgram = ts.createProgram([explicitCatchSourceName], compilerOptions, explicitCatchCompilerHost);
const explicitCatchSource = explicitCatchProgram.getSourceFile(explicitCatchSourceName)!;

describe("refinement receiver identity", () => {
  bench("syntax-only Node Lease collection actions", () => {
    validateRefinementActionBodies(leaseAuthorityFile, leaseAuthoritySource, "leaseAuthority", leaseAuthoritySpec);
  }, { time: 500, iterations: 20 });

  bench("warm TypeChecker Node Lease collection actions", () => {
    validateRefinementActionBodiesInProgram(leaseAuthorityProgram, leaseAuthorityFile, "leaseAuthority", leaseAuthoritySpec);
  }, { time: 500, iterations: 20 });

  bench("export verified project refinement summaries with provenance", () => {
    const project: TypeScriptProject = {
      projectFile: "/bench/tsconfig.json", fileNames: [leaseAuthorityFile],
      compilerOptions: leaseAuthorityProgram.getCompilerOptions(), projectReferences: [],
      provenance: {
        projectFile: "/bench/tsconfig.json",
        compiler: {
          analyzerVersion: ts.version, analyzerPackageFile: "/bench/typescript/package.json",
          consumerVersion: ts.version, consumerPackageFile: "/bench/typescript/package.json",
          consumerModuleFile: "/bench/typescript/index.js", parity: "exact",
        },
      },
    };
    analyzeProjectRefinements(leaseAuthorityProgram, project, new Map());
  }, { time: 500, iterations: 20 });

  bench("compose two same-realm project refinement helpers", () => {
    const result = composeWorkspaceRefinements(
      indirectRefinementProgram, indirectRefinementCurrent, [indirectRefinementCompleted],
      new Map([[indirectRefinementParentName, [indirectRefinementManifest]]]),
    );
    if (result.links[0]?.callPath.length !== 4 || result.links[0]?.guard !== "armed"
      || result.links[0]?.helperDepthBudget !== 2
      || result.links[0]?.runtimeIdentity?.identity !== "ecmascript:realm.globalThis"
      || result.blockers.length > 0) {
      throw new Error("indirect refinement benchmark fixture did not compose");
    }
  }, { time: 500, iterations: 20 });

  bench("validate a labeled Node realm against warm TypeChecker evidence", () => {
    const diagnostics = validateRefinementActionBodiesInProgram(
      nodeRealmProgram, nodeRealmRefinementName, "counter", nodeRealmSpec,
      { externalActions: nodeRealmExternalActions },
      nodeRealmRefinementManifest,
    );
    if (diagnostics.length > 0) throw new Error(diagnostics.map(({ message }) => message).join("; "));
  }, { time: 500, iterations: 20 });
});

describe("DOM property effect inference", () => {
  bench("analyze 64 warm categorized DOM contracts", () => {
    analyzeEffectsInProgram(domPropertyProgram, domPropertySource);
  }, { time: 500, iterations: 20 });
});

describe("typed-array static verification", () => {
  bench("summarize function and module effects across uneffect src", () => {
    analyzeProgramEffects(uneffectEffectProgram, { requireAnnotations: false });
  }, { time: 3_000, iterations: 3 });

  bench("empty source", async () => {
    await verifyTypedArraySafety("empty.ts", "export {}\n");
  }, { time: 500, iterations: 20 });

  bench("128 chained scalar constants", async () => {
    await verifyTypedArraySafety("constants.ts", `${chainedConstants}\n`);
  }, { time: 500, iterations: 20 });

  bench("SHA-256-sized U32 table", async () => {
    await verifyTypedArraySafety("sha-table.ts", `const K = u32Table([${SHA256_K}] as const)\n`);
  }, { time: 500, iterations: 20 });

  bench("256 verified constant-table reads", async () => {
    await verifyTypedArraySafety("sha-reads.ts", `
      const K = u32Table([${SHA256_K}] as const)
      function rounds() { ${indexedReads} }
    `);
  }, { time: 500, iterations: 20 });

  bench("import and barrel resolution across 3 files", async () => {
    await verifyTypedArraySafetyInProgram({
      "/src/constants.ts": `export const SHA_K = u32Table([${SHA256_K}] as const)`,
      "/src/barrel.ts": `export { SHA_K as ROUND_CONSTANTS } from "./constants.js"`,
      "/src/round.ts": `
        import { ROUND_CONSTANTS as K } from "./barrel.js"
        function rounds() { ${indexedReads} }
      `,
    });
  }, { time: 500, iterations: 20 });

  bench("namespace import resolution across 2 files", async () => {
    await verifyTypedArraySafetyInProgram({
      "/src/constants.ts": `export const K = u32Table([${SHA256_K}] as const)`,
      "/src/round.ts": `import * as Tables from "./constants.js"; function rounds() { ${indexedReads.replaceAll("K[", "Tables.K[")} }`,
    });
  }, { time: 500, iterations: 20 });

  bench("U32 table composed from 8 verified spreads", async () => {
    await verifyTypedArraySafety("composed.ts", `
      const PART = u32Table([${SHA256_K.split(",").slice(0, 8).join(",")}] as const)
      const K = u32Table([...PART, ...PART, ...PART, ...PART, ...PART, ...PART, ...PART, ...PART] as const)
    `);
  }, { time: 500, iterations: 20 });

  bench("256 inferred Math.floor integer writes", async () => {
    await verifyTypedArraySafety("integer-casts.ts", `
      import type { BoundedUint8Array, U8 } from "@mizchi/uneffect"
      function write(output: BoundedUint8Array<256>, input: U8) { ${inferredIntegerWrites} }
    `);
  }, { time: 500, iterations: 20 });

  bench("256 aliased integer casts with TypeChecker identity", async () => {
    await verifyTypedArraySafetyInTypeScriptProgram(typedIntegerProgram, typedIntegerSource);
  }, { time: 500, iterations: 20 });

  bench("64 bounded DataView writes", async () => {
    await verifyTypedArraySafety("data-view.ts", `
      type U32 = number
      type BoundedDataView<N extends number> = DataView
      function write(view: BoundedDataView<256>, word: U32) { ${boundedDataViewWrites} }
    `);
  }, { time: 500, iterations: 20 });

  bench("DNS header DataView codec dogfood", async () => {
    await verifyTypedArraySafety("binary-codec.ts", dnsCodecSource);
  }, { time: 500, iterations: 20 });

  bench("compose Worker transfer with DataView proof", async () => {
    await verifyUneffectProject({ files: { "worker-codec-transfer.ts": workerCodecTransferSource } });
  }, { time: 500, iterations: 5 });

  bench("check telemetry Promise ownership across switch and finally", () => {
    analyzeAsyncSafety("telemetry-delivery.ts", telemetryDeliverySource);
  }, { time: 500, iterations: 20 });

  bench("check initialized telemetry Promise ownership baseline", () => {
    analyzeAsyncSafety("telemetry-delivery.ts", initializedTelemetryDeliverySource);
  }, { time: 500, iterations: 20 });

  bench("route 64 structured throw completions through Promise ownership catches", () => {
    analyzeAsyncSafetyInProgram(explicitCatchProgram, explicitCatchSource);
  }, { time: 1_500, iterations: 50 });

  bench("join 64 loop-local awaited catch retries", () => {
    analyzeAsyncSafety("loop-catch-ownership.ts", `declare function task(): Promise<number>\ndeclare function recordAttempt(value: number): void\n${loopCatchOwnershipSource}`);
  }, { time: 1_500, iterations: 50 });

  bench("link Promise adapter assimilation by symbol", () => {
    analyzePromiseChains("promise-adapter.ts", promiseAdapterSource);
  }, { time: 500, iterations: 5 });

  bench("classify dynamic and external thenable assimilation", () => {
    analyzePromiseChains("dynamic-thenables.ts", dynamicThenableSource);
  }, { time: 500, iterations: 5 });

  bench("resolve forwarded Proxy then trap dogfood", () => {
    analyzePromiseChains("examples/dogfood/promise-routing.ts", readFileSync("examples/dogfood/promise-routing.ts", "utf8"));
  }, { time: 500, iterations: 20 });

  bench("classify mixed Promise combinator elements", () => {
    analyzeAsyncPatterns("mixed-promise-batch.ts", mixedPromiseBatchSource);
  }, { time: 500, iterations: 5 });

  bench("enumerate a bounded 32-path Promise iterable", () => {
    analyzeAsyncPatterns("finite-promise-path-product.ts", finitePromisePathProductSource);
  }, { time: 500, iterations: 5 });

  bench("analyze AbortSignal fetch deadline", () => {
    analyzeAsyncPatterns("fetch-timeout.ts", fetchTimeoutSource);
  }, { time: 500, iterations: 5 });

  bench("audit cross-domain trusted telemetry assumptions", async () => {
    await verifyUneffectProject({
      files: { "telemetry-packet.ts": telemetryPacketSource },
      assumptionPolicy: {
        requireOwner: true,
        requireExpiration: true,
        denyExpired: true,
        allowUnboundedDomains: ["builtin"],
        asOf: "2026-08-21",
      },
    });
  }, { time: 500, iterations: 5 });

  bench("lower bounded target-aware retry cleanup", () => {
    const result = analyzeAsyncSafety("target-aware-retry-cleanup.ts", targetAwareRetryCleanupSource);
    generateUnifiedAsyncQuint("target_aware_retry_cleanup", result, "deliverWithRetry");
  }, { time: 500, iterations: 20 });

  bench("lower bounded target-aware break cleanup", () => {
    const result = analyzeAsyncSafety("target-aware-break-cleanup.ts", targetAwareBreakCleanupSource);
    generateUnifiedAsyncQuint("target_aware_break_cleanup", result, "deliverUntilStop");
  }, { time: 500, iterations: 20 });

  bench("lower caught rejection through mixed disposal", () => {
    const result = analyzeAsyncSafety("rejected-await-multiple-disposal.ts", rejectedAwaitMultipleDisposalSource);
    generateUnifiedAsyncQuint("rejected_await_multiple_disposal", result, "deliverWithRecovery");
  }, { time: 500, iterations: 20 });

  bench("lower nested caught awaits through scoped cleanup", () => {
    const result = analyzeAsyncSafety("nested-rejection-cleanup.ts", nestedRejectionCleanupSource);
    generateUnifiedAsyncQuint("nested_rejection_cleanup", result, "deliverNested");
  }, { time: 500, iterations: 20 });

  bench("lower caught inner disposal rejection through handler", () => {
    const result = analyzeAsyncSafety("caught-disposal-rejection.ts", caughtDisposalRejectionSource);
    generateUnifiedAsyncQuint("caught_disposal_rejection", result, "deliverAfterDisposal");
  }, { time: 500, iterations: 20 });

  bench("lower two failing disposals through suppression handler", () => {
    const result = analyzeAsyncSafety("suppressed-disposal-rejections.ts", suppressedDisposalRejectionsSource);
    generateUnifiedAsyncQuint("suppressed_disposal_rejections", result, "deliverWithSuppression");
  }, { time: 500, iterations: 20 });

  bench("lower branch-correlated cleanup through shared handler", () => {
    const result = analyzeAsyncSafety("branch-correlated-cleanup.ts", branchCorrelatedCleanupSource);
    generateUnifiedAsyncQuint("branch_correlated_cleanup", result, "deliverSelected");
  }, { time: 500, iterations: 20 });

  bench("lower exhaustive switch cleanup through shared handler", () => {
    const result = analyzeAsyncSafety("switch-correlated-cleanup.ts", switchCorrelatedCleanupSource);
    generateUnifiedAsyncQuint("switch_correlated_cleanup", result, "deliverByRoute");
  }, { time: 500, iterations: 20 });

  bench("lower nested Boolean cleanup through shared handler", () => {
    const result = analyzeAsyncSafety("nested-branch-correlated-cleanup.ts", nestedBranchCorrelatedCleanupSource);
    generateUnifiedAsyncQuint("nested_branch_correlated_cleanup", result, "deliverNestedChoice");
  }, { time: 500, iterations: 20 });

  bench("lower mixed switch and Boolean cleanup through shared handler", () => {
    const result = analyzeAsyncSafety("mixed-decision-correlated-cleanup.ts", mixedDecisionCorrelatedCleanupSource);
    generateUnifiedAsyncQuint("mixed_decision_correlated_cleanup", result, "deliverMixedChoice");
  }, { time: 500, iterations: 20 });

  bench("lower sequential decision cleanup through an intermediate join", () => {
    const result = analyzeAsyncSafety("sequential-decision-cleanup.ts", sequentialDecisionCleanupSource);
    generateUnifiedAsyncQuint("sequential_decision_cleanup", result, "deliverSequential");
  }, { time: 500, iterations: 20 });

  bench("lower non-uniform return through cleanup and mandatory finally", () => {
    const result = analyzeAsyncSafety("nonuniform-return-cleanup.ts", nonUniformReturnCleanupSource);
    generateUnifiedAsyncQuint("nonuniform_return_cleanup", result, "deliverNonUniform");
  }, { time: 500, iterations: 20 });

  bench("lower non-uniform typed throw through cleanup, catch, and finally", () => {
    const result = analyzeAsyncSafety("nonuniform-throw-cleanup.ts", nonUniformThrowCleanupSource);
    generateUnifiedAsyncQuint("nonuniform_throw_cleanup", result, "deliverNonUniformThrow");
  }, { time: 500, iterations: 20 });

  bench("lower conditional resource generations across a bounded outer loop", () => {
    const result = analyzeAsyncSafety("conditional-loop-resource-generations.ts", conditionalLoopResourceGenerationsSource);
    generateUnifiedAsyncQuint("conditional_loop_resource_generations", result, "deliverConditionalGenerations");
  }, { time: 500, iterations: 20 });

  bench("lower a resource-free dynamic outer continue", () => {
    const result = analyzeAsyncSafety("dynamic-outer-continue.ts", dynamicOuterContinueSource);
    generateUnifiedAsyncQuint("dynamic_outer_continue", result, "deliver");
  }, { time: 500, iterations: 20 });

  bench("parse, lint, and generate flattened Node Lease Quint", () => {
    const temporal = parseSpec("lease.ts", `/* uneffect: clock realNow: 1 */ /* uneffect: state leaseExpiryA: int */ /* uneffect: state localDeadlineA: int */ /* uneffect: state ownerEpoch: int */ /* uneffect: state residentEpochA: int */ /* uneffect: state residentEpochB: int */ /* uneffect: state ownerIsA: bool */ /* uneffect: init leaseExpiryA = 10 */ /* uneffect: init localDeadlineA = 10 */ /* uneffect: init ownerEpoch = 1 */ /* uneffect: init residentEpochA = 1 */ /* uneffect: init residentEpochB = 0 */ /* uneffect: init ownerIsA = true */ /* uneffect: action takeoverB: ownerIsA' = false, ownerEpoch' = ownerEpoch + 1 */ /* uneffect: action_when takeoverB: ownerIsA && realNow + 1 >= leaseExpiryA + 1 */ /* uneffect: action publishB: residentEpochB' = ownerEpoch */ /* uneffect: action_when publishB: !ownerIsA && residentEpochB !== ownerEpoch */ /* uneffect:always singleWriter: !(residentEpochA > 0 && realNow < localDeadlineA && residentEpochB > 0) */`).temporal;
    lintTemporalSpec(temporal);
    generateQuint("node_lease", temporal);
  }, { time: 500, iterations: 20 });

  bench("solver-lint 5 temporal properties and one guarded action", async () => {
    const temporal = parseSpec("semantic-lint.ts", `/* uneffect: state epoch: int */ /* uneffect: state ready: bool */ /* uneffect: init epoch = 0 */ /* uneffect: init ready = false */ /* uneffect: action publish: ready' = true */ /* uneffect: action_when publish: epoch >= 0 */ /* uneffect:always nonnegative: epoch >= 0 */ /* uneffect:always positive: epoch > 0 */ /* uneffect:always bounded: epoch >= 0 && epoch < 100 */ /* uneffect:always totalOrder: epoch > 0 || epoch <= 0 */ /* uneffect:always readyAfterPublish: ready || !ready */`).temporal;
    await lintTemporalSpecWithZ3(temporal);
  }, { time: 500, iterations: 1 });

  bench("bounded reachability lint for 3 actions over 4 steps", async () => {
    const temporal = parseSpec("reachability.ts", `/* uneffect: state phase: int */ /* uneffect: init phase = 0 */ /* uneffect: action advance: phase' = 1 */ /* uneffect: action_when advance: phase === 0 */ /* uneffect: action finish: phase' = 2 */ /* uneffect: action_when finish: phase === 1 */ /* uneffect: action never: phase' = 3 */ /* uneffect: action_when never: phase === 99 */`).temporal;
    await lintTemporalReachabilityWithZ3(temporal, { maxSteps: 4 });
  }, { time: 500, iterations: 1 });

  bench("synthesize a scaled affine capacity invariant", async () => {
    const temporal = parseSpec("scaled-capacity.ts", readFileSync(new URL("../examples/dogfood/telemetry-capacity.ts", import.meta.url), "utf8")).temporal;
    await lintTemporalReachabilityWithZ3(temporal, {
      maxSteps: 2,
      synthesizeRelationalStrengtheningProperties: true,
      relationalStrengtheningMaxCoefficient: 3,
  });

  }, { time: 2_000, iterations: 1 });

  bench("synthesize a pairwise affine quota conservation invariant", async () => {
    const temporal = parseSpec("telemetry-quota.ts", readFileSync(new URL("../examples/dogfood/telemetry-quota.ts", import.meta.url), "utf8")).temporal;
    await lintTemporalReachabilityWithZ3(temporal, {
      maxSteps: 2,
      synthesizeRelationalStrengtheningProperties: true,
    });
  }, { time: 2_000, iterations: 1 });

  bench("synthesize a weighted multi-variable conservation invariant", async () => {
    const temporal = parseSpec("telemetry-weighted-accounting.ts", readFileSync(new URL("../examples/dogfood/telemetry-weighted-accounting.ts", import.meta.url), "utf8")).temporal;
    await lintTemporalReachabilityWithZ3(temporal, {
      maxSteps: 2,
      synthesizeRelationalStrengtheningProperties: true,
    });
  }, { time: 2_000, iterations: 1 });

  bench("synthesize a multi-variable fixed budget invariant", async () => {
    const temporal = parseSpec("request-capacity.ts", readFileSync(new URL("../examples/dogfood/request-capacity.ts", import.meta.url), "utf8")).temporal;
    await lintTemporalReachabilityWithZ3(temporal, {
      maxSteps: 2,
      synthesizeRelationalStrengtheningProperties: true,
    });
  }, { time: 2_000, iterations: 1 });

  bench("synthesize a three-counter conservation invariant", async () => {
    const temporal = parseSpec("telemetry-accounting.ts", readFileSync(new URL("../examples/dogfood/telemetry-accounting.ts", import.meta.url), "utf8")).temporal;
    await lintTemporalReachabilityWithZ3(temporal, {
      maxSteps: 2,
      synthesizeRelationalStrengtheningProperties: true,
    });
  }, { time: 500, iterations: 1 });

  bench("synthesize a four-counter conservation invariant", async () => {
    const temporal = parseSpec("telemetry-routing-accounting.ts", readFileSync(new URL("../examples/dogfood/telemetry-routing-accounting.ts", import.meta.url), "utf8")).temporal;
    await lintTemporalReachabilityWithZ3(temporal, {
      maxSteps: 2,
      synthesizeRelationalStrengtheningProperties: true,
      relationalStrengtheningMaxArity: 4,
    });
  }, { time: 500, iterations: 1 });

  bench("bounded vacuity lint for one frozen-state property", async () => {
    const temporal = parseSpec("vacuity.ts", `/* uneffect: state phase: int */ /* uneffect: state counter: int */ /* uneffect: init phase = 0 */ /* uneffect: init counter = 0 */ /* uneffect: action tick: counter' = counter + 1 */ /* uneffect:always phaseFixed: phase === 0 */`).temporal;
    await lintTemporalReachabilityWithZ3(temporal, { maxSteps: 4 });
  }, { time: 500, iterations: 1 });

  bench("extract a bounded 11-step Node Lease Z3 counterexample", async () => {
    const temporal = parseSpec("lease-counterexample.ts", `/* uneffect: clock realNow: 1 */ /* uneffect: state leaseExpiryA: int */ /* uneffect: state localDeadlineA: int */ /* uneffect: state ownerEpoch: int */ /* uneffect: state residentEpochA: int */ /* uneffect: state residentEpochB: int */ /* uneffect: state ownerIsA: bool */ /* uneffect: init leaseExpiryA = 10 */ /* uneffect: init localDeadlineA = 10 */ /* uneffect: init ownerEpoch = 1 */ /* uneffect: init residentEpochA = 1 */ /* uneffect: init residentEpochB = 0 */ /* uneffect: init ownerIsA = true */ /* uneffect: action takeoverB: ownerIsA' = false, ownerEpoch' = ownerEpoch + 1 */ /* uneffect: action_when takeoverB: ownerIsA && realNow + 1 >= leaseExpiryA */ /* uneffect: action publishB: residentEpochB' = ownerEpoch */ /* uneffect: action_when publishB: !ownerIsA && residentEpochB !== ownerEpoch */ /* uneffect:always singleWriter: !(residentEpochA > 0 && realNow < localDeadlineA && residentEpochB > 0) */`).temporal;
    await findTemporalCounterexampleWithZ3(temporal, "singleWriter", { maxSteps: 12 });
  }, { time: 500, iterations: 1 });

  bench("lower a node-indexed Set/Map lease model to Quint", () => {
    const temporal = parseSpec("lease-set.ts", `/* uneffect: clock realNow: 1 */ /* uneffect: state nodes: Set<int> */ /* uneffect: state activeWriters: Set<int> */ /* uneffect: state residentEpochs: Map<int, int> */ /* uneffect: init nodes = Set(1, 2) */ /* uneffect: init activeWriters = Set(1) */ /* uneffect: init residentEpochs = Map([[1, 1], [2, 0]]) */ /* uneffect: action publish: activeWriters' = activeWriters.union(Set(2)), residentEpochs' = residentEpochs.put(2, 2) */ /* uneffect:always writersAreNodes: activeWriters.forall(node => nodes.contains(node)) */ /* uneffect:always epochsAreNonNegative: residentEpochs.values().forall(epoch => epoch >= 0) */`).temporal;
    generateQuint("lease_set", temporal);
  }, { time: 500, iterations: 20 });

  bench("generate 16 scalar contract property tests", () => {
    const functions = Array.from({ length: 16 }, (_, index) => `
      /* uneffect:requires denominator > 0 */
      /* uneffect:ensures result * denominator <= numerator */
      export function quotient${index}(numerator: Nat, denominator: Int): Int {
        return Math.floor(numerator / denominator) as Int
      }
    `).join("\n");
    generateUneffectPropertyTests({ files: { "src/properties.ts": `import type { Int, Nat } from "@mizchi/uneffect"\n${functions}` }, shrinking: true });
  }, { time: 500, iterations: 20 });

  bench("generate 16 bounded-array and literal-union property tests", () => {
    const functions = Array.from({ length: 16 }, (_, index) => `
      /* uneffect:ensures result >= 0 */
      export function packet${index}(bytes: BoundedUint8Array<64>, mode: "fast" | "safe"): Nat {
        return (bytes.length + mode.length) as Nat
      }
    `).join("\n");
    generateUneffectPropertyTests({ files: { "src/packets.ts": `import type { BoundedUint8Array, Nat } from "@mizchi/uneffect"\n${functions}` }, shrinking: true });
  }, { time: 500, iterations: 20 });

  bench("generate 16 explicit user-predicate property specializations", () => {
    const functions = Array.from({ length: 16 }, (_, index) => `
      export function metricPredicate${index}(value: string): boolean { return /^[a-z][a-z0-9_.]{0,31}$/.test(value) }
      /* uneffect:requires metricPredicate${index}(name) */
      /* uneffect:ensures result === name */
      export function metric${index}(name: string): string { return name }
    `).join("\n");
    const predicateSpecializations = Object.fromEntries(Array.from({ length: 16 }, (_, index) => [
      `src/metrics.ts:metricPredicate${index}`,
      { version: "uneffect-property-predicate/v1" as const, values: ["bad space", "requests.total", "a"] },
    ]));
    generateUneffectPropertyTests({ files: { "src/metrics.ts": functions }, predicateSpecializations, shrinking: true });
  }, { time: 500, iterations: 20 });

  bench("resolve 16 direct cross-file predicate specializations", () => {
    const predicates = Array.from({ length: 16 }, (_, index) =>
      `export function metricPredicate${index}(value: string): boolean { return /^[a-z]+$/.test(value) }`).join("\n");
    const functions = Array.from({ length: 16 }, (_, index) => `
      import { metricPredicate${index} } from "./metric-predicates.js"
      /* uneffect:requires metricPredicate${index}(name) */
      /* uneffect:ensures result === name */
      export function metric${index}(name: string): string { return name }
    `).join("\n");
    const predicateSpecializations = Object.fromEntries(Array.from({ length: 16 }, (_, index) => [
      `src/metric-predicates.ts:metricPredicate${index}`,
      { version: "uneffect-property-predicate/v1" as const, values: ["bad space", "requests", "a"] },
    ]));
    generateUneffectPropertyTests({
      files: { "src/metric-predicates.ts": predicates, "src/metrics.ts": functions },
      predicateSpecializations,
      shrinking: true,
    });
  }, { time: 500, iterations: 20 });

  bench("derive generator hints for 16 refined scalar contracts", () => {
    const functions = Array.from({ length: 16 }, (_, index) => `
      /* uneffect:requires value >= ${index * 10} && value < ${index * 10 + 10} */
      /* uneffect:ensures result >= ${index * 10} */
      export function range${index}(value: Int): Int { return value }
    `).join("\n");
    generateUneffectPropertyTests({ files: { "src/ranges.ts": `import type { Int } from "@mizchi/uneffect"\n${functions}` }, shrinking: true });
  }, { time: 500, iterations: 20 });

  bench("derive aligned hints for 16 modulo-refined shard contracts", () => {
    const functions = Array.from({ length: 16 }, (_, index) => `
      /* uneffect:requires shard >= ${index * 1024} && shard < ${(index + 1) * 1024} && shard % 16 === 0 */
      /* uneffect:ensures result >= 0 */
      export function shard${index}(shard: Nat): Nat { return shard }
    `).join("\n");
    generateUneffectPropertyTests({ files: { "src/shards.ts": `import type { Nat } from "@mizchi/uneffect"\n${functions}` }, shrinking: true });
  }, { time: 500, iterations: 20 });

  bench("derive branch-local hints for 16 tenant shard contracts", () => {
    const functions = Array.from({ length: 16 }, (_, index) => `
      /* uneffect:requires (shard >= ${index * 256} && shard < ${index * 256 + 32} && shard % 16 === 0) || (shard >= ${index * 256 + 100} && shard < ${index * 256 + 132} && shard % 16 === 4) */
      /* uneffect:ensures result >= 0 */
      export function tenantShard${index}(shard: Nat): Nat { return shard }
    `).join("\n");
    generateUneffectPropertyTests({ files: { "src/tenant-shards.ts": `import type { Nat } from "@mizchi/uneffect"\n${functions}` }, shrinking: true });
  }, { time: 500, iterations: 20 });

  bench("combine congruence hints for 16 partition routing contracts", () => {
    const functions = Array.from({ length: 16 }, (_, index) => `
      /* uneffect:requires partition >= ${index * 256} && partition < ${(index + 1) * 256} && partition % 4 === 1 && partition % 6 === 3 */
      /* uneffect:ensures result >= 0 */
      export function route${index}(partition: Nat): Nat { return partition }
    `).join("\n");
    generateUneffectPropertyTests({ files: { "src/partition-routes.ts": `import type { Nat } from "@mizchi/uneffect"\n${functions}` }, shrinking: true });
  }, { time: 500, iterations: 20 });

  bench("derive signed remainder hints for 16 negative partition contracts", () => {
    const functions = Array.from({ length: 16 }, (_, index) => `
      /* uneffect:requires partition >= ${-256 * (index + 1)} && partition < ${-256 * index} && partition % 6 === -3 */
      /* uneffect:ensures result < 0 */
      export function signedRoute${index}(partition: Int): Int { return partition }
    `).join("\n");
    generateUneffectPropertyTests({ files: { "src/signed-routes.ts": `import type { Int } from "@mizchi/uneffect"\n${functions}` }, shrinking: true });
  }, { time: 500, iterations: 20 });

  bench("derive branched affine hints for 16 scalar contracts", () => {
    const functions = Array.from({ length: 16 }, (_, index) => `
      /* uneffect:requires (value + 2 >= ${index * 10} && value + 2 < ${index * 10 + 5}) || (value >= ${index * 10 + 20} && value < ${index * 10 + 25}) */
      /* uneffect:ensures result >= ${index * 10 - 2} */
      export function branched${index}(value: Int): Int { return value }
    `).join("\n");
    generateUneffectPropertyTests({ files: { "src/branched.ts": `import type { Int } from "@mizchi/uneffect"\n${functions}` }, shrinking: true });
  }, { time: 500, iterations: 20 });

  bench("derive correlated affine tuples for 16 three-parameter contracts", () => {
    const functions = Array.from({ length: 16 }, (_, index) => `
      /* uneffect:requires x >= ${index * 10} && x < ${index * 10 + 5} && y === x + 1 && z === y + 2 */
      /* uneffect:ensures result === z */
      export function dependent${index}(x: Int, y: Int, z: Int): Int { return z }
    `).join("\n");
    generateUneffectPropertyTests({ files: { "src/dependent.ts": `import type { Int } from "@mizchi/uneffect"\n${functions}` }, shrinking: true });
  }, { time: 500, iterations: 20 });

  bench("derive nonlinear property tuples with Z3", async () => {
    await generateUneffectPropertyTestsWithZ3({ files: { "src/circle.ts": `
      import type { Int } from "@mizchi/uneffect"
      /* uneffect:requires x >= 0 && y >= 0 && x * x + y * y === 625 */
      /* uneffect:ensures result >= 0 */
      export function radius(x: Int, y: Int): Int { return x + y }
    ` }, solverCases: 8 });
  }, { time: 500, iterations: 1 });

  bench("derive correlated literal-union tuples with JavaScript arithmetic", async () => {
    await generateUneffectPropertyTestsWithZ3({ files: { "src/replicas.ts": `
      /* uneffect:requires replicas >= 4 && (allowLarge || replicas <= 4) && (region === "local" || allowLarge) && signed === -7 && signed / 3 === -2 && signed % 3 === -1 */
      /* uneffect:ensures result >= 4 */
      export function deployment(replicas: 1 | 4 | 9, allowLarge: false | true, region: "local" | "edge", signed: Int): number { return replicas }
    ` }, solverCases: 4 });
  }, { time: 500, iterations: 1 });

  bench("derive nested optional rollout configurations", async () => {
    await generateUneffectPropertyTestsWithZ3({ files: { "src/rollout.ts": `
      type U8 = number
      /* uneffect:requires config.rollout === undefined || (config.rollout.maxReplicas === 9 && (config.rollout.minReplicas === undefined || config.rollout.minReplicas >= 4)) */
      /* uneffect:ensures result >= 0 */
      export function rolloutFloor(config: { rollout?: { minReplicas?: U8; maxReplicas: U8 } }): number { return config.rollout?.minReplicas ?? 0 }
    ` }, solverCases: 8 });
  }, { time: 500, iterations: 1 });

  bench("jointly shrink 64 correlated property tuples", async () => {
    const refinementTuples = Array.from({ length: 64 }, (_, index) => [64 - index, 65 - index]);
    await checkUneffectProperty({
      functionName: "dependent", domains: ["Int", "Int"], refinementTuples, cases: 64,
      precondition: (x, y) => y === x + 1, property: () => false,
    });
  }, { time: 500, iterations: 20 });

  bench("verify an affine contract through external Effect pipe", async () => {
    await verifyUneffectProject({ files: { "src/effect-adapter.ts": `
      import { pipe } from "effect/Function"
      /* uneffect:requires value >= 0 */
      /* uneffect:ensures result > value */
      export function increment(value: number): number { return pipe(value, current => current + 1) }
    ` } });
  }, { time: 500, iterations: 1 });

  bench("verify an external Effect timer adapter with Quint", async () => {
    await verifyUneffectProject({ temporalRuntime: "web", files: { "src/effect-timer.ts": `
      import { pipe } from "effect/Function"
      export function schedule(value: number) {
        setTimeout(() => { const next = pipe(value, current => current + 1); queueMicrotask(() => void next) }, 0)
      }
    ` } });
  }, { time: 500, iterations: 1 });

  bench("model repeated-parent Node timeout instances", () => {
    const model = analyzeAsyncPatterns("repeated-parent-timeout.ts", `
      function schedule() {
        setInterval(() => setTimeout(() => undefined, 5), 1)
        setInterval(() => setInterval(() => undefined, 7), 2)
      }
    `);
    generateNodeEventLoopQuint("repeated_parent_timeout", model);
  }, { time: 500, iterations: 20 });

  bench("model Node ESM top-level microtask ordering", () => {
    const source = `
      import { nextTick } from "node:process"
      Promise.resolve(1).then(value => value + 1)
      queueMicrotask(() => undefined)
      nextTick(() => undefined)
    `;
    generateNodeEventLoopQuint("node_esm_top_level", analyzeAsyncPatterns("node-esm.ts", source), {
      topLevelMode: "esm",
    }, analyzePromiseChains("node-esm.ts", source));
  }, { time: 500, iterations: 20 });

  bench("verify a Web callback temporal product with Quint", async () => {
    const entry = "examples/dogfood/telemetry-once.ts";
    await verifyUneffectProject({ temporalRuntime: "web", files: { [entry]: readFileSync(entry, "utf8") } });
  }, { time: 500, iterations: 1 });

  bench("lower generation-safe retry resources to unified Quint", () => {
    const result = analyzeAsyncSafety("retry-attempts.ts", retryAttemptsSource);
    generateUnifiedAsyncQuint("retry_attempts", result, "flushWithRetry");
  }, { time: 500, iterations: 20 });

  bench("detect retry resource use, value, closure, and retention escapes", () => {
    const program = createAsyncSafetyBenchmarkProgram();
    analyzeAsyncSafetyInProgram(program, program.getSourceFile(retryAttemptEscapeFile)!);
  }, { time: 500, iterations: 20 });

  bench("lower retry alias generations to unified Quint", () => {
    const program = createAsyncSafetyBenchmarkProgram();
    const result = analyzeAsyncSafetyInProgram(program, program.getSourceFile(retryAttemptEscapeFile)!);
    generateUnifiedAsyncQuint("retry_alias_generations", result, "brokenRetry");
  }, { time: 500, iterations: 20 });

  bench("lower shared retry alias generations to unified Quint", () => {
    const result = analyzeAsyncSafety("shared-retry-aliases.ts", `
      interface Resource { send(): void; [Symbol.asyncDispose](): Promise<void> }
      declare function open(): Resource
      async function retry(enabled: boolean) {
        let first: Resource | undefined
        let second: Resource | undefined
        while (enabled) {
          await using resource = open()
          first = resource
          second = resource
          await Promise.resolve("tick").then((value) => value)
        }
        first?.send()
        second?.send()
      }
    `);
    generateUnifiedAsyncQuint("shared_retry_alias_generations", result, "retry");
  }, { time: 500, iterations: 20 });

  bench("lower nested retry alias generations to unified Quint", () => {
    const result = analyzeAsyncSafety("nested-retry-aliases.ts", `
      interface Resource { send(): void; [Symbol.asyncDispose](): Promise<void> }
      declare function open(): Resource
      async function retry(outerEnabled: boolean, innerEnabled: boolean) {
        let outerAlias: Resource | undefined
        let innerAlias: Resource | undefined
        while (outerEnabled) {
          await using outerResource = open()
          outerAlias = outerResource
          while (innerEnabled) {
            await using innerResource = open()
            innerAlias = innerResource
            await Promise.resolve("tick").then((value) => value)
          }
        }
        innerAlias?.send()
        outerAlias?.send()
      }
    `);
    generateUnifiedAsyncQuint("nested_retry_alias_generations", result, "retry");
  }, { time: 500, iterations: 20 });

  bench("lower conditional retry alias generations to unified Quint", () => {
    const result = analyzeAsyncSafety("conditional-retry-aliases.ts", `
      interface Resource { send(): void; [Symbol.asyncDispose](): Promise<void> }
      declare function open(): Resource
      async function retry(enabled: boolean, keepFirst: boolean) {
        let first: Resource | undefined
        let latest: Resource | undefined
        while (enabled) {
          await using resource = open()
          if (keepFirst) first = resource
          else latest = resource
          await Promise.resolve("tick").then((value) => value)
        }
        first?.send()
        latest?.send()
      }
    `);
    generateUnifiedAsyncQuint("conditional_retry_alias_generations", result, "retry");
  }, { time: 500, iterations: 20 });

  bench("lower try-catch retry alias generations to unified Quint", () => {
    const result = analyzeAsyncSafety("try-catch-retry-aliases.ts", `
      interface Resource { send(): void; [Symbol.asyncDispose](): Promise<void> }
      declare function open(): Resource
      declare function mayThrow(): void
      async function retry(enabled: boolean) {
        let success: Resource | undefined
        let failure: Resource | undefined
        while (enabled) {
          await using resource = open()
          try { mayThrow(); success = resource }
          catch { failure = resource }
          await Promise.resolve("tick").then((value) => value)
        }
        success?.send()
        failure?.send()
      }
    `);
    generateUnifiedAsyncQuint("try_catch_retry_alias_generations", result, "retry");
  }, { time: 500, iterations: 20 });

  bench("lower getter-risk retry alias generations to unified Quint", () => {
    const result = analyzeAsyncSafety("getter-retry-aliases.ts", `
      interface Resource { send(): void; [Symbol.asyncDispose](): Promise<void> }
      declare function open(): Resource
      class Gate { get ready(): boolean { return true } }
      declare const gate: Gate
      const gateKey = "ready" as const
      async function retry(enabled: boolean) {
        let success: Resource | undefined
        let failure: Resource | undefined
        while (enabled) {
          await using resource = open()
          try { gate[gateKey]; success = resource }
          catch { failure = resource }
          await Promise.resolve("tick").then((value) => value)
        }
        success?.send()
        failure?.send()
      }
    `);
    generateUnifiedAsyncQuint("getter_retry_alias_generations", result, "retry");
  }, { time: 500, iterations: 20 });

  bench("lower proxy-risk retry alias generations to unified Quint", () => {
    const result = analyzeAsyncSafety("proxy-retry-aliases.ts", `
      interface Resource { send(): void; [Symbol.asyncDispose](): Promise<void> }
      declare function open(): Resource
      const gate = new Proxy({ ready: true }, { get: Reflect.get })
      const forwarded = gate
      async function retry(enabled: boolean) {
        let success: Resource | undefined
        let failure: Resource | undefined
        while (enabled) {
          await using resource = open()
          try { forwarded.ready; success = resource }
          catch { failure = resource }
          await Promise.resolve("tick").then((value) => value)
        }
        success?.send()
        failure?.send()
      }
    `);
    generateUnifiedAsyncQuint("proxy_retry_alias_generations", result, "retry");
  }, { time: 500, iterations: 20 });

  bench("resolve proxy-factory retry alias generations", () => {
    const result = analyzeAsyncSafety("proxy-factory-retry-aliases.ts", `
      interface Resource { send(): void; [Symbol.asyncDispose](): Promise<void> }
      declare function open(): Resource
      declare const primary: boolean
      function createGate() {
        if (primary) return new Proxy({ ready: true }, { get: Reflect.get })
        return new Proxy({ ready: false }, { get: Reflect.get })
      }
      const wrapGate = () => createGate()
      function forward<T>(value: T): T { return value }
      function select<T>(mode: "proxy" | "plain", enabled: boolean, value: T): T | { ready: boolean } {
        return mode === "proxy" && enabled ? value : { ready: true }
      }
      const gate = forward(select("proxy", true, wrapGate()))
      async function retry(enabled: boolean) {
        let success: Resource | undefined
        let failure: Resource | undefined
        while (enabled) {
          await using resource = open()
          try { gate.ready; success = resource }
          catch { failure = resource }
          await Promise.resolve("tick").then((value) => value)
        }
        success?.send()
        failure?.send()
      }
    `);
    generateUnifiedAsyncQuint("proxy_factory_retry_alias_generations", result, "retry");
  }, { time: 500, iterations: 20 });

  bench("construct the retry resource TypeScript Program", () => {
    createAsyncSafetyBenchmarkProgram();
  }, { time: 500, iterations: 20 });

  bench("walk a warm retry resource TypeScript Program", () => {
    analyzeAsyncSafetyInProgram(warmAsyncSafetyProgram, warmAsyncSafetySource);
  }, { time: 500, iterations: 20 });

  bench("analyze grouped resource-release switch dogfood", () => {
    analyzeAsyncSafety("examples/dogfood/grouped-resource-release.ts", readFileSync("examples/dogfood/grouped-resource-release.ts", "utf8"));
  }, { time: 500, iterations: 5 });

  bench("join loop resource alias clear through finally", () => {
    const fileName = "examples/dogfood/upload-session-finally.ts";
    analyzeAsyncSafety(fileName, readFileSync(fileName, "utf8"));
  }, { time: 500, iterations: 20 });

  bench("resolve 64 named timer callback bodies", () => {
    const callbacks = Array.from({ length: 64 }, (_, index) => `function callback${index}() { queueMicrotask(() => {}) }`).join("\n");
    const schedules = Array.from({ length: 64 }, (_, index) => `setTimeout(callback${index}, ${index})`).join(";");
    analyzeAsyncPatterns("named-callbacks.ts", `${callbacks}\nfunction schedule() { ${schedules} }`);
  }, { time: 500, iterations: 5 });

  bench("resolve a 64-link timer handle alias chain", () => {
    const aliases = Array.from({ length: 64 }, (_, index) => `const handle${index + 1} = handle${index}`).join(";");
    analyzeAsyncPatterns("timer-aliases.ts", `function job() {}; function schedule() { const handle0 = setTimeout(job, 0); ${aliases}; clearTimeout(handle64) }`);
  }, { time: 500, iterations: 5 });

  bench("track 64 escaped timer handles", () => {
    const schedules = Array.from({ length: 64 }, (_, index) => `const handle${index} = setTimeout(() => {}, ${index}); register(handle${index})`).join(";");
    analyzeAsyncPatterns("timer-escapes.ts", `declare function register(value: unknown): void; function schedule() { ${schedules} }`);
  }, { time: 500, iterations: 5 });

  bench("track 64 aggregate timer handle escapes", () => {
    const schedules = Array.from({ length: 64 }, (_, index) => `const handle${index} = setTimeout(() => {}, ${index})`).join(";");
    const handles = Array.from({ length: 64 }, (_, index) => `handle${index}`).join(",");
    analyzeAsyncPatterns("aggregate-timer-escapes.ts", `declare function register(value: unknown): void; function schedule() { ${schedules}; const bundle = { handles: [${handles}] }; register(bundle) }`);
  }, { time: 500, iterations: 5 });

  bench("analyze prioritized scheduler dogfood", () => {
    analyzeAsyncPatterns("examples/dogfood/scheduler-priority.ts", readFileSync("examples/dogfood/scheduler-priority.ts", "utf8"));
  }, { time: 500, iterations: 5 });

  bench("analyze Node server close dogfood", () => {
    analyzeAsyncPatterns("examples/dogfood/node-server-shutdown.ts", readFileSync("examples/dogfood/node-server-shutdown.ts", "utf8"));
  }, { time: 500, iterations: 5 });

  bench("analyze Node DNS poll dogfood", () => {
    analyzeAsyncPatterns("examples/dogfood/node-dns-resolution.ts", readFileSync("examples/dogfood/node-dns-resolution.ts", "utf8"));
  }, { time: 500, iterations: 5 });

  bench("analyze conditional abort task dogfood", () => {
    analyzeAsyncPatterns("examples/dogfood/conditional-abort-task.ts", readFileSync("examples/dogfood/conditional-abort-task.ts", "utf8"));
  }, { time: 500, iterations: 5 });

  bench("analyze conditional timer callback dogfood", () => {
    analyzeAsyncPatterns("examples/dogfood/conditional-timer-callback.ts", readFileSync("examples/dogfood/conditional-timer-callback.ts", "utf8"));
  }, { time: 500, iterations: 5 });

  bench("compose validator cardinality through a 4-file barrel and method graph", () => {
    const validator = defineUneffectValidator({ name: "Once", rule: "at-most-once", sink: { module: "./metrics.js", export: "sendMetric" }, specialization: { kind: "call-cardinality", maximum: 1 } });
    analyzeUneffectProject({ validators: [validator], files: {
      "src/metrics.ts": `export declare function sendMetric(): void`,
      "src/reporters.ts": `import { sendMetric as emit } from "./metrics.js"; export function helper() { emit() }; export class Reporter { report() { emit() } }`,
      "src/barrel.ts": `export { helper as forwarded, Reporter } from "./reporters.js"`,
      "src/main.ts": `import { forwarded, Reporter } from "./barrel.js"; /* uneffect:validate Once */ export function main(flag: boolean) { if (flag) forwarded(); else new Reporter().report() }`,
    } });
  }, { time: 500, iterations: 5 });

  bench("replay a 100-step normalized model trace", async () => {
    const steps = Array.from({ length: 100 }, (_, index) => ({ action: "increment", before: { value: index }, after: { value: index + 1 } }));
    const trace = createModelCounterexample({ backend: "manual", modelHash: "counter", initialState: { value: 0 }, steps });
    await replayModelCounterexample(trace, {
      schema: "uneffect-refinement-adapter/v1", name: "counter", version: "1",
      create: (state) => ({ value: state.value }), observe: (runtime) => ({ value: runtime.value }),
      actions: { increment: (runtime) => { runtime.value++; } }, invariants: { nonnegative: (runtime) => runtime.value >= 0 },
    });
  }, { time: 500, iterations: 20 });

  bench("parse a 100-step Quint MBT ITF counterexample", () => {
    const states = Array.from({ length: 101 }, (_, index) => ({
      "#meta": { index },
      value: { "#bigint": String(index) },
      ready: index > 0,
      "mbt::actionTaken": index === 0 ? "init" : "increment",
      "mbt::nondetPicks": {},
    }));
    parseQuintItfCounterexample(JSON.stringify({
      "#meta": { format: "ITF", status: "violation" },
      vars: ["value", "ready", "mbt::actionTaken", "mbt::nondetPicks"],
      states,
    }), "counter");
  }, { time: 500, iterations: 20 });

  bench("parse and recover a 100-step scalar TLC counterexample", () => {
    const temporal = parseSpec("tlc-counter.ts", `/* uneffect: state value: int */ /* uneffect: init value = 0 */ /* uneffect: action increment: value' = value + 1 */ /* uneffect:always belowHundred: value < 100 */`).temporal;
    const states = Array.from({ length: 101 }, (_, index) => `State ${index + 1}: <${index === 0 ? "Initial predicate" : "q_step"}>\nvalue = ${index}`).join("\n");
    parseTlcCounterexample(`Error: Invariant q_inv is violated.\n${states}`, temporal, "counter");
  }, { time: 500, iterations: 20 });

  bench("extract and generate a 64-action refinement adapter", () => {
    const actions = Object.fromEntries(Array.from({ length: 64 }, (_, index) => [`action${index}`, `action${index}`]));
    const manifest = {
      schema: "uneffect-refinement-bindings/v1", fileName: "machine.ts",
      adapterName: "machine", version: "1", create: "create", observe: "observe",
      abstractions: {}, actions, invariants: {},
    } satisfies RefinementBindingManifest;
    generateRefinementAdapterModuleFromManifest(manifest, "./machine.js");
  }, { time: 500, iterations: 20 });

  bench("parse and validate complete telemetry scalar refinement", () => {
    const fileName = "examples/dogfood/telemetry-routing-accounting.ts";
    const source = readFileSync(fileName, "utf8");
    const temporal = parseSpec(fileName, source).temporal;
    validateRefinementBindingCoverage(fileName, source, "telemetryRouting", temporal);
    validateRefinementActionBodies(fileName, source, "telemetryRouting", temporal);
    validateRefinementInvariantBodies(fileName, source, "telemetryRouting", temporal);
    validateRefinementStateProjection(fileName, source, "telemetryRouting", temporal);
  }, { time: 500, iterations: 20 });

  bench("validate an imported runtime method refinement in a warm Program", () => {
    validateRefinementActionBodiesInProgram(
      importedRuntimeRefinementProgram,
      importedRuntimeRefinementFile,
      "importedTelemetry",
      importedRuntimeRefinementSpec,
    );
  }, { time: 500, iterations: 20 });

  bench("unroll finite for-of refinement with abrupt cleanup", () => {
    validateRefinementActionBodies(
      finiteTelemetryBatchFile,
      finiteTelemetryBatchSource,
      "telemetryBatch",
      finiteTelemetryBatchSpec,
    );
  }, { time: 500, iterations: 20 });

  bench("consume a labeled refinement break through finally", () => {
    validateRefinementActionBodies(
      labeledTelemetryFile,
      labeledTelemetrySource,
      "labeledDelivery",
      labeledTelemetrySpec,
    );
  }, { time: 500, iterations: 20 });

  bench("compose an 8x8 nested outer-label transfer", () => {
    const source = `/* uneffect: state value: int */ /* uneffect: init value = 0 */ /* uneffect: action scan: value' = value */
      interface Runtime { value: number }
      export function create(initial: Runtime) { return initial }
      export function observe(runtime: Runtime) { return runtime }
      export function scan(runtime: Runtime) {
        outer: for (let row = 0; row < 8; row++) {
          for (let column = 0; column < 8; column++) continue outer
          runtime.value++
        }
      }
    `;
    validateGeneratedRefinementActionBodies("nested-scan.ts", source, "nestedScan", parseSpec("nested-scan.ts", source).temporal);
  }, { time: 500, iterations: 20 });

  bench("summarize a symbolic telemetry backlog countdown", () => {
    validateRefinementActionBodies(
      telemetryBacklogFile,
      telemetryBacklogSource,
      "telemetryBacklog",
      telemetryBacklogSpec,
    );
  }, { time: 500, iterations: 20 });

  bench("summarize a symbolic worker-pool scale-up", () => {
    validateRefinementActionBodies(
      workerPoolFile,
      workerPoolSource,
      "workerPool",
      workerPoolSpec,
    );
  }, { time: 500, iterations: 20 });

  bench("summarize a triangular loop-carried backlog recurrence", () => {
    validateGeneratedRefinementActionBodies(
      triangularDrainFile,
      triangularDrainSource,
      "triangularDrain",
      triangularDrainSpec,
    );
  }, { time: 500, iterations: 20 });

  bench("summarize a loop-invariant conditional affine recurrence", () => {
    validateRefinementActionBodies(
      priorityTelemetryFile,
      priorityTelemetrySource,
      "priorityTelemetry",
      priorityTelemetrySpec,
    );
  }, { time: 500, iterations: 20 });

  bench("summarize the eight-leaf affine loop branch budget", () => {
    validateGeneratedRefinementActionBodies(
      affineBranchBudgetFile,
      affineBranchBudgetSource,
      "affineBranchBudget",
      affineBranchBudgetSpec,
    );
  }, { time: 500, iterations: 20 });

  bench("compose a bounded invariant break update set with an affine recurrence", () => {
    validateRefinementActionBodies(
      pausedTelemetryFile,
      pausedTelemetrySource,
      "pausedTelemetry",
      pausedTelemetrySpec,
    );
  }, { time: 500, iterations: 20 });

  bench("join caught retry and stop policy through ranking finally", () => {
    validateRefinementActionBodies(
      failingTelemetryFile,
      failingTelemetrySource,
      "failingTelemetry",
      failingTelemetrySpec,
    );
  }, { time: 500, iterations: 20 });

  bench("compose nested Boolean invariant stop accounting path-wise", () => {
    validateRefinementActionBodies(
      circuitBreakerTelemetryFile,
      circuitBreakerTelemetrySource,
      "circuitBreakerTelemetry",
      circuitBreakerTelemetrySpec,
    );
  }, { time: 500, iterations: 20 });

  bench("route mutable-local billing through switch return catch and finally", () => {
    validateRefinementActionBodies(
      adaptiveBatchAccountingFile,
      adaptiveBatchAccountingSource,
      "adaptiveBatchAccounting",
      adaptiveBatchAccountingSpec,
    );
  }, { time: 500, iterations: 20 });

  bench("carry mutable-local recovery through nested rethrow and finally", () => {
    validateRefinementActionBodies(
      rethrowBatchAccountingFile,
      rethrowBatchAccountingSource,
      "rethrowBatchAccounting",
      rethrowBatchAccountingSpec,
    );
  }, { time: 500, iterations: 20 });

  bench("carry mutable-local billing through bounded loop exits", () => {
    validateRefinementActionBodies(
      boundedBatchBillingFile,
      boundedBatchBillingSource,
      "boundedBatchBilling",
      boundedBatchBillingSpec,
    );
  }, { time: 500, iterations: 20 });

  bench("carry a catch-owned break snapshot into a bounded-loop exit", () => {
    validateRefinementActionBodies(
      circuitBreakerBatchAccountingFile,
      circuitBreakerBatchAccountingSource,
      "circuitBreakerBatchAccounting",
      circuitBreakerBatchAccountingSpec,
    );
  }, { time: 500, iterations: 20 });

  bench("carry a catch-owned continue snapshot into the next bounded iteration", () => {
    validateRefinementActionBodies(
      retryBatchAccountingFile,
      retryBatchAccountingSource,
      "retryBatchAccounting",
      retryBatchAccountingSpec,
    );
  }, { time: 500, iterations: 20 });

  bench("override predecessor completion with a conditional finally return", () => {
    validateRefinementActionBodies(
      finallyOverrideAccountingFile,
      finallyOverrideAccountingSource,
      "finallyOverrideAccounting",
      finallyOverrideAccountingSpec,
    );
  }, { time: 500, iterations: 20 });

  bench("override predecessor completion with a scalar finally throw", () => {
    validateRefinementActionBodies(
      finallyEscalationAccountingFile,
      finallyEscalationAccountingSource,
      "finallyEscalationAccounting",
      finallyEscalationAccountingSpec,
    );
  }, { time: 500, iterations: 20 });

  bench("override predecessor completion with an owning-loop finally break", () => {
    validateRefinementActionBodies(
      finallyCircuitBreakAccountingFile,
      finallyCircuitBreakAccountingSource,
      "finallyCircuitBreakAccounting",
      finallyCircuitBreakAccountingSpec,
    );
  }, { time: 500, iterations: 20 });

  bench("override predecessor completion with an owning-loop finally continue", () => {
    validateRefinementActionBodies(
      finallyRetryAccountingFile,
      finallyRetryAccountingSource,
      "finallyRetryAccounting",
      finallyRetryAccountingSpec,
    );
  }, { time: 500, iterations: 20 });

  bench("reduce exact and ownership-aware bounded loops", () => {
    validateRefinementActionBodies(
      generatedMigrationFile,
      generatedMigrationSource,
      "generatedMigration",
      generatedMigrationSpec,
    );
  }, { time: 500, iterations: 20 });

  bench("join catch return and rethrow completions", () => {
    const source = `/* uneffect: state caught: int */ /* uneffect: state observed: int */ /* uneffect: state stop: bool */ /* uneffect: init caught = 0 */ /* uneffect: init observed = 0 */ /* uneffect: init stop = false */ /* uneffect: action returnPath: caught' = stop ? caught : caught + 1, observed' = stop ? observed : observed + 1 */ /* uneffect: action throwPath: caught' = stop ? caught : caught + 1, observed' = stop ? observed : observed + 1 */
      interface Runtime { caught: number; observed: number; stop: boolean }
      export function create(initial: Runtime) { return initial }
      export function observe(runtime: Runtime) { return runtime }
      export function returnPath(runtime: Runtime) {
        try { throw "failed" } catch { if (runtime.stop) return; runtime.caught++ }
        runtime.observed++
      }
      export function throwPath(runtime: Runtime) {
        try { throw "failed" } catch { if (runtime.stop) throw "again"; runtime.caught++ }
        runtime.observed++
      }
    `;
    const temporal = parseSpec("catch-completion-bench.ts", source).temporal;
    validateGeneratedRefinementActionBodies("catch-completion-bench.ts", source, "recovery", temporal);
  }, { time: 500, iterations: 20 });

  bench("join conditional finally overrides", () => {
    const source = `/* uneffect: state worked: int */ /* uneffect: state released: int */ /* uneffect: state observed: int */ /* uneffect: state cancel: bool */ /* uneffect: state fail: bool */ /* uneffect: init worked = 0 */ /* uneffect: init released = 0 */ /* uneffect: init observed = 0 */ /* uneffect: init cancel = false */ /* uneffect: init fail = false */ /* uneffect: action execute: worked' = worked + 1, released' = cancel ? released + 1 : fail ? released : released + 1, observed' = (cancel || fail) ? observed : observed + 1 */
      interface Runtime { worked: number; released: number; observed: number; cancel: boolean; fail: boolean }
      export function create(initial: Runtime) { return initial }
      export function observe(runtime: Runtime) { return runtime }
      export function execute(runtime: Runtime) {
        try { runtime.worked++ } finally {
          if (runtime.cancel) { runtime.released++; return }
          if (runtime.fail) throw "cleanup failed"
          runtime.released++
        }
        runtime.observed++
      }
    `;
    const temporal = parseSpec("finally-completion-bench.ts", source).temporal;
    validateGeneratedRefinementActionBodies("finally-completion-bench.ts", source, "cleanup", temporal);
  }, { time: 500, iterations: 20 });

  bench("compose a 16-case switch refinement with fallthrough", () => {
    const cases = Array.from({ length: 16 }, (_, index) => `case ${index}: runtime.value += 1;${index % 4 === 3 ? " break;" : ""}`).join("\n");
    const expression = Array.from({ length: 16 }, (_, index) => `mode === ${index} ? value ${Array.from({ length: 4 - index % 4 }, () => "+ 1").join(" ")} : `).join("") + "value";
    const source = `/* uneffect: state value: int */ /* uneffect: state mode: int */ /* uneffect: init value = 0 */ /* uneffect: init mode = 0 */ /* uneffect: action route: value' = ${expression} */
      interface Runtime { value: number; mode: number }
      export function create(initial: Runtime) { return initial }
      export function observe(runtime: Runtime) { return runtime }
      export function route(runtime: Runtime) { switch (runtime.mode) { ${cases} } }
    `;
    validateGeneratedRefinementActionBodies("switch-routing.ts", source, "routing", parseSpec("switch-routing.ts", source).temporal);
  }, { time: 500, iterations: 20 });

  bench("join value return and throw switch completions", () => {
    const source = `/* uneffect: state routed: int */ /* uneffect: state failed: int */ /* uneffect: state settled: int */ /* uneffect: state observed: int */ /* uneffect: state mode: int */ /* uneffect: init routed = 0 */ /* uneffect: init failed = 0 */ /* uneffect: init settled = 0 */ /* uneffect: init observed = 0 */ /* uneffect: init mode = 0 */ /* uneffect: action route: routed' = mode === 0 ? routed + 1 : mode === 1 ? routed + 2 : routed + 3, failed' = mode === 1 ? failed + 1 : failed, settled' = settled + 1, observed' = mode === 0 ? observed : observed + 1 */
      interface Runtime { routed: number; failed: number; settled: number; observed: number; mode: number }
      export function create(initial: Runtime) { return initial }
      export function observe(runtime: Runtime) { return runtime }
      export function route(runtime: Runtime) {
        try {
          switch (runtime.mode) {
            case 0: runtime.routed++; return runtime.routed
            case 1: runtime.routed += 2; throw runtime.routed
            default: runtime.routed += 3; break
          }
        } catch { runtime.failed++ }
        finally { runtime.settled++ }
        runtime.observed++
      }
    `;
    validateGeneratedRefinementActionBodies("switch-completion-bench.ts", source, "routing", parseSpec("switch-completion-bench.ts", source).temporal);
  }, { time: 500, iterations: 20 });

  bench("bind a conditional scalar throw payload", () => {
    const source = `/* uneffect: state failed: int */ /* uneffect: state code: int */ /* uneffect: state shouldFail: bool */ /* uneffect: init failed = 0 */ /* uneffect: init code = 0 */ /* uneffect: init shouldFail = false */ /* uneffect: action reject: failed' = shouldFail ? code > 0 ? failed + 1 : failed : failed */
      interface Runtime { failed: number; code: number; shouldFail: boolean }
      export function create(initial: Runtime) { return initial }
      export function observe(runtime: Runtime) { return runtime }
      export function reject(runtime: Runtime) {
        try { if (runtime.shouldFail) throw runtime.code }
        catch (error) { if (error > 0) runtime.failed++ }
      }
    `;
    validateGeneratedRefinementActionBodies("caught-payload-bench.ts", source, "accounting", parseSpec("caught-payload-bench.ts", source).temporal);
  }, { time: 500, iterations: 20 });

  bench("bind switch-selected scalar throw payloads", () => {
    const source = `/* uneffect: state failed: int */ /* uneffect: state code: int */ /* uneffect: state fallbackCode: int */ /* uneffect: state mode: int */ /* uneffect: init failed = 0 */ /* uneffect: init code = 0 */ /* uneffect: init fallbackCode = 1 */ /* uneffect: init mode = 0 */ /* uneffect: action reject: failed' = (mode === 1 || mode === 2) ? (mode === 1 ? code : fallbackCode) > 0 ? failed + 1 : failed : failed */
      interface Runtime { failed: number; code: number; fallbackCode: number; mode: number }
      export function create(initial: Runtime) { return initial }
      export function observe(runtime: Runtime) { return runtime }
      export function reject(runtime: Runtime) {
        try {
          switch (runtime.mode) {
            case 1: throw runtime.code
            case 2: throw runtime.fallbackCode
          }
        } catch (error) {
          if (error > 0) runtime.failed++
        }
      }
    `;
    validateGeneratedRefinementActionBodies("switch-caught-payload-bench.ts", source, "accounting", parseSpec("switch-caught-payload-bench.ts", source).temporal);
  }, { time: 500, iterations: 20 });

  bench("bind literal throw payloads through switch fallthrough", () => {
    const source = `/* uneffect: state failed: int */ /* uneffect: state mode: int */ /* uneffect: init failed = 0 */ /* uneffect: init mode = 0 */ /* uneffect: action reject: failed' = (mode === 0 ? 1 : mode === 1 ? 1 : 0) > 0 ? failed + 1 : failed */
      interface Runtime { failed: number; mode: number }
      export function create(initial: Runtime) { return initial }
      export function observe(runtime: Runtime) { return runtime }
      export function reject(runtime: Runtime) {
        try {
          switch (runtime.mode) {
            case 0:
            case 1: throw 1
            default: throw 0
          }
        } catch (error) {
          if (error > 0) runtime.failed++
        }
      }
    `;
    validateGeneratedRefinementActionBodies("literal-switch-payload-bench.ts", source, "accounting", parseSpec("literal-switch-payload-bench.ts", source).temporal);
  }, { time: 500, iterations: 20 });

  bench("project a direct record throw payload", () => {
    const source = `/* uneffect: state failed: int */ /* uneffect: state code: int */ /* uneffect: state retryable: bool */ /* uneffect: init failed = 0 */ /* uneffect: init code = 0 */ /* uneffect: init retryable = false */ /* uneffect: action reject: failed' = retryable && code > 0 ? failed + 1 : failed */
      interface Runtime { failed: number; code: number; retryable: boolean }
      export function create(initial: Runtime) { return initial }
      export function observe(runtime: Runtime) { return runtime }
      export function reject(runtime: Runtime) {
        try { throw { code: runtime.code, retryable: runtime.retryable } }
        catch (error) { if (error.retryable && error.code > 0) runtime.failed++ }
      }
    `;
    validateGeneratedRefinementActionBodies("record-payload-bench.ts", source, "accounting", parseSpec("record-payload-bench.ts", source).temporal);
  }, { time: 500, iterations: 20 });

  bench("project conditional record throw payloads", () => {
    const source = `/* uneffect: state failed: int */ /* uneffect: state primary: bool */ /* uneffect: init failed = 0 */ /* uneffect: init primary = false */ /* uneffect: action reject: failed' = failed + (primary ? 1 : 2) */
      interface Runtime { failed: number; primary: boolean }
      export function create(initial: Runtime) { return initial }
      export function observe(runtime: Runtime) { return runtime }
      export function reject(runtime: Runtime) {
        try {
          if (runtime.primary) throw { code: 1, retryable: true }
          throw { code: 2, retryable: false }
        } catch (error) {
          if (error.retryable) runtime.failed = runtime.failed + error.code
          else runtime.failed = runtime.failed + error.code
        }
      }
    `;
    validateGeneratedRefinementActionBodies("conditional-record-payload-bench.ts", source, "accounting", parseSpec("conditional-record-payload-bench.ts", source).temporal);
  }, { time: 500, iterations: 20 });
});
