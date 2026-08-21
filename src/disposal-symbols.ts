import ts from "typescript";

export interface ResolvedDisposalProtocol {
  syncSymbol?: ts.Symbol;
  asyncSymbol?: ts.Symbol;
}

function targetSymbol(checker: ts.TypeChecker, node: ts.Node): ts.Symbol | undefined {
  const symbol = checker.getSymbolAtLocation(node);
  return symbol && (symbol.flags & ts.SymbolFlags.Alias) ? checker.getAliasedSymbol(symbol) : symbol;
}

function standardProtocolExpression(checker: ts.TypeChecker, expression: ts.Expression, seen = new Set<ts.Symbol>()): "sync" | "async" | undefined {
  if (ts.isPropertyAccessExpression(expression)) {
    const access = expression;
    if (!ts.isIdentifier(access.expression) || access.expression.text !== "Symbol") return undefined;
    if (access.name.text !== "dispose" && access.name.text !== "asyncDispose") return undefined;
    const symbol = targetSymbol(checker, access.name);
    const isStandard = symbol?.declarations?.some((item) => item.getSourceFile().isDeclarationFile &&
      ts.isInterfaceDeclaration(item.parent) && item.parent.name.text === "SymbolConstructor");
    if (isStandard) return access.name.text === "asyncDispose" ? "async" : "sync";
  }
  if (ts.isIdentifier(expression)) {
    const symbol = checker.resolveName(expression.text, expression, ts.SymbolFlags.Value, false) ?? targetSymbol(checker, expression);
    if (!symbol || seen.has(symbol)) return undefined;
    for (const declaration of symbol.declarations ?? []) {
      if (declaration.getSourceFile().isDeclarationFile && ts.isInterfaceDeclaration(declaration.parent) && declaration.parent.name.text === "SymbolConstructor") {
        const name = (declaration as ts.NamedDeclaration).name;
        if (name && ts.isIdentifier(name) && (name.text === "dispose" || name.text === "asyncDispose")) return name.text === "asyncDispose" ? "async" : "sync";
      }
    }
    seen.add(symbol);
    for (const declaration of symbol.declarations ?? []) if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
      const kind = standardProtocolExpression(checker, declaration.initializer, seen);
      if (kind) return kind;
    }
  }
  return undefined;
}

function standardProtocolKind(checker: ts.TypeChecker, property: ts.Symbol): "sync" | "async" | undefined {
  for (const declaration of property.declarations ?? []) {
    const name = (declaration as ts.NamedDeclaration).name;
    if (!name || !ts.isComputedPropertyName(name)) continue;
    const kind = standardProtocolExpression(checker, name.expression);
    if (kind) return kind;
  }
  return undefined;
}

export function resolveDisposalProtocol(checker: ts.TypeChecker, expression: ts.Expression): ResolvedDisposalProtocol {
  let type = checker.getTypeAtLocation(expression);
  type = checker.getAwaitedType(type) ?? type;
  const result: ResolvedDisposalProtocol = {};
  for (const property of type.getProperties()) {
    const kind = standardProtocolKind(checker, property);
    if (kind === "sync") result.syncSymbol = property;
    if (kind === "async") result.asyncSymbol = property;
  }
  return result;
}
