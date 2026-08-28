import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import ts from "typescript";

export const declarationTransformManifestSchema = "uneffect-declaration-transforms/v1" as const;
export const declarationTransformEvidenceSchema = "uneffect-declaration-transform-evidence/v1" as const;

export interface EmbeddedTypeScriptTransform {
  profile: "embedded-typescript/v1";
  transform: { name: string; version: string };
  sourceFile: string;
  generatedFile: string;
  /** Absolute UTF-16 offsets in sourceFile. The selected text must equal generatedFile byte-for-byte as a JS string. */
  sourceSpan: { start: number; end: number };
  sourceDigest: string;
  generatedDigest: string;
  compilerVersion: string;
}

export interface DeclarationTransformManifest {
  schema: typeof declarationTransformManifestSchema;
  transforms: EmbeddedTypeScriptTransform[];
}

export type DeclarationTransformDiagnosticCode =
  | "compiler-version-mismatch"
  | "source-missing"
  | "generated-missing"
  | "source-digest-mismatch"
  | "generated-digest-mismatch"
  | "source-span-out-of-bounds"
  | "source-span-mismatch";

export interface DeclarationTransformDiagnostic {
  code: DeclarationTransformDiagnosticCode;
  sourceFile: string;
  generatedFile: string;
  message: string;
}

export interface DeclarationTransformEvidence extends EmbeddedTypeScriptTransform {
  schema: typeof declarationTransformEvidenceSchema;
  status: "verified";
}

export interface DeclarationTransformValidation {
  status: "verified" | "missing" | "mismatch";
  evidence: DeclarationTransformEvidence[];
  diagnostics: DeclarationTransformDiagnostic[];
}

export class DeclarationTransformManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeclarationTransformManifestError";
  }
}

function fail(path: string, message: string): never {
  throw new DeclarationTransformManifestError(`${path}: ${message}`);
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(path, "expected an object");
  return value as Record<string, unknown>;
}

function keys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) fail(path, `unknown key ${unknown[0]}`);
}

function string(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) fail(path, "expected a non-empty string");
  return value;
}

function digest(value: unknown, path: string): string {
  const result = string(value, path);
  if (!/^[0-9a-f]{64}$/u.test(result)) fail(path, "expected a lowercase SHA-256 digest");
  return result;
}

function offset(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) fail(path, "expected a non-negative safe integer");
  return value;
}

function filePath(value: unknown, path: string, baseDirectory: string): string {
  const result = string(value, path);
  return resolve(isAbsolute(result) ? result : resolve(baseDirectory, result));
}

