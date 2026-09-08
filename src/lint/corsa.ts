import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { openCorsaApiFrontend, resolveCorsaExecutable, type CorsaApiFrontend } from "../frontends/corsa/corsa-api-frontend.js";
import type { RegistryReadRuleOptions, SourceRuleLowering, SourceRuleOptions } from "./contracts.js";
import { name, record } from "./input.js";
import { normalizeSourceOptions } from "./source-options.js";

export interface CorsaRuleOptions extends SourceRuleOptions {
  /** Use this project's compiler options and file membership. Otherwise check the file in an isolated ES2024/NodeNext project. */
  readonly configFile?: string;
  /** Defaults to Uneffect's packaged native compiler. Never falls back to the JavaScript compiler. */
  readonly corsaExecutable?: string;
}

const execute = promisify(execFile);

export interface CorsaRegistryReadOptions extends RegistryReadRuleOptions {
  readonly configFile?: string;
  readonly corsaExecutable?: string;
}

function failure(error: unknown): SourceRuleLowering {
  return { status: "unknown", reason: error instanceof TypeError ? "invalid-input" : "frontend-error", detail: error instanceof Error ? error.message : String(error) };
}

/** Oxc syntax + Corsa symbols, with native compiler diagnostics checked before extraction. */
export async function lowerCorsaRuleCfg(options: CorsaRuleOptions): Promise<SourceRuleLowering> {
  try {
    const input = record(options, "options", ["fileName", "functionName", "bindings", "configFile", "corsaExecutable"]);
    const normalized = normalizeSourceOptions({ fileName: input.fileName as string, functionName: input.functionName as string, bindings: input.bindings as SourceRuleOptions["bindings"] });
    return await checkedSource({ ...options, fileName: normalized.fileName }, async (source, frontend, fileName) => {
      const { lowerOxcRuleCfg } = await import("./oxc.js");
      return lowerOxcRuleCfg(source, frontend, { ...normalized, fileName });
    });
  } catch (error) { return failure(error); }
}

/** Own-entry reads under explicit runtime assumptions and a selected control-flow scope. */
export async function lowerCorsaRegistryReadCfg(options: CorsaRegistryReadOptions): Promise<SourceRuleLowering> {
  try {
    const input = record(options, "options", ["fileName", "functionName", "registry", "flow", "configFile", "corsaExecutable"]);
    const fileName = name(input.fileName, "fileName"), functionName = name(input.functionName, "functionName"), registry = name(input.registry, "registry");
    if (!/^[$A-Za-z_][$\w]*(?:\.[$A-Za-z_][$\w]*)*$/u.test(registry)) throw new TypeError("registry must be a binding name with optional static properties");
    if (input.flow !== undefined && input.flow !== "expression" && input.flow !== "statement") throw new TypeError("flow must be expression or statement");
    const flow = input.flow;
    return await checkedSource({ ...options, fileName }, async (source, frontend, absolute) => {
      const { lowerRegistryReadCfg } = await import("./registry-reads.js");
      return lowerRegistryReadCfg(source, frontend, { fileName: absolute, functionName, registry, flow });
    });
  } catch (error) { return failure(error); }
}

async function checkedSource(
  options: { fileName: string; configFile?: string; corsaExecutable?: string },
  lower: (source: string, frontend: CorsaApiFrontend, fileName: string) => Promise<SourceRuleLowering>,
): Promise<SourceRuleLowering> {
  let directory: string | undefined;
  let frontend: CorsaApiFrontend | undefined;
  try {
    const fileName = resolve(options.fileName);
    const configFile = options.configFile === undefined ? undefined : resolve(name(options.configFile, "configFile"));
    const corsaExecutable = options.corsaExecutable === undefined ? undefined : name(options.corsaExecutable, "corsaExecutable");
    if (/\.d\.[cm]?ts$/u.test(fileName)) throw new TypeError("fileName must identify an implementation source");
    const source = await readFile(fileName, "utf8");
    const executable = resolveCorsaExecutable({ corsaExecutable });
    let project = configFile;
    if (!project) {
      directory = await mkdtemp(join(tmpdir(), "uneffect-cfg-lint-"));
      project = join(directory, "tsconfig.json");
      await writeFile(project, JSON.stringify({ compilerOptions: {
        target: "ES2024", module: "NodeNext", moduleResolution: "NodeNext", types: [], noEmit: true,
      }, files: [fileName] }));
    }
    // The current Corsa binding has no named diagnostics query. Use the same native
    // executable for diagnostics; do not silently certify ill-typed source.
    try {
      await execute(executable, ["--noEmit", "--pretty", "false", "-p", project], { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && (error.code === 1 || error.code === 2)
        && "stdout" in error && typeof error.stdout === "string" && /error TS\d+:/u.test(error.stdout)) {
        return { status: "unknown", reason: "typescript-error", detail: error.stdout.trim() };
      }
      throw error;
    }
    frontend = await openCorsaApiFrontend({ configFile: project, corsaExecutable: executable });
    if (!frontend.rootFiles.some(file => resolve(file) === fileName)) throw new TypeError("fileName is not a root file of the Corsa project");
    const result = await lower(source, frontend, fileName);
    if (await readFile(fileName, "utf8") !== source) return { status: "unknown", reason: "unsupported-source", detail: "source changed during analysis; retry with a stable project" };
    return result;
  } catch (error) {
    return failure(error);
  } finally {
    try { frontend?.close(); } finally { if (directory) await rm(directory, { recursive: true, force: true }); }
  }
}
