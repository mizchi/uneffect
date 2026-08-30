import { createHash } from "node:crypto";
import ts from "typescript";
import { extractAnnotations } from "./annotations.js";
import type { VerificationArtifact } from "./contracts.js";

export interface ContractSummaryExportV1 {
  symbol: { module: string; export: string };
  functionName: string;
  evidence: "verified";
  declarationSpan: { start: number; end: number };
  declarationDigest: string;
  signature: string;
  signatureDigest: string;
  parameters: string[];
  requires: string[];
  ensures: string[];
  artifactIds: string[];
}

export interface ContractSummaryBundleV1 {
  schema: "uneffect-contract-summary/v1";
  package: { name: string; version: string };
  compiler: { typescriptVersion: string; compilerOptionsDigest: string };
  producer: { fileName: string; sourceDigest: string };
  exports: ContractSummaryExportV1[];
  contentDigest: string;
}

export interface CreateContractSummaryBundleOptions {
  packageName: string;
  packageVersion: string;
  fileName: string;
  source: string;
  program: ts.Program;
  artifacts: readonly VerificationArtifact[];
}

export interface ValidateContractSummaryBundleOptions {
  packageName: string;
  packageVersion: string;
  fileName: string;
  source: string;
  program: ts.Program;
}

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");
function ordered(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(ordered);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, ordered(item)]));
  return value;
}
const canonical = (value: unknown): string => JSON.stringify(ordered(value));
const compilerOptionsDigest = (program: ts.Program): string => sha256(canonical(program.getCompilerOptions()));
const bundleDigest = (bundle: Omit<ContractSummaryBundleV1, "contentDigest">): string => sha256(canonical(bundle));

function checkedSource(options: Pick<CreateContractSummaryBundleOptions, "fileName" | "source" | "program">): ts.SourceFile {
  const source = options.program.getSourceFile(options.fileName);
  if (!source || source.text !== options.source) throw new Error(`contract summary source does not match Program source ${options.fileName}`);
  const errors = [...options.program.getSyntacticDiagnostics(source), ...options.program.getSemanticDiagnostics(source)]
    .filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
  if (errors.length > 0) throw new Error(`contract summary cannot use a Program with TypeScript errors in ${options.fileName}`);
  return source;
}

function directExportName(node: ts.FunctionDeclaration): string | undefined {
  if (!node.name || !node.modifiers?.some(({ kind }) => kind === ts.SyntaxKind.ExportKeyword)
    || node.modifiers.some(({ kind }) => kind === ts.SyntaxKind.DefaultKeyword)) return undefined;
  return node.name.text;
}

function describeExport(program: ts.Program, source: ts.SourceFile, node: ts.FunctionDeclaration, packageName: string, artifacts: readonly VerificationArtifact[]): ContractSummaryExportV1 | undefined {
  const exportName = directExportName(node);
  if (!exportName || !node.body) return undefined;
  const comments = source.text.slice(node.getFullStart(), node.getStart(source));
  const ensures = extractAnnotations(comments, "ensures");
  if (ensures.length === 0) return undefined;
  const requires = extractAnnotations(comments, "requires");
  const span = { start: node.getStart(source), end: node.getEnd() };
  const candidates = artifacts.filter((artifact) => artifact.source.fileName === source.fileName
    && artifact.obligation?.functionName === exportName && artifact.source.span.start >= span.start && artifact.source.span.end <= span.end);
  const covered = ensures.every((clause) => candidates.some((artifact) => artifact.obligation?.clause === "ensures" && artifact.obligation.source === clause));
  const verified = candidates.length > 0 && covered && candidates.every((artifact) => artifact.status === "verified"
    && (artifact.controlFlow?.relationalCalls?.every(({ evidence }) => evidence === "verified") ?? true));
  if (!verified) throw new Error(`${exportName} is not fully verified and cannot be published as a contract summary`);
  const checker = program.getTypeChecker(), signature = checker.getSignatureFromDeclaration(node);
  if (!signature) throw new Error(`${exportName} has no TypeChecker signature`);
  const signatureText = checker.signatureToString(signature, node, ts.TypeFormatFlags.NoTruncation);
  const declarationText = source.text.slice(span.start, span.end);
  return {
    symbol: { module: packageName, export: exportName }, functionName: exportName, evidence: "verified",
    declarationSpan: span, declarationDigest: sha256(declarationText),
    signature: signatureText, signatureDigest: sha256(signatureText),
    parameters: node.parameters.map((parameter) => {
      if (!ts.isIdentifier(parameter.name)) throw new Error(`${exportName} has an unsupported destructured parameter`);
      return parameter.name.text;
    }),
    requires, ensures, artifactIds: candidates.map(({ obligationId }) => obligationId).sort(),
  };
}

