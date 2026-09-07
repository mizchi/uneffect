import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { resolveCorsaExecutable } from "../frontends/corsa/corsa-api-frontend.js";
import type { BuildOutputFileIntegrity, BuildOutputIntegrity } from "./build-output-contracts.js";
import type { CorsaBuildOutputOptions, CorsaNativeCompilerIdentity } from "./corsa-build-output-contracts.js";

export interface NativeProjectBuildOutputIntegrity extends BuildOutputIntegrity {
  readonly compiler: CorsaNativeCompilerIdentity;
  readonly inputDigest?: string;
}
export interface NativeConfig {
  compilerOptions: Record<string, unknown>;
  files?: string[];
  references?: { path: string }[];
}
export interface NativeWorkspaceInspection {
  readonly configuration: string;
  readonly references: readonly string[];
  recordValidation(validate: () => void): void;
}
export const digest = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
function below(root: string, file: string): string | undefined {
  const path = relative(root, file);
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path) ? path : undefined;
}
export function errorMessage(error: unknown): string {
  const failure = error as { stdout?: string | Buffer; stderr?: string | Buffer; message?: string };
  return [failure.stdout, failure.stderr, failure.message ?? String(error)].filter(Boolean).map(String).join("\n");
}

export function openNativeCompiler(options: CorsaBuildOutputOptions) {
  const executable = resolveCorsaExecutable(options);
  const compiler = { executable, version: "", digest: digest(readFileSync(executable)) };
  const run = (args: string[]): string => execFileSync(executable, args, {
    cwd: dirname(resolve(options.cwd ?? process.cwd(), options.configFile)),
    encoding: "utf8", timeout: 30_000, maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
  });
  const version = /^Version (\S+)\s*$/u.exec(run(["--version"]));
  if (!version) throw new Error("invalid native compiler version response");
  compiler.version = version[1]!;
  if (compiler.version !== "7.0.2") throw new Error(`unsupported native emission version ${compiler.version}; the gate is validated for 7.0.2`);
  return { compiler, run };
}
export function nativeConfigArguments(configFile: string): string[] {
  return ["--project", configFile, "--pretty", "false", "--locale", "en"];
}
export function parseNativeConfig(configuration: string): NativeConfig {
  const config = JSON.parse(configuration) as NativeConfig;
  if (!config.compilerOptions || typeof config.compilerOptions !== "object") throw new Error("invalid native project configuration");
  if (config.references !== undefined && (!Array.isArray(config.references) || config.references.some(reference => !reference || typeof reference.path !== "string" || !reference.path))) {
    throw new Error("invalid native project references");
  }
  return config;
}

