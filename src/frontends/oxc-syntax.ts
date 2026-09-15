import { createHash } from "node:crypto";
import { parseSync } from "oxc-parser";
import { oxcLanguage } from "./oxc/source.js";
import oxcParserMetadata from "oxc-parser/package.json" with { type: "json" };
import { syntaxFactsSchema } from "./syntax-facts-contract.js";
import type {
  SyntaxFactExclusion,
  SyntaxFacts,
  SyntaxFactsCoverageDomain,
  SyntaxFunction,
  SyntaxFunctionKind,
  SyntaxSite,
} from "./syntax-facts-contract.js";

export { parseSyntaxFacts, syntaxFactsCoverageDomains, syntaxFactsSchema } from "./syntax-facts-contract.js";
export type {
  SyntaxFactExclusion,
  SyntaxFactExclusionReason,
  SyntaxFacts,
  SyntaxFactsCoverageDomain,
  SyntaxFactsCoverageEntry,
  SyntaxFunction,
  SyntaxFunctionKind,
  SyntaxSite,
} from "./syntax-facts-contract.js";

interface EstreeNode {
  type?: string;
  start?: number;
  end?: number;
  name?: string;
  computed?: boolean;
  kind?: string;
  [key: string]: unknown;
}

const oxcParserVersion = oxcParserMetadata.version;

function isNode(value: unknown): value is EstreeNode {
  return Boolean(value && typeof value === "object" && typeof (value as EstreeNode).type === "string");
}

function walk(node: unknown, visit: (node: EstreeNode) => void): void {
  if (!isNode(node)) return;
  visit(node);
  for (const [key, child] of Object.entries(node)) {
    if (key === "type" || key === "start" || key === "end" || key === "loc" || key === "range") continue;
    if (Array.isArray(child)) for (const item of child) walk(item, visit);
    else walk(child, visit);
  }
}

function identifierName(node: EstreeNode | undefined): string | undefined {
  return node?.type === "Identifier" && typeof node.name === "string" ? node.name : undefined;
}

function staticName(node: EstreeNode | undefined, computed = false): string | undefined {
  if (!node) return undefined;
  if (!computed && (node.type === "Identifier" || node.type === "PrivateIdentifier") && typeof node.name === "string") return node.name;
  if ((node.type === "Literal" || node.type === "StringLiteral" || node.type === "NumericLiteral")
    && (typeof node.value === "string" || typeof node.value === "number")) return String(node.value);
  return undefined;
}

function parameterName(node: EstreeNode): string | undefined {
  if (node.type === "Identifier") return identifierName(node);
  if (node.type === "TSParameterProperty" && isNode(node.parameter)) return parameterName(node.parameter);
  if (node.type === "AssignmentPattern" && isNode(node.left)) return parameterName(node.left);
  if (node.type === "RestElement" && isNode(node.argument)) return parameterName(node.argument);
  return undefined;
}

function functionParameters(node: EstreeNode): string[] {
  const params = Array.isArray(node.params) ? node.params : [];
  return params.flatMap((parameter) => {
    if (!isNode(parameter)) return [];
    const name = parameterName(parameter);
    return name ? [name] : [];
  });
}

function classBodyOwner(body: EstreeNode, parents: Map<EstreeNode, EstreeNode>): string | undefined {
  const declaration = parents.get(body);
  if (!declaration || (declaration.type !== "ClassDeclaration" && declaration.type !== "ClassExpression")) return undefined;
  const direct = identifierName(isNode(declaration.id) ? declaration.id : undefined);
  if (direct) return direct;
  const parent = parents.get(declaration);
  return parent?.type === "VariableDeclarator" ? identifierName(isNode(parent.id) ? parent.id : undefined) : undefined;
}

function classOwner(method: EstreeNode, parents: Map<EstreeNode, EstreeNode>): string | undefined {
  const body = parents.get(method), declaration = body && parents.get(body);
  if (!declaration || (declaration.type !== "ClassDeclaration" && declaration.type !== "ClassExpression")) return undefined;
  const direct = identifierName(isNode(declaration.id) ? declaration.id : undefined);
  if (direct) return direct;
  const parent = parents.get(declaration);
  return parent?.type === "VariableDeclarator" ? identifierName(isNode(parent.id) ? parent.id : undefined) : undefined;
}

