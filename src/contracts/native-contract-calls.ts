import type { Expression, Node } from "oxc-parser";
import type { CorsaCallableFrontend, CorsaCallableSignature } from "../frontends/corsa/corsa-callable-frontend.js";
import { oxcChildren, topLevelOxcFunctions, type OxcFunctionSource, type OxcSource } from "../frontends/oxc/source.js";
import { extractLocatedAnnotations, validateUneffectAnnotations } from "../support/annotations.js";
import type { LogicExpression } from "./logic-contracts.js";
import { parseLogicExpression } from "./logic.js";
import { nativeBodyExpression } from "./native-scalars.js";
import { lowerNativeExpressionPaths } from "./corsa-contract-flow.js";

type Call = Extract<Expression, { type: "CallExpression" }>;
const maximumDepth = 2;
const maximumNodes = 4096;
const maximumCalls = 32;
class ExpansionLimit extends Error {}
class ExpansionFlowError extends Error {}

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
    if (node.kind === "conditional") pending.push(node.test, node.consequent, node.alternate);
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
  readonly requiresBoolean?: boolean;
  readonly structureOnly?: boolean;
}
export interface NativeCallExpansion {
  readonly expression: LogicExpression;
  readonly arguments: readonly NativeCallEvaluation[];
  readonly requirements: readonly (NativeCallEvaluation & { readonly source: string })[];
}

function evaluationExpressions(values: readonly NativeCallEvaluation[]): LogicExpression[] {
  return values.flatMap(item => [item.expression, ...item.conditions]);
}

export function nativeCallExpansionExpressions(expansion: NativeCallExpansion): LogicExpression[] {
  return [expansion.expression, ...evaluationExpressions([...expansion.arguments, ...expansion.requirements])];
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
  if (expression.kind === "conditional") return [expression.test, expression.consequent, expression.alternate].flatMap(variables);
  if (expression.kind === "variable") return [expression.name];
  if (expression.kind === "unary") return variables(expression.operand);
  if (expression.kind === "binary") return [...variables(expression.left), ...variables(expression.right)];
  return [];
}

