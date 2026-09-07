import { resolve } from "node:path";
import type { CorsaApiClient } from "@corsa-bind/napi";
import type { Node } from "oxc-parser";
import { oxcChildren, parseOxcSource, type OxcSource } from "../oxc/source.js";
import { resolveCorsaExecutable, type CorsaApiFrontendOptions, type CorsaApiTypeFact, type CorsaApiSymbolFact } from "./corsa-api-frontend.js";
import { decodeNativeSourceIndex, nativeCallableKinds, parseNativeNodeHandle, type NativeSourceIndex } from "./native-source-index.js";
import { nativeExpressionKind } from "./native-expression-kind.js";

export interface CorsaCallableSignature {
  readonly id: string;
  /** Authenticated native declaration span, excluding leading trivia. */
  readonly declaration: { fileName: string; span: { start: number; end: number } };
  readonly parameters: readonly { name: string; type: CorsaApiTypeFact }[];
  readonly returnType: CorsaApiTypeFact;
}

export interface CorsaCallableFrontend {
  readonly compilerRevision: string;
  readonly compilerExecutable: string;
  readonly rootFiles: readonly string[];
  /** Resolves a complete Oxc CallExpression/NewExpression range in matching snapshot source. */
  getResolvedSignature(file: string, span: { start: number; end: number }, source: string): CorsaCallableSignature | null;
  /** Function declarations (including export modifiers), expressions, and arrows. */
  getSignatureFromDeclaration(file: string, span: { start: number; end: number }, source: string): CorsaCallableSignature | null;
  /** Returns the full overload set; never chooses an overload by its position in this list. */
  getSignaturesOfTypeAtPosition(file: string, position: number, kind?: "call" | "construct"): readonly CorsaCallableSignature[];
  /** Exact Oxc expression range authenticated against native snapshot syntax. */
  getExpressionType(file: string, span: { start: number; end: number }, source: string): CorsaApiTypeFact | null;
  /** Intrinsic never identity, without display-text inference. */
  isNeverType(type: CorsaApiTypeFact): boolean;
  /** Native boolean literal payload; broad boolean/any/unknown/never are not constants. */
  getBooleanLiteralValue(type: CorsaApiTypeFact): boolean | undefined;
  assertSource(file: string, source: string): void;
  getSymbolAtPosition(file: string, position: number): CorsaApiSymbolFact | null;
  getAliasedSymbol(symbol: CorsaApiSymbolFact): CorsaApiSymbolFact | null;
  getTypeAliasSymbol(type: CorsaApiTypeFact): CorsaApiSymbolFact | null;
  /** Both type facts must originate in this frontend's snapshot. */
  isTypeAssignableTo(source: CorsaApiTypeFact, target: CorsaApiTypeFact): boolean;
  /** Resolve the value of an Oxc shorthand Property, rather than its object property symbol. */
  getShorthandAssignmentValueSymbol(file: string, span: { start: number; end: number }, source: string): CorsaApiSymbolFact | null;
  /** Intrinsic identity after literal widening; excludes any, unknown, never, and branded intersections. */
  getPrimitiveTypeKind(type: CorsaApiTypeFact): "number" | "boolean" | null;
  /** Snapshot diagnostics. Rejects noCheck projects rather than returning a false clean result. */
  getProjectDiagnostics(): readonly CorsaCallableDiagnostic[];
  close(): void;
}

export interface CorsaCallableDiagnostic {
  readonly category: "warning" | "error" | "suggestion" | "message";
  readonly code: number;
  readonly message: string;
  readonly fileName?: string;
  readonly span?: { start: number; end: number };
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("invalid native signature response");
  return value as Record<string, unknown>;
}
function numericHandle(value: unknown): number {
  if (typeof value !== "number" && (typeof value !== "string" || !/^\d+$/u.test(value))) throw new Error("invalid native numeric handle");
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error("invalid native numeric handle");
  return number;
}

/**
 * Typed bridge for native callable, type, and diagnostic endpoints missing named N-API
 * methods in @corsa-bind/napi 1.13.1. Wire parameters follow TypeScript 7.0.2
 * internal/api/proto.go. Other checker queries keep using named binding methods.
 */
