import { bench, describe } from "vitest";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { verifyTypedArraySafety, verifyTypedArraySafetyInProgram, verifyTypedArraySafetyInTypeScriptProgram } from "../src/typed-array-safety.js";
import { parseSpec } from "../src/spec-ir.js";
import { generateQuint } from "../src/spec-backends.js";
import { findTemporalCounterexampleWithZ3, lintTemporalReachabilityWithZ3, lintTemporalSpec, lintTemporalSpecWithZ3 } from "../src/spec-lint.js";
import { checkUneffectProperty, generateUneffectPropertyTests, generateUneffectPropertyTestsWithZ3 } from "../src/property-tests.js";
import { analyzeUneffectProject, defineUneffectValidator } from "../src/custom-validators.js";
import { createModelCounterexample, parseQuintItfCounterexample, parseTlcCounterexample, replayModelCounterexample } from "../src/model-replay.js";
import { generateRefinementAdapterModule, validateRefinementActionBodies, validateRefinementActionBodiesInProgram, validateRefinementBindingCoverage, validateRefinementInvariantBodies, validateRefinementStateProjection } from "../src/refinement-bindings.js";
import { verifyUneffectProject } from "../src/project-verification.js";
import { analyzeAsyncPatterns, generateNodeEventLoopQuint } from "../src/async-patterns.js";
import { analyzeAsyncSafety, analyzeAsyncSafetyInProgram, generateUnifiedAsyncQuint } from "../src/async-safety.js";
import { analyzePromiseChains } from "../src/promise-chains.js";

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
const initializedTelemetryDeliverySource = telemetryDeliverySource.replace(
  "let delivery: Promise<void>;\n  delivery = sendTelemetryBatch();",
  "const delivery = sendTelemetryBatch();",
);
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
const compilerHost = ts.createCompilerHost(compilerOptions);
const defaultGetSourceFile = compilerHost.getSourceFile.bind(compilerHost);
compilerHost.fileExists = (fileName) => fileName === typedIntegerSourceName || ts.sys.fileExists(fileName);
compilerHost.readFile = (fileName) => fileName === typedIntegerSourceName ? typedIntegerSourceText : ts.sys.readFile(fileName);
compilerHost.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) => fileName === typedIntegerSourceName
  ? ts.createSourceFile(fileName, typedIntegerSourceText, languageVersion, true)
  : defaultGetSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile);
const typedIntegerProgram = ts.createProgram([typedIntegerSourceName], compilerOptions, compilerHost);
const typedIntegerSource = typedIntegerProgram.getSourceFile(typedIntegerSourceName)!;

describe("refinement receiver identity", () => {
  bench("syntax-only Node Lease collection actions", () => {
    validateRefinementActionBodies(leaseAuthorityFile, leaseAuthoritySource, "leaseAuthority", leaseAuthoritySpec);
  }, { time: 500, iterations: 20 });

  bench("warm TypeChecker Node Lease collection actions", () => {
    validateRefinementActionBodiesInProgram(leaseAuthorityProgram, leaseAuthorityFile, "leaseAuthority", leaseAuthoritySpec);
  }, { time: 500, iterations: 20 });
});

