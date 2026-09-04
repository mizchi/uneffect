import { parseSync } from "oxc-parser";

export interface SyntaxFunction {
  readonly name: string;
  readonly start: number;
  readonly end: number;
  readonly parameters: string[];
}

export interface SyntaxSite {
  readonly kind: "call" | "construct" | "property";
  readonly start: number;
  readonly end: number;
  readonly calleePosition: number;
  readonly receiverPosition?: number;
  readonly name: string;
}

interface EstreeNode {
  type?: string;
  start?: number;
  end?: number;
  name?: string;
  [key: string]: unknown;
}

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

function parameterName(node: EstreeNode): string | undefined {
  if (node.type === "Identifier") return identifierName(node);
  if (node.type === "AssignmentPattern" && isNode(node.left)) return parameterName(node.left);
  if (node.type === "RestElement" && isNode(node.argument)) return parameterName(node.argument);
  return undefined;
}

function functionName(node: EstreeNode, parent: EstreeNode | undefined): string | undefined {
  if (node.type === "FunctionDeclaration" || node.type === "FunctionExpression" || node.type === "TSDeclareFunction") {
    return identifierName(isNode(node.id) ? node.id : undefined);
  }
  if (node.type === "ArrowFunctionExpression" && parent?.type === "VariableDeclarator") {
    return identifierName(isNode(parent.id) ? parent.id : undefined);
  }
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

function callSite(node: EstreeNode): SyntaxSite | undefined {
  const callee = isNode(node.callee) ? node.callee : undefined;
  if (!callee || typeof node.start !== "number" || typeof node.end !== "number") return undefined;
  if (callee.type === "Identifier" && typeof callee.start === "number") {
    const name = identifierName(callee);
    if (!name) return undefined;
    return {
      kind: node.type === "NewExpression" ? "construct" : "call",
      start: node.start, end: node.end, calleePosition: callee.start, name,
    };
  }
  if ((callee.type === "MemberExpression" || callee.type === "TSNonNullExpression") && isNode(callee.object)) {
    const object = callee.type === "TSNonNullExpression" && isNode(callee.expression) ? callee.expression : callee;
    const member = object.type === "MemberExpression" ? object : callee;
    if (member.type !== "MemberExpression" || !isNode(member.object) || !isNode(member.property)) return undefined;
    if (typeof member.property.start !== "number" || typeof member.object.start !== "number") return undefined;
    const name = identifierName(member.property);
    if (!name) return undefined;
    return {
      kind: node.type === "NewExpression" ? "construct" : "call",
      start: node.start,
      end: node.end,
      calleePosition: member.property.start,
      receiverPosition: member.object.start,
      name,
    };
  }
  return undefined;
}

/**
 * Parse TypeScript with Oxc and collect function bounds plus call/construct/property
 * sites. This is the non-TypeScript-6 syntax layer used by Corsa check.
 */
export function collectSyntaxFacts(fileName: string, sourceText: string): {
  functions: SyntaxFunction[];
  sites: SyntaxSite[];
  errors: readonly string[];
} {
  const parsed = parseSync(fileName, sourceText, { lang: fileName.endsWith("x") ? "tsx" : "ts" });
  const functions: SyntaxFunction[] = [];
  const sites: SyntaxSite[] = [];
  const parents = new Map<EstreeNode, EstreeNode>();
  walk(parsed.program, (node) => {
    for (const child of Object.values(node)) {
      if (isNode(child)) parents.set(child, node);
      if (Array.isArray(child)) for (const item of child) if (isNode(item)) parents.set(item, node);
    }
  });
  walk(parsed.program, (node) => {
    if ((node.type === "FunctionDeclaration" || node.type === "FunctionExpression"
      || node.type === "ArrowFunctionExpression" || node.type === "TSDeclareFunction")
      && typeof node.start === "number" && typeof node.end === "number") {
      const name = functionName(node, parents.get(node));
      if (name) functions.push({ name, start: node.start, end: node.end, parameters: functionParameters(node) });
    }
    if (node.type === "CallExpression" || node.type === "NewExpression") {
      const site = callSite(node);
      if (site) sites.push(site);
    }
    if (node.type === "MemberExpression" && !node.computed && isNode(node.object) && isNode(node.property)
      && typeof node.start === "number" && typeof node.end === "number"
      && typeof node.object.start === "number" && typeof node.property.start === "number") {
      const parent = parents.get(node);
      if (parent?.type === "CallExpression" || parent?.type === "NewExpression") return;
      const name = identifierName(node.property);
      if (!name) return;
      sites.push({
        kind: "property",
        start: node.start,
        end: node.end,
        calleePosition: node.property.start,
        receiverPosition: node.object.start,
        name,
      });
    }
  });
  const errors = (parsed.errors ?? []).map((error) => error.message ?? String(error));
  return { functions, sites, errors };
}

export function enclosingFunction(functions: readonly SyntaxFunction[], position: number): SyntaxFunction | undefined {
  return functions.reduce<SyntaxFunction | undefined>((smallest, item) => {
    if (item.start > position || position >= item.end) return smallest;
    const size = item.end - item.start;
    return !smallest || size < (smallest.end - smallest.start) ? item : smallest;
  }, undefined);
}
