import ts from "typescript";
import { extractAnnotations } from "./annotations.js";
import { analyzeAsyncSafety, type AsyncSafetyResult, type OwnershipGuardObligation } from "./async-safety.js";
import { validateOwnershipEvidence, verifyOwnershipObligationWithZ3, type OwnershipEvidenceArtifact } from "./evidence.js";
import { applyOwnershipAssertionElision } from "./optimizer.js";
import { ownershipEvidenceKey, readOwnershipEvidenceCache, writeOwnershipEvidenceCache, type OwnershipEvidenceCacheEntry } from "./ownership-evidence-cache.js";

export interface InstrumentDiagnostic {
  fileName: string;
  line: number;
  kind: "unknown-parameter" | "invalid-schema" | "unsupported-function";
  parameter: string;
  message: string;
}

export interface InstrumentResult {
  code: string;
  diagnostics: InstrumentDiagnostic[];
}
export interface OwnershipAssertionInsertion { obligation: OwnershipGuardObligation; assertion: string }
export interface OwnershipInstrumentResult extends InstrumentResult {
  analysis: AsyncSafetyResult;
  assertions: OwnershipAssertionInsertion[];
}
export interface VerifiedOwnershipBuildResult extends InstrumentResult {
  artifacts: OwnershipEvidenceArtifact[];
  unresolved: OwnershipGuardObligation[];
}
export interface CachedVerifiedOwnershipBuildResult extends VerifiedOwnershipBuildResult {
  cache: { reused: number; verified: number; stale: OwnershipEvidenceCacheEntry[] };
}

const namedSchemas: Record<string, string> = {
  Int: "v.pipe(v.number(), v.safeInteger())",
  Nat: "v.pipe(v.number(), v.safeInteger(), v.minValue(0))",
  Float: "v.pipe(v.number(), v.finite())",
};

function leadingText(source: ts.SourceFile, node: ts.Node): string {
  return source.text.slice(node.getFullStart(), node.getStart(source));
}

