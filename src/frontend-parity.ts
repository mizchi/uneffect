import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import ts from "typescript";
import { extractAnnotations } from "./annotations.js";
import { formatEffect, parseEffectSet } from "./capabilities.js";
import { analyzeAsyncSafety, composeResourceFailures, type ResourceError } from "./async-safety.js";
import type { CorsaCheckerFactFile } from "./corsa-checker-exporter.js";
import { isAuthenticatedCorsaCheckerFacts } from "./corsa-fact-provenance.js";
import { createProjectByteCoordinates, projectFunctionDisplayName } from "./project-coordinates.js";
import { TypeScriptFrontendAdapter } from "./frontend-adapter.js";

export interface CompareUneffectFrontendsOptions {
  files: Record<string, string>;
  corsaSchemaVersion?: number;
  /** Allows slower cold Rust builds while retaining a finite process boundary. */
  corsaTimeoutMs?: number;
  /** Actual schema-v8 facts emitted by the corsa-bind checker exporter. */
  corsaFacts?: CorsaCheckerFactFile;
  /** Fail the comparison unless records came from an actual corsa-bind checker. */
  requireCorsaCheckerFacts?: boolean;
}
export interface FrontendFactProvenance {
  producer: "typescript-reference" | "corsa-checker";
  checkerBacked: boolean;
  compilerRevision: string;
  satisfiesRequirement: boolean;
}
export interface NormalizedFrontendIr {
  schemaVersion: 8;
  provenance: Omit<FrontendFactProvenance, "satisfiesRequirement">;
  functions: Array<{ name: string; effects: string[] }>;
  calls: Array<{ caller: string; callee: string; callbackTiming: "none" }>;
  orderedEvents: Array<{ kind: "call"; caller: string; callee: string; start: number; end: number }>;
  promiseObservations: Array<{ owner: string; source: string; observation: string; catchesRejection: boolean; conditional: boolean; controlConditions: Array<{ id: string; expected: boolean }>; controlPaths: Array<Array<{ id: string; expected: boolean }>>; start: number; end: number }>;
  rejectionOwnership: Array<{ owner: string; binding: string; status: string; observations: string[]; start: number; end: number }>;
  protocolSymbols: Array<{ id: number; kind: "sync" | "async"; fileName: string; start: number; end: number }>;
  resourceScopes: Array<{ owner: string; binding: string; ownerAsync: boolean; asynchronous: boolean; conditional: boolean; controlConditions: Array<{ id: string; expected: boolean }>; controlPaths: Array<Array<{ id: string; expected: boolean }>>; acquisitionIndex: number; scopeId: string; scopeDepth: number; scopeEnd: number; catchesFailure: boolean; disposalFailureType: string; protocolSymbol: number | null; protocolKind: "sync" | "async" | null; start: number; end: number }>;
  disposals: Array<{ owner: string; binding: string; order: number; asynchronous: boolean; scopeId: string; scopeDepth: number; disposalPoint: number; failureKind: string; failureType: string; catchesFailure: boolean; escapingFailure: string; exits: string[] }>;
  suppressedErrors: Array<{ owner: string; payload: ResourceError }>;
}
export interface FrontendSchemaDrift { frontend: "corsa"; message: string }
export interface CompareUneffectFrontendsResult {
  equivalent: boolean;
  semanticEquivalent: boolean;
  provenance: FrontendFactProvenance;
  schemaDrift: FrontendSchemaDrift[];
  typescriptIr: NormalizedFrontendIr;
  corsaIr: NormalizedFrontendIr | null;
}

function programOf(files: Record<string, string>): ts.Program {
  const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, noEmit: true };
  const host = ts.createCompilerHost(options), original = host.getSourceFile.bind(host);
  const originalFileExists = host.fileExists.bind(host), originalReadFile = host.readFile.bind(host);
  host.fileExists = (name) => projectFileName(files, name) !== undefined || originalFileExists(name);
  host.readFile = (name) => {
    const key = projectFileName(files, name);
    return key === undefined ? originalReadFile(name) : files[key];
  };
  host.getSourceFile = (name, version, onError, fresh) => {
    const key = projectFileName(files, name);
    return key === undefined ? original(name, version, onError, fresh) : ts.createSourceFile(name, files[key]!, version, true, ts.ScriptKind.TS);
  };
  return ts.createProgram(Object.keys(files).sort((left, right) => left.localeCompare(right)), options, host);
}

