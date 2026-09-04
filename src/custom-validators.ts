import ts from "@typescript/typescript6";
import { posix } from "node:path";
import { createHash } from "node:crypto";
import { extractAnnotations } from "./annotations.js";
import { analyzeAsyncSafetyInProgram } from "./async-safety.js";
import { formatEffect, registerEffectSchema, type AtomDomain } from "./capabilities.js";
import { analyzeEffectSummariesInProgram, type EvidenceStatus } from "./effects.js";
import { collectOwnershipEvents } from "./ownership.js";

export type CallCardinality = "0" | "1" | "many" | "unknown";

export interface UneffectValidatorDefinition {
  name: string;
  version?: string;
  rule: "at-most-once";
  sink: { module: string; export: string };
  specialization: { kind: "call-cardinality"; maximum: 1 };
}

export interface UneffectValidator extends Readonly<Required<UneffectValidatorDefinition>> {
  readonly schema: "uneffect-validator/v1";
}

export interface ProjectValidatorDiagnostic {
  code: "validator-cardinality-exceeded" | "validator-cardinality-unknown";
  fileName: string;
  functionName: string;
  validator: string;
  inferredMaximum: CallCardinality;
}

export interface FunctionSpecialization {
  schema: "uneffect-cardinality/v1";
  validator: string;
  validatorVersion: string;
  validatorDigest: string;
  compilerRevision: string;
  sourceHash: string;
  projectHash: string;
  kind: "call-cardinality";
  maximum: 1;
  inferredMaximum: "0" | "1";
  evidence: "verified";
}

export interface UneffectProjectSummary {
  fileName: string;
  functionName: string;
  effects: string[];
  evidence?: EvidenceStatus;
  specializations: FunctionSpecialization[];
}

export interface ProjectSafetyDiagnostic {
  code: string;
  fileName: string;
  functionName: string;
  message: string;
  effect?: string;
}

export interface UneffectProjectAnalysis {
  diagnostics: Array<ProjectValidatorDiagnostic | ProjectSafetyDiagnostic>;
  summaries: UneffectProjectSummary[];
  entrypoint?: { functionName: string; sinkMaximum: number | "many" | "unknown"; generatorConsumption: "none" | "once" | "many" };
  orderedEvents: ProjectOrderedEvent[];
  emittedFiles: Record<string, string>;
  coverage: { functions: number; annotatedFunctions: number; annotationDensity: number };
}

export interface ProjectOrderedEvent {
  fileName: string;
  owner: string;
  kind: "acquire" | "transfer" | "suspend" | "dispose";
  resource?: string;
  asynchronous?: boolean;
  span: { start: number; end: number };
}

export interface AnalyzeUneffectProjectOptions {
  files: Record<string, string>;
  validators?: readonly UneffectValidator[];
  mode?: "gradual" | "strict";
  entrypoint?: string;
}
export interface ValidateUneffectProjectOptions {
  files: Record<string, string>;
  validator: UneffectValidator;
  entrypoint?: string;
}

export function defineUneffectValidator(definition: UneffectValidatorDefinition): UneffectValidator {
  if (!/^[A-Za-z_$][\w$]*$/.test(definition.name)) throw new Error(`invalid validator name ${JSON.stringify(definition.name)}`);
  if (!definition.sink.module || !/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(definition.sink.export)) throw new Error("validator sink requires a module and dotted export path");
  return Object.freeze({ schema: "uneffect-validator/v1", version: definition.version ?? "1", ...definition });
}

function validatorDigest(validator: UneffectValidator): string {
  return createHash("sha256").update(JSON.stringify({ schema: validator.schema, name: validator.name, version: validator.version, rule: validator.rule, sink: validator.sink, specialization: validator.specialization })).digest("hex");
}

const sourceDigest = (text: string): string => createHash("sha256").update(text).digest("hex");

type InternalCardinality = 0 | 1 | 2 | "unknown";
const add = (left: InternalCardinality, right: InternalCardinality): InternalCardinality => left === "unknown" || right === "unknown" ? "unknown" : Math.min(2, left + right) as 0 | 1 | 2;
const maximum = (left: InternalCardinality, right: InternalCardinality): InternalCardinality => left === "unknown" || right === "unknown" ? "unknown" : Math.max(left, right) as 0 | 1 | 2;

