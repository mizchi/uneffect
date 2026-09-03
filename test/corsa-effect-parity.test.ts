import { resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { analyzeCorsaEffectParity } from "../src/corsa-effect-parity.js";
import { openCorsaApiFrontend } from "../src/corsa-api-frontend.js";
import { loadTypeScriptProject } from "../src/typescript-project.js";
import { assessCheckAssurance } from "../src/assurance.js";
import { checkFiles } from "../src/check.js";
import { createCheckJsonReport } from "../src/check-report.js";
import { runCli } from "../src/cli-runner.js";
import { exitCode, type CliStreams } from "../src/cli-support.js";

describe("Corsa effect parity sidecar", () => {
  it("agrees for authenticated globals including a const fetch alias", async () => {
    const configFile = resolve("test/fixtures/corsa-api-project/tsconfig.json");
    const project = loadTypeScriptProject(configFile);
    const program = ts.createProgram(project.fileNames, project.compilerOptions);
    const frontend = await openCorsaApiFrontend({ configFile });
    try {
      const result = analyzeCorsaEffectParity(program, frontend);
      expect(result.schema).toBe("uneffect-corsa-effect-parity/v1");
      expect(result.entries.map(({ operation, status }) => [operation, status])).toEqual([
        ["Console", "agree"],
        ["Fetch", "agree"],
        ["Fetch", "agree"],
      ]);
      expect(result.summary).toEqual({ agree: 3, mismatch: 0 });
    } finally {
      frontend.close();
    }
  });

  it("attaches parity to a real project check without a Fetch alias mismatch", async () => {
    const configFile = resolve("test/fixtures/corsa-api-project/tsconfig.json");
    const project = loadTypeScriptProject(configFile);
    const program = ts.createProgram(project.fileNames, project.compilerOptions);
    const frontend = await openCorsaApiFrontend({ configFile });
    try {
      const checked = await checkFiles(project.fileNames, {
        program, project: project.provenance, requireAnnotations: false, corsaFrontend: frontend,
      });
      expect(checked.corsaEffectParity?.summary).toEqual({ agree: 3, mismatch: 0 });
      const names = Object.fromEntries(checked.summaries.map((summary) => [
        summary.functionName,
        summary.effects.filter((effect) => effect.kind === "capability").map((effect) => effect.name),
      ]));
      expect(names.loadAliased).toEqual(expect.arrayContaining(["Fetch"]));
      expect(names.shadowed ?? []).not.toEqual(expect.arrayContaining(["Fetch", "Console"]));
      const assurance = assessCheckAssurance(checked, "no-unknown");
      expect(assurance.blockers).not.toContainEqual(expect.objectContaining({
        message: expect.stringContaining("Corsa effect parity mismatch"),
      }));
      expect(createCheckJsonReport(checked, assurance).corsaEffectParity).toEqual(checked.corsaEffectParity);
    } finally {
      frontend.close();
    }
  }, 60_000);

  it("exposes the sidecar through the project-check CLI and JSON report", async () => {
    const io = {
      stdout: "", stderr: "",
      out(text: string) { io.stdout += text; },
      err(text: string) { io.stderr += text; },
    } satisfies CliStreams & { stdout: string; stderr: string };
    const status = await runCli([
      "check", "--project", resolve("test/fixtures/corsa-api-project/tsconfig.json"),
      "--corsa-parity", "--infer", "--assurance", "no-unknown", "--json",
    ], io);
    expect(status).toBe(exitCode.failed);
    const report = JSON.parse(io.stdout) as { corsaEffectParity?: { summary: { agree: number; mismatch: number } }; assurance: { blockers: Array<{ message: string }> } };
    expect(report.corsaEffectParity?.summary).toEqual({ agree: 3, mismatch: 0 });
    expect(report.assurance.blockers.some((blocker) => blocker.message.includes("Corsa effect parity mismatch"))).toBe(false);
  }, 60_000);
});