function parseSchemaExpression(text: string): ts.Expression | undefined {
  const source = ts.createSourceFile(
    "schema.ts",
    `const __schema = (${text})`,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const parseDiagnostics = (source as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics;
  if (parseDiagnostics && parseDiagnostics.length > 0) return undefined;
  const statement = source.statements[0];
  return statement && ts.isVariableStatement(statement)
    ? statement.declarationList.declarations[0]?.initializer
    : undefined;
}

function isSafeValibotExpression(node: ts.Node): boolean {
  if (ts.isParenthesizedExpression(node)) return isSafeValibotExpression(node.expression);
  if (ts.isStringLiteral(node) || ts.isNumericLiteral(node) || node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword || node.kind === ts.SyntaxKind.NullKeyword) return true;
  if (ts.isIdentifier(node)) return node.text === "v" || node.text === "undefined";
  if (ts.isPropertyAccessExpression(node)) return isSafeValibotExpression(node.expression) && ts.isIdentifier(node.name);
  if (ts.isCallExpression(node)) return isSafeValibotExpression(node.expression) && node.arguments.every(isSafeValibotExpression);
  if (ts.isArrayLiteralExpression(node)) return node.elements.every(isSafeValibotExpression);
  if (ts.isObjectLiteralExpression(node)) return node.properties.every((property) =>
    ts.isPropertyAssignment(property) && !ts.isComputedPropertyName(property.name) && isSafeValibotExpression(property.initializer));
  return false;
}

function schemaCode(input: string): string | undefined {
  const expanded = namedSchemas[input] ?? input;
  const expression = parseSchemaExpression(expanded);
  if (!expression || !isSafeValibotExpression(expression)) return undefined;
  return expanded.replace(/\bv\./g, "__uneffect_v.");
}

export function instrumentRuntimeAssertions(fileName: string, text: string): InstrumentResult {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const diagnostics: InstrumentDiagnostic[] = [];
  const insertions: Array<{ position: number; text: string }> = [];
  for (const node of source.statements) {
    if (!ts.isFunctionDeclaration(node)) continue;
    const comments = leadingText(source, node);
    const assertions = extractAnnotations(comments, "assert").flatMap((payload) => {
      const match = /^([A-Za-z_$][\w$]*)\s*:\s*([\s\S]+)$/.exec(payload);
      return match ? [match] : [];
    });
    if (assertions.length === 0) continue;
    const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
    if (!node.body) {
      for (const assertion of assertions) diagnostics.push({ fileName, line, kind: "unsupported-function", parameter: assertion[1]!, message: "runtime assertions require a function body" });
      continue;
    }
    const parameters = new Set(node.parameters.flatMap((parameter) => ts.isIdentifier(parameter.name) ? [parameter.name.text] : []));
    const statements: string[] = [];
    for (const assertion of assertions) {
      const parameter = assertion[1]!, schema = assertion[2]!.trim();
      if (!parameters.has(parameter)) {
        diagnostics.push({ fileName, line, kind: "unknown-parameter", parameter, message: `unknown parameter ${parameter}` });
        continue;
      }
      const compiled = schemaCode(schema);
      if (!compiled) {
        diagnostics.push({ fileName, line, kind: "invalid-schema", parameter, message: `unsupported Valibot schema: ${schema}` });
        continue;
      }
      statements.push(`\n__uneffect_v.parse(${compiled}, ${parameter});`);
    }
    if (statements.length > 0) insertions.push({ position: node.body.getStart(source) + 1, text: statements.join("") });
  }
  if (insertions.length === 0) return { code: text, diagnostics };
  let code = text;
  for (const insertion of insertions.sort((a, b) => b.position - a.position)) code = code.slice(0, insertion.position) + insertion.text + code.slice(insertion.position);
  code = `import * as __uneffect_v from "valibot";\n${code}`;
  return { code, diagnostics };
}

const ownershipRuntime = `function uneffectAssertOwnership(condition: boolean, detail: string): asserts condition { if (!condition) throw new Error("Uneffect ownership assertion failed: " + detail) }\n`;

/** Inserts runtime checks only for unresolved, direct expression-statement ownership calls. */
export function instrumentOwnershipAssertions(fileName: string, text: string): OwnershipInstrumentResult {
  const analysis = analyzeAsyncSafety(fileName, text), source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const diagnostics: InstrumentDiagnostic[] = [], insertions: Array<{ position: number; text: string }> = [], assertions: OwnershipAssertionInsertion[] = [];
  for (const obligation of analysis.ownershipObligations.filter((item) => item.status === "unresolved")) {
    let target: ts.Node | undefined;
    const find = (node: ts.Node): void => {
      if (target || obligation.span.start < node.getStart(source) || obligation.span.end > node.getEnd()) return;
      if (ts.isCallExpression(node) && node.getStart(source) === obligation.span.start && node.getEnd() === obligation.span.end) { target = node; return; }
      ts.forEachChild(node, find);
    };
    find(source);
    if (!target || !ts.isCallExpression(target) || !ts.isExpressionStatement(target.parent)) {
      diagnostics.push({ fileName, line: source.getLineAndCharacterOfPosition(obligation.span.start).line + 1, kind: "unsupported-function", parameter: String(obligation.parameter), message: "ownership runtime assertions currently require a direct expression-statement call" });
      continue;
    }
    const detail = `${obligation.owner}:${obligation.span.start}:${obligation.parameter}`;
    const assertion = `uneffectAssertOwnership(${obligation.goal}, ${JSON.stringify(detail)});`;
    insertions.push({ position: target.parent.getStart(source), text: `${assertion}\n` });
    assertions.push({ obligation, assertion });
  }
  let code = text;
  for (const insertion of insertions.sort((left, right) => right.position - left.position)) code = code.slice(0, insertion.position) + insertion.text + code.slice(insertion.position);
  if (assertions.length > 0) code = ownershipRuntime + code;
  return { code, diagnostics, analysis, assertions };
}

/** Elides generated checks only when a matching proof artifact validates. */
export function optimizeOwnershipAssertions(result: OwnershipInstrumentResult, artifacts: readonly OwnershipEvidenceArtifact[]): InstrumentResult {
  let code = result.code;
  for (const item of result.assertions) {
    const artifact = artifacts.find((candidate) => validateOwnershipEvidence(candidate, item.obligation));
    if (!artifact) continue;
    const start = code.indexOf(item.assertion);
    if (start < 0) continue;
    code = applyOwnershipAssertionElision(code, { schema: "ownership-guard-elision/v1", ownership: item.obligation, artifact, generatedAssertion: true }, { start, end: start + item.assertion.length }).code;
  }
  if (code.startsWith(ownershipRuntime) && result.assertions.every((item) => !code.includes(item.assertion))) code = code.slice(ownershipRuntime.length);
  return { code, diagnostics: result.diagnostics };
}

/** Runs the deterministic ownership instrumentation, Z3 verification, and safe generated-check elision pipeline. */
export async function buildVerifiedOwnership(fileName: string, text: string): Promise<VerifiedOwnershipBuildResult> {
  const instrumented = instrumentOwnershipAssertions(fileName, text);
  const artifacts: OwnershipEvidenceArtifact[] = [];
  for (const item of instrumented.assertions) artifacts.push(await verifyOwnershipObligationWithZ3(item.obligation));
  const optimized = optimizeOwnershipAssertions(instrumented, artifacts);
  const unresolved = instrumented.assertions
    .filter((item) => !artifacts.some((artifact) => validateOwnershipEvidence(artifact, item.obligation)))
    .map((item) => item.obligation);
  return { code: optimized.code, diagnostics: optimized.diagnostics, artifacts, unresolved };
}

/** Reuses only matching proof-grade evidence and atomically persists newly checked obligations. */
export async function buildVerifiedOwnershipCached(fileName: string, text: string, evidencePath: string): Promise<CachedVerifiedOwnershipBuildResult> {
  const instrumented = instrumentOwnershipAssertions(fileName, text);
  const cache = readOwnershipEvidenceCache(evidencePath);
  const artifacts: OwnershipEvidenceArtifact[] = [], stale: OwnershipEvidenceCacheEntry[] = [];
  let reused = 0, verified = 0;
  const updated = [...cache.entries];
  const occurrences = new Map<string, number>();
  for (const assertion of instrumented.assertions) {
    const base = ownershipEvidenceKey(fileName, assertion.obligation);
    const occurrence = occurrences.get(base) ?? 0;
    occurrences.set(base, occurrence + 1);
    const key = ownershipEvidenceKey(fileName, assertion.obligation, occurrence);
    const candidates = cache.entries.filter((entry) => entry.key === key);
    const matching = candidates.find((entry) => validateOwnershipEvidence(entry.artifact, assertion.obligation));
    let artifact: OwnershipEvidenceArtifact;
    if (matching) { artifact = matching.artifact; reused += 1; }
    else {
      stale.push(...candidates.filter((entry) => entry.artifact?.result === "verified" && entry.artifact.evidence === "verified"));
      artifact = await verifyOwnershipObligationWithZ3(assertion.obligation);
      verified += 1;
    }
    artifacts.push(artifact);
    const entry = { fileName, key, obligation: assertion.obligation, artifact };
    const index = updated.findIndex((item) => item.key === key);
    if (index < 0) updated.push(entry); else updated[index] = entry;
  }
  writeOwnershipEvidenceCache(evidencePath, { schema: "ownership-evidence-cache/v1", entries: updated });
  const optimized = optimizeOwnershipAssertions(instrumented, artifacts);
  const unresolved = instrumented.assertions.filter((item) => !artifacts.some((artifact) => validateOwnershipEvidence(artifact, item.obligation))).map((item) => item.obligation);
  return { code: optimized.code, diagnostics: optimized.diagnostics, artifacts, unresolved, cache: { reused, verified, stale } };
}
