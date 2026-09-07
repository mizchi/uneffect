import { parseSync, type Expression } from "oxc-parser";

/** Parse exactly one expression; user text must not escape the synthetic wrapper. */
export function parseOxcExpression(text: string, context: string): { expression: Expression; source: string } {
  const prefix = "const __value = (", source = `${prefix}${text})`;
  const file = parseSync("expression.ts", source, { lang: "ts" });
  const invalid = () => new Error(`invalid ${context} expression: ${text}`);
  if (file.errors.length || file.program.body.length !== 1) throw invalid();
  const statement = file.program.body[0];
  if (statement?.type !== "VariableDeclaration" || statement.declarations.length !== 1) throw invalid();
  const expression = statement.declarations[0]?.init;
  if (!expression || expression.type !== "ParenthesizedExpression" || expression.start !== prefix.length - 1 || expression.end !== source.length) throw invalid();
  return { expression, source };
}