function callableQueries(client: CorsaApiClient, snapshot: string, project: string) {
  const context = { snapshot: numericHandle(snapshot), project };
  return {
    resolve(location: string): unknown { return client.callJson<unknown>("getResolvedSignature", { ...context, location }); },
    declaration(location: string): unknown { return client.callJson<unknown>("getSignatureFromDeclaration", { ...context, location }); },
    returnType(signature: unknown): unknown { return client.callJson<unknown>("getReturnTypeOfSignature", { ...context, signature: numericHandle(signature) }); },
    parameters(signature: unknown): unknown { return client.callJson<unknown>("getParametersOfSignature", { ...context, objectId: numericHandle(signature) }); },
    literalBase(type: string): unknown { return client.callJson<unknown>("getBaseTypeOfLiteralType", { ...context, type: numericHandle(type) }); },
    typeAlias(type: string): unknown { return client.callJson<unknown>("getAliasSymbolOfType", { ...context, objectId: numericHandle(type) }); },
    shorthand(location: string): unknown { return client.callJson<unknown>("getShorthandAssignmentValueSymbol", { ...context, location }); },
    numberType(): unknown { return client.callJson<unknown>("getNumberType", context); },
    neverType(): unknown { return client.callJson<unknown>("getNeverType", context); },
    expressionType(location: string): unknown { return client.callJson<unknown>("getTypeAtLocation", { ...context, location }); },
    booleanType(): unknown { return client.callJson<unknown>("getBooleanType", context); },
    diagnostics(): unknown[] {
      return ["getConfigFileParsingDiagnostics", "getProgramDiagnostics", "getGlobalDiagnostics", "getSyntacticDiagnostics", "getSemanticDiagnostics"]
        .flatMap(method => {
          const value = client.callJson<unknown>(method, context);
          if (value === null) return [];
          if (!Array.isArray(value)) throw new Error("invalid native project diagnostics");
          return value;
        });
    },
    overloads(type: string, kind: number): unknown {
      // This method is implemented by the binding and accepts its string handles.
      return client.callJson<unknown>("getSignaturesOfType", { snapshot, project, type, kind });
    },
  };
}

/**
 * Native callable facts, without JavaScript TypeScript or display-text inference.
 * Resolution alone does not prove that a call is well typed: consumers must
 * still run project diagnostics before using these facts as verification evidence.
 */
