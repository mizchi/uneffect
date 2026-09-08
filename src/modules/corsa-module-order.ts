import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { openCorsaApiFrontend, resolveCorsaExecutable, type CorsaApiFrontend } from "../frontends/corsa/corsa-api-frontend.js";
import { parseOxcSource } from "../frontends/oxc/source.js";
import { buildModuleInitializationOrder } from "./module-order-core.js";
import { applyModuleOrderControlFlow } from "./module-order-control-flow.js";
import { inspectOxcModule, type OxcModuleFacts } from "./oxc-module-facts.js";
import { moduleControlFlowLimit } from "./options.js";
import type { ModuleInitializationOrder, ModuleInitializationOrderV2, ModuleInitializationUnknown, ModuleInitializationV2Options } from "./contracts.js";

export interface CorsaModuleOrderOptions {
  readonly entryFile: string;
  /** Uses the project options and Corsa's resolved module identities. Defaults to an isolated ES2024/NodeNext project. */
  readonly configFile?: string;
  /** Defaults to the packaged native compiler; no JavaScript compiler fallback. */
  readonly corsaExecutable?: string;
}
export interface CorsaModuleOrderV2Options extends CorsaModuleOrderOptions, ModuleInitializationV2Options {}
export type { ModuleInitializationOrder, ModuleInitializationOrderV2 } from "./contracts.js";

const execute = promisify(execFile);
function validate(options: CorsaModuleOrderOptions, v2: boolean): void {
  if (!options || typeof options !== "object" || Array.isArray(options)) throw new TypeError("options must be an object");
  const keys = ["entryFile", "configFile", "corsaExecutable", ...(v2 ? ["proofBudget"] : [])];
  for (const key of Object.keys(options)) if (!keys.includes(key)) throw new TypeError(`options: unknown field ${key}`);
  for (const key of ["entryFile", "configFile", "corsaExecutable"] as const) {
    const value = options[key];
    if ((key === "entryFile" || value !== undefined) && (typeof value !== "string" || !value.trim())) throw new TypeError(`${key} must be a nonempty string`);
  }
}