describe("typed-array static verification", () => {
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
  }, { time: 500, iterations: 5 });

  bench("check initialized telemetry Promise ownership baseline", () => {
    analyzeAsyncSafety("telemetry-delivery.ts", initializedTelemetryDeliverySource);
  }, { time: 500, iterations: 5 });

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

  bench("parse, lint, and generate flattened Node Lease Quint", () => {
    const temporal = parseSpec("lease.ts", `/* uneffect:
      clock realNow: 1
      state leaseExpiryA: int
      state localDeadlineA: int
      state ownerEpoch: int
      state residentEpochA: int
      state residentEpochB: int
      state ownerIsA: bool
      init leaseExpiryA = 10
      init localDeadlineA = 10
      init ownerEpoch = 1
      init residentEpochA = 1
      init residentEpochB = 0
      init ownerIsA = true
      action takeoverB: ownerIsA' = false, ownerEpoch' = ownerEpoch + 1
      action_when takeoverB: ownerIsA && realNow + 1 >= leaseExpiryA + 1
      action publishB: residentEpochB' = ownerEpoch
      action_when publishB: !ownerIsA && residentEpochB !== ownerEpoch
      temporal singleWriter: !(residentEpochA > 0 && realNow < localDeadlineA && residentEpochB > 0)
    */`).temporal;
    lintTemporalSpec(temporal);
    generateQuint("node_lease", temporal);
  }, { time: 500, iterations: 20 });

  bench("solver-lint 5 temporal properties and one guarded action", async () => {
    const temporal = parseSpec("semantic-lint.ts", `/* uneffect:
      state epoch: int
      state ready: bool
      init epoch = 0
      init ready = false
      action publish: ready' = true
      action_when publish: epoch >= 0
      temporal nonnegative: epoch >= 0
      temporal positive: epoch > 0
      temporal bounded: epoch >= 0 && epoch < 100
      temporal totalOrder: epoch > 0 || epoch <= 0
      temporal readyAfterPublish: ready || !ready
    */`).temporal;
    await lintTemporalSpecWithZ3(temporal);
  }, { time: 500, iterations: 1 });

  bench("bounded reachability lint for 3 actions over 4 steps", async () => {
    const temporal = parseSpec("reachability.ts", `/* uneffect:
      state phase: int
      init phase = 0
      action advance: phase' = 1
      action_when advance: phase === 0
      action finish: phase' = 2
      action_when finish: phase === 1
      action never: phase' = 3
      action_when never: phase === 99
    */`).temporal;
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
    const temporal = parseSpec("vacuity.ts", `/* uneffect:
      state phase: int
      state counter: int
      init phase = 0
      init counter = 0
      action tick: counter' = counter + 1
      temporal phaseFixed: phase === 0
    */`).temporal;
    await lintTemporalReachabilityWithZ3(temporal, { maxSteps: 4 });
  }, { time: 500, iterations: 1 });

  bench("extract a bounded 11-step Node Lease Z3 counterexample", async () => {
    const temporal = parseSpec("lease-counterexample.ts", `/* uneffect:
      clock realNow: 1
      state leaseExpiryA: int
      state localDeadlineA: int
      state ownerEpoch: int
      state residentEpochA: int
      state residentEpochB: int
      state ownerIsA: bool
      init leaseExpiryA = 10
      init localDeadlineA = 10
      init ownerEpoch = 1
      init residentEpochA = 1
      init residentEpochB = 0
      init ownerIsA = true
      action takeoverB: ownerIsA' = false, ownerEpoch' = ownerEpoch + 1
      action_when takeoverB: ownerIsA && realNow + 1 >= leaseExpiryA
      action publishB: residentEpochB' = ownerEpoch
      action_when publishB: !ownerIsA && residentEpochB !== ownerEpoch
      temporal singleWriter: !(residentEpochA > 0 && realNow < localDeadlineA && residentEpochB > 0)
    */`).temporal;
    await findTemporalCounterexampleWithZ3(temporal, "singleWriter", { maxSteps: 12 });
  }, { time: 500, iterations: 1 });

  bench("lower a node-indexed Set/Map lease model to Quint", () => {
    const temporal = parseSpec("lease-set.ts", `/* uneffect:
      clock realNow: 1
      state nodes: Set<int>
      state activeWriters: Set<int>
      state residentEpochs: Map<int, int>
      init nodes = Set(1, 2)
      init activeWriters = Set(1)
      init residentEpochs = Map([[1, 1], [2, 0]])
      action publish: activeWriters' = activeWriters.union(Set(2)), residentEpochs' = residentEpochs.put(2, 2)
      temporal writersAreNodes: activeWriters.forall(node => nodes.contains(node))
      temporal epochsAreNonNegative: residentEpochs.values().forall(epoch => epoch >= 0)
    */`).temporal;
    generateQuint("lease_set", temporal);
  }, { time: 500, iterations: 20 });

  bench("generate 16 scalar contract property tests", () => {
    const functions = Array.from({ length: 16 }, (_, index) => `
      /* uneffect: requires denominator > 0 */
      /* uneffect: ensures result * denominator <= numerator */
      export function quotient${index}(numerator: Nat, denominator: Int): Int {
        return Math.floor(numerator / denominator) as Int
      }
    `).join("\n");
    generateUneffectPropertyTests({ files: { "src/properties.ts": `import type { Int, Nat } from "@mizchi/uneffect"\n${functions}` }, shrinking: true });
  }, { time: 500, iterations: 20 });

  bench("generate 16 bounded-array and literal-union property tests", () => {
    const functions = Array.from({ length: 16 }, (_, index) => `
      /* uneffect: ensures result >= 0 */
      export function packet${index}(bytes: BoundedUint8Array<64>, mode: "fast" | "safe"): Nat {
        return (bytes.length + mode.length) as Nat
      }
    `).join("\n");
    generateUneffectPropertyTests({ files: { "src/packets.ts": `import type { BoundedUint8Array, Nat } from "@mizchi/uneffect"\n${functions}` }, shrinking: true });
  }, { time: 500, iterations: 20 });

  bench("derive generator hints for 16 refined scalar contracts", () => {
    const functions = Array.from({ length: 16 }, (_, index) => `
      /* uneffect: requires value >= ${index * 10} && value < ${index * 10 + 10} */
      /* uneffect: ensures result >= ${index * 10} */
      export function range${index}(value: Int): Int { return value }
    `).join("\n");
    generateUneffectPropertyTests({ files: { "src/ranges.ts": `import type { Int } from "@mizchi/uneffect"\n${functions}` }, shrinking: true });
  }, { time: 500, iterations: 20 });

  bench("derive aligned hints for 16 modulo-refined shard contracts", () => {
    const functions = Array.from({ length: 16 }, (_, index) => `
      /* uneffect: requires shard >= ${index * 1024} && shard < ${(index + 1) * 1024} && shard % 16 === 0 */
      /* uneffect: ensures result >= 0 */
      export function shard${index}(shard: Nat): Nat { return shard }
    `).join("\n");
    generateUneffectPropertyTests({ files: { "src/shards.ts": `import type { Nat } from "@mizchi/uneffect"\n${functions}` }, shrinking: true });
  }, { time: 500, iterations: 20 });

  bench("derive branch-local hints for 16 tenant shard contracts", () => {
    const functions = Array.from({ length: 16 }, (_, index) => `
      /* uneffect: requires (shard >= ${index * 256} && shard < ${index * 256 + 32} && shard % 16 === 0) || (shard >= ${index * 256 + 100} && shard < ${index * 256 + 132} && shard % 16 === 4) */
      /* uneffect: ensures result >= 0 */
      export function tenantShard${index}(shard: Nat): Nat { return shard }
    `).join("\n");
    generateUneffectPropertyTests({ files: { "src/tenant-shards.ts": `import type { Nat } from "@mizchi/uneffect"\n${functions}` }, shrinking: true });
  }, { time: 500, iterations: 20 });

  bench("combine congruence hints for 16 partition routing contracts", () => {
    const functions = Array.from({ length: 16 }, (_, index) => `
      /* uneffect: requires partition >= ${index * 256} && partition < ${(index + 1) * 256} && partition % 4 === 1 && partition % 6 === 3 */
      /* uneffect: ensures result >= 0 */
      export function route${index}(partition: Nat): Nat { return partition }
    `).join("\n");
    generateUneffectPropertyTests({ files: { "src/partition-routes.ts": `import type { Nat } from "@mizchi/uneffect"\n${functions}` }, shrinking: true });
  }, { time: 500, iterations: 20 });

  bench("derive signed remainder hints for 16 negative partition contracts", () => {
    const functions = Array.from({ length: 16 }, (_, index) => `
      /* uneffect: requires partition >= ${-256 * (index + 1)} && partition < ${-256 * index} && partition % 6 === -3 */
      /* uneffect: ensures result < 0 */
      export function signedRoute${index}(partition: Int): Int { return partition }
    `).join("\n");
    generateUneffectPropertyTests({ files: { "src/signed-routes.ts": `import type { Int } from "@mizchi/uneffect"\n${functions}` }, shrinking: true });
  }, { time: 500, iterations: 20 });

  bench("derive branched affine hints for 16 scalar contracts", () => {
    const functions = Array.from({ length: 16 }, (_, index) => `
      /* uneffect: requires (value + 2 >= ${index * 10} && value + 2 < ${index * 10 + 5}) || (value >= ${index * 10 + 20} && value < ${index * 10 + 25}) */
      /* uneffect: ensures result >= ${index * 10 - 2} */
      export function branched${index}(value: Int): Int { return value }
    `).join("\n");
    generateUneffectPropertyTests({ files: { "src/branched.ts": `import type { Int } from "@mizchi/uneffect"\n${functions}` }, shrinking: true });
  }, { time: 500, iterations: 20 });

  bench("derive correlated affine tuples for 16 three-parameter contracts", () => {
    const functions = Array.from({ length: 16 }, (_, index) => `
      /* uneffect: requires x >= ${index * 10} && x < ${index * 10 + 5} && y === x + 1 && z === y + 2 */
      /* uneffect: ensures result === z */
      export function dependent${index}(x: Int, y: Int, z: Int): Int { return z }
    `).join("\n");
    generateUneffectPropertyTests({ files: { "src/dependent.ts": `import type { Int } from "@mizchi/uneffect"\n${functions}` }, shrinking: true });
  }, { time: 500, iterations: 20 });

  bench("derive nonlinear property tuples with Z3", async () => {
    await generateUneffectPropertyTestsWithZ3({ files: { "src/circle.ts": `
      import type { Int } from "@mizchi/uneffect"
      /* uneffect: requires x >= 0 && y >= 0 && x * x + y * y === 625 */
      /* uneffect: ensures result >= 0 */
      export function radius(x: Int, y: Int): Int { return x + y }
    ` }, solverCases: 8 });
  }, { time: 500, iterations: 1 });

  bench("derive correlated literal-union tuples with JavaScript arithmetic", async () => {
    await generateUneffectPropertyTestsWithZ3({ files: { "src/replicas.ts": `
      /* uneffect: requires replicas >= 4 && (allowLarge || replicas <= 4) && (region === "local" || allowLarge) && signed === -7 && signed / 3 === -2 && signed % 3 === -1 */
      /* uneffect: ensures result >= 4 */
      export function deployment(replicas: 1 | 4 | 9, allowLarge: false | true, region: "local" | "edge", signed: Int): number { return replicas }
    ` }, solverCases: 4 });
  }, { time: 500, iterations: 1 });

  bench("derive nested optional rollout configurations", async () => {
    await generateUneffectPropertyTestsWithZ3({ files: { "src/rollout.ts": `
      type U8 = number
      /* uneffect: requires config.rollout === undefined || (config.rollout.maxReplicas === 9 && (config.rollout.minReplicas === undefined || config.rollout.minReplicas >= 4)) */
      /* uneffect: ensures result >= 0 */
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
      /* uneffect: requires value >= 0 */
      /* uneffect: ensures result > value */
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
      "src/main.ts": `import { forwarded, Reporter } from "./barrel.js"; /* uneffect: validate Once */ export function main(flag: boolean) { if (flag) forwarded(); else new Reporter().report() }`,
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
    const temporal = parseSpec("tlc-counter.ts", `/* uneffect:
      state value: int
      init value = 0
      action increment: value' = value + 1
      temporal belowHundred: value < 100
    */`).temporal;
    const states = Array.from({ length: 101 }, (_, index) => `State ${index + 1}: <${index === 0 ? "Initial predicate" : "q_step"}>\nvalue = ${index}`).join("\n");
    parseTlcCounterexample(`Error: Invariant q_inv is violated.\n${states}`, temporal, "counter");
  }, { time: 500, iterations: 20 });

  bench("extract and generate a 64-action refinement adapter", () => {
    const actions = Array.from({ length: 64 }, (_, index) => `/* uneffect: refinement machine@1 action action${index} */ export function action${index}(runtime: unknown) {}`).join("\n");
    const source = `
      /* uneffect: refinement machine@1 create */ export function create(initial: unknown) { return initial }
      /* uneffect: refinement machine@1 observe */ export function observe(runtime: unknown) { return runtime }
      ${actions}
    `;
    generateRefinementAdapterModule("machine.ts", source, "./machine.js", "machine");
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

  bench("join catch return and rethrow completions", () => {
    const source = `/* uneffect:
      state caught: int
      state observed: int
      state stop: bool
      init caught = 0
      init observed = 0
      init stop = false
      action returnPath: caught' = stop ? caught : caught + 1, observed' = stop ? observed : observed + 1
      action throwPath: caught' = stop ? caught : caught + 1, observed' = stop ? observed : observed + 1
    */
      interface Runtime { caught: number; observed: number; stop: boolean }
      /* uneffect: refinement recovery@1 create */ export function create(initial: Runtime) { return initial }
      /* uneffect: refinement recovery@1 observe */ export function observe(runtime: Runtime) { return runtime }
      /* uneffect: refinement recovery@1 action returnPath */
      export function returnPath(runtime: Runtime) {
        try { throw "failed" } catch { if (runtime.stop) return; runtime.caught++ }
        runtime.observed++
      }
      /* uneffect: refinement recovery@1 action throwPath */
      export function throwPath(runtime: Runtime) {
        try { throw "failed" } catch { if (runtime.stop) throw "again"; runtime.caught++ }
        runtime.observed++
      }
    `;
    const temporal = parseSpec("catch-completion-bench.ts", source).temporal;
    validateRefinementActionBodies("catch-completion-bench.ts", source, "recovery", temporal);
  }, { time: 500, iterations: 20 });

  bench("join conditional finally overrides", () => {
    const source = `/* uneffect:
      state worked: int
      state released: int
      state observed: int
      state cancel: bool
      state fail: bool
      init worked = 0
      init released = 0
      init observed = 0
      init cancel = false
      init fail = false
      action execute: worked' = worked + 1, released' = cancel ? released + 1 : fail ? released : released + 1, observed' = (cancel || fail) ? observed : observed + 1
    */
      interface Runtime { worked: number; released: number; observed: number; cancel: boolean; fail: boolean }
      /* uneffect: refinement cleanup@1 create */ export function create(initial: Runtime) { return initial }
      /* uneffect: refinement cleanup@1 observe */ export function observe(runtime: Runtime) { return runtime }
      /* uneffect: refinement cleanup@1 action execute */
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
    validateRefinementActionBodies("finally-completion-bench.ts", source, "cleanup", temporal);
  }, { time: 500, iterations: 20 });

  bench("compose a 16-case switch refinement with fallthrough", () => {
    const cases = Array.from({ length: 16 }, (_, index) => `case ${index}: runtime.value += 1;${index % 4 === 3 ? " break;" : ""}`).join("\n");
    const expression = Array.from({ length: 16 }, (_, index) => `mode === ${index} ? value ${Array.from({ length: 4 - index % 4 }, () => "+ 1").join(" ")} : `).join("") + "value";
    const source = `/* uneffect:
      state value: int
      state mode: int
      init value = 0
      init mode = 0
      action route: value' = ${expression}
    */
      interface Runtime { value: number; mode: number }
      /* uneffect: refinement routing@1 create */ export function create(initial: Runtime) { return initial }
      /* uneffect: refinement routing@1 observe */ export function observe(runtime: Runtime) { return runtime }
      /* uneffect: refinement routing@1 action route */
      export function route(runtime: Runtime) { switch (runtime.mode) { ${cases} } }
    `;
    validateRefinementActionBodies("switch-routing.ts", source, "routing", parseSpec("switch-routing.ts", source).temporal);
  }, { time: 500, iterations: 20 });

  bench("join value return and throw switch completions", () => {
    const source = `/* uneffect:
      state routed: int
      state failed: int
      state settled: int
      state observed: int
      state mode: int
      init routed = 0
      init failed = 0
      init settled = 0
      init observed = 0
      init mode = 0
      action route: routed' = mode === 0 ? routed + 1 : mode === 1 ? routed + 2 : routed + 3, failed' = mode === 1 ? failed + 1 : failed, settled' = settled + 1, observed' = mode === 0 ? observed : observed + 1
    */
      interface Runtime { routed: number; failed: number; settled: number; observed: number; mode: number }
      /* uneffect: refinement routing@1 create */ export function create(initial: Runtime) { return initial }
      /* uneffect: refinement routing@1 observe */ export function observe(runtime: Runtime) { return runtime }
      /* uneffect: refinement routing@1 action route */
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
    validateRefinementActionBodies("switch-completion-bench.ts", source, "routing", parseSpec("switch-completion-bench.ts", source).temporal);
  }, { time: 500, iterations: 20 });
});