function importIdentity(checker: ts.TypeChecker, expression: ts.Expression): { module: string; export: string } | undefined {
  const members: string[] = [];
  let root: ts.Expression = expression;
  while (ts.isPropertyAccessExpression(root)) { members.unshift(root.name.text); root = root.expression; }
  if (!ts.isIdentifier(root)) return undefined;
  const symbol = checker.getSymbolAtLocation(root);
  const declaration = symbol?.declarations?.find((item) => ts.isImportSpecifier(item) || ts.isNamespaceImport(item) || ts.isImportClause(item));
  if (!declaration) return undefined;
  let importDeclaration: ts.Node | undefined = declaration;
  while (importDeclaration && !ts.isImportDeclaration(importDeclaration)) importDeclaration = importDeclaration.parent;
  if (!importDeclaration || !ts.isStringLiteral(importDeclaration.moduleSpecifier)) return undefined;
  if (ts.isImportSpecifier(declaration)) members.unshift((declaration.propertyName ?? declaration.name).text);
  else if (ts.isImportClause(declaration)) members.unshift("default");
  return { module: importDeclaration.moduleSpecifier.text, export: members.join(".") };
}

function functionName(node: ts.FunctionLikeDeclaration): string {
  if (node.name) return node.name.getText();
  if (ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name)) return node.parent.name.text;
  return "<anonymous>";
}

function canonicalSymbol(checker: ts.TypeChecker, symbol: ts.Symbol | undefined): ts.Symbol | undefined {
  const seen = new Set<ts.Symbol>();
  while (symbol && symbol.flags & ts.SymbolFlags.Alias && !seen.has(symbol)) {
    seen.add(symbol);
    const next = checker.getAliasedSymbol(symbol);
    if (next === symbol) break;
    symbol = next;
  }
  return symbol;
}

function cardinalityOfFunction(
  checker: ts.TypeChecker,
  node: ts.FunctionLikeDeclaration,
  validator: UneffectValidator,
  functions: ReadonlyMap<ts.Symbol, ts.FunctionLikeDeclaration> = new Map(),
  stack: ReadonlySet<ts.FunctionLikeDeclaration> = new Set(),
): InternalCardinality {
  const nextStack = new Set(stack);
  nextStack.add(node);
  const generator = (value: ts.FunctionLikeDeclaration): boolean => "asteriskToken" in value && Boolean(value.asteriskToken);
  const containsSink = (value: ts.Node): boolean => {
    if (ts.isCallExpression(value)) {
      const identity = importIdentity(checker, value.expression);
      if (identity?.module === validator.sink.module && identity.export === validator.sink.export) return true;
    }
    let found = false;
    value.forEachChild((child) => { if (!found && containsSink(child)) found = true; });
    return found;
  };
  const callCardinality = (value: ts.CallExpression, consumeGenerator: boolean): InternalCardinality => {
    const local = resolveLocalFunction(checker, functions, value);
    if (local) {
      if (nextStack.has(local)) return "unknown";
      if (generator(local) && !consumeGenerator) return 0;
      return cardinalityOfFunction(checker, local, validator, functions, nextStack);
    }
    const identity = importIdentity(checker, value.expression);
    const calleeSymbol = checker.getSymbolAtLocation(value.expression);
    const parameterCallback = calleeSymbol?.declarations?.some(ts.isParameter) && value.arguments.some((argument) => ts.isFunctionLike(argument) && containsSink(argument));
    if (parameterCallback) return "unknown";
    if (identity?.module.startsWith(".") && !(identity.module === validator.sink.module && identity.export === validator.sink.export)) return "unknown";
    let count: InternalCardinality = identity?.module === validator.sink.module && identity.export === validator.sink.export ? 1 : 0;
    for (const argument of value.arguments) count = add(count, expression(argument));
    return count;
  };
  const expression = (value: ts.Node | undefined): InternalCardinality => {
    if (!value) return 0;
    if (value !== node && ts.isFunctionLike(value)) return 0;
    if (ts.isCallExpression(value)) return callCardinality(value, false);
    if (ts.isYieldExpression(value) && value.asteriskToken && value.expression && ts.isCallExpression(value.expression)) return callCardinality(value.expression, true);
    let count: InternalCardinality = 0;
    value.forEachChild((child) => { count = add(count, expression(child)); });
    return count;
  };
  const statement = (value: ts.Statement): InternalCardinality => {
    if (ts.isBlock(value)) return statements(value.statements);
    if (ts.isIfStatement(value)) return add(expression(value.expression), maximum(statement(value.thenStatement), value.elseStatement ? statement(value.elseStatement) : 0));
    if (ts.isForOfStatement(value)) {
      const consumed = ts.isCallExpression(value.expression) ? callCardinality(value.expression, true) : expression(value.expression);
      const body = statement(value.statement), repeatedBody = body === "unknown" ? "unknown" : body === 0 ? 0 : 2;
      return add(expression(value.initializer), add(consumed, repeatedBody));
    }
    if (ts.isForStatement(value) || ts.isForInStatement(value) || ts.isWhileStatement(value) || ts.isDoStatement(value)) {
      const body = statement(value.statement);
      return body === "unknown" ? "unknown" : body === 0 ? expression(value) : 2;
    }
    return expression(value);
  };
  const statements = (values: readonly ts.Statement[]): InternalCardinality => values.reduce<InternalCardinality>((count, value) => add(count, statement(value)), 0);
  return node.body ? ts.isBlock(node.body) ? statements(node.body.statements) : expression(node.body) : 0;
}

