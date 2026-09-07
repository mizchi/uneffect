import type { PrerequisiteOperation, PrerequisiteRule, RuleCfg } from "./contracts.js";

export function record(value: unknown, label: string, keys?: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  if (keys) for (const key of Object.keys(value)) if (!keys.includes(key)) throw new TypeError(`${label}: unknown field ${key}`);
  return value as Record<string, unknown>;
}
export function name(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new TypeError(`${label} must be a nonempty string`);
  return value;
}
export function list(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  return Array.from(value);
}
export function names(value: unknown, label: string): string[] {
  return list(value, label).map(item => name(item, label));
}

export function normalizeRule(rule: PrerequisiteRule): Map<string, PrerequisiteOperation> {
  const input = record(rule, "rule", ["id", "operations"]);
  name(input.id, "rule.id");
  return new Map(Object.entries(record(input.operations, "rule.operations")).map(([key, value]) => {
    name(key, "operation");
    const operation = record(value, `operation ${key}`, ["requires", "provides", "revokes"]);
    return [key, Object.fromEntries(Object.entries(operation).map(([field, facts]) => [field, names(facts, field)]))];
  }));
}
export function normalizeCfg(graph: RuleCfg): RuleCfg {
  const input = record(graph, "cfg", ["entry", "blocks"]);
  return { entry: name(input.entry, "cfg.entry"), blocks: list(input.blocks, "cfg.blocks").map(value => {
    const block = record(value, "block", ["id", "successors", "events"]);
    return { id: name(block.id, "block.id"), successors: names(block.successors, "successors"),
      events: list(block.events, "events").map(value => {
        const event = record(value, "event", ["operation", "subject", "location"]);
        const location = record(event.location, "location", ["fileName", "start", "end"]);
        if (!Number.isSafeInteger(location.start) || !Number.isSafeInteger(location.end)
          || (location.start as number) < 0 || (location.end as number) < (location.start as number)) throw new TypeError("invalid location span");
        return { operation: name(event.operation, "event.operation"), subject: name(event.subject, "event.subject"),
          location: { fileName: name(location.fileName, "location.fileName"), start: location.start as number, end: location.end as number } };
      }) };
  }) };
}