function projectFileName(files: Readonly<Record<string, string>>, candidate: string): string | undefined {
  if (Object.hasOwn(files, candidate)) return candidate;
  const absolute = resolve(candidate);
  return Object.keys(files).find((fileName) => resolve(fileName) === absolute);
}

function corsaInput(program: ts.Program, files: Record<string, string>, schemaVersion: number) {
  const coordinates = createProjectByteCoordinates(files);
  const nameCounts = topLevelFunctionNameCounts(program, files);
  let nextId = 1;
  const symbols: any[] = [], trivia: unknown[] = [], calls: any[] = [];
  const ids = new Map<ts.Symbol, number>(), declarations: Array<{ source: ts.SourceFile; sourceName: string; callable: TopLevelCallable; id: number }> = [];
  const checker = program.getTypeChecker();
  const adapter = new TypeScriptFrontendAdapter(program);
  for (const source of program.getSourceFiles()) {
    const sourceName = projectFileName(files, source.fileName);
    if (!sourceName) continue;
    for (const callable of topLevelCallables(source)) {
      const id = nextId++, leading = source.text.slice(callable.declaration.getFullStart(), callable.declaration.getStart(source));
      const symbol = checker.getSymbolAtLocation(callable.nameNode);
      if (symbol) ids.set(symbol, id);
      const overloads = symbol?.declarations
        ?.filter((item): item is ts.FunctionDeclaration | ts.MethodDeclaration =>
          (ts.isFunctionDeclaration(item) || ts.isMethodDeclaration(item)) && !item.body)
        .map((item) => checker.signatureToString(checker.getSignatureFromDeclaration(item)!)) ?? [];
      declarations.push({ source, sourceName, callable, id });
      const type = checker.getTypeAtLocation(callable.nameNode);
      symbols.push({ id, name: projectFunctionDisplayName(sourceName, callable.name, nameCounts), kind: "function", typeRepr: checker.typeToString(type), overloads, effectParameters: [], inferredEffects: [], span: { start: coordinates.offset(sourceName, callable.declaration.getStart(source)), end: coordinates.offset(sourceName, callable.declaration.getEnd()) } });
      if (extractAnnotations(leading, "effect").length) trivia.push({ owner: id, text: leading, span: { start: coordinates.offset(sourceName, callable.declaration.getFullStart()), end: coordinates.offset(sourceName, callable.declaration.getStart(source)) } });
    }
  }
  for (const { source, sourceName, callable, id: caller } of declarations) {
    const visit = (child: ts.Node): void => {
      if (child !== callable.body && ts.isFunctionLike(child)) return;
      if (ts.isCallExpression(child)) {
        const resolvedBuiltin = adapter.resolveCall(child);
        if (resolvedBuiltin?.operation?.kind === "effect") {
          const lookup = ts.isPropertyAccessExpression(child.expression) ? child.expression.name : child.expression;
          let builtinSymbol = checker.getSymbolAtLocation(lookup);
          if (builtinSymbol && (builtinSymbol.flags & ts.SymbolFlags.Alias)) builtinSymbol = checker.getAliasedSymbol(builtinSymbol);
          const declaration = builtinSymbol?.declarations?.[0];
          (symbols.find((symbol) => symbol.id === caller) as any).inferredEffects.push({
            effect: resolvedBuiltin.operation.effect,
            builtin: resolvedBuiltin.symbol,
            symbolIdentity: declaration ? `${declaration.getSourceFile().fileName}:${declaration.getStart()}` : "typescript-symbol",
            declaration: declaration ? {
              fileName: declaration.getSourceFile().fileName,
              start: declaration.getStart(),
              end: declaration.getEnd(),
            } : { fileName: "typescript-library", start: 0, end: 0 },
            span: {
              start: coordinates.offset(sourceName, child.getStart(source)),
              end: coordinates.offset(sourceName, child.getEnd()),
            },
          });
        }
        const lookup = ts.isPropertyAccessExpression(child.expression) ? child.expression.name : child.expression;
        let symbol = checker.getSymbolAtLocation(lookup);
        if (symbol && (symbol.flags & ts.SymbolFlags.Alias)) symbol = checker.getAliasedSymbol(symbol);
        const callee = symbol ? ids.get(symbol) : undefined;
        if (callee) {
          const overloadDeclarations = symbol?.declarations?.filter((item): item is ts.FunctionDeclaration | ts.MethodDeclaration =>
            (ts.isFunctionDeclaration(item) || ts.isMethodDeclaration(item)) && !item.body) ?? [];
          const selected = checker.getResolvedSignature(child)?.declaration;
          const selectedIndex = selected ? overloadDeclarations.indexOf(selected as ts.FunctionDeclaration | ts.MethodDeclaration) : -1;
          calls.push({ caller, callee, overloadIndex: selectedIndex >= 0 ? selectedIndex : null, callbackTiming: "none", span: { start: coordinates.offset(sourceName, child.getStart(source)), end: coordinates.offset(sourceName, child.getEnd()) } });
        }
      }
      ts.forEachChild(child, visit);
    };
    ts.forEachChild(callable.body, visit);
  }
  const idsByFileAndName = new Map(declarations.map((item) => [`${item.sourceName}\0${item.callable.name}`, item.id]));
  const promiseObservations: unknown[] = [], rejectionOwnership: unknown[] = [], resourceScopes: unknown[] = [], disposals: unknown[] = [], suppressedErrors: unknown[] = [];
  const protocolSymbols: Array<{ id: number; kind: "sync" | "async"; fileName: string; span: { start: number; end: number } }> = [];
  const protocolIds = new Map<string, number>();
  for (const fileName of coordinates.fileNames) {
    const text = files[fileName]!;
    const async = analyzeAsyncSafety(fileName, text);
    for (const item of async.promises) {
      const owner = idsByFileAndName.get(`${fileName}\0${item.owner}`); if (!owner) continue;
      promiseObservations.push({ owner, source: item.source, observation: item.observation, catchesRejection: item.catchesRejection, conditional: item.conditional, controlConditions: item.controlConditions, controlPaths: item.controlPaths,
        span: { start: coordinates.offset(fileName, item.span.start), end: coordinates.offset(fileName, item.span.end) } });
    }
    for (const item of async.promiseBindings) {
      const owner = idsByFileAndName.get(`${fileName}\0${item.owner}`); if (!owner) continue;
      rejectionOwnership.push({ owner, binding: item.binding, status: item.status, observations: item.observations,
        span: { start: coordinates.offset(fileName, item.span.start), end: coordinates.offset(fileName, item.span.end) } });
    }
    for (const item of async.resources) {
      const owner = idsByFileAndName.get(`${fileName}\0${item.owner}`); if (!owner) continue;
      let protocolSymbol: number | null = null;
      if (item.disposalProtocol) {
        const protocolSource = files[item.disposalProtocol.fileName];
        const start = protocolSource === undefined ? item.disposalProtocol.start : coordinates.offset(item.disposalProtocol.fileName, item.disposalProtocol.start);
        const end = protocolSource === undefined ? item.disposalProtocol.end : coordinates.offset(item.disposalProtocol.fileName, item.disposalProtocol.end);
        const key = `${item.disposalProtocol.fileName}\0${start}\0${end}\0${item.disposalProtocol.kind}`;
        protocolSymbol = protocolIds.get(key) ?? protocolSymbols.length + 1;
        if (!protocolIds.has(key)) { protocolIds.set(key, protocolSymbol); protocolSymbols.push({ id: protocolSymbol, kind: item.disposalProtocol.kind, fileName: item.disposalProtocol.fileName, span: { start, end } }); }
      }
      resourceScopes.push({ owner, binding: item.binding, ownerAsync: item.ownerAsync, asynchronous: item.asynchronous, conditional: item.conditional, controlConditions: item.controlConditions, controlPaths: item.controlPaths,
        acquisitionIndex: item.acquisitionIndex, scopeId: item.scopeId, scopeDepth: item.scopeDepth, scopeEnd: coordinates.offset(fileName, item.scopeEnd),
        catchesFailure: item.catchesFailure, disposalFailureType: item.disposalFailureType, protocolSymbol,
        protocolKind: item.disposalProtocol?.kind ?? null,
        span: { start: coordinates.offset(fileName, item.span.start), end: coordinates.offset(fileName, item.span.end) } });
    }
    for (const item of async.disposals) {
      const owner = idsByFileAndName.get(`${fileName}\0${item.owner}`); if (!owner) continue;
      disposals.push({ owner, binding: item.binding, order: item.order, asynchronous: item.asynchronous, scopeId: item.scopeId,
        scopeDepth: item.scopeDepth, disposalPoint: coordinates.offset(fileName, item.disposalPoint), failureKind: item.failureKind,
        failureType: item.failureType, catchesFailure: item.catchesFailure, escapingFailure: item.escapingFailure, exits: item.exits });
    }
    for (const ownerName of [...new Set(async.disposals.map((item) => item.owner))]) {
      const owner = idsByFileAndName.get(`${fileName}\0${ownerName}`); if (!owner) continue;
      const bindings = async.disposals.filter((item) => item.owner === ownerName).sort((left, right) => left.order - right.order).map((item) => item.binding);
      const payload = composeResourceFailures(async, ownerName, undefined, bindings);
      if (payload) suppressedErrors.push({ owner, payload });
    }
  }
  return { schemaVersion, fileId: 1, provenance: { producer: "typescript-reference" as const, checkerBacked: false }, compilerRevision: `typescript-reference@${ts.version}`, symbols, calls, trivia, protocolSymbols, promiseObservations, rejectionOwnership, resourceScopes, disposals, suppressedErrors };
}

