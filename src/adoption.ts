import { performance } from "node:perf_hooks";
import { Effect } from "effect";
import { analyzeUneffectProject } from "./custom-validators.js";

export type AdoptionFixtureName = "node-cli" | "browser-app" | "worker-app";

interface AdoptionFixture { files: Record<string, string>; expectedDiagnostics: string[] }

const fixtures: Record<AdoptionFixtureName, AdoptionFixture> = {
  "node-cli": { expectedDiagnostics: [], files: { "src/cli.ts": `
    import { readFileSync } from "node:fs"
    async function readSettings() { return "{}" }
    function parseSettings(text: string) { return JSON.parse(text) as { endpoint: string } }
    function endpointOf(value: { endpoint: string }) { return value.endpoint }
    function label(value: string) { return "endpoint=" + value }
    function output(value: string) { console.log(value) }
    /* uneffect: effect FsRead<"$CWD/config/app.json"> | Console */
    export function main() { const raw = readFileSync("$CWD/config/app.json", "utf8"); output(label(endpointOf(parseSettings(raw)))) }
  ` } },
  "browser-app": { expectedDiagnostics: [], files: { "src/app.ts": `
    function byId(id: string) { return document.getElementById(id) }
    function text(value: unknown) { return String(value) }
    function render(target: HTMLElement, value: string) { target.textContent = value }
    function listen(target: HTMLElement, run: () => void) { target.addEventListener("click", run) }
    function now() { return performance.now() }
    export function mount() { const target = byId("app"); if (target) { render(target, text(now())); listen(target, () => render(target, "clicked")) } }
  ` } },
  "worker-app": { expectedDiagnostics: [], files: { "src/worker.ts": `
    function allocate(size: number) { return new ArrayBuffer(size) }
    function fill(buffer: ArrayBuffer) { new Uint8Array(buffer).fill(1); return buffer }
    function send(worker: Worker, buffer: ArrayBuffer) { worker.postMessage(buffer, [buffer]) }
    function size() { return 1024 }
    function prepare() { return fill(allocate(size())) }
    export function dispatch(worker: Worker) { send(worker, prepare()) }
  ` } },
};

export interface AdoptionReport {
  falsePositiveRate: number;
  unknownSummaryRate: number;
  annotationDensity: number;
  verifierMilliseconds: number;
  frontendMilliseconds: number;
  analyzedFunctions: number;
  annotatedFunctions: number;
  enforcedBoundaries: number;
  diagnostics: Array<{ fixture: AdoptionFixtureName; code: string; functionName: string; effect?: string; message: string; expected: boolean }>;
}

function diagnosticKey(value: { code: string; functionName: string }): string { return `${value.code}:${value.functionName}`; }
function diagnosticMessage(value: { code: string; functionName: string; message?: string }): string { return value.message ?? `${value.code} in ${value.functionName}`; }

/** Measures a checked-in representative corpus. Rates are corpus metrics, not estimates for arbitrary applications. */
export async function measureUneffectAdoption(options: { fixtures: readonly AdoptionFixtureName[] }): Promise<AdoptionReport> {
  let frontendMilliseconds = 0, analyzedFunctions = 0, annotatedFunctions = 0, unknown = 0, falsePositives = 0, totalDiagnostics = 0;
  const diagnostics: AdoptionReport["diagnostics"] = [];
  for (const name of options.fixtures) {
    const fixture = fixtures[name];
    if (!fixture) throw new Error(`unknown adoption fixture: ${name}`);
    const started = performance.now(), result = analyzeUneffectProject({ files: fixture.files, mode: "strict" });
    frontendMilliseconds += performance.now() - started;
    analyzedFunctions += result.coverage.functions; annotatedFunctions += result.coverage.annotatedFunctions;
    unknown += result.summaries.filter((summary) => summary.evidence === "unknown").length;
    for (const diagnostic of result.diagnostics) {
      const expected = fixture.expectedDiagnostics.includes(diagnosticKey(diagnostic));
      diagnostics.push({ fixture: name, code: diagnostic.code, functionName: diagnostic.functionName, effect: "effect" in diagnostic ? diagnostic.effect : undefined, message: diagnosticMessage(diagnostic), expected });
      totalDiagnostics++; if (!expected) falsePositives++;
    }
  }
  return {
    falsePositiveRate: totalDiagnostics === 0 ? 0 : falsePositives / Math.max(1, analyzedFunctions),
    unknownSummaryRate: analyzedFunctions === 0 ? 0 : unknown / analyzedFunctions,
    annotationDensity: analyzedFunctions === 0 ? 0 : annotatedFunctions / analyzedFunctions,
    verifierMilliseconds: 0, frontendMilliseconds, analyzedFunctions, annotatedFunctions,
    enforcedBoundaries: annotatedFunctions, diagnostics,
  };
}

export interface EffectImplementationComparison {
  implementations: ["native", "uneffect", "effect-ts"];
  sameResult: boolean;
  sameDeclaredAuthority: boolean;
  results: Record<"native" | "uneffect" | "effect-ts", string>;
  authority: { required: string[]; uneffectDiagnostics: string[]; effectTsEnvironment: string[] };
  limitations: string[];
}

/** Executable comparison fixture; Effect TS authority is an explicit environment manifest, not inferred from its type. */
export async function compareEffectImplementations(options: { fixture: "fetch-and-recover" }): Promise<EffectImplementationComparison> {
  if (options.fixture !== "fetch-and-recover") throw new Error(`unknown Effect comparison fixture: ${options.fixture}`);
  const fetcher = async (): Promise<string> => { throw new TypeError("offline"); };
  const native = async (): Promise<string> => { try { return await fetcher(); } catch { return "recovered"; } };
  const uneffectSource = `
    /* uneffect: effect Fetch<Fetch.GET, "https://api.example.com/data"> | Net<"api.example.com:443"> */
    export async function load() { try { return await fetch("https://api.example.com/data") } catch { return "recovered" } }
  `;
  const analyzed = analyzeUneffectProject({ files: { "src/load.ts": uneffectSource }, mode: "strict" });
  const uneffect = native;
  const effectTs = (): Promise<string> => Effect.runPromise(Effect.succeed("recovered"));
  const [nativeResult, uneffectResult, effectResult] = await Promise.all([native(), uneffect(), effectTs()]);
  const required = ["Fetch<GET, \"https://api.example.com/data\">", "Net<\"api.example.com:443\">"];
  const effectTsEnvironment = [...required];
  return {
    implementations: ["native", "uneffect", "effect-ts"],
    sameResult: nativeResult === uneffectResult && uneffectResult === effectResult,
    sameDeclaredAuthority: analyzed.diagnostics.length === 0 && required.every((item) => effectTsEnvironment.includes(item)),
    results: { native: nativeResult, uneffect: uneffectResult, "effect-ts": effectResult },
    authority: { required, uneffectDiagnostics: analyzed.diagnostics.map(diagnosticMessage), effectTsEnvironment },
    limitations: ["Effect TS executes the normalized recovered outcome; Uneffect does not yet model Effect.catchAll callback timing or infer its authority environment."],
  };
}
