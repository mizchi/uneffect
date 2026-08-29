import ts from "typescript";
import type { DiagnosticNote, DiagnosticSeverity } from "./diagnostics.js";

export interface TrustedTypesDiagnostic {
  domain: "trusted-types";
  kind: "untrusted-script-sink";
  severity: DiagnosticSeverity;
  fileName: string;
  line: number;
  functionName: string;
  sink: string;
  message: string;
  notes: DiagnosticNote[];
}

function targetSymbol(checker: ts.TypeChecker, node: ts.Node): ts.Symbol | undefined {
  const symbol = checker.getSymbolAtLocation(node);
  return symbol && (symbol.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(symbol) : symbol;
}

function isPlatformGlobal(checker: ts.TypeChecker, node: ts.Identifier, expected: string): boolean {
  if (node.text !== expected) return false;
  return targetSymbol(checker, node)?.declarations?.some((declaration) => {
    const file = declaration.getSourceFile().fileName;
    return file.endsWith("lib.es5.d.ts") || file.endsWith("lib.dom.d.ts") || file.endsWith("lib.webworker.d.ts");
  }) ?? false;
}

function constInitializer(checker: ts.TypeChecker, expression: ts.Expression): ts.Expression | undefined {
  if (!ts.isIdentifier(expression)) return undefined;
  const declaration = targetSymbol(checker, expression)?.valueDeclaration;
  return declaration && ts.isVariableDeclaration(declaration) && declaration.initializer
    && (declaration.parent.flags & ts.NodeFlags.Const) !== 0 ? declaration.initializer : undefined;
}

function isTrustedTypesFactory(checker: ts.TypeChecker, expression: ts.Expression): boolean {
  if (ts.isIdentifier(expression)) {
    if (expression.text !== "trustedTypes") return false;
    const declaration = targetSymbol(checker, expression)?.declarations?.[0];
    if (!declaration) return false;
    let statement: ts.Node | undefined = declaration;
    while (statement && !ts.isVariableStatement(statement)) statement = statement.parent;
    return statement !== undefined && ts.isSourceFile(statement.parent);
  }
  return ts.isPropertyAccessExpression(expression) && expression.name.text === "trustedTypes"
    && ts.isIdentifier(expression.expression) && isPlatformGlobal(checker, expression.expression, "globalThis");
}

function isTrustedPolicy(checker: ts.TypeChecker, expression: ts.Expression, seen: Set<ts.Symbol>): boolean {
  const initializer = constInitializer(checker, expression);
  if (initializer) {
    const symbol = ts.isIdentifier(expression) ? targetSymbol(checker, expression) : undefined;
    if (symbol && seen.has(symbol)) return false;
    if (symbol) seen.add(symbol);
    return isTrustedPolicy(checker, initializer, seen);
  }
  return ts.isCallExpression(expression) && ts.isPropertyAccessExpression(expression.expression)
    && expression.expression.name.text === "createPolicy"
    && isTrustedTypesFactory(checker, expression.expression.expression);
}

function isTrustedScript(checker: ts.TypeChecker, expression: ts.Expression, seen = new Set<ts.Symbol>()): boolean {
  if (ts.isParenthesizedExpression(expression) || ts.isNonNullExpression(expression)) return isTrustedScript(checker, expression.expression, seen);
  if (ts.isAsExpression(expression) || ts.isTypeAssertionExpression(expression) || ts.isSatisfiesExpression(expression)) return false;
  const initializer = constInitializer(checker, expression);
  if (initializer) {
    const symbol = ts.isIdentifier(expression) ? targetSymbol(checker, expression) : undefined;
    if (symbol && seen.has(symbol)) return false;
    if (symbol) seen.add(symbol);
    return isTrustedScript(checker, initializer, seen);
  }
  if (ts.isPropertyAccessExpression(expression) && expression.name.text === "emptyScript") {
    return isTrustedTypesFactory(checker, expression.expression);
  }
  return ts.isCallExpression(expression) && ts.isPropertyAccessExpression(expression.expression)
    && expression.expression.name.text === "createScript"
    && isTrustedPolicy(checker, expression.expression.expression, seen);
}

function isCallable(checker: ts.TypeChecker, expression: ts.Expression): boolean {
  return checker.getSignaturesOfType(checker.getTypeAtLocation(expression), ts.SignatureKind.Call).length > 0;
}

function isScriptElement(checker: ts.TypeChecker, expression: ts.Expression): boolean {
  const initializer = constInitializer(checker, expression);
  if (initializer) return isScriptElement(checker, initializer);
  if (ts.isCallExpression(expression) && ts.isPropertyAccessExpression(expression.expression)
    && expression.expression.name.text === "createElement" && expression.arguments[0]
    && ts.isStringLiteralLike(expression.arguments[0]) && expression.arguments[0].text.toLowerCase() === "script") return true;
  const symbol = checker.getTypeAtLocation(expression).getSymbol();
  return symbol?.name === "HTMLScriptElement"
    && (symbol.declarations?.some((declaration) => declaration.getSourceFile().fileName.endsWith("lib.dom.d.ts")) ?? false);
}

function ownerName(node: ts.Node): string {
  for (let current: ts.Node | undefined = node; current; current = current.parent) {
    if (ts.isFunctionDeclaration(current) && current.name) return current.name.text;
    if (ts.isMethodDeclaration(current) && current.name) return current.name.getText();
  }
  return "<module>";
}

function diagnostic(source: ts.SourceFile, node: ts.Node, sink: string): TrustedTypesDiagnostic {
  return {
    domain: "trusted-types", kind: "untrusted-script-sink", severity: "error", fileName: source.fileName,
    line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1, functionName: ownerName(node), sink,
    message: `untrusted value reaches the ${sink} TrustedScript sink`,
    notes: [
      { label: "because", detail: "the value is not traced to trustedTypes.createPolicy(...).createScript(...) or trustedTypes.emptyScript" },
      { label: "boundary", detail: "this checks source provenance; it does not prove CSP deployment or policy sanitizer correctness" },
    ],
  };
}

export function analyzeTrustedScriptSinks(program: ts.Program, source: ts.SourceFile): TrustedTypesDiagnostic[] {
  const checker = program.getTypeChecker(), diagnostics: TrustedTypesDiagnostic[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.arguments[0]) {
      const name = node.expression.text;
      const sink = name === "eval" && isPlatformGlobal(checker, node.expression, "eval") ? "eval"
        : (name === "setTimeout" || name === "setInterval") && isPlatformGlobal(checker, node.expression, name)
          && !isCallable(checker, node.arguments[0]) ? name : undefined;
      if (sink && !isTrustedScript(checker, node.arguments[0])) diagnostics.push(diagnostic(source, node.arguments[0], sink));
    }
    if ((ts.isNewExpression(node) || ts.isCallExpression(node)) && ts.isIdentifier(node.expression)
      && isPlatformGlobal(checker, node.expression, "Function") && node.arguments?.length) {
      const body = node.arguments[node.arguments.length - 1]!;
      if (!isTrustedScript(checker, body)) diagnostics.push(diagnostic(source, body, "Function"));
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && ts.isPropertyAccessExpression(node.left) && ["innerText", "text", "textContent"].includes(node.left.name.text)
      && isScriptElement(checker, node.left.expression) && !isTrustedScript(checker, node.right)) {
      diagnostics.push(diagnostic(source, node.right, `HTMLScriptElement.${node.left.name.text}`));
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return diagnostics;
}
