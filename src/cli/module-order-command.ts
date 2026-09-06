import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import ts from "@typescript/typescript6";
import { analyzeModuleInitializationOrder } from "../modules/module-initialization.js";
import { CliUsageError, exitCode, formatCommandHelp, parseCommandArgs, singleFileArgument, type CliCommand } from "./cli-support.js";

export const moduleOrderCommand: CliCommand = {
  name: "module-order",
  summary: "Print the source-mapped ESM module-initialization partial-order IR.",
  arguments: "<entry.ts> [--schema-version 1|2] [--require]",
  details: [
    "--require  exit 1 unless the extracted ordering fragment is proof-grade",
    "--schema-version 1|2  artifact version (default: 1); v2 supports one bounded conditional TLA join",
    "",
    "Unsupported cycles, external/dynamic imports, control flow, or TypeScript errors remain visible in the JSON artifact.",
  ],
  async run(args, io) {
    const { values, positionals } = parseCommandArgs(args, {
      require: { type: "boolean" },
      "schema-version": { type: "string", default: "1" },
    });
    if (values.help) { io.out(formatCommandHelp(moduleOrderCommand)); return exitCode.success; }
    const schemaVersion = values["schema-version"];
    if (schemaVersion !== "1" && schemaVersion !== "2") throw new CliUsageError("--schema-version must be 1 or 2");
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
    const result = schemaVersion === "2"
      ? (await import("../modules/module-initialization-v2.js")).analyzeModuleInitializationOrderV2(program, entryFile)
      : analyzeModuleInitializationOrder(program, entryFile);
    io.out(`${JSON.stringify(result, null, 2)}\n`);
    if (values.require && result.evidence !== "verified") {
      io.err("module initialization order is unknown:\n");
      for (const unknown of result.unknowns) io.err(`  ${unknown.kind} ${unknown.fileName}: ${unknown.detail}\n`);
      return exitCode.failed;
    }
    return exitCode.success;
  },
};
