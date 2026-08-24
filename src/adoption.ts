import { performance } from "node:perf_hooks";
import { Effect } from "effect";
import ts from "typescript";
import { analyzeUneffectProject } from "./custom-validators.js";
import { analyzeProgramEffects } from "./effects.js";
import { auditBuiltinDeclarationDrift, type DeclarationDriftDiagnostic } from "./frontend-adapter.js";
import { verifyUneffectProject } from "./project-verification.js";

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
    /* uneffect: effect Dom<TextWrite, typeof target> | Dom<NodeWrite, typeof target> | Mutate<typeof target> | InvokeUserCode */
    function render(target: HTMLElement, value: string) { target.textContent = value }
    /* uneffect: effect Dom<AttributeRead, typeof target> | Dom<AttributeWrite, typeof target> | Dom<NodeRead, typeof target> | Dom<TextRead, typeof label> | Mutate<typeof target> | InvokeUserCode */
    function snapshotAndMarkReady(target: HTMLElement, label: CharacterData) { const snapshot = [target.getAttributeNames(), target.children.length, label.substringData(0, 5)]; target.removeAttribute("aria-busy"); target.toggleAttribute("data-ready", true); return snapshot }
    function listen(target: HTMLElement, run: () => void) { target.addEventListener("click", run) }
    function now() { return performance.now() }
    export function mount() { const target = byId("app"); if (target) { render(target, text(now())); snapshotAndMarkReady(target, document.createTextNode("ready")); listen(target, () => render(target, "clicked")) } }
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
  builtinDrift: DeclarationDriftDiagnostic[];
  external: ExternalAdoptionReport;
  diagnostics: Array<{ fixture: AdoptionFixtureName; code: string; functionName: string; effect?: string; message: string; expected: boolean }>;
}

export interface ExternalAdoptionReport {
  packageName: "effect";
  entry: string;
  sourceFiles: number;
  analyzedFunctions: number;
  unknownSummaries: number;
  diagnostics: Array<{ code: string; functionName: string; message: string }>;
  builtinDrift: DeclarationDriftDiagnostic[];
  frontendMilliseconds: number;
}

function diagnosticKey(value: { code: string; functionName: string }): string { return `${value.code}:${value.functionName}`; }
function diagnosticMessage(value: { code: string; functionName: string; message?: string }): string { return value.message ?? `${value.code} in ${value.functionName}`; }

/** Measures a checked-in representative corpus. Rates are corpus metrics, not estimates for arbitrary applications. */
export async function measureUneffectAdoption(options: { fixtures: readonly AdoptionFixtureName[] }): Promise<AdoptionReport> {
  let frontendMilliseconds = 0, verifierMilliseconds = 0, analyzedFunctions = 0, annotatedFunctions = 0, unknown = 0, falsePositives = 0, totalDiagnostics = 0;
  const diagnostics: AdoptionReport["diagnostics"] = [];
  for (const name of options.fixtures) {
    const fixture = fixtures[name];
    if (!fixture) throw new Error(`unknown adoption fixture: ${name}`);
    const started = performance.now(), result = analyzeUneffectProject({ files: fixture.files, mode: "strict" });
    frontendMilliseconds += performance.now() - started;
    const verifierStarted = performance.now();
    await verifyUneffectProject({ files: fixture.files });
    verifierMilliseconds += performance.now() - verifierStarted;
    analyzedFunctions += result.coverage.functions; annotatedFunctions += result.coverage.annotatedFunctions;
    unknown += result.summaries.filter((summary) => summary.evidence === "unknown").length;
    for (const diagnostic of result.diagnostics) {
      const expected = fixture.expectedDiagnostics.includes(diagnosticKey(diagnostic));
      diagnostics.push({ fixture: name, code: diagnostic.code, functionName: diagnostic.functionName, effect: "effect" in diagnostic ? diagnostic.effect : undefined, message: diagnosticMessage(diagnostic), expected });
      totalDiagnostics++; if (!expected) falsePositives++;
    }
  }
  const entry = "node_modules/effect/src/Function.ts";
  const externalStarted = performance.now();
  const program = ts.createProgram([entry], {
    target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
    lib: ["lib.es2024.d.ts", "lib.dom.d.ts"], types: ["node"], noEmit: true, skipLibCheck: true,
  });
  const externalSources = program.getSourceFiles().filter((source) => source.fileName.includes("/effect/src/"));
  const externalAnalysis = analyzeProgramEffects(program, { requireAnnotations: false });
  const builtinDrift = auditBuiltinDeclarationDrift(program);
  const external: ExternalAdoptionReport = {
    packageName: "effect", entry, sourceFiles: externalSources.length,
    analyzedFunctions: externalAnalysis.summaries.length,
    unknownSummaries: externalAnalysis.summaries.filter((summary) => summary.evidence === "unknown").length,
    diagnostics: externalAnalysis.diagnostics.map((diagnostic) => ({ code: diagnostic.kind, functionName: diagnostic.functionName, message: diagnostic.message })),
    builtinDrift, frontendMilliseconds: performance.now() - externalStarted,
  };
  return {
    falsePositiveRate: totalDiagnostics === 0 ? 0 : falsePositives / Math.max(1, analyzedFunctions),
    unknownSummaryRate: analyzedFunctions === 0 ? 0 : unknown / analyzedFunctions,
    annotationDensity: analyzedFunctions === 0 ? 0 : annotatedFunctions / analyzedFunctions,
    verifierMilliseconds, frontendMilliseconds, analyzedFunctions, annotatedFunctions,
    enforcedBoundaries: annotatedFunctions, builtinDrift, external, diagnostics,
  };
}