function functionFact(
  node: EstreeNode,
  parents: Map<EstreeNode, EstreeNode>,
): { fact?: SyntaxFunction; exclusion?: SyntaxFactExclusion } {
  if (typeof node.start !== "number" || typeof node.end !== "number") return {};
  if (node.type === "FunctionDeclaration") {
    const name = identifierName(isNode(node.id) ? node.id : undefined) ?? "<anonymous>";
    return isNode(node.body) ? {
      fact: { name, kind: "function", start: node.start, end: node.end, parameters: functionParameters(node) },
    } : {};
  }
  if (node.type !== "ArrowFunctionExpression" && node.type !== "FunctionExpression") return {};
  const parent = parents.get(node);
  if (parent?.type === "VariableDeclarator") {
    const name = identifierName(isNode(parent.id) ? parent.id : undefined);
    if (!name) return {};
    return { fact: {
      name,
      kind: node.type === "ArrowFunctionExpression" ? "arrow" : "function-expression",
      start: node.start,
      end: node.end,
      parameters: functionParameters(node),
    } };
  }
  if (parent?.type === "MethodDefinition") {
    const methodStart = typeof parent.start === "number" ? parent.start : node.start;
    const methodEnd = typeof parent.end === "number" ? parent.end : node.end;
    // A constructor is a named class member boundary; the published v1 kind inventory has no separate member.
    const key = parent.kind === "constructor" ? "constructor" : staticName(isNode(parent.key) ? parent.key : undefined, parent.computed === true);
    if (!key) return { exclusion: { reason: "computed-function-name", span: { start: methodStart, end: methodEnd } } };
    const owner = classOwner(parent, parents);
    const kind: SyntaxFunctionKind = parent.kind === "get" ? "getter" : parent.kind === "set" ? "setter" : "method";
    return { fact: {
      name: owner ? `${owner}.${key}` : key,
      kind,
      start: methodStart,
      end: methodEnd,
      parameters: functionParameters(node),
    } };
  }
  if (parent?.type === "Property") {
    const key = staticName(isNode(parent.key) ? parent.key : undefined, parent.computed === true);
    if (!key) return { exclusion: { reason: "computed-function-name", span: { start: node.start, end: node.end } } };
    // Accessor reads/writes need effect composition before their exclusion can be removed.
    if (parent.kind === "get" || parent.kind === "set") return {
      exclusion: { reason: "object-member-function", span: { start: node.start, end: node.end } },
    };
    return { fact: {
      name: key,
      kind: parent.method === true ? "method" : node.type === "ArrowFunctionExpression" ? "arrow" : "function-expression",
      start: node.start, end: node.end, parameters: functionParameters(node),
    } };
  }
  return { fact: {
    name: node.type === "FunctionExpression"
      ? identifierName(isNode(node.id) ? node.id : undefined) ?? "<anonymous>"
      : "<anonymous>",
    kind: node.type === "ArrowFunctionExpression" ? "arrow" : "function-expression",
    start: node.start,
    end: node.end,
    parameters: functionParameters(node),
  } };
}

/** The constructor member a class body declares, identified by its own node rather than by a rendered name. */
export function declaredConstructor(body: EstreeNode): EstreeNode | undefined {
  const members = Array.isArray(body.body) ? body.body : [];
  for (const member of members) {
    if (isNode(member) && member.type === "MethodDefinition" && member.kind === "constructor"
      && typeof member.start === "number" && typeof member.end === "number") return member;
  }
  return undefined;
}

/**
 * The span the boundary a construction runs occupies, or `undefined` when a construction of this class runs
 * nothing of its own. An instance field — a plain one or an `accessor` one — runs at construction, so the
 * boundary widens to the whole class body; otherwise it is exactly the declared constructor. Both the syntax
 * pass and the checker locate the same fact through this one rule.
 */
