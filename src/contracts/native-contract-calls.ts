import type { Expression, Node } from "oxc-parser";
import type { CorsaCallableFrontend, CorsaCallableSignature } from "../frontends/corsa/corsa-callable-frontend.js";
import { oxcChildren, topLevelOxcFunctions, type OxcFunctionSource, type OxcSource } from "../frontends/oxc/source.js";
import { extractLocatedAnnotations, validateUneffectAnnotations } from "../support/annotations.js";
import type { LogicExpression } from "./logic-contracts.js";
import { parseLogicExpression } from "./logic.js";
import { nativeBodyExpression } from "./native-scalars.js";

type Call = Extract<Expression, { type: "CallExpression" }>;
const maximumDepth = 2;
const maximumNodes = 4096;
const maximumCalls = 32;
class ExpansionLimit extends Error {}

/** Count occurrences, including shared substituted subtrees, before serialization
 * or scalar/solver traversal can turn a compact DAG into an oversized expression. */
export function assertNativeCallExpressionBudget(roots: readonly LogicExpression[]): void {
  const pending = [...roots];
  let count = 0;
  while (pending.length) {
    if (++count > maximumNodes) throw new ExpansionLimit(`native call expansion node budget exceeded (${maximumNodes})`);
    const node = pending.pop()!;
    if (node.kind === "unary") pending.push(node.operand);
    if (node.kind === "binary") pending.push(node.left, node.right);
  }
}

function checkSyntaxSize(roots: readonly Node[]): void {
  const pending = [...roots];
  let count = 0;
  while (pending.length) {
    if (++count > maximumNodes) throw new ExpansionLimit(`native call syntax node budget exceeded (${maximumNodes})`);
    pending.push(...oxcChildren(pending.pop()!));
  }
}

interface NativeCallEvaluation {
  readonly expression: LogicExpression;
  readonly conditions: readonly LogicExpression[];
}
export interface NativeCallExpansion {
  readonly expression: LogicExpression;
  readonly arguments: readonly NativeCallEvaluation[];
  readonly requirements: readonly (NativeCallEvaluation & { readonly source: string })[];
}

export function nativeCallExpansionExpressions(expansion: NativeCallExpansion): LogicExpression[] {
  return [expansion.expression, ...[...expansion.arguments, ...expansion.requirements]
    .flatMap(item => [item.expression, ...item.conditions])];
}

export function substituteNativeCallExpansion(expansion: NativeCallExpansion,
  substitutions: ReadonlyMap<string, LogicExpression>, guards: readonly LogicExpression[] = []): NativeCallExpansion {
  const expression = (value: LogicExpression) => substituteLogic(value, substitutions);
  const evaluation = <T extends NativeCallEvaluation>(item: T): T => ({ ...item, expression: expression(item.expression),
    conditions: [...guards, ...item.conditions].map(expression) });
  return { expression: expression(expansion.expression), arguments: expansion.arguments.map(evaluation), requirements: expansion.requirements.map(evaluation) };
}
type Declaration = CorsaCallableSignature["declaration"];
const declarationKey = ({ fileName, span }: Declaration) => JSON.stringify([fileName, span.start, span.end]);

interface Target {
  readonly source: OxcSource;
  readonly fn: OxcFunctionSource;
  readonly declaration: Declaration;
  readonly symbolId: string;
}

function variables(expression: LogicExpression): string[] {
  if (expression.kind === "variable") return [expression.name];
  if (expression.kind === "unary") return variables(expression.operand);
  if (expression.kind === "binary") return [...variables(expression.left), ...variables(expression.right)];
  return [];
}

/** Up to two scalar return expansions, retaining each nested evaluation guard.
 * Runtime binding identity and signature declaration
 * must both match a snapshot-owned implementation; structural callable types alone
 * never authorize inlining. Targets with writes or direct eval fail closed.
 */
