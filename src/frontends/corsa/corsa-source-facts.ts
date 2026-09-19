import { parseSync } from "oxc-parser";
import { oxcLanguage } from "../oxc/source.js";
import type { DiagnosticNote } from "../../support/diagnostic-contracts.js";
import { enclosingFunction, receiverTokenPosition } from "../oxc-syntax.js";
import type { SyntaxFunction, SyntaxSite } from "../syntax-facts-contract.js";
import type { CorsaApiFrontend, CorsaApiSymbolFact, CorsaApiTypeFact } from "./corsa-api-frontend.js";
import { nativeExpressionKind } from "./native-expression-kind.js";
import { runtimeModuleDependencies, type RuntimeModuleDependency } from "../../modules/runtime-dependencies.js";

/**
 * Checker-backed element-access analysis for the default Corsa check.
 *
 * Three bounded results are produced from one Oxc traversal:
 *
 * - a computed member whose receiver type cannot select any reviewed DOM
 *   contract is admitted as an ordinary read/write, so it no longer blocks the
 *   syntax coverage of the file;
 * - a computed member whose key has one literal type is republished as the
 *   equivalent static-name site, so it selects the same contract `receiver.name`
 *   would;
 * - an `Array`/`ReadonlyArray` element that is dereferenced immediately
 *   (`list[i].x`, `list[i]()`) without a recognized index guard is reported,
 *   because TypeScript types that element as present unless
 *   `noUncheckedIndexedAccess` is enabled.
 *
 * Everything the fragment cannot establish stays excluded or reported; nothing
 * unanalyzable is converted into evidence of effect freedom. Guard recognition
 * is syntactic and intentionally small. A guard is discarded when the receiver's
 * length is changed between the guard and the access, when a length snapshot is
 * taken before such a change, or when the index binding is assigned outside a
 * `for` header. Interprocedural predicates, guards in an enclosing function, and
 * receiver reassignment remain explicit non-claims.
 */
export type CorsaSourceFactsFrontend = Pick<CorsaApiFrontend, "getTypeAtPosition" | "getTypeAtRange" | "getSymbolOfType" | "getPropertyOfType">;

export interface CorsaSourceFactsOptions {
  /** `Owner#member` keys of the reviewed `lib.dom` contracts the check can select. */
  readonly domContractKeys: ReadonlySet<string>;
  /**
   * Whether a reviewed lib.dom contract is selected for a receiver interface and member name, the library's
   * own inheritance included. Defaults to an exact key match.
   */
  readonly selectsDomContractKey?: (ownerName: string, memberName: string) => boolean;
}

export interface BoundsDiagnostic {
  readonly start: number;
  readonly end: number;
  readonly line: number;
  readonly functionName: string;
  readonly message: string;
  readonly notes: DiagnosticNote[];
}

export interface CorsaSourceFacts {
  /** `${start}:${end}` keys of computed-property exclusions admitted by checker evidence. */
  readonly admittedComputedProperties: ReadonlySet<string>;
  /** `${start}:${end}` keys of computed call/construct exclusions whose receiver selects no DOM contract; the callee stays unknown. */
  readonly admittedComputedCalls: ReadonlySet<string>;
  /** `${start}:${end}` keys of computed members that name a known accessor: the site is ordinary, its body is not. */
  readonly accessorComputedMembers: ReadonlySet<string>;
  /** Exclusion span keys whose literal-typed key is republished in `constantKeySites`. */
  readonly constantKeyExclusions: ReadonlySet<string>;
  readonly constantKeySites: readonly SyntaxSite[];
  /**
   * Property-token offsets of members whose receiver is written as an array literal, under the wrappers that
   * preserve its identity. Such a receiver allocates a genuine Array, so the `Array#` contract describes the
   * body that runs however the checker names its type — including the readonly tuple `as const` produces.
   */
  readonly arrayLiteralReceivers: ReadonlySet<number>;
  /** `${start}:${end}` keys of member expressions written but not read, so the site selects the write semantics. */
  readonly assignmentTargets: ReadonlySet<string>;
  /** `${start}:${end}` keys of member expressions both read and written, such as a compound assignment. */
  readonly readWriteTargets: ReadonlySet<string>;
  /**
   * Every write the source performs whose result someone other than this boundary can see: a member of an
   * object the boundary did not create, or a binding declared outside it. This path renders no region for
   * either, so one no reviewed contract accounts for leaves the boundary unresolved rather than a proof. A
   * write to `this` inside a constructor or a field initializer is excluded, because the object did not exist
   * before the call and no caller holds its previous state.
   */
  readonly observableWrites: ReadonlyArray<{
    readonly start: number; readonly end: number; readonly name: string; readonly kind: "member" | "binding";
  }>;
  /**
   * Every `throw` no enclosing `catch` can reach, with the construction each one throws. `start` is the throw
   * statement's own offset, so the consumer attributes it with the same rule it uses for every other site.
   * The operand is decomposed syntactically first: the checker reduces `flag ? new RangeError() : new TypeError()`
   * to one constituent, and which one survives is arbitrary, so each result branch is reported separately.
   * `calleePosition` is the offset of a `new X(...)` callee identifier, or `null` when the operand is anything
   * else — a value, a call result, a user class. The consumer names only what the reviewed catalog already
   * resolved there.
   */
  readonly throws: ReadonlyArray<{ readonly start: number; readonly calleePosition: number | null }>;
  /**
   * Every implicit ToPrimitive conversion whose operand this path could not prove already primitive — a
   * template substitution, a `+` or an arithmetic, relational or loose-equality operand. The conversion runs
   * the value's own `Symbol.toPrimitive`, `valueOf` or `toString` and throws TypeError when none yields a
   * primitive, which is exactly the reviewed contract `String` and `Number` already carry. `start` is the
   * enclosing expression's offset, attributed by the same rule as every other site.
   */
  readonly coercions: ReadonlyArray<{ readonly start: number }>;
  /** The static imports and export-froms whose evaluation runs another module. */
  readonly dependencies: readonly RuntimeModuleDependency[];
  /**
   * The receiver type of a call or member site whose receiver is not one the last identifier token describes —
   * a call result, a coalesced value, an element, a parenthesized expression. Keyed by the site's own
   * `${start}:${end}`. A receiver the native tree cannot place at that exact range is absent, so the consumer
   * resolves nothing rather than reading the type of a different expression.
   */
  readonly receiverTypes: ReadonlyMap<string, CorsaApiTypeFact>;
  /**
   * Call-expression start offset to the start offset of each argument that is written inline as a function,
   * or `null` for an argument this path cannot see into. A reviewed callback contract can be composed only
   * with an inline argument, because only that argument has its own analyzed function boundary.
   */
  readonly inlineFunctionArguments: ReadonlyMap<string, readonly (number | null)[]>;
  /**
   * Call-expression span to the start offset of each argument written as a plain identifier, or `null`. A
   * caller discharges an invoked-parameter obligation either with an inline function or by forwarding a
   * binding of its own, and only an identifier argument names a binding this path can resolve.
   */
  readonly callArgumentIdentifiers: ReadonlyMap<string, readonly (number | null)[]>;
  /**
   * Per call, whether each argument is an allocation written at the call itself. Only the call site's own
   * syntax is read, so this answers "nothing else can be holding this yet", not "this value never escapes" —
   * which is what tells `Object.freeze({ ... })` from `Object.assign(target, ... )`.
   */
  readonly freshArguments: ReadonlyMap<string, readonly boolean[]>;
  /**
   * `${start}:${end}` of a member expression assigned an inline function, to that function's start offset. A
   * contract whose callback target is the assigned value composes with it, exactly as an argument callback does.
   */
  readonly assignedInlineFunctions: ReadonlyMap<string, number>;
  readonly diagnostics: readonly BoundsDiagnostic[];
}

interface EstreeNode {
  type?: string;
  start?: number;
  end?: number;
  name?: string;
  computed?: boolean;
  optional?: boolean;
  operator?: string;
  kind?: string;
  value?: unknown;
  [key: string]: unknown;
}

type Index = { kind: "literal"; value: number; text: string } | { kind: "identifier"; name: string; text: string };