export async function compareUneffectFrontends(options: CompareUneffectFrontendsOptions): Promise<CompareUneffectFrontendsResult> {
  const program = programOf(options.files), functions: NormalizedFrontendIr["functions"] = [];
  const coverageFailures = options.corsaFacts || options.requireCorsaCheckerFacts
    ? checkerCoverageFailures(program, options.files)
    : [];
  const nameCounts = topLevelFunctionNameCounts(program, options.files);
  for (const source of program.getSourceFiles()) if (projectFileName(options.files, source.fileName)) for (const callable of topLevelCallables(source)) {
    const sourceName = projectFileName(options.files, source.fileName)!;
    const leading = source.text.slice(callable.declaration.getFullStart(), callable.declaration.getStart(source));
    const effects = extractAnnotations(leading, "effect").flatMap(parseEffectSet).map(formatEffect).sort();
    functions.push({ name: projectFunctionDisplayName(sourceName, callable.name, nameCounts), effects });
  }
  functions.sort((left, right) => left.name.localeCompare(right.name));
  const referenceInput = corsaInput(program, options.files, options.corsaSchemaVersion ?? 8);
  const input = options.corsaFacts ?? referenceInput;
  if (options.corsaFacts) coverageFailures.push(...checkerMetadataParityFailures(referenceInput, input));
  const provenance: FrontendFactProvenance = {
    ...input.provenance,
    compilerRevision: input.compilerRevision,
    satisfiesRequirement: !options.requireCorsaCheckerFacts || (
      input.provenance.producer === "corsa-checker" && isAuthenticatedCorsaCheckerFacts(input)
    ),
  };
  const protocolSymbols = referenceInput.protocolSymbols.map((item) => ({ id: item.id, kind: item.kind, fileName: item.fileName, start: item.span.start, end: item.span.end }));
  const names = new Map(referenceInput.symbols.map((symbol) => [symbol.id as number, symbol.name as string]));
  for (const symbol of referenceInput.symbols) {
    const summary = functions.find((item) => item.name === symbol.name);
    if (!summary) continue;
    summary.effects = [...new Set([
      ...summary.effects,
      ...(symbol.inferredEffects ?? []).map((item: any) => item.effect as string),
    ])].sort();
  }
  const calls = referenceInput.calls.map((call) => ({ caller: names.get(call.caller)!, callee: names.get(call.callee)!, callbackTiming: "none" as const }));
  let changed = true;
  while (changed) {
    changed = false;
    for (const call of calls) {
      const caller = functions.find((item) => item.name === call.caller)!, callee = functions.find((item) => item.name === call.callee)!;
      const next = [...new Set([...caller.effects, ...callee.effects])].sort();
      if (next.join("\0") !== caller.effects.join("\0")) { caller.effects = next; changed = true; }
    }
  }
  const orderedEvents = referenceInput.calls.map((call) => ({ kind: "call" as const, caller: names.get(call.caller)!, callee: names.get(call.callee)!, start: call.span.start, end: call.span.end }))
    .sort((left, right) => left.start - right.start || left.end - right.end);
  const promiseObservations = referenceInput.promiseObservations.map((item: any) => ({ owner: names.get(item.owner)!, source: item.source, observation: item.observation,
    catchesRejection: item.catchesRejection, conditional: item.conditional, controlConditions: item.controlConditions, controlPaths: item.controlPaths, start: item.span.start, end: item.span.end }));
  const rejectionOwnership = referenceInput.rejectionOwnership.map((item: any) => ({ owner: names.get(item.owner)!, binding: item.binding, status: item.status,
    observations: item.observations, start: item.span.start, end: item.span.end }));
  const resourceScopes = referenceInput.resourceScopes.map((item: any) => ({ owner: names.get(item.owner)!, binding: item.binding, ownerAsync: item.ownerAsync,
    asynchronous: item.asynchronous, conditional: item.conditional, controlConditions: item.controlConditions, controlPaths: item.controlPaths, acquisitionIndex: item.acquisitionIndex, scopeId: item.scopeId, scopeDepth: item.scopeDepth, scopeEnd: item.scopeEnd,
    catchesFailure: item.catchesFailure, disposalFailureType: item.disposalFailureType, protocolSymbol: item.protocolSymbol,
    protocolKind: item.protocolKind, start: item.span.start, end: item.span.end }));
  const disposals = referenceInput.disposals.map((item: any) => ({ owner: names.get(item.owner)!, binding: item.binding, order: item.order,
    asynchronous: item.asynchronous, scopeId: item.scopeId, scopeDepth: item.scopeDepth, disposalPoint: item.disposalPoint,
    failureKind: item.failureKind, failureType: item.failureType, catchesFailure: item.catchesFailure,
    escapingFailure: item.escapingFailure, exits: item.exits }));
  const suppressedErrors = referenceInput.suppressedErrors.map((item: any) => ({ owner: names.get(item.owner)!, payload: item.payload as ResourceError }));
  const irProvenance = { ...referenceInput.provenance, compilerRevision: referenceInput.compilerRevision };
  const typescriptIr: NormalizedFrontendIr = { schemaVersion: 8, provenance: irProvenance, functions, calls, orderedEvents, protocolSymbols, promiseObservations, rejectionOwnership, resourceScopes, disposals, suppressedErrors };
  const execution = spawnSync("cargo", ["run", "--quiet", "--package", "uneffect-core", "--bin", "uneffect-corsa-normalize"], {
    input: JSON.stringify(input), encoding: "utf8", timeout: options.corsaTimeoutMs ?? 120_000,
  });
  if (execution.error || execution.status !== 0) return { equivalent: false, semanticEquivalent: false, provenance, schemaDrift: [...coverageFailures, { frontend: "corsa", message: `${execution.stderr}${execution.error?.message ?? ""}`.trim() }], typescriptIr, corsaIr: null };
  try {
    const corsaIr = JSON.parse(execution.stdout) as NormalizedFrontendIr;
    corsaIr.functions.sort((left, right) => left.name.localeCompare(right.name));
    const semanticEquivalent = JSON.stringify(semanticProjection(typescriptIr)) === JSON.stringify(semanticProjection(corsaIr));
    const provenanceFailure: FrontendSchemaDrift[] = provenance.satisfiesRequirement ? [] : [{
      frontend: "corsa",
      message: input.provenance.producer === "corsa-checker"
        ? "corsa-checker provenance was not authenticated by the in-process exporter"
        : "actual corsa-bind checker facts are unavailable; comparison used TypeScript reference-adapter records",
    }];
    return { equivalent: semanticEquivalent && provenance.satisfiesRequirement && coverageFailures.length === 0, semanticEquivalent, provenance, schemaDrift: [...coverageFailures, ...provenanceFailure], typescriptIr, corsaIr };
  } catch (error) {
    return { equivalent: false, semanticEquivalent: false, provenance, schemaDrift: [...coverageFailures, { frontend: "corsa", message: error instanceof Error ? error.message : String(error) }], typescriptIr, corsaIr: null };
  }
}

