import ts from "typescript";
import { bench, describe } from "vitest";
import { buildProgramCallGraph } from "../src/call-graph.js";
import { analyzeModuleInitializationOrder } from "../src/module-initialization.js";

const fileName = "compiler-traversal.ts";
const sourceText = `
  import ts from "typescript"
  ${Array.from({ length: 32 }, (_, index) => `
    export function rewrite${index}(node: ts.Node) {
      return ts.transform(node, [
        (context) => (root) => ts.visitEachChild(root, (child) => child, context),
      ])
    }
  `).join("\n")}
`;
const options: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2024,
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  noEmit: true,
};
const host = ts.createCompilerHost(options);
const originalGetSourceFile = host.getSourceFile.bind(host);
host.getSourceFile = (name, languageVersion, onError, shouldCreateNewSourceFile) => name === fileName
  ? ts.createSourceFile(fileName, sourceText, languageVersion, true)
  : originalGetSourceFile(name, languageVersion, onError, shouldCreateNewSourceFile);
const program = ts.createProgram([fileName], options, host);
const cycleFiles = Array.from({ length: 4 }, (_, index) => `/bench/module-cycle-${index}.mts`);
const cycleSources = new Map(cycleFiles.map((name, index) => [
  name,
  `import "./module-cycle-${(index + 1) % cycleFiles.length}.mjs"; console.log(${index})`,
]));
const cycleHost = ts.createCompilerHost(options);
const originalCycleGetSourceFile = cycleHost.getSourceFile.bind(cycleHost);
cycleHost.fileExists = (name) => cycleSources.has(name) || ts.sys.fileExists(name);
cycleHost.readFile = (name) => cycleSources.get(name) ?? ts.sys.readFile(name);
cycleHost.directoryExists = (name) => name === "/bench" || ts.sys.directoryExists(name);
cycleHost.getCurrentDirectory = () => "/bench";
cycleHost.getSourceFile = (name, languageVersion, onError, shouldCreateNewSourceFile) => {
  const source = cycleSources.get(name);
  return source === undefined
    ? originalCycleGetSourceFile(name, languageVersion, onError, shouldCreateNewSourceFile)
    : ts.createSourceFile(name, source, languageVersion, true);
};
const cycleProgram = ts.createProgram(cycleFiles, options, cycleHost);
const promiseLaunchFile = "/bench/workhub-main-catch.mts";
const promiseLaunchSource = `
  async function main(): Promise<void> { await Promise.resolve() }
  main().catch((error) => { console.error(error) })
`;
const promiseLaunchHost = ts.createCompilerHost(options);
const originalPromiseLaunchGetSourceFile = promiseLaunchHost.getSourceFile.bind(promiseLaunchHost);
promiseLaunchHost.fileExists = (name) => name === promiseLaunchFile || ts.sys.fileExists(name);
promiseLaunchHost.readFile = (name) => name === promiseLaunchFile ? promiseLaunchSource : ts.sys.readFile(name);
promiseLaunchHost.getSourceFile = (name, languageVersion, onError, shouldCreateNewSourceFile) => name === promiseLaunchFile
  ? ts.createSourceFile(name, promiseLaunchSource, languageVersion, true)
  : originalPromiseLaunchGetSourceFile(name, languageVersion, onError, shouldCreateNewSourceFile);
const promiseLaunchProgram = ts.createProgram([promiseLaunchFile], options, promiseLaunchHost);

describe("reviewed compiler callback timing", () => {
  bench("build a call graph for 32 TypeScript transformer chains", () => {
    buildProgramCallGraph(program);
  });
});

describe("module initialization order", () => {
  bench("analyze a warm four-module synchronous side-effect import ring", () => {
    const result = analyzeModuleInitializationOrder(cycleProgram, cycleFiles[0]!);
    if (result.evidence !== "verified" || result.cycleComponents[0]?.executionOrder.length !== 4) {
      throw new Error("synchronous cycle benchmark fixture did not verify");
    }
  }, { time: 500, iterations: 20 });

  bench("analyze a warm Workhub-shaped top-level Promise launch", () => {
    const result = analyzeModuleInitializationOrder(promiseLaunchProgram, promiseLaunchFile);
    if (result.evidence !== "verified"
      || result.modules[0]?.events[1]?.kind !== "promise-launch"
      || result.modules[0]?.events[2]?.kind !== "rejection-handler-attach") {
      throw new Error("top-level Promise launch benchmark fixture did not verify");
    }
  }, { time: 500, iterations: 20 });
});