const functionTypes = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"]);
const abruptTypes = new Set(["ReturnStatement", "ThrowStatement", "ContinueStatement", "BreakStatement"]);
/** Array methods that can reduce `length`, so a guard taken before one of them no longer holds. */
const lengthReducingMethods = new Set(["shift", "pop", "splice", "copyWithin", "fill", "sort", "reverse"]);
const opaqueTypeTexts = new Set(["any", "unknown", "never"]);
/**
 * Corsa reports the compiler's own `TypeFlags`, whose values differ from the JavaScript TypeScript 6
 * inventory. `test/corsa-source-facts.test.ts` pins the observed numbering, so a compiler that renumbers
 * them fails CI instead of silently reclassifying a type.
 */
const anyTypeFlag = 1, unknownTypeFlag = 2, neverTypeFlag = 262144;
const numberTypeFlag = 64, numberLiteralTypeFlag = 2048;
const opaqueTypeFlags = anyTypeFlag | unknownTypeFlag | neverTypeFlag;
/** Only the two plain numeric forms; a numeric enum is a union whose members this fragment does not read. */
const numericTypeFlags = numberTypeFlag | numberLiteralTypeFlag;
/** Compiler `SymbolFlags.GetAccessor | SymbolFlags.SetAccessor`; reading or writing one runs its body. */
export const accessorSymbolFlags = 32768 | 65536;
/**
 * Corsa `TypeFlags` for the types whose ToPrimitive conversion reaches no user method and cannot throw, as
 * observed from the compiler and pinned by `test/corsa-source-facts.test.ts`. `symbol` is deliberately absent:
 * ToString of a Symbol throws TypeError. So is `object`, whose conversion is exactly the user method this is
 * here to find, and `any` / `unknown`, which say nothing about what the value is.
 */
const undefinedTypeFlag = 4, nullTypeFlag = 8, voidTypeFlag = 16, stringTypeFlag = 32, bigintTypeFlag = 128;
const stringLiteralTypeFlag = 1024, bigintLiteralTypeFlag = 4096, booleanLiteralTypeFlag = 8192;
const enumLiteralTypeFlag = 32768, unionTypeFlag = 134217728, templateLiteralTypeFlag = 4194304;
const totalConversionFlags = undefinedTypeFlag | nullTypeFlag | voidTypeFlag | stringTypeFlag | numberTypeFlag
  | bigintTypeFlag | stringLiteralTypeFlag | numberLiteralTypeFlag | bigintLiteralTypeFlag
  | booleanLiteralTypeFlag | enumLiteralTypeFlag | templateLiteralTypeFlag;
/**
 * A union reports only `Union` plus, for `boolean` and for an enum, the kind of its members — its constituents
 * are not in the flags. The printed text is the only inventory of them this frontend exposes, so a union is
 * admitted by reading that text, and a term the list does not recognize keeps the whole union out.
 */
const primitiveTypeTexts = new Set(["string", "number", "boolean", "bigint", "undefined", "null", "void", "true", "false"]);
const literalTypeText = /^(?:"[^"]*"|'[^']*'|-?\d+(?:\.\d+)?n?)$/;
/**
 * The members that identify what every constituent of a union is. A union's property access has to resolve on
 * all of them, so a `String.prototype` member declared by the ECMAScript library answers only for a union of
 * strings — which is what a named alias of a string-literal union prints as, and what its text does not say.
 */
const primitiveWitnessMembers = ["charCodeAt", "toFixed"] as const;
/**
 * Whether a value of this type converts to a primitive without running anything the source wrote. Absence of a
 * type is not admission: an operand this path could not type may be an object carrying its own
 * `Symbol.toPrimitive`, `valueOf` or `toString`.
 */
function convertsWithoutUserCode(
  type: CorsaApiTypeFact | null,
  standardMemberOf: (type: CorsaApiTypeFact, name: string) => boolean,
): boolean {
  if (!type || typeof type.flags !== "number" || (type.flags & opaqueTypeFlags) !== 0) return false;
  if ((type.flags & totalConversionFlags) !== 0) return true;
  if ((type.flags & unionTypeFlag) === 0) return false;
  const admittedByText = type.texts.length === 1 && type.texts[0]!.split("|").every((term) => {
    const text = term.trim();
    return primitiveTypeTexts.has(text) || literalTypeText.test(text);
  });
  if (admittedByText) return true;
  // A named alias prints as its own name, so the constituents are asked about instead of read. The union gate
  // above is what keeps a `String` wrapper object — which answers the same way — out of this branch.
  return primitiveWitnessMembers.some((name) => standardMemberOf(type, name));
}

function isNode(value: unknown): value is EstreeNode {
  return Boolean(value && typeof value === "object" && typeof (value as EstreeNode).type === "string");
}

function children(node: EstreeNode): EstreeNode[] {
  const result: EstreeNode[] = [];
  for (const [key, child] of Object.entries(node)) {
    if (key === "type" || key === "loc" || key === "range") continue;
    if (Array.isArray(child)) for (const item of child) { if (isNode(item)) result.push(item); }
    else if (isNode(child)) result.push(child);
  }
  return result;
}

function walk(node: EstreeNode, visit: (node: EstreeNode) => void): void {
  visit(node);
  for (const child of children(node)) walk(child, visit);
}

export function isAccessorSymbol(symbol: CorsaApiSymbolFact | null | undefined): boolean {
  return typeof symbol?.flags === "number" && (symbol.flags & accessorSymbolFlags) !== 0;
}

function declaredBy(symbol: CorsaApiSymbolFact | null | undefined, pattern: RegExp): boolean {
  return Boolean(symbol && (symbol.declarations ?? []).some((item) => pattern.test(item)));
}

const domLibrary = /(?:^|[/\\])lib\.dom\.d\.ts$/;
const ecmaScriptLibrary = /(?:^|[/\\])lib\.es[\w.]*\.d\.ts$/i;

function unwrap(node: EstreeNode): EstreeNode {
  let current = node;
  while ((current.type === "TSNonNullExpression" || current.type === "TSAsExpression" || current.type === "TSSatisfiesExpression"
    || current.type === "TSTypeAssertion" || current.type === "ParenthesizedExpression") && isNode(current.expression)) {
    current = current.expression;
  }
  return current;
}

/** The shared definition of the receiver's type-bearing token, so admission and contract selection agree. */
function receiverTypePosition(receiver: EstreeNode): number | undefined {
  return receiverTokenPosition(receiver as never);
}

interface ResolvedReceiver { type: CorsaApiTypeFact; symbol: CorsaApiSymbolFact | null; position: number }

function isOpaque(type: CorsaApiTypeFact): boolean {
  if (typeof type.flags === "number" && (type.flags & opaqueTypeFlags) !== 0) return true;
  return type.texts.length === 0 || type.texts.some((text) => opaqueTypeTexts.has(text));
}

/** The literal value of a string/number literal type, when the checker reports exactly one. */
function literalKey(type: CorsaApiTypeFact | null): string | number | undefined {
  if (!type || isOpaque(type)) return undefined;
  return typeof type.value === "string" || (typeof type.value === "number" && Number.isFinite(type.value)) ? type.value : undefined;
}

function isArrayReceiver(resolved: ResolvedReceiver): boolean {
  return resolved.symbol !== null && (resolved.symbol.name === "Array" || resolved.symbol.name === "ReadonlyArray")
    && declaredBy(resolved.symbol, ecmaScriptLibrary);
}

/** A key the checker types as a number can only reach numerically named members, and no reviewed contract has one. */
function isNumericKey(type: CorsaApiTypeFact | null): boolean {
  if (!type || isOpaque(type)) return false;
  return typeof type.flags === "number" && (type.flags & numericTypeFlags) !== 0;
}

function indexOf(property: EstreeNode, text: string, constant: string | number | undefined): Index | undefined {
  if (typeof constant === "number" && Number.isInteger(constant) && constant >= 0) return { kind: "literal", value: constant, text };
  if (property.type === "Identifier" && typeof property.name === "string") return { kind: "identifier", name: property.name, text };
  if ((property.type === "Literal" || property.type === "NumericLiteral") && typeof property.value === "number"
    && Number.isInteger(property.value) && property.value >= 0) return { kind: "literal", value: property.value, text };
  return undefined;
}

function numericLiteral(node: EstreeNode): number | undefined {
  const inner = unwrap(node);
  return (inner.type === "Literal" || inner.type === "NumericLiteral") && typeof inner.value === "number" ? inner.value : undefined;
}

function stringLiteral(node: EstreeNode): string | undefined {
  const inner = unwrap(node);
  return (inner.type === "Literal" || inner.type === "StringLiteral") && typeof inner.value === "string" ? inner.value : undefined;
}

