import ts from "typescript";
import { extractAnnotations } from "./annotations.js";
import type { InstrumentDiagnostic, InstrumentResult } from "./instrument.js";

function leading(source: ts.SourceFile, node: ts.Node): string {
  return source.text.slice(node.getFullStart(), node.getStart(source));
}

function safePredicate(fileName: string, text: string, allowed: ReadonlySet<string>): string {
  const source = ts.createSourceFile(fileName, `const __value = (${text})`, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const declaration = source.statements[0];
  const expression = declaration && ts.isVariableStatement(declaration) ? declaration.declarationList.declarations[0]?.initializer : undefined;
  const visit = (node: ts.Node): boolean => {
    if (ts.isParenthesizedExpression(node)) return visit(node.expression);
    if (ts.isIdentifier(node)) return allowed.has(node.text);
    if (ts.isNumericLiteral(node) || node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword) return true;
    if (ts.isPrefixUnaryExpression(node)) return [ts.SyntaxKind.ExclamationToken, ts.SyntaxKind.MinusToken, ts.SyntaxKind.PlusToken].includes(node.operator) && visit(node.operand);
    if (ts.isBinaryExpression(node)) return [
      ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken,
      ts.SyntaxKind.LessThanToken, ts.SyntaxKind.LessThanEqualsToken, ts.SyntaxKind.GreaterThanToken, ts.SyntaxKind.GreaterThanEqualsToken,
      ts.SyntaxKind.PlusToken, ts.SyntaxKind.MinusToken, ts.SyntaxKind.AsteriskToken, ts.SyntaxKind.SlashToken, ts.SyntaxKind.PercentToken,
      ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken,
    ].includes(node.operatorToken.kind) && visit(node.left) && visit(node.right);
    return false;
  };
  if (!expression || !visit(expression)) throw new Error(`unsupported runtime contract predicate: ${text}`);
  return text;
}

function collectFunctionReturns(body: ts.Block): ts.ReturnStatement[] {
  const returned: ts.ReturnStatement[] = [];
  const visit = (node: ts.Node): void => {
    if (node !== body && ts.isFunctionLike(node)) return;
    if (ts.isReturnStatement(node)) {
      returned.push(node);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(body);
  return returned;
}

function collectIdentifiers(node: ts.Node): Set<string> {
  const identifiers = new Set<string>();
  const visit = (current: ts.Node): void => {
    if (ts.isIdentifier(current)) identifiers.add(current.text);
    ts.forEachChild(current, visit);
  };
  visit(node);
  return identifiers;
}

function statementDefinitelyExits(statement: ts.Statement): boolean {
  if (ts.isReturnStatement(statement) || ts.isThrowStatement(statement)) return true;
  if (ts.isBlock(statement)) return blockDefinitelyExits(statement);
  if (ts.isIfStatement(statement)) {
    return statement.elseStatement !== undefined
      && statementDefinitelyExits(statement.thenStatement)
      && statementDefinitelyExits(statement.elseStatement);
  }
  return false;
}

function blockDefinitelyExits(block: ts.Block): boolean {
  return block.statements.some(statementDefinitelyExits);
}

/** Lower the proven pure predicate fragment without importing or executing a specification module. */
export function instrumentContractPredicates(fileName: string, text: string): InstrumentResult {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS), diagnostics: InstrumentDiagnostic[] = [];
  const edits: Array<{ start: number; end: number; text: string }> = [];
  let needsValibot = false;
  for (const node of source.statements) {
    if (!ts.isFunctionDeclaration(node) || !node.body) continue;
    const comments = leading(source, node), requires = extractAnnotations(comments, "requires"), ensures = extractAnnotations(comments, "ensures"), returns = extractAnnotations(comments, "returns");
    if (requires.length === 0 && ensures.length === 0 && returns.length === 0) continue;
    const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
    const parameters = new Set(node.parameters.flatMap((parameter) => ts.isIdentifier(parameter.name) ? [parameter.name.text] : []));
    let checkedRequires: string[], checkedEnsures: string[];
    try {
      checkedRequires = requires.map((value) => safePredicate(fileName, value, parameters));
      checkedEnsures = ensures.map((value) => safePredicate(fileName, value, new Set([...parameters, "result"])));
    } catch (cause) {
      diagnostics.push({ fileName, line, kind: "unsupported-function", parameter: "<contract>", message: cause instanceof Error ? cause.message : String(cause) });
      continue;
    }
    if (checkedRequires.length > 0) edits.push({ start: node.body.getStart(source) + 1, end: node.body.getStart(source) + 1, text: checkedRequires.map((value) => `\nif (!(${value})) throw new RangeError(${JSON.stringify(`Uneffect precondition failed: ${value}`)});`).join("") });
    if (checkedEnsures.length === 0 && returns.length === 0) continue;
    if (node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)) {
      diagnostics.push({ fileName, line, kind: "unsupported-function", parameter: "result", message: "runtime postconditions currently require a synchronous function" });
      continue;
    }
    if (!blockDefinitelyExits(node.body)) {
      diagnostics.push({ fileName, line, kind: "unsupported-function", parameter: "result", message: "runtime postconditions require a function that cannot fall through" });
      continue;
    }
    const returned = collectFunctionReturns(node.body);
    if (returned.length === 0 || returned.some((statement) => !statement.expression)) {
      diagnostics.push({ fileName, line, kind: "unsupported-function", parameter: "result", message: "runtime postconditions require at least one value return and do not support bare returns" });
      continue;
    }
    const usedNames = collectIdentifiers(node);
    let generatedNameIndex = 0;
    returned.forEach((statement) => {
      while (usedNames.has(`__uneffect_contract_result_${generatedNameIndex}`)) generatedNameIndex += 1;
      const resultName = `__uneffect_contract_result_${generatedNameIndex}`;
      usedNames.add(resultName);
      generatedNameIndex += 1;
      const expression = statement.expression!.getText(source);
      const checks = checkedEnsures.map((value) => {
        const rewritten = value.replace(/\bresult\b/g, resultName);
        return `if (!(${rewritten})) throw new RangeError(${JSON.stringify(`Uneffect postcondition failed: ${value}`)});`;
      });
      for (const domain of returns) {
        if (domain !== "Nat" && domain !== "Float") {
          diagnostics.push({ fileName, line, kind: "invalid-schema", parameter: "result", message: `unsupported return assertion: ${domain}` });
          continue;
        }
        needsValibot = true;
        const schema = domain === "Nat"
          ? "__uneffect_v.pipe(__uneffect_v.number(), __uneffect_v.safeInteger(), __uneffect_v.minValue(0))"
          : "__uneffect_v.pipe(__uneffect_v.number(), __uneffect_v.finite())";
        checks.push(`__uneffect_v.parse(${schema}, ${resultName});`);
      }
      edits.push({ start: statement.getStart(source), end: statement.getEnd(), text: `{ const ${resultName} = (${expression}); ${checks.join(" ")} return ${resultName}; }` });
    });
  }
  let code = text;
  for (const edit of edits.sort((left, right) => right.start - left.start)) code = code.slice(0, edit.start) + edit.text + code.slice(edit.end);
  if (needsValibot && !code.includes('import * as __uneffect_v from "valibot"')) code = `import * as __uneffect_v from "valibot";\n${code}`;
  return { code, diagnostics };
}
