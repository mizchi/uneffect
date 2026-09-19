import { analyzeCorsaBuiltinCalls, type CorsaBuiltinCallsResult } from "./corsa-builtin-calls.js";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { builtinContractRegistry, findModuleInitializationContract, type BuiltinContract, type BuiltinContractRegistry } from "../../effects/builtin-contracts.js";
import { effectSchema, parseEffectExpression, type Effect } from "../../effects/capabilities.js";
import { openCorsaApiFrontend, type CorsaApiFrontend, type CorsaApiSymbolFact, type CorsaApiTypeFact } from "./corsa-api-frontend.js";
import type { EffectSummary, EvidenceStatus } from "../../effects/effects.js";
import type { BuiltinSemantics, SemanticPrimitive } from "../../effects/builtin-semantic-schema.js";
import { callingFunction, collectSyntaxFactsWithInternal, enclosingFunction, type SyntaxSite } from "../oxc-syntax.js";
import type { VerificationArtifact } from "../../contracts/verification-contracts.js";
import { hasNativeContractCandidates } from "../../contracts/contract-annotations.js";
import type { DiagnosticNote } from "../../support/diagnostic-contracts.js";
import { collectCorsaEffectBindings } from "./corsa-effect-calls.js";
import { propagateEffectNames } from "../../effects/effect-propagation.js";
import { analyzeCorsaSourceFacts, isAccessorSymbol } from "./corsa-source-facts.js";
import { loadDomInterfaceGraph, type DomInterfaceGraph } from "./dom-inheritance.js";
import { assumptionEntry, type AssumptionEntry, type AssumptionLedger } from "../../evidence/assumption-contracts.js";

export interface CorsaCheckOptions {
  includeBuiltinCalls?: boolean;
  configFile: string;
  corsaExecutable?: string;
  cwd?: string;
  requireAnnotations?: boolean;
  builtinRegistry?: BuiltinContractRegistry;
  fileNames?: readonly string[];
}

export interface CorsaCheckDiagnostic {
  domain: "syntax" | "contract" | "bounds";
  kind: "syntax" | "contract" | "unchecked-index";
  severity: "error" | "warning";
  fileName: string;
  line: number;
  functionName: string;
  message: string;
  notes?: DiagnosticNote[];
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
  corsaBuiltinCalls?: CorsaBuiltinCallsResult;
  diagnostics: CorsaCheckDiagnostic[];
  sources: Map<string, string>;
  artifacts: VerificationArtifact[];
  summaries: EffectSummary[];
  /**
   * Every admitted builtin contract is a reviewed claim about a body this run did not read, so each call site
   * that rests on one is recorded here rather than disappearing into the summary that used it.
   */
  assumptions: AssumptionLedger;
  typedArrays: { obligations: []; diagnostics: []; windows: []; statistics: { solverQueries: 0 }; files: Record<string, never> };
  ownership: [];
  asyncIterators: [];
  resourceProtocols: [];
  errors: number;
  warnings: number;
  project: CorsaProjectProvenance;
}

/**
 * The error constructors the reviewed catalog carries. A throw is named only from one of these, resolved at its
 * construction: the effect language compares `Throw<E>` by text, so naming a user class would let one that
 * shadows a standard constructor satisfy a declaration written against the standard one, and there is no
 * subtype lattice that could tell them apart.
 */
/** The package a specifier names, so a deep import is reviewed against the package that runs, not the file. */
function packageName(specifier: string): string {
  return specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0]!;
}

/**
 * The runtime a reviewed module-initialization contract has to match. A `node:` builtin is answered by the
 * running Node; a package is answered by the manifest that resolves from the importing file, so a project that
 * installed a different version does not inherit another one's review.
 */
function moduleRuntime(fromFile: string, specifier: string): { nodeMajor?: number; packageVersion?: string } {
  if (specifier.startsWith("node:")) return { nodeMajor: Number.parseInt(process.versions.node, 10) };
  try {
    const manifest = createRequire(fromFile).resolve(`${packageName(specifier)}/package.json`);
    const version = (JSON.parse(readFileSync(manifest, "utf8")) as { version?: unknown }).version;
    return typeof version === "string" ? { packageVersion: version } : {};
  } catch { return {}; }
}

/** Marks a boundary whose effects rest on a reviewed contract, so the ladder can tell that from inference. */
const contractToken = "\u0000contract";

const reviewedErrorConstructors = new Set([
  "Error", "EvalError", "RangeError", "ReferenceError", "SyntaxError", "TypeError", "URIError",
]);

function declaredByDomLibrary(symbol: CorsaApiSymbolFact | null | undefined): symbol is CorsaApiSymbolFact {
  return symbol !== null && symbol !== undefined
    && (symbol.declarations ?? []).some((item) => /(?:^|[/\\])lib\.dom\.d\.ts$/.test(item));
}

function declaredByEcmaScriptLibrary(symbol: CorsaApiSymbolFact | null | undefined): boolean {
  return (symbol?.declarations ?? []).some((item) => /(?:^|[/\\])lib\.es[\w.]*\.d\.ts$/i.test(item));
}

/** Effect terms are carried as their canonical text, so `Throw<E>` survives propagation and formatting. */
function capabilityEffect(name: string): Effect {
  try {
    return parseEffectExpression(name);
  } catch {
    const schema = effectSchema(name);
    return { kind: "capability", name, arguments: (schema?.arguments ?? []).map(() => ({ kind: "all" })) };
  }
}

/**
 * A call whose target is fixed by a class declaration rather than by a binding: constructing a class, calling
 * a base through `super`, or dispatching on `this`. Each is resolved once every file has been read, because
 * the declaration may live in another module.
 */
type PendingClassCall = { readonly args: CallArgumentFacts | undefined; readonly label: string } & (
  | { readonly kind: "construct"; readonly classSymbolId: string }
  | { readonly kind: "super"; readonly classSymbolId: string }
  | { readonly kind: "private-method"; readonly declaration: string }
);

/** What one call supplies at each argument position, as far as this path can see it. */
interface CallArgumentFacts {
  readonly fileName: string;
  /** Function-fact key of an argument written inline as a function, or `null`. */
  readonly inline: readonly (string | null)[];
  /** Start offset of an argument written as a plain identifier, or `null`. */
  readonly identifierPositions: readonly (number | null)[];
}

interface RenderedSemantics {
  readonly names: string[];
  /** A primitive this path models neither as an effect nor as a composed callee; the site stays unknown. */
  unrenderable: boolean;
  /** Argument indices the contract invokes as user code. */
  readonly callbackArguments: number[];
  /** The contract invokes the value assigned to this member, such as an event handler property. */
  callbackAssignedValue: boolean;
}

/**
 * Render a reviewed contract into the terms this path can carry. A primitive it can neither render nor compose
 * makes the site unknown rather than an empty proof; `result` and `protocol` are refinement and temporal facts
 * that no capability claim here depends on.
 */