function isUndefinedLiteral(node: EstreeNode): boolean {
  const inner = unwrap(node);
  return inner.type === "Identifier" && inner.name === "undefined";
}

function isNullLiteral(node: EstreeNode): boolean {
  const inner = unwrap(node);
  return inner.type === "NullLiteral" || ((inner.type === "Literal") && inner.value === null && inner.raw === "null");
}

const flippedComparison: Record<string, string> = { "<": ">", ">": "<", "<=": ">=", ">=": "<=", "===": "===", "==": "==", "!==": "!==", "!=": "!=" };

/** Facts about one function body, computed once and shared by every access inside it. */
interface FunctionContext {
  /** `const alias = receiver` bindings, mapping alias text to the aliased receiver text. */
  readonly receiverAliases: ReadonlyMap<string, string>;
  /** `const snapshot = receiver.length` bindings, with the position after which the snapshot exists. */
  readonly lengthSnapshots: ReadonlyMap<string, { receiver: string; from: number }>;
  /** Positions where a receiver's `length` may change, keyed by canonical receiver text. */
  readonly lengthChanges: ReadonlyMap<string, readonly number[]>;
  /** Canonical receiver texts whose array identity escapes into code this fragment does not analyze. */
  readonly escaped: ReadonlySet<string>;
  /** Identifiers assigned or updated outside a `for` header, so a guard on them does not survive. */
  readonly reassigned: ReadonlySet<string>;
  /** Identifiers assigned or updated anywhere, including a `for` header. */
  readonly everAssigned: ReadonlySet<string>;
  /** `const parts = "...".split(literal)` guarantees, keyed by binding name. */
  readonly splitMinimums: ReadonlyMap<string, number>;
  /**
   * Sorted end offsets of the early-exit statements in one block that imply the element is absent, keyed by the
   * block and by the access's receiver and index. Built once per key, then binary-searched: scanning the
   * preceding statements at every access is quadratic in a function with many guards and many accesses.
   */

}

/** Follow `const alias = receiver` bindings to the name they ultimately stand for, without revisiting one. */
function canonicalName(aliases: ReadonlyMap<string, string>, name: string): string {
  const seen = new Set<string>();
  let current = name;
  while (!seen.has(current)) {
    seen.add(current);
    const next = aliases.get(current);
    if (next === undefined) break;
    current = next;
  }
  return current;
}

class FunctionFacts {
  private readonly receiverAliases = new Map<string, string>();
  private readonly lengthSnapshots = new Map<string, { receiver: string; from: number }>();
  private readonly lengthChanges = new Map<string, number[]>();
  private readonly escaped = new Set<string>();
  private readonly reassigned = new Set<string>();
  private readonly everAssigned = new Set<string>();
  private readonly splitCandidates = new Map<string, { init: EstreeNode; end: number }>();
  private readonly declarationCounts = new Map<string, number>();

  private note(receiver: string, position: number): void {
    const list = this.lengthChanges.get(receiver);
    if (list) list.push(position); else this.lengthChanges.set(receiver, [position]);
  }

  /** Resolve an alias chain to the binding the guard and the access must agree on. */
  canonical(name: string): string {
    return canonicalName(this.receiverAliases, name);
  }

  collect(
    root: EstreeNode,
    parents: ReadonlyMap<EstreeNode, EstreeNode>,
    text: (node: EstreeNode) => string,
  ): FunctionContext {
    const forHeaderBindings = new Set<EstreeNode>();
    walk(root, (node) => {
      if (node.type === "ForStatement") {
        if (isNode(node.init)) forHeaderBindings.add(node.init);
        if (isNode(node.update)) forHeaderBindings.add(node.update);
      }
    });
    const insideForHeader = (node: EstreeNode): boolean => {
      let current: EstreeNode | undefined = node;
      while (current && current !== root) {
        if (forHeaderBindings.has(current)) return true;
        current = parents.get(current);
      }
      return false;
    };
    walk(root, (node) => {
      if (node.type === "VariableDeclarator" && isNode(node.id) && node.id.type === "Identifier" && typeof node.id.name === "string") {
        const name = node.id.name;
        this.declarationCounts.set(name, (this.declarationCounts.get(name) ?? 0) + 1);
        const declaration = parents.get(node);
        const isConst = declaration?.kind === "const";
        const init = isNode(node.init) ? unwrap(node.init) : undefined;
        if (init && typeof node.end === "number") {
          if (isConst && init.type === "Identifier" && typeof init.name === "string") this.receiverAliases.set(name, init.name);
          else if (init.type === "MemberExpression" && init.computed !== true && isNode(init.property)
            && init.property.name === "length" && isNode(init.object)) {
            // A `for` header counter bound is not `const`, but it is still a snapshot while nothing assigns it.
            this.lengthSnapshots.set(name, { receiver: text(init.object), from: node.end });
          } else if (isConst && init.type === "CallExpression") this.splitCandidates.set(name, { init, end: node.end });
        }
      }
      if (node.type === "AssignmentExpression" && isNode(node.left)) {
        const target = unwrap(node.left);
        if (target.type === "Identifier" && typeof target.name === "string") {
          this.everAssigned.add(target.name);
          if (!insideForHeader(node)) this.reassigned.add(target.name);
        }
        if (target.type === "MemberExpression" && isNode(target.object) && isNode(target.property)
          && target.computed !== true && target.property.name === "length" && typeof node.start === "number") {
          this.note(text(target.object), node.start);
        }
      }
      if (node.type === "UpdateExpression" && isNode(node.argument)) {
        const target = unwrap(node.argument);
        if (target.type === "Identifier" && typeof target.name === "string") {
          this.everAssigned.add(target.name);
          if (!insideForHeader(node)) this.reassigned.add(target.name);
        }
      }
      if (node.type === "UnaryExpression" && node.operator === "delete" && isNode(node.argument)) {
        const target = unwrap(node.argument);
        if (target.type === "MemberExpression" && isNode(target.object)) this.escaped.add(text(target.object));
      }
      if (node.type === "CallExpression") {
        const callee = isNode(node.callee) ? unwrap(node.callee) : undefined;
        if (callee?.type === "MemberExpression" && callee.computed !== true && isNode(callee.object) && isNode(callee.property)
          && typeof callee.property.name === "string" && typeof node.start === "number"
          && lengthReducingMethods.has(callee.property.name)) {
          this.note(text(callee.object), node.start);
        }
        // An array handed to code outside this fragment can be mutated or aliased there.
        for (const argument of Array.isArray(node.arguments) ? node.arguments : []) {
          if (!isNode(argument)) continue;
          const value = unwrap(argument);
          if (value.type === "Identifier" && typeof value.name === "string") this.escaped.add(value.name);
          if (value.type === "SpreadElement" && isNode(value.argument) && unwrap(value.argument).type === "Identifier") {
            this.escaped.add(text(unwrap(value.argument)));
          }
        }
      }
    });
    // A binding aliased to a receiver lets the receiver be reached under another name.
    for (const [alias, target] of this.receiverAliases) if (this.escaped.has(alias)) this.escaped.add(this.canonical(target));
    for (const [alias, target] of this.receiverAliases) {
      const changes = this.lengthChanges.get(alias);
      if (changes) for (const position of changes) this.note(this.canonical(target), position);
      this.escaped.add(alias);
    }
    const splitMinimums = new Map<string, number>();
    for (const [name, candidate] of this.splitCandidates) {
      if ((this.declarationCounts.get(name) ?? 0) !== 1) continue;
      if (this.reassigned.has(name) || this.escaped.has(name) || this.lengthChanges.has(name)) continue;
      const minimum = this.splitMinimum(candidate.init);
      if (minimum > 0) splitMinimums.set(name, minimum);
    }
    // Copies, so the collected context owns its data and the collector does not escape through it.
    return {
      receiverAliases: new Map(this.receiverAliases),
      lengthSnapshots: new Map(this.lengthSnapshots),
      lengthChanges: new Map([...this.lengthChanges].map(([name, positions]) => [name, [...positions]])),
      escaped: new Set(this.escaped),
      reassigned: new Set(this.reassigned),
      everAssigned: new Set(this.everAssigned),
      splitMinimums,
    };
  }

