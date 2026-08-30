import ts from "typescript";

export type NumberValueClass = "finite" | "nan" | "positive-infinity" | "negative-infinity" | "negative-zero" | "unknown";

export interface NumberSemanticFact {
  readonly binding?: string;
  readonly expression: string;
  readonly valueClass: NumberValueClass;
  readonly exactValue?: number;
  readonly operation?: "Math.fround";
  readonly evidence: "exact" | "unknown";
  readonly span: { start: number; end: number };
}

export interface NumberSemanticsAnalysis {
  readonly fileName: string;
  readonly facts: readonly NumberSemanticFact[];
}

interface ClassifiedNumber {
  valueClass: NumberValueClass;
  exactValue?: number;
  operation?: "Math.fround";
  evidence: "exact" | "unknown";
}

function numberClass(value: number): NumberValueClass {
  if (Number.isNaN(value)) return "nan";
  if (value === Number.POSITIVE_INFINITY) return "positive-infinity";
  if (value === Number.NEGATIVE_INFINITY) return "negative-infinity";
  if (Object.is(value, -0)) return "negative-zero";
  return "finite";
}

function resolvedSymbol(checker: ts.TypeChecker, node: ts.Node): ts.Symbol | undefined {
  const symbol = checker.getSymbolAtLocation(node);
  return symbol && (symbol.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(symbol) : symbol;
}

export function analyzeNumberSemanticsInProgram(program: ts.Program, source: ts.SourceFile): NumberSemanticsAnalysis {
  const checker = program.getTypeChecker();
  const builtin = (node: ts.Node): boolean => resolvedSymbol(checker, node)?.declarations?.some((declaration) =>
    program.isSourceFileDefaultLibrary(declaration.getSourceFile())) ?? false;
  const exact = (value: number, operation?: "Math.fround"): ClassifiedNumber => ({
    valueClass: numberClass(value), exactValue: value, ...(operation ? { operation } : {}), evidence: "exact",
  });
  const unknown = (): ClassifiedNumber => ({ valueClass: "unknown", evidence: "unknown" });
  const classify = (input: ts.Expression): ClassifiedNumber => {
    const expression = ts.isParenthesizedExpression(input) || ts.isAsExpression(input)
      || ts.isTypeAssertionExpression(input) || ts.isNonNullExpression(input) ? input.expression : input;
    if (expression !== input) return classify(expression);
    if (ts.isNumericLiteral(expression)) return exact(Number(expression.text));
    if (ts.isPrefixUnaryExpression(expression)) {
      const operand = classify(expression.operand);
      if (operand.evidence !== "exact" || operand.exactValue === undefined) return unknown();
      if (expression.operator === ts.SyntaxKind.MinusToken) return exact(-operand.exactValue);
      if (expression.operator === ts.SyntaxKind.PlusToken) return exact(+operand.exactValue);
      return unknown();
    }
    if (ts.isIdentifier(expression) && builtin(expression)) {
      if (expression.text === "NaN") return exact(Number.NaN);
      if (expression.text === "Infinity") return exact(Number.POSITIVE_INFINITY);
    }
    if (ts.isPropertyAccessExpression(expression) && builtin(expression.name)) {
      if (expression.expression.getText(source) === "Number") {
        if (expression.name.text === "NaN") return exact(Number.NaN);
        if (expression.name.text === "POSITIVE_INFINITY") return exact(Number.POSITIVE_INFINITY);
        if (expression.name.text === "NEGATIVE_INFINITY") return exact(Number.NEGATIVE_INFINITY);
      }
    }
    if (ts.isBinaryExpression(expression)) {
      const left = classify(expression.left), right = classify(expression.right);
      if (left.evidence !== "exact" || right.evidence !== "exact"
        || left.exactValue === undefined || right.exactValue === undefined) return unknown();
      if (expression.operatorToken.kind === ts.SyntaxKind.PlusToken) return exact(left.exactValue + right.exactValue);
      if (expression.operatorToken.kind === ts.SyntaxKind.MinusToken) return exact(left.exactValue - right.exactValue);
      if (expression.operatorToken.kind === ts.SyntaxKind.AsteriskToken) return exact(left.exactValue * right.exactValue);
      if (expression.operatorToken.kind === ts.SyntaxKind.SlashToken) return exact(left.exactValue / right.exactValue);
      return unknown();
    }
    if (ts.isCallExpression(expression) && ts.isPropertyAccessExpression(expression.expression)
      && expression.expression.name.text === "fround" && builtin(expression.expression.name)
      && expression.arguments.length === 1) {
      const argument = classify(expression.arguments[0]!);
      return argument.evidence === "exact" && argument.exactValue !== undefined
        ? exact(Math.fround(argument.exactValue), "Math.fround") : unknown();
    }
    return unknown();
  };
  const facts: NumberSemanticFact[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && node.initializer) {
      const result = classify(node.initializer);
      facts.push({
        ...(ts.isIdentifier(node.name) ? { binding: node.name.text } : {}),
        expression: node.initializer.getText(source),
        ...result,
        span: { start: node.initializer.getStart(source), end: node.initializer.getEnd() },
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { fileName: source.fileName, facts };
}