function renderSemantics(
  semantics: BuiltinSemantics | undefined,
  siteKind: SyntaxSite["kind"],
  access: "read" | "write" = "read",
  argumentCount?: number,
): RenderedSemantics {
  const rendered: RenderedSemantics = { names: [], unrenderable: false, callbackArguments: [], callbackAssignedValue: false };
  if (!semantics) return rendered;
  const visit = (primitive: SemanticPrimitive, nested: boolean): void => {
    switch (primitive.kind) {
      case "effect": rendered.names.push(primitive.capability); return;
      case "throw": rendered.names.push(`Throw<${primitive.error}>`); return;
      case "invoke-user-code": rendered.names.push("InvokeUserCode"); return;
      // A value the call does not receive is neither cloned nor transferred; an unknown arity is conservative.
      case "clone": case "transfer": {
        if (suppliedArgument(primitive.target, argumentCount)) rendered.names.push(primitive.kind === "clone" ? "Clone" : "Transfer");
        return;
      }
      // `result` and `protocol` are refinement and temporal facts, and `mutate` records which value a call
      // writes through; the ownership analysis reads that, and no capability claim here depends on it.
      case "result": case "protocol": case "mutate": return;
      case "callback": {
        if (primitive.target.kind === "argument") rendered.callbackArguments.push(primitive.target.index);
        else if (primitive.target.kind === "assigned-value") rendered.callbackAssignedValue = true;
        else rendered.unrenderable = true;
        return;
      }
      case "property": {
        if (siteKind !== "property" || nested) return;
        // A reviewed property contract carries separate read and write semantics; an assignment selects the write side.
        for (const item of access === "write" ? primitive.write : primitive.read) visit(item, true);
        return;
      }
      default: rendered.unrenderable = true;
    }
  };
  // Reading a member performs only what its property contract describes; the semantics of calling it are the
  // call site's, so a reference such as `Math.random` carries none of them.
  for (const primitive of semantics.primitives) {
    if (siteKind === "property" && primitive.kind !== "property") continue;
    visit(primitive, false);
  }
  return rendered;
}

