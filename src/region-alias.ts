import ts from "typescript";

export interface RegionAliasEvidence {
  readonly name: string;
  readonly binding: "const";
  readonly span: { readonly start: number; readonly end: number };
}

export type StableRegionResolution =
  | {
    readonly status: "resolved";
    readonly region: string;
    readonly regionId: string;
    readonly aliases: readonly RegionAliasEvidence[];
    /** TypeScript declarations cannot generally prove the runtime descriptor is a data property. */
    readonly runtimeDescriptorUnchecked: boolean;
  }
  | {
    readonly status: "unknown";
    readonly reason: "mutable-binding" | "missing-initializer" | "computed-key" | "alias-escape" | "alias-cycle" | "unsupported-expression";
    readonly span: { readonly start: number; readonly end: number };
  };

export interface ResolveStableRegionOptions {
  /** Lexical owner inside which every use of an alias must be accounted for. */
  readonly scope: ts.Node;
  /** The one use currently being reduced, normally a direct call argument. */
  readonly permittedUse: ts.Expression;
  /** Additional reviewed uses, such as repeated builtin receiver accesses. */
  readonly permittedUses?: readonly ts.Expression[];
}

const plainMember = /^[A-Za-z_$][\w$]*$/u;

function resolvedSymbol(checker: ts.TypeChecker, node: ts.Node): ts.Symbol | undefined {
  const symbol = checker.getSymbolAtLocation(node);
  return symbol && (symbol.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(symbol) : symbol;
}

function rootRegionId(symbol: ts.Symbol | undefined, expression: ts.Expression): string {
  const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
  return declaration
    ? `region:${declaration.getSourceFile().fileName}:${declaration.getStart()}`
    : `region:${expression.getSourceFile().fileName}:${expression.getText()}`;
}

function unwrap(expression: ts.Expression): ts.Expression {
  if (ts.isParenthesizedExpression(expression) || ts.isNonNullExpression(expression)
    || ts.isAsExpression(expression) || ts.isTypeAssertionExpression(expression)) return unwrap(expression.expression);
  return expression;
}

function unknown(reason: Extract<StableRegionResolution, { status: "unknown" }>["reason"], node: ts.Node): StableRegionResolution {
  return { status: "unknown", reason, span: { start: node.getStart(), end: node.getEnd() } };
}

function isConstBinding(declaration: ts.VariableDeclaration): boolean {
  return ts.isVariableDeclarationList(declaration.parent) && (declaration.parent.flags & ts.NodeFlags.Const) !== 0;
}

function hasUnaccountedUse(
  checker: ts.TypeChecker,
  scope: ts.Node,
  symbol: ts.Symbol,
  declaration: ts.VariableDeclaration,
  permittedUse: ts.Expression,
  permittedUses: readonly ts.Expression[],
): boolean {
  let escaped = false;
  const visit = (node: ts.Node): void => {
    if (escaped) return;
    if (ts.isIdentifier(node) && resolvedSymbol(checker, node) === symbol
      && node !== declaration.name && node !== permittedUse
      && !permittedUses.includes(node as ts.Expression)) {
      escaped = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(scope);
  return escaped;
}

function propertyDescriptorUnchecked(checker: ts.TypeChecker, access: ts.PropertyAccessExpression | ts.ElementAccessExpression): boolean {
  const location = ts.isPropertyAccessExpression(access) ? access.name : access.argumentExpression;
  const symbol = location ? resolvedSymbol(checker, location) : undefined;
  if (!symbol) return true;
  return !symbol.declarations?.every((declaration) => ts.isPropertyDeclaration(declaration)
    || ts.isPropertyAssignment(declaration) || ts.isShorthandPropertyAssignment(declaration)
    || ts.isParameter(declaration) && Boolean(ts.getModifiers(declaration)?.some((modifier) =>
      modifier.kind === ts.SyntaxKind.PublicKeyword || modifier.kind === ts.SyntaxKind.PrivateKeyword
      || modifier.kind === ts.SyntaxKind.ProtectedKeyword || modifier.kind === ts.SyntaxKind.ReadonlyKeyword)));
}

/**
 * Resolves the conservative region identity of one direct expression. This is
 * alias evidence only: `runtimeDescriptorUnchecked` keeps property evaluation
 * from being mistaken for proof that no getter/proxy code can run.
 */
export function resolveStableRegion(
  checker: ts.TypeChecker,
  input: ts.Expression,
  options: ResolveStableRegionOptions,
): StableRegionResolution {
  const resolve = (raw: ts.Expression, permittedUse: ts.Expression, seen: ReadonlySet<ts.Symbol>): StableRegionResolution => {
    const expression = unwrap(raw);
    if (expression.kind === ts.SyntaxKind.ThisKeyword) {
      return { status: "resolved", region: "this", regionId: rootRegionId(undefined, expression), aliases: [], runtimeDescriptorUnchecked: false };
    }
    if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
      let member: string;
      if (ts.isPropertyAccessExpression(expression)) member = expression.name.text;
      else if (ts.isStringLiteralLike(expression.argumentExpression)) member = plainMember.test(expression.argumentExpression.text)
        ? expression.argumentExpression.text : `[${JSON.stringify(expression.argumentExpression.text)}]`;
      else return unknown("computed-key", expression);
      const base = resolve(expression.expression, expression.expression, seen);
      if (base.status === "unknown") return base;
      const separator = member.startsWith("[") ? "" : ".";
      return {
        ...base,
        region: `${base.region}${separator}${member}`,
        runtimeDescriptorUnchecked: base.runtimeDescriptorUnchecked || propertyDescriptorUnchecked(checker, expression),
      };
    }
    if (!ts.isIdentifier(expression)) return unknown("unsupported-expression", expression);
    const symbol = resolvedSymbol(checker, expression);
    const declaration = symbol?.declarations?.find((candidate): candidate is ts.VariableDeclaration =>
      ts.isVariableDeclaration(candidate) && ts.isIdentifier(candidate.name));
    if (!symbol || !declaration) {
      return { status: "resolved", region: expression.text, regionId: rootRegionId(symbol, expression), aliases: [], runtimeDescriptorUnchecked: false };
    }
    if (!ts.isIdentifier(declaration.name)) return unknown("unsupported-expression", declaration.name);
    if (seen.has(symbol)) return unknown("alias-cycle", expression);
    if (!isConstBinding(declaration)) return unknown("mutable-binding", declaration.name);
    if (!declaration.initializer) return unknown("missing-initializer", declaration.name);
    if (hasUnaccountedUse(checker, options.scope, symbol, declaration, permittedUse, options.permittedUses ?? [])) return unknown("alias-escape", expression);
    const target = resolve(declaration.initializer, declaration.initializer, new Set([...seen, symbol]));
    if (target.status === "unknown") return target;
    return {
      ...target,
      aliases: [{
        name: declaration.name.text,
        binding: "const",
        span: { start: declaration.name.getStart(), end: declaration.name.getEnd() },
      }, ...target.aliases],
    };
  };
  return resolve(input, options.permittedUse, new Set());
}

/**
 * Resolve object identity without claiming that the value did not escape.
 * Intended only for correlating independently observed events; callers must
 * not use this result as non-escape or mutation-safety evidence.
 */
export function resolveRegionIdentity(checker: ts.TypeChecker, input: ts.Expression): StableRegionResolution {
  return resolveStableRegion(checker, input, { scope: input, permittedUse: input });
}
