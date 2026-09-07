import type { SourceRuleOptions } from "./contracts.js";
import { list, name, record } from "./input.js";

export function normalizeSourceOptions(options: SourceRuleOptions): SourceRuleOptions {
  const input = record(options, "options", ["fileName", "functionName", "bindings"]);
  return { fileName: name(input.fileName, "fileName"), functionName: name(input.functionName, "functionName"),
    bindings: list(input.bindings, "bindings").map(value => {
      const binding = record(value, "binding", ["functionName", "operation", "argumentIndex"]);
      if (!Number.isSafeInteger(binding.argumentIndex) || (binding.argumentIndex as number) < 0) throw new TypeError("argumentIndex must be a nonnegative safe integer");
      return { functionName: name(binding.functionName, "binding.functionName"), operation: name(binding.operation, "binding.operation"), argumentIndex: binding.argumentIndex as number };
    }) };
}
