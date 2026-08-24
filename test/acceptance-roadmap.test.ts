import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import * as uneffect from "../src/index.js";

type FutureApi = (...args: unknown[]) => unknown;

function futureApi(name: string): FutureApi {
  const candidate = (uneffect as unknown as Record<string, unknown>)[name];
  expect(candidate, `public API ${name} is not implemented`).toBeTypeOf("function");
  return candidate as FutureApi;
}

const files = (entries: Record<string, string>) => entries;

describe("Uneffect end-to-end acceptance roadmap", () => {
  it("generates shrinking property tests from refined TypeScript boundaries and replays counterexamples", async () => {
    const generatePropertyTests = futureApi("generateUneffectPropertyTests");
    const result = await generatePropertyTests({ files: files({
      "src/divide.ts": `
        import type { Int, Nat } from "@mizchi/uneffect"
        /* uneffect: requires denominator > 0 */
        /* uneffect: ensures result * denominator <= numerator */
        export function quotient(numerator: Nat, denominator: Int): Int {
          return Math.floor(numerator / denominator) as Int
        }
      `,
    }), backend: "quickcheck", shrinking: true }) as { generatedFiles: Record<string, string>; boundaries: Array<{ functionName: string; generators: string[]; shrinkers: string[] }> };
    expect(result.boundaries).toContainEqual(expect.objectContaining({
      functionName: "quotient", generators: ["Nat", "Int"], shrinkers: ["Nat", "Int"],
    }));
    expect(result.generatedFiles["src/divide.uneffect.test.ts"]).toContain("shrink");
  });

  it("reports annotation drift when implementation effects exceed or no longer use the declared upper bound", async () => {
    const analyzeProject = futureApi("analyzeUneffectProject");
    const result = await analyzeProject({ mode: "strict", files: files({
      "src/io.ts": `
        /* uneffect: effect Console | FsRead<"$CWD/config/**"> */
        export async function load() {
          await fetch("https://api.example.com/data")
        }
      `,
    }) }) as { diagnostics: Array<{ code: string; effect: string }> };
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "missing-effect", effect: expect.stringContaining("Fetch") }));
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "unused-effect", effect: "Console" }),
      expect.objectContaining({ code: "unused-effect", effect: expect.stringContaining("FsRead") }),
    ]));
  });

  it("adopts ordinary TypeScript gradually without changing its emitted JavaScript", async () => {
    const analyzeProject = futureApi("analyzeUneffectProject");
    const result = await analyzeProject({
      files: files({ "src/plain.ts": `export function add(a: number, b: number) { return a + b }` }),
      mode: "gradual",
    }) as { diagnostics: unknown[]; emittedFiles: Record<string, string>; coverage: { annotatedFunctions: number } };
    expect(result.diagnostics).toEqual([]);
    expect(result.coverage.annotatedFunctions).toBe(0);
    expect(result.emittedFiles["src/plain.js"]).toContain("return a + b");
    expect(result.emittedFiles["src/plain.js"]).not.toContain("uneffect");
  });

  it("checks scoped builtin and user-defined capability sets transitively and warns about unused upper bounds", async () => {
    const analyzeProject = futureApi("analyzeUneffectProject");
    const result = await analyzeProject({
      files: files({
        "src/app.ts": `
          import { readFile } from "node:fs/promises"
          /* uneffect: effect_schema Audit<ResourceSet> */
          /* uneffect: effect FsRead<\"$WORKSPACE_ROOT/config/**\"> | Fetch<Fetch.GET, \"https://api.example.com/v1/**\"> | Net<\"api.example.com:443\"> | Audit<\"users\"> | Console */
          export async function load() {
            await fetch("https://api.example.com/v1/users")
            return readFile("$WORKSPACE_ROOT/config/app.json")
          }
        `,
      }),
      mode: "strict",
    }) as { diagnostics: Array<{ code: string; effect?: string }> };
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "unused-effect", effect: "Console" }));
    expect(result.diagnostics).not.toContainEqual(expect.objectContaining({ code: "missing-effect" }));
  });

  it("runs a user validator and specializes passing functions with an at-most-once sink summary", async () => {
    const defineValidator = futureApi("defineUneffectValidator");
    const analyzeProject = futureApi("analyzeUneffectProject");
    const datadogOnce = defineValidator({
      name: "DatadogOnce",
      rule: "at-most-once",
      sink: { module: "@datadog/browser-rum", export: "datadogRum.addAction" },
      specialization: { kind: "call-cardinality", maximum: 1 },
    });
    const result = await analyzeProject({ validators: [datadogOnce], files: files({
      "src/report.ts": `
        import { datadogRum } from "@datadog/browser-rum"
        /* uneffect: validate DatadogOnce */
        export function report(enabled: boolean) {
          if (enabled) datadogRum.addAction("loaded")
        }
      `,
    }) }) as { diagnostics: unknown[]; summaries: Array<{ functionName: string; specializations: Array<{ validator: string; maximum: number; evidence: string }> }> };
    expect(result.diagnostics).toEqual([]);
    expect(result.summaries).toContainEqual(expect.objectContaining({
      functionName: "report",
      specializations: [expect.objectContaining({ validator: "DatadogOnce", maximum: 1, evidence: "verified" })],
    }));
  });

  it("composes validator cardinality through aliases, barrels, namespace imports, default exports, and methods", async () => {
    const defineValidator = futureApi("defineUneffectValidator");
    const validateProject = futureApi("validateUneffectProject");
    const validator = defineValidator({ name: "DatadogOnce", version: "2026-08", rule: "at-most-once", sink: { module: "./metrics.js", export: "sendMetric" }, specialization: { kind: "call-cardinality", maximum: 1 } });
    const result = await validateProject({ validator, files: files({
      "src/metrics.ts": `export declare function sendMetric(): void`,
      "src/reporters.ts": `
        import { sendMetric as emit } from "./metrics.js"
        export function helper() { emit() }
        export default function defaultReporter() { emit() }
        export class Reporter { report() { emit() } }
      `,
      "src/barrel.ts": `export { helper as forwarded, default as defaultReporter, Reporter } from "./reporters.js"`,
      "src/main.ts": `
        import { forwarded as renamed, defaultReporter, Reporter } from "./barrel.js"
        import * as reports from "./barrel.js"
        import { opaque } from "./missing.js"
        /* uneffect: validate DatadogOnce */
        export function viaAlias() { renamed() }
        /* uneffect: validate DatadogOnce */
        export function viaNamespace() { reports.forwarded() }
        /* uneffect: validate DatadogOnce */
        export function viaDefault() { defaultReporter() }
        /* uneffect: validate DatadogOnce */
        export function viaMethod() { new Reporter().report() }
        /* uneffect: validate DatadogOnce */
        export function twice() { renamed(); new Reporter().report() }
        /* uneffect: validate DatadogOnce */
        export function unresolved() { opaque() }
      `,
    }) }) as { diagnostics: Array<{ code: string; functionName: string; inferredMaximum: string }>; summaries: Array<{ functionName: string; specializations: Array<{ evidence: string; inferredMaximum: string }> }> };
    for (const functionName of ["viaAlias", "viaNamespace", "viaDefault", "viaMethod"]) {
      expect(result.summaries).toContainEqual(expect.objectContaining({ functionName, specializations: [expect.objectContaining({ schema: "uneffect-cardinality/v1", evidence: "verified", inferredMaximum: "1", validatorVersion: "2026-08", validatorDigest: expect.stringMatching(/^[0-9a-f]{64}$/), compilerRevision: expect.any(String), sourceHash: expect.stringMatching(/^[0-9a-f]{64}$/), projectHash: expect.stringMatching(/^[0-9a-f]{64}$/) })] }));
    }
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "validator-cardinality-exceeded", functionName: "twice", inferredMaximum: "many" }));
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "validator-cardinality-unknown", functionName: "unresolved", inferredMaximum: "unknown" }));
    expect(result.summaries.find((summary) => summary.functionName === "unresolved")?.specializations).toEqual([]);
  });

  it("rejects sequential, repeated, concurrent, recursive, or unknown callback paths that may call a sink more than once", async () => {
    const defineValidator = futureApi("defineUneffectValidator");
    const validateProject = futureApi("validateUneffectProject");
    const validator = defineValidator({ name: "DatadogOnce", rule: "at-most-once", sink: { module: "./metrics", export: "sendMetric" }, specialization: { kind: "call-cardinality", maximum: 1 } });
    const result = await validateProject({ validator, files: files({
      "src/metrics.ts": `export declare function sendMetric(): Promise<void>`,
      "src/duplicates.ts": `
        import { sendMetric } from "./metrics"
        /* uneffect: validate DatadogOnce */
        function sequential() { sendMetric(); sendMetric() }
        /* uneffect: validate DatadogOnce */
        function repeated(items: string[]) { for (const item of items) sendMetric() }
        /* uneffect: validate DatadogOnce */
        async function concurrent() { await Promise.all([sendMetric(), sendMetric()]) }
        /* uneffect: validate DatadogOnce */
        function recursive() { sendMetric(); if (retry()) recursive() }
        /* uneffect: validate DatadogOnce */
        function callback(run: (job: () => void) => void) { run(() => sendMetric()) }
      `,
    }) }) as { diagnostics: Array<{ code: string; functionName: string; inferredMaximum: string }> };
    for (const functionName of ["sequential", "repeated", "concurrent"]) {
      expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "validator-cardinality-exceeded", functionName }));
    }
    for (const functionName of ["recursive", "callback"]) expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "validator-cardinality-unknown", functionName }));
  });

  it("composes call cardinality through Generator yield, yield-star, AsyncGenerator, and a single main consumption", async () => {
    const defineValidator = futureApi("defineUneffectValidator");
    const validateProject = futureApi("validateUneffectProject");
    const validator = defineValidator({ name: "DatadogOnce", rule: "at-most-once", sink: { module: "./metrics", export: "sendMetric" }, specialization: { kind: "call-cardinality", maximum: 1 } });
    const result = await validateProject({ validator, entrypoint: "main", files: files({
      "src/metrics.ts": `export declare function sendMetric(): unknown`,
      "src/main.ts": `
        import { sendMetric } from "./metrics"
        declare function loadWithoutMetrics(): Promise<void>
        function* optional(enabled: boolean) {
          if (enabled) yield sendMetric()
        }
        /* uneffect: validate DatadogOnce */
        function constructOnly() { optional(true) }
        async function* pipeline(enabled: boolean) {
          yield* optional(enabled)
          yield await loadWithoutMetrics()
        }
        /* uneffect: validate DatadogOnce */
        async function main(enabled: boolean) {
          for await (const _effect of pipeline(enabled)) {}
        }
      `,
    }) }) as { diagnostics: unknown[]; summaries: Array<{ functionName: string; specializations: Array<{ inferredMaximum: string }> }>; entrypoint: { functionName: string; sinkMaximum: number; generatorConsumption: string } };
    expect(result.diagnostics).toEqual([]);
    expect(result.summaries).toContainEqual(expect.objectContaining({ functionName: "constructOnly", specializations: [expect.objectContaining({ inferredMaximum: "0" })] }));
    expect(result.entrypoint).toEqual({ functionName: "main", sinkMaximum: 1, generatorConsumption: "once" });

    const duplicated = await validateProject({ validator, entrypoint: "main", files: files({
      "src/metrics.ts": `export declare function sendMetric(): unknown`,
      "src/main.ts": `
        import { sendMetric } from "./metrics"
        function* pipeline() { yield sendMetric() }
        /* uneffect: validate DatadogOnce */
        async function main() {
          for (const _effect of pipeline()) {}
          for (const _effect of pipeline()) {}
        }
      `,
    }) }) as { diagnostics: Array<{ code: string; inferredMaximum: string }> };
    expect(duplicated.diagnostics).toContainEqual(expect.objectContaining({ code: "validator-cardinality-exceeded", inferredMaximum: "many" }));
  });

  it("tracks typed synchronous throws and Promise rejection ownership through explicit discharge boundaries", async () => {
    const analyzeProject = futureApi("analyzeUneffectProject");
    const result = await analyzeProject({ files: files({
      "src/errors.ts": `
        class ParseError extends Error {}
        /* uneffect: effect Throw<ParseError> */
        function parse(input: string) { if (!input) throw new ParseError(); return input }
        function syncHandled() { try { parse("") } catch (error) {} }
        async function asyncHandled() { try { await Promise.reject(new ParseError()) } catch (error) {} }
        async function floating() { Promise.reject(new ParseError()) }
      `,
    }) }) as { diagnostics: Array<{ code: string; functionName: string }>; summaries: Array<{ functionName: string; effects: string[] }> };
    expect(result.summaries).toContainEqual(expect.objectContaining({ functionName: "parse", effects: ["Throw<ParseError>"] }));
    expect(result.summaries).toContainEqual(expect.objectContaining({ functionName: "syncHandled", effects: [] }));
    expect(result.diagnostics).not.toContainEqual(expect.objectContaining({ functionName: "syncHandled" }));
    expect(result.diagnostics).not.toContainEqual(expect.objectContaining({ functionName: "asyncHandled" }));
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "floating-promise", functionName: "floating" }));
  });

  it("verifies Hoare contracts with Z3 and emits explicit Valibot assertions in the same optional runtime build", async () => {
    const verifyProject = futureApi("verifyUneffectProject");
    const result = await verifyProject({ files: files({
      "src/numeric.ts": `
        import type { Nat } from "@mizchi/uneffect"
        /* uneffect: requires value >= 0 */
        /* uneffect: ensures result > value */
        /* uneffect: assert value: Nat */
        export function increment(value: Nat) { return value + 1 }
      `,
    }), runtimeAssertions: "fallback" }) as { obligations: Array<{ backend: string; result: string }>; emittedFiles: Record<string, string> };
    expect(result.obligations).toContainEqual(expect.objectContaining({ backend: "z3", result: "verified" }));
    expect(result.emittedFiles["src/numeric.js"]).toContain("valibot");
  });

  it("composes temporal function contracts with the Web event loop instead of passing inline Quint through", async () => {
    const verifyProject = futureApi("verifyUneffectProject");
    const result = await verifyProject({ files: files({
      "src/scheduler.ts": `
        /* uneffect: state phase: int */
        /* uneffect: init phase = 0 */
        /* uneffect: temporal committedOnce: phase <= 1 */
        /* uneffect: temporal_requires phase === 0 */
        /* uneffect: temporal_ensures phase' = phase + 1 */
        /* uneffect: temporal_modifies phase */
        function commit() {}
        function main() { queueMicrotask(commit) }
      `,
    }), temporalRuntime: "web" }) as { temporal: { sourceLanguage: string; backend: string; models: Array<{ kind: string; quint: string }>; properties: Array<{ name: string; result: string }> } };
    expect(result.temporal.sourceLanguage).toBe("uneffect-ts");
    expect(result.temporal.backend).toBe("quint");
    expect(result.temporal.models).toContainEqual(expect.objectContaining({ kind: "web-event-loop", quint: expect.stringContaining("eventLoopSafe") }));
    expect(result.temporal.models[0]?.quint).toContain("phase' = phase + 1");
    expect(result.temporal.properties).toContainEqual(expect.objectContaining({ name: "eventLoopSafe", result: "verified" }));
    expect(result.temporal.properties).toContainEqual(expect.objectContaining({ name: "committedOnce", result: "verified" }));

    const broken = await verifyProject({ files: files({
      "src/scheduler.ts": `
        /* uneffect: state phase: int */
        /* uneffect: init phase = 0 */
        /* uneffect: temporal_requires phase === 0 */
        /* uneffect: temporal_ensures phase' = phase + 1 */
        /* uneffect: temporal_modifies phase */
        function commit() {}
        function main() { queueMicrotask(commit); queueMicrotask(commit) }
      `,
    }), temporalRuntime: "web" }) as { temporal: { properties: Array<{ name: string; result: string }> } };
    expect(broken.temporal.properties).toContainEqual(expect.objectContaining({ name: "eventLoopSafe", result: "counterexample" }));
  }, 30_000);

  it("models using cleanup, Transferable ownership, and async exits in one ordered neutral IR", async () => {
    const analyzeProject = futureApi("analyzeUneffectProject");
    const result = await analyzeProject({ files: files({
      "src/worker.ts": `
        async function send(worker: Worker, buffer: ArrayBuffer, open: () => Promise<AsyncDisposable>) {
          await using resource = await open()
          worker.postMessage(buffer, [buffer])
          await Promise.resolve()
        }
      `,
    }) }) as { orderedEvents: Array<{ kind: string; resource?: string }> };
    expect(result.orderedEvents.map((event) => event.kind)).toEqual(["suspend", "acquire", "transfer", "suspend", "dispose"]);
    expect(result.orderedEvents).toContainEqual(expect.objectContaining({ kind: "transfer", resource: "buffer" }));
  });

  it("allows compression or mangling only when persisted proof dependencies still match", async () => {
    const optimizeProject = futureApi("optimizeUneffectProject");
    const directory = mkdtempSync(join(tmpdir(), "uneffect-acceptance-evidence-"));
    try {
      const options = {
        files: files({ "src/value.ts": `export function read(value: { stable: number }) { return value.stable + value.stable }` }),
        evidencePath: join(directory, "evidence.json"),
        closedWorld: true,
      };
      await optimizeProject(options);
      const result = await optimizeProject(options) as { transformations: Array<{ kind: string; applied: boolean; evidence: string }>; staleEvidence: unknown[] };
      expect(result.transformations).toContainEqual(expect.objectContaining({ applied: true, evidence: "verified" }));
      expect(result.staleEvidence).toEqual([]);
      const changed = await optimizeProject({ ...options, files: files({
        "src/value.ts": `export function read(value: { stable: number }) { value.stable++; return value.stable + value.stable }`,
      }) }) as { transformations: Array<{ applied: boolean }>; staleEvidence: unknown[] };
      expect(changed.transformations).not.toContainEqual(expect.objectContaining({ applied: true }));
      expect(changed.staleEvidence.length).toBeGreaterThan(0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("produces equivalent neutral IR from the TypeScript and Corsa frontends", async () => {
    const compareFrontends = futureApi("compareUneffectFrontends");
    const result = await compareFrontends({ files: files({
      "src/parity.ts": `/* uneffect: effect Console | Mutate<typeof value> */ export function update(value: { n: number }) { value.n++; console.log(value.n) }`,
    }) }) as { equivalent: boolean; schemaDrift: unknown[]; typescriptIr: unknown; corsaIr: unknown };
    expect(result.schemaDrift).toEqual([]);
    expect(result.typescriptIr).toEqual(result.corsaIr);
    expect(result.equivalent).toBe(true);
  }, 60_000);

  it("proves bounded Uint8Array allocation and rejects implicit u8 coercion", async () => {
    const verifyTypedArrays = futureApi("verifyTypedArraySafety");
    const result = await verifyTypedArrays("bytes.ts", `
      import type { BoundedUint8Array, Nat, U8 } from "@mizchi/uneffect"
      /* uneffect: requires size >= 0 && size <= 1024 */
      function allocate(size: Nat): BoundedUint8Array<1024> { return new Uint8Array(size) }
      /* uneffect: requires value >= 0 && value <= 255 */
      function write(bytes: BoundedUint8Array<1024>, index: Nat, value: U8) { bytes[index] = value }
      function truncates(bytes: Uint8Array, value: number) { bytes[0] = value }
      function unbounded(size: number): BoundedUint8Array<1024> { return new Uint8Array(size) }
    `) as { obligations: Array<{ functionName: string; kind: string; result: string }>; diagnostics: Array<{ functionName: string; kind: string }> };
    expect(result.obligations).toContainEqual(expect.objectContaining({ functionName: "allocate", kind: "max-length", result: "verified" }));
    expect(result.obligations).toContainEqual(expect.objectContaining({ functionName: "write", kind: "u8-write", result: "verified" }));
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ functionName: "truncates", kind: "u8-write" }));
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ functionName: "unbounded", kind: "max-length" }));
  });

  it("refines switch entry, fallthrough, break, and default as a symbolic temporal update", () => {
    const parseSpec = futureApi("parseSpec");
    const validateActions = futureApi("validateRefinementActionBodies");
    const source = `/* uneffect:
      state value: int
      state mode: int
      init value = 0
      init mode = 0
      action route: value' = mode === 0 ? value + 1 : mode === 1 ? value + 2 + 4 : value + 4
    */
      interface Runtime { value: number; mode: number }
      /* uneffect: refinement routing@1 create */ export function create(initial: Runtime) { return initial }
      /* uneffect: refinement routing@1 observe */ export function observe(runtime: Runtime) { return runtime }
      /* uneffect: refinement routing@1 action route */
      export function route(runtime: Runtime) {
        switch (runtime.mode) {
          case 0: runtime.value += 1; break
          case 1: runtime.value += 2
          default: runtime.value += 4; break
        }
      }
    `;
    const temporal = (parseSpec("switch-routing.ts", source) as { temporal: unknown }).temporal;
    expect(validateActions("switch-routing.ts", source, "routing", temporal)).toEqual([]);

    const dynamic = source.replace("case 1:", "case chooseMode():");
    expect(validateActions("dynamic-switch-routing.ts", dynamic, "routing", temporal)).toContainEqual(
      expect.objectContaining({ code: "unsupported-action-body", modelName: "route" }),
    );
  });

  it("refines a mandatory finally accounting update and rejects an unmodeled catch path", () => {
    const parseSpec = futureApi("parseSpec");
    const validateActions = futureApi("validateRefinementActionBodies");
    const source = `/* uneffect:
      state outcome: int
      state attempted: int
      init outcome = 0
      init attempted = 0
      action deliver: outcome' = outcome + 1, attempted' = attempted + 1
    */
      interface Runtime { outcome: number; attempted: number }
      /* uneffect: refinement accounting@1 create */ export function create(initial: Runtime) { return initial }
      /* uneffect: refinement accounting@1 observe */ export function observe(runtime: Runtime) { return runtime }
      /* uneffect: refinement accounting@1 action deliver */
      export function deliver(runtime: Runtime) {
        try { runtime.outcome++ }
        finally { runtime.attempted++ }
      }
    `;
    const temporal = (parseSpec("finally-accounting.ts", source) as { temporal: unknown }).temporal;
    expect(validateActions("finally-accounting.ts", source, "accounting", temporal)).toEqual([]);
    const withCatch = source.replace("finally {", "catch (error) { runtime.outcome-- } finally {");
    expect(validateActions("catch-accounting.ts", withCatch, "accounting", temporal)).toContainEqual(
      expect.objectContaining({ code: "unsupported-action-body", modelName: "deliver" }),
    );
  });

  it("refines an explicitly thrown failure through catch and finally", () => {
    const parseSpec = futureApi("parseSpec");
    const validateActions = futureApi("validateRefinementActionBodies");
    const source = `/* uneffect:
      state attempted: int
      state failed: int
      state settled: int
      init attempted = 0
      init failed = 0
      init settled = 0
      action reject: attempted' = attempted + 1, failed' = failed + 1, settled' = settled + 1
    */
      interface Runtime { attempted: number; failed: number; settled: number }
      /* uneffect: refinement accounting@1 create */ export function create(initial: Runtime) { return initial }
      /* uneffect: refinement accounting@1 observe */ export function observe(runtime: Runtime) { return runtime }
      /* uneffect: refinement accounting@1 action reject */
      export function reject(runtime: Runtime) {
        try {
          runtime.attempted++
          throw "delivery failed"
        } catch {
          runtime.failed++
        } finally {
          runtime.settled++
        }
      }
    `;
    const temporal = (parseSpec("caught-throw.ts", source) as { temporal: unknown }).temporal;
    expect(validateActions("caught-throw.ts", source, "accounting", temporal)).toEqual([]);
  });

  it("joins a conditional failure with the normal path through catch and finally", () => {
    const parseSpec = futureApi("parseSpec");
    const validateActions = futureApi("validateRefinementActionBodies");
    const source = `/* uneffect:
      state delivered: int
      state failed: int
      state settled: int
      state shouldFail: bool
      init delivered = 0
      init failed = 0
      init settled = 0
      init shouldFail = false
      action deliver: delivered' = shouldFail ? delivered : delivered + 1, failed' = shouldFail ? failed + 1 : failed, settled' = settled + 1
    */
      interface Runtime { delivered: number; failed: number; settled: number; shouldFail: boolean }
      /* uneffect: refinement delivery@1 create */ export function create(initial: Runtime) { return initial }
      /* uneffect: refinement delivery@1 observe */ export function observe(runtime: Runtime) { return runtime }
      /* uneffect: refinement delivery@1 action deliver */
      export function deliver(runtime: Runtime) {
        try {
          if (runtime.shouldFail) throw "delivery failed"
          runtime.delivered++
        } catch {
          runtime.failed++
        } finally {
          runtime.settled++
        }
      }
    `;
    const temporal = (parseSpec("conditional-throw.ts", source) as { temporal: unknown }).temporal;
    expect(validateActions("conditional-throw.ts", source, "delivery", temporal)).toEqual([]);
  });

  it("routes a nested conditional throw through the enclosing catch path", () => {
    const parseSpec = futureApi("parseSpec");
    const validateActions = futureApi("validateRefinementActionBodies");
    const source = `/* uneffect:
      state delivered: int
      state failed: int
      state settled: int
      state outer: bool
      state inner: bool
      init delivered = 0
      init failed = 0
      init settled = 0
      init outer = false
      init inner = false
      action deliver: delivered' = outer ? inner ? delivered : delivered + 1 : delivered, failed' = (outer ? inner : false) ? failed + 1 : failed, settled' = settled + 1
    */
      interface Runtime { delivered: number; failed: number; settled: number; outer: boolean; inner: boolean }
      /* uneffect: refinement delivery@1 create */ export function create(initial: Runtime) { return initial }
      /* uneffect: refinement delivery@1 observe */ export function observe(runtime: Runtime) { return runtime }
      /* uneffect: refinement delivery@1 action deliver */
      export function deliver(runtime: Runtime) {
        try {
          if (runtime.outer) {
            if (runtime.inner) throw "delivery failed"
            runtime.delivered++
          }
        } catch {
          runtime.failed++
        } finally {
          runtime.settled++
        }
      }
    `;
    const temporal = (parseSpec("nested-throw.ts", source) as { temporal: unknown }).temporal;
    expect(validateActions("nested-throw.ts", source, "delivery", temporal)).toEqual([]);
  });

  it("keeps return and throw paths distinct while catch discharges only throw", () => {
    const parseSpec = futureApi("parseSpec");
    const validateActions = futureApi("validateRefinementActionBodies");
    const source = `/* uneffect:
      state returned: int
      state caught: int
      state settled: int
      state chooseReturn: bool
      init returned = 0
      init caught = 0
      init settled = 0
      init chooseReturn = false
      action finish: returned' = chooseReturn ? returned + 1 : returned, caught' = !chooseReturn ? caught + 1 : caught, settled' = settled + 1
    */
      interface Runtime { returned: number; caught: number; settled: number; chooseReturn: boolean }
      /* uneffect: refinement completion@1 create */ export function create(initial: Runtime) { return initial }
      /* uneffect: refinement completion@1 observe */ export function observe(runtime: Runtime) { return runtime }
      /* uneffect: refinement completion@1 action finish */
      export function finish(runtime: Runtime) {
        try {
          if (runtime.chooseReturn) { runtime.returned++; return }
          throw "failed"
        } catch {
          runtime.caught++
        } finally {
          runtime.settled++
        }
      }
    `;
    const temporal = (parseSpec("heterogeneous-completion.ts", source) as { temporal: unknown }).temporal;
    expect(validateActions("heterogeneous-completion.ts", source, "completion", temporal)).toEqual([]);
  });

  it("executes finally but suppresses post-try work on an early-return path", () => {
    const parseSpec = futureApi("parseSpec");
    const validateActions = futureApi("validateRefinementActionBodies");
    const source = `/* uneffect:
      state worked: int
      state released: int
      state observed: int
      state cancelled: bool
      init worked = 0
      init released = 0
      init observed = 0
      init cancelled = false
      action execute: worked' = cancelled ? worked : worked + 1, released' = released + 1, observed' = cancelled ? observed : observed + 1
    */
      interface Runtime { worked: number; released: number; observed: number; cancelled: boolean }
      /* uneffect: refinement resource@1 create */ export function create(initial: Runtime) { return initial }
      /* uneffect: refinement resource@1 observe */ export function observe(runtime: Runtime) { return runtime }
      /* uneffect: refinement resource@1 action execute */
      export function execute(runtime: Runtime) {
        try {
          if (runtime.cancelled) return
          runtime.worked++
        } finally {
          runtime.released++
        }
        runtime.observed++
      }
    `;
    const temporal = (parseSpec("finally-return.ts", source) as { temporal: unknown }).temporal;
    expect(validateActions("finally-return.ts", source, "resource", temporal)).toEqual([]);
  });

  it("allows finally to override normal completion with a void return", () => {
    const parseSpec = futureApi("parseSpec");
    const validateActions = futureApi("validateRefinementActionBodies");
    const source = `/* uneffect:
      state worked: int
      state released: int
      state observed: int
      init worked = 0
      init released = 0
      init observed = 0
      action execute: worked' = worked + 1, released' = released + 1
    */
      interface Runtime { worked: number; released: number; observed: number }
      /* uneffect: refinement resource@1 create */ export function create(initial: Runtime) { return initial }
      /* uneffect: refinement resource@1 observe */ export function observe(runtime: Runtime) { return runtime }
      /* uneffect: refinement resource@1 action execute */
      export function execute(runtime: Runtime) {
        try { runtime.worked++ }
        finally { runtime.released++; return }
        runtime.observed++
      }
    `;
    const temporal = (parseSpec("finally-return-override.ts", source) as { temporal: unknown }).temporal;
    expect(validateActions("finally-return-override.ts", source, "resource", temporal)).toEqual([]);
  });

  it("propagates nested early return without executing enclosing continuations", () => {
    const parseSpec = futureApi("parseSpec");
    const validateActions = futureApi("validateRefinementActionBodies");
    const source = `/* uneffect:
      state routed: int
      state observed: int
      state outer: bool
      state inner: bool
      init routed = 0
      init observed = 0
      init outer = false
      init inner = false
      action route: routed' = outer ? inner ? routed : routed + 1 : routed, observed' = outer ? inner ? observed : observed + 1 : observed + 1
    */
      interface Runtime { routed: number; observed: number; outer: boolean; inner: boolean }
      /* uneffect: refinement routing@1 create */ export function create(initial: Runtime) { return initial }
      /* uneffect: refinement routing@1 observe */ export function observe(runtime: Runtime) { return runtime }
      /* uneffect: refinement routing@1 action route */
      export function route(runtime: Runtime) {
        if (runtime.outer) {
          if (runtime.inner) return
          runtime.routed++
        }
        runtime.observed++
      }
    `;
    const temporal = (parseSpec("nested-return.ts", source) as { temporal: unknown }).temporal;
    expect(validateActions("nested-return.ts", source, "routing", temporal)).toEqual([]);
  });

  it("joins an early-return action branch without executing its trailing updates", () => {
    const parseSpec = futureApi("parseSpec");
    const validateActions = futureApi("validateRefinementActionBodies");
    const source = `/* uneffect:
      state attempts: int
      state routed: int
      state stop: bool
      init attempts = 0
      init routed = 0
      init stop = false
      action route: attempts' = attempts + 1, routed' = stop ? routed + 1 : routed + 2
    */
      interface Runtime { attempts: number; routed: number; stop: boolean }
      /* uneffect: refinement routing@1 create */ export function create(initial: Runtime) { return initial }
      /* uneffect: refinement routing@1 observe */ export function observe(runtime: Runtime) { return runtime }
      /* uneffect: refinement routing@1 action route */
      export function route(runtime: Runtime) {
        runtime.attempts++
        if (runtime.stop) { runtime.routed++; return }
        runtime.routed += 2
      }
    `;
    const temporal = (parseSpec("early-return-routing.ts", source) as { temporal: unknown }).temporal;
    expect(validateActions("early-return-routing.ts", source, "routing", temporal)).toEqual([]);
    const valueReturn = source.replace("return }", "return runtime.routed }");
    expect(validateActions("value-return-routing.ts", valueReturn, "routing", temporal)).toContainEqual(
      expect.objectContaining({ code: "unsupported-action-body", modelName: "route" }),
    );
  });

  it("refines a Set-backed lease implementation against its temporal actions and invariants", async () => {
    const parseSpec = futureApi("parseSpec");
    const validateProjection = futureApi("validateRefinementStateProjectionInProgram");
    const validateActions = futureApi("validateRefinementActionBodiesInProgramWithZ3");
    const validateInvariants = futureApi("validateRefinementInvariantBodiesInProgramWithZ3");
    const validateInvariantsWithoutTypes = futureApi("validateRefinementInvariantBodies");
    const directory = mkdtempSync(join(tmpdir(), "uneffect-acceptance-lease-"));
    const fileName = join(directory, "lease.ts");
    const source = `/* uneffect:
      state owners: Set<int>
      state allowedOwners: Set<int>
      state epochs: Map<int, int>
      state leases: Map<int, { epoch: int, valid: bool }>
      init owners = Set(1)
      init allowedOwners = Set(1, 2)
      init epochs = Map([[1, 1]])
      init leases = Map([[1, { epoch: 1, valid: true }]])
      action acquire: owners' = owners.union(Set(2)), epochs' = epochs.put(2, 1)
      temporal ownerPresent: owners.contains(1)
      temporal epochRegistered: epochs.keys().contains(1)
      temporal initialEpoch: epochs.keys().contains(1) && epochs.get(1) === 1
      temporal epochsNonNegative: epochs.values().forall(epoch => epoch >= 0)
      temporal epochKeysKnown: epochs.keys().forall(owner => owner === 1 || owner === 2)
      temporal validLeases: leases.values().forall(lease => !lease.valid || lease.epoch > 0)
      temporal ownersAllowed: owners.forall(owner => allowedOwners.contains(owner))
      temporal hasOwnerOne: owners.exists(owner => owner === 1)
    */
      interface LeaseRecord { epoch: number; valid: boolean }
      interface Runtime { owners: Set<number>; allowedOwners: Set<number>; epochs: Map<number, number>; leases: Map<number, LeaseRecord> }
      /* uneffect: refinement lease@1 create */
      export function createLease(initial: Runtime): Runtime { return initial }
      /* uneffect: refinement lease@1 observe */
      export function observeLease(runtime: Runtime): Runtime { return runtime }
      /* uneffect: refinement lease@1 action acquire */
      export function acquire(runtime: Runtime) { runtime.owners.add(2); runtime.epochs.set(2, 1) }
      /* uneffect: refinement lease@1 invariant ownerPresent */
      export function ownerPresent(runtime: Runtime) { return runtime.owners.has(1) }
      /* uneffect: refinement lease@1 invariant epochRegistered */
      export function epochRegistered(runtime: Runtime) { return runtime.epochs.has(1) }
      /* uneffect: refinement lease@1 invariant initialEpoch */
      export function initialEpoch(runtime: Runtime) { return runtime.epochs.has(1) && runtime.epochs.get(1) === 1 }
      /* uneffect: refinement lease@1 invariant epochsNonNegative */
      export function epochsNonNegative(runtime: Runtime) { return Array.from(runtime.epochs.values()).every(epoch => epoch >= 0) }
      /* uneffect: refinement lease@1 invariant epochKeysKnown */
      export function epochKeysKnown(runtime: Runtime) { return Array.from(runtime.epochs.keys()).every(owner => owner === 1 || owner === 2) }
      /* uneffect: refinement lease@1 invariant validLeases */
      export function validLeases(runtime: Runtime) {
        return Array.from(runtime.leases.values()).every(lease => { return !lease.valid || lease.epoch > 0 })
      }
      /* uneffect: refinement lease@1 invariant ownersAllowed */
      export function ownersAllowed(runtime: Runtime) { return Array.from(runtime.owners).every(owner => runtime.allowedOwners.has(owner)) }
      /* uneffect: refinement lease@1 invariant hasOwnerOne */
      export function hasOwnerOne(runtime: Runtime) { return Array.from(runtime.owners).some(owner => owner === 1) }
    `;
    try {
      writeFileSync(fileName, source);
      const program = ts.createProgram([fileName], { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, noEmit: true });
      const spec = (parseSpec(fileName, source) as { temporal: unknown }).temporal;
      expect(validateInvariantsWithoutTypes(fileName, source, "lease", spec)).toContainEqual(
        expect.objectContaining({ code: "unsupported-invariant-body", modelName: "ownersAllowed" }),
      );
      expect(validateProjection(program, fileName, "lease", spec)).toEqual([]);
      await expect(validateActions(program, fileName, "lease", spec)).resolves.toEqual([]);
      await expect(validateInvariants(program, fileName, "lease", spec)).resolves.toEqual([]);

      const broken = source.replace("runtime.owners.has(1)", "runtime.owners.has(2)");
      writeFileSync(fileName, broken);
      const brokenProgram = ts.createProgram([fileName], { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, noEmit: true });
      await expect(validateInvariants(brokenProgram, fileName, "lease", spec)).resolves.toContainEqual(
        expect.objectContaining({ code: "invariant-expression-mismatch", modelName: "ownerPresent" }),
      );
      const brokenMap = source.replace("runtime.epochs.has(1)", "runtime.epochs.has(2)");
      writeFileSync(fileName, brokenMap);
      const brokenMapProgram = ts.createProgram([fileName], { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, noEmit: true });
      await expect(validateInvariants(brokenMapProgram, fileName, "lease", spec)).resolves.toContainEqual(
        expect.objectContaining({ code: "invariant-expression-mismatch", modelName: "epochRegistered" }),
      );
      const brokenValue = source.replace("runtime.epochs.get(1) === 1", "runtime.epochs.get(1) === 2");
      writeFileSync(fileName, brokenValue);
      const brokenValueProgram = ts.createProgram([fileName], { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, noEmit: true });
      await expect(validateInvariants(brokenValueProgram, fileName, "lease", spec)).resolves.toContainEqual(
        expect.objectContaining({ code: "invariant-expression-mismatch", modelName: "initialEpoch" }),
      );
      const brokenAuthority = source.replace("runtime.allowedOwners.has(owner)", "runtime.allowedOwners.has(2)");
      writeFileSync(fileName, brokenAuthority);
      const brokenAuthorityProgram = ts.createProgram([fileName], { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, noEmit: true });
      await expect(validateInvariants(brokenAuthorityProgram, fileName, "lease", spec)).resolves.toContainEqual(
        expect.objectContaining({ code: "invariant-expression-mismatch", modelName: "ownersAllowed" }),
      );
      const brokenValues = source.replace(
        "Array.from(runtime.epochs.values()).every(epoch => epoch >= 0)",
        "Array.from(runtime.epochs.values()).every(epoch => epoch > 0)",
      );
      writeFileSync(fileName, brokenValues);
      const brokenValuesProgram = ts.createProgram([fileName], { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, noEmit: true });
      await expect(validateInvariants(brokenValuesProgram, fileName, "lease", spec)).resolves.toContainEqual(
        expect.objectContaining({ code: "invariant-expression-mismatch", modelName: "epochsNonNegative" }),
      );
      const brokenExistential = source.replace(
        "Array.from(runtime.owners).some(owner => owner === 1)",
        "Array.from(runtime.owners).some(owner => owner === 2)",
      );
      writeFileSync(fileName, brokenExistential);
      const brokenExistentialProgram = ts.createProgram([fileName], { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, noEmit: true });
      await expect(validateInvariants(brokenExistentialProgram, fileName, "lease", spec)).resolves.toContainEqual(
        expect.objectContaining({ code: "invariant-expression-mismatch", modelName: "hasOwnerOne" }),
      );
      const brokenLeaseField = source.replace(
        "return Array.from(runtime.leases.values()).every(lease => { return !lease.valid || lease.epoch > 0 })",
        "return Array.from(runtime.leases.values()).every(lease => { return !lease.valid || lease.epoch >= 0 })",
      );
      writeFileSync(fileName, brokenLeaseField);
      const brokenLeaseFieldProgram = ts.createProgram([fileName], { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, noEmit: true });
      await expect(validateInvariants(brokenLeaseFieldProgram, fileName, "lease", spec)).resolves.toContainEqual(
        expect.objectContaining({ code: "invariant-expression-mismatch", modelName: "validLeases" }),
      );
      const statementCallback = source.replace(
        "lease => { return !lease.valid || lease.epoch > 0 }",
        "lease => { const epoch = lease.epoch; return !lease.valid || epoch > 0 }",
      );
      writeFileSync(fileName, statementCallback);
      const statementCallbackProgram = ts.createProgram([fileName], { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, noEmit: true });
      await expect(validateInvariants(statementCallbackProgram, fileName, "lease", spec)).resolves.toEqual([]);
      const mutableCallback = statementCallback.replace("const epoch = lease.epoch", "let epoch = lease.epoch");
      writeFileSync(fileName, mutableCallback);
      const mutableCallbackProgram = ts.createProgram([fileName], { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, noEmit: true });
      await expect(validateInvariants(mutableCallbackProgram, fileName, "lease", spec)).resolves.toContainEqual(
        expect.objectContaining({ code: "unsupported-invariant-body", modelName: "validLeases" }),
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("compares native Promise, Uneffect annotations, and Effect TS against the same observable contract", async () => {
    const compareImplementations = futureApi("compareEffectImplementations");
    const result = await compareImplementations({ fixture: "fetch-and-recover" }) as { implementations: string[]; sameResult: boolean; sameDeclaredAuthority: boolean; effectTsRecovery: { unhandledFailures: number }; limitations: string[] };
    expect(result.implementations).toEqual(["native", "uneffect", "effect-ts"]);
    expect(result.sameResult).toBe(true);
    expect(result.sameDeclaredAuthority).toBe(true);
    expect(result.effectTsRecovery.unhandledFailures).toBe(0);
    expect(result.limitations).not.toContain(expect.stringContaining("catchAll"));
  });

  it("dogfoods representative projects and reports adoption and verifier KPIs", async () => {
    const measureAdoption = futureApi("measureUneffectAdoption");
    const report = await measureAdoption({ fixtures: ["node-cli", "browser-app", "worker-app"] }) as {
      falsePositiveRate: number;
      unknownSummaryRate: number;
      annotationDensity: number;
      verifierMilliseconds: number;
      frontendMilliseconds: number;
      builtinDrift: unknown[];
      external: { packageName: string; sourceFiles: number; analyzedFunctions: number; unknownSummaries: number; diagnostics: unknown[]; builtinDrift: unknown[]; frontendMilliseconds: number };
    };
    expect(report.falsePositiveRate).toBeLessThanOrEqual(0.02);
    expect(report.unknownSummaryRate).toBeLessThanOrEqual(0.05);
    expect(report.annotationDensity).toBeLessThanOrEqual(0.15);
    expect(report.verifierMilliseconds).toBeGreaterThan(0);
    expect(report.frontendMilliseconds).toBeGreaterThan(0);
    expect(report.builtinDrift).toEqual([]);
    expect(report.external).toMatchObject({ packageName: "effect", unknownSummaries: 0, diagnostics: [], builtinDrift: [] });
    expect(report.external.sourceFiles).toBeGreaterThanOrEqual(3);
    expect(report.external.analyzedFunctions).toBeGreaterThanOrEqual(40);
    expect(report.external.frontendMilliseconds).toBeGreaterThan(0);
  });
});
