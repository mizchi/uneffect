import { bench, describe } from "vitest";
import ts from "typescript";
import { verifyTypedArraySafety, verifyTypedArraySafetyInProgram, verifyTypedArraySafetyInTypeScriptProgram } from "../src/typed-array-safety.js";
import { parseSpec } from "../src/spec-ir.js";
import { generateQuint } from "../src/spec-backends.js";
import { findTemporalCounterexampleWithZ3, lintTemporalReachabilityWithZ3, lintTemporalSpec, lintTemporalSpecWithZ3 } from "../src/spec-lint.js";
import { generateUneffectPropertyTests } from "../src/property-tests.js";
import { analyzeUneffectProject, defineUneffectValidator } from "../src/custom-validators.js";
import { createModelCounterexample, parseQuintItfCounterexample, parseTlcCounterexample, replayModelCounterexample } from "../src/model-replay.js";
import { generateRefinementAdapterModule } from "../src/refinement-bindings.js";

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

  bench("derive branched affine hints for 16 scalar contracts", () => {
    const functions = Array.from({ length: 16 }, (_, index) => `
      /* uneffect: requires (value + 2 >= ${index * 10} && value + 2 < ${index * 10 + 5}) || (value >= ${index * 10 + 20} && value < ${index * 10 + 25}) */
      /* uneffect: ensures result >= ${index * 10 - 2} */
      export function branched${index}(value: Int): Int { return value }
    `).join("\n");
    generateUneffectPropertyTests({ files: { "src/branched.ts": `import type { Int } from "@mizchi/uneffect"\n${functions}` }, shrinking: true });
  }, { time: 500, iterations: 20 });

  bench("derive correlated affine tuples for 16 two-parameter contracts", () => {
    const functions = Array.from({ length: 16 }, (_, index) => `
      /* uneffect: requires x >= ${index * 10} && x < ${index * 10 + 5} && y === x + 1 */
      /* uneffect: ensures result === y */
      export function dependent${index}(x: Int, y: Int): Int { return y }
    `).join("\n");
    generateUneffectPropertyTests({ files: { "src/dependent.ts": `import type { Int } from "@mizchi/uneffect"\n${functions}` }, shrinking: true });
  }, { time: 500, iterations: 20 });

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
});
