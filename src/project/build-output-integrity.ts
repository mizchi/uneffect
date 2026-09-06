import { createHash } from "node:crypto";
import { resolve } from "node:path";
import ts from "@typescript/typescript6";

export interface BuildOutputFileIntegrity {
  kind: "declaration" | "runtime";
  status: "verified" | "missing" | "mismatch";
  fileName: string;
  projectFile?: string;
  expectedDigest: string;
  actualDigest?: string;
  message?: string;
}

export interface BuildOutputIntegrity {
  status: "not-checked" | "verified" | "missing" | "mismatch" | "error";
  outputs: BuildOutputFileIntegrity[];
  message?: string;
}

const statusRank: Record<BuildOutputIntegrity["status"], number> = {
  "not-checked": 0, verified: 1, missing: 2, mismatch: 3, error: 4,
};

export function mergeBuildOutputIntegrity(target: BuildOutputIntegrity, next: BuildOutputIntegrity): void {
  target.outputs.push(...next.outputs);
  if (statusRank[next.status] > statusRank[target.status]) target.status = next.status;
  if (next.message && !target.message) target.message = next.message;
}

function digest(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function outputKind(fileName: string): BuildOutputFileIntegrity["kind"] | undefined {
  if (/\.d\.[cm]?ts$/u.test(fileName)) return "declaration";
  if (/\.[cm]?js$/u.test(fileName)) return "runtime";
  return undefined;
}

/** Compares TypeScript's exact in-memory emit with the outputs present on disk. */
export function inspectBuildOutputs(program: ts.Program, projectFile?: string): BuildOutputIntegrity {
  const expected: Array<{ fileName: string; text: string; kind: BuildOutputFileIntegrity["kind"] }> = [];
  const result = program.emit(undefined, (fileName, text) => {
    const kind = outputKind(fileName);
    if (kind) expected.push({ fileName: resolve(fileName), text, kind });
  });
  if (result.emitSkipped) return { status: "error", outputs: [], message: "TypeScript build output re-emission was skipped" };
  const hasRuntimeSource = program.getSourceFiles().some((source) => !source.isDeclarationFile);
  if (hasRuntimeSource && !expected.some((output) => output.kind === "runtime")) return {
    status: "error", outputs: [], message: "TypeScript project does not emit runtime JavaScript",
  };
  const outputs = expected.map<BuildOutputFileIntegrity>(({ fileName, text, kind }) => {
    const actual = ts.sys.readFile(fileName), expectedDigest = digest(text), actualDigest = actual === undefined ? undefined : digest(actual);
    return actual === undefined
      ? { kind, status: "missing", fileName, expectedDigest, ...(projectFile ? { projectFile } : {}), message: `${kind} output is missing` }
      : actualDigest !== expectedDigest
        ? { kind, status: "mismatch", fileName, expectedDigest, actualDigest, ...(projectFile ? { projectFile } : {}), message: `${kind} output content mismatch` }
        : { kind, status: "verified", fileName, expectedDigest, actualDigest, ...(projectFile ? { projectFile } : {}) };
  });
  const status = outputs.some((output) => output.status === "mismatch") ? "mismatch"
    : outputs.some((output) => output.status === "missing") ? "missing" : "verified";
  return { status, outputs };
}
