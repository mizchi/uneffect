import type { ModuleInitializationV2Options } from "./contracts.js";

export const DEFAULT_MODULE_CONTROL_FLOW_PROOF_BUDGET = Object.freeze({
  moduleControlFlowIterations: 32,
} as const);

function record(value: unknown, path: string, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${path} must be an object`);
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw new TypeError(`${path}: unknown field ${key}`);
  return value as Record<string, unknown>;
}

/** Validate options before inspecting source, including inputs that need no CFG proof. */
export function moduleControlFlowLimit(options: ModuleInitializationV2Options): number {
  const input = record(options, "options", ["proofBudget"]);
  const budget = input.proofBudget === undefined ? {} : record(input.proofBudget, "options.proofBudget", ["moduleControlFlowIterations"]);
  const value = budget.moduleControlFlowIterations;
  if (value === undefined) return DEFAULT_MODULE_CONTROL_FLOW_PROOF_BUDGET.moduleControlFlowIterations;
  if (typeof value !== "number") throw new TypeError("moduleControlFlowIterations must be a number");
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError("moduleControlFlowIterations must be a positive safe integer");
  return value;
}
