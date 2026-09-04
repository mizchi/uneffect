import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { builtinContractRegistry, type BuiltinContract, type BuiltinContractRegistry } from "./builtin-contracts.js";
import { effectSchema, type Effect } from "./capabilities.js";
import { openCorsaApiFrontend, type CorsaApiFrontend, type CorsaApiSymbolFact } from "./corsa-api-frontend.js";
import type { EffectSummary, EvidenceStatus } from "./effects.js";
import type { BuiltinSemantics, SemanticPrimitive } from "./builtin-semantic-schema.js";
import { collectSyntaxFacts, enclosingFunction, type SyntaxSite } from "./oxc-syntax.js";

export interface CorsaCheckOptions {
  configFile: string;
  corsaExecutable?: string;
  cwd?: string;
  requireAnnotations?: boolean;
  builtinRegistry?: BuiltinContractRegistry;
  fileNames?: readonly string[];
}

export interface CorsaCheckDiagnostic {
  domain: "syntax";
  kind: "syntax";
  severity: "error" | "warning";
  fileName: string;
  line: number;
  functionName: string;
  message: string;
}

export interface CorsaProjectProvenance {
  projectFile: string;
  compiler: {
    analyzerVersion: string;
    analyzerPackageFile: string;
    consumerVersion: string | null;
    consumerPackageFile: string | null;
    consumerModuleFile: string | null;
    parity: "exact" | "mismatch" | "unknown";
    reason?: string;
  };
}

export interface CorsaCheckResult {
  diagnostics: CorsaCheckDiagnostic[];
  sources: Map<string, string>;
  artifacts: [];
  summaries: EffectSummary[];
  assumptions: { schema: "uneffect-assumptions/v1"; entries: []; violations: [] };
  typedArrays: { obligations: []; diagnostics: []; windows: []; statistics: { solverQueries: 0 }; files: Record<string, never> };
  ownership: [];
  asyncIterators: [];
  resourceProtocols: [];
  errors: number;
  warnings: number;
  project: CorsaProjectProvenance;
}

function declaredByDomLibrary(symbol: CorsaApiSymbolFact | null | undefined): symbol is CorsaApiSymbolFact {
  return symbol !== null && symbol !== undefined
    && (symbol.declarations ?? []).some((item) => /(?:^|[/\\])lib\.dom\.d\.ts$/.test(item));
}

function declaredByEcmaScriptLibrary(symbol: CorsaApiSymbolFact | null | undefined): boolean {
  return (symbol?.declarations ?? []).some((item) => /(?:^|[/\\])lib\.es[\w.]*\.d\.ts$/i.test(item));
}

function capabilityEffect(name: string): Effect {
  const schema = effectSchema(name);
  return {
    kind: "capability",
    name,
    arguments: (schema?.arguments ?? []).map(() => ({ kind: "all" })),
  };
}

function effectNamesFromSemantics(semantics: BuiltinSemantics | undefined, siteKind: SyntaxSite["kind"]): string[] {
  if (!semantics) return [];
  const names: string[] = [];
  const visit = (primitive: SemanticPrimitive): void => {
    if (primitive.kind === "effect") names.push(primitive.capability);
    if (primitive.kind === "property" && siteKind === "property") {
      for (const item of primitive.read) visit(item);
    }
  };
  for (const primitive of semantics.primitives) visit(primitive);
  return names;
}

function uniqueEffects(names: readonly string[]): Effect[] {
  const seen = new Set<string>();
  const effects: Effect[] = [];
  for (const name of names) {
    if (seen.has(name)) continue;
    seen.add(name);
    effects.push(capabilityEffect(name));
  }
  return effects;
}

function resolveDomContract(
  corsa: CorsaApiFrontend,
  file: string,
  site: SyntaxSite,
  domMethods: Map<string, BuiltinContract>,
): BuiltinContract | undefined {
  if (site.receiverPosition === undefined || !corsa.getTypeAtPosition || !corsa.getSymbolOfType || !corsa.getPropertyOfType) {
    return undefined;
  }
  const receiverType = corsa.getTypeAtPosition(file, site.receiverPosition);
  if (!receiverType) return undefined;
  const owner = corsa.getSymbolOfType(receiverType);
  const member = corsa.getPropertyOfType(receiverType, site.name);
  if (!declaredByDomLibrary(owner) || !declaredByDomLibrary(member)) return undefined;
  return domMethods.get(`${owner.name}#${member.name}`);
}

function resolveConstructContract(
  corsa: CorsaApiFrontend,
  file: string,
  site: SyntaxSite,
  globals: Map<string, BuiltinContract>,
): BuiltinContract | undefined {
  const symbol = corsa.getSymbolAtPosition(file, site.calleePosition);
  if (!declaredByDomLibrary(symbol)) return undefined;
  return globals.get(symbol.name);
}

/**
 * Admitted-catalog check: Oxc syntax plus Corsa checker identity. Does not
 * construct a JavaScript TypeScript 6 Program or load `typescript` for facts.
 */
