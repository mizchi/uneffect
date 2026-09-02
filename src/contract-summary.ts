import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import ts from "typescript";
import { extractAnnotations } from "./annotations.js";
import type { VerificationArtifact } from "./contracts.js";
import { formatEffect, parseEffectSet } from "./capabilities.js";
import { analyzeProgramEffects, type EffectSummary, type ExternalFunctionEffectContract } from "./effects.js";
import { analyzeCallableSummaries, type CallableSummary } from "./callable-summary.js";

export interface ContractCallbackSummaryV1 {
  index: number;
  name: string;
  path?: readonly (string | number)[];
  containerAccess?: "borrow-readonly";
  cardinality: "0" | "0..1" | "exactly-1" | "0..n" | "unknown";
  timing: "inline" | "deferred" | "promise-reaction" | "unknown";
  completion: "propagate-throw" | "convert-throw-to-rejection" | "host-report-throw" | "unknown";
  effectBound?: readonly string[];
}

export interface ContractSummaryExportV1 {
  symbol: { module: string; export: string };
  functionName: string;
  evidence: "verified";
  declarationSpan: { start: number; end: number };
  declarationDigest: string;
  signature: string;
  signatureDigest: string;
  parameters: string[];
  requires: string[];
  ensures: string[];
  artifactIds: string[];
  effect?: {
    effects: string[];
    parameters: string[];
    callbacks?: ContractCallbackSummaryV1[];
  };
}

export interface ContractSummaryBundleV1 {
  schema: "uneffect-contract-summary/v1";
  package: { name: string; version: string };
  compiler: { typescriptVersion: string; compilerOptionsDigest: string };
  producer: { fileName: string; sourceDigest: string };
  exports: ContractSummaryExportV1[];
  contentDigest: string;
}

export interface CreateContractSummaryBundleOptions {
  packageName: string;
  packageVersion: string;
  fileName: string;
  source: string;
  program: ts.Program;
  artifacts: readonly VerificationArtifact[];
}

export interface ValidateContractSummaryBundleOptions {
  packageName: string;
  packageVersion: string;
  fileName: string;
  source: string;
  program: ts.Program;
}

export interface BoundContractSummaryExportV1 {
  exportName: string;
  /** Declaration binding is verified; persisted producer authority is trusted. */
  evidence: "trusted";
  declarationFileName: string;
  declarationSpan: { start: number; end: number };
  declarationDigest: string;
  signature: string;
  callSites: Array<{ fileName: string; span: { start: number; end: number } }>;
  summary: ContractSummaryExportV1;
}

export interface BoundContractSummaryBundleV1 {
  schema: "uneffect-bound-contract-summary/v1";
  status: "not-applicable" | "verified" | "unknown";
  package: { name: string; version: string };
  compiler: { producerTypeScriptVersion: string; consumerTypeScriptVersion: string; consumerCompilerOptionsDigest: string };
  exports: BoundContractSummaryExportV1[];
  blockers: string[];
}

/** Project verified declaration bindings into the existing Effect analyzer IR. */
export function boundContractSummaryEffectContracts(
  bindings: readonly BoundContractSummaryBundleV1[],
): Map<string, ExternalFunctionEffectContract> {
  const contracts = new Map<string, ExternalFunctionEffectContract>();
  for (const binding of bindings) for (const item of binding.exports) if (item.summary.effect) {
    contracts.set(`${item.declarationFileName}:${item.declarationSpan.start}`, {
      effects: item.summary.effect.effects.flatMap((effect) => parseEffectSet(effect)),
      parameters: item.summary.effect.parameters,
      ...(item.summary.effect.callbacks ? { callbackParameters: item.summary.effect.callbacks.map((callback) => {
        const { effectBound, ...rest } = callback;
        return {
          ...rest,
          ...(effectBound ? { effectBound: effectBound.flatMap((effect) => parseEffectSet(effect)) } : {}),
        };
      }) } : {}),
      functionName: item.exportName,
      // Linkage is verified structurally. The persisted producer authority is
      // retained separately in the package-contract assumption ledger.
      evidence: "verified",
      reason: `persisted package contract ${binding.package.name}@${binding.package.version}`,
    });
  }
  return contracts;
}

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");
function ordered(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(ordered);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, ordered(item)]));
  return value;
}
const canonical = (value: unknown): string => JSON.stringify(ordered(value));
const compilerOptionsDigest = (program: ts.Program): string => sha256(canonical(program.getCompilerOptions()));
const bundleDigest = (bundle: Omit<ContractSummaryBundleV1, "contentDigest">): string => sha256(canonical(bundle));