export function createContractSummaryBundle(options: CreateContractSummaryBundleOptions): ContractSummaryBundleV1 {
  if (!options.packageName || !options.packageVersion) throw new Error("contract summary requires package name and version");
  const source = checkedSource(options);
  const exports = source.statements.flatMap((node) => ts.isFunctionDeclaration(node)
    ? [describeExport(options.program, source, node, options.packageName, options.artifacts)].filter((item): item is ContractSummaryExportV1 => item !== undefined) : []);
  if (exports.length === 0) throw new Error("contract summary has no fully verified exported function contracts");
  const unsigned: Omit<ContractSummaryBundleV1, "contentDigest"> = {
    schema: "uneffect-contract-summary/v1",
    package: { name: options.packageName, version: options.packageVersion },
    compiler: { typescriptVersion: ts.version, compilerOptionsDigest: compilerOptionsDigest(options.program) },
    producer: { fileName: options.fileName, sourceDigest: sha256(options.source) },
    exports: exports.sort((left, right) => left.symbol.export.localeCompare(right.symbol.export)),
  };
  return { ...unsigned, contentDigest: bundleDigest(unsigned) };
}

export function validateContractSummaryBundle(bundle: ContractSummaryBundleV1, options: ValidateContractSummaryBundleOptions): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const { contentDigest, ...unsigned } = bundle;
  if (bundle.schema !== "uneffect-contract-summary/v1") errors.push(`unsupported contract summary schema ${bundle.schema}`);
  if (bundleDigest(unsigned) !== contentDigest) errors.push("contract summary content digest does not match its payload");
  if (bundle.package.name !== options.packageName) errors.push(`contract summary package name ${bundle.package.name} does not match ${options.packageName}`);
  if (bundle.package.version !== options.packageVersion) errors.push(`contract summary package version ${bundle.package.version} does not match ${options.packageVersion}`);
  if (bundle.compiler.typescriptVersion !== ts.version) errors.push(`contract summary TypeScript ${bundle.compiler.typescriptVersion} does not match ${ts.version}`);
  if (bundle.compiler.compilerOptionsDigest !== compilerOptionsDigest(options.program)) errors.push("contract summary compiler options digest does not match the consumer Program");
  if (bundle.producer.fileName !== options.fileName) errors.push(`contract summary producer ${bundle.producer.fileName} does not match ${options.fileName}`);
  if (bundle.producer.sourceDigest !== sha256(options.source)) errors.push("contract summary source digest does not match producer source");
  let source: ts.SourceFile | undefined;
  try { source = checkedSource(options); } catch (cause) { errors.push(cause instanceof Error ? cause.message : String(cause)); }
  if (source) for (const item of bundle.exports) {
    const declaration = source.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node)
      && directExportName(node) === item.symbol.export && node.getStart(source) === item.declarationSpan.start && node.getEnd() === item.declarationSpan.end);
    if (!declaration) { errors.push(`contract summary export ${item.symbol.export} does not match a direct exported function declaration`); continue; }
    const declarationText = source.text.slice(item.declarationSpan.start, item.declarationSpan.end);
    if (sha256(declarationText) !== item.declarationDigest) errors.push(`contract summary declaration digest for ${item.symbol.export} does not match source`);
    const signature = options.program.getTypeChecker().getSignatureFromDeclaration(declaration);
    const signatureText = signature ? options.program.getTypeChecker().signatureToString(signature, declaration, ts.TypeFormatFlags.NoTruncation) : undefined;
    if (!signatureText || signatureText !== item.signature || sha256(signatureText) !== item.signatureDigest) errors.push(`contract summary signature for ${item.symbol.export} does not match TypeChecker`);
  }
  return { valid: errors.length === 0, errors };
}
