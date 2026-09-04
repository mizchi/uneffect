import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import ts from "@typescript/typescript6";
import { analyzeModuleInitializationOrder } from "./module-initialization.js";
import { exitCode, formatCommandHelp, parseCommandArgs, singleFileArgument, type CliCommand } from "./cli-support.js";

export const moduleOrderCommand: CliCommand = {
  name: "module-order",
  summary: "Print the source-mapped ESM module-initialization partial-order IR.",
  arguments: "<entry.ts> [--require]",
  details: [
    "--require  exit 1 unless the extracted ordering fragment is proof-grade",
    "",
    "Unknown cycles, external/dynamic imports, conditional top-level await, or TypeScript errors remain visible in the JSON artifact.",
  ],
  async run(args, io) {
    const { values, positionals } = parseCommandArgs(args, { require: { type: "boolean" } });
    if (values.help) { io.out(formatCommandHelp(moduleOrderCommand)); return exitCode.success; }
    const entryFile = resolve(singleFileArgument(positionals, "module-order"));
    await readFile(entryFile, "utf8");
    const options: ts.CompilerOptions = {
      target: ts.ScriptTarget.ES2024,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      lib: ["lib.es2024.d.ts", "lib.dom.d.ts"],
      types: ["node"],
      noEmit: true,
    };
    const program = ts.createProgram([entryFile], options);
    const result = analyzeModuleInitializationOrder(program, entryFile);
    io.out(`${JSON.stringify(result, null, 2)}\n`);
    if (values.require && result.evidence !== "verified") {
      io.err("module initialization order is unknown:\n");
      for (const unknown of result.unknowns) io.err(`  ${unknown.kind} ${unknown.fileName}: ${unknown.detail}\n`);
      return exitCode.failed;
    }
    return exitCode.success;
  },
};
