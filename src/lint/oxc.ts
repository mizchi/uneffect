import { oxcChildren as children } from "../frontends/oxc/source.js";
import { parseSync, type Node, type Expression, type Function as OxcFunction, type TSType } from "oxc-parser";
import type { SemanticQueryFrontend, SemanticPositionFact } from "../frontends/semantic-query.js";
import type { RuleEvent, RuleLocation, SourceRuleBinding, SourceRuleLowering, SourceRuleOptions } from "./contracts.js";
import { normalizeSourceOptions } from "./source-options.js";

class UnsupportedSource extends Error {
  constructor(readonly node: Node, detail: string) { super(detail); }
}

function returnsVoid(type: TSType): boolean {
  if (type.type === "TSFunctionType") return type.returnType.typeAnnotation.type === "TSVoidKeyword";
  if (type.type === "TSTypeLiteral") {
    const signatures = type.members.filter(member => member.type === "TSCallSignatureDeclaration");
    return signatures.length > 0 && signatures.every(signature => signature.returnType?.typeAnnotation.type === "TSVoidKeyword");
  }
  return false;
}

function voidSignature(texts: readonly string[] | undefined): boolean {
  return !!texts?.length && texts.every(text => {
    const parsed = parseSync("signature.ts", `type Signature = ${text}`, { lang: "ts" });
    const declaration = parsed.program.body[0];
    return parsed.errors.length === 0 && declaration?.type === "TSTypeAliasDeclaration" && returnsVoid(declaration.typeAnnotation);
  });
}