  /**
   * `String#split` returns at least one element only for a non-empty string separator: `"".split("")`
   * is `[]`, and a regular expression that matches the empty string behaves the same way.
   */
  private splitMinimum(init: EstreeNode): number {
    const callee = isNode(init.callee) ? unwrap(init.callee) : undefined;
    if (callee?.type !== "MemberExpression" || callee.computed === true || !isNode(callee.property)
      || callee.property.type !== "Identifier" || callee.property.name !== "split") return 0;
    const args = (Array.isArray(init.arguments) ? init.arguments : []).filter(isNode);
    const separator = args[0] === undefined ? undefined : stringLiteral(args[0]);
    if (separator === undefined || separator.length === 0) return 0;
    if (args.length === 1) return 1;
    if (args.length === 2) { const limit = numericLiteral(args[1]!); return limit !== undefined && limit > 0 ? 1 : 0; }
    return 0;
  }

  /** The split binding must also be a checker-resolved `String#split`, not a same-named user method. */
  static resolvesToStringSplit(
    frontend: CorsaSourceFactsFrontend, file: string, init: EstreeNode,
  ): boolean {
    const callee = isNode(init.callee) ? unwrap(init.callee) : undefined;
    if (callee?.type !== "MemberExpression" || !isNode(callee.property) || typeof callee.property.start !== "number") return false;
    const method = frontend.getTypeAtPosition(file, callee.property.start);
    const symbol = method ? frontend.getSymbolOfType(method) : null;
    return symbol !== null && symbol.name === "split" && declaredBy(symbol, ecmaScriptLibrary);
  }
}

class AccessContext {
  constructor(
    readonly source: string,
    readonly receiverText: string,
    readonly accessText: string,
    readonly index: Index,
    readonly facts: FunctionContext,
    readonly canonicalReceiver: string,
    readonly canonicalize: (name: string) => string,
    /** Memo of the early-exit guards each statement list ends before, shared across the whole file. */
    readonly guardIndex: Map<string, number[]>,
  ) {}

  text(node: EstreeNode): string {
    return this.source.slice(node.start, node.end).replace(/\s+/g, "");
  }

  /** No change to the receiver's length may happen in `[from, until)`, or a guard taken at `from` is stale. */
  stable(from: number, until: number): boolean {
    const changes = this.facts.lengthChanges.get(this.canonicalReceiver) ?? [];
    return !changes.some((position) => position >= from && position < until);
  }

  private denotesReceiver(node: EstreeNode): boolean {
    const inner = unwrap(node);
    if (inner.type === "Identifier" && typeof inner.name === "string") return this.canonicalize(inner.name) === this.canonicalReceiver;
    return this.text(inner) === this.receiverText;
  }

  denotesLength(node: EstreeNode, accessStart: number): boolean {
    const inner = unwrap(node);
    if (inner.type === "Identifier" && typeof inner.name === "string") {
      const snapshot = this.facts.lengthSnapshots.get(inner.name);
      if (!snapshot || this.facts.everAssigned.has(inner.name)) return false;
      if (this.canonicalize(snapshot.receiver.replace(/\.length$/u, "")) !== this.canonicalReceiver
        && snapshot.receiver !== this.receiverText) return false;
      // The snapshot is a value, not a view: any later change to the array invalidates it.
      return this.stable(snapshot.from, accessStart);
    }
    return inner.type === "MemberExpression" && inner.computed !== true && isNode(inner.property)
      && inner.property.type === "Identifier" && inner.property.name === "length"
      && isNode(inner.object) && this.denotesReceiver(inner.object);
  }

  denotesElement(node: EstreeNode): boolean {
    return this.text(unwrap(node)) === this.accessText;
  }

  denotesIndex(node: EstreeNode): boolean {
    const inner = unwrap(node);
    return this.index.kind === "identifier" && inner.type === "Identifier" && inner.name === this.index.name;
  }

  /** `L op n` with a numeric literal, or `i op L` with the identifier index, normalized onto the length. */
  comparison(node: EstreeNode, accessStart: number): { lengthVsLiteral?: { op: string; n: number }; indexVsLength?: { op: string } } | undefined {
    if (node.type !== "BinaryExpression" || !isNode(node.left) || !isNode(node.right) || typeof node.operator !== "string") return undefined;
    const op = node.operator;
    if (!(op in flippedComparison)) return undefined;
    if (this.denotesLength(node.left, accessStart)) {
      const n = numericLiteral(node.right);
      if (n !== undefined) return { lengthVsLiteral: { op, n } };
      if (this.denotesIndex(node.right)) return { indexVsLength: { op: flippedComparison[op]! } };
    }
    if (this.denotesLength(node.right, accessStart)) {
      const n = numericLiteral(node.left);
      if (n !== undefined) return { lengthVsLiteral: { op: flippedComparison[op]!, n } };
      if (this.denotesIndex(node.left)) return { indexVsLength: { op } };
    }
    return undefined;
  }

  /** The condition being true implies the indexed element exists. */
  provesInRange(test: EstreeNode, accessStart: number): boolean {
    const node = unwrap(test);
    if (node.type === "LogicalExpression" && isNode(node.left) && isNode(node.right)) {
      return node.operator === "&&" && (this.provesInRange(node.left, accessStart) || this.provesInRange(node.right, accessStart));
    }
    if (node.type === "UnaryExpression" && node.operator === "!" && isNode(node.argument)) return this.impliedByOutOfRange(node.argument, accessStart);
    if (this.denotesLength(node, accessStart)) return this.index.kind === "literal" && this.index.value === 0;
    if (this.denotesElement(node)) return true;
    const compared = this.comparison(node, accessStart);
    if (compared?.lengthVsLiteral && this.index.kind === "literal") {
      const { op, n } = compared.lengthVsLiteral, k = this.index.value;
      return (op === ">" && n >= k) || (op === ">=" && n > k) || ((op === "===" || op === "==") && n > k)
        || ((op === "!==" || op === "!=") && n === 0 && k === 0);
    }
    if (compared?.indexVsLength) return compared.indexVsLength.op === "<";
    if (node.type === "BinaryExpression" && isNode(node.left) && isNode(node.right)) {
      const op = node.operator;
      const [element, other] = this.denotesElement(node.left) ? [node.left, node.right]
        : this.denotesElement(node.right) ? [node.right, node.left] : [undefined, undefined];
      if (element && other) {
        if ((op === "!==" || op === "!=") && isUndefinedLiteral(other)) return true;
        if (op === "!=" && isNullLiteral(other)) return true;
      }
      const typed = this.typeofArgument(node.left) ?? this.typeofArgument(node.right);
      const tag = this.typeofArgument(node.left) ? node.right : node.left;
      if (typed && this.denotesElement(typed)) {
        const literal = stringLiteral(tag);
        if (literal === undefined) return false;
        if ((op === "===" || op === "==") && literal !== "undefined") return true;
        if ((op === "!==" || op === "!=") && literal === "undefined") return true;
      }
    }
    return false;
  }

  private typeofArgument(side: EstreeNode): EstreeNode | undefined {
    const inner = unwrap(side);
    return inner.type === "UnaryExpression" && inner.operator === "typeof" && isNode(inner.argument) ? inner.argument : undefined;
  }

  /** The indexed element being absent implies the condition is true, so its false branch is safe. */
  impliedByOutOfRange(test: EstreeNode, accessStart: number): boolean {
    const node = unwrap(test);
    if (node.type === "LogicalExpression" && isNode(node.left) && isNode(node.right)) {
      if (node.operator === "||") return this.impliedByOutOfRange(node.left, accessStart) || this.impliedByOutOfRange(node.right, accessStart);
      if (node.operator === "&&") return this.impliedByOutOfRange(node.left, accessStart) && this.impliedByOutOfRange(node.right, accessStart);
      return false;
    }
    if (node.type === "UnaryExpression" && node.operator === "!" && isNode(node.argument)) return this.provesInRange(node.argument, accessStart);
    const compared = this.comparison(node, accessStart);
    if (compared?.lengthVsLiteral && this.index.kind === "literal") {
      const { op, n } = compared.lengthVsLiteral, k = this.index.value;
      return (op === "<" && n > k) || (op === "<=" && n >= k) || ((op === "===" || op === "==") && n === 0 && k === 0)
        || ((op === "!==" || op === "!=") && n > k);
    }
    if (compared?.indexVsLength) return compared.indexVsLength.op === ">=";
    if (node.type === "BinaryExpression" && isNode(node.left) && isNode(node.right)) {
      const op = node.operator;
      const [element, other] = this.denotesElement(node.left) ? [node.left, node.right]
        : this.denotesElement(node.right) ? [node.right, node.left] : [undefined, undefined];
      if (element && other) {
        if ((op === "===" || op === "==") && isUndefinedLiteral(other)) return true;
        if (op === "==" && isNullLiteral(other)) return true;
      }
      const typed = this.typeofArgument(node.left) ?? this.typeofArgument(node.right);
      const tag = this.typeofArgument(node.left) ? node.right : node.left;
      if (typed && this.denotesElement(typed)) return (op === "===" || op === "==") && stringLiteral(tag) === "undefined";
    }
    return false;
  }

