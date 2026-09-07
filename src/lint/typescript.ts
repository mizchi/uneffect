import ts from "@typescript/typescript6";
import type { RuleCfg, RuleEvent, RuleLocation, TypeScriptRuleBinding, TypeScriptRuleLowering, TypeScriptRuleOptions } from "./contracts.js";
import { normalizeSourceOptions } from "./source-options.js";

class UnsupportedSource extends Error {
  constructor(readonly node: ts.Node, detail: string) { super(detail); }
}

/** Bounded synchronous, intraprocedural extraction using public AST and symbol APIs.
 * Operation semantics are caller assumptions; this does not verify their bodies.
 */
export function lowerTypeScriptRuleCfg(program: ts.Program, options: TypeScriptRuleOptions): TypeScriptRuleLowering {
  let source: ts.SourceFile | undefined;
  const location = (node: ts.Node): RuleLocation => ({ fileName: node.getSourceFile().fileName, start: node.getStart(), end: node.getEnd() });
  try {
    options = normalizeSourceOptions(options);
    source = program.getSourceFile(options.fileName);
    if (!source || source.isDeclarationFile) throw new TypeError("fileName must identify a Program source");
    const functions = source.statements.filter(ts.isFunctionDeclaration);
    const fn = functions.find(node => node.name?.text === options.functionName && node.body);
    if (!fn?.body) throw new TypeError("functionName must identify a top-level function implementation");
    if (fn.asteriskToken || fn.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword)) {
      throw new UnsupportedSource(fn, "async and generator functions are not supported");
    }
    const errors = [
      ...program.getConfigFileParsingDiagnostics(), ...program.getOptionsDiagnostics(), ...program.getGlobalDiagnostics(),
      ...program.getSyntacticDiagnostics(source), ...program.getSemanticDiagnostics(source),
    ].filter(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error);
    if (errors.length) return { status: "unknown", reason: "typescript-error",
      detail: errors.map(error => ts.flattenDiagnosticMessageText(error.messageText, "\n")).join("\n") };
    const checker = program.getTypeChecker();
    const bindings = new Map<ts.Symbol, TypeScriptRuleBinding>();
    for (const binding of options.bindings) {
      const declaration = functions.find(node => node.name?.text === binding.functionName);
      const symbol = declaration?.name && checker.getSymbolAtLocation(declaration.name);
      if (!symbol || !declaration) throw new TypeError(`operation declaration not found: ${binding.functionName}`);
      if (bindings.has(symbol)) throw new TypeError(`duplicate operation declaration: ${binding.functionName}`);
      if (binding.argumentIndex >= declaration.parameters.length) throw new TypeError(`argumentIndex outside ${binding.functionName} parameters`);
      const signatures = checker.getSignaturesOfType(checker.getTypeOfSymbolAtLocation(symbol, declaration), ts.SignatureKind.Call);
      if (!signatures.length || signatures.some(signature => !(checker.getReturnTypeOfSignature(signature).flags & ts.TypeFlags.Void))) {
        throw new UnsupportedSource(declaration, "operation declarations must return void; asynchronous operations are unsupported");
      }
      bindings.set(symbol, binding);
    }
    // A declaration's trusted operation contract cannot follow a replaced binding.
    const checkReferences = (node: ts.Node): void => {
      if (ts.isIdentifier(node)) {
        const symbol = ts.isShorthandPropertyAssignment(node.parent)
          ? checker.getShorthandAssignmentValueSymbol(node.parent) : checker.getSymbolAtLocation(node);
        if (symbol && bindings.has(symbol)) {
          for (let parent: ts.Node | undefined = node.parent; parent && !ts.isFunctionLike(parent) && !ts.isSourceFile(parent); parent = parent.parent) {
            const target = ts.isBinaryExpression(parent) && parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
              && parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment ? parent.left
              : (ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent))
                && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(parent.operator) ? parent.operand
                : ts.isForInStatement(parent) || ts.isForOfStatement(parent) ? parent.initializer : undefined;
            if (target && target.pos <= node.pos && target.end >= node.end) {
              throw new UnsupportedSource(node, "registered operation bindings must not be reassigned");
            }
          }
        }
      }
      ts.forEachChild(node, checkReferences);
    };
    checkReferences(source);
    for (const parameter of fn.parameters) {
      if (!ts.isIdentifier(parameter.name) || parameter.initializer || parameter.dotDotDotToken) {
        throw new UnsupportedSource(parameter, "only plain identifier parameters are supported");
      }
    }
    const body = fn.body;
    const identity = (declaration: ts.Declaration) => `${source!.fileName}#binding:${declaration.getStart()}`;
    const parameterIdentities = new Set(fn.parameters.map(identity));
    const usedParameters = new Set<string>();
    const unwrap = (expression: ts.Expression): ts.Expression => ts.isParenthesizedExpression(expression) ? unwrap(expression.expression) : expression;
    const localDeclaration = (identifier: ts.Identifier): ts.Declaration | undefined => {
      const declaration = checker.getSymbolAtLocation(identifier)?.valueDeclaration;
      return declaration && declaration.getSourceFile() === source && declaration.getStart() >= fn.getStart()
        && declaration.getEnd() <= fn.getEnd() ? declaration : undefined;
    };
    const subject = (expression: ts.Expression, seen = new Set<ts.Declaration>()): string | undefined => {
      expression = unwrap(expression);
      if (!ts.isIdentifier(expression)) return undefined;
      const declaration = localDeclaration(expression);
      if (!declaration || seen.has(declaration)) return undefined;
      if (ts.isParameter(declaration) && declaration.parent === fn) return identity(declaration);
      if (!ts.isVariableDeclaration(declaration) || !ts.isVariableDeclarationList(declaration.parent)
        || !(declaration.parent.flags & ts.NodeFlags.Const) || !declaration.initializer) return undefined;
      seen.add(declaration);
      const initializer = unwrap(declaration.initializer);
      if (ts.isObjectLiteralExpression(initializer) && initializer.properties.length === 0) return identity(declaration);
      return subject(initializer, seen);
    };
    const pure = (expression: ts.Expression): boolean => {
      expression = unwrap(expression);
      if (ts.isIdentifier(expression)) {
        const declaration = localDeclaration(expression);
        return !!declaration && (ts.isParameter(declaration) || ts.isVariableDeclaration(declaration));
      }
      if (expression.kind === ts.SyntaxKind.TrueKeyword || expression.kind === ts.SyntaxKind.FalseKeyword
        || expression.kind === ts.SyntaxKind.NullKeyword || ts.isNumericLiteral(expression) || ts.isStringLiteral(expression)) return true;
      // Truthiness does not invoke coercion hooks; arithmetic and comparisons may.
      if (ts.isPrefixUnaryExpression(expression) && expression.operator === ts.SyntaxKind.ExclamationToken) return pure(expression.operand);
      if (ts.isBinaryExpression(expression) && [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken,
        ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken].includes(expression.operatorToken.kind)) {
        return pure(expression.left) && pure(expression.right);
      }
      return false;
    };
    const condition = (expression: ts.Expression): void => {
      if (!pure(expression)) throw new UnsupportedSource(expression, "condition/throw expression may execute unmodeled code");
    };
    const events = (expression: ts.Expression): RuleEvent[] => {
      expression = unwrap(expression);
      if (!ts.isCallExpression(expression) || expression.questionDotToken || !ts.isIdentifier(expression.expression)) {
        throw new UnsupportedSource(expression, "only direct registered operation calls are supported");
      }
      const symbol = checker.getSymbolAtLocation(expression.expression);
      const binding = symbol && bindings.get(symbol);
      if (!binding) throw new UnsupportedSource(expression, "call does not resolve to a registered operation declaration");
      const argument = expression.arguments[binding.argumentIndex];
      const target = argument && subject(argument);
      if (!target || !expression.arguments.every(pure)) throw new UnsupportedSource(expression, "operation arguments require local identities and side-effect-free values");
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
    const sequence = (statements: readonly ts.Statement[], next: string, context: Context): string => {
      for (let index = statements.length - 1; index >= 0; index--) next = lower(statements[index]!, next, context);
      return next;
    };
    const lower = (statement: ts.Statement, next: string, context: Context): string => {
      if (ts.isBlock(statement)) return sequence(statement.statements, next, context);
      if (ts.isEmptyStatement(statement)) return next;
      if (ts.isExpressionStatement(statement)) return block([next], events(statement.expression)).id;
      if (ts.isVariableStatement(statement)) {
        if (!(statement.declarationList.flags & ts.NodeFlags.Const) || (statement.declarationList.flags & ts.NodeFlags.Using)) {
          throw new UnsupportedSource(statement, "only const local bindings without implicit disposal are supported");
        }
        for (const declaration of statement.declarationList.declarations) {
          const initializer = declaration.initializer && unwrap(declaration.initializer);
          if (initializer && ts.isObjectLiteralExpression(initializer) && context.continueTarget) {
            throw new UnsupportedSource(declaration, "fresh object identities inside loops require allocation-generation tracking");
          }
          if (!ts.isIdentifier(declaration.name) || !initializer || !(pure(initializer)
            || ts.isObjectLiteralExpression(initializer) && initializer.properties.length === 0)) {
            throw new UnsupportedSource(declaration, "only const aliases, pure values, and empty object identities are supported");
          }
        }
        return next;
      }
      if (ts.isIfStatement(statement)) {
        condition(statement.expression);
        return block([lower(statement.thenStatement, next, context), statement.elseStatement ? lower(statement.elseStatement, next, context) : next]).id;
      }
      if (ts.isWhileStatement(statement) || ts.isDoStatement(statement)) {
        condition(statement.expression);
        const guard = block([]);
        const entry = lower(statement.statement, guard.id, { breakTarget: next, continueTarget: guard.id });
        guard.successors.push(...new Set([entry, next]));
        return ts.isDoStatement(statement) ? entry : guard.id;
      }
      if (ts.isReturnStatement(statement)) {
        if (statement.expression) throw new UnsupportedSource(statement, "return values and escaping identities are unsupported");
        return block([exit]).id;
      }
      if (ts.isThrowStatement(statement)) { condition(statement.expression); return block([exit]).id; }
      if (ts.isBreakStatement(statement) || ts.isContinueStatement(statement)) {
        const target = ts.isBreakStatement(statement) ? context.breakTarget : context.continueTarget;
        if (statement.label || !target) throw new UnsupportedSource(statement, "only unlabeled loop transfers are supported");
        return block([target]).id;
      }
      throw new UnsupportedSource(statement, `unsupported statement: ${ts.SyntaxKind[statement.kind]}`);
    };
    const cfg: RuleCfg = { entry: sequence(body.statements, exit, {}), blocks };
    return { status: "lowered", cfg };
  } catch (error) {
    if (error instanceof UnsupportedSource) return { status: "unknown", reason: "unsupported-source", detail: error.message, location: location(error.node) };
    if (error instanceof TypeError) return { status: "unknown", reason: "invalid-input", detail: error.message };
    throw error;
  }
}
