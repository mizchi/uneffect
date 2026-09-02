/* uneffect:module_effect FsRead | FsWrite | Throw<Error> */
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import ts from "typescript";
import { createContractSummaryBundle } from "./contract-summary.js";
import { verifyContractObligations } from "./contracts.js";
import { builtinContractRegistry } from "./builtin-contracts.js";
import { loadBuiltinRegistryConfig } from "./registry-config.js";
import { loadUneffectModules } from "./modules.js";
import { loadTypeScriptProject } from "./typescript-project.js";
import { CliUsageError, exitCode, formatCommandHelp, parseCommandArgs, type CliCommand } from "./cli-support.js";

function requiredString(values: Record<string, unknown>, key: string): string {
  const value = values[key];
  if (typeof value !== "string" || value.length === 0) throw new CliUsageError(`contract-summary requires --${key.replaceAll("_", "-")}`);
  return value;
}

function parseRuntimeArtifacts(values: Record<string, unknown>): Array<{ packagePath: string; fileName: string }> | undefined {
  const entries = values["runtime-artifact"] as string[] | undefined;
  if (!entries) return undefined;
  return entries.map((entry) => {
    const separator = entry.indexOf("=");
    if (separator <= 0 || separator === entry.length - 1) {
      throw new CliUsageError("--runtime-artifact must be <package-path>=<file>");
    }
    return { packagePath: entry.slice(0, separator), fileName: resolve(entry.slice(separator + 1)) };
  });
}

export const contractSummaryCommand: CliCommand = {
  name: "contract-summary",
  summary: "Publish a package contract summary from one TypeScript project entry.",
  arguments: "--project <tsconfig.json> --entry <file.ts> --package-name <name> --package-version <version> [options]",
  details: [
    "--out <file>  write JSON to a file; otherwise print it to stdout",
    "--typescript-emit-root <dir>  require exact same-compiler .js/.d.ts output under this package root",
    "--runtime-artifact <package-path>=<file>  bind an additional reviewed runtime file; repeatable",
    "--config <registry.json>  load a caller-owned semantic registry",
    "--semantics-module <module.json>  compose a trusted semantics module; repeatable",
  ],
  async run(args, io) {
    const { values, positionals } = parseCommandArgs(args, {
      project: { type: "string" }, entry: { type: "string" },
      "package-name": { type: "string" }, "package-version": { type: "string" },
      out: { type: "string" }, "typescript-emit-root": { type: "string" },
      "runtime-artifact": { type: "string", multiple: true }, config: { type: "string" },
      "semantics-module": { type: "string", multiple: true },
    });
    if (values.help) { io.out(formatCommandHelp(contractSummaryCommand)); return exitCode.success; }
    if (positionals.length > 0) throw new CliUsageError("contract-summary accepts named options only");
    const projectFile = resolve(requiredString(values, "project"));
    const entry = resolve(requiredString(values, "entry"));
    const packageName = requiredString(values, "package-name");
    const packageVersion = requiredString(values, "package-version");
    const project = loadTypeScriptProject(projectFile);
    if (!project.fileNames.map((fileName) => resolve(fileName)).includes(entry)) throw new CliUsageError(`entry is not selected by ${projectFile}: ${entry}`);
    const program = ts.createProgram({
      rootNames: project.fileNames, options: project.compilerOptions, projectReferences: project.projectReferences,
    });
    const source = await readFile(entry, "utf8");
    let registry = builtinContractRegistry;
    try { if (values.config !== undefined) registry = await loadBuiltinRegistryConfig(String(values.config)); }
    catch (cause) { throw new CliUsageError(cause instanceof Error ? cause.message : String(cause)); }
    try { if (values["semantics-module"] !== undefined) registry = (await loadUneffectModules(values["semantics-module"] as string[], registry)).registry; }
    catch (cause) { throw new CliUsageError(cause instanceof Error ? cause.message : String(cause)); }
    const verification = await verifyContractObligations(entry, source, undefined, program);
    const bundle = createContractSummaryBundle({
      packageName, packageVersion, fileName: entry, source, program, artifacts: verification.artifacts,
      builtinRegistry: registry,
      runtimeArtifacts: parseRuntimeArtifacts(values),
      ...(values["typescript-emit-root"] !== undefined
        ? { typescriptEmit: { packageRoot: resolve(String(values["typescript-emit-root"])), projectFile } }
        : {}),
    });
    const json = `${JSON.stringify(bundle, null, 2)}\n`;
    if (values.out !== undefined) await writeFile(resolve(String(values.out)), json, "utf8");
    else io.out(json);
    return exitCode.success;
  },
};