  /** `for (let i = R.length - 1; i >= 0; i--)` binds the identifier index below the length. */
  reverseLoopBounds(loop: EstreeNode, accessStart: number): boolean {
    if (this.index.kind !== "identifier" || !isNode(loop.init) || !isNode(loop.test)) return false;
    const test = unwrap(loop.test);
    if (test.type !== "BinaryExpression" || !isNode(test.left) || !isNode(test.right)) return false;
    const lower = (this.denotesIndex(test.left) && test.operator === ">=" && numericLiteral(test.right) === 0)
      || (this.denotesIndex(test.left) && test.operator === ">" && unwrap(test.right).type === "UnaryExpression"
        && numericLiteral(unwrap(test.right).argument as EstreeNode) === 1);
    if (!lower || loop.init.type !== "VariableDeclaration" || !Array.isArray(loop.init.declarations)) return false;
    return loop.init.declarations.some((declarator) => {
      if (!isNode(declarator) || !isNode(declarator.id) || !this.denotesIndex(declarator.id) || !isNode(declarator.init)) return false;
      const init = unwrap(declarator.init);
      return init.type === "BinaryExpression" && init.operator === "-" && isNode(init.left) && isNode(init.right)
        && this.denotesLength(init.left, accessStart) && numericLiteral(init.right) === 1;
    });
  }

  /** `for (const [i, value] of R.entries())` binds the identifier index inside the receiver's range. */
  entriesLoopBounds(loop: EstreeNode): boolean {
    if (this.index.kind !== "identifier" || !isNode(loop.right) || !isNode(loop.left)) return false;
    const right = unwrap(loop.right);
    const callee = isNode(right.callee) ? unwrap(right.callee) : undefined;
    if (right.type !== "CallExpression" || callee?.type !== "MemberExpression" || callee.computed === true
      || !isNode(callee.property) || callee.property.name !== "entries" || !isNode(callee.object)
      || !this.denotesReceiver(callee.object)) return false;
    const declaration = loop.left.type === "VariableDeclaration" && Array.isArray(loop.left.declarations)
      ? loop.left.declarations.find(isNode) : undefined;
    const pattern = declaration && isNode(declaration.id) ? declaration.id : unwrap(loop.left);
    if (!pattern || pattern.type !== "ArrayPattern" || !Array.isArray(pattern.elements)) return false;
    const first = pattern.elements[0];
    return isNode(first) && this.denotesIndex(first);
  }
}

function endsAbruptly(statement: EstreeNode): boolean {
  if (abruptTypes.has(statement.type ?? "")) return true;
  if (statement.type === "BlockStatement" && Array.isArray(statement.body)) {
    const last = statement.body[statement.body.length - 1];
    return isNode(last) && endsAbruptly(last);
  }
  return false;
}

function statementList(parent: EstreeNode): EstreeNode[] | undefined {
  if ((parent.type === "BlockStatement" || parent.type === "Program" || parent.type === "StaticBlock" || parent.type === "SwitchCase")
    && Array.isArray(parent.type === "SwitchCase" ? parent.consequent : parent.body)) {
    return (parent.type === "SwitchCase" ? parent.consequent : parent.body) as EstreeNode[];
  }
  return undefined;
}

function ancestorsWithinFunction(node: EstreeNode, parents: ReadonlyMap<EstreeNode, EstreeNode>): EstreeNode[] {
  const chain: EstreeNode[] = [];
  let current: EstreeNode | undefined = node;
  while ((current = parents.get(current))) {
    if (functionTypes.has(current.type ?? "")) break;
    chain.push(current);
  }
  return chain;
}

function guarded(access: EstreeNode, context: AccessContext, parents: ReadonlyMap<EstreeNode, EstreeNode>): boolean {
  const at = access.start!;
  // A guard on an index binding that is later assigned does not survive to the access.
  if (context.index.kind === "identifier" && context.facts.reassigned.has(context.index.name)) return false;
  let child: EstreeNode = access;
  for (const ancestor of ancestorsWithinFunction(access, parents)) {
    switch (ancestor.type) {
      case "IfStatement":
      case "ConditionalExpression": {
        if (!isNode(ancestor.test)) break;
        if (child === ancestor.consequent && context.provesInRange(ancestor.test, at) && context.stable(child.start!, at)) return true;
        if (child === ancestor.alternate && context.impliedByOutOfRange(ancestor.test, at) && context.stable(child.start!, at)) return true;
        break;
      }
      case "LogicalExpression": {
        if (child !== ancestor.right || !isNode(ancestor.left)) break;
        if (ancestor.operator === "&&" && context.provesInRange(ancestor.left, at) && context.stable(child.start!, at)) return true;
        if (ancestor.operator === "||" && context.impliedByOutOfRange(ancestor.left, at) && context.stable(child.start!, at)) return true;
        break;
      }
      case "ForStatement":
      case "WhileStatement": {
        if (child === ancestor.test || child === ancestor.init) break;
        const body = isNode(ancestor.body) ? ancestor.body : undefined;
        if (!body || !context.stable(body.start!, at)) break;
        if (isNode(ancestor.test) && context.provesInRange(ancestor.test, at)) return true;
        if (ancestor.type === "ForStatement" && context.reverseLoopBounds(ancestor, at)) return true;
        break;
      }
      case "ForOfStatement": {
        const body = isNode(ancestor.body) ? ancestor.body : undefined;
        if (body && context.stable(body.start!, at) && context.entriesLoopBounds(ancestor)) return true;
        break;
      }
      default: {
        const siblings = statementList(ancestor);
        if (!siblings) break;
        const key = `${ancestor.start}:${context.canonicalReceiver}:${context.index.text}`;
        let ends = context.guardIndex.get(key);
        if (ends === undefined) {
          ends = [];
          for (const statement of siblings) {
            if (statement.type !== "IfStatement" || statement.alternate || !isNode(statement.test) || !isNode(statement.consequent)) continue;
            if (!endsAbruptly(statement.consequent)) continue;
            // The condition depends on the receiver and index, never on where the access sits, so one pass
            // over the block answers it for every access that indexes the same binding the same way.
            if (context.impliedByOutOfRange(statement.test, statement.end!)) ends.push(statement.end!);
          }
          context.guardIndex.set(key, ends);
        }
        // The nearest preceding guard has the smallest window, so if a length change falls inside it, it falls
        // inside every earlier guard's window too; checking that one is enough.
        let low = -1, high = ends.length;
        while (low + 1 < high) { const middle = (low + high) >>> 1; if (ends[middle]! <= child.start!) low = middle; else high = middle; }
        if (low >= 0 && context.stable(ends[low]!, at)) return true;
      }
    }
    child = ancestor;
  }
  return false;
}

