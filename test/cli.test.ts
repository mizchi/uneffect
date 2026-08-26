import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import ts from "typescript";
import { cliCommands, cliVersion, formatCliHelp, runCli } from "../src/cli-runner.js";
import { exitCode, type CliStreams } from "../src/cli-support.js";
import { builtinContractRegistry } from "../src/builtin-contracts.js";
import { builtinContractDigest } from "../src/evidence.js";
import type { CheckWorkspaceJsonReport } from "../src/check-report.js";

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

  it("loads an exact caller-owned registry and fails closed on runtime drift", async () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-cli-registry-"));
    const fileName = join(directory, "main.ts"), config = join(directory, "registry.json");
    const nodeMajor = Number.parseInt(process.versions.node.split(".")[0]!, 10);
    try {
      writeFileSync(fileName, '/* uneffect: module_effect Console */\nimport "node:path"; export const ready = true');
      const registry = (major: number) => JSON.stringify({
        schema: "uneffect-registry/v1", builtinRegistryVersion: 2,
        moduleInitializations: [{
          module: "node:path", runtime: { kind: "node", major },
          effects: ["Console"], evidence: "trusted",
          trustReason: "reviewed test initialization", trustOwner: "test-platform",
        }],
      });

      writeFileSync(config, registry(nodeMajor));
      const matched = capture();
      expect(await runCli(["check", "--config", config, "--evidence", "--assurance", "no-unknown", fileName], matched)).toBe(exitCode.success);
      expect(matched.stderr).toContain("<module>: Console (trusted)");
      expect(matched.stderr).toContain("assurance no-unknown: passed (assumed)");

      const evidence = capture();
      expect(await runCli(["evidence", "--config", config, fileName], evidence)).toBe(exitCode.success);
      expect((JSON.parse(evidence.stdout) as { artifact: { builtinContractDigest: string } }).artifact.builtinContractDigest)
        .not.toBe(builtinContractDigest(builtinContractRegistry));

      writeFileSync(config, registry(nodeMajor + 1));
      const drifted = capture();
      expect(await runCli(["check", "--config", config, "--assurance", "no-unknown", fileName], drifted)).toBe(exitCode.failed);
      expect(drifted.stderr).toContain("<module>: effect summary is unknown");

      writeFileSync(config, '{"schema":"uneffect-registry/v1","builtinRegistryVersion":2,"ignored":true}');
      const malformed = capture();
      expect(await runCli(["check", "--config", config, fileName], malformed)).toBe(exitCode.usage);
      expect(malformed.stderr).toContain("unknown key");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
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
  }, 30_000);

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

  it("uses the consumer tsconfig and can discover its selected source files", async () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-cli-project-"));
    const sourceDir = join(directory, "src");
    const fileName = join(sourceDir, "loose.ts"), project = join(directory, "tsconfig.json");
    try {
      mkdirSync(sourceDir, { recursive: true });
      writeFileSync(fileName, `
        export function identity(value) { return value }
        export function readEnv() { return process.env.PROJECT_KEY }
      `);
      writeFileSync(project, JSON.stringify({
        compilerOptions: {
          target: "ES2024", module: "ESNext", moduleResolution: "Bundler",
          noImplicitAny: false, noEmit: true, types: ["node"],
          typeRoots: [join(process.cwd(), "node_modules/@types")],
        },
        include: ["src/**/*.ts"],
      }));

      const explicit = capture();
      expect(await runCli(["check", "--project", project, "--infer", fileName], explicit)).toBe(exitCode.success);
      expect(explicit.stderr).not.toContain("typescript/semantic");

      const discovered = capture();
      expect(await runCli(["check", "--project", project, "--infer", "--evidence"], discovered)).toBe(exitCode.success);
      expect(discovered.stderr).toContain("effects identity:");
      expect(discovered.stderr).toContain('effects readEnv: Env<"PROJECT_KEY"> (inferred)');
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("rejects an invalid or empty TypeScript project as CLI usage", async () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-cli-invalid-project-"));
    const malformed = join(directory, "malformed.json"), empty = join(directory, "empty.json");
    try {
      writeFileSync(malformed, "{");
      writeFileSync(empty, JSON.stringify({ include: ["missing/**/*.ts"] }));
      const bad = capture();
      expect(await runCli(["check", "--project", malformed], bad)).toBe(exitCode.usage);
      expect(bad.stderr).toContain("cannot read TypeScript project");
      const none = capture();
      expect(await runCli(["check", "--project", empty], none)).toBe(exitCode.usage);
      expect(none.stderr).toContain("does not select any source files");
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("emits a versioned machine-readable check decision, including failed assurance", async () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-cli-check-json-"));
    const fileName = join(directory, "client.ts");
    try {
      writeFileSync(fileName, `export async function send(url: string) { await fetch(url, { method: "POST" }) }`);
      const io = capture();
      expect(await runCli(["check", "--infer", "--json", "--assurance", "no-unknown", fileName], io)).toBe(exitCode.failed);
      expect(io.stderr).toBe("");
      expect(JSON.parse(io.stdout)).toMatchObject({
        schema: "uneffect-check/v1",
        outcome: "failed",
        counts: { errors: 0, warnings: 0 },
        diagnostics: [],
        effects: expect.arrayContaining([expect.objectContaining({ functionName: "send", evidence: "inferred", effects: [
          "Fetch<POST, Unknown<dynamic-url>>", "Net<Unknown<dynamic-origin>>",
        ] })]),
        assurance: {
          profile: "no-unknown", status: "unknown", passed: false,
          blockers: expect.arrayContaining([expect.objectContaining({ classification: "unknown", functionName: "send" })]),
        },
      });
      expect(JSON.parse(readFileSync("schemas/uneffect-check-v1.schema.json", "utf8"))).toMatchObject({
        properties: { schema: { const: "uneffect-check/v1" } },
        required: expect.arrayContaining(["outcome", "diagnostics", "effects", "contracts", "assurance", "project"]),
      });

      const gradual = capture();
      expect(await runCli(["check", "--infer", "--json", fileName], gradual)).toBe(exitCode.success);
      expect(JSON.parse(gradual.stdout)).toMatchObject({ outcome: "passed", assurance: null });
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("fails assurance when the consumer TypeScript compiler is unresolved or version-drifted", async () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-cli-ts-parity-"));
    const sourceDirectory = join(directory, "src"), fileName = join(sourceDirectory, "main.ts"), project = join(directory, "tsconfig.json");
    const packageDirectory = join(directory, "node_modules", "typescript");
    try {
      mkdirSync(sourceDirectory, { recursive: true });
      writeFileSync(fileName, "export const value = 1");
      writeFileSync(project, JSON.stringify({ compilerOptions: { noEmit: true, types: [] }, include: ["src/**/*.ts"] }));

      const unresolvedIo = capture();
      expect(await runCli(["check", "--project", project, "--infer", "--assurance", "no-unknown", "--json"], unresolvedIo)).toBe(exitCode.failed);
      expect(JSON.parse(unresolvedIo.stdout)).toMatchObject({
        project: { compiler: { analyzerVersion: ts.version, consumerVersion: null, parity: "unknown" } },
        assurance: { status: "unknown", passed: false, blockers: [expect.objectContaining({ kind: "typescript", classification: "unknown" })] },
      });

      mkdirSync(packageDirectory, { recursive: true });
      writeFileSync(join(packageDirectory, "index.js"), "module.exports = {}");
      writeFileSync(join(packageDirectory, "package.json"), JSON.stringify({ name: "typescript", version: "0.0.0-drift", main: "index.js" }));
      const driftedIo = capture();
      expect(await runCli(["check", "--project", project, "--infer", "--assurance", "no-unknown", "--json"], driftedIo)).toBe(exitCode.failed);
      expect(JSON.parse(driftedIo.stdout)).toMatchObject({
        project: { compiler: { analyzerVersion: ts.version, consumerVersion: "0.0.0-drift", parity: "mismatch" } },
        assurance: { status: "unknown", passed: false },
      });

      writeFileSync(join(packageDirectory, "package.json"), JSON.stringify({ name: "typescript", version: ts.version, main: "index.js" }));
      const exactIo = capture();
      expect(await runCli(["check", "--project", project, "--infer", "--assurance", "no-unknown", "--json"], exactIo)).toBe(exitCode.success);
      expect(JSON.parse(exactIo.stdout)).toMatchObject({
        outcome: "passed", project: { compiler: { analyzerVersion: ts.version, consumerVersion: ts.version, parity: "exact" } },
        assurance: { status: "verified", passed: true },
      });
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }, 30_000);

  it("checks solution references as separate compiler domains and fails closed on broken graphs", async () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-cli-ts-workspace-"));
    const project = join(directory, "tsconfig.json"), a = join(directory, "packages", "a"), b = join(directory, "packages", "b");
    const packageDirectory = join(directory, "node_modules", "typescript");
    try {
      mkdirSync(join(a, "src"), { recursive: true });
      mkdirSync(join(b, "src"), { recursive: true });
      mkdirSync(packageDirectory, { recursive: true });
      writeFileSync(join(packageDirectory, "index.js"), "module.exports = {}");
      writeFileSync(join(packageDirectory, "package.json"), JSON.stringify({ name: "typescript", version: ts.version, main: "index.js" }));
      writeFileSync(join(a, "src", "a.ts"), "export const a = 1");
      writeFileSync(join(b, "src", "b.ts"), "export function b() { console.log('b') }");
      for (const child of [a, b]) writeFileSync(join(child, "tsconfig.json"), JSON.stringify({
        compilerOptions: { composite: true, declaration: true, emitDeclarationOnly: true, outDir: "dist", types: [] }, include: ["src/**/*.ts"],
      }));
      writeFileSync(project, JSON.stringify({ files: [], references: [{ path: "./packages/a" }, { path: "./packages/b" }] }));

      const valid = capture();
      expect(await runCli(["check", "--project", project, "--infer", "--assurance", "no-unknown", "--json"], valid)).toBe(exitCode.success);
      expect(valid.stderr).toBe("");
      const validReport = JSON.parse(valid.stdout) as CheckWorkspaceJsonReport;
      expect(validReport).toMatchObject({ schema: "uneffect-workspace-check/v1", outcome: "passed", rootProjectFile: project, blockers: [] });
      expect(validReport.buildOrder).toEqual([join(a, "tsconfig.json"), join(b, "tsconfig.json"), project]);
      expect(validReport.configs.find((item) => item.projectFile === join(a, "tsconfig.json"))?.rootFiles).toEqual([join(a, "src", "a.ts")]);
      expect(validReport.references).toEqual(expect.arrayContaining([
        { from: project, to: join(a, "tsconfig.json") },
        { from: project, to: join(b, "tsconfig.json") },
      ]));
      expect(validReport.projects.map((item) => ({ projectFile: item.project!.projectFile, passed: item.assurance!.passed }))).toEqual([
        { projectFile: join(a, "tsconfig.json"), passed: true },
        { projectFile: join(b, "tsconfig.json"), passed: true },
      ]);
      expect(JSON.parse(readFileSync("schemas/uneffect-workspace-check-v1.schema.json", "utf8"))).toMatchObject({
        properties: { schema: { const: "uneffect-workspace-check/v1" } },
        required: expect.arrayContaining(["rootProjectFile", "references", "buildOrder", "configs", "projects", "blockers", "assurance"]),
      });
      const validText = capture();
      expect(await runCli(["check", "--project", project, "--infer", "--assurance", "no-unknown"], validText)).toBe(exitCode.success);
      expect(validText.stderr).toContain(`project ${join(a, "tsconfig.json")}`);
      expect(validText.stderr).toContain("workspace: passed; 2 checked compiler domain(s), 0 blocker(s)");

      writeFileSync(project, JSON.stringify({ files: [], references: [{ path: "./packages/missing" }] }));
      const missing = capture();
      expect(await runCli(["check", "--project", project, "--infer", "--assurance", "no-unknown", "--json"], missing)).toBe(exitCode.failed);
      expect(JSON.parse(missing.stdout)).toMatchObject({
        schema: "uneffect-workspace-check/v1", outcome: "failed",
        blockers: expect.arrayContaining([expect.objectContaining({ kind: "missing-reference", classification: "unknown" })]),
      });

      writeFileSync(project, JSON.stringify({ files: [], references: [{ path: "./packages/a" }] }));
      writeFileSync(join(a, "tsconfig.json"), "{");
      const malformed = capture();
      expect(await runCli(["check", "--project", project, "--infer", "--assurance", "no-unknown", "--json"], malformed)).toBe(exitCode.failed);
      expect(JSON.parse(malformed.stdout)).toMatchObject({
        outcome: "failed", blockers: expect.arrayContaining([expect.objectContaining({ kind: "invalid-reference", classification: "unknown" })]),
      });

      writeFileSync(join(a, "tsconfig.json"), JSON.stringify({ compilerOptions: { composite: true, declaration: true, emitDeclarationOnly: true, outDir: "dist", types: [] }, include: ["src/**/*.ts"] }));
      writeFileSync(project, JSON.stringify({ files: ["packages/a/src/a.ts"], references: [{ path: "./packages/a" }] }));
      const duplicate = capture();
      expect(await runCli(["check", "--project", project, "--infer", "--assurance", "no-unknown", "--json"], duplicate)).toBe(exitCode.failed);
      expect(JSON.parse(duplicate.stdout)).toMatchObject({
        outcome: "failed", blockers: expect.arrayContaining([expect.objectContaining({ kind: "duplicate-root-file", classification: "unknown" })]),
      });

      writeFileSync(project, JSON.stringify({ files: [], references: [{ path: "./packages/a" }] }));
      writeFileSync(join(a, "tsconfig.json"), JSON.stringify({ files: [], references: [{ path: "../.." }] }));
      const cycle = capture();
      expect(await runCli(["check", "--project", project, "--infer", "--assurance", "no-unknown", "--json"], cycle)).toBe(exitCode.failed);
      expect(JSON.parse(cycle.stdout)).toMatchObject({
        outcome: "failed", blockers: expect.arrayContaining([expect.objectContaining({ kind: "reference-cycle", classification: "unknown" })]),
      });
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }, 30_000);

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

  it("emits auditable iterator-effect parameters and bounds in evidence JSON", async () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-evidence-iterator-"));
    const fileName = join(directory, "bounded.ts");
    try {
      writeFileSync(fileName, `
        /* uneffect: effect Console */ function* generate() { console.log("step"); yield 1 }
        /* uneffect: effect_parameter iterator extends Console */
        export function consume(iterator: IteratorObject<unknown>) { iterator.next() }
        /* uneffect: effect Console */ export function main() { consume(generate()) }
      `);
      const io = capture();
      expect(await runCli(["evidence", fileName], io)).toBe(exitCode.success);
      const output = JSON.parse(io.stdout) as { artifact: { schemaVersion: number; summaries: Array<Record<string, unknown>> }; eligibility: { eligible: boolean; vacuous: boolean; blockers: unknown[] } };
      expect(output.artifact.schemaVersion).toBe(3);
      expect(output.eligibility).toEqual({ eligible: true, vacuous: false, blockers: [] });
      expect(output.artifact.summaries.find((summary) => summary.functionName === "consume")).toMatchObject({
        evidence: "verified",
        iteratorEffectParameters: [{ index: 0, name: "iterator", convertsThrowToRejection: false }],
        iteratorEffectBounds: [{ index: 0, name: "iterator", effects: ["Console"] }],
      });
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("emits the specification IR through the spec command", async () => {
    const io = capture();
    expect(await runCli(["spec", "ir", "examples/spec.ts"], io)).toBe(exitCode.success);
    expect(JSON.parse(io.stdout)).toMatchObject({ fileName: "examples/spec.ts" });
  });

  it("emits module-order evidence and can require a proof-grade extraction", async () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-module-order-cli-"));
    const dependency = join(directory, "dependency.mts"), entry = join(directory, "entry.mts"), external = join(directory, "external.mts");
    try {
      writeFileSync(dependency, "export const value = await Promise.resolve(1)");
      writeFileSync(entry, 'import { value } from "./dependency.mjs"; console.log(value)');
      writeFileSync(external, 'import "node:path"; export const ready = true');

      const verified = capture();
      expect(await runCli(["module-order", "--require", entry], verified)).toBe(exitCode.success);
      expect(JSON.parse(verified.stdout)).toMatchObject({ evidence: "verified", entryFile: entry });

      const inspected = capture();
      expect(await runCli(["module-order", external], inspected)).toBe(exitCode.success);
      expect(JSON.parse(inspected.stdout)).toMatchObject({ evidence: "unknown" });

      const required = capture();
      expect(await runCli(["module-order", "--require", external], required)).toBe(exitCode.failed);
      expect(required.stderr).toContain("module initialization order is unknown");
      expect(required.stderr).toContain("external-static-import");
    } finally { rmSync(directory, { recursive: true, force: true }); }
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
