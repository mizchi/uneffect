import ts from "typescript";
import { afterAll, beforeAll, bench, describe } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTypeScriptWorkspace, type TypeScriptProject } from "../src/typescript-project.js";
import { inspectDeclarationOutputs } from "../src/workspace-effects.js";
import {
  composeWorkspaceModuleInitialization,
  type CompletedModuleInitializationProject,
} from "../src/workspace-module-initialization.js";

let directory = "";
let entryFile = "";
let parent!: TypeScriptProject;
let parentProgram!: ts.Program;
let completed!: CompletedModuleInitializationProject[];

function json(fileName: string, value: unknown): void {
  writeFileSync(fileName, `${JSON.stringify(value)}\n`);
}

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), "uneffect-workspace-module-bench-"));
  const childDirectory = join(directory, "child"), parentDirectory = join(directory, "parent");
  mkdirSync(join(directory, "node_modules", "typescript"), { recursive: true });
  mkdirSync(join(childDirectory, "src"), { recursive: true });
  mkdirSync(join(parentDirectory, "src"), { recursive: true });
  json(join(directory, "node_modules", "typescript", "package.json"), { name: "typescript", version: ts.version, main: "index.js" });
  writeFileSync(join(directory, "node_modules", "typescript", "index.js"), "module.exports = {}\n");
  const childFile = join(childDirectory, "src", "child.mts");
  entryFile = join(parentDirectory, "src", "parent.mts");
  writeFileSync(childFile, "export const ready = await Promise.resolve(1)\n");
  writeFileSync(entryFile, 'import { ready } from "../../child/src/child.mjs"\nexport const observed = ready\n');
  const compilerOptions = {
    composite: true, declaration: true, rootDir: "src", outDir: "dist",
    module: "NodeNext", moduleResolution: "NodeNext", target: "ES2022", strict: true, types: [],
  };
  json(join(childDirectory, "tsconfig.json"), { compilerOptions, include: ["src/**/*.mts"] });
  json(join(parentDirectory, "tsconfig.json"), {
    compilerOptions, include: ["src/**/*.mts"], references: [{ path: "../child" }],
  });
  const root = join(directory, "tsconfig.json");
  json(root, { files: [], references: [{ path: "./parent" }] });
  if (ts.createSolutionBuilder(ts.createSolutionBuilderHost(ts.sys), [root], {}).build() !== ts.ExitStatus.Success) {
    throw new Error("workspace module benchmark fixture did not build");
  }
  const workspace = loadTypeScriptWorkspace(root);
  const child = workspace.projects[0]!;
  parent = workspace.projects[1]!;
  const childProgram = ts.createProgram({
    rootNames: child.fileNames, options: child.compilerOptions, projectReferences: child.projectReferences,
  });
  parentProgram = ts.createProgram({
    rootNames: parent.fileNames, options: parent.compilerOptions, projectReferences: parent.projectReferences,
  });
  completed = [{ project: child, program: childProgram, declarationOutputs: inspectDeclarationOutputs(childProgram) }];
});

afterAll(() => rmSync(directory, { recursive: true, force: true }));

describe("workspace module initialization", () => {
  bench("compose a warm exact cross-project straight-line TLA dependency", () => {
    const result = composeWorkspaceModuleInitialization(parentProgram, parent, completed, entryFile);
    if (result.evidence !== "verified" || result.links.length !== 1) {
      throw new Error("workspace TLA benchmark fixture did not verify");
    }
  }, { time: 500, iterations: 20 });
});