function checkerCoverageFailures(program: ts.Program, files: Readonly<Record<string, string>>): FrontendSchemaDrift[] {
  const failures: FrontendSchemaDrift[] = [];
  for (const source of program.getSourceFiles()) {
    const fileName = projectFileName(files, source.fileName);
    if (!fileName) continue;
    for (const statement of source.statements) {
      if (ts.isClassDeclaration(statement) && statement.name) {
        for (const member of statement.members) {
          if (!ts.isMethodDeclaration(member) || !member.body) continue;
          const leading = source.text.slice(member.getFullStart(), member.getStart(source));
          if (!extractAnnotations(leading, "effect").length || ts.isIdentifier(member.name)) continue;
          failures.push({
            frontend: "corsa",
            message: `${fileName}:${source.getLineAndCharacterOfPosition(member.getStart(source)).line + 1}: annotated computed method is outside checker-backed frontend coverage`,
          });
        }
      }
      if (ts.isVariableStatement(statement)) {
        const leading = source.text.slice(statement.getFullStart(), statement.getStart(source));
        if (!extractAnnotations(leading, "effect").length) continue;
        const declarations = statement.declarationList.declarations;
        const supported = Boolean(statement.declarationList.flags & ts.NodeFlags.Const)
          && declarations.length === 1
          && ts.isIdentifier(declarations[0]!.name)
          && Boolean(declarations[0]!.initializer && (ts.isArrowFunction(declarations[0]!.initializer!) || ts.isFunctionExpression(declarations[0]!.initializer!)));
        if (!supported) failures.push({
          frontend: "corsa",
          message: `${fileName}:${source.getLineAndCharacterOfPosition(statement.getStart(source)).line + 1}: annotated variable callable is outside checker-backed frontend coverage`,
        });
      }
    }
  }
  return failures;
}

