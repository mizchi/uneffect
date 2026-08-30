import { bench, describe } from "vitest";
import ts from "typescript";
import { analyzeTypeScriptControlFlow, analyzeTypeScriptProgramControlFlow } from "../src/typescript-control-flow.js";

const source = `
  type Kind = "left" | "right";
  ${Array.from({ length: 8 }, (_, index) => `
    export function choose${index}(kind: Kind): number {
      switch (kind) {
        case "left": return ${index};
        case "right": return ${index + 1};
      }
    }
  `).join("\n")}
`;
const fileName = "/virtual/cfg-benchmark.ts";
const options: ts.CompilerOptions = { strict: true, noImplicitReturns: true, allowUnreachableCode: true, noEmit: true };
const host = ts.createCompilerHost(options), defaultGetSourceFile = host.getSourceFile.bind(host);
const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
host.getSourceFile = (requested, languageVersion, onError, fresh) => requested === fileName ? sourceFile : defaultGetSourceFile(requested, languageVersion, onError, fresh);
host.fileExists = (requested) => requested === fileName || ts.sys.fileExists(requested);
host.readFile = (requested) => requested === fileName ? source : ts.sys.readFile(requested);
const program = ts.createProgram({ rootNames: [fileName], options, host });

describe("TypeScript control-flow bridge", () => {
  bench("analyze a cold eight-function literal-union switch file", () => {
    const result = analyzeTypeScriptControlFlow("cfg-benchmark.ts", source);
    if (result.functions.length !== 8 || result.functions.some((item) => item.endpoint !== "unreachable")) {
      throw new Error("TypeScript CFG benchmark fixture did not refine every endpoint");
    }
  }, { time: 500, iterations: 10 });

  bench("reanalyze eight functions through one checked Program", () => {
    const result = analyzeTypeScriptProgramControlFlow(program, [sourceFile]);
    if (!result.programReused || result.functions.length !== 8 || result.functions.some((item) => item.endpoint !== "unreachable")) {
      throw new Error("reused TypeScript CFG benchmark fixture did not refine every endpoint");
    }
  });
});
