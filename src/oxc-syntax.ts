import { createHash } from "node:crypto";
import { parseSync } from "oxc-parser";
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
    if (parent.kind === "constructor") return {
      exclusion: { reason: "constructor-boundary", span: { start: methodStart, end: methodEnd } },
    };
    const key = staticName(isNode(parent.key) ? parent.key : undefined, parent.computed === true);
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
  if (parent?.type === "Property") return {
    exclusion: { reason: "object-member-function", span: { start: node.start, end: node.end } },
  };
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

function callSite(node: EstreeNode): SyntaxSite | undefined {
  const callee = isNode(node.callee) ? node.callee : undefined;
  if (!callee || typeof node.start !== "number" || typeof node.end !== "number") return undefined;
  if (callee.type === "Identifier" && typeof callee.start === "number") {
    const name = identifierName(callee);
    if (!name) return undefined;
    return { kind: node.type === "NewExpression" ? "construct" : "call", start: node.start, end: node.end, calleePosition: callee.start, name };
  }
  const unwrapped = callee.type === "TSNonNullExpression" && isNode(callee.expression) ? callee.expression : callee;
  if (unwrapped.type !== "MemberExpression" || unwrapped.computed || !isNode(unwrapped.object) || !isNode(unwrapped.property)) return undefined;
  if (typeof unwrapped.property.start !== "number" || typeof unwrapped.object.start !== "number") return undefined;
  const name = staticName(unwrapped.property);
  if (!name) return undefined;
  return {
    kind: node.type === "NewExpression" ? "construct" : "call",
    start: node.start,
    end: node.end,
    calleePosition: unwrapped.property.start,
    receiverPosition: unwrapped.object.start,
    name,
  };
}

/** Parse TypeScript with Oxc into the versioned, compiler-neutral syntax observation contract. */
export function collectSyntaxFacts(fileName: string, sourceText: string): SyntaxFacts {
  const language = fileName.endsWith(".tsx") ? "tsx" as const : "typescript" as const;
  const parsed = parseSync(fileName, sourceText, { lang: language === "tsx" ? "tsx" : "ts" });
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
    if (node.type === "MemberExpression" && node.computed && typeof node.start === "number" && typeof node.end === "number") {
      const parent = parents.get(node);
      if (parent?.type !== "CallExpression" && parent?.type !== "NewExpression") {
        exclusions.get("property-sites")!.push({ reason: "computed-property", span: { start: node.start, end: node.end } });
      }
    } else if (node.type === "MemberExpression" && !node.computed && isNode(node.object) && isNode(node.property)
      && typeof node.start === "number" && typeof node.end === "number"
      && typeof node.object.start === "number" && typeof node.property.start === "number") {
      const parent = parents.get(node);
      if (parent?.type === "CallExpression" || parent?.type === "NewExpression") return;
      const name = staticName(node.property);
      if (name) sites.push({
        kind: "property", start: node.start, end: node.end,
        calleePosition: node.property.start, receiverPosition: node.object.start, name,
      });
    }
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

export function enclosingFunction(functions: readonly SyntaxFunction[], position: number): SyntaxFunction | undefined {
  return functions.reduce<SyntaxFunction | undefined>((smallest, item) => {
    if (item.start > position || position >= item.end) return smallest;
    const size = item.end - item.start;
    return !smallest || size < (smallest.end - smallest.start) ? item : smallest;
  }, undefined);
}