export function constructionBoundarySpan(body: EstreeNode): { start: number; end: number } | undefined {
  const members = Array.isArray(body.body) ? body.body : [];
  const initializes = members.some((member) => isNode(member)
    && (member.type === "PropertyDefinition" || member.type === "AccessorProperty")
    && isNode(member.value) && member.static !== true);
  if (initializes && typeof body.start === "number" && typeof body.end === "number") {
    return { start: body.start, end: body.end };
  }
  const declared = declaredConstructor(body);
  return declared === undefined ? undefined : { start: declared.start as number, end: declared.end as number };
}

function unwrapCallee(callee: EstreeNode): EstreeNode {
  let current = callee;
  while ((current.type === "TSNonNullExpression" || current.type === "ParenthesizedExpression" || current.type === "TSAsExpression"
    || current.type === "TSSatisfiesExpression") && isNode(current.expression)) current = current.expression;
  return current;
}

/**
 * The offset whose type is the receiver's own type: the last identifier token of a member chain, or the
 * identifier itself. `env.doc.cookie` must be typed at `doc`, not at `env`. A receiver with no such token
 * (a call result, a computed member) falls back to its start, which types a chained primitive correctly and
 * otherwise resolves no contract.
 */
export function receiverTokenPosition(receiver: EstreeNode | undefined): number | undefined {
  if (!receiver) return undefined;
  let node = receiver;
  while ((node.type === "TSNonNullExpression" || node.type === "TSAsExpression" || node.type === "TSSatisfiesExpression"
    || node.type === "TSTypeAssertion" || node.type === "ParenthesizedExpression") && isNode(node.expression)) {
    node = node.expression;
  }
  if (node.type === "Identifier" || node.type === "ThisExpression") return node.start;
  if (node.type === "MemberExpression" && node.computed !== true && isNode(node.property)
    && (node.property.type === "Identifier" || node.property.type === "PrivateIdentifier")) return node.property.start;
  return undefined;
}

function callSite(node: EstreeNode): SyntaxSite | undefined {
  const rawCallee = isNode(node.callee) ? node.callee : undefined;
  if (!rawCallee || typeof node.start !== "number" || typeof node.end !== "number") return undefined;
  const callee = unwrapCallee(rawCallee);
  if (callee.type === "Identifier" && typeof callee.start === "number") {
    const name = identifierName(callee);
    if (!name) return undefined;
    return { kind: node.type === "NewExpression" ? "construct" : "call", start: node.start, end: node.end, calleePosition: callee.start, name };
  }
  // A call result used as a callee has no declaration to resolve; the site is kept so its caller becomes unknown evidence.
  if (callee.type === "CallExpression" && typeof callee.start === "number") {
    return { kind: node.type === "NewExpression" ? "construct" : "call", start: node.start, end: node.end, calleePosition: callee.start, name: "<dynamic>" };
  }
  // `super(...)` resolves to no symbol at its keyword and therefore stays an unknown call rather than missing coverage.
  if (callee.type === "Super" && typeof callee.start === "number" && node.type === "CallExpression") {
    return { kind: "call", start: node.start, end: node.end, calleePosition: callee.start, name: "super" };
  }
  const inline = inlineFunctionCallee(callee);
  if (inline && node.type === "CallExpression") {
    // The callee is its own function boundary; its position links the call to that boundary's summary.
    return { kind: "call", start: node.start, end: node.end, calleePosition: inline.start!, name: "<iife>" };
  }
  const unwrapped = callee.type === "TSNonNullExpression" && isNode(callee.expression) ? callee.expression : callee;
  if (unwrapped.type !== "MemberExpression" || !isNode(unwrapped.object) || !isNode(unwrapped.property)) return undefined;
  if (typeof unwrapped.property.start !== "number" || typeof unwrapped.object.start !== "number") return undefined;
  const name = staticName(unwrapped.property, unwrapped.computed === true);
  if (!name) return undefined;
  return {
    kind: node.type === "NewExpression" ? "construct" : "call",
    start: node.start,
    end: node.end,
    calleePosition: unwrapped.property.start,
    receiverPosition: receiverTokenPosition(unwrapped.object) ?? unwrapped.object.start,
    name,
  };
}