/** Whether the argument a projector reads was actually passed, when the call's arity is known. */
function suppliedArgument(target: { kind: string; index?: number; target?: unknown }, argumentCount: number | undefined): boolean {
  if (argumentCount === undefined) return true;
  const projector = target.kind === "property" && typeof target.target === "object" && target.target !== null
    ? target.target as { kind: string; index?: number }
    : target;
  return projector.kind !== "argument" || typeof projector.index !== "number" || projector.index < argumentCount;
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

/**
 * A reviewed contract is selected only when the receiver's own type names it. A member declared on a base
 * interface (`Node#ownerDocument` reached through an `HTMLElement` receiver) is therefore not selected: matching
 * on the member name alone would attach an unrelated contract, because a name such as `length` is reviewed for
 * exactly one interface and carried by many others. Selecting by the member's declaring interface needs a
 * declared-type query the Corsa boundary does not expose yet; until then a derived receiver is an explicit
 * unknown rather than a wrong capability.
 */
/**
 * The checker queries this file needs, memoized per file. Contract selection, the fail-closed member check, and
 * the unknown reason all ask about the same receiver position, so without this each site pays for the same
 * answer several times; the compiler's cost per query grows with file size.
 */
export type CorsaCheckQueries = Pick<CorsaApiFrontend, "getTypeAtPosition" | "getTypeAtRange" | "getSymbolOfType" | "getPropertyOfType" | "getSymbolAtPosition">;

function memoizeQueries(frontend: CorsaApiFrontend, fileName: string): CorsaCheckQueries {
  const types = new Map<number, CorsaApiTypeFact | null>();
  const typeSymbols = new Map<string, CorsaApiSymbolFact | null>();
  const properties = new Map<string, CorsaApiSymbolFact | null>();
  const positionSymbols = new Map<number, CorsaApiSymbolFact | null>();
  const ranges = new Map<string, CorsaApiTypeFact | null>();
  const remember = <K, V>(cache: Map<K, V>, key: K, compute: () => V): V => {
    if (cache.has(key)) return cache.get(key)!;
    const value = compute();
    cache.set(key, value);
    return value;
  };
  return {
    getTypeAtPosition: (file, position) => file !== fileName
      ? frontend.getTypeAtPosition(file, position)
      : remember(types, position, () => frontend.getTypeAtPosition(file, position)),
    getTypeAtRange: (file, span, nativeKind) => file !== fileName
      ? frontend.getTypeAtRange(file, span, nativeKind)
      : remember(ranges, `${span.start}:${span.end}:${nativeKind}`, () => frontend.getTypeAtRange(file, span, nativeKind)),
    getSymbolOfType: (type) => remember(typeSymbols, type.id, () => frontend.getSymbolOfType(type)),
    getPropertyOfType: (type, name) => remember(properties, `${type.id}#${name}`, () => frontend.getPropertyOfType(type, name)),
    getSymbolAtPosition: (file, position) => file !== fileName
      ? frontend.getSymbolAtPosition(file, position)
      : remember(positionSymbols, position, () => frontend.getSymbolAtPosition(file, position)),
  };
}

function resolveDomContract(
  corsa: CorsaCheckQueries,
  receiverType: CorsaApiTypeFact | null,
  site: SyntaxSite,
  domMethods: Map<string, BuiltinContract>,
  graph: DomInterfaceGraph,
): BuiltinContract | undefined {
  if (!receiverType || !corsa.getSymbolOfType || !corsa.getPropertyOfType) return undefined;
  const owner = corsa.getSymbolOfType(receiverType);
  if (!declaredByDomLibrary(owner)) return undefined;
  const member = corsa.getPropertyOfType(receiverType, site.name);
  if (declaredByDomLibrary(member)) return domContractFor(domMethods, graph, owner.name, member.name);
  // A name no declared property carries is reached through the interface's own index signature — a `data-*`
  // attribute of a `DOMStringMap`, a token of a `DOMTokenList` — so only a whole-surface contract can answer.
  return member === null ? domSurfaceFor(domMethods, graph, owner.name) : undefined;
}

/**
 * The reviewed contract for a member the checker resolved on a standard DOM receiver. The member is keyed by
 * the interface that declares it, so a receiver that inherits it is matched through the library's own
 * inheritance, nearest interface first. A member name alone never selects a contract: the receiver must be a
 * DOM interface that actually reaches the declaring one.
 */
function domContractFor(
  domMethods: Map<string, BuiltinContract>,
  graph: DomInterfaceGraph,
  ownerName: string,
  memberName: string,
): BuiltinContract | undefined {
  for (const name of [ownerName, ...graph.ancestors(ownerName)]) {
    const named = domMethods.get(`${name}#${memberName}`);
    if (named) return named;
  }
  // A member-specific contract on any interface of the chain always wins over a whole-surface one.
  return domSurfaceFor(domMethods, graph, ownerName);
}

/**
 * The reviewed contract for an interface every member of which performs the same operation, published under the
 * key `Owner#*`. It is consulted only after every member-specific key on the chain has missed.
 */
function domSurfaceFor(
  domMethods: Map<string, BuiltinContract>,
  graph: DomInterfaceGraph,
  ownerName: string,
): BuiltinContract | undefined {
  for (const name of [ownerName, ...graph.ancestors(ownerName)]) {
    const surface = domMethods.get(`${name}#*`);
    if (surface) return surface;
  }
  return undefined;
}

/**
 * The ECMAScript counterpart of `resolveDomContract`. Both the receiver's type symbol and the member must be
 * declared by the standard library, so a same-named user method never selects a builtin contract. Dotted
 * globals such as `Math.random` are published under the `global` module and are consulted with their own key.
 */
/**
 * The catalog registers no member of `ReadonlyArray`, `ReadonlyMap` or `ReadonlySet`, because those name no
 * ECMA-262 object and any declaration whose members match inhabits one. A receiver written as an array
 * literal is the narrower, syntactic admission: the expression allocates a genuine Array, so the `Array#`
 * contract describes the body that runs however the checker names the type — including the readonly tuple
 * `as const` produces, which carries no type symbol of its own to name an owner with.
 */
function resolveEcmaScriptContract(
  corsa: CorsaCheckQueries,
  receiverType: CorsaApiTypeFact | null,
  site: SyntaxSite,
  members: Map<string, BuiltinContract>,
  globals: Map<string, BuiltinContract>,
  arrayLiteralReceivers: ReadonlySet<number>,
  singleStringLiteralCallStarts: ReadonlySet<number>,
): BuiltinContract | undefined {
  // The literal's own members are the ones the catalog registers, so this needs no type at the receiver —
  // which an `as const` literal does not carry an owner symbol for anyway. This narrows on the literal
  // written at the site only: unlike the TypeScript path, this one has no cross-file symbol resolution to
  // follow a `const` binding back to its initializer with, so a named literal stays unknown here.
  if (arrayLiteralReceivers.has(site.calleePosition)) return members.get(`Array#${site.name}`);
  // The receiver's type is read from its own RANGE by the caller, not from a position: a position query
  // resolves the innermost token, which for a computed member is the key rather than the receiver.
  if (!receiverType || !corsa.getSymbolOfType || !corsa.getPropertyOfType) return undefined;
  const owner = corsa.getSymbolOfType(receiverType);
  const member = corsa.getPropertyOfType(receiverType, site.name);
  if (!declaredByEcmaScriptLibrary(member)) return undefined;
  const ownerName = declaredByEcmaScriptLibrary(owner) ? owner!.name : primitiveOwnerName(receiverType);
  if (ownerName === undefined) return undefined;
  if (ownerName === "String" && site.name === "split"
    && (!singleStringLiteralCallStarts.has(site.start) || primitiveOwnerName(receiverType) !== "String")) return undefined;
  return members.get(`${ownerName}#${member!.name}`) ?? globals.get(`${ownerName}.${member!.name}`);
}

/**
 * A primitive type has no type symbol, so its standard wrapper interface is derived from the compiler's own
 * type flags rather than from the type's display text. The flag values are pinned in `corsa-source-facts.test.ts`.
 */
function primitiveOwnerName(type: { flags?: number }): string | undefined {
  const flags = type.flags;
  if (typeof flags !== "number") return undefined;
  if ((flags & (32 | 1024)) !== 0) return "String";
  if ((flags & (64 | 2048)) !== 0) return "Number";
  if ((flags & 128) !== 0) return "BigInt";
  return undefined;
}

function resolveConstructContract(
  corsa: CorsaCheckQueries,
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
  const ecmaScriptMembers = new Map(
    registry.contracts.filter((contract) => contract.symbol.module === "lib.es" && contract.symbol.export.includes("#"))
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
    // The standard library the checker loaded ships beside the compiler executable, so the inheritance this
    // reads is the one the resolved members were declared in.
    const domGraph = loadDomInterfaceGraph(join(dirname(frontend.compilerExecutable), "lib.dom.d.ts"));
    const requested = options.fileNames === undefined ? undefined : new Set(options.fileNames.map((file) => resolve(file)));

    const rootFiles = frontend.rootFiles.map((file) => resolve(file))
      .filter((file) => requested === undefined || requested.has(file))
      .filter((file) => /\.[cm]?tsx?$/u.test(file));
    if (rootFiles.length === 0) {
      throw new Error(`TypeScript project ${configFile} does not select any source files`);
    }
    const sources = new Map<string, string>();
    const diagnostics: CorsaCheckDiagnostic[] = [];
    const assumptions: AssumptionEntry[] = [];
    const declarations = new Map<string, { key: string; name: string } | null>();
    const writes = new Set<string>();
    const ambiguousWrites = new Set<string>();
    const byFunction = new Map<string, {
      functionName: string;
      fileName: string;
      span: { start: number; end: number };
      parameters: string[];
      names: string[];
      unclassified: boolean;
      /** Distinct source spellings of the calls that left this function unclassified, for an actionable reason. */
      unresolved: Set<string>;
      /** Callee symbol identity to its source spelling, resolved against the analyzed bodies after every file is read. */
      deferred: Map<string, string>;
      calleeSymbols: Set<string>;
      /** Function-fact keys called directly at a syntactic boundary, such as an immediately invoked inline function. */
      directCallees: Set<string>;
      /** Callee symbols already accounted for, so the deferred link pass does not report them as unresolved. */
      resolvedSymbols: Set<string>;
      /** This body invokes a value one of its own parameters carries. */
      invokesUserCode: boolean;
      /** Named reasons a module could not account for what importing it evaluates. */
      moduleReasons: Array<{ code: "unknown-dependency" | "unreviewed-external-module"; message: string }>;
      /** Calls to a resolvable binding with the argument shape each supplies, for invoked-parameter obligations. */
      argumentCalls: Array<{ symbol: string; args: CallArgumentFacts | undefined }>;
      /** Constructions and in-class dispatch, resolved once every file has contributed its class declarations. */
      classCalls: PendingClassCall[];
      /** Resolved call targets with the arguments each supplied, for discharging invoked-parameter obligations. */
      discharges: Array<{ targets: readonly string[]; args: CallArgumentFacts | undefined; label: string }>;
      /**
       * Boundaries composed as a value rather than called here: a contract's callback argument, a handler
       * assigned to a property, and an argument that discharges an invoked-parameter obligation. Whoever calls
       * them supplies their arguments elsewhere, so one that owes an obligation of its own cannot be composed.
       */
      composedValues: Array<{ key: string; label: string }>;
    }>();
    type Boundary = NonNullable<ReturnType<typeof byFunction.get>>;
    /**
     * A static import or export-from and where it leads. `target` is the analyzed file it evaluates, and
     * `followable` says whether the specifier named a TypeScript implementation at all — a package and a
     * declaration file are different absences and the reader is told which.
     */
    const moduleEdges: Array<{ importer: Boundary; fromFile: string; specifier: string; target: string | undefined; followable: boolean }> = [];
    /** Parameter symbol identity to the boundary that receives it and the argument position that supplies it. */
    const parameterOwners = new Map<string, { ownerKey: string; index: number }>();
    const classes = new Map<string, {
      superSymbolId: string | null;
      superResolvable: boolean;
      constructorKey: string | null;
      /** The class body runs something of its own at construction: a declared constructor or an initializer. */
      runsOwnBody: boolean;
      declaresConstructor: boolean;
      linkable: boolean;
    }>();
    /** Checker declaration identity of a class method to the boundary that holds its body. */
    const methodBodies = new Map<string, string>();
    /** Class identity to the methods it declares, by name, so a base or a subclass can be consulted. */
    /**
     * Declarations of `#`-private methods. A `#` name is not a property: no subclass can redeclare it, no code
     * outside the class body can write it, and neither `Object.assign`, `Object.defineProperty` nor `delete`
     * reaches it. It is the one member shape whose body is fixed without reasoning about the whole program.
     */
    const privateMethods = new Set<string>();
    /** Parameter names a shorthand pattern may have written, which the position query cannot attribute. */
    const parameterNames = new Map<string, string>();
    for (const fileName of rootFiles) {
      const sourceText = readFileSync(fileName, "utf8");
      sources.set(fileName, sourceText);
      const queries = memoizeQueries(frontend, fileName);
      const { syntax, singleStringLiteralCallStarts } = collectSyntaxFactsWithInternal(fileName, sourceText);
      const bindings = collectCorsaEffectBindings(frontend, fileName, sourceText);
      for (const binding of bindings.declarations) {
        const key = `${fileName}:${binding.start}:${binding.name}`;
        declarations.set(binding.symbolId, declarations.has(binding.symbolId) ? null : { key, name: binding.name });
      }
      for (const symbol of bindings.writes) writes.add(symbol);
      for (const name of bindings.ambiguousWrites) ambiguousWrites.add(name);
      for (const message of syntax.errors) {
        diagnostics.push({
          domain: "syntax", kind: "syntax", severity: "error", fileName, line: 1,
          functionName: "<syntax>", message,
        });
      }
      const indexAccess = analyzeCorsaSourceFacts(queries, fileName, sourceText, syntax.functions, {
        domContractKeys: new Set(domMethods.keys()),
        selectsDomContractKey: (ownerName, memberName) => domContractFor(domMethods, domGraph, ownerName, memberName) !== undefined,
      });
      const admittedComputedCalls: Array<{ start: number }> = [];
      const unknownComputedMembers: Array<{ start: number }> = [];
      const excludedSites: Array<{ start: number }> = [];
      /**
       * The boundary that runs a site. Module-scope code runs when the module is evaluated, so a site with no
       * enclosing function belongs to the module rather than to nothing at all: dropping it left every function
       * in the file looking complete while the work the module itself performs went unrecorded.
       *
       * The boundary is built here rather than published as a syntax fact. `enclosingFunction` answers with the
       * smallest enclosing entry, so a whole-file entry would also start answering the lookups that are
       * deliberately restricted to a real function — a parameter's owner, a class method's body, and the caller
       * of an immediately invoked function.
       */
      type Boundary = { name: string; start: number; end: number; parameters: readonly string[] };
      const moduleBoundary: Boundary = { name: "<module>", start: 0, end: sourceText.length, parameters: [] };
      /**
       * A class body evaluates its static blocks, static field initializers, decorators and computed keys when
       * the DECLARATION is evaluated, not when an instance is constructed. A sibling instance initializer
       * widens the construction boundary over the whole body, so `enclosingFunction` answers with the
       * constructor for those spans — which both hides the work from the scope that really performs it and
       * charges every `new C()` for something it does not do.
       *
       * `witness` supplies the enclosing boundary when the caller already resolved it by another rule, which
       * the immediately invoked call below does.
       */
      const declaringScope = (position: number, witness?: { start: number; end: number }, given = false): Boundary | undefined => {
        const inner = given ? witness : enclosingFunction(syntax.functions, position);
        for (const item of bindings.staticInitializers) {
          // A class is declared before anything its own body evaluates, so this also bounds the recursion below.
          if (item.declaration >= position) continue;
          for (const region of item.regions) {
            if (position < region.start || position >= region.end) continue;
            // Creating a function at declaration time is not calling it. Only the widened construction boundary
            // covers the whole class body and therefore STRICTLY contains the region, so only it is the one to
            // correct: an arrow stored in a static field, a class expression written inside the region, or a
            // callback in a static block is merely built there and keeps its own body. Skipping to the next
            // region rather than abandoning the search is what lets a class nested in another class's region
            // still find its own entry.
            if (inner !== undefined && !(inner.start <= region.start && region.end <= inner.end
              && (inner.start < region.start || region.end < inner.end))) continue;
            // The declaration may itself sit inside another class's definition-time region, so it is resolved by
            // the same rule rather than by span alone.
            return owningBoundary(item.declaration);
          }
        }
        return undefined;
      };
      const owningBoundary = (position: number): Boundary =>
        declaringScope(position) ?? enclosingFunction(syntax.functions, position) ?? moduleBoundary;
      for (const entry of syntax.coverage) for (const exclusion of entry.exclusions) {
        const spanKey = `${exclusion.span.start}:${exclusion.span.end}`;
        // A dynamic key on a checker-resolved non-DOM receiver is an ordinary read/write, not missing coverage.
        if (exclusion.reason === "computed-property" && indexAccess.admittedComputedProperties.has(spanKey)) continue;
        // Calling a dynamic member of such a receiver is a call to an unknown callee, recorded below as unknown evidence.
        if ((exclusion.reason === "computed-call-target" || exclusion.reason === "computed-construct-target") && indexAccess.admittedComputedCalls.has(spanKey)) {
          admittedComputedCalls.push({ start: exclusion.span.start });
          continue;
        }
        // A literal-typed constant key on a DOM receiver is processed as the equivalent static-name site.
        if (indexAccess.constantKeyExclusions.has(spanKey)) continue;
        // A key that names an accessor is ordinary syntax reaching a body this path does not analyze.
        if (indexAccess.accessorComputedMembers.has(spanKey)) {
          unknownComputedMembers.push({ start: exclusion.span.start });
          continue;
        }
        // Named by the same rule that decides which summary carries the exclusion, so a reader chasing the
        // diagnostic is not sent to a boundary the report certifies as clean.
        const owner = owningBoundary(exclusion.span.start);
        const line = sourceText.slice(0, exclusion.span.start).split("\n").length;
        // An exclusion is a construct this path could not see. A diagnostic reports it, but the summary must
        // carry it too: a callee it never recorded reaches no site, so the boundary that contains it would
        // otherwise stay a proof of effect freedom while the construct runs.
        excludedSites.push({ start: exclusion.span.start });
        diagnostics.push({
          domain: "syntax", kind: "syntax", severity: "error", fileName, line,
          functionName: owner.name,
          message: `unsupported ${entry.domain} syntax (${exclusion.reason}); Corsa effect inference is incomplete for this source`,
        });
      }
      for (const finding of indexAccess.diagnostics) {
        diagnostics.push({
          domain: "bounds", kind: "unchecked-index", severity: "error", fileName, line: finding.line,
          functionName: finding.functionName, message: finding.message, notes: finding.notes,
        });
      }
      const argumentFactsAt = (site: SyntaxSite): CallArgumentFacts | undefined => {
        const key = `${site.start}:${site.end}`;
        const inlineStarts = indexAccess.inlineFunctionArguments.get(key);
        // A spread hides which position an obligation names, so the call supplies no usable argument shape.
        if (inlineStarts === undefined) return undefined;
        const identifiers = indexAccess.callArgumentIdentifiers.get(key) ?? [];
        return {
          fileName,
          inline: inlineStarts.map((start) => {
            if (start === null) return null;
            const callee = syntax.functions.find((item) => item.start === start);
            return callee ? `${fileName}:${callee.start}:${callee.name}` : null;
          }),
          identifierPositions: inlineStarts.map((_, index) => identifiers[index] ?? null),
        };
      };
      const sites = [...syntax.sites, ...indexAccess.constantKeySites];
      const callSites = sites.filter((site) => site.kind === "call");
      const classified = frontend.classifyBuiltinCalls(fileName, callSites.map((site) => ({
        calleePosition: site.calleePosition,
        ...(site.receiverPosition === undefined ? {} : { receiverPosition: site.receiverPosition }),
      })));
      const byFunctionKey = (fact: { start: number; name: string }): string => `${fileName}:${fact.start}:${fact.name}`;
      for (const parameter of bindings.parameters) {
        const owner = enclosingFunction(syntax.functions, parameter.position);
        if (owner) {
          parameterOwners.set(parameter.symbolId, { ownerKey: byFunctionKey(owner), index: parameter.index });
          parameterNames.set(parameter.symbolId, parameter.name);
        }
      }
      for (const item of bindings.classes) {
        // The syntax pass and this one locate the same boundary through one rule, by its exact span: a class
        // that runs an instance initializer widens the constructor over its whole body, and a class that runs
        // nothing of its own has no span at all.
        const span = item.constructionSpan;
        const fact = span === null ? undefined
          : syntax.functions.find((entry) => entry.start === span.start && entry.end === span.end);
        classes.set(item.symbolId, {
          superSymbolId: item.superSymbolId,
          superResolvable: item.superResolvable,
          constructorKey: fact ? byFunctionKey(fact) : null,
          runsOwnBody: span !== null,
          declaresConstructor: item.declaresConstructor,
          linkable: item.linkable,
        });
      }
      for (const method of bindings.methods) {
        const boundary = enclosingFunction(syntax.functions, method.position);
        if (!boundary) continue;
        if (!method.hardPrivate) continue;
        methodBodies.set(method.declaration, byFunctionKey(boundary));
        privateMethods.add(method.declaration);
      }
      const ensure = (owner: { name: string; start: number; end: number; parameters: readonly string[] }) => {
        const key = `${fileName}:${owner.start}:${owner.name}`;
        const current = byFunction.get(key) ?? {
          functionName: owner.name, fileName, span: { start: owner.start, end: owner.end },
          parameters: [...owner.parameters], names: [], unclassified: false, unresolved: new Set<string>(), deferred: new Map<string, string>(),
          calleeSymbols: new Set<string>(), directCallees: new Set<string>(), resolvedSymbols: new Set<string>(),
          invokesUserCode: false, moduleReasons: [], argumentCalls: [], classCalls: [], discharges: [], composedValues: [],
        };
        byFunction.set(key, current);
        return current;
      };
      for (const call of [...admittedComputedCalls, ...unknownComputedMembers, ...excludedSites]) {
        ensure(owningBoundary(call.start)).unclassified = true;
      }
      // The sites inside those regions are attributed above, so the declaring scope carries the work itself
      // rather than an unresolved marker standing in for it. A decorator is the exception: applying one invokes
      // it, that invocation is spelled nowhere, and partial modelling of a class body would otherwise let the
      // declaring scope reach `trusted` while the decorator's own work stayed invisible.
      for (const declaration of bindings.decoratedDeclarations) {
        ensure(owningBoundary(declaration)).unclassified = true;
      }
      // A `throw` the enclosing boundary cannot catch is an effect of that boundary. Naming it is a separate
      // question from seeing it: an operand the reviewed catalog did not resolve is `Throw<unknown>`, which the
      // effect language deliberately leaves uncovered by a declared `Throw<Error>`.
      for (const item of indexAccess.throws) {
        const symbol = item.calleePosition === null ? null : queries.getSymbolAtPosition(fileName, item.calleePosition);
        const named = declaredByEcmaScriptLibrary(symbol) && reviewedErrorConstructors.has(symbol!.name);
        ensure(owningBoundary(item.start)).names.push(`Throw<${named ? symbol!.name : "unknown"}>`);
      }
      // Importing a module runs it. An importer therefore has a boundary of its own even when it evaluates
      // nothing else, because the answer for it is either the dependency's own effects or an explicit absence.
      for (const dependency of indexAccess.dependencies) {
        const symbol = queries.getSymbolAtPosition(fileName, dependency.position);
        const declarations = symbol?.declarations ?? [];
        const implementations = rootFiles.filter((file) => !/\.d\.[cm]?ts$/u.test(file)
          && declarations.some((item) => item.endsWith(file) || item.toLowerCase().endsWith(file.toLowerCase())));
        // A declaration file declares what another artifact runs, so following it proves nothing about the run.
        const followable = declarations.some((item) => /\.[cm]?tsx?$/u.test(item) && !/\.d\.[cm]?ts$/u.test(item));
        moduleEdges.push({
          importer: ensure(moduleBoundary), fromFile: fileName, specifier: dependency.specifier,
          target: implementations.length === 1 ? implementations[0] : undefined, followable,
        });
      }
      const record = (site: SyntaxSite, contract: BuiltinContract | undefined): void => {
        if (!contract) return;
        const owner = owningBoundary(site.start);
        assumptions.push(assumptionEntry({
          domain: "builtin",
          reason: contract.trustReason ?? "reviewed builtin semantic overlay",
          owner: contract.trustOwner ?? "@mizchi/uneffect",
          ...(contract.trustExpiresOn ? { expiresOn: contract.trustExpiresOn } : {}),
          ...(contract.runtime ? { dependency: {
            module: contract.symbol.module,
            ...(contract.runtime.kind === "package" ? { packageVersion: contract.runtime.version } : { nodeMajor: contract.runtime.major }),
          } } : {}),
          scope: { fileName, functionName: owner.name, span: { start: site.start, end: site.end } },
        }));
        const span = `${site.start}:${site.end}`;
        const readWrite = indexAccess.readWriteTargets.has(span);
        const access = readWrite || indexAccess.assignmentTargets.has(span) ? "write" as const : "read" as const;
        const args = indexAccess.inlineFunctionArguments.get(span);
        const rendered = renderSemantics(contract.semantics, site.kind, access, args?.length);
        const caller = ensure(owner);
        caller.names.push(...rendered.names);
        // `trusted` names an effect a reviewed contract supplied. An effect read out of the analyzed source is
        // not one, and a contract that supplies no effect leaves the boundary's own evidence unchanged.
        if (rendered.names.length > 0) caller.names.push(contractToken);
        // A compound assignment or an update reads the member before writing it.
        if (readWrite) caller.names.push(...renderSemantics(contract.semantics, site.kind, "read", args?.length).names);
        if (rendered.unrenderable) caller.unclassified = true;
        if (rendered.callbackAssignedValue) {
          const assigned = indexAccess.assignedInlineFunctions.get(span);
          const handler = assigned === undefined ? undefined : syntax.functions.find((item) => item.start === assigned);
          if (handler) {
            const key = `${fileName}:${handler.start}:${handler.name}`;
            caller.directCallees.add(key);
            caller.composedValues.push({ key, label: `the handler assigned to ${site.name}` });
          } else caller.unclassified = true;
        }
        for (const index of rendered.callbackArguments) {
          // An argument the call does not pass invokes nothing; only a passed one needs a boundary to compose with.
          if (args !== undefined && index >= args.length) continue;
          const inline = args?.[index];
          const callee = inline === undefined || inline === null ? undefined : syntax.functions.find((item) => item.start === inline);
          if (callee) {
            const key = `${fileName}:${callee.start}:${callee.name}`;
            caller.directCallees.add(key);
            caller.composedValues.push({ key, label: `the callback ${site.name} receives` });
          } else caller.unclassified = true;
        }
      };
      /**
       * How an unresolved callee is named in the unknown reason: its receiver type plus the member, when known.
       * Only a standard-library owner is named, by the same rule the resolver applies. The receiver position is
       * the last identifier token of the receiver, which for a call result or a computed member belongs to a
       * different expression, so a user symbol found there would name something this call never reaches.
       */
      const unresolvedLabel = (site: SyntaxSite, symbol: CorsaApiSymbolFact | null): string => {
        if (site.receiverPosition === undefined) return site.name;
        const receiverType = receiverTypeAt(site);
        // The member has to be declared on the type that was read, or the receiver that was typed is not the
        // one this call runs on: `Object.entries(v).map(...)` types `Object`, which declares no `map`.
        const member = receiverType ? queries.getPropertyOfType?.(receiverType, site.name) : null;
        if (!declaredByEcmaScriptLibrary(member) && !declaredByDomLibrary(member)) {
          return symbol ? site.name : `<unresolved>.${site.name}`;
        }
        const owner = queries.getSymbolOfType(receiverType!);
        const ownerName = declaredByEcmaScriptLibrary(owner) || declaredByDomLibrary(owner)
          ? owner!.name : primitiveOwnerName(receiverType!);
        return ownerName ? `${ownerName}#${site.name}` : (symbol ? site.name : `<unresolved>.${site.name}`);
      };

      /**
       * The receiver's own type. A receiver the last identifier token describes is typed at that token; every
       * other receiver was typed at its exact range by the source facts, because the token that begins it
       * belongs to a different expression.
       */
      const receiverTypeAt = (site: SyntaxSite): CorsaApiTypeFact | null => {
        if (site.receiverPosition === undefined) return null;
        return indexAccess.receiverTypes.get(`${site.start}:${site.end}`)
          ?? queries.getTypeAtPosition(fileName, site.receiverPosition);
      };

      /** A bare call or construction of a standard-library global, such as `structuredClone` or `new Map`. */
      const standardGlobalContract = (site: SyntaxSite): BuiltinContract | undefined => {
        const symbol = queries.getSymbolAtPosition(fileName, site.calleePosition);
        if (!declaredByEcmaScriptLibrary(symbol) && !declaredByDomLibrary(symbol)) return undefined;
        return globals.get(symbol!.name);
      };
      const memberSymbolAt = (site: SyntaxSite): CorsaApiSymbolFact | null => {
        const receiverType = receiverTypeAt(site);
        return receiverType ? queries.getPropertyOfType(receiverType, site.name) : null;
      };
      const recordClassCall = (site: SyntaxSite): boolean => {
        const pending = classCallAt(site);
        if (pending === undefined) return false;
        ensure(owningBoundary(site.start)).classCalls.push(pending);
        return true;
      };
      const recordUnclassified = (site: SyntaxSite): void => {
        const owner = owningBoundary(site.start);
        // A synthetic callee (`<dynamic>`) has no declaration position; it is unknown without symbol linking.
        if (site.name === "<dynamic>") { ensure(owner).unclassified = true; return; }
        const symbol = queries.getSymbolAtPosition(fileName, site.calleePosition);
        const caller = ensure(owner);
        const linkable = symbol !== null && site.kind === "call" && site.receiverPosition === undefined
          ? (frontend.getAliasedSymbol(symbol) ?? symbol).id : undefined;
        const frozenTarget = site.kind === "call" ? bindings.calls.get(site.calleePosition) : undefined;
        // A call whose callee symbol resolves is deferred: whether it is unknown depends on whether that
        // symbol reaches an analyzed body, which is only known once every root file has been read.
        if (linkable !== undefined) {
          caller.calleeSymbols.add(linkable);
          caller.argumentCalls.push({ symbol: linkable, args: argumentFactsAt(site) });
        }
        if (frozenTarget) {
          caller.calleeSymbols.add(frozenTarget);
          caller.argumentCalls.push({ symbol: frozenTarget, args: argumentFactsAt(site) });
        }
        if (linkable === undefined && frozenTarget === undefined) {
          caller.unclassified = true;
          caller.unresolved.add(unresolvedLabel(site, symbol));
        } else caller.deferred.set(linkable ?? frozenTarget!, unresolvedLabel(site, symbol));
      };
      /**
       * Whether this site dispatches through a class declaration. `this` is an instance of the class or of one
       * of its subclasses, and `super` names exactly the base the `extends` clause resolves to, so both reach a
       * declaration the checker fixed rather than a value a caller supplied.
       */
      const classCallAt = (site: SyntaxSite): PendingClassCall | undefined => {
        const label = site.receiverPosition === undefined ? site.name : `this.${site.name}`;
        const args = argumentFactsAt(site);
        if (site.kind === "construct" && site.receiverPosition === undefined) {
          const symbol = queries.getSymbolAtPosition(fileName, site.calleePosition);
          if (!symbol) return undefined;
          return { kind: "construct", classSymbolId: (frontend.getAliasedSymbol(symbol) ?? symbol).id, label: `new ${site.name}`, args };
        }
        if (site.kind !== "call") return undefined;
        const superCall = bindings.superCalls.get(site.start);
        if (superCall !== undefined && site.name === "super") return { kind: "super", classSymbolId: superCall, label: "super", args };
        // Only a `#` name is fixed by its declaration alone. Every other member — a public or TypeScript-private
        // method, one reached through `super.m()`, one reached through a receiver the caller supplies — can be
        // replaced by a subclass the run did not read or by a write the run cannot attribute, so it stays on the
        // ordinary unresolved path.
        // Keyed by the callee token, which is unique to this site: a call chained onto `this.#m()` shares the
        // call expression's start offset but reports its own callee.
        const privateCall = bindings.privateCalls.get(site.calleePosition);
        if (privateCall === undefined) return undefined;
        return { kind: "private-method", declaration: privateCall, label, args };
      };
      for (const [index, site] of callSites.entries()) {
        if (site.name === "<iife>" && site.receiverPosition === undefined) {
          // An unparenthesized IIFE starts where its callee starts, so the caller is the smallest
          // enclosing function that is not the callee itself. Failing to link falls back to unknown.
          const callee = syntax.functions.find((item) => item.start === site.calleePosition);
          // An IIFE written in a static block or a static field initializer runs when the declaration is
          // evaluated, so the declaring scope claims it here too; `callingFunction` is the witness.
          const enclosing = callingFunction(syntax.functions, site.start, callee);
          const owner = declaringScope(site.start, enclosing, true) ?? enclosing ?? moduleBoundary;
          const calleeKey = callee === undefined ? undefined : `${fileName}:${callee.start}:${callee.name}`;
          if (owner && calleeKey && byFunctionKey(owner) !== calleeKey) {
            const caller = ensure(owner);
            caller.directCallees.add(calleeKey);
            // The inline callee may invoke one of its own parameters, and this call is what supplies it.
            caller.discharges.push({ targets: [calleeKey], args: argumentFactsAt(site), label: "an immediately invoked function" });
          } else if (owner) ensure(owner).unclassified = true;
          continue;
        }
        if (site.name === "<dynamic>") { recordUnclassified(site); continue; }
        const resolution = classified[index];
        const exportName = resolution?.operation === "Fetch" ? "fetch"
          : resolution?.operation === "Console"
            ? `${resolution.receiver?.name ?? "console"}.${resolution.symbol.name}`
            : undefined;
        const classifiedContract = exportName === undefined ? undefined : globals.get(exportName);
        const contract = classifiedContract
          ?? (site.receiverPosition === undefined
            ? standardGlobalContract(site)
            : resolveDomContract(queries, receiverTypeAt(site), site, domMethods, domGraph)
              ?? resolveEcmaScriptContract(queries, receiverTypeAt(site), site, ecmaScriptMembers, globals, indexAccess.arrayLiteralReceivers, singleStringLiteralCallStarts));
        if (contract) record(site, contract);
        else if (!recordClassCall(site)) recordUnclassified(site);
      }
      for (const site of sites) {
        if (site.kind === "construct") {
          const contract = resolveConstructContract(queries, fileName, site, globals) ?? standardGlobalContract(site);
          if (contract) record(site, contract);
          else if (!recordClassCall(site)) recordUnclassified(site);
        } else if (site.kind === "property") {
          const contract = resolveDomContract(queries, receiverTypeAt(site), site, domMethods, domGraph)
            ?? resolveEcmaScriptContract(queries, receiverTypeAt(site), site, ecmaScriptMembers, globals, indexAccess.arrayLiteralReceivers, singleStringLiteralCallStarts);
          if (contract) record(site, contract);
          // A member the DOM library declares carries host semantics this check did not model, and an accessor
          // runs a body this path does not analyze; both are unknown, not proofs of effect freedom. A member the
          // checker resolves to no declaration at all — reached through a nullable or union receiver, an `any`,
          // or an index signature — is unknown for the same reason: nothing says what it is. An ordinary data
          // property of an object resolves to its own declaration and stays effect-free.
          else if (site.receiverPosition !== undefined) {
            const member = memberSymbolAt(site);
            if (member === null || declaredByDomLibrary(member) || isAccessorSymbol(member)) recordUnclassified(site);
          }
        }
      }
      for (const fn of syntax.functions) {
        const key = `${fileName}:${fn.start}:${fn.name}`;
        if (byFunction.has(key)) continue;
        byFunction.set(key, {
          functionName: fn.name, fileName, span: { start: fn.start, end: fn.end },
          parameters: [...fn.parameters], names: [], unclassified: false, unresolved: new Set<string>(), deferred: new Map<string, string>(),
          calleeSymbols: new Set<string>(), directCallees: new Set<string>(), resolvedSymbols: new Set<string>(),
          invokesUserCode: false, moduleReasons: [], argumentCalls: [], classCalls: [], discharges: [], composedValues: [],
        });
      }
    }
    /**
     * The parameter a symbol names, when invoking it is still the caller's value. A written binding is not, and a
     * shorthand pattern target resolves to the property symbol rather than the binding, so a name any shorthand
     * wrote is excluded as well.
     */
    const invokedParameter = (symbol: string): { ownerKey: string; index: number } | undefined => {
      if (writes.has(symbol)) return undefined;
      const owner = parameterOwners.get(symbol);
      const name = parameterNames.get(symbol);
      return owner === undefined || (name !== undefined && ambiguousWrites.has(name)) ? undefined : owner;
    };
    /**
     * The boundaries `new C()` runs: the class's own constructor, and — when it declares none — the inherited
     * one. A class this run did not analyze, an `extends` clause that names an expression, and a declared
     * constructor with no analyzed body each make the construction unresolved rather than effect-free.
     */
    const constructorTargets = (classSymbolId: string, seen: Set<string> = new Set()): string[] | undefined => {
      if (seen.has(classSymbolId)) return [];
      seen.add(classSymbolId);
      const info = classes.get(classSymbolId);
      if (info === undefined || !info.superResolvable || !info.linkable) return undefined;
      // A body this run did not resolve to a boundary is never an empty target list: an empty list is a proof
      // that construction performs nothing, and it is owed only when the class body runs nothing of its own.
      if (info.runsOwnBody && (info.constructorKey === null || !byFunction.has(info.constructorKey))) return undefined;
      const targets = info.constructorKey !== null && byFunction.has(info.constructorKey) ? [info.constructorKey] : [];
      // A declared constructor of a derived class reaches its base through its own `super(...)` call; an
      // implicit one runs the inherited constructor directly.
      if (info.declaresConstructor || info.superSymbolId === null) return targets;
      const inherited = constructorTargets(info.superSymbolId, seen);
      return inherited === undefined ? undefined : [...targets, ...inherited];
    };
    /** The analyzed boundary a callee symbol names, or `undefined` when no unique immutable body backs it. */
    const resolveTarget = (symbol: string): string | undefined => {
      const target = writes.has(symbol) ? undefined : declarations.get(symbol);
      return target && !ambiguousWrites.has(target.name) && byFunction.has(target.key) ? target.key : undefined;
    };
    for (const item of byFunction.values()) {
      for (const call of item.classCalls) {
        const targets = ((): readonly string[] | undefined => {
          if (call.kind === "construct") return constructorTargets(call.classSymbolId);
          if (call.kind === "super") {
            const base = classes.get(call.classSymbolId)?.superSymbolId ?? null;
            return base === null ? undefined : constructorTargets(base);
          }
          if (!privateMethods.has(call.declaration)) return undefined;
          const body = methodBodies.get(call.declaration);
          return body === undefined || !byFunction.has(body) ? undefined : [body];
        })();
        if (targets === undefined) {
          item.unclassified = true;
          item.unresolved.add(call.label);
          continue;
        }
        for (const target of targets) item.directCallees.add(target);
        // A constructor or a method may itself invoke one of its parameters, so this call owes the same
        // discharge a plain function call does.
        item.discharges.push({ targets, args: call.args, label: call.label });
      }
      for (const call of item.argumentCalls) {
        const target = resolveTarget(call.symbol);
        if (target === undefined) continue;
        item.discharges.push({ targets: [target], args: call.args, label: item.deferred.get(call.symbol) ?? "an invoked parameter" });
      }
    }
    // Invoking a parameter is not an unresolved site: the value comes from whoever calls the boundary that
    // receives it, so the body carries `InvokeUserCode` and every call of that boundary owes an argument whose
    // effects can be composed. A written parameter no longer carries the caller's value and stays unresolved.
    const obligations = new Map<string, Set<number>>();
    const owe = (key: string, index: number): boolean => {
      const owed = obligations.get(key) ?? new Set<number>();
      if (owed.has(index)) return false;
      owed.add(index);
      obligations.set(key, owed);
      return true;
    };
    for (const item of byFunction.values()) {
      for (const symbol of item.calleeSymbols) {
        const owner = invokedParameter(symbol);
        if (!owner || !byFunction.has(owner.ownerKey)) continue;
        item.invokesUserCode = true;
        item.resolvedSymbols.add(symbol);
        owe(owner.ownerKey, owner.index);
      }
    }
    const argumentSymbols = new Map<string, string | null>();
    const argumentSymbolAt = (file: string, position: number): string | null => {
      const key = `${file}:${position}`;
      if (argumentSymbols.has(key)) return argumentSymbols.get(key)!;
      const symbol = frontend.getSymbolAtPosition(file, position);
      const resolved = symbol === null ? null : (frontend.getAliasedSymbol(symbol) ?? symbol).id;
      argumentSymbols.set(key, resolved);
      return resolved;
    };
    /** The parameter an argument forwards unchanged, when the argument is a binding this path can resolve. */
    const forwardedParameter = (args: CallArgumentFacts, index: number): { ownerKey: string; index: number } | undefined => {
      const position = args.identifierPositions[index];
      if (position === null || position === undefined) return undefined;
      const symbol = argumentSymbolAt(args.fileName, position);
      return symbol === null ? undefined : invokedParameter(symbol);
    };
    // An obligation discovered on one boundary can create one on its caller, so this runs to a fixed point.
    for (let settled = false; !settled;) {
      settled = true;
      for (const [key, item] of byFunction) {
        for (const call of item.discharges) {
          const owed = new Set<number>();
          for (const target of call.targets) for (const index of obligations.get(target) ?? []) owed.add(index);
          if (owed.size === 0) continue;
          for (const index of owed) {
            if (call.args === undefined) {
              item.unclassified = true;
              item.unresolved.add(`a callback argument of ${call.label}`);
              continue;
            }
            // An argument position the call does not fill invokes nothing.
            if (index >= call.args.inline.length) continue;
            const inline = call.args.inline[index];
            if (inline !== null && byFunction.has(inline)) {
              if (!item.directCallees.has(inline)) {
                item.directCallees.add(inline);
                settled = false;
              }
              item.composedValues.push({ key: inline, label: `a callback argument of ${call.label}` });
              continue;
            }
            const forwarded = forwardedParameter(call.args, index);
            if (forwarded !== undefined && forwarded.ownerKey === key) {
              if (owe(key, forwarded.index)) settled = false;
              continue;
            }
            // An argument that names an analyzed binding supplies a boundary of its own.
            const position = call.args.identifierPositions[index];
            const supplied = position === null || position === undefined ? null : argumentSymbolAt(call.args.fileName, position);
            const bound = supplied === null ? undefined : resolveTarget(supplied);
            if (bound !== undefined) {
              if (!item.directCallees.has(bound)) {
                item.directCallees.add(bound);
                settled = false;
              }
              item.composedValues.push({ key: bound, label: `a callback argument of ${call.label}` });
              continue;
            }
            item.unclassified = true;
            item.unresolved.add(`a callback argument of ${call.label}`);
          }
        }
      }
    }
    // Composing a boundary as a value is not calling it: whatever fills its own invoked parameter is chosen by
    // whoever does call it, so an obligation it still owes cannot be discharged here.
    for (const item of byFunction.values()) {
      for (const composed of item.composedValues) {
        if ((obligations.get(composed.key)?.size ?? 0) === 0) continue;
        item.unclassified = true;
        item.unresolved.add(composed.label);
      }
    }
    // Every file has now been read, so which dependencies this run actually followed is settled. An edge to an
    // analyzed module joins the same fixed point as a call, which converges over import cycles for free; one
    // that was not followed is an explicit absence, named so it is not mistaken for a call this check could not
    // resolve. The target's boundary is materialized here because the propagation filter drops a dangling
    // callee, which would turn "not followed" into "followed and clean".
    for (const edge of moduleEdges) {
      if (edge.target !== undefined) {
        const key = `${edge.target}:0:<module>`;
        if (!byFunction.has(key)) {
          byFunction.set(key, {
            functionName: "<module>", fileName: edge.target, span: { start: 0, end: (sources.get(edge.target) ?? "").length },
            parameters: [], names: [], unclassified: false, unresolved: new Set<string>(), deferred: new Map<string, string>(),
            calleeSymbols: new Set<string>(), directCallees: new Set<string>(), resolvedSymbols: new Set<string>(),
            invokesUserCode: false, moduleReasons: [], argumentCalls: [], classCalls: [], discharges: [], composedValues: [],
          });
        }
        edge.importer.directCallees.add(key);
        continue;
      }
      const contract = findModuleInitializationContract(registry, packageName(edge.specifier), moduleRuntime(edge.fromFile, edge.specifier));
      if (contract) {
        edge.importer.names.push(...contract.effects);
        if (contract.effects.length > 0) edge.importer.names.push(contractToken);
        // What this import evaluates is a reviewed claim about an artifact the run never read, so the ledger
        // carries it the same way it carries a builtin contract.
        assumptions.push(assumptionEntry({
          domain: "module-initialization",
          reason: contract.trustReason,
          owner: contract.trustOwner,
          ...(contract.trustExpiresOn === undefined ? {} : { expiresOn: contract.trustExpiresOn }),
          dependency: {
            module: edge.specifier,
            ...(contract.runtime.kind === "package" ? { packageVersion: contract.runtime.version } : { nodeMajor: contract.runtime.major }),
          },
          scope: { fileName: edge.fromFile, functionName: "<module>", span: { start: 0, end: (sources.get(edge.fromFile) ?? "").length } },
        }));
        continue;
      }
      edge.importer.unclassified = true;
      edge.importer.moduleReasons.push(edge.followable
        ? { code: "unknown-dependency", message: `importing ${edge.specifier} evaluates a module this run did not analyze` }
        : { code: "unreviewed-external-module", message: `importing ${edge.specifier} has no reviewed module initialization contract` });
    }
    // An unresolved site is carried through the same fixed point as effect names, so a caller that reaches one
    // transitively is unknown too. The token cannot collide with an effect term.
    const unresolvedToken = "\u0000unresolved";
    const propagated = propagateEffectNames([...byFunction].map(([id, item]) => {
      const callees = [...item.directCallees].filter(key => byFunction.has(key));
      for (const symbol of item.calleeSymbols) {
        if (item.resolvedSymbols.has(symbol)) continue;
        const target = resolveTarget(symbol);
        if (target !== undefined) callees.push(target);
        else {
          item.unclassified = true;
          item.unresolved.add(item.deferred.get(symbol) ?? "an unresolved call");
        }
      }
      const names = item.invokesUserCode ? [...item.names, "InvokeUserCode"] : item.names;
      return { id, names: item.unclassified ? [...names, unresolvedToken] : names, callees };
    }));
    const summaries: EffectSummary[] = [...byFunction]
      .map(([id, item]) => {
        const names = [...propagated.get(id)!];
        const reachesUnresolved = names.includes(unresolvedToken);
        const restsOnContract = names.includes(contractToken);
        const effects = uniqueEffects(names.filter((name) => name !== unresolvedToken && name !== contractToken));
        const evidence: EvidenceStatus = reachesUnresolved ? "unknown"
          : restsOnContract && effects.length > 0 ? "trusted" : "inferred";
        return {
          functionName: item.functionName,
          effects,
          evidence,
          fileName: item.fileName,
          span: item.span,
          parameters: item.parameters,
          ...(reachesUnresolved ? {
            unknownReasons: [...(item.unresolved.size > 0 || item.moduleReasons.length === 0 ? [{
              code: "unresolved-call" as const,
              message: item.unresolved.size === 0
                ? "a callee reaches a site outside the complete Corsa effect model; known callee effects may be retained"
                : `no reviewed contract for ${[...item.unresolved].sort().slice(0, 5).join(", ")}`
                  + (item.unresolved.size > 5 ? ` and ${item.unresolved.size - 5} more` : "")
                  + "; known callee effects may be retained",
            }] : []), ...item.moduleReasons],
          } : {}),
        };
      })
      .sort((left, right) => (left.fileName ?? "").localeCompare(right.fileName ?? "")
        || (left.span?.start ?? 0) - (right.span?.start ?? 0));
    let artifacts: VerificationArtifact[] = [];
    if ([...sources.values()].some(hasNativeContractCandidates)) {
      const { verifyCorsaContracts } = await import("../../contracts/corsa-contracts.js");
      const contracts = await verifyCorsaContracts({ configFile, cwd: options.cwd, corsaExecutable: options.corsaExecutable, files: sources });
      artifacts = contracts.artifacts;
      diagnostics.push(...contracts.diagnostics.map(diagnostic => ({
        domain: "contract" as const, kind: "contract" as const, severity: "error" as const,
        fileName: diagnostic.fileName, functionName: diagnostic.functionName, line: diagnostic.line, message: diagnostic.message, notes: diagnostic.notes,
      })));
    }
    const errors = diagnostics.filter((item) => item.severity === "error").length;
    return {
      ...(options.includeBuiltinCalls ? { corsaBuiltinCalls: analyzeCorsaBuiltinCalls(sources, frontend) } : {}),
      diagnostics,
      sources,
      artifacts,
      summaries,
      assumptions: { schema: "uneffect-assumptions/v1", entries: assumptions, violations: [] },
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