async function analyze(options: CorsaModuleOrderOptions, limit?: number): Promise<ModuleInitializationOrder | ModuleInitializationOrderV2> {
  let directory: string | undefined, frontend: CorsaApiFrontend | undefined;
  const entryFile = resolve(options.entryFile);
  try {
    await readFile(entryFile, "utf8");
    let configFile = options.configFile && resolve(options.configFile);
    if (!configFile) {
      directory = await mkdtemp(join(tmpdir(), "uneffect-module-order-"));
      configFile = join(directory, "tsconfig.json");
      await writeFile(configFile, JSON.stringify({ compilerOptions: { target: "ES2024", module: "NodeNext", moduleResolution: "NodeNext", types: [], noEmit: true }, files: [entryFile] }));
    }
    const executable = resolveCorsaExecutable(options);
    const run = async (args: string[]): Promise<string> => (await execute(executable, args, { timeout: 30_000, maxBuffer: 16 * 1024 * 1024 })).stdout;
    const diagnosticOptions = ["--noEmit", "--noCheck", "false", "--listFilesOnly", "false"];
    const check = async (): Promise<string> => {
      try { return await run([...diagnosticOptions, "--pretty", "false", "--listFiles", "-p", configFile]); }
      catch (error) {
        if (error && typeof error === "object" && "code" in error && (error.code === 1 || error.code === 2)
          && "stdout" in error && typeof error.stdout === "string" && /error TS\d+:/u.test(error.stdout)) return error.stdout;
        throw error;
      }
    };
    const inventory = await check();
    const files = inventory.split(/\r?\n/u).filter(line => isAbsolute(line) && !/error TS\d+:/u.test(line));
    if (!files.includes(entryFile)) throw new TypeError("entryFile is not part of the Corsa project");
    const texts = new Map(await Promise.all(files.map(async file => [file, await readFile(file, "utf8")] as const)));
    const configText = await readFile(configFile, "utf8");
    frontend = await openCorsaApiFrontend({ configFile, corsaExecutable: executable });
    const output = await check();
    const diagnostics: ModuleInitializationUnknown[] = [];
    const projectDiagnostics: ModuleInitializationUnknown[] = [];
    // Native diagnostics report a point, not a range. Do not invent a token length.
    for (const line of output.split(/\r?\n/u)) {
      const match = /^(?:(.+)\((\d+),(\d+)\): )?error TS\d+: (.*)$/u.exec(line);
      if (!match) continue;
      const fileName = match[1] ? resolve(match[1]) : entryFile;
      let span: { start: number; end: number } | undefined;
      if (match[1]) {
        const text = texts.get(fileName) ?? await readFile(fileName, "utf8").catch(() => undefined);
        if (text !== undefined) {
          const lines = text.match(/[^\r\n\u2028\u2029]*(?:\r\n|[\r\n\u2028\u2029]|$)/gu) ?? [];
          const start = lines.slice(0, Number(match[2]) - 1).reduce((sum, value) => sum + value.length, 0) + Number(match[3]) - 1;
          span = { start, end: start };
        }
      }
      const target = match[1] && texts.has(fileName) ? diagnostics : projectDiagnostics;
      target.push({ fileName, kind: "typescript-error", ...(span ? { span } : {}), detail: match[4]! });
    }
    const version = (await run(["--version"])).trim().replace(/^Version\s+/u, "");
    const config = JSON.parse(await run([...diagnosticOptions, "--showConfig", "-p", configFile])) as { compilerOptions: Record<string, unknown> };
    const compilerOptionsDigest = createHash("sha256").update(JSON.stringify(Object.fromEntries(Object.entries(config.compilerOptions).sort(([a], [b]) => a.localeCompare(b))))).digest("hex");
    const records = new Map<string, OxcModuleFacts>();
    const native = frontend;
    const baseline = buildModuleInitializationOrder({ compiler: { typescriptVersion: version, compilerOptionsDigest }, diagnostics, projectDiagnostics,
      getModule(fileName) {
        if (/\.d\.[cm]?ts$/u.test(fileName) || !texts.has(fileName)) return undefined;
        let record = records.get(fileName);
        if (!record) {
          const source = parseOxcSource(fileName, texts.get(fileName)!);
          record = inspectOxcModule(source, native, position => {
            const symbol = native.getSymbolAtPosition(fileName, position);
            // Corsa node handles are opaque. Match their file suffix against the
            // compiler's own inventory, including canonical casing on macOS.
            const declarations = symbol?.declarations ?? [];
            const exact = files.filter(file => declarations.some(declaration => declaration.endsWith(file)));
            const matches = exact.length ? exact : files.filter(file => declarations.some(declaration => declaration.toLowerCase().endsWith(file.toLowerCase())));
            return matches.length === 1 && !/\.d\.[cm]?ts$/u.test(matches[0]!) ? matches[0] : undefined;
          });
          records.set(fileName, record);
        }
        return record.facts;
      },
    }, entryFile);
    const candidate = limit === undefined ? undefined : [...records.values()].map(record => record.conditionalCandidate(baseline)).find(value => value !== undefined);
    for (const [file, text] of texts) if (await readFile(file, "utf8") !== text) throw new Error("source changed during analysis; retry with a stable project");
    if (await readFile(configFile, "utf8") !== configText) throw new Error("configuration changed during analysis; retry with a stable project");
    return limit === undefined ? baseline : applyModuleOrderControlFlow(baseline, candidate, limit);
  } finally {
    try { frontend?.close(); } finally { if (directory) await rm(directory, { recursive: true, force: true }); }
  }
}

/** Asynchronous native/Oxc v1 extraction. Frontend failures reject rather than certify an ordering. */
export async function analyzeCorsaModuleInitializationOrder(options: CorsaModuleOrderOptions): Promise<ModuleInitializationOrder> {
  validate(options, false);
  return await analyze(options) as ModuleInitializationOrder;
}
/** Native/Oxc extraction with the same bounded conditional-await proof as the Program API. */
export async function analyzeCorsaModuleInitializationOrderV2(options: CorsaModuleOrderV2Options): Promise<ModuleInitializationOrderV2> {
  validate(options, true);
  const limit = moduleControlFlowLimit({ proofBudget: options.proofBudget });
  return await analyze(options, limit) as ModuleInitializationOrderV2;
}