/** Load a versioned summary. Full provenance validation happens when it is bound to a Program. */
export async function loadContractSummaryBundle(fileName: string): Promise<ContractSummaryBundleV1> {
  let value: unknown;
  try { value = JSON.parse(await readFile(fileName, "utf8")); }
  catch (cause) { throw new Error(`cannot load contract summary ${fileName}: ${cause instanceof Error ? cause.message : String(cause)}`); }
  if (!value || typeof value !== "object" || (value as { schema?: unknown }).schema !== "uneffect-contract-summary/v1") {
    throw new Error(`unsupported contract summary schema in ${fileName}`);
  }
  const bundle = value as ContractSummaryBundleV1;
  if (!bundle.package || typeof bundle.package.name !== "string" || typeof bundle.package.version !== "string"
    || !bundle.compiler || typeof bundle.compiler.typescriptVersion !== "string"
    || typeof bundle.compiler.compilerOptionsDigest !== "string" || !bundle.producer
    || typeof bundle.producer.fileName !== "string" || typeof bundle.producer.sourceDigest !== "string"
    || !Array.isArray(bundle.exports) || typeof bundle.contentDigest !== "string") {
    throw new Error(`malformed contract summary ${fileName}`);
  }
  for (const [index, item] of bundle.exports.entries()) {
    const validCallback = (callback: ContractCallbackSummaryV1): boolean =>
      Boolean(callback && typeof callback === "object"
        && Number.isInteger(callback.index) && callback.index >= 0
        && typeof callback.name === "string"
        && (callback.path === undefined || (Array.isArray(callback.path)
          && callback.path.every((part) => typeof part === "string" || Number.isInteger(part))))
        && (callback.containerAccess === undefined || callback.containerAccess === "borrow-readonly")
        && ["0", "0..1", "exactly-1", "0..n", "unknown"].includes(callback.cardinality)
        && ["inline", "deferred", "promise-reaction", "unknown"].includes(callback.timing)
        && ["propagate-throw", "convert-throw-to-rejection", "host-report-throw", "unknown"].includes(callback.completion)
        && (callback.effectBound === undefined || (Array.isArray(callback.effectBound)
          && callback.effectBound.every((entry) => typeof entry === "string"))));
    if (!item || typeof item !== "object" || !item.symbol
      || typeof item.symbol.module !== "string" || typeof item.symbol.export !== "string"
      || typeof item.functionName !== "string" || item.evidence !== "verified"
      || !item.declarationSpan || !Number.isInteger(item.declarationSpan.start) || !Number.isInteger(item.declarationSpan.end)
      || typeof item.declarationDigest !== "string" || typeof item.signature !== "string"
      || typeof item.signatureDigest !== "string" || !Array.isArray(item.parameters)
      || !item.parameters.every((entry) => typeof entry === "string")
      || !Array.isArray(item.requires) || !item.requires.every((entry) => typeof entry === "string")
      || !Array.isArray(item.ensures) || !item.ensures.every((entry) => typeof entry === "string")
      || !Array.isArray(item.artifactIds) || !item.artifactIds.every((entry) => typeof entry === "string")
      || (item.effect !== undefined && (!item.effect || typeof item.effect !== "object"
        || !Array.isArray(item.effect.effects) || !item.effect.effects.every((entry) => typeof entry === "string")
        || !Array.isArray(item.effect.parameters) || !item.effect.parameters.every((entry) => typeof entry === "string")
        || (item.effect.callbacks !== undefined && (!Array.isArray(item.effect.callbacks)
          || !item.effect.callbacks.every(validCallback)))))) {
      throw new Error(`malformed contract summary export ${index} in ${fileName}`);
    }
  }
  return bundle;
}

