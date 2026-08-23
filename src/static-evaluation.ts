import ts from "typescript";

export type StaticPrimitive = string | number | boolean;

export interface StaticIdentifierResolution {
  key: unknown;
  expression?: ts.Expression;
  value?: StaticPrimitive;
}

export interface StaticEvaluationOptions {
  resolveIdentifier(identifier: ts.Identifier): StaticIdentifierResolution | undefined;
}

/** A deliberately finite evaluator for proof-directed TypeScript control flow. */
export function evaluateStaticPrimitive(
  expression: ts.Expression,
  options: StaticEvaluationOptions,
  seen = new Set<unknown>(),
): StaticPrimitive | undefined {
  if (expression.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (expression.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) return expression.text;
  if (ts.isNumericLiteral(expression)) return Number(expression.text);
  if (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression)
    || ts.isTypeAssertionExpression(expression) || ts.isNonNullExpression(expression)) {
    return evaluateStaticPrimitive(expression.expression, options, seen);
  }
  if (ts.isPrefixUnaryExpression(expression) && expression.operator === ts.SyntaxKind.ExclamationToken) {
    const operand = evaluateStaticPrimitive(expression.operand, options, seen);
    return typeof operand === "boolean" ? !operand : undefined;
  }
  if (ts.isBinaryExpression(expression)
    && (expression.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
      || expression.operatorToken.kind === ts.SyntaxKind.BarBarToken)) {
    const left = evaluateStaticPrimitive(expression.left, options, new Set(seen));
    if (typeof left !== "boolean") return undefined;
    if (expression.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken && !left) return false;
    if (expression.operatorToken.kind === ts.SyntaxKind.BarBarToken && left) return true;
    const right = evaluateStaticPrimitive(expression.right, options, new Set(seen));
    return typeof right === "boolean" ? right : undefined;
  }
  if (ts.isBinaryExpression(expression)
    && (expression.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken
      || expression.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken)) {
    const left = evaluateStaticPrimitive(expression.left, options, new Set(seen));
    const right = evaluateStaticPrimitive(expression.right, options, new Set(seen));
    if (left === undefined || right === undefined) return undefined;
    const equal = left === right;
    return expression.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ? equal : !equal;
  }
  if (!ts.isIdentifier(expression)) return undefined;
  const resolved = options.resolveIdentifier(expression);
  if (!resolved || seen.has(resolved.key)) return undefined;
  if (resolved.value !== undefined) return resolved.value;
  return resolved.expression && resolved.expression !== expression
    ? evaluateStaticPrimitive(resolved.expression, options, new Set([...seen, resolved.key]))
    : undefined;
}

export function evaluateStaticBoolean(expression: ts.Expression, options: StaticEvaluationOptions): boolean | undefined {
  const value = evaluateStaticPrimitive(expression, options);
  return typeof value === "boolean" ? value : undefined;
}
