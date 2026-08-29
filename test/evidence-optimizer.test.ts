import ts from "typescript";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assessEvidenceArtifactEligibility, builtinContractDigest, createEvidenceArtifact, validateEvidenceArtifact, validateOwnershipEvidence, verifyOwnershipObligationWithQuint, verifyOwnershipObligationWithZ3 } from "../src/evidence.js";
import type { OwnershipGuardObligation } from "../src/async-safety.js";
import { analyzeEffectSummariesInProgram, analyzeProgramEffects } from "../src/effects.js";
import { applyOwnershipAssertionElision, applyStableReadReuse, evaluateOwnershipGuardElision, evaluatePropertyMangle, evaluateStableReadReuse } from "../src/optimizer.js";
import { verifyUneffectProject } from "../src/project-verification.js";
import { builtinContractRegistry, extendBuiltinContractRegistry, type BuiltinContractRegistry } from "../src/builtin-contracts.js";
import { ciMeasuredNativeProjectTimeoutMs } from "../ci/test-tiers.js";

function programOf(text: string) {
  const fileName = "/virtual/evidence.ts";
  const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2024, noEmit: true };
  const host = ts.createCompilerHost(options), original = host.getSourceFile.bind(host);
  host.getSourceFile = (name, language, onError, fresh) => name === fileName ? ts.createSourceFile(fileName, text, language, true) : original(name, language, onError, fresh);
  const program = ts.createProgram([fileName], options, host);
  return { program, source: program.getSourceFile(fileName)! };
}

