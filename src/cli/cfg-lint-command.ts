import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { initializationRule, lintPrerequisites } from "../lint/prerequisites.js";
import { lowerCorsaRuleCfg } from "../lint/corsa.js";
import type { SourceRuleBinding } from "../lint/contracts.js";
import { CliUsageError, exitCode, formatCommandHelp, parseCommandArgs, type CliCommand } from "./cli-support.js";

export const cfgLintCommand: CliCommand = {
  name: "cfg-lint",
  summary: "Prototype: check initialization prerequisites along function control flow.",
  arguments: "<file.ts> <function> [--initialize name] [--use name] [--reset name] [--budget count] [--project tsconfig.json]",
  details: [
    "--initialize name  source-local initialization function (default: initialize)",
    "--use name         source-local use function (default: use)",
    "--reset name       optional source-local invalidation function",
    "--project file     use compiler options and file membership from this tsconfig",
    "--corsa-executable path  explicit native compiler (default: packaged Corsa compiler)",
    "--budget count     maximum processed analysis steps (default: 100000)",
    "",
    "Operation declarations are trusted synchronous contracts; their bodies are not verified.",
    "Prints JSON. Exit 0: clean; 1: findings; 2: unknown or invalid arguments.",
  ],
  async run(args, io) {
    const { values, positionals } = parseCommandArgs(args, {
      initialize: { type: "string", default: "initialize" }, use: { type: "string", default: "use" },
      project: { type: "string" }, "corsa-executable": { type: "string" },
      reset: { type: "string" }, budget: { type: "string" },
    });
    if (values.help) { io.out(formatCommandHelp(cfgLintCommand)); return exitCode.success; }
    if (positionals.length !== 2 || positionals.some(value => value.trim().length === 0)) throw new CliUsageError("cfg-lint requires a file and a function name");
    const budgetText = values.budget as string | undefined;
    const budget = budgetText === undefined ? undefined : Number(budgetText);
    if (budget !== undefined && (!/^[1-9]\d*$/u.test(budgetText!) || !Number.isSafeInteger(budget))) {
      throw new CliUsageError("--budget must be a positive safe integer");
    }
    const bindings: SourceRuleBinding[] = [
      { functionName: values.initialize as string, operation: "initialize", argumentIndex: 0 },
      { functionName: values.use as string, operation: "use", argumentIndex: 0 },
      ...(values.reset === undefined ? [] : [{ functionName: values.reset as string, operation: "reset", argumentIndex: 0 }]),
    ];
    if (bindings.some(binding => !binding.functionName.trim())) throw new CliUsageError("operation names must be nonempty");
    const fileName = resolve(positionals[0]!);
    const functionName = positionals[1]!;
    await readFile(fileName, "utf8");
    const lowered = await lowerCorsaRuleCfg({ fileName, functionName, bindings,
      configFile: values.project as string | undefined, corsaExecutable: values["corsa-executable"] as string | undefined });
    const result = lowered.status === "lowered" ? lintPrerequisites(lowered.cfg, initializationRule, { budget }) : lowered;
    io.out(`${JSON.stringify({ fileName, functionName, ruleId: initializationRule.id, assumedOperations: bindings, ...result }, null, 2)}\n`);
    return result.status === "clean" ? exitCode.success : result.status === "findings" ? exitCode.failed : exitCode.usage;
  },
};
