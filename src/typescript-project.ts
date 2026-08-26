import { dirname, resolve } from "node:path";
import ts from "typescript";

export interface TypeScriptProject {
  projectFile: string;
  fileNames: string[];
  compilerOptions: ts.CompilerOptions;
}

function diagnosticMessage(diagnostic: ts.Diagnostic): string {
  return ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
}

/** Load the consumer's TypeScript file set and compiler semantics without mutating them. */
export function loadTypeScriptProject(projectFile: string): TypeScriptProject {
  const absolute = resolve(projectFile);
  const loaded = ts.readConfigFile(absolute, ts.sys.readFile);
  if (loaded.error) throw new Error(`cannot read TypeScript project ${absolute}: ${diagnosticMessage(loaded.error)}`);
  const parsed = ts.parseJsonConfigFileContent(loaded.config, ts.sys, dirname(absolute), undefined, absolute);
  const errors = parsed.errors.filter((diagnostic) => diagnostic.code !== 18003);
  if (errors.length > 0) {
    throw new Error(`cannot read TypeScript project ${absolute}: ${errors.map(diagnosticMessage).join("; ")}`);
  }
  if (parsed.fileNames.length === 0) throw new Error(`TypeScript project ${absolute} does not select any source files`);
  return { projectFile: absolute, fileNames: parsed.fileNames, compilerOptions: parsed.options };
}