/** Up to two active scalar return bodies, retaining each nested evaluation guard.
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
      checkSyntaxSize([node.body, ...call.arguments]);
      const lower = (expression: Expression, from: OxcSource, active: readonly string[], collected: NativeCallExpansion[]) =>
        nativeBodyExpression(expression, (inner, guards) => {
          const child = expand(from, inner, active, budget);
          if (!child) return undefined;
          collected.push(substituteNativeCallExpansion(child, new Map(), guards));
          assertNativeCallExpressionBudget(collected.flatMap(nativeCallExpansionExpressions));
          return child.expression;
        });
      const nested: NativeCallExpansion[] = [];
      const evaluations: NativeCallEvaluation[] = [];
      const syntaxExpressions: LogicExpression[] = [];
      const locals = new Map<string, LogicExpression>();
      const mutableLocals = new Set<string>();
      const lowerBound = (expression: Expression, collected: NativeCallExpansion[]): LogicExpression => {
        const calls: NativeCallExpansion[] = [];
        const value = substituteLogic(lower(expression, target.source, [...ancestors, identity], calls), locals);
        const projected = calls.map(child => substituteNativeCallExpansion(child, locals));
        // Child return expressions are already embedded in value. Count their
        // evaluations and requirements too, without counting the returns twice.
        assertNativeCallExpressionBudget(nativeCallExpansionExpressions({ expression: value,
          arguments: projected.flatMap(child => child.arguments), requirements: projected.flatMap(child => child.requirements) }));
        collected.push(...projected);
        return value;
      };
      const retainPrefixEvaluation = (value: LogicExpression): void => {
        evaluations.push({ expression: value, conditions: [] });
        syntaxExpressions.push(value);
        assertNativeCallExpressionBudget([...syntaxExpressions,
          ...nested.flatMap(child => evaluationExpressions([...child.arguments, ...child.requirements]))]);
      };
      // Freeze entry-prefix state before the CFG. Keep each evaluated value in
      // the original parameter namespace, including values overwritten later.
      let prefix = 0;
      for (const statement of node.body.body) {
        if (statement.type === "VariableDeclaration" && (statement.kind === "const" || statement.kind === "let")) {
          for (const declaration of statement.declarations) {
            const name = declaration.id.type === "Identifier" ? declaration.id.name : undefined;
            if (!name || !declaration.init
              || locals.has(name) || node.params.some(parameter => parameter.type === "Identifier" && parameter.name === name)) {
              throw new ExpansionFlowError("native callee locals require distinct initialized identifiers");
            }
            const value = lowerBound(declaration.init, nested);
            retainPrefixEvaluation(value);
            locals.set(name, value);
            if (statement.kind === "let") mutableLocals.add(name);
          }
        } else if (statement.type === "ExpressionStatement" && statement.expression.type === "AssignmentExpression") {
          const assignment = statement.expression;
          if (assignment.left.type !== "Identifier" || !mutableLocals.has(assignment.left.name)
            || !["=", "+=", "-=", "*=", "/=", "%="].includes(assignment.operator)) {
            throw new ExpansionFlowError("native callee assignments require a supported operator and an initialized local let binding");
          }
          const name = assignment.left.name;
          const right = lowerBound(assignment.right, nested);
          const value: LogicExpression = assignment.operator === "=" ? right : { kind: "binary",
            operator: ({ "+=": "add", "-=": "sub", "*=": "mul", "/=": "div", "%=": "mod" } as Record<string, string>)[assignment.operator]!,
            left: locals.get(name)!, right };
          retainPrefixEvaluation(value);
          locals.set(name, value);
        } else break;
        prefix++;
      }
      const remainingBody = { ...node.body, body: node.body.body.slice(prefix) };
      const body = (() => {
        const returned = remainingBody.body.length === 1 ? remainingBody.body[0] : undefined;
        if (returned?.type === "ReturnStatement" && returned.argument) {
          return lowerBound(returned.argument, nested);
        }
        // CFG construction and fixed-point propagation revisit expressions. Resolve
        // each syntax call once, then attach each distinct evaluation path separately.
        const cache = new Map<Expression, { value: LogicExpression; calls: NativeCallExpansion[] }>();
        const seen = new Set<string>();
        try {
          const paths = lowerNativeExpressionPaths(remainingBody, (expression, conditions, role) => {
            let entry = cache.get(expression);
            if (!entry) {
              const calls: NativeCallExpansion[] = [];
              entry = { value: lowerBound(expression, calls), calls };
              cache.set(expression, entry);
              syntaxExpressions.push(entry.value, ...calls.flatMap(nativeCallExpansionExpressions));
              evaluations.push({ expression: entry.value, conditions: [], requiresBoolean: role === "predicate", structureOnly: true },
                ...calls.flatMap(child => [...child.arguments, ...child.requirements.map(item => ({ ...item, requiresBoolean: true }))])
                  .map(item => ({ ...item, structureOnly: true })));
              assertNativeCallExpressionBudget(syntaxExpressions);
            }
            if (conditions !== null) {
              const key = JSON.stringify([expression.start, expression.end, role, conditions]);
              if (!seen.has(key)) {
                seen.add(key);
                evaluations.push({ expression: entry.value, conditions, requiresBoolean: role === "predicate" });
                nested.push(...entry.calls.map(child => substituteNativeCallExpansion(child, new Map(), conditions)));
                assertNativeCallExpressionBudget([...evaluations.flatMap(item => [item.expression, ...item.conditions]),
                  ...nested.flatMap(nativeCallExpansionExpressions)]);
              }
            }
            return entry.value;
          });
          // The CFG has proved that no path falls through. The final return can
          // therefore be the default arm; earlier paths guard every other result.
          let value = paths.at(-1)!.result;
          for (const path of paths.slice(0, -1).reverse()) {
            const test = path.conditions.reduce<LogicExpression>((left, right) =>
              left.kind === "boolean" && left.value ? right : { kind: "binary", operator: "and", left, right }, { kind: "boolean", value: true });
            value = { kind: "conditional", test, consequent: path.result, alternate: value };
          }
          assertNativeCallExpressionBudget([value]);
          return value;
        } catch (error) {
          if (error instanceof ExpansionLimit || error instanceof ExpansionFlowError) throw error;
          throw new ExpansionFlowError(error instanceof Error ? error.message : String(error));
        }
      })();
      const names = node.params.map(parameter => parameter.type === "Identifier" ? parameter.name : "");
      const localExpressions = [body, ...syntaxExpressions, ...nested.flatMap(nativeCallExpansionExpressions)];
      if (localExpressions.some(expression => variables(expression).some(name => !names.includes(name)))) return undefined;
      // Arguments execute in the caller before the target's body. In particular,
      // f(f(value)) is not recursion and cannot borrow conditions from f's body.
      const argumentCalls: NativeCallExpansion[] = [];
      const arguments_ = call.arguments.map(argument => lower(argument as Expression, source, ancestors, argumentCalls));
      const substitutions = new Map(names.map((name, index) => [name, arguments_[index]!]));
      const requirements: Array<NativeCallEvaluation & { source: string }> = [];
      for (const { value } of extractLocatedAnnotations(target.fn.comments, "requires")) {
        const requirement = parseLogicExpression(value);
        if (variables(requirement).some(name => !names.includes(name))) return undefined;
        requirements.push({ source: value, expression: requirement, conditions: [] });
      }
      const projected = substituteNativeCallExpansion({ expression: body,
        arguments: [...evaluations, ...nested.flatMap(item => item.arguments)],
        requirements: [...requirements, ...nested.flatMap(item => item.requirements)] }, substitutions);
      // Actual arguments already belong to the caller namespace. Only the body
      // and nested evaluations are expressed in the target's parameter namespace.
      const result: NativeCallExpansion = { ...projected,
        arguments: [...argumentCalls.flatMap(item => item.arguments),
          ...arguments_.map(expression => ({ expression, conditions: [] })), ...projected.arguments],
        requirements: [...argumentCalls.flatMap(item => item.requirements), ...projected.requirements] };
      assertNativeCallExpressionBudget(nativeCallExpansionExpressions(result));
      return result;
    } catch (error) {
      if (error instanceof ExpansionLimit || error instanceof ExpansionFlowError) throw error;
      return undefined;
    }
  };
  return (source, call) => expand(source, call, [], { calls: 0 });
}

export function substituteLogic(expression: LogicExpression, substitutions: ReadonlyMap<string, LogicExpression>): LogicExpression {
  if (expression.kind === "conditional") return { kind: "conditional", test: substituteLogic(expression.test, substitutions),
    consequent: substituteLogic(expression.consequent, substitutions), alternate: substituteLogic(expression.alternate, substitutions) };
  if (expression.kind === "variable") return substitutions.get(expression.name) ?? expression;
  if (expression.kind === "unary") return { ...expression, operand: substituteLogic(expression.operand, substitutions) };
  if (expression.kind === "binary") return { ...expression, left: substituteLogic(expression.left, substitutions), right: substituteLogic(expression.right, substitutions) };
  return expression;
}
export function constantBoolean(expression: LogicExpression): boolean | undefined {
  if (expression.kind === "conditional") {
    const test = constantBoolean(expression.test);
    return test === undefined ? undefined : constantBoolean(test ? expression.consequent : expression.alternate);
  }
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