export async function openCorsaCallableFrontend(options: CorsaApiFrontendOptions): Promise<CorsaCallableFrontend> {
  const { CorsaApiClient, version } = await import("@corsa-bind/napi");
  const compilerExecutable = resolveCorsaExecutable(options), configFile = resolve(options.configFile);
  const client = await CorsaApiClient.spawnAsync({ executable: compilerExecutable, cwd: resolve(options.cwd ?? process.cwd()), mode: "jsonrpc" });
  let snapshot: string | undefined;
  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    try { if (snapshot) client.releaseHandle(snapshot); }
    finally { client.close(); }
  };
  try {
    const initialized = await client.initializeAsync();
    const opened = await client.updateSnapshotAsync({ openProject: configFile });
    snapshot = opened.snapshot;
    const canonical = (file: string): string => initialized.useCaseSensitiveFileNames ? resolve(file) : resolve(file).toLowerCase();
    const project = opened.projects.find(item => canonical(item.configFileName) === canonical(configFile));
    if (!project) throw new Error(`Corsa did not open callable project ${configFile}`);
    const rpc = callableQueries(client, snapshot, project.id);
    const sources = new Map<string, NativeSourceIndex>();
    const syntaxSources = new Map<string, OxcSource>();
    const booleanLiterals = new WeakMap<CorsaApiTypeFact, boolean>();
    const ownedTypes = new WeakMap<CorsaApiTypeFact, string>();
    const ownedSymbols = new WeakMap<CorsaApiSymbolFact, { id: string; flags: number }>();
    const assertOpen = (): void => { if (closed) throw new Error("Corsa callable frontend is closed"); };
    const sourceIndex = (file: string): NativeSourceIndex => {
      assertOpen();
      const absolute = resolve(file), cached = sources.get(absolute);
      if (cached) return cached;
      const data = client.getSourceFile(snapshot!, project.id, absolute);
      if (!data) throw new Error(`${absolute} is not part of the Corsa snapshot`);
      const index = decodeNativeSourceIndex(data);
      sources.set(absolute, index);
      sources.set(index.path, index);
      return index;
    };
    const typeFact = (input: unknown): CorsaApiTypeFact => {
      const value = record(input), id = String(numericHandle(value.id));
      const type = { id, texts: [client.typeToString(snapshot!, project.id, id)],
        ...(value.symbol ? { symbol: String(numericHandle(value.symbol)) } : {}) };
      ownedTypes.set(type, id);
      if (typeof value.value === "boolean") booleanLiterals.set(type, value.value);
      return type;
    };
    const ownedTypeId = (type: CorsaApiTypeFact): string => {
      assertOpen();
      const id = ownedTypes.get(type);
      if (!id) throw new Error("type fact must come from this owning snapshot");
      return id;
    };
    const symbolFact = (input: unknown): CorsaApiSymbolFact | null => {
      if (input === null) return null;
      const value = record(input), id = String(numericHandle(value.id));
      if (typeof value.name !== "string" || typeof value.flags !== "number"
        || value.declarations !== undefined && (!Array.isArray(value.declarations) || value.declarations.some(item => typeof item !== "string"))) throw new Error("invalid native symbol response");
      const symbol: CorsaApiSymbolFact = { id, name: value.name, flags: value.flags, declarations: (value.declarations ?? []) as string[] };
      ownedSymbols.set(symbol, { id, flags: value.flags });
      return symbol;
    };
    let intrinsicNumbers: { number: number; boolean: number } | undefined;
    let intrinsicNever: number | undefined;
    const signatureFact = (input: unknown): CorsaCallableSignature | null => {
      if (input === null) return null;
      const value = record(input), id = String(numericHandle(value.id));
      // Native recovery/any signatures have no declaration and cannot establish identity.
      if (value.declaration === undefined) return null;
      if (typeof value.declaration !== "string") throw new Error("invalid native signature declaration");
      const handle = parseNativeNodeHandle(value.declaration), index = sourceIndex(handle.path);
      const node = index.node(value.declaration);
      if (value.parameters !== undefined && !Array.isArray(value.parameters)) throw new Error("invalid native signature parameters");
      // Fetching the sub-property registers parameter handles in the native
      // snapshot; IDs embedded in SignatureResponse are not yet queryable.
      const symbols = rpc.parameters(id);
      if (symbols !== null && !Array.isArray(symbols)) throw new Error("invalid native signature parameter symbols");
      const parameterSymbols = ((symbols ?? []) as unknown[]).map(record);
      const parameterIds = (value.parameters ?? []) as unknown[];
      if (parameterIds.length !== parameterSymbols.length) throw new Error("incomplete native signature parameter symbols");
      const parameters = parameterIds.map((parameter, position) => {
        const parameterId = String(numericHandle(parameter));
        // The signature's instantiated parameter handles are authoritative, not
        // the parameter type text attached to a declaration or overload template.
        const parameterType = client.getTypeOfSymbol(snapshot!, project.id, parameterId);
        const symbol = parameterSymbols[position]!;
        if (String(numericHandle(symbol.id)) !== parameterId || typeof symbol.name !== "string") throw new Error("missing native signature parameter symbol");
        return { name: symbol.name, type: typeFact(parameterType) };
      });
      return { id, declaration: { fileName: index.fileName, span: node.span }, parameters, returnType: typeFact(rpc.returnType(id)) };
    };
    const matchingSource = (file: string, text: string): OxcSource => {
      const index = sourceIndex(file);
      if (text !== index.text) throw new Error(`${file}: source does not match the Corsa snapshot`);
      let source = syntaxSources.get(index.path);
      if (!source) { source = parseOxcSource(file, text); syntaxSources.set(index.path, source); }
      return source;
    };
    const location = (file: string, span: { start: number; end: number }, text: string, mode: "call" | "declaration" | "expression"): string | null => {
      const index = sourceIndex(file);
      if (text !== index.text) throw new Error(`${file}: source does not match the Corsa snapshot`);
      if (!Number.isSafeInteger(span.start) || !Number.isSafeInteger(span.end) || span.start < 0 || span.end <= span.start || span.end > text.length) throw new Error("invalid callable source range");
      const source = matchingSource(file, text);
      let kind: number | undefined;
      const visit = (node: Node): void => {
        if (node.start > span.start || node.end < span.end) return;
        if (mode === "expression") {
          if (node.start === span.start && node.end === span.end) kind ??= nativeExpressionKind(node);
          for (const child of oxcChildren(node)) visit(child);
          return;
        }
        const candidate = node.type === "ExportNamedDeclaration" || node.type === "ExportDefaultDeclaration" ? node.declaration : node;
        if (node.start === span.start && node.end === span.end && candidate && candidate.type in nativeCallableKinds) {
          const call = candidate.type === "CallExpression" || candidate.type === "NewExpression";
          if (call === (mode === "call")) kind = nativeCallableKinds[candidate.type as keyof typeof nativeCallableKinds];
        }
        for (const child of oxcChildren(node)) visit(child);
      };
      visit(source.program);
      if (kind === undefined) return null;
      const node = index.find(kind, span);
      if (!node) throw new Error(`${file}: Oxc range does not match a native ${mode} node`);
      return node.handle;
    };
    return {
      compilerRevision: `corsa-api@${version()}`, compilerExecutable, rootFiles: Object.freeze([...project.rootFiles]),
      getResolvedSignature(file, span, text) {
        const handle = location(file, span, text, "call");
        return handle ? signatureFact(rpc.resolve(handle)) : null;
      },
      getSignatureFromDeclaration(file, span, text) {
        const handle = location(file, span, text, "declaration");
        return handle ? signatureFact(rpc.declaration(handle)) : null;
      },
      getSignaturesOfTypeAtPosition(file, position, kind = "call") {
        const index = sourceIndex(file);
        if (!Number.isSafeInteger(position) || position < 0 || position >= index.text.length) throw new Error("invalid callable source position");
        const type = client.getTypeAtPosition(snapshot!, project.id, index.path, position);
        if (!type) return [];
        const result = rpc.overloads(type.id, kind === "call" ? 0 : 1);
        if (!Array.isArray(result)) throw new Error("invalid native overload response");
        return result.flatMap(value => { const signature = signatureFact(value); return signature ? [signature] : []; });
      },
      getExpressionType(file, span, text) {
        const handle = location(file, span, text, "expression");
        if (!handle) return null;
        const result = rpc.expressionType(handle);
        return result === null ? null : typeFact(result);
      },
      isNeverType(type) {
        const id = numericHandle(ownedTypeId(type));
        intrinsicNever ??= numericHandle(record(rpc.neverType()).id);
        return id === intrinsicNever;
      },
      getBooleanLiteralValue(type) {
        ownedTypeId(type);
        return booleanLiterals.get(type);
      },
      assertSource(file, text) {
        if (sourceIndex(file).text !== text) throw new Error(`${file}: source does not match the Corsa snapshot`);
      },
      getSymbolAtPosition(file, position) {
        const index = sourceIndex(file);
        if (!Number.isSafeInteger(position) || position < 0 || position >= index.text.length) throw new Error("invalid symbol source position");
        return symbolFact(client.getSymbolAtPosition(snapshot!, project.id, index.path, position));
      },
      getAliasedSymbol(symbol) {
        assertOpen();
        const owned = ownedSymbols.get(symbol);
        if (!owned) throw new Error("symbol fact must come from this owning snapshot");
        return (owned.flags & 2_097_152) === 0 ? null : symbolFact(client.getAliasedSymbol(snapshot!, project.id, owned.id));
      },
      getTypeAliasSymbol(type) { return symbolFact(rpc.typeAlias(ownedTypeId(type))); },
      isTypeAssignableTo(source, target) {
        const sourceId = ownedTypeId(source), targetId = ownedTypeId(target);
        const result = client.isTypeAssignableTo(snapshot!, project.id, sourceId, targetId);
        if (typeof result !== "boolean") throw new Error("invalid native assignability response");
        return result;
      },
      getShorthandAssignmentValueSymbol(file, span, text) {
        const index = sourceIndex(file);
        if (text !== index.text) throw new Error(`${file}: source does not match the Corsa snapshot`);
        const source = matchingSource(file, text);
        let matched = false;
        const visit = (node: Node): void => {
          if (node.start > span.start || node.end < span.end) return;
          if (node.type === "Property" && node.shorthand && node.value.type === "Identifier" && node.start === span.start && node.end === span.end) matched = true;
          for (const child of oxcChildren(node)) visit(child);
        };
        visit(source.program);
        if (!matched) return null;
        // Native 7.0.2 protocol-5 ShorthandPropertyAssignment kind.
        const node = index.find(304, span);
        if (!node) throw new Error(`${file}: Oxc range does not match a native shorthand property`);
        return symbolFact(rpc.shorthand(node.handle));
      },
      getPrimitiveTypeKind(type) {
        const id = ownedTypeId(type);
        intrinsicNumbers ??= { number: numericHandle(record(rpc.numberType()).id), boolean: numericHandle(record(rpc.booleanType()).id) };
        const base = numericHandle(record(rpc.literalBase(id)).id);
        return base === intrinsicNumbers.number ? "number" : base === intrinsicNumbers.boolean ? "boolean" : null;
      },
      getProjectDiagnostics() {
        assertOpen();
        if (record(project.compilerOptions).noCheck === true) throw new Error("noCheck prevents native project type checking");
        const message = (input: unknown): string => {
          const diagnostic = record(input);
          if (typeof diagnostic.text !== "string" || diagnostic.messageChain !== undefined && !Array.isArray(diagnostic.messageChain)) throw new Error("invalid native diagnostic message");
          return [diagnostic.text, ...((diagnostic.messageChain ?? []) as unknown[]).map(message)].join("\n");
        };
        return rpc.diagnostics().map(input => {
          const value = record(input);
          const category = ["warning", "error", "suggestion", "message"] as const;
          if (!Number.isInteger(value.code) || typeof value.category !== "number" || !Number.isInteger(value.category) || !category[value.category]) throw new Error("invalid native diagnostic category/code");
          if (value.fileName !== undefined && (typeof value.fileName !== "string" || !Number.isSafeInteger(value.pos) || !Number.isSafeInteger(value.end)
            || Number(value.pos) < 0 || Number(value.end) < Number(value.pos))) throw new Error("invalid native diagnostic location");
          return { category: category[value.category]!, code: value.code as number, message: message(value),
            ...(value.fileName ? { fileName: value.fileName as string, span: { start: value.pos as number, end: value.end as number } } : {}) };
        });
      },
      close,
    };
  } catch (error) { close(); throw error; }
}
