import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import ts from "@typescript/typescript6";
import { describe, expect, it } from "vitest";
import { analyzeCorsaBuiltinCalls } from "../src/frontends/corsa/corsa-builtin-calls.js";
import { openCorsaApiFrontend } from "../src/frontends/corsa/corsa-api-frontend.js";
import { loadTypeScriptProject } from "../src/frontends/typescript/typescript-project.js";
import { assessCheckAssurance } from "../src/evidence/assurance.js";
import { checkFiles } from "../src/project/check.js";
import { createCheckJsonReport } from "../src/cli/check-report.js";
import { runCli } from "../src/cli/cli-runner.js";
import { exitCode, type CliStreams } from "../src/cli/cli-support.js";

describe("Corsa builtin call classification", () => {
  it("classifies authenticated globals and preserves unclassified shadowed calls", async () => {
    const configFile = resolve("test/fixtures/corsa-api-project/tsconfig.json");
    const frontend = await openCorsaApiFrontend({ configFile });
    try {
      const result = analyzeCorsaBuiltinCalls(new Map(frontend.rootFiles.map(file => [file, readFileSync(file, "utf8")])), frontend);
      expect(result.schema).toBe("uneffect-corsa-builtin-calls/v1");
      expect(result.entries.filter(entry => entry.status === "classified").map(({ operation, status }) => [operation, status])).toEqual([
        ["Console", "classified"],
        ["Fetch", "classified"],
        ["Fetch", "classified"],
        ["Console", "classified"],
      ]);
      expect(result.summary.classified).toBe(4);
      expect(result.summary.unclassified).toBeGreaterThan(0);
      expect(result).not.toHaveProperty("typescriptRevision");
    } finally {
      frontend.close();
    }
  });

  it("attaches the classification to the existing project checker", async () => {
    const configFile = resolve("test/fixtures/corsa-api-project/tsconfig.json");
    const project = loadTypeScriptProject(configFile);
    const program = ts.createProgram(project.fileNames, project.compilerOptions);
    const frontend = await openCorsaApiFrontend({ configFile });
    try {
      const checked = await checkFiles(project.fileNames, {
        program, project: project.provenance, requireAnnotations: false, corsaFrontend: frontend,
      });
      expect(checked.corsaBuiltinCalls?.summary.classified).toBe(4);
      const names = Object.fromEntries(checked.summaries.map((summary) => [
        summary.functionName,
        summary.effects.filter((effect) => effect.kind === "capability").map((effect) => effect.name),
      ]));
      expect(names.loadAliased).toEqual(expect.arrayContaining(["Fetch"]));
      expect(names.shadowed ?? []).not.toEqual(expect.arrayContaining(["Fetch", "Console"]));
      expect(names.makeNode).toEqual(expect.arrayContaining(["Dom"]));
      expect(names.shadowedDocument ?? []).not.toEqual(expect.arrayContaining(["Dom"]));
      expect(names.connect).toEqual(expect.arrayContaining(["Net"]));
      expect(names.shadowedSocket ?? []).not.toEqual(expect.arrayContaining(["Net"]));
      const assurance = assessCheckAssurance(checked, "no-unknown");
      expect(assurance.blockers).not.toContainEqual(expect.objectContaining({
        message: expect.stringContaining("Corsa effect parity mismatch"),
      }));
      expect(createCheckJsonReport(checked, assurance).corsaBuiltinCalls).toEqual(checked.corsaBuiltinCalls);
    } finally {
      frontend.close();
    }
  }, 60_000);

  it("exposes classifications through the default Corsa CLI", async () => {
    const io = {
      stdout: "", stderr: "",
      out(text: string) { io.stdout += text; },
      err(text: string) { io.stderr += text; },
    } satisfies CliStreams & { stdout: string; stderr: string };
    const status = await runCli([
      "check", "--project", resolve("test/fixtures/corsa-api-project/tsconfig.json"),
      "--corsa-builtins", "--infer", "--assurance", "no-unknown", "--json",
    ], io);
    expect(status).toBe(exitCode.failed);
    const report = JSON.parse(io.stdout) as { corsaBuiltinCalls?: { summary: { classified: number } }; assurance: { blockers: Array<{ message: string }> } };
    expect(report.corsaBuiltinCalls?.summary.classified).toBe(4);
    expect(report.assurance.blockers.some((blocker) => blocker.message.includes("Corsa effect parity mismatch"))).toBe(false);
  }, 60_000);
});

 it("runs the classification CLI with both JavaScript compiler packages rejected", () => {
   const child = spawnSync(process.execPath, ["--import", resolve("test/hooks/install-reject-js-typescript.mjs"), "--import", "tsx", resolve("src/cli/index.ts"), "check", "--project", resolve("test/fixtures/corsa-api-project/tsconfig.json"), "--corsa-builtins", "--infer", "--json"], { encoding: "utf8", timeout: 60_000 });
   expect(child.error).toBeUndefined();
   expect(child.stderr).toBe("");
   const report = JSON.parse(child.stdout);
   expect(report.corsaBuiltinCalls.summary.classified).toBe(4);
   expect(report).not.toHaveProperty("corsaEffectParity");
 });

describe("builtin classification coverage", () => {
  const fileName = resolve("calls.ts");
  const frontend = {
    rootFiles: [fileName], compilerRevision: "test-revision",
    classifyBuiltinCalls: (_file: string, queries: readonly unknown[]) => queries.map(() => null),
  };

  it("preserves unclassified and excluded calls without inventing agreement", () => {
    const result = analyzeCorsaBuiltinCalls(new Map([["calls.ts", "local(); obj[key]();"]]), frontend);
    expect(result.summary).toEqual({ classified: 0, unclassified: 1, excluded: 1, invalidFiles: 0 });
    expect(result.entries[0]).toMatchObject({ fileName, start: 0, end: 7, status: "unclassified" });
    expect(result.files[0].exclusions[0].reason).toBe("computed-call-target");
    expect(result.summary).not.toHaveProperty("agree");
  });

  it("retains parser errors and does not query partial ASTs", () => {
    const result = analyzeCorsaBuiltinCalls(new Map([[fileName, "function broken( {"]]), {
      ...frontend, classifyBuiltinCalls: () => { throw new Error("must not query invalid syntax"); },
    });
    expect(result.summary.invalidFiles).toBe(1);
    expect(result.files[0].errors.length).toBeGreaterThan(0);
    expect(result.entries).toEqual([]);
  });

  it("rejects source files outside the project and duplicate normalized paths", () => {
    expect(() => analyzeCorsaBuiltinCalls(new Map([["other.ts", "fetch('x')"]]), frontend)).toThrow("does not contain");
    expect(() => analyzeCorsaBuiltinCalls(new Map([["calls.ts", ""], [fileName, ""]]), frontend)).toThrow("Duplicate");
  });

  it("rejects incomplete batches instead of reporting unclassified calls", () => {
    expect(() => analyzeCorsaBuiltinCalls(new Map([[fileName, "fetch('x')"]]), {
      ...frontend, classifyBuiltinCalls: () => [],
    })).toThrow("count differs");
  });

  it("rejects classifications from another compiler revision", () => {
    expect(() => analyzeCorsaBuiltinCalls(new Map([[fileName, "fetch('x')"]]), {
      ...frontend, classifyBuiltinCalls: () => [{ operation: "Fetch", compilerRevision: "stale", symbol: { id: "fetch", name: "fetch" } }],
    })).toThrow("revision differs");
  });
});
