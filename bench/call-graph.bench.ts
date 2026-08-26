import ts from "typescript";
import { bench, describe } from "vitest";
import { buildProgramCallGraph } from "../src/call-graph.js";

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

describe("reviewed compiler callback timing", () => {
  bench("build a call graph for 32 TypeScript transformer chains", () => {
    buildProgramCallGraph(program);
  });
});
