import ts from "@typescript/typescript6";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { verifyUneffectProject } from "../src/project-verification.js";
import { runCli } from "../src/cli-runner.js";
import { exitCode, type CliStreams } from "../src/cli-support.js";

function writeJson(fileName: string, value: unknown): void {
  writeFileSync(fileName, `${JSON.stringify(value, null, 2)}\n`);
}

function capture(): CliStreams & { stdout: string; stderr: string } {
  const io = {
    stdout: "", stderr: "",
    out(text: string) { io.stdout += text; },
    err(text: string) { io.stderr += text; },
  };
  return io;
}

describe("workspace module initialization", () => {
  it("composes one straight-line top-level-await dependency across an exact project boundary", async () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-workspace-module-order-"));
    const child = join(directory, "packages", "child");
    const parent = join(directory, "packages", "parent");
    const childSource = join(child, "src", "child.mts");
    const parentSource = join(parent, "src", "parent.mts");
    const root = join(directory, "tsconfig.json");
    try {
      mkdirSync(join(directory, "node_modules", "typescript"), { recursive: true });
      mkdirSync(join(child, "src"), { recursive: true });
      mkdirSync(join(parent, "src"), { recursive: true });
      writeJson(join(directory, "node_modules", "typescript", "package.json"), {
        name: "typescript", version: ts.version, main: "index.js",
      });
      writeFileSync(join(directory, "node_modules", "typescript", "index.js"), "module.exports = {}\n");
      writeFileSync(childSource, 'export const ready = await "ready"\n');
      writeFileSync(parentSource, 'import { ready } from "../../child/src/child.mjs"\nexport const observed = ready\n');
      writeJson(join(child, "tsconfig.json"), {
        compilerOptions: {
          composite: true, declaration: true, rootDir: "src", outDir: "dist",
          module: "NodeNext", moduleResolution: "NodeNext", target: "ES2022", strict: true, types: [],
        },
        include: ["src/**/*.mts"],
      });
      writeJson(join(parent, "tsconfig.json"), {
        compilerOptions: {
          composite: true, declaration: true, rootDir: "src", outDir: "dist",
          module: "NodeNext", moduleResolution: "NodeNext", target: "ES2022", strict: true, types: [],
        },
        include: ["src/**/*.mts"], references: [{ path: "../child" }],
      });
      writeJson(root, { files: [], references: [{ path: "./packages/parent" }] });
      expect(ts.createSolutionBuilder(ts.createSolutionBuilderHost(ts.sys), [root], {}).build()).toBe(ts.ExitStatus.Success);

      const result = await verifyUneffectProject({
        projectFile: root, moduleInitializationEntry: parentSource, buildArtifacts: "require-exact",
      });
      const composition = (result as typeof result & { moduleInitializationComposition?: unknown })
        .moduleInitializationComposition as undefined | {
          schema: string;
          evidence: string;
          entryFile: string;
          domains: Array<{ projectFile: string; order: { entryFile: string; evidence: string; choices?: unknown } }>;
          links: Array<{
            importerFile: string; dependencyEntryFile: string; declarationFile: string;
            semanticRule: string; declarationIntegrity: { status: string };
          }>;
          constraints: Array<{ before: string; after: string; semanticRule: string }>;
          unknowns: unknown[];
        };
      expect(composition).toMatchObject({
        schema: "uneffect-workspace-module-order/v1", evidence: "verified", entryFile: parentSource,
        unknowns: [],
      });
      expect(JSON.parse(readFileSync("schemas/uneffect-workspace-module-order-v1.schema.json", "utf8"))).toMatchObject({
        properties: {
          schema: { const: "uneffect-workspace-module-order/v1" },
          links: { items: { $ref: "#/$defs/link" }, maxItems: 1 },
        },
        $defs: {
          domain: { properties: { order: { $ref: "./uneffect-module-order-v1.schema.json" } } },
          link: { required: expect.arrayContaining(["sourceEvidence", "declarationIntegrity", "semanticRule"]) },
        },
      });
      expect(composition?.domains).toEqual(expect.arrayContaining([
        expect.objectContaining({ projectFile: join(child, "tsconfig.json"), order: expect.objectContaining({ entryFile: childSource, evidence: "verified" }) }),
        expect.objectContaining({ projectFile: join(parent, "tsconfig.json"), order: expect.objectContaining({ entryFile: parentSource }) }),
      ]));
      expect(composition?.links).toContainEqual(expect.objectContaining({
        importerFile: parentSource, dependencyEntryFile: childSource,
        declarationFile: join(child, "dist", "child.d.mts"),
        semanticRule: "ecma262-async-module-dependency-completion",
        declarationIntegrity: expect.objectContaining({ status: "verified" }),
      }));
      expect(composition?.constraints).toContainEqual(expect.objectContaining({
        before: `${childSource}#complete`, after: `${parentSource}#start`,
        semanticRule: "ecma262-async-module-dependency-completion",
      }));
      const childOrder = composition?.domains.find((domain) => domain.order.entryFile === childSource)?.order as
        | { modules?: Array<{ choices: Array<{ alternatives: [string, string] }> }> }
        | undefined;
      expect(childOrder?.modules?.[0]?.choices[0]?.alternatives).toEqual([
        `${childSource}#resume:0`, `${childSource}#reject:0`,
      ]);
      const cli = capture();
      expect(await runCli([
        "check", "--project", root, "--module-entry", parentSource,
        "--infer", "--require-exact-build-artifacts", "--json",
      ], cli), `${cli.stdout}\n${cli.stderr}`).toBe(exitCode.success);
      expect(JSON.parse(cli.stdout)).toMatchObject({
        schema: "uneffect-workspace-check/v1", outcome: "passed",
        moduleInitializationComposition: {
          schema: "uneffect-workspace-module-order/v1", evidence: "verified",
          entryFile: parentSource,
        },
      });
      expect(JSON.parse(readFileSync("schemas/uneffect-workspace-check-v1.schema.json", "utf8"))).toMatchObject({
        properties: {
          moduleInitializationComposition: { $ref: "./uneffect-workspace-module-order-v1.schema.json" },
        },
      });

      writeFileSync(childSource, `
        declare const enabled: boolean
        export let ready = "pending"
        if (enabled) ready = await "ready"
      `);
      expect(ts.createSolutionBuilder(ts.createSolutionBuilderHost(ts.sys), [root], {}).build()).toBe(ts.ExitStatus.Success);
      const conditional = await verifyUneffectProject({
        projectFile: root, moduleInitializationEntry: parentSource, buildArtifacts: "require-exact",
      });
      expect(conditional.moduleInitializationComposition).toMatchObject({
        evidence: "unknown", claims: [], links: [], constraints: [],
        unknowns: [expect.objectContaining({
          projectFile: join(child, "tsconfig.json"), fileName: childSource,
          kind: "unsupported-child-tla-shape",
          detail: expect.stringContaining("straight-line top-level await"),
        })],
      });
      expect(conditional.assurance).toMatchObject({ status: "unknown", passed: false, claims: [] });
      expect(conditional.blockers).toContainEqual(expect.objectContaining({
        kind: "module-initialization", subject: childSource,
        message: expect.stringContaining("unsupported-child-tla-shape"),
      }));

      writeFileSync(childSource, `
        export const ready = await "ready"
        throw new Error("initialization failed")
      `);
      expect(ts.createSolutionBuilder(ts.createSolutionBuilderHost(ts.sys), [root], {}).build()).toBe(ts.ExitStatus.Success);
      const neverCompletes = await verifyUneffectProject({
        projectFile: root, moduleInitializationEntry: parentSource, buildArtifacts: "require-exact",
      });
      expect(neverCompletes.moduleInitializationComposition).toMatchObject({
        evidence: "unknown", claims: [], links: [], constraints: [],
        unknowns: [expect.objectContaining({
          kind: "unsupported-child-tla-shape", fileName: childSource,
          detail: expect.stringContaining("straight-line top-level await"),
        })],
      });

      const missingEntry = join(parent, "src", "missing.mts");
      const missing = await verifyUneffectProject({ projectFile: root, moduleInitializationEntry: missingEntry });
      expect(missing.moduleInitializationComposition).toBeUndefined();
      expect(missing.blockers).toContainEqual(expect.objectContaining({
        kind: "module-initialization", subject: missingEntry,
        message: expect.stringContaining("not selected by any loaded TypeScript project"),
      }));
      const missingCli = capture();
      expect(await runCli([
        "check", "--project", root, "--module-entry", missingEntry, "--infer", "--json",
      ], missingCli)).toBe(exitCode.failed);
      expect(JSON.parse(missingCli.stdout)).toMatchObject({
        outcome: "failed",
        blockers: expect.arrayContaining([expect.objectContaining({
          kind: "module-initialization", subject: missingEntry,
        })]),
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);
});
