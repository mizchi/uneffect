import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { initializationRule, lintPrerequisites, ownPropertyReadRule } from "../lint/prerequisites.js";
import { lowerCorsaRegistryReadCfg, lowerCorsaRuleCfg } from "../lint/corsa.js";
import type { SourceRuleBinding } from "../lint/contracts.js";
import { CliUsageError, exitCode, formatCommandHelp, parseCommandArgs, type CliCommand } from "./cli-support.js";

export const cfgLintCommand: CliCommand = {
  name: "cfg-lint",
  summary: "Prototype: check initialization prerequisites or own-entry registry reads.",
  arguments: "<file.ts> <function> [--registry binding.path [--flow expression|statement] | --initialize name --use name --reset name] [--budget count] [--project tsconfig.json]",
  details: [
    "--initialize name  source-local initialization function (default: initialize)",
    "--use name         source-local use function (default: use)",
    "--reset name       optional source-local invalidation function",
    "--registry path    table rooted at a plain parameter or module const binding",
    "--flow mode        registry control flow: expression (default) or statement (branches, returns, loops)",
    "--project file     use compiler options and file membership from this tsconfig",
    "--corsa-executable path  explicit native compiler (default: packaged Corsa compiler)",
    "--budget count     maximum processed analysis steps (default: 100000)",
    "",
    "Operation declarations are trusted synchronous contracts; their bodies are not verified.",
    "Registry mode assumes stable data properties, unmodified Object builtins, and standard array iteration.",
    "It checks direct reads in the selected control-flow scope; aliases and proxy/getter behavior are not proved.",
    "Prints JSON. Exit 0: clean; 1: findings; 2: unknown or invalid arguments.",
  ],
  async run(args, io) {
    const { values, positionals } = parseCommandArgs(args, {
      initialize: { type: "string" }, use: { type: "string" }, registry: { type: "string" }, flow: { type: "string" },
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
    const registry = values.registry as string | undefined;
    const flow = values.flow as string | undefined;
    if (flow !== undefined && (registry === undefined || (flow !== "expression" && flow !== "statement"))) throw new CliUsageError("--flow requires --registry and must be expression or statement");
    if (registry !== undefined) {
      if (!/^[$A-Za-z_][$\w]*(?:\.[$A-Za-z_][$\w]*)*$/u.test(registry)) throw new CliUsageError("--registry must be a binding name with optional static properties");
      if (values.initialize !== undefined || values.use !== undefined || values.reset !== undefined) throw new CliUsageError("--registry cannot be combined with --initialize, --use, or --reset");
    }
    const bindings: SourceRuleBinding[] = [
      { functionName: (values.initialize as string | undefined) ?? "initialize", operation: "initialize", argumentIndex: 0 },
      { functionName: (values.use as string | undefined) ?? "use", operation: "use", argumentIndex: 0 },
      ...(values.reset === undefined ? [] : [{ functionName: values.reset as string, operation: "reset", argumentIndex: 0 }]),
    ];
    if (bindings.some(binding => !binding.functionName.trim())) throw new CliUsageError("operation names must be nonempty");
    const fileName = resolve(positionals[0]!);
    const functionName = positionals[1]!;
    await readFile(fileName, "utf8");
    const options = { fileName, functionName, configFile: values.project as string | undefined,
      corsaExecutable: values["corsa-executable"] as string | undefined };
    const lowered = registry === undefined ? await lowerCorsaRuleCfg({ ...options, bindings })
      : await lowerCorsaRegistryReadCfg({ ...options, registry, flow: flow as "expression" | "statement" | undefined });
    const rule = registry === undefined ? initializationRule : ownPropertyReadRule;
    const result = lowered.status === "lowered" ? lintPrerequisites(lowered.cfg, rule, { budget }) : lowered;
    const scope = registry === undefined ? { assumedOperations: bindings } : {
      registry, analysisScope: flow === "statement" ? "statement-registry-reads" : "expression-local-registry-reads",
      assumptions: ["Registry entries and registry/key paths are stable data properties, without getters or proxies.",
        "Keys are primitive strings or numbers, without user-defined coercion.",
        "Object.hasOwn, Object.keys, and Object.freeze are unmodified builtins, and array iteration is standard; native symbols authenticate declarations, not runtime replacement."],
    };
    io.out(`${JSON.stringify({ fileName, functionName, ruleId: rule.id, ...scope, ...result }, null, 2)}\n`);
    return result.status === "clean" ? exitCode.success : result.status === "findings" ? exitCode.failed : exitCode.usage;
  },
};