function resolveLocalFunction(checker: ts.TypeChecker, functions: ReadonlyMap<ts.Symbol, ts.FunctionLikeDeclaration>, call: ts.CallExpression): ts.FunctionLikeDeclaration | undefined {
  const signatureDeclaration = checker.getResolvedSignature(call)?.declaration;
  if (signatureDeclaration && ts.isFunctionLike(signatureDeclaration) && "body" in signatureDeclaration && signatureDeclaration.body) return signatureDeclaration as ts.FunctionLikeDeclaration;
  const lookup = ts.isPropertyAccessExpression(call.expression) ? call.expression.name : call.expression;
  const symbol = canonicalSymbol(checker, checker.getSymbolAtLocation(lookup));
  return symbol && functions.get(symbol);
}

function generatorConsumptions(checker: ts.TypeChecker, functions: ReadonlyMap<ts.Symbol, ts.FunctionLikeDeclaration>, node: ts.FunctionLikeDeclaration): "none" | "once" | "many" {
  let count: 0 | 1 | 2 = 0;
  const visit = (value: ts.Node): void => {
    if (value !== node && ts.isFunctionLike(value)) return;
    const call = ts.isForOfStatement(value) && ts.isCallExpression(value.expression) ? value.expression
      : ts.isYieldExpression(value) && value.asteriskToken && value.expression && ts.isCallExpression(value.expression) ? value.expression
      : undefined;
    const callee = call && resolveLocalFunction(checker, functions, call);
    if (callee && "asteriskToken" in callee && callee.asteriskToken) count = Math.min(2, count + 1) as 0 | 1 | 2;
    ts.forEachChild(value, visit);
  };
  visit(node);
  return count === 0 ? "none" : count === 1 ? "once" : "many";
}

function createVirtualProgram(files: Record<string, string>): ts.Program {
  const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, lib: ["lib.es2024.d.ts", "lib.dom.d.ts"], types: ["node"], noEmit: true };
  const host = ts.createCompilerHost(options), original = host.getSourceFile.bind(host);
  host.fileExists = (fileName) => Object.hasOwn(files, fileName) || ts.sys.fileExists(fileName);
  host.readFile = (fileName) => files[fileName] ?? ts.sys.readFile(fileName);
  host.getSourceFile = (fileName, version, onError, fresh) => Object.hasOwn(files, fileName) ? ts.createSourceFile(fileName, files[fileName]!, version, true, ts.ScriptKind.TS) : original(fileName, version, onError, fresh);
  const resolveModule = (moduleName: string, containingFile: string): ts.ResolvedModuleFull | undefined => {
    if (moduleName.startsWith(".")) {
      const joined = posix.normalize(posix.join(posix.dirname(containingFile), moduleName));
      const absoluteStem = joined.replace(/\.[cm]?js$/, "");
      const stem = posix.isAbsolute(absoluteStem) ? posix.relative(process.cwd().replaceAll("\\", "/"), absoluteStem) : absoluteStem;
      const candidate = [`${stem}.ts`, `${stem}.tsx`, `${stem}.mts`, `${stem}.cts`, `${stem}/index.ts`].find((name) => Object.hasOwn(files, name));
      if (candidate) return { resolvedFileName: candidate, extension: candidate.endsWith(".tsx") ? ts.Extension.Tsx : candidate.endsWith(".mts") ? ts.Extension.Mts : candidate.endsWith(".cts") ? ts.Extension.Cts : ts.Extension.Ts, isExternalLibraryImport: false };
    }
    return ts.resolveModuleName(moduleName, containingFile, options, host).resolvedModule;
  };
  host.resolveModuleNames = (moduleNames, containingFile) => moduleNames.map((moduleName) => resolveModule(moduleName, containingFile));
  host.resolveModuleNameLiterals = (moduleLiterals, containingFile) => moduleLiterals.map((moduleLiteral) => ({ resolvedModule: resolveModule(moduleLiteral.text, containingFile) }));
  return ts.createProgram(Object.keys(files), options, host);
}