export function createNativeContractCalls(frontend: CorsaCallableFrontend, sources: readonly OxcSource[]):
  (source: OxcSource, call: Call) => NativeCallExpansion | undefined {
  const targets = new Map<string, Target>();
  const writes = new Set<string>();
  const ambiguousWrites = new Set<string>();
  const dynamicSources = new Set<string>();
  for (const source of sources) {
    const write = (node: Node, shorthand = false): void => {
      if (node.type === "Identifier") {
        const symbol = frontend.getSymbolAtPosition(source.fileName, node.start);
        if (symbol) {
          const binding = frontend.getAliasedSymbol(symbol) ?? symbol;
          for (const declaration of frontend.getDeclarationSpans(binding)) writes.add(declarationKey(declaration));
        }
        // A shorthand position may identify the property instead of its target.
        if (shorthand || !symbol) ambiguousWrites.add(node.name);
      } else if (node.type !== "MemberExpression") {
        for (const child of oxcChildren(node)) write(child, shorthand || node.type === "Property" && node.shorthand);
      }
    };
    const visit = (node: Node): void => {
      if (node.type === "AssignmentExpression") write(node.left);
      if (node.type === "UpdateExpression") write(node.argument);
      if ((node.type === "ForInStatement" || node.type === "ForOfStatement") && node.left.type !== "VariableDeclaration") write(node.left);
      if (node.type === "CallExpression") {
        let callee = node.callee;
        while (callee.type === "ParenthesizedExpression") callee = callee.expression;
        if (callee.type === "Identifier" && callee.name === "eval") dynamicSources.add(source.fileName);
      }
      for (const child of oxcChildren(node)) visit(child);
    };
    visit(source.program);
    for (const fn of topLevelOxcFunctions(source)) {
      const { node } = fn;
      if (node.async || node.generator || node.typeParameters || node.params.length > 8
        || node.params.some(parameter => parameter.type !== "Identifier" || parameter.optional)
        || node.body.body.length !== 1 || node.body.body[0]!.type !== "ReturnStatement" || !node.body.body[0]!.argument
        || validateUneffectAnnotations(fn.comments).length
        || !extractLocatedAnnotations(fn.comments, "ensures").length
        || extractLocatedAnnotations(fn.comments, "contract_from").length) continue;
      const symbol = frontend.getSymbolAtPosition(source.fileName, node.id.start);
      const signature = frontend.getSignatureFromDeclaration(source.fileName, fn, source.text);
      if (!symbol || !signature || frontend.getSignaturesOfTypeAtPosition(source.fileName, node.id.start).length !== 1) continue;
      const declarations = frontend.getDeclarationSpans(symbol);
      if (declarations.length !== 1 || declarationKey(declarations[0]!) !== declarationKey(signature.declaration)) continue;
      targets.set(declarationKey(signature.declaration), { source, fn, declaration: signature.declaration, symbolId: symbol.id });
    }
  }

  const expand = (source: OxcSource, call: Call, ancestors: readonly string[], budget: { calls: number }): NativeCallExpansion | undefined => {
    if (++budget.calls > maximumCalls) throw new ExpansionLimit(`native call expansion call budget exceeded (${maximumCalls})`);
    let callee = call.callee;
    while (callee.type === "ParenthesizedExpression") callee = callee.expression;
    if (callee.type !== "Identifier" || call.optional || call.typeArguments || dynamicSources.has(source.fileName)) return undefined;
    const symbol = frontend.getSymbolAtPosition(source.fileName, callee.start);
    if (!symbol) return undefined;
    const binding = frontend.getAliasedSymbol(symbol) ?? symbol;
    const declarations = frontend.getDeclarationSpans(binding);
    if (declarations.length !== 1) return undefined;
    const target = targets.get(declarationKey(declarations[0]!));
    if (!target || target.symbolId !== binding.id || writes.has(declarationKey(target.declaration))
      || ambiguousWrites.has(target.fn.node.id.name) || dynamicSources.has(target.source.fileName)) return undefined;
    const identity = declarationKey(target.declaration);
    if (ancestors.includes(identity)) throw new ExpansionLimit("recursive native call expansion is unsupported");
    if (ancestors.length >= maximumDepth) throw new ExpansionLimit(`native call expansion depth budget exceeded (${maximumDepth})`);
    const signature = frontend.getResolvedSignature(source.fileName, call, source.text);
    if (!signature || declarationKey(signature.declaration) !== declarationKey(target.declaration)) return undefined;
    const { node } = target.fn;
    if (call.arguments.length !== node.params.length || call.arguments.some(argument => argument.type === "SpreadElement")) return undefined;
    try {
      const returned = node.body.body[0]!;
      if (returned.type !== "ReturnStatement" || !returned.argument) return undefined;
      checkSyntaxSize([returned.argument, ...call.arguments]);
      const nested: NativeCallExpansion[] = [];
      const body = nativeBodyExpression(returned.argument, (inner, guards) => {
        const child = expand(target.source, inner, [...ancestors, identity], budget);
        if (!child) return undefined;
        nested.push(substituteNativeCallExpansion(child, new Map(), guards));
        assertNativeCallExpressionBudget(nested.flatMap(nativeCallExpansionExpressions));
        return child.expression;
      });
      const names = node.params.map(parameter => parameter.type === "Identifier" ? parameter.name : "");
      const localExpressions = [body, ...nested.flatMap(nativeCallExpansionExpressions)];
      if (localExpressions.some(expression => variables(expression).some(name => !names.includes(name)))) return undefined;
      const arguments_ = call.arguments.map(argument => nativeBodyExpression(argument as Expression));
      const substitutions = new Map(names.map((name, index) => [name, arguments_[index]!]));
      const requirements: Array<NativeCallEvaluation & { source: string }> = [];
      for (const { value } of extractLocatedAnnotations(target.fn.comments, "requires")) {
        const requirement = parseLogicExpression(value);
        if (variables(requirement).some(name => !names.includes(name))) return undefined;
        requirements.push({ source: value, expression: requirement, conditions: [] });
      }
      const projected = substituteNativeCallExpansion({ expression: body,
        arguments: nested.flatMap(item => item.arguments),
        requirements: [...requirements, ...nested.flatMap(item => item.requirements)] }, substitutions);
      // Actual arguments already belong to the caller namespace. Only the body
      // and nested evaluations are expressed in the target's parameter namespace.
      const result: NativeCallExpansion = { ...projected,
        arguments: [...arguments_.map(expression => ({ expression, conditions: [] })), ...projected.arguments] };
      assertNativeCallExpressionBudget(nativeCallExpansionExpressions(result));
      return result;
    } catch (error) {
      if (error instanceof ExpansionLimit) throw error;
      return undefined;
    }
  };
  return (source, call) => expand(source, call, [], { calls: 0 });
}