function installedPackageAt(declarationFileName: string, packageName: string): { name: string; version: string } | undefined {
  let directory = dirname(declarationFileName);
  for (;;) {
    const manifestFile = join(directory, "package.json");
    if (existsSync(manifestFile)) {
      try {
        const manifest = JSON.parse(readFileSync(manifestFile, "utf8")) as { name?: unknown; version?: unknown };
        if (manifest.name === packageName && typeof manifest.version === "string") {
          return { name: packageName, version: manifest.version };
        }
      } catch {
        return undefined;
      }
    }
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

/**
 * Bind a producer contract bundle to declarations actually resolved by a
 * consumer Program. This authenticates identity and installed bytes; it does
 * not authenticate the publisher or prove that runtime JavaScript matches the
 * declaration package.
 */
export function bindContractSummaryBundleToProgram(
  bundle: ContractSummaryBundleV1,
  program: ts.Program,
): BoundContractSummaryBundleV1 {
  const blockers: string[] = [];
  const { contentDigest, ...unsigned } = bundle;
  if (bundle.schema !== "uneffect-contract-summary/v1") blockers.push(`unsupported contract summary schema ${bundle.schema}`);
  if (bundleDigest(unsigned) !== contentDigest) blockers.push("contract summary content digest does not match its payload");
  if (bundle.compiler.typescriptVersion !== ts.version) {
    blockers.push(`contract summary TypeScript ${bundle.compiler.typescriptVersion} does not match consumer ${ts.version}`);
  }
  if (blockers.length > 0) return {
    schema: "uneffect-bound-contract-summary/v1",
    status: "unknown",
    package: bundle.package,
    compiler: {
      producerTypeScriptVersion: bundle.compiler.typescriptVersion,
      consumerTypeScriptVersion: ts.version,
      consumerCompilerOptionsDigest: compilerOptionsDigest(program),
    },
    exports: [],
    blockers,
  };
  const checker = program.getTypeChecker();
  const allowedSymbols = new Map<string, Set<ts.Symbol>>();
  const rememberModuleExports = (moduleSpecifier: ts.StringLiteralLike): void => {
    if (moduleSpecifier.text !== bundle.package.name) return;
    const moduleSymbol = checker.getSymbolAtLocation(moduleSpecifier);
    if (!moduleSymbol) return;
    for (const exported of checker.getExportsOfModule(moduleSymbol)) {
      const target = (exported.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(exported) : exported;
      if (!target.declarations?.length) continue;
      const selected = allowedSymbols.get(exported.getName()) ?? new Set<ts.Symbol>();
      selected.add(target);
      allowedSymbols.set(exported.getName(), selected);
    }
  };
  for (const source of program.getSourceFiles()) {
    if (source.isDeclarationFile) continue;
    const visit = (node: ts.Node): void => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
        && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
        rememberModuleExports(node.moduleSpecifier);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  const candidates = new Map<string, Array<{ declaration: ts.Declaration; signature: string; call: ts.CallExpression }>>();
  for (const source of program.getSourceFiles()) {
    if (source.isDeclarationFile) continue;
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const signature = checker.getResolvedSignature(node);
        const lookup = ts.isPropertyAccessExpression(node.expression) ? node.expression.name : node.expression;
        let symbol = checker.getSymbolAtLocation(lookup);
        if (symbol && (symbol.flags & ts.SymbolFlags.Alias) !== 0) symbol = checker.getAliasedSymbol(symbol);
        const declaration = symbol?.declarations?.[0];
        if (declaration && signature && symbol) for (const [exportName, symbols] of allowedSymbols) if (symbols.has(symbol)) {
          candidates.set(exportName, [...(candidates.get(exportName) ?? []), {
            declaration, signature: checker.signatureToString(signature, declaration, ts.TypeFormatFlags.NoTruncation), call: node,
          }]);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  const exports: BoundContractSummaryExportV1[] = [];
  for (const summary of bundle.exports) {
    const uses = candidates.get(summary.symbol.export) ?? [];
    const declarations = [...new Set(uses.map(({ declaration }) => declaration))];
    if (declarations.length === 0) continue;
    if (declarations.length !== 1) {
      blockers.push(`contract summary export ${summary.symbol.export} resolves ambiguously in the consumer Program`);
      continue;
    }
    const declaration = declarations[0]!;
    const declarationSource = declaration.getSourceFile();
    const installed = installedPackageAt(declarationSource.fileName, bundle.package.name);
    if (!installed) {
      blockers.push(`contract summary export ${summary.symbol.export} is not backed by an installed ${bundle.package.name} package manifest`);
      continue;
    }
    if (installed.version !== bundle.package.version) {
      blockers.push(`installed ${bundle.package.name} version ${installed.version} does not match summary ${bundle.package.version}`);
      continue;
    }
    const signatures = [...new Set(uses.map((use) => use.signature))];
    const signatureText = signatures.length === 1 ? signatures[0] : undefined;
    if (!signatureText || signatureText !== summary.signature || sha256(signatureText) !== summary.signatureDigest) {
      blockers.push(`contract summary signature for ${summary.symbol.export} does not match the installed declaration`);
      continue;
    }
    const declarationText = declarationSource.text.slice(declaration.getStart(declarationSource), declaration.getEnd());
    exports.push({
      exportName: summary.symbol.export,
      evidence: "trusted",
      declarationFileName: declarationSource.fileName,
      declarationSpan: { start: declaration.getStart(declarationSource), end: declaration.getEnd() },
      declarationDigest: sha256(declarationText),
      signature: signatureText,
      callSites: uses.map(({ call }) => ({
        fileName: call.getSourceFile().fileName,
        span: { start: call.getStart(call.getSourceFile()), end: call.getEnd() },
      })),
      summary,
    });
  }
  return {
    schema: "uneffect-bound-contract-summary/v1",
    status: blockers.length > 0 ? "unknown" : exports.length > 0 ? "verified" : "not-applicable",
    package: bundle.package,
    compiler: {
      producerTypeScriptVersion: bundle.compiler.typescriptVersion,
      consumerTypeScriptVersion: ts.version,
      consumerCompilerOptionsDigest: compilerOptionsDigest(program),
    },
    exports,
    blockers,
  };
}

function checkedSource(options: Pick<CreateContractSummaryBundleOptions, "fileName" | "source" | "program">): ts.SourceFile {
  const source = options.program.getSourceFile(options.fileName);
  if (!source || source.text !== options.source) throw new Error(`contract summary source does not match Program source ${options.fileName}`);
  const errors = [...options.program.getSyntacticDiagnostics(source), ...options.program.getSemanticDiagnostics(source)]
    .filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
  if (errors.length > 0) throw new Error(`contract summary cannot use a Program with TypeScript errors in ${options.fileName}`);
  return source;
}

type DirectExportCallable = {
  node: ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression;
  owner: ts.FunctionDeclaration | ts.VariableStatement;
  exportName: string;
};

function directExportCallables(statement: ts.Statement): DirectExportCallable[] {
  if (ts.isFunctionDeclaration(statement)) {
    if (!statement.name || !statement.body
      || !statement.modifiers?.some(({ kind }) => kind === ts.SyntaxKind.ExportKeyword)
      || statement.modifiers.some(({ kind }) => kind === ts.SyntaxKind.DefaultKeyword)) return [];
    return [{ node: statement, owner: statement, exportName: statement.name.text }];
  }
  if (!ts.isVariableStatement(statement)
    || !statement.modifiers?.some(({ kind }) => kind === ts.SyntaxKind.ExportKeyword)
    || statement.declarationList.declarations.length !== 1
    || (statement.declarationList.flags & ts.NodeFlags.Const) === 0) return [];
  const declaration = statement.declarationList.declarations[0]!;
  if (!ts.isIdentifier(declaration.name) || !declaration.initializer) return [];
  let initializer = declaration.initializer;
  while (ts.isParenthesizedExpression(initializer) || ts.isAsExpression(initializer)
    || ts.isTypeAssertionExpression(initializer) || ts.isSatisfiesExpression(initializer)) initializer = initializer.expression;
  return ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)
    ? [{ node: initializer, owner: statement, exportName: declaration.name.text }] : [];
}

function summaryParameterNames(node: DirectExportCallable["node"]): string[] {
  return node.parameters.map((parameter, index) => ts.isIdentifier(parameter.name) ? parameter.name.text : `$arg${index}`);
}

function describeExport(
  program: ts.Program,
  source: ts.SourceFile,
  exported: DirectExportCallable,
  packageName: string,
  artifacts: readonly VerificationArtifact[],
  effectSummary?: EffectSummary,
  callableSummary?: CallableSummary,
): ContractSummaryExportV1 | undefined {
  const { node, owner, exportName } = exported;
  if (!node.body) return undefined;
  const comments = source.text.slice(owner.getFullStart(), owner.getStart(source));
  const ensures = extractAnnotations(comments, "ensures");
  const effectDeclared = extractAnnotations(comments, "effect").length > 0;
  if (ensures.length === 0 && !effectDeclared) return undefined;
  const requires = extractAnnotations(comments, "requires");
  const span = { start: node.getStart(source), end: node.getEnd() };
  const candidates = artifacts.filter((artifact) => artifact.source.fileName === source.fileName
    && artifact.obligation?.functionName === exportName && artifact.source.span.start >= span.start && artifact.source.span.end <= span.end);
  const covered = ensures.every((clause) => candidates.some((artifact) => artifact.obligation?.clause === "ensures" && artifact.obligation.source === clause));
  const verified = candidates.length > 0 && covered && candidates.every((artifact) => artifact.status === "verified"
    && (artifact.controlFlow?.relationalCalls?.every(({ evidence }) => evidence === "verified") ?? true));
  if (ensures.length > 0 && !verified) throw new Error(`${exportName} is not fully verified and cannot be published as a contract summary`);
  const callableEffectFallback = callableSummary && callableSummary.evidence !== "unknown"
    && callableSummary.unknownReasons.length === 0 && callableSummary.callbackParameters.length > 0;
  if (effectDeclared && effectSummary?.evidence !== "verified" && !callableEffectFallback) {
    throw new Error(`${exportName} Effect summary is not verified and cannot be published`);
  }
  const checker = program.getTypeChecker(), signature = checker.getSignatureFromDeclaration(node);
  if (!signature) throw new Error(`${exportName} has no TypeChecker signature`);
  const signatureText = checker.signatureToString(signature, node, ts.TypeFormatFlags.NoTruncation);
  const declarationText = source.text.slice(span.start, span.end);
  return {
    symbol: { module: packageName, export: exportName }, functionName: exportName, evidence: "verified",
    declarationSpan: span, declarationDigest: sha256(declarationText),
    signature: signatureText, signatureDigest: sha256(signatureText),
    parameters: summaryParameterNames(node),
    requires, ensures, artifactIds: candidates.map(({ obligationId }) => obligationId).sort(),
    ...(effectDeclared && (effectSummary || callableSummary) ? { effect: {
      effects: (effectSummary?.evidence === "verified" ? effectSummary.effects : callableSummary!.effects).map(formatEffect).sort(),
      parameters: summaryParameterNames(node),
      ...(callableSummary?.callbackParameters.length ? { callbacks: callableSummary.callbackParameters.map((callback) => ({
        index: callback.index,
        name: callback.name,
        ...(callback.path ? { path: callback.path } : {}),
        ...(callback.containerAccess ? { containerAccess: callback.containerAccess } : {}),
        cardinality: callback.cardinality,
        timing: callback.timing,
        completion: callback.completion,
        ...(callback.effectBound ? { effectBound: callback.effectBound } : {}),
      })) } : {}),
    } } : {}),
  };
}

export function createContractSummaryBundle(options: CreateContractSummaryBundleOptions): ContractSummaryBundleV1 {
  if (!options.packageName || !options.packageVersion) throw new Error("contract summary requires package name and version");
  const source = checkedSource(options);
  const effectSummaries = analyzeProgramEffects(options.program, { requireAnnotations: false }).summaries;
  const callableSummaries = analyzeCallableSummaries(options.program).summaries;
  const exports = source.statements.flatMap((statement) => directExportCallables(statement).flatMap((exported) => {
    const node = exported.node;
    return [describeExport(options.program, source, exported, options.packageName, options.artifacts,
      effectSummaries.find((summary) => summary.fileName === source.fileName && summary.span
        && summary.span.start === node.getStart(source) && summary.span.end === node.getEnd()),
      callableSummaries.find((summary) => summary.fileName === source.fileName
        && summary.span.start === node.getStart(source) && summary.span.end === node.getEnd()))]
      .filter((item): item is ContractSummaryExportV1 => item !== undefined);
  }));
  if (exports.length === 0) throw new Error("contract summary has no fully verified exported function contracts");
  const unsigned: Omit<ContractSummaryBundleV1, "contentDigest"> = {
    schema: "uneffect-contract-summary/v1",
    package: { name: options.packageName, version: options.packageVersion },
    compiler: { typescriptVersion: ts.version, compilerOptionsDigest: compilerOptionsDigest(options.program) },
    producer: { fileName: options.fileName, sourceDigest: sha256(options.source) },
    exports: exports.sort((left, right) => left.symbol.export.localeCompare(right.symbol.export)),
  };
  return { ...unsigned, contentDigest: bundleDigest(unsigned) };
}

export function validateContractSummaryBundle(bundle: ContractSummaryBundleV1, options: ValidateContractSummaryBundleOptions): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const { contentDigest, ...unsigned } = bundle;
  if (bundle.schema !== "uneffect-contract-summary/v1") errors.push(`unsupported contract summary schema ${bundle.schema}`);
  if (bundleDigest(unsigned) !== contentDigest) errors.push("contract summary content digest does not match its payload");
  if (bundle.package.name !== options.packageName) errors.push(`contract summary package name ${bundle.package.name} does not match ${options.packageName}`);
  if (bundle.package.version !== options.packageVersion) errors.push(`contract summary package version ${bundle.package.version} does not match ${options.packageVersion}`);
  if (bundle.compiler.typescriptVersion !== ts.version) errors.push(`contract summary TypeScript ${bundle.compiler.typescriptVersion} does not match ${ts.version}`);
  if (bundle.compiler.compilerOptionsDigest !== compilerOptionsDigest(options.program)) errors.push("contract summary compiler options digest does not match the consumer Program");
  if (bundle.producer.fileName !== options.fileName) errors.push(`contract summary producer ${bundle.producer.fileName} does not match ${options.fileName}`);
  if (bundle.producer.sourceDigest !== sha256(options.source)) errors.push("contract summary source digest does not match producer source");
  let source: ts.SourceFile | undefined;
  try { source = checkedSource(options); } catch (cause) { errors.push(cause instanceof Error ? cause.message : String(cause)); }
  const effectSummaries = source ? analyzeProgramEffects(options.program, { requireAnnotations: false }).summaries : [];
  const callableSummaries = source ? analyzeCallableSummaries(options.program).summaries : [];
  if (source) for (const item of bundle.exports) {
    const exported = source.statements.flatMap(directExportCallables).find(({ node, exportName }) =>
      exportName === item.symbol.export && node.getStart(source) === item.declarationSpan.start && node.getEnd() === item.declarationSpan.end);
    if (!exported) { errors.push(`contract summary export ${item.symbol.export} does not match a direct exported callable declaration`); continue; }
    const declaration = exported.node;
    const declarationText = source.text.slice(item.declarationSpan.start, item.declarationSpan.end);
    if (sha256(declarationText) !== item.declarationDigest) errors.push(`contract summary declaration digest for ${item.symbol.export} does not match source`);
    const signature = options.program.getTypeChecker().getSignatureFromDeclaration(declaration);
    const signatureText = signature ? options.program.getTypeChecker().signatureToString(signature, declaration, ts.TypeFormatFlags.NoTruncation) : undefined;
    if (!signatureText || signatureText !== item.signature || sha256(signatureText) !== item.signatureDigest) errors.push(`contract summary signature for ${item.symbol.export} does not match TypeChecker`);
    const leading = source.text.slice(exported.owner.getFullStart(), exported.owner.getStart(source));
    const declaresEffect = extractAnnotations(leading, "effect").length > 0;
    if (declaresEffect !== Boolean(item.effect)) {
      errors.push(`contract summary Effect payload for ${item.symbol.export} does not match its declaration`);
    } else if (item.effect) {
      const actual = effectSummaries.find((summary) => summary.fileName === source.fileName && summary.span
        && summary.span.start === declaration.getStart(source) && summary.span.end === declaration.getEnd());
      const callable = callableSummaries.find((summary) => summary.fileName === source.fileName
        && summary.span.start === declaration.getStart(source) && summary.span.end === declaration.getEnd());
      const callableFallback = callable && callable.evidence !== "unknown"
        && callable.unknownReasons.length === 0 && callable.callbackParameters.length > 0;
      const effects = (actual?.evidence === "verified" ? actual.effects : callableFallback ? callable.effects : undefined)
        ?.map(formatEffect).sort();
      const parameters = summaryParameterNames(declaration);
      const callbacks = callable?.callbackParameters.length ? callable.callbackParameters.map((callback) => ({
        index: callback.index, name: callback.name,
        ...(callback.path ? { path: callback.path } : {}),
        ...(callback.containerAccess ? { containerAccess: callback.containerAccess } : {}),
        cardinality: callback.cardinality, timing: callback.timing, completion: callback.completion,
        ...(callback.effectBound ? { effectBound: callback.effectBound } : {}),
      })) : undefined;
      if (!effects || canonical(effects) !== canonical(item.effect.effects)
        || canonical(parameters) !== canonical(item.effect.parameters)
        || canonical(callbacks) !== canonical(item.effect.callbacks)) {
        errors.push(`contract summary Effect payload for ${item.symbol.export} does not match verified producer evidence`);
      }
    }
  }
  return { valid: errors.length === 0, errors };
}
