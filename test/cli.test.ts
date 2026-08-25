import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cliCommands, cliVersion, formatCliHelp, runCli } from "../src/cli-runner.js";
import { exitCode, type CliStreams } from "../src/cli-support.js";

function capture(): CliStreams & { stdout: string; stderr: string } {
  const io = {
    stdout: "", stderr: "",
    out(text: string) { io.stdout += text; },
    err(text: string) { io.stderr += text; },
  };
  return io;
}

describe("uneffect command line", () => {
  it("publishes exactly one binary that points at the built entry", () => {
    const manifest = JSON.parse(readFileSync("package.json", "utf8")) as { bin: Record<string, string> };
    expect(manifest.bin).toEqual({ uneffect: "dist/src/cli.js" });
  });

  it("reports the installed package version", async () => {
    const manifest = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };
    expect(await cliVersion()).toBe(manifest.version);
    const io = capture();
    expect(await runCli(["--version"], io)).toBe(exitCode.success);
    expect(io.stdout.trim()).toBe(manifest.version);
  });

  it("lists every command in the help, and documents each one", async () => {
    const io = capture();
    expect(await runCli(["--help"], io)).toBe(exitCode.success);
    for (const command of cliCommands) expect(io.stdout).toContain(command.name);
    expect(cliCommands.filter((command) => command.summary.length === 0 || command.arguments.length === 0)).toEqual([]);
    for (const command of cliCommands) {
      const help = capture();
      expect(await runCli([command.name, "--help"], help)).toBe(exitCode.success);
      expect(help.stdout).toContain(`usage: uneffect ${command.name}`);
    }
  });

  it("asks for a command instead of guessing when the argument is neither", async () => {
    const io = capture();
    expect(await runCli([], io)).toBe(exitCode.usage);
    expect(io.stderr).toBe(formatCliHelp());
    const unknown = capture();
    expect(await runCli(["speq", "file.ts"], unknown)).toBe(exitCode.usage);
    expect(unknown.stderr).toContain("unknown command speq");
  });

  it("rejects a misspelled option instead of ignoring it", async () => {
    const io = capture();
    expect(await runCli(["check", "--stict", "fixtures/effects/missing-console.ts"], io)).toBe(exitCode.usage);
    expect(io.stderr).toContain("--stict");
    expect(io.stderr).toContain("usage: uneffect check");
  });

  it("separates gradual lint success from explicit assurance profiles", async () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-assurance-"));
    const unknownFile = join(directory, "unknown.ts"), inferredFile = join(directory, "inferred.ts");
    const declaredFile = join(directory, "declared.ts");
    const emptyFile = join(directory, "empty.ts");
    try {
      writeFileSync(unknownFile, `export function consume(iterator: Iterator<number>) { iterator.next() }`);
      writeFileSync(inferredFile, `export function identity(value: number) { return value }`);
      writeFileSync(declaredFile, `/* uneffect: effect Console */ export function report() { console.log("ok") }`);
      writeFileSync(emptyFile, `export type Empty = never`);

      const gradual = capture();
      expect(await runCli(["check", unknownFile], gradual)).toBe(exitCode.success);
      expect(gradual.stderr).toContain("no diagnostics");

      const noUnknown = capture();
      expect(await runCli(["check", "--assurance", "no-unknown", unknownFile], noUnknown)).toBe(exitCode.success);
      expect(noUnknown.stderr).toContain("assurance no-unknown: passed");
      expect(noUnknown.stderr).toContain("unbounded iterator-effect parameters describe caller-supplied lazy effects");

      const tracked = capture();
      expect(await runCli(["check", "--assurance", "no-unknown", inferredFile], tracked)).toBe(exitCode.success);
      expect(tracked.stderr).toContain("assurance no-unknown: passed");

      const inferred = capture();
      expect(await runCli(["check", "--assurance", "declared", inferredFile], inferred)).toBe(exitCode.failed);
      expect(inferred.stderr).toContain("identity: effect summary is inferred, not declaration-checked");

      const declared = capture();
      expect(await runCli(["check", "--assurance", "declared", declaredFile], declared)).toBe(exitCode.success);
      expect(declared.stderr).toContain("assurance declared: passed");
      expect(declared.stderr).toContain("claim: every emitted function effect summary is declaration-checked");
      expect(declared.stderr).toContain("excluded: unannotated semantic domains are not checked by this profile");

      const empty = capture();
      expect(await runCli(["check", "--assurance", "no-unknown", emptyFile], empty)).toBe(exitCode.success);
      expect(empty.stderr).toContain("coverage: 1 effect summary, 0 contract artifacts, 1 selected file");

      const mixed = capture();
      expect(await runCli(["check", "--assurance", "no-unknown", inferredFile, emptyFile], mixed)).toBe(exitCode.success);
      expect(mixed.stderr).toContain("coverage: 3 effect summaries, 0 contract artifacts, 2 selected files");

      const invalid = capture();
      expect(await runCli(["check", "--assurance", "absolute", declaredFile], invalid)).toBe(exitCode.usage);
      expect(invalid.stderr).toContain("unknown assurance profile absolute");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("fails closed on TypeScript syntax and semantic errors", async () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-typescript-errors-"));
    const syntaxFile = join(directory, "syntax.ts"), semanticFile = join(directory, "semantic.ts");
    try {
      writeFileSync(syntaxFile, `export function broken( {`);
      writeFileSync(semanticFile, `export const count: number = "not-a-number"`);

      const syntax = capture();
      expect(await runCli(["check", "--assurance", "no-unknown", syntaxFile], syntax)).toBe(exitCode.failed);
      expect(syntax.stderr).toContain("error typescript/syntax");
      expect(syntax.stderr).toContain("assurance no-unknown: failed");
      expect(syntax.stderr).toContain("TypeScript source has syntax errors");

      const semantic = capture();
      expect(await runCli(["check", "--assurance", "no-unknown", semanticFile], semantic)).toBe(exitCode.failed);
      expect(semantic.stderr).toContain("error typescript/semantic");
      expect(semantic.stderr).toContain("TypeScript source has semantic errors");
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("reports missing or excess positional arguments per command", async () => {
    const missing = capture();
    expect(await runCli(["evidence"], missing)).toBe(exitCode.usage);
    expect(missing.stderr).toContain("evidence needs one file");
    const excess = capture();
    expect(await runCli(["evidence", "a.ts", "b.ts"], excess)).toBe(exitCode.usage);
    expect(excess.stderr).toContain("evidence takes one file, received 2");
    const backend = capture();
    expect(await runCli(["spec", "wat", "a.ts"], backend)).toBe(exitCode.usage);
    expect(backend.stderr).toContain("unknown spec backend: wat");
  });

  it("reports an unreadable file as a bad argument, not as a toolchain failure", async () => {
    const io = capture();
    expect(await runCli(["check", "no-such-file.ts"], io)).toBe(exitCode.usage);
    expect(io.stderr).toContain("cannot read no-such-file.ts");
    expect(io.stderr).not.toContain("uneffect doctor");
  });

  it("emits the specification IR through the spec command", async () => {
    const io = capture();
    expect(await runCli(["spec", "ir", "examples/spec.ts"], io)).toBe(exitCode.success);
    expect(JSON.parse(io.stdout)).toMatchObject({ fileName: "examples/spec.ts" });
  });

  it("checks the toolchain and names what each unmet requirement blocks", async () => {
    const io = capture();
    const status = await runCli(["doctor", "--skip-solver-probe"], io);
    expect([exitCode.success, exitCode.failed]).toContain(status);
    for (const name of ["node", "typescript", "@types/node", "@informalsystems/quint"]) expect(io.stdout).toContain(name);
    expect(io.stdout).toMatch(/\d+ check\(s\)/u);
    const json = capture();
    expect(await runCli(["doctor", "--json", "--skip-solver-probe"], json)).toBe(status);
    const report = JSON.parse(json.stdout) as { checks: Array<{ name: string; status: string; requiredBy: string; remedy?: string }>; errors: number; warnings: number };
    expect(report.checks.length).toBeGreaterThanOrEqual(5);
    expect(report.errors).toBe(report.checks.filter((check) => check.status === "error").length);
    for (const check of report.checks) {
      expect(check.requiredBy.length).toBeGreaterThan(0);
      if (check.status !== "ok") expect(check.remedy?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it("refuses file arguments the doctor cannot act on", async () => {
    const io = capture();
    expect(await runCli(["doctor", "src/cli.ts"], io)).toBe(exitCode.usage);
    expect(io.stderr).toContain("doctor takes no file arguments");
  });
});