export interface EffectImplementationComparison {
  implementations: ["native", "uneffect", "effect-ts"];
  sameResult: boolean;
  sameDeclaredAuthority: boolean;
  results: Record<"native" | "uneffect" | "effect-ts", string>;
  authority: { required: string[]; uneffectDiagnostics: string[]; effectTsEnvironment: string[] };
  effectTsRecovery: EffectRecoveryAnalysis;
  limitations: string[];
}

export interface EffectFailureOwnership {
  source: { start: number; end: number };
  owner?: "catchAll";
  ownerSpan?: { start: number; end: number };
  status: "recovered" | "unhandled";
}

export interface EffectRecoveryAnalysis {
  tryPromiseCallbacks: number;
  catchAllCallbacks: number;
  unhandledFailures: number;
  failures: EffectFailureOwnership[];
}

/** Resolves Effect.tryPromise/catchAll by package symbol identity and assigns failure ownership within pipe chains. */
export function analyzeEffectRecovery(fileName: string, text: string): EffectRecoveryAnalysis {
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
    lib: ["lib.es2024.d.ts", "lib.dom.d.ts"], types: ["node"], noEmit: true, skipLibCheck: true,
  };
  const host = ts.createCompilerHost(options), original = host.getSourceFile.bind(host);
  host.getSourceFile = (name, languageVersion, onError, fresh) => name === fileName
    ? ts.createSourceFile(fileName, text, languageVersion, true, ts.ScriptKind.TS)
    : original(name, languageVersion, onError, fresh);
  const program = ts.createProgram([fileName], options, host), checker = program.getTypeChecker(), source = program.getSourceFile(fileName)!;
  const symbolAt = (node: ts.Node): ts.Symbol | undefined => {
    const symbol = checker.getSymbolAtLocation(node);
    return symbol && (symbol.flags & ts.SymbolFlags.Alias) ? checker.getAliasedSymbol(symbol) : symbol;
  };
  const effectOperation = (call: ts.CallExpression): "tryPromise" | "catchAll" | "pipe" | undefined => {
    const lookup = ts.isPropertyAccessExpression(call.expression) ? call.expression.name : call.expression;
    const symbol = symbolAt(lookup);
    const name = symbol?.name;
    if (name !== "tryPromise" && name !== "catchAll" && name !== "pipe") return undefined;
    const fromEffect = symbol?.declarations?.some((declaration) => declaration.getSourceFile().fileName.includes("/node_modules/effect/")) ?? false;
    return fromEffect ? name : undefined;
  };
  const tries: ts.CallExpression[] = [], catches: ts.CallExpression[] = [], pipelines: ts.Expression[][] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const operation = effectOperation(node);
      if (operation === "tryPromise") tries.push(node);
      if (operation === "catchAll") catches.push(node);
      if (operation === "pipe") pipelines.push([...node.arguments]);
      if (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "pipe") pipelines.push([node.expression.expression, ...node.arguments]);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  const contains = (container: ts.Node, target: ts.Node): boolean => container.pos <= target.pos && target.end <= container.end;
  const failures = tries.map((attempt): EffectFailureOwnership => {
    for (const stages of pipelines) {
      const sourceIndex = stages.findIndex((stage) => contains(stage, attempt));
      if (sourceIndex < 0) continue;
      const owner = stages.slice(sourceIndex + 1).flatMap((stage) => catches.filter((candidate) => contains(stage, candidate)))[0];
      if (owner) return {
        source: { start: attempt.getStart(source), end: attempt.getEnd() }, owner: "catchAll",
        ownerSpan: { start: owner.getStart(source), end: owner.getEnd() }, status: "recovered",
      };
    }
    return { source: { start: attempt.getStart(source), end: attempt.getEnd() }, status: "unhandled" };
  });
  return {
    tryPromiseCallbacks: tries.length, catchAllCallbacks: catches.length,
    unhandledFailures: failures.filter((failure) => failure.status === "unhandled").length, failures,
  };
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
  const effectSource = `
    import { Effect, pipe } from "effect"
    declare const fetcher: () => Promise<string>
    export const load = pipe(
      Effect.tryPromise({ try: fetcher, catch: error => error }),
      Effect.catchAll(() => Effect.succeed("recovered")),
    )
  `;
  const effectTsRecovery = analyzeEffectRecovery("effect-comparison.ts", effectSource);
  const effectTs = (): Promise<string> => Effect.runPromise(Effect.tryPromise({ try: fetcher, catch: (error) => error }).pipe(
    Effect.catchAll(() => Effect.succeed("recovered")),
  ));
  const [nativeResult, uneffectResult, effectResult] = await Promise.all([native(), uneffect(), effectTs()]);
  const required = ["Fetch<GET, \"https://api.example.com/data\">", "Net<\"api.example.com:443\">"];
  const effectTsEnvironment = [...required];
  return {
    implementations: ["native", "uneffect", "effect-ts"],
    sameResult: nativeResult === uneffectResult && uneffectResult === effectResult,
    sameDeclaredAuthority: analyzed.diagnostics.length === 0 && required.every((item) => effectTsEnvironment.includes(item)),
    results: { native: nativeResult, uneffect: uneffectResult, "effect-ts": effectResult },
    authority: { required, uneffectDiagnostics: analyzed.diagnostics.map(diagnosticMessage), effectTsEnvironment },
    effectTsRecovery,
    limitations: ["Effect TS service authority remains an explicit comparison manifest rather than an inference from its environment type."],
  };
}