function inlineFunctionCallee(callee: EstreeNode): EstreeNode | undefined {
  let current = callee;
  while (current.type === "ParenthesizedExpression" && isNode(current.expression)) current = current.expression;
  return (current.type === "ArrowFunctionExpression" || current.type === "FunctionExpression") && typeof current.start === "number" ? current : undefined;
}

/** A member used as an argument is still a read, even when its parent is a call. */
function isCallTarget(node: EstreeNode, parents: ReadonlyMap<EstreeNode, EstreeNode>): boolean {
  const parent = parents.get(node);
  const target = parent?.type === "TSNonNullExpression" ? parent : node;
  const call = target === node ? parent : parents.get(target);
  return (call?.type === "CallExpression" || call?.type === "NewExpression") && call.callee === target;
}

/** Parse TypeScript with Oxc into the versioned, compiler-neutral syntax observation contract. */
export function collectSyntaxFacts(fileName: string, sourceText: string): SyntaxFacts {
  const lang = oxcLanguage(fileName);
  const language = lang === "tsx" ? "tsx" as const : "typescript" as const;
  const parsed = parseSync(fileName, sourceText, { lang });
  const functions: SyntaxFunction[] = [], sites: SyntaxSite[] = [];
  const parents = new Map<EstreeNode, EstreeNode>();
  const exclusions = new Map<SyntaxFactsCoverageDomain, SyntaxFactExclusion[]>([
    ["function-boundaries", []], ["call-sites", []], ["construct-sites", []], ["property-sites", []],
  ]);
  walk(parsed.program, (node) => {
    for (const child of Object.values(node)) {
      if (isNode(child)) parents.set(child, node);
      if (Array.isArray(child)) for (const item of child) if (isNode(item)) parents.set(item, node);
    }
  });
  walk(parsed.program, (node) => {
    const boundary = functionFact(node, parents);
    if (boundary.fact) functions.push(boundary.fact);
    if (boundary.exclusion) exclusions.get("function-boundaries")!.push(boundary.exclusion);
    if (node.type === "CallExpression" || node.type === "NewExpression") {
      const callee = isNode(node.callee) ? node.callee : undefined;
      const unwrapped = callee?.type === "TSNonNullExpression" && isNode(callee.expression) ? callee.expression : callee;
      if (unwrapped?.type === "MemberExpression" && unwrapped.computed
        && !staticName(isNode(unwrapped.property) ? unwrapped.property : undefined, true)
        && typeof node.start === "number" && typeof node.end === "number") {
        exclusions.get(node.type === "NewExpression" ? "construct-sites" : "call-sites")!.push({
          reason: node.type === "NewExpression" ? "computed-construct-target" : "computed-call-target",
          span: { start: node.start, end: node.end },
        });
      } else {
        const site = callSite(node);
        if (site) sites.push(site);
        else if (typeof node.start === "number" && typeof node.end === "number") {
          exclusions.get(node.type === "NewExpression" ? "construct-sites" : "call-sites")!.push({
            reason: node.type === "NewExpression" ? "unsupported-construct-target" : "unsupported-call-target",
            span: { start: node.start, end: node.end },
          });
        }
      }
    }
    if (node.type === "TaggedTemplateExpression" && typeof node.start === "number" && typeof node.end === "number") {
      exclusions.get("call-sites")!.push({ reason: "tagged-template", span: { start: node.start, end: node.end } });
    }
    if (node.type === "ImportExpression" && typeof node.start === "number" && typeof node.end === "number") {
      exclusions.get("call-sites")!.push({ reason: "dynamic-import", span: { start: node.start, end: node.end } });
    }
    if (node.type === "MemberExpression" && node.computed
      && !staticName(isNode(node.property) ? node.property : undefined, true)
      && typeof node.start === "number" && typeof node.end === "number") {
      if (!isCallTarget(node, parents)) {
        exclusions.get("property-sites")!.push({ reason: "computed-property", span: { start: node.start, end: node.end } });
      }
    } else if (node.type === "MemberExpression" && isNode(node.object) && isNode(node.property)
      && typeof node.start === "number" && typeof node.end === "number"
      && typeof node.object.start === "number" && typeof node.property.start === "number") {
      if (isCallTarget(node, parents)) return;
      const name = staticName(node.property, node.computed === true);
      if (name) sites.push({
        kind: "property", start: node.start, end: node.end,
        calleePosition: node.property.start,
        receiverPosition: receiverTokenPosition(node.object) ?? node.object.start,
        name,
      });
    }
  });
  // An instance field initializer runs outside every method body but inside the class, at construction. Its
  // operations belong to the construction boundary, so the constructor covers the class body; without this they
  // would have no enclosing function and disappear. A static block and a static field initializer run when the
  // class declaration is evaluated instead, which is the enclosing scope's work rather than a construction's, so
  // they do not open this boundary — the scope that declares the class keeps them.
  walk(parsed.program, (node) => {
    if (node.type !== "ClassBody" || !Array.isArray(node.body)) return;
    const span = constructionBoundarySpan(node);
    if (span === undefined || span.start !== node.start || span.end !== node.end) return;
    const declared = declaredConstructor(node);
    const owner = classBodyOwner(node, parents);
    const name = owner ? `${owner}.constructor` : "constructor";
    if (declared) {
      // The declared constructor's own span identifies it; a nested class may carry a fact of the same name.
      const existing = functions.findIndex((item) => item.start === declared.start && item.end === declared.end);
      if (existing >= 0) functions[existing] = { ...functions[existing]!, start: span.start, end: span.end };
      return;
    }
    functions.push({ name, kind: "method", start: span.start, end: span.end, parameters: [] });
  });
  functions.sort((left, right) => left.start - right.start || left.end - right.end || left.kind.localeCompare(right.kind));
  sites.sort((left, right) => left.start - right.start || left.end - right.end || left.kind.localeCompare(right.kind));
  for (const values of exclusions.values()) values.sort((left, right) => left.span.start - right.span.start || left.reason.localeCompare(right.reason));
  const errors = (parsed.errors ?? []).map((error) => error.message ?? String(error));
  const coverage = ([...exclusions.entries()] as Array<[SyntaxFactsCoverageDomain, SyntaxFactExclusion[]]>).map(([domain, domainExclusions]) => ({
    domain,
    status: errors.length > 0 ? "invalid" as const : domainExclusions.length > 0 ? "partial" as const : "complete" as const,
    exclusions: domainExclusions,
  }));
  return {
    schema: syntaxFactsSchema,
    source: {
      fileName, language, length: sourceText.length,
      digest: createHash("sha256").update(sourceText).digest("hex"),
    },
    parser: { name: "oxc-parser", version: oxcParserVersion },
    coverage,
    functions,
    sites,
    errors,
  };
}

/**
 * The function a call at `position` belongs to, skipping an inline callee that starts at the same
 * position. An unparenthesized immediately invoked function shares its call's start offset, so the
 * plain enclosing-function lookup would name the callee as its own caller.
 */
export function callingFunction(
  functions: readonly SyntaxFunction[],
  position: number,
  callee: SyntaxFunction | undefined,
): SyntaxFunction | undefined {
  const candidates = callee === undefined
    ? functions
    : functions.filter((item) => item.start !== callee.start || item.end !== callee.end);
  return enclosingFunction(candidates, position);
}

export function enclosingFunction(functions: readonly SyntaxFunction[], position: number): SyntaxFunction | undefined {
  return functions.reduce<SyntaxFunction | undefined>((smallest, item) => {
    if (item.start > position || position >= item.end) return smallest;
    const size = item.end - item.start;
    return !smallest || size < (smallest.end - smallest.start) ? item : smallest;
  }, undefined);
}
