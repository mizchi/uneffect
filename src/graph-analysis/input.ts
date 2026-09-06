import type { AnalysisOptions, DependencyNode, Workflow, WorkflowAnalysisOptions, WorkflowStep } from "./contracts.js";

function record(value: unknown, path: string, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${path} must be an object`);
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw new TypeError(`${path}: unknown field ${key}`);
  return value as Record<string, unknown>;
}

function name(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new TypeError(`${path} must be a nonempty string`);
  return value;
}

export function stringList(value: unknown, path: string, unique = false): string[] {
  if (!Array.isArray(value)) throw new TypeError(`${path} must be a string array`);
  const result = Array.from(value, (item, index) => name(item, `${path}[${index}]`));
  if (unique && new Set(result).size !== result.length) throw new TypeError(`${path} contains duplicates`);
  return [...new Set(result)].sort();
}

/** Validate a JSON-compatible workflow shape and return an independent canonical copy.
 * Invalid shapes throw TypeError. Graph references/scopes are checked by verifyWorkflow.
 */
export function parseWorkflow(input: unknown): Workflow {
  const workflow = record(input, "workflow", ["entry", "initial", "steps"]);
  const entry = name(workflow.entry, "workflow.entry");
  if (!Array.isArray(workflow.steps)) throw new TypeError("workflow.steps must be an array");
  const steps = Array.from(workflow.steps, (value, index): WorkflowStep => {
    const path = `workflow.steps[${index}]`;
    const step = record(value, path, ["id", "kind", "next", "requires", "provides", "revokes", "fork", "join"]);
    const kind = step.kind;
    if (kind !== undefined && kind !== "action" && kind !== "fork" && kind !== "join") throw new TypeError(`${path}: unknown step kind`);
    if ((kind !== "fork" && "join" in step) || (kind !== "join" && "fork" in step)) throw new TypeError(`${path}: unexpected fork/join field`);
    const base = { id: name(step.id, `${path}.id`), next: stringList(step.next, `${path}.next`, true),
      requires: stringList(step.requires === undefined ? [] : step.requires, `${path}.requires`),
      provides: stringList(step.provides === undefined ? [] : step.provides, `${path}.provides`),
      revokes: stringList(step.revokes === undefined ? [] : step.revokes, `${path}.revokes`) };
    if (kind === "fork") return { ...base, kind, join: name(step.join, `${path}.join`) };
    if (kind === "join") return { ...base, kind, fork: name(step.fork, `${path}.fork`) };
    return { ...base, kind: "action" };
  });
  return { entry, initial: stringList(workflow.initial === undefined ? [] : workflow.initial, "workflow.initial"),
    steps: steps.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0) };
}

/** Validate and copy dependency inputs; missing references are analysis errors. */
export function parseDependencyGraph(input: unknown): readonly DependencyNode[] {
  if (!Array.isArray(input)) throw new TypeError("dependency graph must be an array");
  return Array.from(input, (value, index) => {
    const path = `nodes[${index}]`;
    const node = record(value, path, ["id", "dependencies"]);
    return { id: name(node.id, `${path}.id`), dependencies: stringList(node.dependencies, `${path}.dependencies`) };
  }).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** Options are programming errors (TypeError/RangeError), never positive verdicts. */
export function validateOptions(options: AnalysisOptions | WorkflowAnalysisOptions, parallel: boolean): void {
  const keys = parallel ? ["budget", "maxConfigurations", "maxTransitions"] : ["budget"];
  const values = record(options, "options", keys);
  for (const key of keys) {
    const value = values[key];
    if (value !== undefined && (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)) {
      throw new RangeError(`${key} must be a positive safe integer`);
    }
  }
}
