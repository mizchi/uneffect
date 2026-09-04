import ts from "@typescript/typescript6";

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

function staticPropertyKey(name: ts.PropertyName): string | undefined {
  return ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name) ? name.text : undefined;
}

function objectProperty(object: ts.ObjectLiteralExpression, key: string): ts.PropertyAssignment | ts.ShorthandPropertyAssignment | undefined {
  return object.properties.find((candidate): candidate is ts.PropertyAssignment | ts.ShorthandPropertyAssignment =>
    (ts.isPropertyAssignment(candidate) || ts.isShorthandPropertyAssignment(candidate)) && staticPropertyKey(candidate.name) === key);
}

function callableLeaf(symbol: ts.Symbol): boolean {
  return symbol.declarations?.some((declaration) => ts.isFunctionDeclaration(declaration)
    || ts.isMethodDeclaration(declaration) || ts.isMethodSignature(declaration)
    || ts.isCallSignatureDeclaration(declaration)
    || ts.isVariableDeclaration(declaration) && isConstVariable(declaration) && Boolean(declaration.initializer)
      && (ts.isArrowFunction(unwrap(declaration.initializer!)) || ts.isFunctionExpression(unwrap(declaration.initializer!)))) === true;
}

function moduleNamespaceForReceiver(
  checker: ts.TypeChecker,
  input: ts.Expression,
  seen: ReadonlySet<ts.Symbol>,
): ts.Symbol | undefined {
  const expression = unwrap(input);
  if (!ts.isIdentifier(expression)) return undefined;
  const raw = checker.getSymbolAtLocation(expression);
  if (!raw || seen.has(raw)) return undefined;
  if ((raw.flags & ts.SymbolFlags.Alias) !== 0 && raw.declarations?.some(ts.isNamespaceImport)) {
    const module = checker.getAliasedSymbol(raw);
    return (module.flags & (ts.SymbolFlags.ValueModule | ts.SymbolFlags.NamespaceModule)) !== 0 ? module : undefined;
  }
  const symbol = (raw.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(raw) : raw;
  for (const declaration of symbol.declarations ?? []) {
    if (!ts.isVariableDeclaration(declaration) || !isConstVariable(declaration) || !declaration.initializer) continue;
    const result = moduleNamespaceForReceiver(checker, declaration.initializer, new Set(seen).add(raw));
    if (result) return result;
  }
  return undefined;
}

function frozenLiteralForReceiver(
  checker: ts.TypeChecker,
  input: ts.Expression,
  seen: ReadonlySet<ts.Symbol>,
): ts.ObjectLiteralExpression | undefined {
  const expression = unwrap(input);
  if (ts.isCallExpression(expression) && isBuiltinObjectFreeze(checker, expression)
    && expression.arguments.length === 1 && ts.isObjectLiteralExpression(expression.arguments[0])) {
    return expression.arguments[0];
  }
  if (!ts.isIdentifier(expression)) return undefined;
  const symbol = resolvedSymbol(checker, expression);
  if (!symbol || seen.has(symbol)) return undefined;
  for (const declaration of symbol.declarations ?? []) {
    if (!ts.isVariableDeclaration(declaration) || !isConstVariable(declaration) || !declaration.initializer) continue;
    const initializer = unwrap(declaration.initializer);
    const frozen = frozenLiteralForReceiver(checker, initializer, new Set(seen).add(symbol));
    if (frozen) return frozen;
  }
  return undefined;
}

/** Resolve the literal protected by the builtin Object.freeze for a stable binding. */
export function resolveFrozenObjectLiteral(
  checker: ts.TypeChecker,
  input: ts.Expression,
): ts.ObjectLiteralExpression | undefined {
  return frozenLiteralForReceiver(checker, input, new Set());
}

/** Verify that an expression reaches a specific exported root through const-only static member edges. */
export function hasStableRootPath(
  checker: ts.TypeChecker,
  input: ts.Expression,
  roots: ReadonlySet<ts.Symbol>,
  path: readonly string[],
  seen: ReadonlySet<ts.Symbol> = new Set(),
): boolean {
  const expression = unwrap(input);
  const location = ts.isPropertyAccessExpression(expression) ? expression.name
    : ts.isElementAccessExpression(expression) ? expression.argumentExpression : expression;
  const symbol = location ? resolvedSymbol(checker, location) : undefined;
  if (path.length === 0 && symbol && roots.has(symbol)) return true;
  if (ts.isIdentifier(expression) && symbol && !seen.has(symbol)) {
    const declaration = symbol.valueDeclaration;
    if (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer
      && ts.isVariableDeclarationList(declaration.parent) && (declaration.parent.flags & ts.NodeFlags.Const) !== 0) {
      return hasStableRootPath(checker, declaration.initializer, roots, path, new Set(seen).add(symbol));
    }
    if (declaration && ts.isBindingElement(declaration) && ts.isObjectBindingPattern(declaration.parent)
      && path.length > 0) {
      const variable = declaration.parent.parent;
      const keyNode = declaration.propertyName ?? (ts.isIdentifier(declaration.name) ? declaration.name : undefined);
      const key = keyNode && (ts.isIdentifier(keyNode) || ts.isStringLiteralLike(keyNode)
        || ts.isNumericLiteral(keyNode)) ? keyNode.text : undefined;
      if (key === path[path.length - 1] && ts.isVariableDeclaration(variable) && variable.initializer
        && ts.isVariableDeclarationList(variable.parent) && (variable.parent.flags & ts.NodeFlags.Const) !== 0) {
        return hasStableRootPath(checker, variable.initializer, roots, path.slice(0, -1), new Set(seen).add(symbol));
      }
    }
  }
  if (path.length === 0) return false;
  const expected = path[path.length - 1];
  const access = ts.isPropertyAccessExpression(expression) ? { receiver: expression.expression, key: expression.name.text }
    : ts.isElementAccessExpression(expression) && expression.argumentExpression
      && (ts.isStringLiteralLike(expression.argumentExpression) || ts.isNumericLiteral(expression.argumentExpression))
      ? { receiver: expression.expression, key: expression.argumentExpression.text } : undefined;
  return access?.key === expected && hasStableRootPath(checker, access.receiver, roots, path.slice(0, -1), seen);
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
    if (key === undefined) return undefined;
    const module = moduleNamespaceForReceiver(checker, expression.expression, seen);
    if (module) {
      const exported = checker.getExportsOfModule(module).find((candidate) => candidate.name === key);
      const target = exported && (exported.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(exported) : exported;
      return target && callableLeaf(target) ? target : undefined;
    }
    const object = frozenLiteralForReceiver(checker, expression.expression, seen);
    if (!object) return undefined;
    const property = objectProperty(object, key);
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
    if (ts.isBindingElement(declaration) && ts.isObjectBindingPattern(declaration.parent)) {
      const variable = declaration.parent.parent;
      if (!ts.isVariableDeclaration(variable) || !isConstVariable(variable) || !variable.initializer) continue;
      const key = declaration.propertyName ? staticPropertyKey(declaration.propertyName)
        : ts.isIdentifier(declaration.name) ? declaration.name.text : undefined;
      const module = key === undefined ? undefined : moduleNamespaceForReceiver(checker, variable.initializer, nextSeen);
      if (module) {
        const exported = checker.getExportsOfModule(module).find((candidate) => candidate.name === key);
        const target = exported && (exported.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(exported) : exported;
        if (target && callableLeaf(target)) return target;
      }
      const object = key === undefined ? undefined : frozenLiteralForReceiver(checker, variable.initializer, nextSeen);
      const property = object && objectProperty(object, key!);
      if (!property) continue;
      if (ts.isPropertyAssignment(property)) {
        const target = resolveStableCallableSymbol(checker, property.initializer, nextSeen);
        if (target) return target;
      } else {
        const value = checker.getShorthandAssignmentValueSymbol(property);
        if (!value || nextSeen.has(value)) continue;
        for (const valueDeclaration of value.declarations ?? []) {
          if (ts.isFunctionDeclaration(valueDeclaration) || ts.isMethodDeclaration(valueDeclaration)) return value;
          if (ts.isVariableDeclaration(valueDeclaration) && isConstVariable(valueDeclaration) && valueDeclaration.initializer) {
            const target = resolveStableCallableSymbol(checker, valueDeclaration.initializer, new Set(nextSeen).add(value));
            if (target) return target;
          }
        }
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