function checkerMetadataParityFailures(reference: any, actual: any): FrontendSchemaDrift[] {
  const failures: FrontendSchemaDrift[] = [];
  const referenceNames = new Map(reference.symbols.map((symbol: any) => [symbol.id, symbol.name]));
  const actualNames = new Map(actual.symbols.map((symbol: any) => [symbol.id, symbol.name]));
  const actualByName = new Map(actual.symbols.map((symbol: any) => [symbol.name, symbol]));
  for (const expected of reference.symbols) {
    const observed: any = actualByName.get(expected.name);
    if (!observed) continue;
    if (JSON.stringify(expected.overloads) !== JSON.stringify(observed.overloads)) failures.push({
      frontend: "corsa",
      message: `checker-backed overload candidates differ for ${expected.name}`,
    });
    const evidenceKey = (item: any): string => `${item.effect}\0${item.builtin?.module}\0${item.builtin?.export}\0${item.span?.start}\0${item.span?.end}`;
    const expectedEffects = (expected.inferredEffects ?? []).map(evidenceKey).sort();
    const observedEffects = (observed.inferredEffects ?? []).map(evidenceKey).sort();
    if (JSON.stringify(expectedEffects) !== JSON.stringify(observedEffects)) failures.push({
      frontend: "corsa",
      message: `checker-backed inferred-effect evidence differs for ${expected.name}`,
    });
  }
  const callKey = (call: any, names: Map<any, any>): string =>
    `${names.get(call.caller)}\0${names.get(call.callee)}\0${call.span.start}\0${call.span.end}`;
  const actualCalls = new Map(actual.calls.map((call: any) => [callKey(call, actualNames), call]));
  for (const expected of reference.calls) {
    const observed: any = actualCalls.get(callKey(expected, referenceNames));
    if (!observed) continue;
    if (expected.overloadIndex !== observed.overloadIndex) failures.push({
      frontend: "corsa",
      message: `checker-backed selected overload differs for ${referenceNames.get(expected.callee)}`,
    });
  }
  return failures;
}

