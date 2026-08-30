import ts from "typescript";

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