export function analyzeCorsaSourceFacts(
  frontend: CorsaSourceFactsFrontend,
  fileName: string,
  sourceText: string,
  functions: readonly SyntaxFunction[],
  options: CorsaSourceFactsOptions,
): CorsaSourceFacts {
  const parsed = parseSync(fileName, sourceText, { lang: oxcLanguage(fileName) });
  const program = parsed.program as unknown as EstreeNode;
  const parents = new Map<EstreeNode, EstreeNode>();
  const computedMembers: EstreeNode[] = [];
  const arrayLiteralReceivers = new Set<number>();
  const assignmentTargets = new Set<string>();
  const readWriteTargets = new Set<string>();
  const observableWrites: Array<{ start: number; end: number; name: string; kind: "member" | "binding" }> = [];
  /** Every member expression a binding pattern or loop header writes, at any nesting depth. */
  /** Names a scope introduces directly: its own declarations, parameters, and a catch binding. */
  const scopeNames = (scope: EstreeNode): Set<string> => {
    const names = new Set<string>();
    const fromPattern = (pattern: unknown): void => {
      const node = pattern as EstreeNode | null | undefined;
      if (!node || typeof node.type !== "string") return;
      if (node.type === "Identifier" && typeof node.name === "string") { names.add(node.name); return; }
      for (const child of children(node)) fromPattern(child);
    };
    const fromStatement = (statement: EstreeNode): void => {
      if (statement.type === "VariableDeclaration" && Array.isArray(statement.declarations)) {
        for (const declarator of statement.declarations) if (isNode(declarator)) fromPattern(declarator.id);
      }
      if ((statement.type === "FunctionDeclaration" || statement.type === "ClassDeclaration") && isNode(statement.id)) {
        fromPattern(statement.id);
      }
    };
    if (functionTypes.has(scope.type ?? "")) {
      for (const parameter of (Array.isArray(scope.params) ? scope.params : [])) fromPattern(parameter);
      if (isNode(scope.id)) fromPattern(scope.id);
      // A `var` is hoisted to the whole function, so a block below the write still declares it here.
      walk(scope, (node) => { if (node.type === "VariableDeclaration" && node.kind === "var") fromStatement(node); });
      return names;
    }
    if (scope.type === "CatchClause") { fromPattern(scope.param); return names; }
    if (scope.type === "ForStatement" && isNode(scope.init)) fromStatement(scope.init);
    if ((scope.type === "ForOfStatement" || scope.type === "ForInStatement") && isNode(scope.left)) fromStatement(scope.left);
    for (const statement of (Array.isArray(scope.body) ? scope.body : [])) if (isNode(statement)) fromStatement(statement);
    return names;
  };
  /**
   * Whether an assignment to a bare name reaches a binding declared outside the boundary that runs it — a
   * module-scope variable, or an upvalue of an enclosing function. Either is visible to someone other than
   * this boundary once it returns, so the write is not private to the call.
   */
  const writesOuterBinding = (origin: EstreeNode, name: string): boolean => {
    for (let child = origin, parent = parents.get(child); parent; child = parent, parent = parents.get(parent)) {
      if (scopeNames(parent).has(name)) return false;
      if (functionTypes.has(parent.type ?? "")) return true;
    }
    // Reaching the program without a declaration means the name is a global or an import, and a write to
    // either is observable everywhere; module scope itself is the boundary that owns its own variables.
    return true;
  };
  /** Whether a write through `this` reaches an object that already existed when the boundary was entered. */
  const writesEstablishedObject = (node: EstreeNode, origin: EstreeNode): boolean => {
    let root = node;
    while (root.type === "MemberExpression" && isNode(root.object)) root = unwrap(root.object);
    if (root.type !== "ThisExpression") return true;
    for (let child = origin, parent = parents.get(child); parent; child = parent, parent = parents.get(parent)) {
      if (parent.type === "MethodDefinition") return parent.kind !== "constructor";
      if (parent.type === "PropertyDefinition" || parent.type === "AccessorProperty") return false;
      if (parent.type === "StaticBlock") return true;
    }
    return true;
  };
  /**
   * `origin` is the node this collection started from. The walk records a node's children when it visits that
   * node, so only the target handed in has an entry in `parents`; a name nested inside a pattern does not, and
   * the scope walk has to start from the target. They share a scope, so the answer is the same.
   */
  const collectWriteTargets = (target: EstreeNode, into: Set<string>, origin: EstreeNode = target): void => {
    const node = unwrap(target);
    if (node.type === "MemberExpression") {
      into.add(`${node.start}:${node.end}`);
      const property = isNode(node.property) ? node.property : undefined;
      const name = node.computed !== true && property?.type === "Identifier" && typeof property.name === "string"
        ? property.name : "a computed member";
      if (writesEstablishedObject(node, origin) && typeof node.start === "number" && typeof node.end === "number") {
        observableWrites.push({ start: node.start, end: node.end, name, kind: "member" });
      }
      return;
    }
    if (node.type === "Identifier" && typeof node.name === "string"
      && typeof node.start === "number" && typeof node.end === "number" && writesOuterBinding(origin, node.name)) {
      observableWrites.push({ start: node.start, end: node.end, name: node.name, kind: "binding" });
      return;
    }
    if (node.type === "ObjectPattern" && Array.isArray(node.properties)) {
      for (const property of node.properties) {
        if (!isNode(property)) continue;
        const value = property.type === "Property" ? property.value : property.type === "RestElement" ? property.argument : undefined;
        if (isNode(value)) collectWriteTargets(value, into, origin);
      }
      return;
    }
    if (node.type === "ArrayPattern" && Array.isArray(node.elements)) {
      for (const element of node.elements) if (isNode(element)) collectWriteTargets(element, into, origin);
      return;
    }
    if ((node.type === "RestElement" || node.type === "AssignmentPattern") && isNode(node.left ?? node.argument)) {
      collectWriteTargets((node.left ?? node.argument) as EstreeNode, into, origin);
    }
  };
  const inlineFunctionArguments = new Map<string, readonly (number | null)[]>();
  const callArgumentIdentifiers = new Map<string, readonly (number | null)[]>();
  const freshArguments = new Map<string, readonly boolean[]>();
  const assignedInlineFunctions = new Map<string, number>();
  const receiverTypes = new Map<string, CorsaApiTypeFact>();
  const throws: Array<{ start: number; calleePosition: number | null }> = [];
  const coercions: Array<{ start: number }> = [];
  /**
   * A throw escapes unless a `try` whose `catch` clause encloses it sits between it and the boundary that runs
   * it. The walk stops at the first function-like ancestor: a `catch` outside a callback cannot catch what that
   * callback throws when it later runs.
   */
  const caught = (node: EstreeNode): boolean => {
    for (let child = node, parent = parents.get(child); parent; child = parent, parent = parents.get(parent)) {
      if (parent.type === undefined || functionTypes.has(parent.type) || parent.type === "StaticBlock") return false;
      if (parent.type === "TryStatement" && parent.block === child && isNode(parent.handler)) return true;
    }
    return false;
  };
  /** The values a throw operand can actually produce. A reduced union would lose one of them. */
  const thrownOperands = (node: EstreeNode): EstreeNode[] => {
    if ((node.type === "ParenthesizedExpression" || node.type === "TSAsExpression" || node.type === "TSNonNullExpression"
      || node.type === "TSSatisfiesExpression" || node.type === "TSTypeAssertion") && isNode(node.expression)) {
      return thrownOperands(node.expression);
    }
    if (node.type === "ConditionalExpression" && isNode(node.consequent) && isNode(node.alternate)) {
      return [...thrownOperands(node.consequent), ...thrownOperands(node.alternate)];
    }
    if (node.type === "LogicalExpression" && isNode(node.left) && isNode(node.right)) {
      return [...thrownOperands(node.left), ...thrownOperands(node.right)];
    }
    if (node.type === "SequenceExpression" && Array.isArray(node.expressions)) {
      const last = node.expressions.filter(isNode).at(-1);
      return last ? thrownOperands(last) : [node];
    }
    return [node];
  };
  /**
   * A receiver the last identifier token already describes needs no range query. Everything else — a call
   * result, a coalesced value, an element, a parenthesized expression — is typed at its own exact range, which
   * the native tree authenticates. A kind the tree does not carry yields nothing rather than a nearby token.
   */
  const recordReceiverType = (site: EstreeNode, receiver: EstreeNode | undefined): void => {
    if (!receiver || !frontend.getTypeAtRange) return;
    if (typeof site.start !== "number" || typeof site.end !== "number") return;
    if (typeof receiver.start !== "number" || typeof receiver.end !== "number") return;
    if (receiverTokenPosition(receiver) !== undefined) return;
    const kind = nativeExpressionKind(receiver as never);
    if (kind === undefined) return;
    // A range the native tree cannot place unambiguously is one this path does not type. It is an ordinary
    // absence of evidence, so it must not end the whole check.
    let type: CorsaApiTypeFact | null = null;
    try { type = frontend.getTypeAtRange(fileName, { start: receiver.start, end: receiver.end }, kind); }
    catch { return; }
    if (type) receiverTypes.set(`${site.start}:${site.end}`, type);
  };
  /** The operators that convert an operand before they compute; `+` also admits a string, which is the point. */
  const coercingOperators = new Set(["+", "-", "*", "/", "%", "**", "<", ">", "<=", ">=", "<<", ">>", ">>>", "&", "|", "^", "==", "!="]);
  /** The type of an expression, or `null` when the native tree holds no node this path can name at that range. */
  const typeOfExpression = (node: EstreeNode): CorsaApiTypeFact | null => {
    if (typeof node.start !== "number" || typeof node.end !== "number") return null;
    const kind = nativeExpressionKind(node as never);
    if (kind === undefined) return null;
    try { return frontend.getTypeAtRange(fileName, { start: node.start, end: node.end }, kind); } catch { return null; }
  };
  /**
   * A literal is a primitive by syntax, which is more than any type query can establish: a BigInt literal has
   * no native expression kind at all, so asking about `0n` answers nothing and the operand would be admitted
   * as unresolved. A regular expression literal is an object and is not one of these.
   */
  const isPrimitiveLiteral = (node: EstreeNode): boolean => {
    // An untagged template produces a string whatever it substitutes; the substitutions' own conversions are
    // recorded when the template itself is visited, so the enclosing operator has nothing more to charge.
    if (node.type === "TemplateLiteral") return parents.get(node)?.type !== "TaggedTemplateExpression";
    return node.type === "Literal" && !("regex" in node);
  };
  /** Whether the type carries this member as the ECMAScript library declares it, rather than one of its own. */
  const standardMemberOf = (type: CorsaApiTypeFact, name: string): boolean => {
    const member = frontend.getPropertyOfType(type, name);
    return member !== null && declaredBy(member, ecmaScriptLibrary);
  };
  const recordCoercion = (site: EstreeNode, operands: readonly EstreeNode[]): void => {
    if (typeof site.start !== "number") return;
    if (operands.every((operand) => isPrimitiveLiteral(operand)
      || convertsWithoutUserCode(typeOfExpression(operand), standardMemberOf))) return;
    coercions.push({ start: site.start });
  };
  walk(program, (node) => {
    // A tagged template hands its substitutions to the tag unconverted, so no ToPrimitive step runs here.
    if (node.type === "TemplateLiteral" && parents.get(node)?.type !== "TaggedTemplateExpression") {
      const expressions = (Array.isArray(node.expressions) ? node.expressions : []).filter(isNode);
      if (expressions.length > 0) recordCoercion(node, expressions);
    }
    if ((node.type === "BinaryExpression" || node.type === "AssignmentExpression")
      && typeof node.operator === "string" && isNode(node.left) && isNode(node.right)) {
      const operator = node.type === "AssignmentExpression" ? node.operator.replace(/=$/, "") : node.operator;
      // An assignment's own `=` is not a conversion, and `+=` converts both sides exactly as `+` does.
      if (operator.length > 0 && coercingOperators.has(operator)) recordCoercion(node, [node.left, node.right]);
    }
    if (node.type === "ThrowStatement" && isNode(node.argument) && typeof node.start === "number" && !caught(node)) {
      for (const operand of thrownOperands(node.argument)) {
        const callee = operand.type === "NewExpression" && isNode(operand.callee) && operand.callee.type === "Identifier"
          && typeof operand.callee.start === "number" ? operand.callee.start : null;
        throws.push({ start: node.start, calleePosition: callee });
      }
    }
    if (node.type === "MemberExpression" && isNode(node.object)) recordReceiverType(node, node.object);
    if ((node.type === "CallExpression" || node.type === "NewExpression") && isNode(node.callee)) {
      const callee = unwrap(node.callee);
      if (callee.type === "MemberExpression" && isNode(callee.object)) recordReceiverType(node, callee.object);
    }
    if ((node.type === "CallExpression" || node.type === "NewExpression")
      && typeof node.start === "number" && typeof node.end === "number") {
      const args = (Array.isArray(node.arguments) ? node.arguments : []).filter(isNode);
      // A spread hides which argument a contract's callback index names, so the list is not published and the
      // call falls through to unknown. The key carries the whole span: an unparenthesized immediately invoked
      // callee shares its call's start offset.
      if (!args.some((argument) => argument.type === "SpreadElement")) {
        inlineFunctionArguments.set(`${node.start}:${node.end}`, args.map((argument) => {
          const value = unwrap(argument);
          return (value.type === "ArrowFunctionExpression" || value.type === "FunctionExpression") && typeof value.start === "number"
            ? value.start : null;
        }));
        callArgumentIdentifiers.set(`${node.start}:${node.end}`, args.map((argument) => {
          const value = unwrap(argument);
          return value.type === "Identifier" && typeof value.start === "number" ? value.start : null;
        }));
        freshArguments.set(`${node.start}:${node.end}`, args.map((argument) => {
          const value = unwrap(argument);
          // A literal with a spread copies out of something else, but the object it produces is still new.
          return value.type === "ObjectExpression" || value.type === "ArrayExpression";
        }));
      }
    }
    for (const child of children(node)) parents.set(child, node);
    if (node.type === "MemberExpression" && node.computed === true && isNode(node.object) && isNode(node.property)) computedMembers.push(node);
    if (node.type === "MemberExpression" && node.computed !== true && isNode(node.object) && isNode(node.property)
      && unwrap(node.object).type === "ArrayExpression" && typeof node.property.start === "number") {
      arrayLiteralReceivers.add(node.property.start);
    }
    // A plain assignment and a binding-pattern or loop target only write; a compound assignment and an update
    // read the member before writing it, so both halves of the contract apply.
    if (node.type === "AssignmentExpression" && isNode(node.left)) {
      collectWriteTargets(node.left, node.operator === "=" ? assignmentTargets : readWriteTargets);
      const value = isNode(node.right) ? unwrap(node.right) : undefined;
      if (node.operator === "=" && node.left.type === "MemberExpression"
        && typeof node.left.start === "number" && typeof node.left.end === "number"
        && (value?.type === "ArrowFunctionExpression" || value?.type === "FunctionExpression") && typeof value.start === "number") {
        assignedInlineFunctions.set(`${node.left.start}:${node.left.end}`, value.start);
      }
    }
    if (node.type === "UpdateExpression" && isNode(node.argument)) collectWriteTargets(node.argument, readWriteTargets);
    // Removing a property changes the object exactly as assigning one does; neither path recorded it at all.
    if (node.type === "UnaryExpression" && node.operator === "delete" && isNode(node.argument)) {
      collectWriteTargets(node.argument, assignmentTargets);
    }
    if ((node.type === "ForOfStatement" || node.type === "ForInStatement") && isNode(node.left)
      && node.left.type !== "VariableDeclaration") collectWriteTargets(node.left, assignmentTargets);
  });
  const text = (node: EstreeNode): string => sourceText.slice(node.start, node.end).replace(/\s+/g, "");
  // One line-offset table per file; computing a line by slicing the source is linear in the file per diagnostic.
  const lineStarts = [0];
  for (let index = 0; index < sourceText.length; index++) if (sourceText[index] === "\n") lineStarts.push(index + 1);
  const lineAt = (offset: number): number => {
    let low = 0, high = lineStarts.length;
    while (low + 1 < high) { const middle = (low + high) >>> 1; if (lineStarts[middle]! <= offset) low = middle; else high = middle; }
    return low + 1;
  };
  const admitted = new Set<string>();
  const admittedCalls = new Set<string>();
  const accessorMembers = new Set<string>();
  const constantKeyExclusions = new Set<string>();
  const constantKeySites: SyntaxSite[] = [];
  const diagnostics: BoundsDiagnostic[] = [];

  const receiverCache = new Map<EstreeNode, ResolvedReceiver | undefined>();
  const resolveReceiver = (receiver: EstreeNode): ResolvedReceiver | undefined => {
    if (receiverCache.has(receiver)) return receiverCache.get(receiver);
    const position = receiverTypePosition(receiver);
    let at = position;
    let type = position === undefined ? null : frontend.getTypeAtPosition(fileName, position);
    // A receiver the last identifier token does not describe — a call result, a coalesced value — is typed at
    // its own range instead, which the native tree authenticates. Without this an ordinary
    // `text.split(sep)[index]` stays an unsupported construct although every part of it is resolvable.
    if (type === null && typeof receiver.start === "number" && typeof receiver.end === "number") {
      const kind = nativeExpressionKind(receiver as never);
      if (kind !== undefined) {
        try { type = frontend.getTypeAtRange(fileName, { start: receiver.start, end: receiver.end }, kind); }
        catch { type = null; }
        if (type !== null) at = receiver.start;
      }
    }
    const resolved = type === null || at === undefined
      ? undefined : { type, symbol: frontend.getSymbolOfType(type), position: at };
    receiverCache.set(receiver, resolved);
    return resolved;
  };

  const collectionCache = new Map<string, boolean>();
  /**
   * The `lib.dom` live-collection shape: a `length` and an `item` member both declared by the DOM library.
   * Indexing one past its length yields `undefined` even though TypeScript types the element as present.
   */
  const isIndexedCollection = (resolved: ResolvedReceiver): boolean => {
    const cached = collectionCache.get(resolved.type.id);
    if (cached !== undefined) return cached;
    const collection = declaredBy(frontend.getPropertyOfType(resolved.type, "length"), domLibrary)
      && declaredBy(frontend.getPropertyOfType(resolved.type, "item"), domLibrary);
    collectionCache.set(resolved.type.id, collection);
    return collection;
  };

  const domMemberNames = [...new Set([...options.domContractKeys].map((key) => key.slice(key.indexOf("#") + 1)))];
  const selectsDomContractKey = options.selectsDomContractKey
    ?? ((ownerName: string, memberName: string) => options.domContractKeys.has(`${ownerName}#${memberName}`));
  const domSelectableCache = new Map<string, boolean>();
  /** A receiver that declares any reviewed `lib.dom` member can select a contract through a key this fragment cannot read. */
  const selectsDomContract = (resolved: ResolvedReceiver): boolean => {
    const cached = domSelectableCache.get(resolved.type.id);
    if (cached !== undefined) return cached;
    const selectable = isArrayReceiver(resolved)
      ? false
      : domMemberNames.some((name) => declaredBy(frontend.getPropertyOfType(resolved.type, name), domLibrary));
    domSelectableCache.set(resolved.type.id, selectable);
    return selectable;
  };

  // The cache holds the collected context only. Returning a closure over the collector would let the collector
  // escape through it, and the whole-source effect analysis cannot reduce an escaping alias to one root; the
  // context already carries the alias map the canonical resolution reads.
  // Keyed by the function root's start offset: a syntax node is not reducible to one addressable root, and a
  // cache keyed by one is an alias the whole-source effect analysis cannot name.
  const contextCache = new Map<number, FunctionContext>();
  const guardIndex = new Map<string, number[]>();
  const factsOf = (root: EstreeNode, cache: Map<number, FunctionContext>): FunctionContext => {
    const cached = cache.get(root.start ?? -1);
    if (cached) return cached;
    const context = new FunctionFacts().collect(root, parents, text);
    cache.set(root.start ?? -1, context);
    return context;
  };
  const functionRootOf = (node: EstreeNode): EstreeNode | undefined => {
    let current: EstreeNode | undefined = node;
    while ((current = parents.get(current))) if (functionTypes.has(current.type ?? "")) return current;
    return undefined;
  };
  const splitVerified = new Map<string, boolean>();

  for (const member of computedMembers) {
    const receiver = member.object as EstreeNode;
    const resolved = resolveReceiver(receiver);
    const parent = parents.get(member);
    const property = member.property as EstreeNode;
    const isCallee = parent !== undefined && (parent.type === "CallExpression" || parent.type === "NewExpression") && parent.callee === member;
    const exclusionKey = isCallee ? `${parent.start}:${parent.end}` : `${member.start}:${member.end}`;
    const literalProperty = property.type === "Literal" || property.type === "NumericLiteral" || property.type === "StringLiteral";
    const keyPosition = literalProperty ? undefined : receiverTypePosition(property);
    const keyType = keyPosition === undefined ? null : frontend.getTypeAtPosition(fileName, keyPosition);
    const constant = literalKey(keyType);
    const numericKey = (property.type === "Literal" || property.type === "NumericLiteral") && typeof property.value === "number"
      ? true : isNumericKey(keyType);

    if (resolved && !isOpaque(resolved.type)) {
      const admit = (): void => { if (isCallee) admittedCalls.add(exclusionKey); else admitted.add(exclusionKey); };
      // A literal-typed key names exactly one member; republish it as that static site when a contract exists.
      const resolvedMember = constant === undefined ? null : frontend.getPropertyOfType(resolved.type, String(constant));
      if (resolvedMember && declaredBy(resolvedMember, domLibrary)) {
        if (selectsDomContractKey(resolved.symbol?.name ?? "", String(constant)) && typeof property.start === "number") {
          constantKeyExclusions.add(exclusionKey);
          constantKeySites.push({
            kind: isCallee ? (parent.type === "NewExpression" ? "construct" : "call") : "property",
            start: isCallee ? parent.start! : member.start!, end: isCallee ? parent.end! : member.end!,
            calleePosition: property.start, receiverPosition: resolved.position, name: String(constant),
          });
        }
      // An accessor is a body this fragment does not analyze. The site itself is ordinary syntax, so it is
      // admitted, but naming it proves nothing about its effects and the enclosing function stays unknown.
      } else if (resolvedMember !== null) {
        if (isAccessorSymbol(resolvedMember)) accessorMembers.add(exclusionKey);
        else admit();
      }
      // A numeric key selects an element only where the numeric index signature is the element accessor; on a
      // receiver such as `Storage` a numeric key still reaches the effect-bearing string index signature.
      else if ((numericKey && (isArrayReceiver(resolved) || isIndexedCollection(resolved))) || !selectsDomContract(resolved)) admit();
    }

    const dereferenced = parent !== undefined && parent.optional !== true
      && ((parent.type === "MemberExpression" && parent.object === member) || (parent.type === "CallExpression" && parent.callee === member));
    if (!dereferenced || !resolved || !(isArrayReceiver(resolved) || isIndexedCollection(resolved))) continue;
    const index = indexOf(property, text(property), constant);
    if (!index) continue;
    const functionRoot = functionRootOf(member);
    if (!functionRoot) continue;
    const facts = factsOf(functionRoot, contextCache);
    const canonicalize = (name: string): string => canonicalName(facts.receiverAliases, name);
    const receiverText = text(receiver);
    const canonicalReceiver = unwrap(receiver).type === "Identifier" ? canonicalize(text(unwrap(receiver))) : receiverText;
    const context = new AccessContext(sourceText, receiverText, text(member), index, facts, canonicalReceiver, canonicalize, guardIndex);
    if (guarded(member, context, parents)) continue;
    if (index.kind === "literal") {
      const minimum = facts.splitMinimums.get(canonicalReceiver) ?? 0;
      if (index.value < minimum) {
        const verified = splitVerified.get(canonicalReceiver) ?? (() => {
          const declarator = findDeclarator(functionRoot, canonicalReceiver);
          const result = declarator !== undefined && isNode(declarator.init)
            && FunctionFacts.resolvesToStringSplit(frontend, fileName, unwrap(declarator.init));
          splitVerified.set(canonicalReceiver, result);
          return result;
        })();
        if (verified) continue;
      }
    }
    const owner = enclosingFunction(functions, member.start!);
    const typeText = resolved.type.texts[0] ?? "array";
    const shape = isArrayReceiver(resolved) ? "array type" : "indexed DOM collection type";
    diagnostics.push({
      start: member.start!, end: member.end!,
      line: lineAt(member.start!),
      functionName: owner?.name ?? "<module>",
      message: `\`${sourceText.slice(member.start, member.end)}\` is dereferenced without an index guard; the element may be undefined at runtime`,
      notes: [
        { label: "because", detail: `${receiverText} has ${shape} ${typeText} and no enclosing loop bound, conditional guard, or early exit proves index ${index.text} is below its length at this point` },
        { label: "hint", detail: `check ${receiverText}.length or the element before the access, use optional chaining, or enable noUncheckedIndexedAccess so TypeScript reports the possibly undefined element` },
      ],
    });
  }
  return { admittedComputedProperties: admitted, admittedComputedCalls: admittedCalls, accessorComputedMembers: accessorMembers, constantKeyExclusions, constantKeySites, arrayLiteralReceivers, assignmentTargets, readWriteTargets, observableWrites, receiverTypes, throws, coercions,
    dependencies: runtimeModuleDependencies(parsed.program as never, sourceText), inlineFunctionArguments, callArgumentIdentifiers, freshArguments, assignedInlineFunctions, diagnostics };
}

function findDeclarator(root: EstreeNode, name: string): EstreeNode | undefined {
  let found: EstreeNode | undefined;
  walk(root, (node) => {
    if (found || node.type !== "VariableDeclarator" || !isNode(node.id)) return;
    if (node.id.type === "Identifier" && node.id.name === name) found = node;
  });
  return found;
}
