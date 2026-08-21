import { globSync, readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { analyzeProgramEffects } from "../src/effects.js";
import { auditBuiltinDeclarationDrift } from "../src/frontend-adapter.js";
import { verifyUneffectProject } from "../src/project-verification.js";

describe("Uneffect dogfood", () => {
  it("analyzes its own implementation without diagnostics or unknown summaries in inference mode", () => {
    const program = ts.createProgram(globSync("src/*.ts"), {
      target: ts.ScriptTarget.ES2024,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      lib: ["lib.es2024.d.ts", "lib.dom.d.ts"],
      types: ["node"],
      noEmit: true,
    });
    const result = analyzeProgramEffects(program, { requireAnnotations: false });
    expect(result.summaries.length).toBeGreaterThan(200);
    expect(result.diagnostics).toEqual([]);
    expect(result.summaries.filter((summary) => summary.evidence === "unknown")).toEqual([]);
  }, 20_000);

  it("analyzes the independently maintained Effect Function module without frontend drift", () => {
    const entry = "node_modules/effect/src/Function.ts";
    const program = ts.createProgram([entry], {
      target: ts.ScriptTarget.ES2024,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      lib: ["lib.es2024.d.ts", "lib.dom.d.ts"],
      types: ["node"],
      noEmit: true,
      skipLibCheck: true,
    });
    const externalSources = program.getSourceFiles().filter((source) => source.fileName.includes("/effect/src/"));
    const result = analyzeProgramEffects(program, { requireAnnotations: false });
    expect(externalSources.length).toBeGreaterThanOrEqual(3);
    expect(result.summaries.length).toBeGreaterThanOrEqual(40);
    expect(result.diagnostics).toEqual([]);
    expect(result.summaries.filter((summary) => summary.evidence === "unknown")).toEqual([]);
    expect(auditBuiltinDeclarationDrift(program)).toEqual([]);
  }, 20_000);

  it("enforces a Console boundary on an adapter using external Effect pipe", () => {
    const entry = "examples/dogfood/effect-adapter.ts";
    const compilerOptions: ts.CompilerOptions = {
      target: ts.ScriptTarget.ES2024,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      lib: ["lib.es2024.d.ts", "lib.dom.d.ts"],
      types: ["node"],
      noEmit: true,
      skipLibCheck: true,
    };
    const program = ts.createProgram([entry], compilerOptions);
    const result = analyzeProgramEffects(program, { requireAnnotations: true });
    const main = result.summaries.find((summary) => summary.functionName === "main");
    expect(result.diagnostics).toEqual([]);
    expect(main).toMatchObject({ evidence: "verified", effects: [expect.objectContaining({ kind: "capability", name: "Console" })] });

    const host = ts.createCompilerHost(compilerOptions);
    const source = readFileSync(entry, "utf8").replace("effect Console", "effect FsRead<\"$CWD/**\">");
    const original = host.getSourceFile.bind(host);
    host.getSourceFile = (name, languageVersion, onError, fresh) => name === entry
      ? ts.createSourceFile(entry, source, languageVersion, true, ts.ScriptKind.TS)
      : original(name, languageVersion, onError, fresh);
    const broken = analyzeProgramEffects(ts.createProgram([entry], compilerOptions, host), { requireAnnotations: true });
    expect(broken.diagnostics).toContainEqual(expect.objectContaining({ kind: "missing", functionName: "main", effect: "Console" }));
  }, 20_000);

  it("verifies a Hoare contract through the external Effect pipe adapter", async () => {
    const entry = "examples/dogfood/effect-adapter.ts";
    const source = readFileSync(entry, "utf8");
    const verified = await verifyUneffectProject({ files: { [entry]: source } });
    expect(verified.diagnostics).toEqual([]);
    expect(verified.obligations).toContainEqual(expect.objectContaining({ status: "verified", evidence: "verified" }));

    const broken = await verifyUneffectProject({ files: { [entry]: source.replace("current + 1", "current - 1") } });
    expect(broken.diagnostics).toContainEqual(expect.objectContaining({ functionName: "increment", clause: "ensures" }));
    expect(broken.obligations).toContainEqual(expect.objectContaining({ status: "counterexample", evidence: "unknown" }));
  }, 20_000);
});
