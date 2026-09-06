import ts from "@typescript/typescript6";

export type TypedArrayWindowMethod = "subarray" | "slice";

/** Authenticate a typed-array window operation against TypeScript's default library. */
export function resolveBuiltinTypedArrayWindowMethod(
  program: ts.Program,
  call: ts.CallExpression,
): TypedArrayWindowMethod | undefined {
  if (!ts.isPropertyAccessExpression(call.expression)) return undefined;
  const method = call.expression.name.text;
  if (method !== "subarray" && method !== "slice") return undefined;
  const symbol = program.getTypeChecker().getSymbolAtLocation(call.expression.name);
  return symbol?.declarations?.some((declaration) => program.isSourceFileDefaultLibrary(declaration.getSourceFile()))
    ? method
    : undefined;
}
