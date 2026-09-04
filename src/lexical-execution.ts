import ts from "@typescript/typescript6";

export type LexicalExecutionMultiplicity = "exactly-once" | "conditional" | "repeated";

/**
 * Conservative syntax-level execution multiplicity within one lexical owner.
 * This does not replace the CFG: it is the shared cheap classifier used before
 * a domain elects to build path-sensitive state.
 */
export function classifyLexicalExecution(node: ts.Node, boundary: ts.Node): LexicalExecutionMultiplicity {
  if (node === boundary) return ts.isCallExpression(node) && node.questionDotToken ? "conditional" : "exactly-once";
  let conditional = ts.isCallExpression(node) && Boolean(node.questionDotToken);
  for (let child: ts.Node = node; child.parent && child.parent !== boundary; child = child.parent) {
    const parent: ts.Node = child.parent;
    if (ts.isForStatement(parent)) {
      if (child !== parent.initializer) return "repeated";
    } else if (ts.isForInStatement(parent) || ts.isForOfStatement(parent)) {
      if (child !== parent.expression) return "repeated";
    } else if (ts.isWhileStatement(parent) || ts.isDoStatement(parent)) return "repeated";
    if (ts.isBinaryExpression(parent) && parent.right === child
      && [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken]
        .includes(parent.operatorToken.kind)) conditional = true;
    if ((ts.isParameter(parent) || ts.isBindingElement(parent)) && parent.initializer
      && child === parent.initializer) conditional = true;
    if (ts.isIfStatement(parent) && child !== parent.expression) conditional = true;
    if (ts.isConditionalExpression(parent) && child !== parent.condition) conditional = true;
    if (ts.isSwitchStatement(parent) && child !== parent.expression) conditional = true;
    if (ts.isCaseClause(parent) || ts.isDefaultClause(parent) || ts.isTryStatement(parent)
      || ts.isCatchClause(parent)) conditional = true;
    if (ts.isFunctionLike(parent)) return "conditional";
  }
  return conditional ? "conditional" : "exactly-once";
}

export function isDefinitelyLexicallyExecuted(node: ts.Node, boundary: ts.Node): boolean {
  return classifyLexicalExecution(node, boundary) === "exactly-once";
}