export async function checkCorsaProject(options: CorsaCheckOptions): Promise<CorsaCheckResult> {
  const configFile = resolve(options.configFile);
  const registry = options.builtinRegistry ?? builtinContractRegistry;
  const globals = new Map(
    registry.contracts.filter((contract) => contract.symbol.module === "global")
      .map((contract) => [contract.symbol.export, contract]),
  );
  const domMethods = new Map(
    registry.contracts.filter((contract) => contract.symbol.module === "lib.dom" && contract.symbol.export.includes("#"))
      .map((contract) => [contract.symbol.export, contract]),
  );
  const frontend = await openCorsaApiFrontend({
    configFile,
    ...(options.corsaExecutable === undefined ? {} : { corsaExecutable: options.corsaExecutable }),
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
  });
  try {
    const requested = options.fileNames === undefined ? undefined : new Set(options.fileNames.map((file) => resolve(file)));
    const rootFiles = frontend.rootFiles.map((file) => resolve(file))
      .filter((file) => requested === undefined || requested.has(file))
      .filter((file) => /\.[cm]?tsx?$/u.test(file));
    if (rootFiles.length === 0) {
      throw new Error(`TypeScript project ${configFile} does not select any source files`);
    }
    const sources = new Map<string, string>();
    const diagnostics: CorsaCheckDiagnostic[] = [];
    const byFunction = new Map<string, {
      functionName: string;
      fileName: string;
      span: { start: number; end: number };
      parameters: string[];
      names: string[];
      unclassified: boolean;
    }>();
    for (const fileName of rootFiles) {
      const sourceText = readFileSync(fileName, "utf8");
      sources.set(fileName, sourceText);
      const syntax = collectSyntaxFacts(fileName, sourceText);
      for (const message of syntax.errors) {
        diagnostics.push({
          domain: "syntax", kind: "syntax", severity: "error", fileName, line: 1,
          functionName: "<syntax>", message,
        });
      }
      const callSites = syntax.sites.filter((site) => site.kind === "call");
      const classified = frontend.classifyBuiltinCalls(fileName, callSites.map((site) => ({
        calleePosition: site.calleePosition,
        ...(site.receiverPosition === undefined ? {} : { receiverPosition: site.receiverPosition }),
      })));
      const ensure = (owner: { name: string; start: number; end: number; parameters: readonly string[] }) => {
        const key = `${fileName}:${owner.start}:${owner.name}`;
        const current = byFunction.get(key) ?? {
          functionName: owner.name, fileName, span: { start: owner.start, end: owner.end },
          parameters: [...owner.parameters], names: [], unclassified: false,
        };
        byFunction.set(key, current);
        return current;
      };
      const record = (site: SyntaxSite, contract: BuiltinContract | undefined): void => {
        if (!contract) return;
        const owner = enclosingFunction(syntax.functions, site.start);
        if (!owner) return;
        ensure(owner).names.push(...effectNamesFromSemantics(contract.semantics, site.kind));
      };
      const recordUnclassified = (site: SyntaxSite): void => {
        const owner = enclosingFunction(syntax.functions, site.start);
        if (!owner) return;
        const symbol = frontend.getSymbolAtPosition(fileName, site.calleePosition);
        if (declaredByEcmaScriptLibrary(symbol)) return;
        ensure(owner).unclassified = true;
      };
      for (const [index, site] of callSites.entries()) {
        const resolution = classified[index];
        const exportName = resolution?.operation === "Fetch" ? "fetch"
          : resolution?.operation === "Console"
            ? `${resolution.receiver?.name ?? "console"}.${resolution.symbol.name}`
            : undefined;
        const classifiedContract = exportName === undefined ? undefined : globals.get(exportName);
        const contract = classifiedContract
          ?? (site.receiverPosition === undefined ? undefined : resolveDomContract(frontend, fileName, site, domMethods));
        if (contract) record(site, contract);
        else recordUnclassified(site);
      }
      for (const site of syntax.sites) {
        if (site.kind === "construct") {
          const contract = resolveConstructContract(frontend, fileName, site, globals);
          if (contract) record(site, contract);
          else recordUnclassified(site);
        } else if (site.kind === "property") record(site, resolveDomContract(frontend, fileName, site, domMethods));
      }
      for (const fn of syntax.functions) {
        const key = `${fileName}:${fn.start}:${fn.name}`;
        if (byFunction.has(key)) continue;
        byFunction.set(key, {
          functionName: fn.name, fileName, span: { start: fn.start, end: fn.end },
          parameters: [...fn.parameters], names: [], unclassified: false,
        });
      }
    }
    const summaries: EffectSummary[] = [...byFunction.values()]
      .map((item) => {
        const effects = uniqueEffects(item.names);
        const evidence: EvidenceStatus = item.unclassified ? "unknown" : effects.length > 0 ? "trusted" : "inferred";
        return {
          functionName: item.functionName,
          effects,
          evidence,
          fileName: item.fileName,
          span: item.span,
          parameters: item.parameters,
          ...(item.unclassified ? {
            unknownReasons: [{
              code: "unresolved-call" as const,
              message: "a call is outside the admitted Corsa builtin catalog",
            }],
          } : {}),
        };
      })
      .sort((left, right) => (left.fileName ?? "").localeCompare(right.fileName ?? "")
        || (left.span?.start ?? 0) - (right.span?.start ?? 0));
    const errors = diagnostics.filter((item) => item.severity === "error").length;
    return {
      diagnostics,
      sources,
      artifacts: [],
      summaries,
      assumptions: { schema: "uneffect-assumptions/v1", entries: [], violations: [] },
      typedArrays: { obligations: [], diagnostics: [], windows: [], statistics: { solverQueries: 0 }, files: {} },
      ownership: [],
      asyncIterators: [],
      resourceProtocols: [],
      errors,
      warnings: diagnostics.length - errors,
      project: {
        projectFile: configFile,
        compiler: {
          analyzerVersion: frontend.compilerRevision,
          analyzerPackageFile: frontend.compilerExecutable,
          consumerVersion: frontend.compilerRevision,
          consumerPackageFile: frontend.compilerExecutable,
          consumerModuleFile: frontend.compilerExecutable,
          parity: "exact",
        },
      },
    };
  } finally {
    frontend.close();
  }
}
