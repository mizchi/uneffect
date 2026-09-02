import ts from "typescript";

function resolvedSymbol(checker: ts.TypeChecker, node: ts.Node): ts.Symbol | undefined {
  const symbol = checker.getSymbolAtLocation(node);
  return symbol && (symbol.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(symbol) : symbol;
}

function unwrap(expression: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(expression) || ts.isNonNullExpression(expression)
    || ts.isAsExpression(expression) || ts.isTypeAssertionExpression(expression)) expression = expression.expression;
  return expression;
}

function isConstVariable(declaration: ts.VariableDeclaration): boolean {
  return ts.isVariableDeclarationList(declaration.parent) && (declaration.parent.flags & ts.NodeFlags.Const) !== 0;
}

function isBuiltinObjectFreeze(checker: ts.TypeChecker, call: ts.CallExpression): boolean {
  if (!ts.isPropertyAccessExpression(call.expression) || call.expression.name.text !== "freeze") return false;
  const objectSymbol = resolvedSymbol(checker, call.expression.expression);
  const symbol = resolvedSymbol(checker, call.expression.name);
  const fromLib = (candidate: ts.Symbol | undefined): boolean => {
    const declarations = candidate?.declarations ?? [];
    return declarations.length > 0 && declarations.every((declaration) => declaration.getSourceFile().isDeclarationFile
      && /(?:^|[/\\])lib\.(?:es\d+|esnext|d)\b.*\.d\.ts$/u.test(declaration.getSourceFile().fileName));
  };
  return fromLib(objectSymbol) && fromLib(symbol);
}

function staticElementKey(expression: ts.ElementAccessExpression): string | undefined {
  const key = expression.argumentExpression && unwrap(expression.argumentExpression);
  return key && (ts.isStringLiteralLike(key) || ts.isNumericLiteral(key)) ? key.text : undefined;
}

function frozenLiteralForReceiver(
  checker: ts.TypeChecker,
  input: ts.Expression,
  seen: ReadonlySet<ts.Symbol>,
): ts.ObjectLiteralExpression | undefined {
  const expression = unwrap(input);
  if (!ts.isIdentifier(expression)) return undefined;
  const symbol = resolvedSymbol(checker, expression);
  if (!symbol || seen.has(symbol)) return undefined;
  for (const declaration of symbol.declarations ?? []) {
    if (!ts.isVariableDeclaration(declaration) || !isConstVariable(declaration) || !declaration.initializer) continue;
    const initializer = unwrap(declaration.initializer);
    if (ts.isCallExpression(initializer) && isBuiltinObjectFreeze(checker, initializer)
      && initializer.arguments.length === 1 && ts.isObjectLiteralExpression(initializer.arguments[0])) return initializer.arguments[0];
    if (ts.isIdentifier(initializer)) {
      const result = frozenLiteralForReceiver(checker, initializer, new Set(seen).add(symbol));
      if (result) return result;
    }
  }
  return undefined;
}

/**
 * Resolves the declaration identity of a callable through references whose
 * target cannot change: import aliases, const alias chains, and own properties
 * of an authenticated `Object.freeze({...})` literal.
 *
 * Mutable bindings, ordinary object properties, getters, computed dynamic
 * keys, calls returning callables, and prototype dispatch fail closed.
 */
export function resolveStableCallableSymbol(
  checker: ts.TypeChecker,
  input: ts.Expression,
  seen: ReadonlySet<ts.Symbol> = new Set(),
): ts.Symbol | undefined {
  const expression = unwrap(input);
  if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
    const propertyLocation = ts.isPropertyAccessExpression(expression) ? expression.name : expression.argumentExpression;
    const propertySymbol = propertyLocation ? resolvedSymbol(checker, propertyLocation) : undefined;
    if (propertySymbol?.declarations?.some((declaration) => ts.isMethodDeclaration(declaration)
      || ts.isMethodSignature(declaration))) return propertySymbol;
    const key = ts.isPropertyAccessExpression(expression) ? expression.name.text : staticElementKey(expression);
    const object = key === undefined ? undefined : frozenLiteralForReceiver(checker, expression.expression, seen);
    if (!object) return undefined;
    const property = object.properties.find((candidate) => {
      if (!ts.isPropertyAssignment(candidate) && !ts.isShorthandPropertyAssignment(candidate)) return false;
      const name = candidate.name;
      return (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) && name.text === key;
    });
    if (!property) return undefined;
    if (ts.isPropertyAssignment(property)) return resolveStableCallableSymbol(checker, property.initializer, seen);
    const value = checker.getShorthandAssignmentValueSymbol(property);
    if (!value || seen.has(value)) return undefined;
    for (const declaration of value.declarations ?? []) {
      if (ts.isFunctionDeclaration(declaration) || ts.isMethodDeclaration(declaration)) return value;
      if (ts.isVariableDeclaration(declaration) && isConstVariable(declaration) && declaration.initializer) {
        const initializer = unwrap(declaration.initializer);
        if (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) return value;
        return resolveStableCallableSymbol(checker, initializer, new Set(seen).add(value));
      }
    }
    return undefined;
  }
  const location = ts.isPropertyAccessExpression(expression) ? expression.name
    : ts.isElementAccessExpression(expression) ? expression.argumentExpression : expression;
  const symbol = location ? resolvedSymbol(checker, location) : undefined;
  if (!symbol || seen.has(symbol)) return undefined;
  const nextSeen = new Set(seen).add(symbol);

  for (const declaration of symbol.declarations ?? []) {
    if (ts.isFunctionDeclaration(declaration) || ts.isMethodDeclaration(declaration)
      || ts.isMethodSignature(declaration) || ts.isCallSignatureDeclaration(declaration)) return symbol;
    if (ts.isVariableDeclaration(declaration) && isConstVariable(declaration) && declaration.initializer) {
      const initializer = unwrap(declaration.initializer);
      if (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) return symbol;
      if (ts.isIdentifier(initializer) || ts.isPropertyAccessExpression(initializer) || ts.isElementAccessExpression(initializer)) {
        const target = resolveStableCallableSymbol(checker, initializer, nextSeen);
        if (target) return target;
      }
    }
  }
  return undefined;
}

export type StableCallableDeclaration = ts.FunctionDeclaration | ts.MethodDeclaration | ts.MethodSignature
  | ts.CallSignatureDeclaration | ts.ArrowFunction | ts.FunctionExpression;

/** Returns the callable declaration/body represented by a stable symbol. */
export function stableCallableDeclaration(symbol: ts.Symbol): StableCallableDeclaration | undefined {
  for (const declaration of symbol.declarations ?? []) {
    if (ts.isFunctionDeclaration(declaration) || ts.isMethodDeclaration(declaration)
      || ts.isMethodSignature(declaration) || ts.isCallSignatureDeclaration(declaration)) return declaration;
    if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
      const initializer = unwrap(declaration.initializer);
      if (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) return initializer;
    }
    if (ts.isPropertyAssignment(declaration)) {
      const initializer = unwrap(declaration.initializer);
      if (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) return initializer;
    }
  }
  return undefined;
}