/** Internal syntax adapter. The caller must supply a checked, matching semantic snapshot. */
export function lowerOxcRuleCfg(source: string, frontend: Pick<SemanticQueryFrontend, "queryPosition">, options: SourceRuleOptions): SourceRuleLowering {
  const location = (node: Node): RuleLocation => ({ fileName: options.fileName, start: node.start, end: node.end });
  try {
    options = normalizeSourceOptions(options);
    const parsed = parseSync(options.fileName, source);
    if (parsed.errors.length) return { status: "unknown", reason: "unsupported-source", detail: parsed.errors.map(error => error.message).join("\n") };
    const functions = parsed.program.body.flatMap(node => {
      const declaration = node.type === "ExportNamedDeclaration" || node.type === "ExportDefaultDeclaration" ? node.declaration : node;
      return declaration && (declaration.type === "FunctionDeclaration" || declaration.type === "TSDeclareFunction") ? [declaration as OxcFunction] : [];
    });
    const fn = functions.find(node => node.id?.name === options.functionName && node.body);
    if (!fn?.body) throw new TypeError("functionName must identify a top-level function implementation");
    if (fn.async || fn.generator) throw new UnsupportedSource(fn, "async and generator functions are not supported");
    const facts = new Map<number, SemanticPositionFact>();
    const fact = (node: Node): SemanticPositionFact => {
      let value = facts.get(node.start);
      // Oxc and the Corsa position API both use UTF-16 offsets, including after astral characters.
      if (!value) { value = frontend.queryPosition(options.fileName, node.start); facts.set(node.start, value); }
      return value;
    };
    const bindings = new Map<string, SourceRuleBinding>();
    for (const binding of options.bindings) {
      const declaration = functions.find(node => node.id?.name === binding.functionName);
      const resolved = declaration?.id && fact(declaration.id);
      if (!declaration || !resolved?.symbol) throw new TypeError(`operation declaration not found: ${binding.functionName}`);
      if (bindings.has(resolved.symbol.id)) throw new TypeError(`duplicate operation declaration: ${binding.functionName}`);
      if (binding.argumentIndex >= declaration.params.length) throw new TypeError(`argumentIndex outside ${binding.functionName} parameters`);
      if (!voidSignature(resolved.type?.texts)) throw new UnsupportedSource(declaration, "operation declarations must return void; asynchronous operations are unsupported");
      bindings.set(resolved.symbol.id, binding);
    }
    const operationNames = new Set(options.bindings.map(binding => binding.functionName));
    const checkWrites = (node: Node): void => {
      const target = node.type === "AssignmentExpression" ? node.left : node.type === "UpdateExpression" ? node.argument
        : node.type === "ForInStatement" || node.type === "ForOfStatement" ? node.left : undefined;
      const checkTarget = (target: Node): void => {
        // Corsa's position query can return the property symbol for shorthand
        // assignment targets. Without a value-symbol query, fail closed even
        // when that spelling might refer to a shadowed local binding.
        if (target.type === "Property" && target.shorthand && target.key.type === "Identifier" && operationNames.has(target.key.name)) {
          throw new UnsupportedSource(target, "shorthand writes may replace a registered operation binding");
        }
        if (target.type === "Identifier") {
          const symbol = fact(target).symbol;
          if (symbol && bindings.has(symbol.id)) throw new UnsupportedSource(target, "registered operation bindings must not be reassigned");
        }
        children(target).forEach(checkTarget);
      };
      if (target) checkTarget(target);
      children(node).forEach(checkWrites);
    };
    checkWrites(parsed.program);
    const locals = new Map<string, { declaration: Node; initializer?: Expression; parameter?: true }>();
    const parameterIdentities = new Set<string>();
    const identity = (node: Node) => `${options.fileName}#binding:${node.start}`;
    for (const parameter of fn.params) {
      if (parameter.type !== "Identifier") throw new UnsupportedSource(parameter, "only plain identifier parameters are supported");
      const symbol = fact(parameter).symbol;
      if (!symbol) throw new UnsupportedSource(parameter, "parameter symbol unavailable");
      locals.set(symbol.id, { declaration: parameter, parameter: true });
      parameterIdentities.add(identity(parameter));
    }
    const collectLocals = (node: Node): void => {
      if (node.type === "VariableDeclaration" && node.kind === "const") {
        for (const declaration of node.declarations) {
          if (declaration.id.type === "Identifier" && declaration.init) {
            const symbol = fact(declaration.id).symbol;
            if (symbol) locals.set(symbol.id, { declaration, initializer: declaration.init });
          }
        }
      }
      children(node).forEach(collectLocals);
    };
    collectLocals(fn.body);
    const unwrap = (expression: Expression): Expression => expression.type === "ParenthesizedExpression" ? unwrap(expression.expression) : expression;
    const local = (node: Node) => { const symbol = fact(node).symbol; return symbol && locals.get(symbol.id); };
    const subject = (expression: Expression, seen = new Set<Node>()): string | undefined => {
      expression = unwrap(expression);
      if (expression.type !== "Identifier") return undefined;
      const binding = local(expression);
      if (!binding || seen.has(binding.declaration)) return undefined;
      if (binding.parameter) return identity(binding.declaration);
      if (!binding.initializer) return undefined;
      seen.add(binding.declaration);
      const initializer = unwrap(binding.initializer);
      if (initializer.type === "ObjectExpression" && initializer.properties.length === 0) return identity(binding.declaration);
      return subject(initializer, seen);
    };
    const pure = (expression: Expression): boolean => {
      expression = unwrap(expression);
      if (expression.type === "Identifier") return !!local(expression);
      if (expression.type === "Literal") return expression.value === null || ["boolean", "number", "string"].includes(typeof expression.value);
      if (expression.type === "UnaryExpression" && expression.operator === "!") return pure(expression.argument);
      if ((expression.type === "BinaryExpression" || expression.type === "LogicalExpression") && ["&&", "||", "===", "!=="].includes(expression.operator)) {
        return expression.left.type !== "PrivateIdentifier" && pure(expression.left) && pure(expression.right);
      }
      return false;
    };
    const condition = (expression: Expression): void => {
      if (!pure(expression)) throw new UnsupportedSource(expression, "condition/throw expression may execute unmodeled code");
    };
    const usedParameters = new Set<string>();
    const events = (expression: Expression): RuleEvent[] => {
      expression = unwrap(expression);
      if (expression.type !== "CallExpression" || expression.optional || expression.callee.type !== "Identifier") {
        throw new UnsupportedSource(expression, "only direct registered operation calls are supported");
      }
      const symbol = fact(expression.callee).symbol;
      const binding = symbol && bindings.get(symbol.id);
      if (!binding) throw new UnsupportedSource(expression, "call does not resolve to a registered operation declaration");
      const argument = expression.arguments[binding.argumentIndex];
      const target = argument && argument.type !== "SpreadElement" && subject(argument);
      if (!target || !expression.arguments.every(argument => argument.type !== "SpreadElement" && pure(argument))) {
        throw new UnsupportedSource(expression, "operation arguments require local identities and side-effect-free values");
      }
      if (parameterIdentities.has(target)) usedParameters.add(target);
      if (usedParameters.size > 1) throw new UnsupportedSource(expression, "multiple operation-subject parameters may alias at runtime");
      return [{ operation: binding.operation, subject: target, location: location(expression) }];
    };
    const blocks: Array<{ id: string; successors: string[]; events: RuleEvent[] }> = [];
    const block = (successors: readonly string[], events: RuleEvent[] = []) => {
      const item = { id: `block:${blocks.length}`, successors: [...new Set(successors)], events };
      blocks.push(item);
      return item;
    };
    const exit = block([]).id;
    interface Context { breakTarget?: string; continueTarget?: string }
    const sequence = (statements: readonly Node[], next: string, context: Context): string => {
      for (let index = statements.length - 1; index >= 0; index--) next = lower(statements[index]!, next, context);
      return next;
    };
    const lower = (statement: Node, next: string, context: Context): string => {
      switch (statement.type) {
        case "BlockStatement": return sequence(statement.body, next, context);
        case "EmptyStatement": return next;
        case "ExpressionStatement": return block([next], events(statement.expression)).id;
        case "VariableDeclaration": {
          if (statement.kind !== "const") throw new UnsupportedSource(statement, "only const local bindings without implicit disposal are supported");
          for (const declaration of statement.declarations) {
            const initializer = declaration.init && unwrap(declaration.init);
            if (initializer?.type === "ObjectExpression" && context.continueTarget) throw new UnsupportedSource(declaration, "fresh object identities inside loops require allocation-generation tracking");
            if (declaration.id.type !== "Identifier" || !initializer || !(pure(initializer) || initializer.type === "ObjectExpression" && initializer.properties.length === 0)) {
              throw new UnsupportedSource(declaration, "only const aliases, pure values, and empty object identities are supported");
            }
          }
          return next;
        }
        case "IfStatement":
          condition(statement.test);
          return block([lower(statement.consequent, next, context), statement.alternate ? lower(statement.alternate, next, context) : next]).id;
        case "WhileStatement": case "DoWhileStatement": {
          condition(statement.test);
          const guard = block([]);
          const entry = lower(statement.body, guard.id, { breakTarget: next, continueTarget: guard.id });
          guard.successors.push(...new Set([entry, next]));
          return statement.type === "DoWhileStatement" ? entry : guard.id;
        }
        case "ReturnStatement":
          if (statement.argument) throw new UnsupportedSource(statement, "return values and escaping identities are unsupported");
          return block([exit]).id;
        case "ThrowStatement": condition(statement.argument); return block([exit]).id;
        case "BreakStatement": case "ContinueStatement": {
          const target = statement.type === "BreakStatement" ? context.breakTarget : context.continueTarget;
          if (statement.label || !target) throw new UnsupportedSource(statement, "only unlabeled loop transfers are supported");
          return block([target]).id;
        }
        default: throw new UnsupportedSource(statement, `unsupported statement: ${statement.type}`);
      }
    };
    return { status: "lowered", cfg: { entry: sequence(fn.body.body, exit, {}), blocks } };
  } catch (error) {
    if (error instanceof UnsupportedSource) return { status: "unknown", reason: "unsupported-source", detail: error.message, location: location(error.node) };
    if (error instanceof TypeError) return { status: "unknown", reason: "invalid-input", detail: error.message };
    throw error;
  }
}