export function analyzeUneffectProject(options: AnalyzeUneffectProjectOptions): UneffectProjectAnalysis {
  const schemaDomains: Record<string, AtomDomain> = { TokenSet: "token", MethodSet: "token", ResourceSet: "literal", LiteralSet: "literal", UrlSet: "url", PathSet: "path", HostSet: "host", EnvSet: "env", RegionSet: "region" };
  for (const text of Object.values(options.files)) for (const declaration of extractAnnotations(text, "effect_schema")) {
    const match = /^([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)<(.+)>$/.exec(declaration);
    if (!match) throw new Error(`invalid effect_schema: ${declaration}`);
    const arguments_ = match[2]!.split(",").map((item) => schemaDomains[item.trim()]);
    if (arguments_.some((item) => !item)) throw new Error(`unknown effect_schema argument domain: ${declaration}`);
    registerEffectSchema({ name: match[1]!, version: 1, arguments: arguments_ as AtomDomain[] });
  }
  const validators = options.validators ?? [], program = createVirtualProgram(options.files), checker = program.getTypeChecker();
  const projectHash = sourceDigest(JSON.stringify(Object.entries(options.files).sort(([left], [right]) => left.localeCompare(right))));
  const diagnostics: Array<ProjectValidatorDiagnostic | ProjectSafetyDiagnostic> = [], summaries: UneffectProjectSummary[] = [];
  const summary = (fileName: string, name: string): UneffectProjectSummary => {
    let value = summaries.find((item) => item.fileName === fileName && item.functionName === name);
    if (!value) { value = { fileName, functionName: name, effects: [], specializations: [] }; summaries.push(value); }
    return value;
  };
  const functions = new Map<ts.Symbol, ts.FunctionLikeDeclaration>();
  for (const source of program.getSourceFiles()) if (Object.hasOwn(options.files, source.fileName)) {
    const collect = (node: ts.Node): void => {
      if (ts.isFunctionLike(node) && "body" in node && node.body && node.name) {
        const symbol = checker.getSymbolAtLocation(node.name);
        if (symbol) functions.set(symbol, node as ts.FunctionLikeDeclaration);
      }
      ts.forEachChild(node, collect);
    };
    collect(source);
  }
  let entrypointNode: ts.FunctionLikeDeclaration | undefined;
  let functionCount = 0, annotatedFunctionCount = 0;
  const orderedEvents: ProjectOrderedEvent[] = [];
  for (const source of program.getSourceFiles()) {
    if (!Object.hasOwn(options.files, source.fileName)) continue;
    const effectResult = analyzeEffectSummariesInProgram(program, source, { requireAnnotations: false });
    for (const effectSummary of effectResult.summaries) {
      const target = summary(source.fileName, effectSummary.functionName);
      target.effects = effectSummary.effects.map(formatEffect).sort();
      target.evidence = effectSummary.evidence;
    }
    for (const diagnostic of effectResult.diagnostics) diagnostics.push({ code: `${diagnostic.kind}-effect`, fileName: diagnostic.fileName, functionName: diagnostic.functionName, effect: diagnostic.effect, message: diagnostic.message });
    const asyncResult = analyzeAsyncSafetyInProgram(program, source);
    for (const diagnostic of asyncResult.diagnostics) diagnostics.push({ code: diagnostic.kind, fileName: diagnostic.fileName, functionName: diagnostic.functionName, message: diagnostic.message });
    for (const promise of asyncResult.promises) if (promise.observation === "await") orderedEvents.push({
      fileName: source.fileName, owner: promise.owner, kind: "suspend", span: promise.span,
    });
    for (const resource of asyncResult.resources) orderedEvents.push({
      fileName: source.fileName, owner: resource.owner, kind: "acquire", resource: resource.binding,
      asynchronous: resource.asynchronous, span: { start: resource.span.end, end: resource.span.end },
    });
    for (const disposal of asyncResult.disposals) orderedEvents.push({
      fileName: source.fileName, owner: disposal.owner, kind: "dispose", resource: disposal.binding,
      asynchronous: disposal.asynchronous, span: { start: disposal.disposalPoint, end: disposal.disposalPoint },
    });
    for (const event of collectOwnershipEvents(program, source)) if (event.operation === "transfer") orderedEvents.push({
      fileName: source.fileName, owner: "<module>", kind: "transfer", resource: event.resource, span: event.span,
    });
    const visit = (node: ts.Node): void => {
      if (ts.isFunctionLike(node) && "body" in node && node.body) {
        functionCount++;
        const functionNode = node as ts.FunctionLikeDeclaration;
        if (options.entrypoint && functionName(functionNode) === options.entrypoint) entrypointNode = functionNode;
        const annotations = extractAnnotations(source.text.slice(node.getFullStart(), node.getStart(source)), "validate");
        if (/\/\*\s*uneffect:/.test(source.text.slice(node.getFullStart(), node.getStart(source)))) annotatedFunctionCount++;
        const specializations: FunctionSpecialization[] = [];
        for (const name of annotations) {
          const validator = validators.find((item) => item.name === name);
          if (!validator) continue;
          const cardinality = cardinalityOfFunction(checker, functionNode, validator, functions), inferredMaximum: CallCardinality = cardinality === 0 ? "0" : cardinality === 1 ? "1" : cardinality === "unknown" ? "unknown" : "many";
          if (cardinality !== "unknown" && cardinality <= validator.specialization.maximum) specializations.push({ schema: "uneffect-cardinality/v1", validator: validator.name, validatorVersion: validator.version, validatorDigest: validatorDigest(validator), compilerRevision: ts.version, sourceHash: sourceDigest(source.text), projectHash, kind: "call-cardinality", maximum: 1, inferredMaximum: cardinality === 0 ? "0" : "1", evidence: "verified" });
          else diagnostics.push({ code: cardinality === "unknown" ? "validator-cardinality-unknown" : "validator-cardinality-exceeded", fileName: source.fileName, functionName: functionName(functionNode), validator: validator.name, inferredMaximum });
        }
        if (annotations.length) summary(source.fileName, functionName(functionNode)).specializations.push(...specializations);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  let entrypoint: UneffectProjectAnalysis["entrypoint"];
  if (entrypointNode && validators[0]) {
    const cardinality = cardinalityOfFunction(checker, entrypointNode, validators[0], functions);
    entrypoint = { functionName: functionName(entrypointNode), sinkMaximum: cardinality === 0 ? 0 : cardinality === 1 ? 1 : cardinality, generatorConsumption: generatorConsumptions(checker, functions, entrypointNode) };
  }
  orderedEvents.sort((left, right) => left.fileName.localeCompare(right.fileName) || left.span.start - right.span.start || eventOrder(left.kind) - eventOrder(right.kind));
  const emittedFiles = Object.fromEntries(Object.entries(options.files).filter(([name]) => /\.[cm]?tsx?$/.test(name)).map(([name, text]) => [
    name.replace(/\.[cm]?tsx?$/, ".js"),
    ts.transpileModule(text, { fileName: name, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, removeComments: true } }).outputText,
  ]));
  return { diagnostics, summaries, orderedEvents, emittedFiles, coverage: { functions: functionCount, annotatedFunctions: annotatedFunctionCount, annotationDensity: functionCount === 0 ? 0 : annotatedFunctionCount / functionCount }, ...(entrypoint ? { entrypoint } : {}) };
}

function eventOrder(kind: ProjectOrderedEvent["kind"]): number {
  return kind === "suspend" ? 0 : kind === "acquire" ? 1 : kind === "transfer" ? 2 : 3;
}

export function validateUneffectProject(options: ValidateUneffectProjectOptions): UneffectProjectAnalysis {
  return analyzeUneffectProject({ files: options.files, validators: [options.validator], mode: "strict", entrypoint: options.entrypoint });
}
