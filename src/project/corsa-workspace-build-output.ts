import { readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { CorsaBuildOutputOptions, CorsaWorkspaceBuildOutputIntegrity, CorsaWorkspaceProjectOutputIntegrity } from "./corsa-build-output-contracts.js";
import { digest, errorMessage, inspectNativeBuildOutputs, nativeConfigArguments, openNativeCompiler, parseNativeConfig } from "./native-build-output.js";

interface Project {
  configFile: string;
  configuration: string;
  configDigest: string;
  references: string[];
  kind: "project" | "solution";
}

/**
 * Verify native JS/declaration bytes in reference order, blocking consumers of
 * unverified producers. Never builds in place. This is not contract composition,
 * source-map integrity, or tsbuildinfo freshness evidence. Keep inputs quiescent.
 */
export function inspectCorsaWorkspaceBuildOutputs(options: CorsaBuildOutputOptions): CorsaWorkspaceBuildOutputIntegrity {
  const compiler = { executable: "", version: "", digest: "" };
  const projects: CorsaWorkspaceProjectOutputIntegrity[] = [];
  const base = { schema: "uneffect-native-workspace-build-outputs/v1" as const, compiler,
    coverage: "project-reference-js-and-declarations" as const, projects };
  try {
    const native = openNativeCompiler(options);
    Object.assign(compiler, native.compiler);
    const run = native.run;
    const discovered = new Map<string, Project>(), visiting = new Set<string>(), order: Project[] = [];
    const visit = (path: string): string => {
      const configFile = statSync(path).isDirectory() ? join(path, "tsconfig.json") : path;
      const identity = realpathSync(configFile);
      if (visiting.has(identity)) throw new Error(`project reference cycle: ${configFile}`);
      const known = discovered.get(identity);
      if (known) {
        if (known.configFile !== configFile) throw new Error(`unsupported project config alias: ${configFile}`);
        return known.configFile;
      }
      visiting.add(identity);
      const configDigest = digest(readFileSync(configFile));
      const configuration = run([...nativeConfigArguments(configFile), "--showConfig"]);
      const config = parseNativeConfig(configuration);
      const project: Project = { configFile, configuration, configDigest, references: [], kind: config.files?.length ? "project" : "solution" };
      discovered.set(identity, project);
      for (const reference of config.references ?? []) {
        const dependency = visit(resolve(dirname(configFile), reference.path));
        if (!project.references.includes(dependency)) project.references.push(dependency);
      }
      if (project.kind === "solution" && !project.references.length) throw new Error(`empty solution has no source files or references: ${configFile}`);
      visiting.delete(identity);
      order.push(project);
      return configFile;
    };
    visit(resolve(options.cwd ?? process.cwd(), options.configFile));
    if (!order.some(project => project.kind === "project")) throw new Error("empty workspace has no emitting projects");
    const validations: (() => void)[] = [];
    const results = new Map<string, CorsaWorkspaceProjectOutputIntegrity>();
    const outputs = new Set<string>();
    for (const project of order) {
      const { configFile, references, kind } = project;
      const blockedBy = references.filter(reference => results.get(reference)?.status !== "verified");
      let result: CorsaWorkspaceProjectOutputIntegrity;
      if (blockedBy.length) {
        result = { configFile, references, kind, status: "not-checked", outputs: [], blockedBy, message: "referenced project outputs are not verified" };
      } else if (kind === "solution") {
        result = { configFile, references, kind, status: "verified", outputs: [] };
      } else {
        const inspection = inspectNativeBuildOutputs({ ...options, configFile }, {
          configuration: project.configuration, references,
          recordValidation: validate => validations.push(validate),
        });
        if (inspection.compiler.digest !== compiler.digest) throw new Error("compiler changed during workspace inspection");
        const { compiler: _compiler, ...integrity } = inspection;
        result = { ...integrity, configFile, references, kind };
        for (const output of result.outputs) {
          const identity = output.status === "missing" ? output.fileName : realpathSync(output.fileName);
          if (outputs.has(identity)) throw new Error(`overlapping project output: ${output.fileName}`);
          outputs.add(identity);
        }
      }
      results.set(configFile, result);
      projects.push(result);
    }
    // Revalidate producers after every consumer has finished. A producer that
    // changed between phases must invalidate the whole workspace observation.
    for (const validate of validations) validate();
    for (const project of order) {
      if (digest(readFileSync(project.configFile)) !== project.configDigest || run([...nativeConfigArguments(project.configFile), "--showConfig"]) !== project.configuration) {
        throw new Error(`project configuration changed during workspace inspection: ${project.configFile}`);
      }
    }
    if (digest(readFileSync(compiler.executable)) !== compiler.digest) throw new Error("compiler changed during workspace inspection");
    const status = projects.some(project => project.status === "error") ? "error"
      : projects.some(project => project.status === "mismatch") ? "mismatch"
      : projects.some(project => project.status === "missing") ? "missing" : "verified";
    return { ...base, status, outputs: projects.flatMap(project => project.outputs) };
  } catch (error) {
    // Do not leave earlier projects labelled verified after their observation
    // has been invalidated by a graph/compiler/input/output change.
    return { ...base, projects: projects.map(project => ({ ...project, status: "not-checked", outputs: [], message: "workspace inspection invalidated" })),
      status: "error", outputs: [], message: errorMessage(error) };
  }
}