function topLevelFunctionNameCounts(program: ts.Program, files: Readonly<Record<string, string>>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const source of program.getSourceFiles()) {
    if (!projectFileName(files, source.fileName)) continue;
    for (const callable of topLevelCallables(source)) {
      counts.set(callable.name, (counts.get(callable.name) ?? 0) + 1);
    }
  }
  return counts;
}

interface TopLevelCallable {
  name: string;
  nameNode: ts.Identifier;
  body: ts.ConciseBody;
  declaration: ts.Node;
}

function topLevelCallables(source: ts.SourceFile): TopLevelCallable[] {
  const callables: TopLevelCallable[] = [];
  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name && statement.body) {
      callables.push({ name: statement.name.text, nameNode: statement.name, body: statement.body, declaration: statement });
      continue;
    }
    if (ts.isClassDeclaration(statement) && statement.name) {
      for (const member of statement.members) {
        if (!ts.isMethodDeclaration(member) || !member.body || !ts.isIdentifier(member.name)) continue;
        callables.push({
          name: `${statement.name.text}.${member.name.text}`,
          nameNode: member.name,
          body: member.body,
          declaration: member,
        });
      }
      continue;
    }
    if (!ts.isVariableStatement(statement) || statement.declarationList.declarations.length !== 1) continue;
    if (!(statement.declarationList.flags & ts.NodeFlags.Const)) continue;
    const declaration = statement.declarationList.declarations[0]!;
    if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
    if (!ts.isArrowFunction(declaration.initializer) && !ts.isFunctionExpression(declaration.initializer)) continue;
    callables.push({
      name: declaration.name.text,
      nameNode: declaration.name,
      body: declaration.initializer.body,
      declaration: statement,
    });
  }
  return callables;
}

function semanticProjection(ir: NormalizedFrontendIr): Omit<NormalizedFrontendIr, "provenance"> {
  const { provenance: _provenance, ...projection } = ir;
  return projection;
}
