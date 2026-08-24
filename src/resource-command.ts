import { readFile } from "node:fs/promises";
import { analyzeAsyncSafety, generateResourceSafetyQuint, generateUnifiedAsyncQuint } from "./async-safety.js";
import { CliUsageError, exitCode, formatCommandHelp, parseCommandArgs, singleFileArgument, type CliCommand } from "./cli-support.js";

export const resourceCommand: CliCommand = {
  name: "resource-model",
  summary: "Generate the Quint resource-safety model for one file.",
  arguments: "<file.ts>",
  details: ["The model covers `using` acquisition, disposal, and escape for every resource binding."],
  async run(args, io) {
    const { values, positionals } = parseCommandArgs(args, {});
    if (values.help) { io.out(formatCommandHelp(resourceCommand)); return exitCode.success; }
    const fileName = singleFileArgument(positionals, "resource-model");
    const source = await readFile(fileName, "utf8");
    io.out(generateResourceSafetyQuint("resource_safety", analyzeAsyncSafety(fileName, source)));
    return exitCode.success;
  },
};

export const asyncModelCommand: CliCommand = {
  name: "async-model",
  summary: "Generate the unified Quint model of Promise, exception, and resource flow for one function.",
  arguments: "<file.ts> <function>",
  details: ["The function argument selects the owner whose flow is modeled."],
  async run(args, io) {
    const { values, positionals } = parseCommandArgs(args, {});
    if (values.help) { io.out(formatCommandHelp(asyncModelCommand)); return exitCode.success; }
    const [fileName, owner] = positionals;
    if (!fileName || !owner) throw new CliUsageError("async-model needs a file and a function name");
    if (positionals.length > 2) throw new CliUsageError(`async-model takes a file and one function, received ${positionals.length} arguments`);
    const source = await readFile(fileName, "utf8");
    io.out(generateUnifiedAsyncQuint("unified_async", analyzeAsyncSafety(fileName, source), owner));
    return exitCode.success;
  },
};