export function substituteLogic(expression: LogicExpression, substitutions: ReadonlyMap<string, LogicExpression>): LogicExpression {
  if (expression.kind === "variable") return substitutions.get(expression.name) ?? expression;
  if (expression.kind === "unary") return { ...expression, operand: substituteLogic(expression.operand, substitutions) };
  if (expression.kind === "binary") return { ...expression, left: substituteLogic(expression.left, substitutions), right: substituteLogic(expression.right, substitutions) };
  return expression;
}
export function constantBoolean(expression: LogicExpression): boolean | undefined {
  if (expression.kind === "boolean") return expression.value;
  if (expression.kind === "unary" && expression.operator === "not") {
    const value = constantBoolean(expression.operand); return value === undefined ? undefined : !value;
  }
  if (expression.kind !== "binary") return undefined;
  if (expression.operator === "and" || expression.operator === "or") {
    const left = constantBoolean(expression.left), right = constantBoolean(expression.right);
    return left === undefined || right === undefined ? undefined : expression.operator === "and" ? left && right : left || right;
  }
  if (!["lt", "lte", "gt", "gte", "eq", "neq"].includes(expression.operator)
    || expression.left.kind !== "integer" || expression.right.kind !== "integer") return undefined;
  const left = BigInt(expression.left.value), right = BigInt(expression.right.value);
  return ({ lt: left < right, lte: left <= right, gt: left > right, gte: left >= right, eq: left === right, neq: left !== right } as Record<string, boolean>)[expression.operator];
}
