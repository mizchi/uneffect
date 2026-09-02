import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import ts from "typescript";
import { cliCommands, cliVersion, formatCliHelp, runCli } from "../src/cli-runner.js";
import { exitCode, type CliStreams } from "../src/cli-support.js";
import { builtinContractRegistry } from "../src/builtin-contracts.js";
import { builtinContractDigest } from "../src/evidence.js";
import type { CheckWorkspaceJsonReport } from "../src/check-report.js";
import { createContractSummaryBundle } from "../src/contract-summary.js";
import { verifyContractObligations } from "../src/contracts.js";
import { createResourceCallableContractArtifact } from "../src/resource-callable-artifact.js";

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
    expect(manifest.bin).toEqual({ uneffect:"dist/src/cli.js" });
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
    const misplacedBuildGate = capture();
    expect(await runCli(["check", "--require-build-artifacts", "fixtures/effects/missing-console.ts"], misplacedBuildGate)).toBe(exitCode.usage);
    const misplacedExactBuildGate = capture();
    expect(await runCli(["check", "--require-exact-build-artifacts", "fixtures/effects/missing-console.ts"], misplacedExactBuildGate)).toBe(exitCode.usage);
    expect(misplacedBuildGate.stderr).toContain("requires --project without positional files");
  });

  it("loads an exact caller-owned registry and fails closed on runtime drift", async () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-cli-registry-"));
    const fileName = join(directory, "main.ts"), config = join(directory, "registry.json");
    const nodeMajor = Number.parseInt(process.versions.node.split(".")[0]!, 10);
    try {
      writeFileSync(fileName, '/* uneffect:module_effect Console */\nimport "node:path"; export const ready = true');
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

  it("loads declarative semantics modules and records their trusted ledger", async () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-cli-module-"));
    const fileName = join(directory, "main.ts"), moduleFile = join(directory, "audit.uneffect.json");
    try {
      writeFileSync(fileName, '/* uneffect:module_effect Acme.Audit.Init */\nimport "node:path"; export const ready = true');
      writeFileSync(moduleFile, JSON.stringify({
        schema: "uneffect-module/v1", name: "@acme/audit-semantics", version: "1.0.0", namespace: "Acme.Audit",
        evidence: "trusted", trustOwner: "security-platform", trustReason: "reviewed test module",
        effectSchemas: [{ name: "Acme.Audit.Init", version: 1, arguments: [] }],
        registry: {
          schema: "uneffect-registry/v1", builtinRegistryVersion: 2,
          moduleInitializations: [{
            module: "node:path", runtime: { kind: "node", major: Number.parseInt(process.versions.node.split(".")[0]!, 10) },
            effects: ["Acme.Audit.Init"], evidence: "trusted", trustReason: "reviewed initialization", trustOwner: "security-platform",
          }],
        },
      }));
      const checked = capture();
      expect(await runCli(["check", "--semantics-module", moduleFile, "--assurance", "no-unknown", fileName], checked)).toBe(exitCode.success);
      const evidence = capture();
      expect(await runCli(["evidence", "--semantics-module", moduleFile, fileName], evidence)).toBe(exitCode.success);
      expect((JSON.parse(evidence.stdout) as { artifact: { modules: Array<{ name: string; evidence: string }> } }).artifact.modules)
        .toEqual([expect.objectContaining({ name: "@acme/audit-semantics", evidence: "trusted" })]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("loads a package contract summary and binds it to the installed declaration", async () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-cli-contract-summary-"));
    const producerFile = join(directory, "producer.ts");
    const consumerFile = join(directory, "consumer.ts");
    const reporterFile = join(directory, "reporter.ts");
    const summaryFile = join(directory, "contract-summary.json");
    const packageDirectory = join(directory, "node_modules", "@example", "math");
    const producerSource = `
      /* uneffect:requires value >= 0 */
      /* uneffect:ensures result === value + 1 */
      export async function addOne(value: number): Promise<number> { return value + 1 }
      /* uneffect:effect Console */
      export function report(message: string): void { console.log(message) }
      /* uneffect:effect Console */
      export const reportArrow = (message: string): void => { console.log(message) }
      /* uneffect:effect Mutate<typeof target.value> | Throw<RangeError> */
      export function update(target: { value: number }): void {
        target.value += 1
        if (target.value < 0) throw new RangeError("invalid")
      }
      /* uneffect:effect none */
      /* uneffect:effect_parameter callback extends Console */
      export function once(callback: () => void): void { callback() }
      /* uneffect:effect none */
      /* uneffect:effect_parameter onDone extends Console */
      export function configure({ onDone }: { onDone: () => void }): void { onDone() }
      /* uneffect:effect none */
      /* uneffect:effect_parameter callback extends Console */
      export function choose(callback: () => void, ok: boolean): void {
        if (ok) callback()
        else callback()
      }
      /* uneffect:effect none */
      /* uneffect:effect_parameter callback extends Console */
      export function chooseLater(left: Promise<void>, right: Promise<void>, callback: () => void, first: boolean): Promise<void> {
        if (first) return left.then(callback)
        else return right.then(callback)
      }
      /* uneffect:effect none */
      export function makeReporter(): (message: string) => void {
        return (message: string) => console.log(message)
      }
      export interface Client {
        report(message: string): void
        run(callback: () => void): void
        schedule(callback: () => void): void
        chain(): Client
      }
      /* uneffect:effect none */
      export function createClient(): Client {
        return {
          report(message: string): void { console.log(message) },
          /* uneffect:effect_parameter callback extends Console */
          run(callback: () => void): void { callback() },
          /* uneffect:effect_parameter callback extends Console */
          schedule(callback: () => void): void { setTimeout(callback, 0) },
          chain(): Client { return this },
        }
      }
    `;
    const consumerSource = `
      import { addOne, choose, chooseLater, configure, createClient, once, report, reportArrow, update } from "@example/math"
      import { madeReporter } from "./reporter.js"
      const client = createClient()
      const clientAlias = client
      /* uneffect:requires value >= 0 */
      /* uneffect:ensures result === value + 1 */
      export async function run(value: number): Promise<number> { return await addOne(value) }
      /* uneffect:effect Console */
      export function reportIt(message: string): void { report(message) }
      /* uneffect:effect Console */
      export function reportArrowIt(message: string): void { reportArrow(message) }
      /* uneffect:effect Mutate<typeof state.value> | Throw<RangeError> */
      export function updateIt(state: { value: number }): void { update(state) }
      /* uneffect:effect Console */
      function logOnce(): void { console.log("once") }
      /* uneffect:effect Console */
      export function runOnce(): void { once(logOnce) }
      /* uneffect:effect Console */
      export function runConfigured(): void {
        const options = { onDone: logOnce }
        configure(options)
        configure(options)
      }
      /* uneffect:effect Console */
      export function runChosen(ok: boolean): void { choose(logOnce, ok) }
      /* uneffect:effect Console */
      export async function runChosenLater(ok: boolean): Promise<void> {
        await chooseLater(Promise.resolve(), Promise.resolve(), logOnce, ok)
      }
      /* uneffect:effect Console */
      export function runMadeReporter(message: string): void { madeReporter(message) }
      /* uneffect:effect Console */
      export function runClient(message: string): void { clientAlias.chain().report(message) }
      /* uneffect:effect Console */
      export function runClientCallback(): void { clientAlias.run(logOnce) }
      /* uneffect:effect Console | Timer */
      export function runClientScheduled(): void { clientAlias.schedule(logOnce) }
    `;
    try {
      mkdirSync(packageDirectory, { recursive: true });
      writeFileSync(producerFile, producerSource);
      writeFileSync(consumerFile, consumerSource);
      writeFileSync(reporterFile, `
        import { makeReporter } from "@example/math"
        const reporter = makeReporter()
        export const madeReporter = reporter
      `);
      writeFileSync(join(packageDirectory, "package.json"), JSON.stringify({
        name: "@example/math", version: "1.2.3", types: "index.d.ts",
      }));
      writeFileSync(join(packageDirectory, "index.d.ts"), [
        "export declare function addOne(value: number): Promise<number>;",
        "export declare function report(message: string): void;",
        "export declare const reportArrow: (message: string) => void;",
        "export declare function update(target: { value: number }): void;",
        "export declare function once(callback: () => void): void;",
        "export declare function configure({ onDone }: { onDone: () => void }): void;",
        "export declare function choose(callback: () => void, ok: boolean): void;",
        "export declare function chooseLater(left: Promise<void>, right: Promise<void>, callback: () => void, first: boolean): Promise<void>;",
        "export declare function makeReporter(): (message: string) => void;",
        "export interface Client { report(message: string): void; run(callback: () => void): void; schedule(callback: () => void): void; chain(): Client }",
        "export declare function createClient(): Client;",
        "",
      ].join("\n"));
      const producerProgram = ts.createProgram([producerFile], {
        strict: true, noEmit: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext,
      });
      const verification = await verifyContractObligations(producerFile, producerSource, undefined, producerProgram);
      const contractBundle = createContractSummaryBundle({
        packageName: "@example/math", packageVersion: "1.2.3", fileName: producerFile,
        source: producerSource, program: producerProgram, artifacts: verification.artifacts,
      });
      expect(contractBundle.exports.find(({ functionName }) => functionName === "createClient")?.effect?.returnMembers)
        .toContainEqual(expect.objectContaining({ key: "chain", returnsReceiver: true }));
      expect(contractBundle.exports.find(({ functionName }) => functionName === "createClient")?.effect?.returnMembers)
        .toContainEqual(expect.objectContaining({
          key: "schedule", callbacks: [expect.objectContaining({ schedulingSource: "setTimeout", schedulingDelay: 0 })],
        }));
      writeFileSync(summaryFile, JSON.stringify(contractBundle));

      const checked = capture();
      expect(await runCli(["check", "--contract-summary", summaryFile, "--evidence", consumerFile], checked), checked.stderr).toBe(exitCode.success);
      expect(checked.stderr).toContain("proved run: ensures result === value + 1");
      expect(checked.stderr).toContain("effects reportIt: Console");
      expect(checked.stderr).toContain("effects reportArrowIt: Console");
      expect(checked.stderr).toContain("effects updateIt: Mutate<typeof state.value> | Throw<RangeError>");
      expect(checked.stderr).toContain("effects runOnce: Console");
      expect(checked.stderr).toContain("effects runConfigured: Console");
      expect(checked.stderr).toContain("effects runChosen: Console");
      expect(checked.stderr).toContain("effects runChosenLater: Console");
      expect(checked.stderr).toContain("effects runMadeReporter: Console");
      expect(checked.stderr).toContain("effects runClient: Console");
      expect(checked.stderr).toContain("effects runClientCallback: Console");
      expect(checked.stderr).toContain("effects runClientScheduled: Timer | Console");
      const reported = capture();
      expect(await runCli(["check", "--contract-summary", summaryFile, "--json", consumerFile], reported)).toBe(exitCode.success);
      expect((JSON.parse(reported.stdout) as { assumptions: { entries: Array<{ domain: string }> } }).assumptions.entries)
        .toContainEqual(expect.objectContaining({ domain: "package-contract" }));

      writeFileSync(join(packageDirectory, "package.json"), JSON.stringify({
        name: "@example/math", version: "1.2.4", types: "index.d.ts",
      }));
      const drifted = capture();
      expect(await runCli(["check", "--contract-summary", summaryFile, consumerFile], drifted)).toBe(exitCode.failed);
      expect(drifted.stderr).toContain("version 1.2.4 does not match summary 1.2.3");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("loads repeated package resource lifecycle artifacts", async () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-cli-resource-contract-"));
    try {
      const packageDirectory = join(directory, "node_modules", "reviewed-resource");
      mkdirSync(packageDirectory, { recursive: true });
      const declarationText = "export interface Handle {}\nexport declare function open(): Handle\nexport declare function close(value: Handle): void\n";
      writeFileSync(join(packageDirectory, "package.json"), JSON.stringify({
        name: "reviewed-resource", version: "1.0.0", types: "index.d.ts",
      }));
      writeFileSync(join(packageDirectory, "index.d.ts"), declarationText);
      const artifactFiles = (["open", "close"] as const).map((name) => {
        const artifact = createResourceCallableContractArtifact({
          symbol: { module: "reviewed-resource", export: name },
          runtime: { kind: "package", version: "1.0.0" }, declarationText,
          summary: {
            schema: "uneffect-resource-callable-summary/v1", id: `reviewed-resource#${name}`, evidence: "trusted",
            operations: name === "open" ? [{ kind: "acquire", subject: { kind: "return" } }]
              : [{ kind: "release", subject: { kind: "parameter", index: 0 } }],
          },
          trust: { owner: "cli-test", reason: "reviewed lifecycle" },
        });
        const fileName = join(directory, `${name}.resource.json`);
        writeFileSync(fileName, JSON.stringify(artifact));
        return fileName;
      });
      const consumer = join(directory, "consumer.ts");
      writeFileSync(consumer, `import { open, close } from "reviewed-resource"; export function main() { const value = open(); close(value) }`);
      const io = capture();
      expect(await runCli(["check", "--infer", "--json",
        "--resource-contract", artifactFiles[0]!, "--resource-contract", artifactFiles[1]!, consumer], io), io.stderr)
        .toBe(exitCode.success);
      const report = JSON.parse(io.stdout) as { resourceProtocols: Array<{ owner: string; status: string }>; assumptions: { entries: Array<{ owner?: string }> } };
      expect(report.resourceProtocols).toContainEqual(expect.objectContaining({ owner: "main", status: "satisfied" }));
      expect(report.assumptions.entries).toContainEqual(expect.objectContaining({ owner: "cli-test" }));
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
      writeFileSync(declaredFile, `/* uneffect:effect Console */ export function report() { console.log("ok") }`);
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

      const verifiedWithBuiltin = capture();
      expect(await runCli(["check", "--assurance", "verified", declaredFile], verifiedWithBuiltin)).toBe(exitCode.failed);
      expect(verifiedWithBuiltin.stderr).toContain("assurance verified: failed (unknown)");
      expect(verifiedWithBuiltin.stderr).toContain("reviewed Console log semantic overlay");

      const pureDeclaredFile = join(directory, "pure-declared.ts");
      writeFileSync(pureDeclaredFile, `/* uneffect:module_effect none */\n/* uneffect:effect none */ export function identity(value: number) { return value }`);
      const verifiedPure = capture();
      expect(await runCli(["check", "--assurance", "verified", pureDeclaredFile], verifiedPure)).toBe(exitCode.success);
      expect(verifiedPure.stderr).toContain("assurance verified: passed (verified)");
      expect(verifiedPure.stderr).toContain("claim: the emitted assumption ledger is empty");

      const empty = capture();
      expect(await runCli(["check", "--assurance", "no-unknown", emptyFile], empty)).toBe(exitCode.success);
      expect(empty.stderr).toContain("coverage: 1 effect summary, 0 contract artifacts, 0 typed-array obligations, 0 typed-array windows, 0 ownership diagnostics, 0 async-iterator obligations, 0 resource-protocol obligations, 0 assumptions, 1 selected file");

      const mixed = capture();
      expect(await runCli(["check", "--assurance", "no-unknown", inferredFile, emptyFile], mixed)).toBe(exitCode.success);
      expect(mixed.stderr).toContain("coverage: 3 effect summaries, 0 contract artifacts, 0 typed-array obligations, 0 typed-array windows, 0 ownership diagnostics, 0 async-iterator obligations, 0 resource-protocol obligations, 0 assumptions, 2 selected files");

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
      const syntaxJson = capture();
      expect(await runCli(["check", "--assurance", "no-unknown", "--json", syntaxFile], syntaxJson)).toBe(exitCode.failed);
      const syntaxReport = JSON.parse(syntaxJson.stdout);
      expect(syntaxReport.assurance).toMatchObject({ passed: false, claims: [] });
      expect(syntaxReport.effects.filter((effect: { evidence: string }) => effect.evidence === "unknown"))
        .toEqual(expect.arrayContaining([expect.objectContaining({
          unknownReasons: expect.arrayContaining([expect.objectContaining({ code: "typescript-errors" })]),
        })]));

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
        assumptions: {
          schema: "uneffect-assumptions/v1",
          entries: [expect.objectContaining({ domain: "builtin", reason: "reviewed builtin semantic overlay" })],
          violations: [],
        },
        effects: expect.arrayContaining([expect.objectContaining({ functionName: "send", evidence: "inferred", effects: [
          "Fetch<POST, Unknown<dynamic-url>>", "Net<Unknown<dynamic-origin>>",
        ] })]),
        assurance: {
          profile: "no-unknown", status: "unknown", passed: false,
          claims: [],
          blockers: expect.arrayContaining([expect.objectContaining({ classification: "unknown", functionName: "send" })]),
        },
      });
      expect(JSON.parse(readFileSync("schemas/uneffect-check-v1.schema.json", "utf8"))).toMatchObject({
        properties: { schema: { const: "uneffect-check/v1" } },
        required: expect.arrayContaining(["outcome", "diagnostics", "effects", "contracts", "assumptions", "typedArrays", "ownership", "asyncIterators", "resourceProtocols", "assurance", "project"]),
        $defs: {
          assurance: { allOf: [expect.objectContaining({ then: { properties: { claims: { maxItems: 0 } } } })] },
          assumption: { properties: {
            domain: { enum: expect.arrayContaining(["temporal-contract", "resource-callable"]) },
            reviewDigest: { pattern: "^[a-f0-9]{64}$" },
          } },
          z3Attempt: { required: expect.arrayContaining(["backend", "version", "status", "stdout", "stderr", "exitCode"]) },
        },
      });

      const gradual = capture();
      expect(await runCli(["check", "--infer", "--json", fileName], gradual)).toBe(exitCode.success);
      expect(JSON.parse(gradual.stdout)).toMatchObject({ outcome: "passed", assurance: null });

      const contracted = join(directory, "contracted.ts");
      writeFileSync(contracted, "/* uneffect:ensures result === x */ export function identity(x: number) { return x }");
      const proof = capture();
      expect(await runCli(["check", "--json", contracted], proof)).toBe(exitCode.success);
      expect(JSON.parse(proof.stdout)).toMatchObject({
        contracts: [expect.objectContaining({
          status: "verified",
          solver: {
            backend: expect.stringMatching(/^(?:native|wasm)$/),
            version: expect.any(String),
            attempts: expect.arrayContaining([expect.objectContaining({ status: "unsat" })]),
          },
        })],
      });
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("runs typed-array and ownership checks through the default CLI pipeline", async () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-cli-memory-safety-"));
    const fileName = join(directory, "memory.ts");
    try {
      writeFileSync(fileName, `
        type FixedArrayBuffer<N extends number> = ArrayBuffer
        type BoundedArrayBuffer<N extends number> = ArrayBuffer
        type BoundedDataView<N extends number> = DataView
        type BoundedUint8Array<N extends number> = Uint8Array
        function window(bytes: BoundedUint8Array<8>) { const shared = bytes.subarray(0, 4); return shared }
        function broken(buffer: FixedArrayBuffer<16>): BoundedDataView<8> {
          structuredClone({}, { transfer: [buffer] })
          return new DataView(buffer, 0, 8) as BoundedDataView<8>
        }
        function shrink(buffer: BoundedArrayBuffer<16>): BoundedDataView<8> {
          buffer.resize(4)
          return new DataView(buffer, 0, 8) as BoundedDataView<8>
        }
        function staleView(buffer: BoundedArrayBuffer<16>) {
          buffer.resize(16)
          const bytes: BoundedUint8Array<8> = new Uint8Array(buffer, 0, 8)
          buffer.resize(4)
          return bytes[0]
        }
      `);
      const io = capture();
      expect(await runCli(["check", "--infer", "--json", fileName], io)).toBe(exitCode.failed);
      const report = JSON.parse(io.stdout);
      expect(report).toMatchObject({
        outcome: "failed",
        typedArrays: {
          obligations: expect.arrayContaining([
            expect.objectContaining({ kind: "dataview-backing-bounds", result: "counterexample" }),
            expect.objectContaining({ functionName: "shrink", kind: "dataview-backing-bounds", result: "counterexample", goal: expect.stringContaining("<= 4") }),
            expect.objectContaining({ functionName: "staleView", kind: "index-bounds", result: "counterexample", goal: expect.stringContaining("view remains in bounds") }),
          ]),
          windows: expect.arrayContaining([expect.objectContaining({ backing: "shared", result: "verified" })]),
          statistics: { solverQueries: expect.any(Number) },
        },
        ownership: expect.arrayContaining([expect.objectContaining({ operation: "read", state: "detached" })]),
        diagnostics: expect.arrayContaining([
          expect.objectContaining({ code: "ownership/invalid-transition" }),
          expect.objectContaining({ code: "typed-array/dataview-backing-bounds" }),
        ]),
      });
      const assured = capture();
      expect(await runCli(["check", "--infer", "--json", "--assurance", "no-unknown", fileName], assured)).toBe(exitCode.failed);
      expect(JSON.parse(assured.stdout).assurance).toMatchObject({
        passed: false,
        blockers: expect.arrayContaining([
          expect.objectContaining({ kind: "typed-array", classification: "violation" }),
          expect.objectContaining({ kind: "ownership", classification: "violation" }),
        ]),
        coverage: expect.objectContaining({ typedArrayObligations: expect.any(Number), typedArrayWindows: 1, ownershipDiagnostics: expect.any(Number) }),
      });
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("loads caller-owned assumption records for source trust IDs", async () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-cli-assumptions-"));
    const fileName = join(directory, "runtime.ts");
    const registryFile = join(directory, "assumptions.json");
    try {
      writeFileSync(fileName, `
        /* uneffect:temporal_contract ensures ready' = true */
        /* uneffect:trust trust assumption runtime-summary-v1 */
        export function start() {}
      `);
      writeFileSync(registryFile, JSON.stringify({
        schema: "uneffect-assumption-registry/v1",
        records: [{
          id: "runtime-summary-v1", domain: "temporal-contract", reason: "reviewed runtime summary",
          owner: "runtime-team", reviewDigest: "a".repeat(64),
        }],
      }));
      const io = capture();
      expect(await runCli(["check", "--infer", "--json", "--assumptions", registryFile, fileName], io))
        .toBe(exitCode.success);
      expect(JSON.parse(io.stdout).assumptions.entries).toContainEqual(expect.objectContaining({
        id: "runtime-summary-v1", domain: "temporal-contract", owner: "runtime-team",
        reviewDigest: "a".repeat(64),
      }));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("emits invalid effect-set syntax as a structured JSON diagnostic", async () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-cli-invalid-effect-set-"));
    const fileName = join(directory, "invalid.ts");
    try {
      writeFileSync(fileName, `/* uneffect:effect none | Console */ export function invalid() {}`);
      const io = capture();
      expect(await runCli(["check", "--json", fileName], io)).toBe(exitCode.failed);
      expect(io.stderr).toBe("");
      expect(JSON.parse(io.stdout)).toMatchObject({
        schema: "uneffect-check/v1",
        outcome: "failed",
        diagnostics: [expect.objectContaining({
          code: "effect/invalid", severity: "error", functionName: "invalid",
          message: expect.stringContaining("`none` must be the only member"),
        })],
        effects: expect.arrayContaining([expect.objectContaining({ functionName: "invalid", evidence: "unknown" })]),
      });
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it.each([
    ["unknown", "/* uneffect: effects Console */", "effects"],
    ["removed refinement", "/* uneffect:refinement counter@1 action report */", "refinement"],
    ["removed runtime", "/* uneffect:runtime counter@1 = globalThis */", "runtime"],
  ])("fails closed on an %s Uneffect dialect in the normal check path", async (_case, annotation, dialect) => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-cli-invalid-directive-"));
    const fileName = join(directory, "invalid.ts");
    try {
      writeFileSync(fileName, `${annotation} export function report() { console.log("x") }`);
      const io = capture();
      expect(await runCli(["check", "--infer", "--json", fileName], io)).toBe(exitCode.failed);
      expect(io.stderr).toBe("");
      const report = JSON.parse(io.stdout);
      expect(report.diagnostics).toContainEqual(expect.objectContaining({
        code: "effect/invalid", severity: "error", functionName: "<annotation>",
        message: `unknown Uneffect dialect \`${dialect}\``,
      }));
      expect(report.effects).toEqual(expect.arrayContaining([
        expect.objectContaining({ functionName: "report", evidence: "unknown", unknownReasons: expect.arrayContaining([
          expect.objectContaining({ code: "invalid-annotation" }),
        ]) }),
        expect.objectContaining({ functionName: "<module>", evidence: "unknown", unknownReasons: expect.arrayContaining([
          expect.objectContaining({ code: "invalid-annotation" }),
        ]) }),
      ]));
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
      expect(validReport.effectComposition).toMatchObject({ status: "not-applicable", links: [], blockers: [] });
      expect(validReport.refinementComposition).toMatchObject({ status: "not-applicable", links: [], blockers: [] });
      expect(validReport.buildArtifacts.status).toBe("stale");
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
        required: expect.arrayContaining(["rootProjectFile", "references", "buildOrder", "buildArtifacts", "outputIntegrity", "configs", "projects", "effectComposition", "refinementComposition", "blockers", "assurance"]),
        $defs: {
          declarationIntegrity: { properties: { transform: { $ref: "#/$defs/declarationTransformEvidence" } } },
          declarationTransformEvidence: { properties: {
            schema: { const: "uneffect-declaration-transform-evidence/v1" },
            profile: { const: "embedded-typescript/v1" },
          } },
          refinementComposition: { properties: { links: { items: {
          required: expect.arrayContaining(["callPath", "helperDepthBudget"]),
          properties: {
            callPath: { type: "array", items: { type: "string" }, minItems: 2 },
            helperDepthBudget: { type: "integer", const: 2 },
            runtimeIdentity: { $ref: "#/$defs/refinementRuntimeIdentity" }, guard: { type: "string" },
          },
        } } } },
        },
      });
      const staleArtifacts = capture();
      expect(await runCli(["check", "--project", project, "--infer", "--assurance", "no-unknown", "--require-build-artifacts", "--json"], staleArtifacts)).toBe(exitCode.failed);
      expect(JSON.parse(staleArtifacts.stdout)).toMatchObject({
        buildArtifacts: { status: "stale" },
        blockers: expect.arrayContaining([expect.objectContaining({ kind: "build-artifact", classification: "unknown" })]),
      });
      expect(ts.createSolutionBuilder(ts.createSolutionBuilderHost(ts.sys), [project], {}).build()).toBe(ts.ExitStatus.Success);
      const freshArtifacts = capture();
      expect(await runCli(["check", "--project", project, "--infer", "--assurance", "no-unknown", "--require-build-artifacts", "--json"], freshArtifacts)).toBe(exitCode.success);
      expect(JSON.parse(freshArtifacts.stdout)).toMatchObject({
        outcome: "passed", buildArtifacts: { status: "fresh" }, assurance: { status: "assumed", passed: true },
      });

      writeFileSync(join(a, "src", "a.ts"), `
        /* uneffect:module_effect Console */
        console.log("module-a")
        /* uneffect:effect Console */
        export function report() { console.log("a") }
      `);
      writeFileSync(join(b, "src", "b.ts"), `
        /* uneffect:module_effect Console */
        import { report } from "../../a/src/a.js"
        /* uneffect:effect Console */
        export function relay() { report() }
      `);
      writeFileSync(join(b, "tsconfig.json"), JSON.stringify({
        compilerOptions: { composite: true, declaration: true, emitDeclarationOnly: true, outDir: "dist", types: [] },
        include: ["src/**/*.ts"], references: [{ path: "../a" }],
      }));
      expect(ts.createSolutionBuilder(ts.createSolutionBuilderHost(ts.sys), [project], {}).build()).toBe(ts.ExitStatus.Success);
      const composedEffects = capture();
      expect(await runCli(["check", "--project", project, "--infer", "--assurance", "no-unknown", "--json"], composedEffects)).toBe(exitCode.success);
      expect(JSON.parse(composedEffects.stdout)).toMatchObject({
        effectComposition: {
          status: "verified",
          links: expect.arrayContaining([
            expect.objectContaining({ kind: "function", callee: "report", evidence: "verified", effects: ["Console"] }),
            expect.objectContaining({ kind: "module", callee: "<module>", evidence: "verified", effects: ["Console"] }),
          ]),
          blockers: [],
        },
      });

      const declarationFile = join(a, "dist", "src", "a.d.ts");
      const declarationText = readFileSync(declarationFile, "utf8");
      appendFileSync(declarationFile, "// tampered after a successful build\n");
      const tamperedEffects = capture();
      expect(await runCli(["check", "--project", project, "--infer", "--assurance", "no-unknown", "--json"], tamperedEffects)).toBe(exitCode.failed);
      expect(JSON.parse(tamperedEffects.stdout)).toMatchObject({
        effectComposition: {
          status: "unknown",
          links: expect.arrayContaining([expect.objectContaining({ declarationIntegrity: expect.objectContaining({ status: "mismatch" }) })]),
          blockers: expect.arrayContaining([expect.objectContaining({ message: expect.stringContaining("declaration output content mismatch") })]),
        },
      });
      writeFileSync(declarationFile, declarationText);

      const exactArtifacts = capture();
      expect(await runCli(["check", "--project", project, "--infer", "--assurance", "no-unknown", "--require-exact-build-artifacts", "--json"], exactArtifacts)).toBe(exitCode.failed);
      expect(JSON.parse(exactArtifacts.stdout)).toMatchObject({
        outputIntegrity: { status: "error", outputs: [] },
        blockers: expect.arrayContaining([expect.objectContaining({ kind: "build-output", message: expect.stringContaining("does not emit runtime JavaScript") })]),
      });

      writeFileSync(join(a, "src", "a.ts"), `
        /* uneffect:effect_parameter iterator extends Console */
        export function consume(iterator: Iterator<unknown>) {
          for (;;) { const step = iterator.next(); if (step.done) return }
        }
      `);
      writeFileSync(join(b, "src", "b.ts"), `
        import { consume } from "../../a/src/a.js"
        /* uneffect:effect Console */
        function* generate() { console.log("item") }
        /* uneffect:effect Console */
        export function run() { consume(generate()) }
      `);
      expect(ts.createSolutionBuilder(ts.createSolutionBuilderHost(ts.sys), [project], {}).build()).toBe(ts.ExitStatus.Success);
      const composedIterator = capture();
      expect(await runCli(["check", "--project", project, "--infer", "--assurance", "no-unknown", "--json"], composedIterator)).toBe(exitCode.success);
      expect(JSON.parse(composedIterator.stdout)).toMatchObject({
        effectComposition: { status: "verified", links: expect.arrayContaining([expect.objectContaining({
          callee: "consume",
          iteratorEffectParameters: [{ index: 0, name: "iterator", convertsThrowToRejection: false }],
          iteratorEffectBounds: [{ index: 0, name: "iterator", effects: ["Console"] }],
        })]) },
      });

      writeFileSync(join(a, "src", "a.ts"), `
        export const shared = { value: 0 }
        /* uneffect:effect Mutate<typeof shared.value> */
        export function setShared() { shared.value = 1 }
      `);
      writeFileSync(join(b, "src", "b.ts"), `
        import { setShared, shared } from "../../a/src/a.js"
        /* uneffect:effect Mutate<typeof shared.value> */
        export function update() { setShared() }
      `);
      expect(ts.createSolutionBuilder(ts.createSolutionBuilderHost(ts.sys), [project], {}).build()).toBe(ts.ExitStatus.Success);
      const composedStableMutation = capture();
      expect(await runCli(["check", "--project", project, "--infer", "--assurance", "no-unknown", "--json"], composedStableMutation)).toBe(exitCode.success);
      expect(JSON.parse(composedStableMutation.stdout)).toMatchObject({
        effectComposition: { status: "verified", links: expect.arrayContaining([expect.objectContaining({
          callee: "setShared",
          mutationRoots: [expect.objectContaining({ kind: "export", root: "shared", exportName: "shared", identity: expect.stringContaining("src/a.ts#shared") })],
        })]) },
      });
      expect(composedStableMutation.stdout).not.toContain("declarationKey");

      writeFileSync(join(a, "src", "state.ts"), "export const shared = { value: 0 }\n");
      writeFileSync(join(a, "src", "bridge.ts"), "export { shared } from './state.js'\n");
      writeFileSync(join(a, "src", "a.ts"), `
        /* uneffect:module_effect Mutate<typeof shared.value> */
        import { shared } from "./bridge.js"
        export { shared } from "./bridge.js"
        shared.value = 1
      `);
      writeFileSync(join(b, "src", "b.ts"), `
        /* uneffect:module_effect Mutate<typeof shared.value> */
        import { shared } from "../../a/src/a.js"
        export const value = shared.value
      `);
      expect(ts.createSolutionBuilder(ts.createSolutionBuilderHost(ts.sys), [project], {}).build()).toBe(ts.ExitStatus.Success);
      const composedModuleMutation = capture();
      expect(await runCli(["check", "--project", project, "--infer", "--assurance", "no-unknown", "--json"], composedModuleMutation)).toBe(exitCode.success);
      expect(JSON.parse(composedModuleMutation.stdout)).toMatchObject({
        effectComposition: { status: "verified", links: expect.arrayContaining([expect.objectContaining({
          kind: "module", callee: "<module>", mutationRoots: [expect.objectContaining({ root: "shared", exportName: "shared" })],
        })]) },
      });

      writeFileSync(join(a, "src", "a.ts"), `
        /* uneffect:module_effect Mutate<typeof globalThis.appState.value> | GlobalVarsRead<"appState"> */
        export {}
        declare global { var appState: { value: number } }
        globalThis.appState.value = 1
      `);
      writeFileSync(join(b, "src", "b.ts"), `
        /* uneffect:module_effect Mutate<typeof globalThis.appState.value> | GlobalVarsRead<"appState"> */
        import "../../a/src/a.js"
        export const value = globalThis.appState.value
      `);
      expect(ts.createSolutionBuilder(ts.createSolutionBuilderHost(ts.sys), [project], {}).build()).toBe(ts.ExitStatus.Success);
      const composedAmbientMutation = capture();
      expect(await runCli(["check", "--project", project, "--infer", "--assurance", "no-unknown", "--json"], composedAmbientMutation)).toBe(exitCode.success);
      expect(JSON.parse(composedAmbientMutation.stdout)).toMatchObject({
        effectComposition: { status: "verified", links: expect.arrayContaining([expect.objectContaining({
          kind: "module", mutationRoots: [{ kind: "ambient", root: "globalThis", identity: "ecmascript:realm.globalThis" }],
        })]) },
      });

      writeFileSync(join(a, "src", "a.ts"), `export function report() { console.log("a") }`);
      writeFileSync(join(b, "src", "b.ts"), `
        /* uneffect:module_effect Console */
        import { report } from "../../a/src/a.js"
        /* uneffect:effect Console */
        export function relay() { report() }
      `);
      expect(ts.createSolutionBuilder(ts.createSolutionBuilderHost(ts.sys), [project], {}).build()).toBe(ts.ExitStatus.Success);
      const inferredChildEffects = capture();
      expect(await runCli(["check", "--project", project, "--infer", "--assurance", "no-unknown", "--json"], inferredChildEffects)).toBe(exitCode.failed);
      const inferredChildReport = JSON.parse(inferredChildEffects.stdout) as CheckWorkspaceJsonReport;
      expect(inferredChildReport.effectComposition).toMatchObject({
        status: "unknown",
        blockers: [expect.objectContaining({ kind: "effect-composition", subject: "report" })],
      });
      expect(inferredChildReport.projects.find((item) => item.project?.projectFile === join(b, "tsconfig.json"))?.effects
        .find((item) => item.functionName === "relay")).toMatchObject({ effects: ["Console"], evidence: "unknown" });

      writeFileSync(join(a, "src", "a.ts"), `
        /* uneffect:effect Console */
        export function report() { console.log("a") }
      `);
      writeFileSync(join(b, "src", "b.ts"), `
        import { report } from "../../a/src/a.js"
        /* uneffect:effect FsRead<"$CWD/**"> */
        export function relay() { report() }
      `);
      const missingParentEffect = capture();
      expect(await runCli(["check", "--project", project, "--infer", "--json"], missingParentEffect)).toBe(exitCode.failed);
      expect((JSON.parse(missingParentEffect.stdout) as CheckWorkspaceJsonReport).projects
        .find((item) => item.project?.projectFile === join(b, "tsconfig.json"))?.diagnostics).toContainEqual(expect.objectContaining({
          code: "effect/missing", functionName: "relay", message: expect.stringContaining("Console"),
        }));

      writeFileSync(join(a, "src", "a.ts"), "export const a = 1");
      writeFileSync(join(b, "src", "b.ts"), "export function b() { console.log('b') }");
      writeFileSync(join(b, "tsconfig.json"), JSON.stringify({
        compilerOptions: { composite: true, declaration: true, emitDeclarationOnly: true, outDir: "dist", types: [] }, include: ["src/**/*.ts"],
      }));
      expect(ts.createSolutionBuilder(ts.createSolutionBuilderHost(ts.sys), [project], {}).build()).toBe(ts.ExitStatus.Success);
      const validText = capture();
      expect(await runCli(["check", "--project", project, "--infer", "--assurance", "no-unknown"], validText)).toBe(exitCode.success);
      expect(validText.stderr).toContain(`project ${join(a, "tsconfig.json")}`);
      expect(validText.stderr).toContain("build artifacts: fresh (TypeScript SolutionBuilder dry run)");
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
  }, 60_000);

  it("reports cross-project scalar refinement composition in workspace JSON", async () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-cli-refinement-workspace-"));
    const project = join(directory, "tsconfig.json");
    const child = join(directory, "packages", "child");
    const parent = join(directory, "packages", "parent");
    try {
      for (const path of [join(directory, "node_modules", "typescript"), join(directory, "node_modules", "@mizchi", "uneffect"), join(child, "src"), join(parent, "src")]) {
        mkdirSync(path, { recursive: true });
      }
      writeFileSync(join(directory, "node_modules", "typescript", "index.js"), "module.exports = {}\n");
      writeFileSync(join(directory, "node_modules", "typescript", "package.json"), JSON.stringify({ name: "typescript", version: ts.version, main: "index.js" }));
      writeFileSync(join(directory, "node_modules", "@mizchi", "uneffect", "package.json"), JSON.stringify({
        name: "@mizchi/uneffect", version: "0.0.0-test", type: "module", exports: { "./spec": "./refinement-dsl.d.ts" },
      }));
      writeFileSync(join(directory, "node_modules", "@mizchi", "uneffect", "refinement-dsl.d.ts"), `
        export declare function defineRefinement<T>(definition: T): T;
        export declare function identityProjection(path: string): unknown;
      `);
      const model = `state armed: bool\nstate count: int\ninit armed = true\ninit count = 1\naction increment: count' = count + 1\naction_when increment: armed && count > 0`;
      writeFileSync(join(child, "src", "counter.ts"), `/* uneffect: \n${model}\n */
        /* uneffect:refinement_from "./counter.uneffect.ts#default" */
        export interface Runtime { armed: boolean; count: number }
        export function create(initial: Runtime) { return initial }
        export function observe(runtime: Runtime) { return runtime }
        /* uneffect:effect Mutate<typeof runtime.count> */
        export function increment(runtime: Runtime) { if (!(runtime.armed && runtime.count > 0)) return; runtime.count++ }
      `);
      writeFileSync(join(child, "src", "counter.uneffect.ts"), `
        import { defineRefinement, identityProjection } from "@mizchi/uneffect/spec";
        import { create, observe, increment } from "./counter.js";
        export default defineRefinement({ name: "counter", version: "1", create, observe,
          abstractions: { armed: identityProjection("armed"), count: identityProjection("count") },
          actions: { increment }, invariants: {} });
      `);
      writeFileSync(join(parent, "src", "counter.ts"), `import { increment as incrementChild } from "../../child/src/counter.js"
        import type { Runtime } from "../../child/src/counter.js"
        /* uneffect: \n${model}\n */
        /* uneffect:refinement_from "./counter.uneffect.ts#default" */
        export function create(initial: Runtime) { return initial }
        export function observe(runtime: Runtime) { return runtime }
        /* uneffect:effect Mutate<typeof runtime.count> */
        export function increment(runtime: Runtime) { incrementChild(runtime) }
      `);
      writeFileSync(join(parent, "src", "counter.uneffect.ts"), `
        import { defineRefinement, identityProjection } from "@mizchi/uneffect/spec";
        import { create, observe, increment } from "./counter.js";
        export default defineRefinement({ name: "counter", version: "1", create, observe,
          abstractions: { armed: identityProjection("armed"), count: identityProjection("count") },
          actions: { increment }, invariants: {} });
      `);
      const config = (references: unknown[] = []) => ({
        compilerOptions: { composite: true, declaration: true, emitDeclarationOnly: true, rootDir: "src", outDir: "dist", strict: true, module: "NodeNext", moduleResolution: "NodeNext", types: [] },
        include: ["src/**/*.ts"], references,
      });
      writeFileSync(join(child, "tsconfig.json"), JSON.stringify(config()));
      writeFileSync(join(parent, "tsconfig.json"), JSON.stringify(config([{ path: "../child" }])));
      writeFileSync(project, JSON.stringify({ files: [], references: [{ path: "./packages/parent" }] }));
      expect(ts.createSolutionBuilder(ts.createSolutionBuilderHost(ts.sys), [project], {}).build()).toBe(ts.ExitStatus.Success);
      const io = capture();
      expect(
        await runCli(["check", "--project", project, "--infer", "--assurance", "no-unknown", "--require-build-artifacts", "--json"], io),
        `${io.stdout}\n${io.stderr}`,
      ).toBe(exitCode.success);
      expect(JSON.parse(io.stdout)).toMatchObject({
        refinementComposition: {
          status: "verified", blockers: [],
          links: [expect.objectContaining({ adapterName: "counter", version: "1", modelName: "increment", callPath: ["increment", "increment"], guard: "armed && count > 0", evidence: "verified" })],
        },
        assurance: { passed: true, claims: expect.arrayContaining(["verified child-project scalar refinement actions are composed through bounded resolved parent action call paths"]) },
      });
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }, 30_000);

  it("loads declaration-transform evidence and fails closed when its source drifts", async () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-cli-declaration-transform-"));
    const project = join(directory, "tsconfig.json");
    const sourceFile = join(directory, "src", "value.component");
    const generatedFile = join(directory, "src", "value.ts");
    const manifestFile = join(directory, "transforms.json");
    const generated = "/* uneffect:effect none */\nexport function value() { return 1 }\n";
    const source = `<script lang="ts">\n${generated}</script>\n`;
    const start = source.indexOf(generated), end = start + generated.length;
    const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
    try {
      mkdirSync(join(directory, "src"), { recursive: true });
      mkdirSync(join(directory, "node_modules", "typescript"), { recursive: true });
      writeFileSync(join(directory, "node_modules", "typescript", "index.js"), "module.exports = {}\n");
      writeFileSync(join(directory, "node_modules", "typescript", "package.json"), JSON.stringify({ name: "typescript", version: ts.version, main: "index.js" }));
      writeFileSync(sourceFile, source);
      writeFileSync(generatedFile, generated);
      writeFileSync(project, JSON.stringify({ compilerOptions: { strict: true, types: [] }, include: ["src/**/*.ts"] }));
      writeFileSync(manifestFile, JSON.stringify({
        schema: "uneffect-declaration-transforms/v1",
        transforms: [{
          profile: "embedded-typescript/v1", transform: { name: "component-script", version: "1.0.0" },
          sourceFile: "src/value.component", generatedFile: "src/value.ts", sourceSpan: { start, end },
          sourceDigest: sha256(source), generatedDigest: sha256(generated), compilerVersion: ts.version,
        }],
      }));

      const valid = capture();
      expect(await runCli(["check", "--project", project, "--infer", "--assurance", "no-unknown", "--declaration-transforms", manifestFile, "--json"], valid)).toBe(exitCode.success);
      expect(JSON.parse(valid.stdout)).toMatchObject({ outcome: "passed", blockers: [] });

      writeFileSync(sourceFile, source.replace("return 1", "return 2"));
      const drifted = capture();
      expect(await runCli(["check", "--project", project, "--infer", "--assurance", "no-unknown", "--declaration-transforms", manifestFile, "--json"], drifted)).toBe(exitCode.failed);
      expect(JSON.parse(drifted.stdout)).toMatchObject({
        outcome: "failed",
        blockers: expect.arrayContaining([expect.objectContaining({ kind: "declaration-transform", classification: "violation", subject: generatedFile })]),
      });

      const misplaced = capture();
      expect(await runCli(["check", "--declaration-transforms", manifestFile, generatedFile], misplaced)).toBe(exitCode.usage);
      expect(misplaced.stderr).toContain("requires --project without positional files");
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
    for (const removed of ["async-quint", "promise-quint", "web-loop-quint", "node-loop-quint"]) {
      const compatibility = capture();
      expect(await runCli(["spec", removed, "a.ts"], compatibility)).toBe(exitCode.usage);
      expect(compatibility.stderr).toContain(`unknown spec backend: ${removed}`);
    }
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
        /* uneffect:effect Console */ function* generate() { console.log("step"); yield 1 }
        /* uneffect:effect_parameter iterator extends Console */
        export function consume(iterator: IteratorObject<unknown>) { iterator.next() }
        /* uneffect:effect Console */ export function main() { consume(generate()) }
      `);
      const io = capture();
      expect(await runCli(["evidence", fileName], io)).toBe(exitCode.success);
      const output = JSON.parse(io.stdout) as { artifact: { schemaVersion: number; summaries: Array<Record<string, unknown>> }; eligibility: { eligible: boolean; vacuous: boolean; blockers: unknown[] } };
      expect(output.artifact.schemaVersion).toBe(4);
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

  it.each(["web", "node"] as const)("emits the unified %s temporal model", async (runtime) => {
    const io = capture();
    expect(await runCli([
      "spec", "temporal", "examples/dogfood/telemetry-once.ts", "main", "--runtime", runtime,
    ], io)).toBe(exitCode.success);
    expect(io.stdout).toContain("var telemetrySends: int");
    expect(io.stdout).toContain("val sendsAtMostOnce = telemetrySends <= 1");
    expect(io.stdout).toContain(runtime === "web" ? "val eventLoopSafe" : "val nodeEventLoopSafe");
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

  it("reports the concrete Z3 runtime selected by the backend policy", async () => {
    const io = capture();
    await runCli(["doctor", "--json"], io);
    const report = JSON.parse(io.stdout) as { checks: Array<{ name: string; status: string; detail: string }> };
    const solver = report.checks.find((check) => check.name === "z3 backend");
    expect(solver).toMatchObject({ status: "ok" });
    expect(solver?.detail).toMatch(/(?:native|wasm).*probe query answered/u);
  });

  it("refuses file arguments the doctor cannot act on", async () => {
    const io = capture();
    expect(await runCli(["doctor", "src/cli.ts"], io)).toBe(exitCode.usage);
    expect(io.stderr).toContain("doctor takes no file arguments");
  });
});