/** Strictly parses the transform manifest; relative paths are resolved against baseDirectory. */
export function parseDeclarationTransformManifest(value: unknown, baseDirectory = process.cwd()): DeclarationTransformManifest {
  const input = record(value, "manifest");
  keys(input, ["schema", "transforms"], "manifest");
  if (input.schema !== declarationTransformManifestSchema) fail("manifest.schema", `unsupported schema ${JSON.stringify(input.schema)}`);
  if (!Array.isArray(input.transforms)) fail("manifest.transforms", "expected an array");
  const transforms = input.transforms.map((item, index): EmbeddedTypeScriptTransform => {
    const path = `manifest.transforms[${index}]`, entry = record(item, path);
    keys(entry, ["profile", "transform", "sourceFile", "generatedFile", "sourceSpan", "sourceDigest", "generatedDigest", "compilerVersion"], path);
    if (entry.profile !== "embedded-typescript/v1") fail(`${path}.profile`, `unsupported declaration transform profile ${JSON.stringify(entry.profile)}`);
    const transform = record(entry.transform, `${path}.transform`);
    keys(transform, ["name", "version"], `${path}.transform`);
    const span = record(entry.sourceSpan, `${path}.sourceSpan`);
    keys(span, ["start", "end"], `${path}.sourceSpan`);
    const start = offset(span.start, `${path}.sourceSpan.start`), end = offset(span.end, `${path}.sourceSpan.end`);
    if (end < start) fail(`${path}.sourceSpan`, "end must be greater than or equal to start");
    return {
      profile: "embedded-typescript/v1",
      transform: { name: string(transform.name, `${path}.transform.name`), version: string(transform.version, `${path}.transform.version`) },
      sourceFile: filePath(entry.sourceFile, `${path}.sourceFile`, baseDirectory),
      generatedFile: filePath(entry.generatedFile, `${path}.generatedFile`, baseDirectory),
      sourceSpan: { start, end },
      sourceDigest: digest(entry.sourceDigest, `${path}.sourceDigest`),
      generatedDigest: digest(entry.generatedDigest, `${path}.generatedDigest`),
      compilerVersion: string(entry.compilerVersion, `${path}.compilerVersion`),
    };
  });
  const generated = new Set<string>();
  for (const [index, entry] of transforms.entries()) {
    if (generated.has(entry.generatedFile)) fail(`manifest.transforms[${index}].generatedFile`, "duplicate generated file");
    generated.add(entry.generatedFile);
  }
  return { schema: declarationTransformManifestSchema, transforms };
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function diagnostic(entry: EmbeddedTypeScriptTransform, code: DeclarationTransformDiagnosticCode, message: string): DeclarationTransformDiagnostic {
  return { code, sourceFile: entry.sourceFile, generatedFile: entry.generatedFile, message };
}

/** Validates the complete source -> exact embedded TS span relation without trusting the transform implementation. */
export function validateDeclarationTransformManifest(manifest: DeclarationTransformManifest): DeclarationTransformValidation {
  const evidence: DeclarationTransformEvidence[] = [], diagnostics: DeclarationTransformDiagnostic[] = [];
  for (const entry of manifest.transforms) {
    if (entry.compilerVersion !== ts.version) {
      diagnostics.push(diagnostic(entry, "compiler-version-mismatch", `transform compiler version ${entry.compilerVersion} does not match analyzer TypeScript ${ts.version}`));
      continue;
    }
    const source = ts.sys.readFile(entry.sourceFile), generated = ts.sys.readFile(entry.generatedFile);
    if (source === undefined) diagnostics.push(diagnostic(entry, "source-missing", `transform source file is missing: ${entry.sourceFile}`));
    if (generated === undefined) diagnostics.push(diagnostic(entry, "generated-missing", `generated TypeScript file is missing: ${entry.generatedFile}`));
    if (source === undefined || generated === undefined) continue;
    if (sha256(source) !== entry.sourceDigest) diagnostics.push(diagnostic(entry, "source-digest-mismatch", `transform source digest does not match ${entry.sourceDigest}`));
    if (sha256(generated) !== entry.generatedDigest) diagnostics.push(diagnostic(entry, "generated-digest-mismatch", `generated TypeScript digest does not match ${entry.generatedDigest}`));
    const { start, end } = entry.sourceSpan;
    if (end > source.length) diagnostics.push(diagnostic(entry, "source-span-out-of-bounds", `source span ${start}:${end} exceeds source length ${source.length}`));
    else if (source.slice(start, end) !== generated) diagnostics.push(diagnostic(entry, "source-span-mismatch", "selected source span does not exactly equal generated TypeScript"));
    const failed = diagnostics.some((item) => item.generatedFile === entry.generatedFile);
    if (!failed) evidence.push({ schema: declarationTransformEvidenceSchema, ...entry, status: "verified" });
  }
  return {
    status: diagnostics.some((item) => item.code === "source-missing" || item.code === "generated-missing") ? "missing"
      : diagnostics.length > 0 ? "mismatch" : "verified",
    evidence, diagnostics,
  };
}

export async function loadDeclarationTransformManifest(fileName: string): Promise<DeclarationTransformManifest> {
  const absolute = resolve(fileName);
  let text: string;
  try { text = await readFile(absolute, "utf8"); }
  catch (error) { throw new DeclarationTransformManifestError(`${absolute}: ${error instanceof Error ? error.message : String(error)}`); }
  let value: unknown;
  try { value = JSON.parse(text); }
  catch (error) { throw new DeclarationTransformManifestError(`${absolute}: invalid JSON: ${error instanceof Error ? error.message : String(error)}`); }
  return parseDeclarationTransformManifest(value, dirname(absolute));
}
