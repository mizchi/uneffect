import ts from "../../support/typescript-compiler.js";

/** Stable within one source snapshot; names are deliberately excluded. */
export interface BindingIdentity {
  readonly fileName: string;
  readonly declarationStart: number;
}

export function resolvedSymbol(checker: ts.TypeChecker, node: ts.Node): ts.Symbol | undefined {
  const direct = ts.isShorthandPropertyAssignment(node)
    ? checker.getShorthandAssignmentValueSymbol(node)
    : checker.getSymbolAtLocation(node);
  return direct && (direct.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(direct) : direct;
}

/**
 * A receiver whose value is an array literal, under the wrappers that preserve its identity. `ReadonlyArray`
 * names no ECMA-262 object, so no contract is keyed on it, but an expression written as a literal allocates a
 * genuine Array whatever interface the checker names for its type — including the readonly tuple `as const`
 * produces. A `const` binding fixes which object the name denotes, and a conditional selects between literals
 * without producing anything else, so both preserve the claim; a `let`, a parameter, a destructured binding,
 * or an initializer this cannot see through does not. Passing no checker restricts the answer to the literal
 * written at the site. Overwriting the member on the bound object, or replacing its prototype, is outside
 * this claim exactly as it is for any receiver the checker types as `Array`. This is the one shared
 * definition of the condition, so every engine narrows the same way.
 */
export function isArrayLiteralReceiver(
  expression: ts.Expression,
  checker?: ts.TypeChecker,
  seen: Set<ts.Symbol> = new Set(),
): boolean {
  let receiver = expression;
  while (ts.isParenthesizedExpression(receiver) || ts.isAsExpression(receiver)
    || ts.isTypeAssertionExpression(receiver) || ts.isSatisfiesExpression(receiver)
    || ts.isNonNullExpression(receiver)) receiver = receiver.expression;
  if (ts.isArrayLiteralExpression(receiver)) return true;
  if (ts.isConditionalExpression(receiver)) {
    return isArrayLiteralReceiver(receiver.whenTrue, checker, seen)
      && isArrayLiteralReceiver(receiver.whenFalse, checker, seen);
  }
  if (!checker || !ts.isIdentifier(receiver)) return false;
  const symbol = resolvedSymbol(checker, receiver);
  if (!symbol || seen.has(symbol)) return false;
  seen.add(symbol);
  const declaration = symbol.valueDeclaration;
  return Boolean(declaration && ts.isVariableDeclaration(declaration) && ts.isIdentifier(declaration.name)
    && ts.isVariableDeclarationList(declaration.parent)
    && (declaration.parent.flags & ts.NodeFlags.Const) !== 0
    && declaration.initializer && isArrayLiteralReceiver(declaration.initializer, checker, seen));
}

export function bindingIdentity(symbol: ts.Symbol | undefined): BindingIdentity | undefined {
  const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
  return declaration ? { fileName: declaration.getSourceFile().fileName, declarationStart: declaration.getStart() } : undefined;
}

export function bindingIdentityKey(identity: BindingIdentity): string {
  return `${identity.fileName}:${identity.declarationStart}`;
}

export function symbolIdentityKey(symbol: ts.Symbol | undefined): string | undefined {
  const identity = bindingIdentity(symbol);
  return identity && bindingIdentityKey(identity);
}
