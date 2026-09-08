import { verifyWorkflow, type WorkflowStep } from "../graph-analysis/workflow-api.js";
import type { PrerequisiteOperation, PrerequisiteRule, RuleAnalysisOptions, RuleAnalysisResult, RuleCfg, RuleEvent } from "./contracts.js";
import { normalizeCfg, normalizeRule, record } from "./input.js";

export const initializationRule: PrerequisiteRule = Object.freeze({
  id: "initialization-before-use",
  operations: Object.freeze({
    initialize: Object.freeze({ provides: Object.freeze(["initialized"]) }),
    use: Object.freeze({ requires: Object.freeze(["initialized"]) }),
    reset: Object.freeze({ revokes: Object.freeze(["initialized"]) }),
  }),
});

export const ownPropertyReadRule: PrerequisiteRule = Object.freeze({
  id: "own-property-before-read",
  operations: Object.freeze({
    guard: Object.freeze({ provides: Object.freeze(["own-property"]) }),
    read: Object.freeze({ requires: Object.freeze(["own-property"]) }),
    invalidate: Object.freeze({ revokes: Object.freeze(["own-property"]) }),
  }),
});

/** Compile operation prerequisites to the existing CFG must-analysis consumer. */
export function lintPrerequisites(graph: RuleCfg, rule: PrerequisiteRule, options: RuleAnalysisOptions = {}): RuleAnalysisResult {
  const config = record(options, "options", ["budget"]);
  if (config.budget !== undefined && (typeof config.budget !== "number" || !Number.isSafeInteger(config.budget) || config.budget <= 0)) {
    throw new RangeError("budget must be a positive safe integer");
  }
  const steps: WorkflowStep[] = [];
  const events = new Map<string, { event: RuleEvent; operation: PrerequisiteOperation }>();
  let entry: string;
  try {
    graph = normalizeCfg(graph);
    const operations = normalizeRule(rule);
    const ids = new Map(graph.blocks.map((block, index) => [block.id, `block:${index}`]));
    if (ids.size !== graph.blocks.length || !ids.has(graph.entry)) throw new TypeError("duplicate blocks or missing entry");
    entry = ids.get(graph.entry)!;
    for (const block of graph.blocks) {
      const blockId = ids.get(block.id)!;
      const successors = block.successors.map(id => {
        const target = ids.get(id);
        if (!target) throw new TypeError(`missing successor ${id}`);
        return target;
      });
      steps.push({ id: blockId, next: block.events.length ? [`${blockId}:event:0`] : successors });
      block.events.forEach((event, index) => {
        const operation = operations.get(event.operation);
        if (!operation) throw new TypeError(`unknown operation ${event.operation}`);
        const id = `${blockId}:event:${index}`;
        const facts = (values: readonly string[] | undefined) => values?.map(fact => JSON.stringify([event.subject, fact]));
        steps.push({ id, next: index + 1 < block.events.length ? [`${blockId}:event:${index + 1}`] : successors,
          requires: facts(operation.requires), provides: facts(operation.provides), revokes: facts(operation.revokes) });
        events.set(id, { event, operation });
      });
    }
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    return { status: "unknown", reason: "invalid-input", detail: error.message };
  }
  const result = verifyWorkflow({ entry, steps }, options);
  if (result.status === "unknown") return result;
  const diagnostics = result.diagnostics.flatMap(diagnostic => {
    if (diagnostic.kind !== "missing-prerequisite") return [];
    const { event, operation } = events.get(diagnostic.step)!;
    const missing = [...new Set(operation.requires)].filter(fact => diagnostic.missing.includes(JSON.stringify([event.subject, fact]))).sort();
    return [{ ruleId: rule.id, subject: event.subject, operation: event.operation, missing, location: event.location,
      message: `${event.operation} requires ${missing.join(", ")} on every incoming path` }];
  }).sort((a, b) => a.location.fileName.localeCompare(b.location.fileName) || a.location.start - b.location.start);
  return { status: diagnostics.length ? "findings" : "clean", diagnostics, iterations: result.iterations };
}