/** Internal re-emission engine. Reference admission belongs to the workspace coordinator. */
export function inspectNativeBuildOutputs(options: CorsaBuildOutputOptions, workspace?: NativeWorkspaceInspection): NativeProjectBuildOutputIntegrity {
  const configFile = resolve(options.cwd ?? process.cwd(), options.configFile), directory = dirname(configFile);
  const compiler = { executable: "", version: "", digest: "" };
  const base = { compiler };
  let staging: string | undefined;
  try {
    const native = openNativeCompiler(options), run = native.run;
    Object.assign(compiler, native.compiler);
    const configArguments = nativeConfigArguments(configFile);
    const configuration = run([...configArguments, "--showConfig"]), config = parseNativeConfig(configuration);
    if (workspace && configuration !== workspace.configuration) throw new Error("project configuration changed after workspace discovery");
    const settings = config.compilerOptions;
    if (config.references?.length && !workspace) throw new Error("unsupported project references: verify producers separately; workspace composition is not established");
    for (const option of ["noCheck", "noEmit", "emitDeclarationOnly", "inlineSourceMap", "outFile", "mapRoot"]) {
      if (settings[option]) throw new Error(`unsupported ${option} for native output comparison`);
    }
    if (typeof settings.outDir !== "string" || !settings.outDir) throw new Error("native output comparison requires an explicit outDir");
    if (!config.files?.length) throw new Error("native output comparison requires source files");
    const outputRoot = resolve(directory, settings.outDir);
    const declarationRoot = typeof settings.declarationDir === "string" ? resolve(directory, settings.declarationDir) : undefined;
    const selectedInputs = (args: string[]): string[] => [...new Set(run([...args, "--listFilesOnly"]).trim().split(/\r?\n/u).filter(Boolean).map(file => resolve(directory, file)))].sort();
    const originalInputs = selectedInputs(configArguments);
    const inputState = (): string => {
      const effectiveConfig = run([...configArguments, "--showConfig"]);
      const files = selectedInputs(configArguments);
      const inputs = [...new Set(files)].sort().map(file => [file, digest(readFileSync(file))]);
      // NodeNext format and package exports depend on package.json, even when
      // all selected source paths remain identical. Track missing ancestors too.
      const packageFiles = new Set<string>();
      for (const file of [configFile, ...files]) {
        for (let parent = dirname(file);;) {
          packageFiles.add(join(parent, "package.json"));
          const next = dirname(parent);
          if (next === parent) break;
          parent = next;
        }
      }
      const packages = [...packageFiles].sort().map(file => {
        try { return [file, digest(readFileSync(file))]; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; return [file, null]; }
      });
      return digest(JSON.stringify({ effectiveConfig, config: digest(readFileSync(configFile)), inputs, packages }));
    };
    const inputDigest = inputState();
    // Detect config changes since inspection before permitting any output paths.
    if (run([...configArguments, "--showConfig"]) !== configuration) throw new Error("project configuration changed during native output inspection");
    staging = mkdtempSync(join(tmpdir(), "uneffect-native-emit-"));
    const stagedRuntime = join(staging, "runtime"), stagedDeclarations = join(staging, "declarations");
    const stagedSettings: Record<string, unknown> = { outDir: stagedRuntime };
    if (declarationRoot) stagedSettings.declarationDir = stagedDeclarations;
    if (settings.incremental || settings.composite || settings.tsBuildInfoFile) stagedSettings.tsBuildInfoFile = join(staging, "state.tsbuildinfo");
    // Native 7.0.2 defaults rootDir to the original config directory.
    if (!settings.rootDir) stagedSettings.rootDir = directory;
    if (!settings.typeRoots) {
      const typeRoots: string[] = [];
      for (let parent = directory;;) {
        typeRoots.push(join(parent, "node_modules", "@types"));
        const next = dirname(parent);
        if (next === parent) break;
        parent = next;
      }
      stagedSettings.typeRoots = typeRoots;
    }
    // Keep the original roots explicit: changing outDir changes its implicit
    // exclusion, otherwise old declarations in dist can contaminate re-emission.
    const stagedConfig = join(staging, "tsconfig.json");
    writeFileSync(stagedConfig, JSON.stringify({ extends: configFile, files: config.files.map(file => resolve(directory, file)), include: [], exclude: [], ...(workspace ? { references: workspace.references.map(path => ({ path })) } : {}), compilerOptions: stagedSettings }));
    const args = ["--project", stagedConfig, "--pretty", "false", "--locale", "en", "--listEmittedFiles", "--noEmitOnError", "true"];
    if (JSON.stringify(selectedInputs(args)) !== JSON.stringify(originalInputs)) throw new Error("unsupported output redirection changes compiler input membership");
    const emitted = run(args).split(/\r?\n/u).filter(line => line.startsWith("TSFILE: ")).map(line => resolve(directory, line.slice(8)));
    const expected: Array<{ fileName: string; kind: BuildOutputFileIntegrity["kind"]; data: Buffer }> = [];
    for (const file of emitted) {
      if (!below(staging, file)) throw new Error("native compiler reported output outside the isolated directory");
      const kind = /\.d\.[cm]?ts$/u.test(file) ? "declaration" : /\.[cm]?js$/u.test(file) ? "runtime" : undefined;
      if (!kind) continue;
      const relativeName = declarationRoot && kind === "declaration" ? below(stagedDeclarations, file) : below(stagedRuntime, file);
      if (!relativeName) throw new Error("native output does not match its configured output directory");
      expected.push({ fileName: resolve(declarationRoot && kind === "declaration" ? declarationRoot : outputRoot, relativeName), kind, data: readFileSync(file) });
    }
    if (!expected.some(output => output.kind === "runtime")) throw new Error("native project did not emit runtime JavaScript");
    if (inputState() !== inputDigest || digest(readFileSync(compiler.executable)) !== compiler.digest) throw new Error("compiler or project inputs changed during native output inspection");
    const outputs = expected.map<BuildOutputFileIntegrity>(({ fileName, kind, data }) => {
      const expectedDigest = digest(data);
      let actual: Buffer;
      try { actual = readFileSync(fileName); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        return { fileName, projectFile: configFile, kind, expectedDigest, status: "missing", message: `${kind} output is missing` };
      }
      const actualDigest = digest(actual);
      return { fileName, projectFile: configFile, kind, expectedDigest, actualDigest,
        status: expectedDigest === actualDigest ? "verified" : "mismatch",
        ...(expectedDigest === actualDigest ? {} : { message: `${kind} output content mismatch` }) };
    }).sort((left, right) => left.fileName.localeCompare(right.fileName));
    const status = outputs.some(output => output.status === "mismatch") ? "mismatch" : outputs.some(output => output.status === "missing") ? "missing" : "verified";
    if (status === "verified") workspace?.recordValidation(() => {
      if (inputState() !== inputDigest || digest(readFileSync(compiler.executable)) !== compiler.digest) throw new Error(`compiler or project inputs changed during workspace inspection: ${configFile}`);
      for (const output of outputs) {
        if (digest(readFileSync(output.fileName)) !== output.actualDigest) throw new Error(`project output changed during workspace inspection: ${output.fileName}`);
      }
    });
    return { ...base, status, inputDigest, outputs };
  } catch (error) { return { ...base, status: "error", outputs: [], message: errorMessage(error) }; }
  finally { if (staging) rmSync(staging, { recursive: true, force: true }); }
}