describe("evidence and optimizer obligations", () => {
  it("verifies solution projects as independent compiler domains and aggregates provenance fail closed", async () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-project-workspace-"));
    const root = join(directory, "tsconfig.json");
    const packageDirectory = join(directory, "node_modules", "typescript");
    const reviewedPackageDirectory = join(directory, "node_modules", "reviewed");
    const aDirectory = join(directory, "packages", "a");
    const bDirectory = join(directory, "packages", "b");
    const cDirectory = join(directory, "packages", "c");
    try {
      mkdirSync(join(aDirectory, "src"), { recursive: true });
      mkdirSync(join(bDirectory, "src"), { recursive: true });
      mkdirSync(join(cDirectory, "src"), { recursive: true });
      mkdirSync(packageDirectory, { recursive: true });
      mkdirSync(reviewedPackageDirectory, { recursive: true });
      writeFileSync(join(packageDirectory, "package.json"), JSON.stringify({ name: "typescript", version: ts.version, main: "index.js" }));
      writeFileSync(join(packageDirectory, "index.js"), "module.exports = {}\n");
      writeFileSync(join(reviewedPackageDirectory, "package.json"), JSON.stringify({ name: "reviewed", version: "1.0.0", types: "index.d.ts" }));
      writeFileSync(join(reviewedPackageDirectory, "index.d.ts"), "export {}\n");
      writeFileSync(join(aDirectory, "src", "a.ts"), "export const a: number = 1\n");
      writeFileSync(join(bDirectory, "src", "b.ts"), "export function loose(value) { return value }\n");
      writeFileSync(join(aDirectory, "tsconfig.json"), JSON.stringify({
        compilerOptions: { composite: true, declaration: true, emitDeclarationOnly: true, outDir: "dist", strict: true, types: [] },
        include: ["src/**/*.ts"],
      }));
      writeFileSync(join(bDirectory, "tsconfig.json"), JSON.stringify({
        compilerOptions: { composite: true, declaration: true, emitDeclarationOnly: true, outDir: "dist", strict: false, types: [] },
        include: ["src/**/*.ts"],
      }));
      writeFileSync(root, JSON.stringify({ files: [], references: [{ path: "./packages/a" }, { path: "./packages/b" }] }));

      const verified = await verifyUneffectProject({ projectFile: root });
      expect(verified).toMatchObject({
        schema: "uneffect-project-workspace/v1", rootProjectFile: root,
        assurance: { status: "verified", passed: true },
      });
      expect(JSON.parse(readFileSync("schemas/uneffect-project-workspace-v1.schema.json", "utf8"))).toMatchObject({
        properties: {
          schema: { const: "uneffect-project-workspace/v1" },
          moduleInitializationComposition: { $ref: "./uneffect-workspace-module-order-v1.schema.json" },
        },
        required: expect.arrayContaining(["buildArtifacts", "outputIntegrity", "configs", "projects", "effectComposition", "refinementComposition", "blockers", "assurance"]),
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
      expect(verified.projects.map((item) => item.project.projectFile)).toEqual([
        join(aDirectory, "tsconfig.json"), join(bDirectory, "tsconfig.json"),
      ]);
      expect(verified.projects.map((item) => item.project.compiler.parity)).toEqual(["exact", "exact"]);
      expect(verified.projects.map((item) => item.verification.assurance.status)).toEqual(["verified", "verified"]);
      expect(verified.effectComposition).toMatchObject({ status: "not-applicable", links: [], blockers: [] });
      expect(verified.refinementComposition).toMatchObject({ status: "not-applicable", links: [], blockers: [] });
      expect(verified.assurance.claims).toContain("every referenced compiler domain passed project verification");
      expect(verified.assurance.exclusions).toContain("contract, ownership, invariant, and temporal evidence is not composed across project boundaries");
      expect(verified.assurance.exclusions).not.toContain("this result covers one tsconfig compiler domain; referenced domains require workspace aggregation");
      expect(verified.assurance.exclusions).not.toContain("this assessment covers only explicitly supplied files and analyses represented in this result");
      expect(verified.assurance.exclusions).toContain("this workspace assessment covers the selected source roots in every loaded tsconfig compiler domain");
      expect(verified.buildArtifacts.status).toBe("stale");

      const staleArtifacts = await verifyUneffectProject({ projectFile: root, buildArtifacts: "require-fresh" });
      expect(staleArtifacts.assurance).toMatchObject({ status: "unknown", passed: false, claims: [] });
      expect(staleArtifacts.blockers).toContainEqual(expect.objectContaining({ kind: "build-artifact", classification: "unknown" }));

      const buildHost = ts.createSolutionBuilderHost(ts.sys);
      expect(ts.createSolutionBuilder(buildHost, [root], {}).build()).toBe(ts.ExitStatus.Success);
      const freshArtifacts = await verifyUneffectProject({ projectFile: root, buildArtifacts: "require-fresh" });
      expect(freshArtifacts.buildArtifacts).toMatchObject({ status: "fresh" });
      expect(freshArtifacts.assurance).toMatchObject({ status: "verified", passed: true });

      writeFileSync(join(aDirectory, "src", "a.ts"), `
        /* uneffect: module_effect Console */
        console.log("module-a")
        /* uneffect: effect Console */
        export function report() { console.log("a") }
      `);
      writeFileSync(join(bDirectory, "src", "b.ts"), `
        /* uneffect: module_effect Console */
        import { report } from "../../a/src/a.js"
        /* uneffect: effect Console */
        export function relay() { report() }
      `);
      writeFileSync(join(bDirectory, "tsconfig.json"), JSON.stringify({
        compilerOptions: { composite: true, declaration: true, emitDeclarationOnly: true, outDir: "dist", strict: false, types: [] },
        include: ["src/**/*.ts"], references: [{ path: "../a" }],
      }));
      expect(ts.createSolutionBuilder(ts.createSolutionBuilderHost(ts.sys), [root], {}).build()).toBe(ts.ExitStatus.Success);
      const composed = await verifyUneffectProject({ projectFile: root, buildArtifacts: "require-fresh" });
      const bVerification = composed.projects.find((item) => item.project.projectFile === join(bDirectory, "tsconfig.json"))!.verification;
      expect(bVerification.effects.summaries.find((item) => item.functionName === "relay")).toMatchObject({
        effects: expect.arrayContaining([expect.objectContaining({ kind: "capability", name: "Console" })]),
        evidence: "verified",
      });
      expect(bVerification.effects.summaries.find((item) => item.functionName === "<module>")).toMatchObject({
        effects: expect.arrayContaining([expect.objectContaining({ kind: "capability", name: "Console" })]),
        evidence: "verified",
      });
      expect(composed.assurance).toMatchObject({ status: "assumed", passed: true });
      expect(composed.effectComposition).toMatchObject({
        status: "verified",
        links: expect.arrayContaining([
          expect.objectContaining({ kind: "function", callee: "report", evidence: "verified" }),
          expect.objectContaining({ kind: "module", callee: "<module>", evidence: "verified" }),
        ]),
        blockers: [],
      });

      const childDeclaration = join(aDirectory, "dist", "src", "a.d.ts");
      const originalDeclaration = readFileSync(childDeclaration, "utf8");
      appendFileSync(childDeclaration, "// post-build tamper that remains newer than the source\n");
      const tamperedDeclaration = await verifyUneffectProject({ projectFile: root, buildArtifacts: "require-fresh" });
      expect(tamperedDeclaration.buildArtifacts.status).toBe("fresh");
      expect(tamperedDeclaration.effectComposition).toMatchObject({
        status: "unknown",
        blockers: expect.arrayContaining([expect.objectContaining({
          kind: "effect-composition", subject: "report",
          message: expect.stringContaining("declaration output content mismatch"),
        })]),
      });
      writeFileSync(childDeclaration, originalDeclaration);

      writeFileSync(join(bDirectory, "src", "b.ts"), `
        /* uneffect: module_effect FsRead<"$CWD/**"> */
        import { report } from "../../a/src/a.js"
        /* uneffect: effect Console */
        export function relay() { report() }
      `);
      const missingModuleAuthority = await verifyUneffectProject({ projectFile: root });
      expect(missingModuleAuthority.projects.find((item) => item.project.projectFile === join(bDirectory, "tsconfig.json"))!
        .verification.effects.diagnostics).toContainEqual(expect.objectContaining({
          functionName: "<module>", effect: "Console", kind: "missing", severity: "error",
        }));

      writeFileSync(join(aDirectory, "src", "a.ts"), `
        import "reviewed"
        /* uneffect: effect Console */
        export function report() { console.log("a") }
      `);
      writeFileSync(join(bDirectory, "src", "b.ts"), `
        /* uneffect: module_effect Console */
        import { report } from "../../a/src/a.js"
        /* uneffect: effect Console */
        export function relay() { report() }
      `);
      expect(ts.createSolutionBuilder(ts.createSolutionBuilderHost(ts.sys), [root], {}).build()).toBe(ts.ExitStatus.Success);
      const reviewedRegistry = extendBuiltinContractRegistry(builtinContractRegistry, { moduleInitializations: [{
        module: "reviewed", runtime: { kind: "package", version: "1.0.0" }, effects: [], evidence: "trusted",
        trustReason: "test-reviewed module initialization", trustOwner: "test",
      }] });
      const trustedModule = await verifyUneffectProject({ projectFile: root, builtinRegistry: reviewedRegistry });
      expect(trustedModule.effectComposition).toMatchObject({
        status: "unknown",
        blockers: [expect.objectContaining({ kind: "effect-composition", message: expect.stringContaining("module has trusted") })],
      });
      expect(trustedModule.projects.find((item) => item.project.projectFile === join(bDirectory, "tsconfig.json"))!
        .verification.effects.summaries.find((item) => item.functionName === "<module>")).toMatchObject({ evidence: "unknown" });

      writeFileSync(join(aDirectory, "src", "a.ts"), `
        /* uneffect: module_effect Console */
        console.log("module-a")
        /* uneffect: effect Console */
        export function report() { console.log("a") }
      `);

      writeFileSync(join(cDirectory, "src", "c.ts"), `
        /* uneffect: module_effect Console */
        import { relay } from "../../b/src/b.js"
        /* uneffect: effect Console */
        export function forward() { relay() }
      `);
      writeFileSync(join(cDirectory, "tsconfig.json"), JSON.stringify({
        compilerOptions: { composite: true, declaration: true, emitDeclarationOnly: true, outDir: "dist", strict: true, types: [] },
        include: ["src/**/*.ts"], references: [{ path: "../b" }],
      }));
      writeFileSync(root, JSON.stringify({ files: [], references: [{ path: "./packages/a" }, { path: "./packages/b" }, { path: "./packages/c" }] }));
      expect(ts.createSolutionBuilder(ts.createSolutionBuilderHost(ts.sys), [root], {}).build()).toBe(ts.ExitStatus.Success);
      const transitive = await verifyUneffectProject({ projectFile: root, buildArtifacts: "require-fresh" });
      expect(transitive.effectComposition.links).toEqual(expect.arrayContaining([
        expect.objectContaining({ callee: "report", evidence: "verified" }),
        expect.objectContaining({ callee: "relay", evidence: "verified" }),
      ]));
      expect(transitive.projects.find((item) => item.project.projectFile === join(cDirectory, "tsconfig.json"))!
        .verification.effects.summaries.find((item) => item.functionName === "forward")).toMatchObject({
          effects: expect.arrayContaining([expect.objectContaining({ kind: "capability", name: "Console" })]),
          evidence: "verified",
        });
      expect(transitive.projects.find((item) => item.project.projectFile === join(cDirectory, "tsconfig.json"))!
        .verification.effects.summaries.find((item) => item.functionName === "<module>")).toMatchObject({
          effects: expect.arrayContaining([expect.objectContaining({ kind: "capability", name: "Console" })]),
          evidence: "verified",
        });
      writeFileSync(root, JSON.stringify({ files: [], references: [{ path: "./packages/a" }, { path: "./packages/b" }] }));

      writeFileSync(join(bDirectory, "src", "b.ts"), `
        import { report } from "../../a/src/a.js"
        /* uneffect: effect FsRead<"$CWD/**"> */
        export function relay() { report() }
      `);
      const missingParentDeclaration = await verifyUneffectProject({ projectFile: root });
      expect(missingParentDeclaration.assurance).toMatchObject({ passed: false });
      expect(missingParentDeclaration.projects.find((item) => item.project.projectFile === join(bDirectory, "tsconfig.json"))!
        .verification.effects.diagnostics).toContainEqual(expect.objectContaining({
          functionName: "relay", effect: "Console", kind: "missing", severity: "error",
        }));

      writeFileSync(join(aDirectory, "src", "a.ts"), `export function report() { console.log("a") }`);
      writeFileSync(join(bDirectory, "src", "b.ts"), `
        import { report } from "../../a/src/a.js"
        /* uneffect: effect Console */
        export function relay() { report() }
      `);
      const inferredChild = await verifyUneffectProject({ projectFile: root });
      expect(inferredChild.effectComposition).toMatchObject({
        status: "unknown",
        blockers: [expect.objectContaining({ kind: "effect-composition", subject: "report" })],
      });
      expect(inferredChild.projects.find((item) => item.project.projectFile === join(bDirectory, "tsconfig.json"))!
        .verification.effects.summaries.find((item) => item.functionName === "relay")).toMatchObject({
          effects: expect.arrayContaining([expect.objectContaining({ kind: "capability", name: "Console" })]),
          evidence: "unknown",
        });

      writeFileSync(join(bDirectory, "src", "b.ts"), "export function loose(value) { return value }\n");
      writeFileSync(join(bDirectory, "tsconfig.json"), JSON.stringify({
        compilerOptions: { composite: true, declaration: true, emitDeclarationOnly: true, outDir: "dist", strict: false, types: [] },
        include: ["src/**/*.ts"],
      }));

      writeFileSync(join(aDirectory, "src", "a.ts"), "export function broken(value) { return value }\n");
      const invalidChild = await verifyUneffectProject({ projectFile: root });
      expect(invalidChild.assurance).toMatchObject({ status: "violated", passed: false });
      expect(invalidChild.blockers).toContainEqual(expect.objectContaining({
        kind: "typescript", classification: "violation", projectFile: join(aDirectory, "tsconfig.json"),
      }));
      expect(invalidChild.projects.find((item) => item.project.projectFile === join(bDirectory, "tsconfig.json"))?.verification.assurance)
        .toMatchObject({ status: "verified", passed: true });
      writeFileSync(join(aDirectory, "src", "a.ts"), "export const a: number = 1\n");

      writeFileSync(root, JSON.stringify({ files: [], references: [{ path: "./packages/a" }, { path: "./packages/missing" }] }));
      const missing = await verifyUneffectProject({ projectFile: root });
      expect(missing.assurance).toMatchObject({ status: "unknown", passed: false });
      expect(missing.blockers).toContainEqual(expect.objectContaining({ kind: "missing-reference", classification: "unknown" }));

      writeFileSync(root, JSON.stringify({ files: [], references: [{ path: "./packages/a" }, { path: "./packages/b" }] }));
      writeFileSync(join(packageDirectory, "package.json"), JSON.stringify({ name: "typescript", version: "0.0.0-drift", main: "index.js" }));
      const drifted = await verifyUneffectProject({ projectFile: root });
      expect(drifted.assurance).toMatchObject({ status: "unknown", passed: false });
      expect(drifted.blockers).toContainEqual(expect.objectContaining({ kind: "typescript", classification: "unknown" }));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, ciMeasuredNativeProjectTimeoutMs);

  it("rejects a post-build runtime output mismatch under exact artifact assurance", async () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-project-runtime-integrity-"));
    const root = join(directory, "tsconfig.json"), child = join(directory, "child"), parent = join(directory, "parent");
    try {
      const packageDirectory = join(directory, "node_modules", "typescript");
      mkdirSync(packageDirectory, { recursive: true });
      writeFileSync(join(packageDirectory, "package.json"), JSON.stringify({ name: "typescript", version: ts.version, main: "index.js" }));
      writeFileSync(join(packageDirectory, "index.js"), "module.exports = {}\n");
      mkdirSync(join(child, "src"), { recursive: true });
      mkdirSync(join(parent, "src"), { recursive: true });
      writeFileSync(join(child, "src", "child.ts"), `/* uneffect: effect Console */\nexport function report() { console.log("verified") }\n`);
      writeFileSync(join(parent, "src", "parent.ts"), `import { report } from "../../child/dist/child.js"\n/* uneffect: effect Console */\nexport function relay() { report() }\n`);
      const compilerOptions = { composite: true, declaration: true, outDir: "dist", rootDir: "src", types: [] };
      writeFileSync(join(child, "tsconfig.json"), JSON.stringify({ compilerOptions, include: ["src/**/*.ts"] }));
      writeFileSync(join(parent, "tsconfig.json"), JSON.stringify({ compilerOptions, include: ["src/**/*.ts"], references: [{ path: "../child" }] }));
      writeFileSync(root, JSON.stringify({ files: [], references: [{ path: "./child" }, { path: "./parent" }] }));
      expect(ts.createSolutionBuilder(ts.createSolutionBuilderHost(ts.sys), [root], {}).build()).toBe(ts.ExitStatus.Success);

      const exact = await verifyUneffectProject({ projectFile: root, buildArtifacts: "require-exact" });
      expect(exact.blockers).toEqual([]);
      expect(exact.assurance).toMatchObject({ passed: true });
      expect(exact.outputIntegrity).toMatchObject({ status: "verified" });

      appendFileSync(join(child, "dist", "child.js"), `\nconsole.log("post-build behavior")\n`);
      const tampered = await verifyUneffectProject({ projectFile: root, buildArtifacts: "require-exact" });
      expect(tampered.buildArtifacts.status).toBe("fresh");
      expect(tampered.outputIntegrity).toMatchObject({ status: "mismatch" });
      expect(tampered.assurance).toMatchObject({ status: "unknown", passed: false });
      expect(tampered.blockers).toContainEqual(expect.objectContaining({
        kind: "build-output", classification: "unknown", subject: join(child, "dist", "child.js"),
        message: expect.stringContaining("runtime output content mismatch"),
      }));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);

  it("instantiates verified child-project iterator Effect parameters", async () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-project-iterator-"));
    const root = join(directory, "tsconfig.json");
    const packageDirectory = join(directory, "node_modules", "typescript");
    const aDirectory = join(directory, "packages", "a");
    const bDirectory = join(directory, "packages", "b");
    const cDirectory = join(directory, "packages", "c");
    try {
      mkdirSync(join(aDirectory, "src"), { recursive: true });
      mkdirSync(join(bDirectory, "src"), { recursive: true });
      mkdirSync(join(cDirectory, "src"), { recursive: true });
      mkdirSync(packageDirectory, { recursive: true });
      writeFileSync(join(packageDirectory, "package.json"), JSON.stringify({ name: "typescript", version: ts.version, main: "index.js" }));
      writeFileSync(join(packageDirectory, "index.js"), "module.exports = {}\n");
      writeFileSync(join(aDirectory, "src", "a.ts"), `
        /* uneffect: effect_parameter iterator extends Console | Throw<Error> */
        export function consume(iterator: Iterator<unknown>) {
          for (;;) { const step = iterator.next(); if (step.done) return }
        }
      `);
      writeFileSync(join(bDirectory, "src", "b.ts"), `
        import { consume } from "../../a/src/a.js"
        /* uneffect: effect Console | Throw<RangeError> */
        function* generate() { console.log("item"); throw new RangeError("stop") }
        /* uneffect: effect Console | Throw<RangeError> */
        export function run() { consume(generate()) }
      `);
      writeFileSync(join(aDirectory, "tsconfig.json"), JSON.stringify({
        compilerOptions: { composite: true, declaration: true, emitDeclarationOnly: true, outDir: "dist", strict: true, types: [] },
        include: ["src/**/*.ts"],
      }));
      writeFileSync(join(bDirectory, "tsconfig.json"), JSON.stringify({
        compilerOptions: { composite: true, declaration: true, emitDeclarationOnly: true, outDir: "dist", strict: true, types: [] },
        include: ["src/**/*.ts"], references: [{ path: "../a" }],
      }));
      writeFileSync(root, JSON.stringify({ files: [], references: [{ path: "./packages/a" }, { path: "./packages/b" }] }));
      expect(ts.createSolutionBuilder(ts.createSolutionBuilderHost(ts.sys), [root], {}).build()).toBe(ts.ExitStatus.Success);

      const result = await verifyUneffectProject({ projectFile: root, buildArtifacts: "require-fresh" });
      const verification = result.projects.find((item) => item.project.projectFile === join(bDirectory, "tsconfig.json"))!.verification;
      expect(verification.effects.summaries.find((item) => item.functionName === "run")).toMatchObject({
        evidence: "verified",
        effects: expect.arrayContaining([
          expect.objectContaining({ kind: "capability", name: "Console" }),
          expect.objectContaining({ kind: "throw", errorType: "RangeError" }),
        ]),
      });
      expect(result.effectComposition).toMatchObject({
        status: "verified",
        links: expect.arrayContaining([expect.objectContaining({
          kind: "function", callee: "consume", evidence: "verified",
          iteratorEffectParameters: [{ index: 0, name: "iterator", convertsThrowToRejection: false }],
        })]),
        blockers: [],
      });

      writeFileSync(join(aDirectory, "src", "a.ts"), `
        /* uneffect: effect_parameter iterator extends Console */
        export function consume(iterator: Iterator<unknown>) {
          for (;;) { const step = iterator.next(); if (step.done) return }
        }
      `);
      expect(ts.createSolutionBuilder(ts.createSolutionBuilderHost(ts.sys), [root], {}).build()).toBe(ts.ExitStatus.Success);
      const narrow = await verifyUneffectProject({ projectFile: root, buildArtifacts: "require-fresh" });
      const narrowVerification = narrow.projects.find((item) => item.project.projectFile === join(bDirectory, "tsconfig.json"))!.verification;
      expect(narrowVerification.effects.diagnostics).toContainEqual(expect.objectContaining({
        functionName: "run", effect: "Throw<RangeError>", kind: "missing",
        message: expect.stringContaining("outside its declared bound"),
      }));
      expect(narrowVerification.effects.summaries.find((item) => item.functionName === "run"))
        .toMatchObject({ evidence: "unknown" });

      writeFileSync(join(bDirectory, "src", "b.ts"), `
        import { consume } from "../../a/src/a.js"
        declare const opaque: Iterator<unknown>
        export function run() { consume(opaque) }
      `);
      expect(ts.createSolutionBuilder(ts.createSolutionBuilderHost(ts.sys), [root], {}).build()).toBe(ts.ExitStatus.Success);
      const opaque = await verifyUneffectProject({ projectFile: root, buildArtifacts: "require-fresh" });
      expect(opaque.projects.find((item) => item.project.projectFile === join(bDirectory, "tsconfig.json"))!
        .verification.effects.summaries.find((item) => item.functionName === "run")).toMatchObject({ evidence: "unknown" });

      writeFileSync(join(bDirectory, "src", "b.ts"), `
        import { consume } from "../../a/src/a.js"
        /* uneffect: effect_parameter items extends Console */
        export function forward(items: Iterator<unknown>) { consume(items) }
        export function pure() { consume([1, 2].values()) }
      `);
      expect(ts.createSolutionBuilder(ts.createSolutionBuilderHost(ts.sys), [root], {}).build()).toBe(ts.ExitStatus.Success);
      const forwarded = await verifyUneffectProject({ projectFile: root, buildArtifacts: "require-fresh" });
      const forwardedEffects = forwarded.projects.find((item) => item.project.projectFile === join(bDirectory, "tsconfig.json"))!.verification.effects;
      expect(forwardedEffects.diagnostics).toEqual([]);
      expect(forwardedEffects.summaries.find((item) => item.functionName === "forward")).toMatchObject({
        evidence: "verified",
        iteratorEffectParameters: [{ index: 0, name: "items", convertsThrowToRejection: false }],
        iteratorEffectBounds: [{ index: 0, name: "items", effects: [expect.objectContaining({ name: "Console" })] }],
      });
      expect(forwardedEffects.summaries.find((item) => item.functionName === "pure"))
        .not.toMatchObject({ evidence: "unknown" });

      writeFileSync(join(cDirectory, "src", "c.ts"), `
        import { forward } from "../../b/src/b.js"
        /* uneffect: effect Console */
        function* generate() { console.log("item") }
        /* uneffect: effect Console */
        export function run() { forward(generate()) }
      `);
      writeFileSync(join(cDirectory, "tsconfig.json"), JSON.stringify({
        compilerOptions: { composite: true, declaration: true, emitDeclarationOnly: true, outDir: "dist", strict: true, types: [] },
        include: ["src/**/*.ts"], references: [{ path: "../b" }],
      }));
      writeFileSync(root, JSON.stringify({ files: [], references: [
        { path: "./packages/a" }, { path: "./packages/b" }, { path: "./packages/c" },
      ] }));
      expect(ts.createSolutionBuilder(ts.createSolutionBuilderHost(ts.sys), [root], {}).build()).toBe(ts.ExitStatus.Success);
      const transitive = await verifyUneffectProject({ projectFile: root, buildArtifacts: "require-fresh" });
      expect(transitive.projects.find((item) => item.project.projectFile === join(cDirectory, "tsconfig.json"))!
        .verification.effects.summaries.find((item) => item.functionName === "run")).toMatchObject({
          evidence: "verified", effects: [expect.objectContaining({ kind: "capability", name: "Console" })],
        });
      expect(transitive.effectComposition.links).toEqual(expect.arrayContaining([
        expect.objectContaining({ callee: "consume", iteratorEffectParameters: [expect.objectContaining({ name: "iterator" })] }),
        expect.objectContaining({ callee: "forward", iteratorEffectParameters: [expect.objectContaining({ name: "items" })] }),
      ]));
      writeFileSync(root, JSON.stringify({ files: [], references: [{ path: "./packages/a" }, { path: "./packages/b" }] }));

      writeFileSync(join(bDirectory, "src", "b.ts"), `
        import { consume } from "../../a/src/a.js"
        /* uneffect: effect_parameter items extends Console | Throw<Error> */
        export function forward(items: Iterator<unknown>) { consume(items) }
      `);
      expect(ts.createSolutionBuilder(ts.createSolutionBuilderHost(ts.sys), [root], {}).build()).toBe(ts.ExitStatus.Success);
      const incompatible = await verifyUneffectProject({ projectFile: root, buildArtifacts: "require-fresh" });
      const incompatibleEffects = incompatible.projects.find((item) => item.project.projectFile === join(bDirectory, "tsconfig.json"))!.verification.effects;
      expect(incompatibleEffects.diagnostics).toContainEqual(expect.objectContaining({
        functionName: "forward", effect: "Throw<Error>", kind: "missing",
        message: expect.stringContaining("not compatible with forwarded constraint"),
      }));
      expect(incompatibleEffects.summaries.find((item) => item.functionName === "forward"))
        .toMatchObject({ evidence: "unknown" });

      writeFileSync(join(aDirectory, "src", "a.ts"), `
        /* uneffect: effect InvokeUserCode */
        /* uneffect: effect_parameter iterator extends Console | Throw<Error> */
        export async function consumeAll(iterator: IterableIterator<PromiseLike<unknown>>) {
          await Promise.all(iterator)
        }
      `);
      writeFileSync(join(bDirectory, "src", "b.ts"), `
        import { consumeAll } from "../../a/src/a.js"
        /* uneffect: effect Console | Throw<RangeError> */
        function* generate() { console.log("item"); throw new RangeError("stop") }
        /* uneffect: effect Console | InvokeUserCode */
        export function runAll() { return consumeAll(generate()) }
      `);
      expect(ts.createSolutionBuilder(ts.createSolutionBuilderHost(ts.sys), [root], {}).build()).toBe(ts.ExitStatus.Success);
      const promise = await verifyUneffectProject({ projectFile: root, buildArtifacts: "require-fresh" });
      const promiseEffects = promise.projects.find((item) => item.project.projectFile === join(bDirectory, "tsconfig.json"))!.verification.effects;
      expect(promiseEffects.summaries.find((item) => item.functionName === "runAll")).toMatchObject({
        evidence: "verified", effects: expect.arrayContaining([
          expect.objectContaining({ kind: "capability", name: "Console" }),
          expect.objectContaining({ kind: "capability", name: "InvokeUserCode" }),
        ]),
      });
      expect(promiseEffects.summaries.find((item) => item.functionName === "runAll")!.effects)
        .not.toContainEqual(expect.objectContaining({ kind: "throw", errorType: "RangeError" }));
      expect(promise.effectComposition.links).toContainEqual(expect.objectContaining({
        callee: "consumeAll",
        iteratorEffectParameters: [{ index: 0, name: "iterator", convertsThrowToRejection: true }],
      }));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);

  it("substitutes verified child-project Mutate regions through exact parameter and export identities", async () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-project-mutate-"));
    const root = join(directory, "tsconfig.json");
    const packageDirectory = join(directory, "node_modules", "typescript");
    const aDirectory = join(directory, "packages", "a");
    const bDirectory = join(directory, "packages", "b");
    try {
      mkdirSync(join(aDirectory, "src"), { recursive: true });
      mkdirSync(join(bDirectory, "src"), { recursive: true });
      mkdirSync(packageDirectory, { recursive: true });
      writeFileSync(join(packageDirectory, "package.json"), JSON.stringify({ name: "typescript", version: ts.version, main: "index.js" }));
      writeFileSync(join(packageDirectory, "index.js"), "module.exports = {}\n");
      writeFileSync(join(aDirectory, "src", "a.ts"), `
        export interface Box { value: number }
        /* uneffect: effect Mutate<typeof box.value> */
        export function setValue(box: Box) { box.value = 1 }
      `);
      writeFileSync(join(bDirectory, "src", "b.ts"), `
        import { setValue, type Box } from "../../a/src/a.js"
        /* uneffect: effect Mutate<typeof state.value> */
        export function update(state: Box) { setValue(state) }
      `);
      writeFileSync(join(aDirectory, "tsconfig.json"), JSON.stringify({
        compilerOptions: { composite: true, declaration: true, emitDeclarationOnly: true, outDir: "dist", strict: true, types: [] },
        include: ["src/**/*.ts"],
      }));
      writeFileSync(join(bDirectory, "tsconfig.json"), JSON.stringify({
        compilerOptions: { composite: true, declaration: true, emitDeclarationOnly: true, outDir: "dist", strict: true, types: [] },
        include: ["src/**/*.ts"], references: [{ path: "../a" }],
      }));
      writeFileSync(root, JSON.stringify({ files: [], references: [{ path: "./packages/a" }, { path: "./packages/b" }] }));
      expect(ts.createSolutionBuilder(ts.createSolutionBuilderHost(ts.sys), [root], {}).build()).toBe(ts.ExitStatus.Success);

      const result = await verifyUneffectProject({ projectFile: root, buildArtifacts: "require-fresh" });
      const update = result.projects.find((item) => item.project.projectFile === join(bDirectory, "tsconfig.json"))!
        .verification.effects.summaries.find((item) => item.functionName === "update");
      expect(update).toMatchObject({
        evidence: "verified",
        effects: [expect.objectContaining({ kind: "mutate", region: "state.value" })],
      });
      expect(result.effectComposition).toMatchObject({
        status: "verified",
        links: expect.arrayContaining([expect.objectContaining({ kind: "function", callee: "setValue", evidence: "verified", parameters: ["box"] })]),
        blockers: [],
      });

      writeFileSync(join(bDirectory, "src", "b.ts"), `
        import { setValue as apply, type Box } from "../../a/src/a.js"
        interface Parent { child: Box }
        /* uneffect: effect Mutate<typeof state.child.value> */
        export function update(state: Parent) { apply(state.child) }
      `);
      expect(ts.createSolutionBuilder(ts.createSolutionBuilderHost(ts.sys), [root], {}).build()).toBe(ts.ExitStatus.Success);
      const nested = await verifyUneffectProject({ projectFile: root, buildArtifacts: "require-fresh" });
      expect(nested.projects.find((item) => item.project.projectFile === join(bDirectory, "tsconfig.json"))!
        .verification.effects.summaries.find((item) => item.functionName === "update")).toMatchObject({
          evidence: "verified", effects: [expect.objectContaining({ kind: "mutate", region: "state.child.value" })],
        });

      writeFileSync(join(bDirectory, "src", "b.ts"), `
        import { setValue, type Box } from "../../a/src/a.js"
        declare function select(): Box
        /* uneffect: effect Mutate<typeof state.value> */
        export function update(state: Box) { setValue(select()) }
      `);
      expect(ts.createSolutionBuilder(ts.createSolutionBuilderHost(ts.sys), [root], {}).build()).toBe(ts.ExitStatus.Success);
      const unstable = await verifyUneffectProject({ projectFile: root, buildArtifacts: "require-fresh" });
      const unstableVerification = unstable.projects.find((item) => item.project.projectFile === join(bDirectory, "tsconfig.json"))!.verification;
      expect(unstableVerification.effects.summaries.find((item) => item.functionName === "update"))
        .toMatchObject({ evidence: "unknown" });
      expect(unstableVerification.effects.diagnostics).toContainEqual(expect.objectContaining({
        functionName: "update", kind: "unknown", severity: "error",
        message: expect.stringContaining("cannot instantiate Mutate<typeof box.value>"),
      }));

      writeFileSync(join(aDirectory, "src", "a.ts"), `
        export interface Box { value: number }
        /* uneffect: effect Mutate<typeof box.value> */
        export function setValue(box: Box = { value: 0 }) { box.value = 1 }
      `);
      writeFileSync(join(bDirectory, "src", "b.ts"), `
        import { setValue } from "../../a/src/a.js"
        export function update() { setValue() }
      `);
      expect(ts.createSolutionBuilder(ts.createSolutionBuilderHost(ts.sys), [root], {}).build()).toBe(ts.ExitStatus.Success);
      const omitted = await verifyUneffectProject({ projectFile: root, buildArtifacts: "require-fresh" });
      const omittedVerification = omitted.projects.find((item) => item.project.projectFile === join(bDirectory, "tsconfig.json"))!.verification;
      expect(omittedVerification.effects.summaries.find((item) => item.functionName === "update"))
        .toMatchObject({ evidence: "unknown" });
      expect(omittedVerification.effects.diagnostics).toContainEqual(expect.objectContaining({
        functionName: "update", kind: "unknown", message: expect.stringContaining("corresponding argument is missing"),
      }));

      writeFileSync(join(aDirectory, "src", "a.ts"), `
        export const shared = { value: 0 }
        /* uneffect: effect Mutate<typeof shared.value> */
        export function setShared() { shared.value = 1 }
      `);
      writeFileSync(join(bDirectory, "src", "b.ts"), `
        import { setShared, shared } from "../../a/src/a.js"
        /* uneffect: effect Mutate<typeof shared.value> */
        export function update() { setShared() }
      `);
      expect(ts.createSolutionBuilder(ts.createSolutionBuilderHost(ts.sys), [root], {}).build()).toBe(ts.ExitStatus.Success);
      const stableExport = await verifyUneffectProject({ projectFile: root, buildArtifacts: "require-fresh" });
      expect(stableExport.effectComposition).toMatchObject({
        status: "verified",
        links: expect.arrayContaining([expect.objectContaining({
          callee: "setShared", evidence: "verified",
          mutationRoots: [expect.objectContaining({ kind: "export", root: "shared", exportName: "shared" })],
        })]),
        blockers: [],
      });
      expect(stableExport.projects.find((item) => item.project.projectFile === join(bDirectory, "tsconfig.json"))!
        .verification.effects.summaries.find((item) => item.functionName === "update")).toMatchObject({
          evidence: "verified", effects: [expect.objectContaining({ kind: "mutate", region: "shared.value" })],
        });

      writeFileSync(join(bDirectory, "src", "b.ts"), `
        import * as child from "../../a/src/a.js"
        /* uneffect: effect Mutate<typeof child.shared.value> */
        export function update() { child.setShared() }
      `);
      expect(ts.createSolutionBuilder(ts.createSolutionBuilderHost(ts.sys), [root], {}).build()).toBe(ts.ExitStatus.Success);
      const namespaceExport = await verifyUneffectProject({ projectFile: root, buildArtifacts: "require-fresh" });
      expect(namespaceExport.projects.find((item) => item.project.projectFile === join(bDirectory, "tsconfig.json"))!
        .verification.effects.summaries.find((item) => item.functionName === "update")).toMatchObject({
          evidence: "verified", effects: [expect.objectContaining({ kind: "mutate", region: "child.shared.value" })],
        });

      writeFileSync(join(bDirectory, "src", "other.ts"), "export const shared = { value: 0 }\n");
      writeFileSync(join(bDirectory, "src", "b.ts"), `
        import { setShared } from "../../a/src/a.js"
        import { shared } from "./other.js"
        /* uneffect: effect Mutate<typeof shared.value> */
        export function update() { setShared() }
      `);
      expect(ts.createSolutionBuilder(ts.createSolutionBuilderHost(ts.sys), [root], {}).build()).toBe(ts.ExitStatus.Success);
      const collidingExport = await verifyUneffectProject({ projectFile: root, buildArtifacts: "require-fresh" });
      const collidingVerification = collidingExport.projects.find((item) => item.project.projectFile === join(bDirectory, "tsconfig.json"))!.verification;
      expect(collidingVerification.effects.summaries.find((item) => item.functionName === "update"))
        .toMatchObject({ evidence: "unknown" });
      expect(collidingVerification.effects.diagnostics).toContainEqual(expect.objectContaining({
        functionName: "update", kind: "unknown", message: expect.stringContaining("cannot instantiate Mutate<typeof shared.value>"),
      }));

      writeFileSync(join(bDirectory, "src", "b.ts"), `
        import { setShared } from "../../a/src/a.js"
        export function update() { setShared() }
      `);
      expect(ts.createSolutionBuilder(ts.createSolutionBuilderHost(ts.sys), [root], {}).build()).toBe(ts.ExitStatus.Success);
      const inaccessibleExport = await verifyUneffectProject({ projectFile: root, buildArtifacts: "require-fresh" });
      expect(inaccessibleExport.effectComposition).toMatchObject({
        status: "verified",
        blockers: [],
      });
      expect(inaccessibleExport.projects.find((item) => item.project.projectFile === join(bDirectory, "tsconfig.json"))!
        .verification.effects.summaries.find((item) => item.functionName === "update")).toMatchObject({ evidence: "unknown" });

      writeFileSync(join(aDirectory, "src", "state.ts"), "export const shared = { value: 0 }\n");
      writeFileSync(join(aDirectory, "src", "bridge.ts"), "export { shared } from './state.js'\n");
      writeFileSync(join(aDirectory, "src", "a.ts"), `
        /* uneffect: module_effect Mutate<typeof shared.value> */
        import { shared } from "./bridge.js"
        export { shared } from "./bridge.js"
        shared.value = 1
      `);
      writeFileSync(join(bDirectory, "src", "b.ts"), `
        /* uneffect: module_effect Mutate<typeof shared.value> */
        import { shared } from "../../a/src/a.js"
        export const value = shared.value
      `);
      expect(ts.createSolutionBuilder(ts.createSolutionBuilderHost(ts.sys), [root], {}).build()).toBe(ts.ExitStatus.Success);
      const moduleExport = await verifyUneffectProject({ projectFile: root, buildArtifacts: "require-fresh" });
      expect(moduleExport.effectComposition).toMatchObject({
        status: "verified",
        links: expect.arrayContaining([expect.objectContaining({
          kind: "module", callee: "<module>", evidence: "verified",
          mutationRoots: [expect.objectContaining({ kind: "export", root: "shared", exportName: "shared" })],
        })]),
        blockers: [],
      });
      expect(moduleExport.projects.find((item) => item.project.projectFile === join(bDirectory, "tsconfig.json"))!
        .verification.effects.summaries.find((item) => item.functionName === "<module>" && item.fileName === join(bDirectory, "src", "b.ts"))).toMatchObject({
          evidence: "verified", effects: [expect.objectContaining({ kind: "mutate", region: "shared.value" })],
        });

      writeFileSync(join(bDirectory, "src", "b.ts"), `
        /* uneffect: module_effect Mutate<typeof shared.value> */
        import "../../a/src/a.js"
        import { shared } from "./other.js"
        export const value = shared.value
      `);
      expect(ts.createSolutionBuilder(ts.createSolutionBuilderHost(ts.sys), [root], {}).build()).toBe(ts.ExitStatus.Success);
      const collidingModuleExport = await verifyUneffectProject({ projectFile: root, buildArtifacts: "require-fresh" });
      expect(collidingModuleExport.projects.find((item) => item.project.projectFile === join(bDirectory, "tsconfig.json"))!
        .verification.effects.summaries.find((item) => item.functionName === "<module>" && item.fileName === join(bDirectory, "src", "b.ts")))
        .toMatchObject({ evidence: "unknown" });

      writeFileSync(join(aDirectory, "src", "a.ts"), `
        /* uneffect: module_effect Mutate<typeof globalThis.appState.value> */
        export {}
        declare global { var appState: { value: number } }
        globalThis.appState.value = 1
      `);
      writeFileSync(join(bDirectory, "src", "b.ts"), `
        /* uneffect: module_effect Mutate<typeof globalThis.appState.value> */
        import "../../a/src/a.js"
        export const value = globalThis.appState.value
      `);
      expect(ts.createSolutionBuilder(ts.createSolutionBuilderHost(ts.sys), [root], {}).build()).toBe(ts.ExitStatus.Success);
      const ambientGlobal = await verifyUneffectProject({ projectFile: root, buildArtifacts: "require-fresh" });
      expect(ambientGlobal.effectComposition).toMatchObject({
        status: "verified",
        links: expect.arrayContaining([expect.objectContaining({
          kind: "module", evidence: "verified",
          mutationRoots: [{ kind: "ambient", root: "globalThis", identity: "ecmascript:realm.globalThis" }],
        })]),
        blockers: [],
      });
      expect(ambientGlobal.projects.find((item) => item.project.projectFile === join(bDirectory, "tsconfig.json"))!
        .verification.effects.summaries.find((item) => item.functionName === "<module>" && item.fileName === join(bDirectory, "src", "b.ts")))
        .toMatchObject({ evidence: "verified", effects: [expect.objectContaining({ kind: "mutate", region: "globalThis.appState.value" })] });

      writeFileSync(join(aDirectory, "src", "a.ts"), `
        export {}
        declare global { var appState: { value: number } }
        /* uneffect: effect Mutate<typeof globalThis.appState.value> */
        export function setGlobal() { globalThis.appState.value = 1 }
      `);
      writeFileSync(join(bDirectory, "src", "b.ts"), `
        import { setGlobal } from "../../a/src/a.js"
        /* uneffect: effect Mutate<typeof globalThis.appState.value> */
        export function update() { setGlobal() }
      `);
      expect(ts.createSolutionBuilder(ts.createSolutionBuilderHost(ts.sys), [root], {}).build()).toBe(ts.ExitStatus.Success);
      const ambientFunction = await verifyUneffectProject({ projectFile: root, buildArtifacts: "require-fresh" });
      expect(ambientFunction.effectComposition).toMatchObject({
        status: "verified",
        links: expect.arrayContaining([expect.objectContaining({
          kind: "function", callee: "setGlobal", evidence: "verified",
          mutationRoots: [{ kind: "ambient", root: "globalThis", identity: "ecmascript:realm.globalThis" }],
        })]),
      });
      expect(ambientFunction.projects.find((item) => item.project.projectFile === join(bDirectory, "tsconfig.json"))!
        .verification.effects.summaries.find((item) => item.functionName === "update"))
        .toMatchObject({ evidence: "verified", effects: [expect.objectContaining({ kind: "mutate", region: "globalThis.appState.value" })] });

      writeFileSync(join(aDirectory, "src", "a.ts"), `
        /* uneffect: module_effect Mutate<typeof window.appState.value> */
        export {}
        declare global { interface Window { appState: { value: number } } }
        window.appState.value = 1
      `);
      writeFileSync(join(bDirectory, "src", "b.ts"), `
        /* uneffect: module_effect Mutate<typeof window.appState.value> */
        import "../../a/src/a.js"
        export const value = window.appState.value
      `);
      expect(ts.createSolutionBuilder(ts.createSolutionBuilderHost(ts.sys), [root], {}).build()).toBe(ts.ExitStatus.Success);
      const hostGlobal = await verifyUneffectProject({ projectFile: root, buildArtifacts: "require-fresh" });
      expect(hostGlobal.effectComposition).toMatchObject({
        status: "unknown",
        blockers: [expect.objectContaining({ message: expect.stringContaining("root window is not a stable export") })],
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, ciMeasuredNativeProjectTimeoutMs);

  it("makes module-order verification an explicit project assurance domain", async () => {
    const root = join(process.cwd(), "virtual-module-order");
    const dependency = join(root, "dependency.mts"), entry = join(root, "entry.mts");
    const verified = await verifyUneffectProject({
      files: {
        [dependency]: "export const value = await Promise.resolve(1)",
        [entry]: 'import { value } from "./dependency.mjs"; console.log(value)',
      },
      moduleInitializationEntry: entry,
    });
    expect(verified.moduleInitialization).toMatchObject({ evidence: "verified", entryFile: entry });
    expect(verified.assurance.blockers.filter((item) => item.domain === "module-initialization")).toEqual([]);
    expect(verified.moduleInitialization?.claims).toContain("represented module events follow source order on the normal-completion path");
    expect(verified.assurance).toMatchObject({ passed: false, claims: [] });
    expect(verified.assurance.blockers).toContainEqual(expect.objectContaining({
      domain: "effect", subject: "<module>", message: expect.stringContaining("unresolved-call"),
    }));

    const unknown = await verifyUneffectProject({
      files: { [entry]: 'import "node:path"; export const ready = true' },
      moduleInitializationEntry: entry,
    });
    expect(unknown.moduleInitialization).toMatchObject({ evidence: "unknown" });
    expect(unknown.assurance).toMatchObject({ status: "unknown", passed: false, claims: [] });
    expect(unknown.assurance.blockers).toContainEqual(expect.objectContaining({
      domain: "module-initialization", subject: "external-static-import",
    }));
  });

  it("rejects a manually claimed verified external iterator contract with missing bounds", () => {
    const { program, source } = programOf(`
      declare function consume(iterator: Iterator<unknown>): void
      /* uneffect: effect Console */
      function* generate() { console.log("item") }
      /* uneffect: effect Console */
      export function run() { consume(generate()) }
    `);
    const declaration = source.statements.find((statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === "consume")!;
    const key = `${source.fileName}:${declaration.getStart(source)}`;
    const result = analyzeProgramEffects(program, { externalFunctionEffects: new Map([[key, {
      effects: [], evidence: "verified" as const, functionName: "consume",
      iteratorEffectParameters: [{ index: 0, name: "iterator", convertsThrowToRejection: false }],
    }]]) });

    expect(result.summaries.find((summary) => summary.functionName === "run")).toMatchObject({ evidence: "unknown" });
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      functionName: "run", kind: "unknown", severity: "error",
      message: expect.stringContaining("missing a verified bound"),
    }));
  });

  it("binds persisted evidence to the caller-owned builtin registry", () => {
    const { program, source } = programOf("export function identity(value: number) { return value }");
    const summaries = analyzeEffectSummariesInProgram(program, source).summaries;
    const custom = extendBuiltinContractRegistry(builtinContractRegistry, {
      moduleInitializations: [{
        module: "node:path", runtime: { kind: "node", major: 24 }, effects: ["Console"], evidence: "trusted",
        trustReason: "application review", trustOwner: "platform-team",
      }],
    });
    const artifact = createEvidenceArtifact(program, source, summaries, custom);

    expect(artifact.builtinContractDigest).toBe(builtinContractDigest(custom));
    expect(artifact.builtinContractDigest).not.toBe(builtinContractDigest());
    expect(validateEvidenceArtifact(program, source, summaries, artifact, custom)).toEqual({ valid: true, reasons: [] });
    expect(validateEvidenceArtifact(program, source, summaries, artifact, builtinContractRegistry)).toEqual({
      valid: false, reasons: ["builtin-contract-mismatch"],
    });
  });

  it("rejects a vacuous project verification result", async () => {
    const result = await verifyUneffectProject({ files: {} });
    expect(result.assurance).toMatchObject({ status: "unknown", passed: false, coverage: { checkedFiles: 0 } });
    expect(result.assurance.blockers).toContainEqual(expect.objectContaining({
      domain: "coverage", classification: "unknown", fileName: "<project>", subject: "<coverage>",
    }));
  });

  it("applies one explicit Z3 policy to integrated contract and typed-array verification", async () => {
    const result = await verifyUneffectProject({
      files: { "src/contract.ts": `
        type Nat = number
        /* uneffect: requires value >= 0 */
        /* uneffect: ensures result >= 0 */
        export function identity(value: Nat): Nat { return value }
      `, "src/typed-array.ts": `
        type Nat = number
        /* uneffect: requires value * 2 <= 255 */
        export function write(bytes: Uint8Array, value: Nat) { bytes[0] = value }
      ` },
      z3: { preference: "native", nativeExecutable: "/uneffect/missing/integrated-z3" },
    });
    expect(result.obligations).toContainEqual(expect.objectContaining({ result: "unknown" }));
    expect(result.typedArrays.obligations).toContainEqual(expect.objectContaining({
      functionName: "write", kind: "u8-write", result: "unknown",
    }));
  });

  it("distinguishes verified evidence from accepted assumptions", async () => {
    const verified = await verifyUneffectProject({ files: {
      "src/pure.ts": `export function identity(value: number) { return value }`,
    } });
    expect(verified.assurance).toMatchObject({ status: "verified", passed: true });

    const assumed = await verifyUneffectProject({ files: {
      "src/report.ts": `export function report() { console.log("ok") }`,
    } });
    expect(assumed.assumptions.entries).not.toHaveLength(0);
    expect(assumed.assurance).toMatchObject({ status: "assumed", passed: true });
    expect(assumed.assurance.assumptions).toBe(assumed.assumptions.entries.length);
  });

  it("does not turn an unknown capability scope into project assurance", async () => {
    const result = await verifyUneffectProject({ files: {
      "src/client.ts": `export async function send(url: string) { await fetch(url, { method: "POST" }) }`,
    } });
    expect(result.effects.summaries.find((item) => item.functionName === "send")?.effects)
      .toEqual(expect.arrayContaining([expect.objectContaining({ name: "Fetch" })]));
    expect(result.assurance).toMatchObject({ status: "unknown", passed: false });
    expect(result.assurance.blockers).toContainEqual(expect.objectContaining({
      domain: "effect", classification: "unknown", subject: "send",
    }));
  });

  it("records reviewed external module initialization as an assumption", async () => {
    const fileName = "src/node-module.ts";
    const result = await verifyUneffectProject({ files: {
      [fileName]: `import "node:path"; export const loaded = true`,
    } });

    expect(result.effects.summaries.find((item) => item.functionName === "<module>"))
      .toMatchObject({ evidence: "trusted" });
    expect(result.assumptions.entries).toContainEqual(expect.objectContaining({
      domain: "module-initialization",
      dependency: { module: "node:path", nodeMajor: 24 },
      scope: expect.objectContaining({ fileName }),
    }));
    expect(result.assurance).toMatchObject({ status: "assumed", passed: true });
  });

  it("uses one caller-owned registry for module effects and the assumption ledger", async () => {
    const registry = (nodeMajor: number): BuiltinContractRegistry => extendBuiltinContractRegistry(builtinContractRegistry, {
      moduleInitializations: [{
        module: "node:path", runtime: { kind: "node", major: nodeMajor }, effects: ["Console"], evidence: "trusted",
        trustReason: "application review of path initialization", trustOwner: "platform-team",
        trustExpiresOn: "2027-01-01",
      }],
    });
    const files = { "src/custom-module.ts": 'import "node:path"; export const loaded = true' };

    const matched = await verifyUneffectProject({ files, builtinRegistry: registry(24) });
    expect(matched.effects.summaries.find((item) => item.functionName === "<module>"))
      .toMatchObject({ evidence: "trusted", effects: [expect.objectContaining({ kind: "capability", name: "Console" })] });
    expect(matched.assumptions.entries).toContainEqual(expect.objectContaining({
      reason: "application review of path initialization", owner: "platform-team", expiresOn: "2027-01-01",
      dependency: { module: "node:path", nodeMajor: 24 },
    }));

    const drifted = await verifyUneffectProject({ files, builtinRegistry: registry(23) });
    expect(drifted.effects.summaries.find((item) => item.functionName === "<module>"))
      .toMatchObject({ evidence: "unknown" });
    expect(drifted.assumptions.entries).toEqual([]);
    expect(drifted.assurance).toMatchObject({ status: "unknown", passed: false });
  });

  it("makes runtime instrumentation failures project assurance blockers", async () => {
    const fileName = "src/runtime-boundary.ts";
    const result = await verifyUneffectProject({ runtimeAssertions: "fallback", files: { [fileName]: `
      /* uneffect: assert missing: Nat */
      export function parse(value: number) { return value }
    ` } });
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ kind: "unknown-parameter", parameter: "missing" }));
    expect(result.assurance).toMatchObject({ status: "unknown", passed: false });
    expect(result.assurance.blockers).toContainEqual(expect.objectContaining({
      domain: "instrument", classification: "unknown", fileName, subject: "missing",
    }));
  });

  it("does not issue project-level proof evidence for an ill-typed source", async () => {
    const fileName = "src/invalid-project.ts";
    const result = await verifyUneffectProject({ temporalRuntime: "web", files: { [fileName]: `
      const broken: number = "not-a-number"
      type BoundedUint8Array<N extends number> = Uint8Array
      function writeTag(output: BoundedUint8Array<1>) { output[0] = 7 }
      /* uneffect: ensures result === value */
      export function identity(value: number): number { return value }
    ` } });

    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      domain: "typescript", kind: "semantic", fileName, severity: "error",
    }));
    expect(result.effects.summaries.filter((summary) => summary.fileName === fileName))
      .toEqual(expect.arrayContaining([expect.objectContaining({ evidence: "unknown" })]));
    expect(result.obligations).not.toContainEqual(expect.objectContaining({ result: "verified" }));
    expect(result.typedArrays.obligations.length).toBeGreaterThan(0);
    expect(result.typedArrays.obligations).not.toContainEqual(expect.objectContaining({ result: "verified" }));
    expect(result.temporal?.properties).toEqual(expect.arrayContaining([
      expect.objectContaining({ fileName, name: "eventLoopSafe", result: "error", output: expect.stringContaining("TypeScript errors") }),
    ]));
    expect(result.assurance).toMatchObject({ status: "violated", passed: false, coverage: { checkedFiles: 1 } });
    expect(result.assurance.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ domain: "typescript", fileName }),
      expect.objectContaining({ domain: "contract", fileName }),
      expect.objectContaining({ domain: "typed-array", fileName }),
      expect.objectContaining({ domain: "temporal", fileName }),
    ]));
  });

  it("attaches evidence to every summary and binds reproducibility inputs", () => {
    const { program, source } = programOf(`
      /* uneffect: effect Console */ function checked() { console.log("x") }
      function inferred() { console.log("x") }
      /* uneffect: effect Console */ function unknown() { fetch("https://example.com") }
    `);
    const result = analyzeEffectSummariesInProgram(program, source);
    const artifact = createEvidenceArtifact(program, source, result.summaries, builtinContractRegistry);
    expect(artifact.uneffectVersion).toBe((JSON.parse(readFileSync("package.json", "utf8")) as { version: string }).version);
    expect(artifact.summaries.filter((item) => item.functionName !== "<module>").map((item) => item.evidence))
      .toEqual(["verified", "inferred", "unknown"]);
    expect(artifact).toMatchObject({
      schemaVersion: 3, sourceFile: source.fileName,
      compilerRevision: expect.any(String), tsconfigHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      sourceHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      sourceHashes: { [source.fileName]: expect.stringMatching(/^[a-f0-9]{64}$/) },
      builtinContractDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(artifact.summaries).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: expect.any(String), fileName: source.fileName, span: expect.any(Object) }),
    ]));
  });

  it("preserves polymorphic iterator contracts and bounds in evidence artifacts", () => {
    const { program, source } = programOf(`
      /* uneffect: effect Console */ function* generate() { console.log("step"); yield 1 }
      /* uneffect: effect_parameter iterator extends Console */
      function consume(iterator: IteratorObject<unknown>) { iterator.next() }
      /* uneffect: effect Console */ function main() { consume(generate()) }
    `);
    const artifact = createEvidenceArtifact(program, source, analyzeEffectSummariesInProgram(program, source).summaries, builtinContractRegistry);
    expect(artifact.summaries.find((summary) => summary.functionName === "consume")).toMatchObject({
      evidence: "verified",
      iteratorEffectParameters: [{ index: 0, name: "iterator", convertsThrowToRejection: false }],
      iteratorEffectBounds: [{ index: 0, name: "iterator", effects: ["Console"] }],
    });
  });

  it("changes evidence inputs when any analyzed Program source changes", () => {
    const root = "/virtual/root.ts", dependency = "/virtual/dependency.ts";
    const build = (dependencyText: string) => {
      const files = new Map([[root, `export const root = 1`], [dependency, dependencyText]]);
      const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2024, noEmit: true };
      const host = ts.createCompilerHost(options), original = host.getSourceFile.bind(host);
      host.getSourceFile = (name, language, onError, fresh) => files.has(name)
        ? ts.createSourceFile(name, files.get(name)!, language, true) : original(name, language, onError, fresh);
      const program = ts.createProgram([...files.keys()], options, host), source = program.getSourceFile(root)!;
      return { program, source, artifact: createEvidenceArtifact(program, source, [], builtinContractRegistry) };
    };
    const before = build(`export const dependency = 1`), after = build(`export const dependency = 2`);
    expect(before.artifact.sourceHash).toBe(after.artifact.sourceHash);
    expect(before.artifact.sourceHashes[root]).toBe(after.artifact.sourceHashes[root]);
    expect(before.artifact.sourceHashes[dependency]).not.toBe(after.artifact.sourceHashes[dependency]);
    expect(validateEvidenceArtifact(after.program, after.source, [], before.artifact, builtinContractRegistry)).toMatchObject({
      valid: false, reasons: expect.arrayContaining(["source-hashes-mismatch"]),
    });
    const reordered = { ...after.artifact, sourceHashes: Object.fromEntries(Object.entries(after.artifact.sourceHashes).reverse()) };
    expect(validateEvidenceArtifact(after.program, after.source, [], reordered, builtinContractRegistry)).toEqual({ valid: true, reasons: [] });
  });

  it("validates effect evidence against every regenerated dependency and summary", () => {
    const { program, source } = programOf(`
      /* uneffect: effect Console */ function report() { console.log("ok") }
    `);
    const summaries = analyzeEffectSummariesInProgram(program, source).summaries;
    const artifact = createEvidenceArtifact(program, source, summaries, builtinContractRegistry);
    expect(validateEvidenceArtifact(program, source, summaries, artifact, builtinContractRegistry)).toEqual({ valid: true, reasons: [] });

    const tamperedSummary = structuredClone(artifact);
    tamperedSummary.summaries[0]!.effects = [];
    expect(validateEvidenceArtifact(program, source, summaries, tamperedSummary, builtinContractRegistry)).toMatchObject({
      valid: false, reasons: expect.arrayContaining(["summary-mismatch"]),
    });

    const partialSources = structuredClone(artifact);
    partialSources.sourceHashes = {};
    expect(validateEvidenceArtifact(program, source, summaries, partialSources, builtinContractRegistry)).toMatchObject({
      valid: false, reasons: expect.arrayContaining(["source-hashes-mismatch"]),
    });

    expect(validateEvidenceArtifact(program, source, summaries, { ...artifact, compilerRevision: "stale" }, builtinContractRegistry)).toMatchObject({
      valid: false, reasons: expect.arrayContaining(["compiler-revision-mismatch"]),
    });
    expect(validateEvidenceArtifact(program, source, summaries, { ...artifact, builtinContractDigest: "modified" }, builtinContractRegistry)).toMatchObject({
      valid: false, reasons: expect.arrayContaining(["builtin-contract-mismatch"]),
    });
    expect(validateEvidenceArtifact(program, source, summaries, null, builtinContractRegistry)).toEqual({ valid: false, reasons: ["invalid-artifact"] });

    expect(validateEvidenceArtifact(program, source, summaries, { ...artifact, schemaVersion: 2 }, builtinContractRegistry)).toMatchObject({
      valid: false, reasons: expect.arrayContaining(["schema-mismatch"]),
    });
    expect(() => createEvidenceArtifact(program, source, [{ functionName: "manual", effects: [], evidence: "verified" }], builtinContractRegistry))
      .toThrow(/source identity/);
  });

  it("separates fresh evidence inventory from proof eligibility", () => {
    const located = { id: "safe.ts:0", fileName: "safe.ts", span: { start: 0, end: 10 }, functionName: "safe", effects: [] };
    expect(assessEvidenceArtifactEligibility({ summaries: [{ ...located, evidence: "verified" }] })).toEqual({
      eligible: true, vacuous: false, blockers: [],
    });
    for (const evidence of ["inferred", "trusted", "unknown"] as const) {
      expect(assessEvidenceArtifactEligibility({ summaries: [{ ...located, evidence }] })).toMatchObject({
        eligible: false, blockers: [expect.objectContaining({ summaryId: located.id, reason: evidence })],
      });
    }
    expect(assessEvidenceArtifactEligibility({ summaries: [] })).toEqual({
      eligible: false, vacuous: true, blockers: [{ reason: "vacuous", summaryId: "<artifact>" }],
    });
    expect(assessEvidenceArtifactEligibility({ summaries: [{
      ...located, evidence: "verified", iteratorEffectParameters: [{ index: 0, name: "items", convertsThrowToRejection: false }],
    }] })).toMatchObject({
      eligible: false, blockers: [expect.objectContaining({ reason: "open-iterator-effect" })],
    });
    expect(assessEvidenceArtifactEligibility({ summaries: [
      { ...located, evidence: "verified" }, { ...located, functionName: "duplicate", evidence: "verified" },
    ] })).toMatchObject({
      eligible: false, blockers: [expect.objectContaining({ reason: "duplicate-summary-id" })],
    });
    expect(assessEvidenceArtifactEligibility({ summaries: [{
      ...located, effects: ["Fetch<POST, Unknown<dynamic-url>>"], evidence: "verified",
    }] })).toMatchObject({
      eligible: false, blockers: [expect.objectContaining({ reason: "unknown-capability-scope" })],
    });
  });

  it("allows stable-read reuse only with proof-grade evidence and no invalidation", () => {
    const base = { schema: "stable-read-reuse/v1" as const, region: "state.value", firstRead: 0, reuseAt: 2, evidence: "verified" as const };
    expect(evaluateStableReadReuse({ ...base, events: [{ kind: "read", region: "state.value" }, { kind: "read", region: "other" }, { kind: "read", region: "state.value" }] }).allowed).toBe(true);
    expect(evaluateStableReadReuse({ ...base, events: [{ kind: "read" }, { kind: "mutate", region: "state" }, { kind: "read" }] }).allowed).toBe(false);
    expect(evaluateStableReadReuse({ ...base, evidence: "unknown", events: [{ kind: "read" }, { kind: "read" }, { kind: "read" }] }).allowed).toBe(false);
    expect(evaluateStableReadReuse({ ...base, evidence: "trusted", events: [{ kind: "read" }, { kind: "read" }, { kind: "read" }] })).toMatchObject({
      allowed: false, reason: expect.stringContaining("trusted evidence cannot authorize"),
    });
    const source = "const cached = state.value; use(state.value)";
    const start = source.lastIndexOf("state.value");
    expect(applyStableReadReuse(source, { ...base, events: [{ kind: "read" }, { kind: "read", region: "other" }, { kind: "read" }] }, { start, end: start + "state.value".length }, "cached").code)
      .toBe("const cached = state.value; use(cached)");
    expect(applyStableReadReuse(source, { ...base, evidence: "unknown", events: [{ kind: "read" }, { kind: "read" }, { kind: "read" }] }, { start, end: start + 11 }, "cached").code).toBe(source);
  });

  it("keeps property mangling behind a separate closed-world obligation", () => {
    const safe = { schema: "property-mangle/v1" as const, property: "internal", evidence: "verified" as const, closedWorld: true, reflection: false, escaped: false };
    expect(evaluatePropertyMangle(safe).allowed).toBe(true);
    expect(evaluatePropertyMangle({ ...safe, reflection: true }).allowed).toBe(false);
    expect(evaluatePropertyMangle({ ...safe, closedWorld: false }).allowed).toBe(false);
    expect(evaluatePropertyMangle({ ...safe, evidence: "trusted" })).toMatchObject({
      allowed: false, reason: expect.stringContaining("trusted evidence cannot authorize"),
    });
  });

  it("binds ownership proof evidence to the obligation, verifier program, and Z3 version", async () => {
    const obligation: OwnershipGuardObligation = { owner: "run", callee: "consume", ownership: "promise", parameter: 1, assumptions: ["enabled && active"], goal: "enabled && active", status: "verified", evidence: "finite-propositional", span: { start: 10, end: 20 } };
    const artifact = await verifyOwnershipObligationWithZ3(obligation);
    expect(artifact).toMatchObject({ schema: "ownership-evidence/v2", backend: "z3", result: "verified", evidence: "verified", exitCode: 0 });
    if (artifact.backend !== "z3") throw new Error("Z3 verifier returned non-Z3 evidence");
    expect(artifact.backendVersion).toMatch(/^Z3 (?:version )?\d+\./u);
    expect(artifact.backendRuntime).toMatch(/^(?:native|wasm)$/u);
    expect(artifact.backendAttempts?.at(-1)).toMatchObject({ backend: artifact.backendRuntime, status: "unsat" });
    expect(artifact.obligationHash).toMatch(/^[a-f0-9]{64}$/);
    expect(artifact.verifierProgramHash).toMatch(/^[a-f0-9]{64}$/);
    expect(validateOwnershipEvidence(artifact, obligation)).toBe(true);
    expect(validateOwnershipEvidence({ ...artifact, verifierProgramHash: "0".repeat(64) }, obligation)).toBe(false);
    const otherRuntime: "native" | "wasm" = artifact.backendRuntime === "native" ? "wasm" : "native";
    expect(validateOwnershipEvidence({ ...artifact, backendRuntime: otherRuntime }, obligation)).toBe(false);
    expect(validateOwnershipEvidence({ ...artifact, backendAttempts: [] }, obligation)).toBe(false);
    expect(validateOwnershipEvidence({ ...artifact, backendAttempts: [{ ...artifact.backendAttempts[0]!, status: "sat" as const }] }, obligation)).toBe(false);
    expect(validateOwnershipEvidence({ ...artifact, backendAttempts: artifact.backendAttempts.map((attempt, index) => index === artifact.backendAttempts.length - 1 ? { ...attempt, exitCode: 1 } : attempt) }, obligation)).toBe(false);
    expect(validateOwnershipEvidence({ ...artifact, stdout: "unsat\n; modified" }, obligation)).toBe(false);
    expect(validateOwnershipEvidence(artifact, { ...obligation, goal: "enabled" })).toBe(false);
    const quintArtifact = verifyOwnershipObligationWithQuint(obligation);
    expect(quintArtifact).toMatchObject({ backend: "quint", backendVersion: expect.stringMatching(/^0\.32\.0/) });
    expect(validateOwnershipEvidence(quintArtifact, obligation)).toBe(quintArtifact.result === "verified");
    if (quintArtifact.result !== "verified") expect(quintArtifact.evidence).toBe("unknown");

    const optimization = { schema: "ownership-guard-elision/v1" as const, ownership: obligation, artifact, generatedAssertion: true as const };
    expect(evaluateOwnershipGuardElision(optimization).allowed).toBe(true);
    const source = "work();uneffectAssertOwnership(token);done()";
    const start = source.indexOf("uneffectAssertOwnership");
    expect(applyOwnershipAssertionElision(source, optimization, { start, end: source.indexOf(";done") + 1 }).code).toBe("work();done()");
    expect(applyOwnershipAssertionElision(source, { ...optimization, artifact: { ...artifact, result: "unknown", evidence: "unknown" } }, { start, end: source.indexOf(";done") + 1 }).code).toBe(source);
    expect(evaluateOwnershipGuardElision({ ...optimization, generatedAssertion: false }).allowed).toBe(false);
  });

  it("emits a cross-domain assumption ledger and enforces owner/expiration CI policy", async () => {
    const fileName = "src/trusted-boundary.ts";
    const source = `
      type BoundedUint8Array<N extends number> = Uint8Array
      /* uneffect: trust typed-array validated by the wire-format review */
      /* uneffect: trust_owner binary-platform */
      /* uneffect: trust_expires 2027-01-31 */
      function decode(output: BoundedUint8Array<1>, value: number) {
        output[0] = value
        console.log("decoded")
      }
      /* uneffect: temporal_ensures ready' = true */
      /* uneffect: temporal_modifies ready */
      /* uneffect: trust_owner runtime-team */
      /* uneffect: trust_expires 2026-12-31 */
      function start() {}
      /* uneffect: trust dispatch-sealing application owns the complete class graph */
      /* uneffect: trust_owner runtime-team */
      /* uneffect: trust_expires 2027-02-28 */
      export class Runtime { run() {} }
    `;
    const result = await verifyUneffectProject({
      files: { [fileName]: source },
      assumptionPolicy: {
        requireOwner: true,
        requireExpiration: true,
        allowUnboundedDomains: ["builtin"],
        asOf: "2026-08-21",
      },
    });
    expect(result.assumptions.schema).toBe("uneffect-assumptions/v1");
    expect(result.assumptions.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ domain: "typed-array", reason: "validated by the wire-format review", owner: "binary-platform", expiresOn: "2027-01-31", scope: expect.objectContaining({ fileName, functionName: "decode", span: expect.any(Object) }) }),
      expect.objectContaining({ domain: "builtin", reason: "reviewed Console log semantic overlay", owner: "@mizchi/uneffect", scope: expect.objectContaining({ fileName, span: expect.any(Object) }) }),
      expect.objectContaining({ domain: "temporal-summary", owner: "runtime-team", expiresOn: "2026-12-31", scope: expect.objectContaining({ functionName: "start" }) }),
      expect.objectContaining({ domain: "dispatch-sealing", reason: "application owns the complete class graph", owner: "runtime-team", expiresOn: "2027-02-28", scope: expect.objectContaining({ fileName, span: expect.any(Object) }) }),
    ]));
    expect(result.assumptions.violations).toEqual([]);
    expect(result.assurance).toMatchObject({ passed: true, blockers: [] });

    const missingOwner = await verifyUneffectProject({
      files: { [fileName]: source.replace("/* uneffect: trust_owner binary-platform */", "") },
      assumptionPolicy: { requireOwner: true, asOf: "2026-08-21" },
    });
    expect(missingOwner.assumptions.violations).toContainEqual(expect.objectContaining({ rule: "owner-required", domain: "typed-array" }));
    expect(missingOwner.assurance).toMatchObject({ passed: false });
    expect(missingOwner.assurance.blockers).toContainEqual(expect.objectContaining({ domain: "assumption", fileName }));
    expect(missingOwner.diagnostics).toContainEqual(expect.objectContaining({ kind: "assumption-policy", rule: "owner-required" }));

    const missingDispatchOwner = await verifyUneffectProject({
      files: { [fileName]: source.replaceAll("/* uneffect: trust_owner runtime-team */", "") },
      assumptionPolicy: { requireOwner: true, asOf: "2026-08-21" },
    });
    expect(missingDispatchOwner.assumptions.violations).toEqual(expect.arrayContaining([
      expect.objectContaining({ rule: "owner-required", domain: "temporal-summary" }),
      expect.objectContaining({ rule: "owner-required", domain: "dispatch-sealing" }),
    ]));

    const expired = await verifyUneffectProject({
      files: { [fileName]: source },
      assumptionPolicy: { denyExpired: true, asOf: "2028-01-01" },
    });
    expect(expired.assumptions.violations).toEqual(expect.arrayContaining([
      expect.objectContaining({ rule: "expired", domain: "typed-array" }),
      expect.objectContaining({ rule: "expired", domain: "temporal-summary" }),
      expect.objectContaining({ rule: "expired", domain: "dispatch-sealing" }),
    ]));
  });

  it("attributes statement-scoped trust metadata to its exact ledger span", async () => {
    const fileName = "src/local-trust.ts";
    const source = `
      type BoundedUint8Array<N extends number> = Uint8Array
      function encode(output: BoundedUint8Array<2>, value: number) {
        /* uneffect: trust typed-array:u8-write reviewed packet tag */
        /* uneffect: trust_owner wire-team */
        /* uneffect: trust_expires 2027-04-01 */
        output[0] = value
        output[1] = value
      }
    `;
    const result = await verifyUneffectProject({
      files: { [fileName]: source },
      assumptionPolicy: { requireOwner: true, requireExpiration: true, asOf: "2026-08-21" },
    });
    expect(result.assumptions.entries).toEqual([
      expect.objectContaining({ domain: "typed-array", reason: "reviewed packet tag", owner: "wire-team", expiresOn: "2027-04-01" }),
    ]);
    const [assumption] = result.assumptions.entries;
    expect(source.slice(assumption!.scope.span.start, assumption!.scope.span.end)).toContain("output[0] = value");
    expect(result.assumptions.violations).toEqual([]);
    const [diagnostic] = result.typedArrays.diagnostics;
    expect(diagnostic).toEqual(expect.objectContaining({ kind: "u8-write", functionName: "encode" }));
    expect(source.slice(diagnostic!.span.start, diagnostic!.span.end)).toContain("output[1] = value");
  });
});
