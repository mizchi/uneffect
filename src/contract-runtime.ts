import ts from "typescript";
import { extractLocatedAnnotations } from "./annotations.js";
import type { InstrumentDiagnostic, InstrumentResult } from "./instrument.js";
import { functionMayFallThrough } from "./contract-control-flow.js";
import { createTypeScriptControlFlowBridge, type TypeScriptControlFlowBridge } from "./typescript-control-flow.js";
import type { ContractClauseProvenance } from "./contract-dsl.js";

export interface ContractRuntimeFailureMetadata {
  kind: "precondition" | "postcondition";
  fileName: string;
  line: number;
  expression: string;
  column: number;
  span: { start: number; end: number };
}

export type ContractRuntimeError = RangeError & { uneffect: ContractRuntimeFailureMetadata };

export interface InstrumentContractPredicateOptions {
  /** Reuse a Program whose SourceFile text exactly matches `text`. */
  program?: ts.Program;
  /** Original specification spans for materialized linked contracts. */
  clauseProvenance?: readonly ContractClauseProvenance[];
}

export interface RelocatedContractAliases {
  files: Record<string, string>;
  diagnostics: InstrumentDiagnostic[];
}

const runtimeContractDirectives = ["requires", "ensures", "returns", "assert", "validate"] as const;
function hasRuntimeContractAnnotation(text: string): boolean {
  return runtimeContractDirectives.some((directive) => extractLocatedAnnotations(text, directive).length > 0);
}
function runtimeContractComments(text: string): RegExpMatchArray[] {
  return [...text.matchAll(/\/\*[\s\S]*?\*\//g)].filter((comment) => hasRuntimeContractAnnotation(comment[0]));
}

function sourceHasCallableAliasContract(source: ts.SourceFile): boolean {
  let found = false;
  const visit = (current: ts.Node): void => {
    if (ts.isVariableStatement(current) && current.declarationList.declarations.length === 1) {
      const initializer = current.declarationList.declarations[0]!.initializer;
      const leading = source.text.slice(current.getFullStart(), current.getStart(source));
      if (initializer && (ts.isIdentifier(initializer) || ts.isPropertyAccessExpression(initializer) || ts.isElementAccessExpression(initializer))
        && hasRuntimeContractAnnotation(leading)) found = true;
    }
    if (!found) ts.forEachChild(current, visit);
  };
  visit(source);
  return found;
}

export function hasProjectCallableAliasContracts(files: Readonly<Record<string, string>>): boolean {
  return Object.entries(files).some(([fileName, text]) => sourceHasCallableAliasContract(ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)));
}

export function isContractRuntimeError(value: unknown): value is ContractRuntimeError {
  if (!(value instanceof RangeError) || !("uneffect" in value)) return false;
  const metadata = value.uneffect as Partial<ContractRuntimeFailureMetadata> | null;
  return metadata !== null
    && (metadata.kind === "precondition" || metadata.kind === "postcondition")
    && typeof metadata.fileName === "string"
    && Number.isInteger(metadata.line)
    && typeof metadata.expression === "string"
    && Number.isInteger(metadata.column)
    && metadata.span !== undefined
    && Number.isInteger(metadata.span.start)
    && Number.isInteger(metadata.span.end);
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

function contractFailure(fileName: string, location: { line: number; column: number; span: { start: number; end: number } }, kind: "precondition" | "postcondition", expression: string): string {
  const message = `${fileName}:${location.line}:${location.column} Uneffect ${kind} failed: ${expression}`;
  return `Object.assign(new RangeError(${JSON.stringify(message)}), { uneffect: { kind: ${JSON.stringify(kind)}, fileName: ${JSON.stringify(fileName)}, line: ${location.line}, expression: ${JSON.stringify(expression)}, column: ${location.column}, span: { start: ${location.span.start}, end: ${location.span.end} } } })`;
}

type RuntimeContractFunction = ts.FunctionDeclaration | ts.MethodDeclaration | ts.GetAccessorDeclaration | ts.SetAccessorDeclaration | ts.ArrowFunction | ts.FunctionExpression;
interface RuntimeContractCandidate { node: RuntimeContractFunction; anchor: ts.Node; immutable: boolean; stableName: boolean; alias: boolean }

function hasStableRuntimePropertyName(name: ts.PropertyName): boolean {
  if (!ts.isComputedPropertyName(name)) return true;
  return ts.isStringLiteral(name.expression) || ts.isNumericLiteral(name.expression) || ts.isNoSubstitutionTemplateLiteral(name.expression);
}

function runtimeContractCandidates(source: ts.SourceFile, bridge?: TypeScriptControlFlowBridge): RuntimeContractCandidate[] {
  const result: RuntimeContractCandidate[] = [];
  const visit = (current: ts.Node): void => {
    if (ts.isFunctionDeclaration(current) && current.body) result.push({ node: current, anchor: current, immutable: true, stableName: true, alias: false });
    if (ts.isMethodDeclaration(current) && current.body) result.push({ node: current, anchor: current, immutable: true, stableName: hasStableRuntimePropertyName(current.name), alias: false });
    if ((ts.isGetAccessorDeclaration(current) || ts.isSetAccessorDeclaration(current)) && current.body) result.push({ node: current, anchor: current, immutable: true, stableName: hasStableRuntimePropertyName(current.name), alias: false });
    if (ts.isVariableStatement(current) && current.declarationList.declarations.length === 1) {
      const declaration = current.declarationList.declarations[0]!, initializer = declaration.initializer;
      if (initializer && (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))) {
        result.push({ node: initializer, anchor: current, immutable: (current.declarationList.flags & ts.NodeFlags.Const) !== 0, stableName: true, alias: false });
      }
    }
    ts.forEachChild(current, visit);
  };
  visit(source);
  const direct = new Map<string, RuntimeContractCandidate>();
  const aliases = new Map<string, { target: string; anchor: ts.VariableStatement; immutable: boolean }>();
  for (const candidate of result) if (!candidate.alias && ts.isVariableStatement(candidate.anchor)) {
    const declaration = candidate.anchor.declarationList.declarations[0];
    if (declaration && ts.isIdentifier(declaration.name)) direct.set(declaration.name.text, candidate);
  }
  for (const statement of source.statements) if (ts.isVariableStatement(statement) && statement.declarationList.declarations.length === 1) {
    const declaration = statement.declarationList.declarations[0]!;
    if (ts.isIdentifier(declaration.name) && declaration.initializer && ts.isIdentifier(declaration.initializer)) aliases.set(declaration.name.text, {
      target: declaration.initializer.text, anchor: statement, immutable: (statement.declarationList.flags & ts.NodeFlags.Const) !== 0,
    });
  }
  const resolve = (name: string, seen = new Set<string>()): { target: RuntimeContractCandidate; immutable: boolean } | undefined => {
    if (seen.has(name)) return undefined;
    const target = direct.get(name);
    if (target) return { target, immutable: target.immutable };
    const alias = aliases.get(name);
    if (!alias) return undefined;
    const resolved = resolve(alias.target, new Set([...seen, name]));
    return resolved && { target: resolved.target, immutable: alias.immutable && resolved.immutable };
  };
  for (const [name, alias] of aliases) {
    const resolved = resolve(name);
    if (resolved) result.push({ node: resolved.target.node, anchor: alias.anchor, immutable: resolved.immutable, stableName: true, alias: true });
  }
  if (bridge) {
    const existingAnchors = new Set(result.filter((item) => item.alias).map((item) => item.anchor));
    const visitAlias = (current: ts.Node): void => {
      if (ts.isVariableStatement(current) && current.declarationList.declarations.length === 1 && !existingAnchors.has(current)) {
        const declaration = current.declarationList.declarations[0]!, initializer = declaration.initializer;
        if (initializer && (ts.isIdentifier(initializer) || ts.isPropertyAccessExpression(initializer) || ts.isElementAccessExpression(initializer))) {
          const node = bridge.resolveStableCallable(initializer);
          if (node && node.getSourceFile() === source) result.push({ node, anchor: current, immutable: (current.declarationList.flags & ts.NodeFlags.Const) !== 0, stableName: true, alias: true });
        }
      }
      ts.forEachChild(current, visitAlias);
    };
    visitAlias(source);
  }
  return result;
}

/** Move contracts on stable aliases to the source callable without creating identity-changing wrappers. */
export function relocateProjectCallableAliasContracts(files: Readonly<Record<string, string>>, program: ts.Program): RelocatedContractAliases {
  const edits = new Map<string, Array<{ start: number; end: number; text: string }>>(), diagnostics: InstrumentDiagnostic[] = [];
  const addEdit = (fileName: string, edit: { start: number; end: number; text: string }): void => {
    const current = edits.get(fileName) ?? [];
    current.push(edit);
    edits.set(fileName, current);
  };
  for (const fileName of Object.keys(files)) {
    const source = program.getSourceFile(fileName);
    if (!source || source.text !== files[fileName]) continue;
    if (!sourceHasCallableAliasContract(source)) continue;
    const bridge = createTypeScriptControlFlowBridge(fileName, source, program);
    const visit = (current: ts.Node): void => {
      if (ts.isVariableStatement(current) && current.declarationList.declarations.length === 1) {
        const declaration = current.declarationList.declarations[0]!, initializer = declaration.initializer;
        const leadingStart = current.getFullStart(), leading = source.text.slice(leadingStart, current.getStart(source));
        const comments = runtimeContractComments(leading);
        if (comments.length > 0 && initializer && (ts.isIdentifier(initializer) || ts.isPropertyAccessExpression(initializer) || ts.isElementAccessExpression(initializer))) {
          const target = bridge.resolveStableCallable(initializer), line = source.getLineAndCharacterOfPosition(current.getStart(source)).line + 1;
          if (!target) diagnostics.push({ fileName, line, kind: "unsupported-function", parameter: "<contract>", message: "runtime contracts require an immutable TypeChecker-resolved callable alias" });
          else {
            const targetSource = target.getSourceFile(), targetText = files[targetSource.fileName];
            const targetAnchor = ts.isArrowFunction(target) || ts.isFunctionExpression(target)
              ? ts.isVariableDeclaration(target.parent) && ts.isVariableStatement(target.parent.parent.parent) ? target.parent.parent.parent : undefined
              : target;
            if (targetText === undefined || !targetAnchor) diagnostics.push({ fileName, line, kind: "unsupported-function", parameter: "<contract>", message: "resolved callable alias target is outside the selected source project" });
            else for (const comment of comments) {
              const text = comment[0]!, start = leadingStart + comment.index!;
              addEdit(fileName, { start, end: start + text.length, text: "" });
              addEdit(targetSource.fileName, { start: targetAnchor.getFullStart(), end: targetAnchor.getFullStart(), text: `${text}\n` });
            }
          }
        }
      }
      ts.forEachChild(current, visit);
    };
    visit(source);
  }
  const output = { ...files };
  for (const [fileName, fileEdits] of edits) {
    let text = output[fileName]!;
    for (const edit of fileEdits.sort((left, right) => right.start - left.start || right.end - left.end)) text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
    output[fileName] = text;
  }
  return { files: output, diagnostics };
}

/** Lower the proven pure predicate fragment without importing or executing a specification module. */
export function instrumentContractPredicates(fileName: string, text: string, options: InstrumentContractPredicateOptions = {}): InstrumentResult {
  const programSource = options.program?.getSourceFile(fileName);
  const source = programSource?.text === text ? programSource : ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS), diagnostics: InstrumentDiagnostic[] = [];
  const edits: Array<{ start: number; end: number; text: string }> = [];
  let needsValibot = false;
  let controlFlowBridge: TypeScriptControlFlowBridge | undefined;
  const remainingProvenance = [...(options.clauseProvenance ?? [])];
  let needsAliasResolution = false;
  const detectAliasContract = (current: ts.Node): void => {
    if (ts.isVariableStatement(current) && current.declarationList.declarations.length === 1) {
      const initializer = current.declarationList.declarations[0]!.initializer;
      if (initializer && (ts.isIdentifier(initializer) || ts.isPropertyAccessExpression(initializer) || ts.isElementAccessExpression(initializer))) {
        const leading = source.text.slice(current.getFullStart(), current.getStart(source));
        if (hasRuntimeContractAnnotation(leading)) needsAliasResolution = true;
      }
    }
    ts.forEachChild(current, detectAliasContract);
  };
  detectAliasContract(source);
  if (needsAliasResolution) controlFlowBridge = createTypeScriptControlFlowBridge(fileName, source, source === programSource ? options.program : undefined);
  const candidates = runtimeContractCandidates(source, controlFlowBridge);
  if (needsAliasResolution) {
    const covered = new Set(candidates.filter((candidate) => candidate.alias).map((candidate) => candidate.anchor));
    const diagnoseUnresolved = (current: ts.Node): void => {
      if (ts.isVariableStatement(current) && current.declarationList.declarations.length === 1 && !covered.has(current)) {
        const initializer = current.declarationList.declarations[0]!.initializer;
        const leading = source.text.slice(current.getFullStart(), current.getStart(source));
        if (initializer && (ts.isIdentifier(initializer) || ts.isPropertyAccessExpression(initializer) || ts.isElementAccessExpression(initializer)) && hasRuntimeContractAnnotation(leading)) {
          const line = source.getLineAndCharacterOfPosition(current.getStart(source)).line + 1;
          diagnostics.push({ fileName, line, kind: "unsupported-function", parameter: "<contract>", message: "runtime contracts require an immutable TypeChecker-resolved callable alias" });
        }
      }
      ts.forEachChild(current, diagnoseUnresolved);
    };
    diagnoseUnresolved(source);
  }
  for (const candidate of candidates) {
    const { node } = candidate, body = node.body!;
    const leadingStart = candidate.anchor.getFullStart();
    const comments = source.text.slice(leadingStart, candidate.anchor.getStart(source));
    const located = (directive: "requires" | "ensures" | "returns") => extractLocatedAnnotations(comments, directive, leadingStart).map((item) => {
      const position = source.getLineAndCharacterOfPosition(item.span.start);
      const provenanceIndex = directive === "returns" ? -1 : remainingProvenance.findIndex((candidate) => candidate.kind === directive && candidate.expression === item.value);
      const provenance = provenanceIndex < 0 ? undefined : remainingProvenance.splice(provenanceIndex, 1)[0];
      return provenance ? { value: item.value, ...provenance } : { value: item.value, fileName, line: position.line + 1, column: position.character + 1, span: item.span };
    });
    const requires = located("requires"), ensures = located("ensures"), returns = located("returns");
    if (requires.length === 0 && ensures.length === 0 && returns.length === 0) continue;
    if (!candidate.stableName) {
      const line = source.getLineAndCharacterOfPosition(candidate.anchor.getStart(source)).line + 1;
      diagnostics.push({ fileName, line, kind: "unsupported-function", parameter: "<contract>", message: "runtime contracts do not support dynamic computed declaration names" });
      continue;
    }
    if (ts.isSetAccessorDeclaration(node) && (ensures.length > 0 || returns.length > 0)) {
      const line = source.getLineAndCharacterOfPosition(candidate.anchor.getStart(source)).line + 1;
      diagnostics.push({ fileName, line, kind: "unsupported-function", parameter: "result", message: "setter postconditions and return assertions are unsupported because setters have no result" });
      continue;
    }
    if (!candidate.immutable) {
      const line = source.getLineAndCharacterOfPosition(candidate.anchor.getStart(source)).line + 1;
      diagnostics.push({ fileName, line, kind: "unsupported-function", parameter: "<contract>", message: candidate.alias ? "runtime contracts require an immutable callable alias chain" : "runtime contracts require an immutable function binding" });
      continue;
    }
    const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
    const parameters = new Set(node.parameters.flatMap((parameter) => ts.isIdentifier(parameter.name) ? [parameter.name.text] : []));
    let checkedRequires: Array<{ value: string; fileName: string; line: number; column: number; span: { start: number; end: number } }>, checkedEnsures: Array<{ value: string; fileName: string; line: number; column: number; span: { start: number; end: number } }>;
    try {
      checkedRequires = requires.map((item) => ({ ...item, value: safePredicate(fileName, item.value, parameters) }));
      checkedEnsures = ensures.map((item) => ({ ...item, value: safePredicate(fileName, item.value, new Set([...parameters, "result"])) }));
    } catch (cause) {
      diagnostics.push({ fileName, line, kind: "unsupported-function", parameter: "<contract>", message: cause instanceof Error ? cause.message : String(cause) });
      continue;
    }
    if (ts.isArrowFunction(node) && !ts.isBlock(body)) {
      const usedNames = collectIdentifiers(node);
      let generatedNameIndex = 0;
      while (usedNames.has(`__uneffect_contract_result_${generatedNameIndex}`)) generatedNameIndex += 1;
      const resultName = `__uneffect_contract_result_${generatedNameIndex}`;
      const preconditions = checkedRequires.map((item) => `if (!(${item.value})) throw ${contractFailure(item.fileName, item, "precondition", item.value)};`);
      const checks = checkedEnsures.map((item) => {
        const rewritten = item.value.replace(/\bresult\b/g, resultName);
        return `if (!(${rewritten})) throw ${contractFailure(item.fileName, item, "postcondition", item.value)};`;
      });
      for (const returned of returns) {
        if (returned.value !== "Nat" && returned.value !== "Float") {
          diagnostics.push({ fileName, line: returned.line, kind: "invalid-schema", parameter: "result", message: `unsupported return assertion: ${returned.value}` });
          continue;
        }
        needsValibot = true;
        const schema = returned.value === "Nat"
          ? "__uneffect_v.pipe(__uneffect_v.number(), __uneffect_v.safeInteger(), __uneffect_v.minValue(0))"
          : "__uneffect_v.pipe(__uneffect_v.number(), __uneffect_v.finite())";
        checks.push(`__uneffect_v.parse(${schema}, ${resultName});`);
      }
      const expression = body.getText(source);
      const checkedReturn = `${checks.join(" ")} return ${resultName};`;
      const replacement = node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)
        ? `{ ${preconditions.join(" ")} return Promise.resolve(${expression}).then((${resultName}) => { ${checkedReturn} }); }`
        : `{ ${preconditions.join(" ")} const ${resultName} = (${expression}); ${checkedReturn} }`;
      edits.push({ start: body.getStart(source), end: body.getEnd(), text: replacement });
      continue;
    }
    const block = body as ts.Block;
    if (checkedRequires.length > 0) edits.push({ start: block.getStart(source) + 1, end: block.getStart(source) + 1, text: checkedRequires.map((item) => `\nif (!(${item.value})) throw ${contractFailure(item.fileName, item, "precondition", item.value)};`).join("") });
    if (checkedEnsures.length === 0 && returns.length === 0) continue;
    const isAsync = node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) ?? false;
    const structurallyFallsThrough = functionMayFallThrough(block);
    if (structurallyFallsThrough) controlFlowBridge ??= createTypeScriptControlFlowBridge(fileName, source, source === programSource ? options.program : undefined);
    const refinedFallsThrough = structurallyFallsThrough && functionMayFallThrough(block, controlFlowBridge?.options);
    if (refinedFallsThrough && controlFlowBridge?.endpointOf(node) !== "unreachable") {
      diagnostics.push({ fileName, line, kind: "unsupported-function", parameter: "result", message: "runtime postconditions require a function that cannot fall through" });
      continue;
    }
    const returned = collectFunctionReturns(block);
    if (returned.some((statement) => !statement.expression)) {
      diagnostics.push({ fileName, line, kind: "unsupported-function", parameter: "result", message: "runtime postconditions do not support bare returns" });
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
      const checks = checkedEnsures.map((item) => {
        const rewritten = item.value.replace(/\bresult\b/g, resultName);
        return `if (!(${rewritten})) throw ${contractFailure(item.fileName, item, "postcondition", item.value)};`;
      });
      for (const returned of returns) {
        if (returned.value !== "Nat" && returned.value !== "Float") {
          diagnostics.push({ fileName, line: returned.line, kind: "invalid-schema", parameter: "result", message: `unsupported return assertion: ${returned.value}` });
          continue;
        }
        needsValibot = true;
        const schema = returned.value === "Nat"
          ? "__uneffect_v.pipe(__uneffect_v.number(), __uneffect_v.safeInteger(), __uneffect_v.minValue(0))"
          : "__uneffect_v.pipe(__uneffect_v.number(), __uneffect_v.finite())";
        checks.push(`__uneffect_v.parse(${schema}, ${resultName});`);
      }
      const checkedReturn = `${checks.join(" ")} return ${resultName};`;
      const replacement = isAsync
        ? `return Promise.resolve(${expression}).then((${resultName}) => { ${checkedReturn} });`
        : `{ const ${resultName} = (${expression}); ${checkedReturn} }`;
      edits.push({ start: statement.getStart(source), end: statement.getEnd(), text: replacement });
    });
  }
  let code = text;
  for (const edit of edits.sort((left, right) => right.start - left.start)) code = code.slice(0, edit.start) + edit.text + code.slice(edit.end);
  if (needsValibot && !code.includes('import * as __uneffect_v from "valibot"')) code = `import * as __uneffect_v from "valibot";\n${code}`;
  return { code, diagnostics };
}
