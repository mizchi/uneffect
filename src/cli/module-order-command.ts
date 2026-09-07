import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { analyzeCorsaModuleInitializationOrder, analyzeCorsaModuleInitializationOrderV2 } from "../modules/corsa-module-order.js";
import { CliUsageError, exitCode, formatCommandHelp, parseCommandArgs, singleFileArgument, type CliCommand } from "./cli-support.js";

export const moduleOrderCommand: CliCommand = {
  name: "module-order",
  summary: "Print the source-mapped ESM module-initialization partial-order IR.",
  arguments: "<entry.ts> [--project tsconfig.json] [--schema-version 1|2] [--require]",
  details: [
    "--project <tsconfig.json>  use the native compiler project (default: isolated ES2024/NodeNext)",
    "--corsa-executable <path>  explicit native compiler executable",
    "--require  exit 1 unless the extracted ordering fragment is proof-grade",
    "--schema-version 1|2  artifact version (default: 1); v2 supports one bounded conditional TLA join",
    "",
    "Unsupported cycles, external/dynamic imports, control flow, or TypeScript errors remain visible in the JSON artifact.",
  ],
  async run(args, io) {
    const { values, positionals } = parseCommandArgs(args, {
      require: { type: "boolean" },
      project: { type: "string" },
      "corsa-executable": { type: "string" },
      "schema-version": { type: "string", default: "1" },
    });
    if (values.help) { io.out(formatCommandHelp(moduleOrderCommand)); return exitCode.success; }
    const schemaVersion = values["schema-version"];
    if (schemaVersion !== "1" && schemaVersion !== "2") throw new CliUsageError("--schema-version must be 1 or 2");
    const entryFile = resolve(singleFileArgument(positionals, "module-order"));
    await readFile(entryFile, "utf8");
    const options = { entryFile, configFile: values.project as string | undefined, corsaExecutable: values["corsa-executable"] as string | undefined };
    const result = schemaVersion === "2"
      ? await analyzeCorsaModuleInitializationOrderV2(options)
      : await analyzeCorsaModuleInitializationOrder(options);
    io.out(`${JSON.stringify(result, null, 2)}\n`);
    if (values.require && result.evidence !== "verified") {
      io.err("module initialization order is unknown:\n");
      for (const unknown of result.unknowns) io.err(`  ${unknown.kind} ${unknown.fileName}: ${unknown.detail}\n`);
      return exitCode.failed;
    }
    return exitCode.success;
  },
};
