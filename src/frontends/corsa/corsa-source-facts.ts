import { parseSync } from "oxc-parser";
import type { DiagnosticNote } from "../../support/diagnostic-contracts.js";
import { enclosingFunction, receiverTokenPosition } from "../oxc-syntax.js";
import type { SyntaxFunction, SyntaxSite } from "../syntax-facts-contract.js";
import type { CorsaApiFrontend, CorsaApiSymbolFact, CorsaApiTypeFact } from "./corsa-api-frontend.js";

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
export type CorsaSourceFactsFrontend = Pick<CorsaApiFrontend, "getTypeAtPosition" | "getSymbolOfType" | "getPropertyOfType">;

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
  /** `${start}:${end}` keys of member expressions written but not read, so the site selects the write semantics. */
  readonly assignmentTargets: ReadonlySet<string>;
  /** `${start}:${end}` keys of member expressions both read and written, such as a compound assignment. */
  readonly readWriteTargets: ReadonlySet<string>;
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
  readonly guardIndex: Map<string, number[]>;
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

  constructor(private readonly text: (node: EstreeNode) => string) {}

  private note(receiver: string, position: number): void {
    const list = this.lengthChanges.get(receiver);
    if (list) list.push(position); else this.lengthChanges.set(receiver, [position]);
  }

  /** Resolve an alias chain to the binding the guard and the access must agree on. */
  canonical(name: string): string {
    const seen = new Set<string>();
    let current = name;
    while (!seen.has(current)) {
      seen.add(current);
      const next = this.receiverAliases.get(current);
      if (next === undefined) break;
      current = next;
    }
    return current;
  }

  collect(root: EstreeNode, parents: ReadonlyMap<EstreeNode, EstreeNode>): FunctionContext {
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
            this.lengthSnapshots.set(name, { receiver: this.text(init.object), from: node.end });
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
          this.note(this.text(target.object), node.start);
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
        if (target.type === "MemberExpression" && isNode(target.object)) this.escaped.add(this.text(target.object));
      }
      if (node.type === "CallExpression") {
        const callee = isNode(node.callee) ? unwrap(node.callee) : undefined;
        if (callee?.type === "MemberExpression" && callee.computed !== true && isNode(callee.object) && isNode(callee.property)
          && typeof callee.property.name === "string" && typeof node.start === "number"
          && lengthReducingMethods.has(callee.property.name)) {
          this.note(this.text(callee.object), node.start);
        }
        // An array handed to code outside this fragment can be mutated or aliased there.
        for (const argument of Array.isArray(node.arguments) ? node.arguments : []) {
          if (!isNode(argument)) continue;
          const value = unwrap(argument);
          if (value.type === "Identifier" && typeof value.name === "string") this.escaped.add(value.name);
          if (value.type === "SpreadElement" && isNode(value.argument) && unwrap(value.argument).type === "Identifier") {
            this.escaped.add(this.text(unwrap(value.argument)));
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
    return {
      receiverAliases: this.receiverAliases,
      lengthSnapshots: this.lengthSnapshots,
      lengthChanges: this.lengthChanges,
      escaped: this.escaped,
      reassigned: this.reassigned,
      everAssigned: this.everAssigned,
      splitMinimums,
      guardIndex: new Map<string, number[]>(),
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
        let ends = context.facts.guardIndex.get(key);
        if (ends === undefined) {
          ends = [];
          for (const statement of siblings) {
            if (statement.type !== "IfStatement" || statement.alternate || !isNode(statement.test) || !isNode(statement.consequent)) continue;
            if (!endsAbruptly(statement.consequent)) continue;
            // The condition depends on the receiver and index, never on where the access sits, so one pass
            // over the block answers it for every access that indexes the same binding the same way.
            if (context.impliedByOutOfRange(statement.test, statement.end!)) ends.push(statement.end!);
          }
          context.facts.guardIndex.set(key, ends);
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
  const parsed = parseSync(fileName, sourceText, { lang: fileName.endsWith(".tsx") ? "tsx" : "ts" });
  const program = parsed.program as unknown as EstreeNode;
  const parents = new Map<EstreeNode, EstreeNode>();
  const computedMembers: EstreeNode[] = [];
  const assignmentTargets = new Set<string>();
  const readWriteTargets = new Set<string>();
  /** Every member expression a binding pattern or loop header writes, at any nesting depth. */
  const collectWriteTargets = (target: EstreeNode, into: Set<string>): void => {
    const node = unwrap(target);
    if (node.type === "MemberExpression") { into.add(`${node.start}:${node.end}`); return; }
    if (node.type === "ObjectPattern" && Array.isArray(node.properties)) {
      for (const property of node.properties) {
        if (!isNode(property)) continue;
        const value = property.type === "Property" ? property.value : property.type === "RestElement" ? property.argument : undefined;
        if (isNode(value)) collectWriteTargets(value, into);
      }
      return;
    }
    if (node.type === "ArrayPattern" && Array.isArray(node.elements)) {
      for (const element of node.elements) if (isNode(element)) collectWriteTargets(element, into);
      return;
    }
    if ((node.type === "RestElement" || node.type === "AssignmentPattern") && isNode(node.left ?? node.argument)) {
      collectWriteTargets((node.left ?? node.argument) as EstreeNode, into);
    }
  };
  const inlineFunctionArguments = new Map<string, readonly (number | null)[]>();
  const callArgumentIdentifiers = new Map<string, readonly (number | null)[]>();
  const assignedInlineFunctions = new Map<string, number>();
  walk(program, (node) => {
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
      }
    }
    for (const child of children(node)) parents.set(child, node);
    if (node.type === "MemberExpression" && node.computed === true && isNode(node.object) && isNode(node.property)) computedMembers.push(node);
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
    const type = position === undefined ? null : frontend.getTypeAtPosition(fileName, position);
    const resolved = type === null || position === undefined
      ? undefined : { type, symbol: frontend.getSymbolOfType(type), position };
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

  const factsCache = new Map<EstreeNode, { context: FunctionContext; canonicalize: (name: string) => string }>();
  const factsOf = (root: EstreeNode) => {
    const cached = factsCache.get(root);
    if (cached) return cached;
    const facts = new FunctionFacts(text);
    const context = facts.collect(root, parents);
    const entry = { context, canonicalize: (name: string) => facts.canonical(name) };
    factsCache.set(root, entry);
    return entry;
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
    const { context: facts, canonicalize } = factsOf(functionRoot);
    const receiverText = text(receiver);
    const canonicalReceiver = unwrap(receiver).type === "Identifier" ? canonicalize(text(unwrap(receiver))) : receiverText;
    const context = new AccessContext(sourceText, receiverText, text(member), index, facts, canonicalReceiver, canonicalize);
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
  return { admittedComputedProperties: admitted, admittedComputedCalls: admittedCalls, accessorComputedMembers: accessorMembers, constantKeyExclusions, constantKeySites, assignmentTargets, readWriteTargets, inlineFunctionArguments, callArgumentIdentifiers, assignedInlineFunctions, diagnostics };
}

function findDeclarator(root: EstreeNode, name: string): EstreeNode | undefined {
  let found: EstreeNode | undefined;
  walk(root, (node) => {
    if (found || node.type !== "VariableDeclarator" || !isNode(node.id)) return;
    if (node.id.type === "Identifier" && node.id.name === name) found = node;
  });
  return found;
}
