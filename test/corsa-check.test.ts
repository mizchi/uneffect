import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { checkCorsaProject } from "../src/corsa-check.js";
import { createCorsaCheckJsonReport } from "../src/corsa-check-report.js";
import { runCli } from "../src/cli-runner.js";
import { exitCode, type CliStreams } from "../src/cli-support.js";

const configFile = resolve("test/fixtures/corsa-api-project/tsconfig.json");

function capture(): CliStreams & { stdout: string; stderr: string } {
  const io = {
    stdout: "", stderr: "",
    out(text: string) { io.stdout += text; },
    err(text: string) { io.stderr += text; },
  };
  return io;
}

function capabilityNames(result: Awaited<ReturnType<typeof checkCorsaProject>>): Record<string, string[]> {
  return Object.fromEntries(result.summaries.map((summary) => [
    summary.functionName,
    summary.effects.filter((effect) => effect.kind === "capability").map((effect) => effect.name),
  ]));
}

describe("Corsa-native project check", () => {
  it("does not import a JavaScript TypeScript 6 Program on the shipped check driver", () => {
    const driver = readFileSync("src/check-command.ts", "utf8");
    const corsaCheck = readFileSync("src/corsa-check.ts", "utf8");
    expect(driver).not.toMatch(/from ["']\.\/check\.js["']/);
    expect(driver).not.toMatch(/from ["']typescript["']/);
    expect(driver).not.toMatch(/createCheckProgram|createProgram/);
    expect(corsaCheck).not.toMatch(/from ["']typescript["']/);
    expect(corsaCheck).not.toMatch(/createProgram/);
  });

  function launchCheck(args: string[]) {
    const hook = resolve("test/hooks/install-reject-js-typescript.mjs");
    return spawnSync(process.execPath, [
      "--import", hook,
      "--import", "tsx",
      resolve("src/cli.ts"),
      ...args,
    ], { encoding: "utf8", cwd: process.cwd() });
  }

  function expectAdmittedCatalog(stdout: string) {
    const report = JSON.parse(stdout) as { effects: Array<{ functionName: string; effects: string[] }> };
    const names = Object.fromEntries(report.effects.map((item) => [item.functionName, item.effects]));
    expect(names.loadAliased?.some((effect) => effect.startsWith("Fetch"))).toBe(true);
    expect(names.load?.some((effect) => effect === "Console" || effect.startsWith("Console"))).toBe(true);
    expect(names.makeNode?.some((effect) => effect.startsWith("Dom"))).toBe(true);
    expect(names.connect?.some((effect) => effect.startsWith("Net"))).toBe(true);
    expect(names.shadowed?.some((effect) => /^(?:Fetch|Console)/.test(effect))).toBe(false);
    expect(names.load?.some((effect) => effect.startsWith("FsRead"))).toBe(false);
    return names;
  }

  it("does not load the JavaScript typescript package for uneffect check --project", () => {
    const launched = launchCheck(["check", "--project", configFile, "--infer", "--json"]);
    expect(launched.status, launched.stderr).toBe(0);
    expect(launched.stderr).not.toMatch(/javascript typescript must not load/);
    expectAdmittedCatalog(launched.stdout);
  }, 60_000);

  it("does not load the JavaScript typescript package for file-specified uneffect check", () => {
    const launched = launchCheck([
      "check", resolve("test/fixtures/corsa-api-project/index.ts"), "--infer", "--json",
    ]);
    expect(launched.status, launched.stderr).toBe(0);
    expect(launched.stderr).not.toMatch(/javascript typescript must not load/);
    expectAdmittedCatalog(launched.stdout);
  }, 60_000);

  it("classifies admitted catalog identity without a TypeScript 6 Program", async () => {
    const checked = await checkCorsaProject({ configFile, requireAnnotations: false });
    const names = capabilityNames(checked);
    expect(names.load).toEqual(expect.arrayContaining(["Console", "Fetch"]));
    expect(names.load ?? []).not.toEqual(expect.arrayContaining(["FsRead"]));
    expect(names.loadAliased).toEqual(expect.arrayContaining(["Fetch"]));
    expect(names.shadowed ?? []).not.toEqual(expect.arrayContaining(["Fetch", "Console"]));
    expect(names.makeNode).toEqual(expect.arrayContaining(["Dom"]));
    expect(names.shadowedDocument ?? []).not.toEqual(expect.arrayContaining(["Dom"]));
    expect(names.connect).toEqual(expect.arrayContaining(["Net"]));
    expect(names.shadowedSocket ?? []).not.toEqual(expect.arrayContaining(["Net"]));
    expect(names["Reporter.report"]).toEqual(["Console"]);
    const load = checked.summaries.find((summary) => summary.functionName === "load");
    expect(load?.effects.some((effect) => effect.kind === "capability" && effect.name === "FsRead")).toBe(false);
  }, 60_000);

  it("fails closed when computed syntax would hide an effect-bearing call", async () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-corsa-syntax-"));
    try {
      const sourceFile = join(directory, "index.ts");
      const temporaryConfig = join(directory, "tsconfig.json");
      writeFileSync(sourceFile, `
        export function main(registry: Record<string, () => void>, key: string): void {
          registry[key]()
        }
      `);
      writeFileSync(temporaryConfig, JSON.stringify({
        compilerOptions: { strict: true, target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext" },
        files: ["index.ts"],
      }));
      const checked = await checkCorsaProject({ configFile: temporaryConfig, requireAnnotations: false });
      expect(checked.errors).toBeGreaterThan(0);
      expect(checked.diagnostics).toContainEqual(expect.objectContaining({
        domain: "syntax", severity: "error", functionName: "main",
        message: expect.stringContaining("computed-call-target"),
      }));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 60_000);

  it("exposes the same summaries through the default project-check CLI twice", async () => {
    const args = ["check", "--project", configFile, "--infer", "--json"];
    const first = capture();
    const second = capture();
    expect(await runCli(args, first)).toBe(exitCode.success);
    expect(await runCli(args, second)).toBe(exitCode.success);
    const report = JSON.parse(first.stdout) as { effects: Array<{ functionName: string; effects: string[] }> };
    const again = JSON.parse(second.stdout) as { effects: Array<{ functionName: string; effects: string[] }> };
    expect(again).toEqual(report);
    const names = Object.fromEntries(report.effects.map((item) => [item.functionName, item.effects]));
    expect(names.loadAliased?.some((effect) => effect.startsWith("Fetch"))).toBe(true);
    expect(names.load?.some((effect) => effect === "Console" || effect.startsWith("Console"))).toBe(true);
    expect(names.makeNode?.some((effect) => effect.startsWith("Dom"))).toBe(true);
    expect(names.connect?.some((effect) => effect.startsWith("Net"))).toBe(true);
    expect(names.shadowed?.some((effect) => /^(?:Fetch|Console)/.test(effect))).toBe(false);
    expect(names.shadowedDocument?.some((effect) => effect.startsWith("Dom"))).toBe(false);
    expect(names.shadowedSocket?.some((effect) => effect.startsWith("Net"))).toBe(false);
    expect(names.load?.some((effect) => effect.startsWith("FsRead"))).toBe(false);
    expect(createCorsaCheckJsonReport(await checkCorsaProject({ configFile, requireAnnotations: false })).schema)
      .toBe("uneffect-check/v1");
  }, 60_000);

  it("does not treat unclassified calls as an empty inferred proof", async () => {
    const checked = await checkCorsaProject({ configFile, requireAnnotations: false });
    const load = checked.summaries.find((summary) => summary.functionName === "load");
    const loadAliased = checked.summaries.find((summary) => summary.functionName === "loadAliased");
    expect(load).toMatchObject({ evidence: "unknown" });
    expect(load?.unknownReasons).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "unresolved-call" }),
    ]));
    expect(load?.effects.map((effect) => effect.kind === "capability" ? effect.name : effect.kind))
      .toEqual(expect.arrayContaining(["Console", "Fetch"]));
    expect(load?.effects.some((effect) => effect.kind === "capability" && effect.name === "FsRead")).toBe(false);
    expect(loadAliased).toMatchObject({ evidence: "trusted" });
    expect(loadAliased?.unknownReasons).toBeUndefined();

    const io = capture();
    expect(await runCli(["check", "--project", configFile, "--infer", "--json", "--assurance", "no-unknown"], io))
      .toBe(exitCode.failed);
    const report = JSON.parse(io.stdout) as { outcome: string; effects: Array<{ functionName: string; evidence: string }> };
    expect(report.outcome).toBe("failed");
    expect(report.effects.find((item) => item.functionName === "load")?.evidence).toBe("unknown");
  }, 60_000);
});
