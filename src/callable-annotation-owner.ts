import ts from "@typescript/typescript6";

/** Resolve the statement that owns leading Uneffect annotations for a callable. */
export function callableAnnotationOwner(node: ts.Node): ts.Node {
  if (!ts.isArrowFunction(node) && !ts.isFunctionExpression(node)) return node;
  let expression: ts.Node = node;
  while (expression.parent && (ts.isParenthesizedExpression(expression.parent)
    || ts.isAsExpression(expression.parent) || ts.isTypeAssertionExpression(expression.parent)
    || ts.isSatisfiesExpression(expression.parent) || ts.isNonNullExpression(expression.parent))
    && expression.parent.expression === expression) expression = expression.parent;
  if (expression.parent && ts.isExportAssignment(expression.parent) && expression.parent.expression === expression) return expression.parent;
  if (expression.parent && ts.isVariableDeclaration(expression.parent) && expression.parent.initializer === expression) {
    const list = expression.parent.parent;
    if (ts.isVariableDeclarationList(list) && ts.isVariableStatement(list.parent)) return list.parent;
  }
  return node;
}
