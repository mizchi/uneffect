import type { InvariantSpec, TemporalSpec } from "./spec-ir.js";
import { formatTemporalValueType, generateQuintExpression } from "./temporal-expressions.js";
import { generateObligationSmt, obligationFromSpec } from "./invariant-ir.js";

export function generateSmtLib(spec: InvariantSpec): string {
  return generateObligationSmt(obligationFromSpec(spec));
}

function safeName(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`invalid Quint name: ${name}`);
  return name;
}

export function generateQuint(moduleName: string, spec: TemporalSpec): string {
  if (spec.states.length === 0) throw new Error("temporal spec has no state variables");
  if (spec.actions.length === 0) throw new Error("temporal spec has no actions");
  const stateNames = new Set(spec.states.map((state) => state.name));
  const init = new Map(spec.init.map((item) => [item.target, generateQuintExpression(item.expressionAst)]));
  for (const state of spec.states) if (!init.has(state.name)) throw new Error(`missing init for ${state.name}`);

  const lines = [`module ${safeName(moduleName)} {`];
  for (const state of spec.states) lines.push(`  var ${safeName(state.name)}: ${formatTemporalValueType(state.type)}`);
  lines.push("", "  action init = all {");
  for (const state of spec.states) lines.push(`    ${state.name}' = ${init.get(state.name)},`);
  lines.push("  }");
  for (const action of spec.actions) {
    const assigned = new Map(action.assignments.map((item) => [item.target, generateQuintExpression(item.expressionAst)]));
    for (const target of assigned.keys()) if (!stateNames.has(target)) throw new Error(`unknown state in ${action.name}: ${target}`);
    lines.push("", `  action ${safeName(action.name)} = all {`);
    if (action.guard) lines.push(`    ${generateQuintExpression(action.guard.expressionAst)},`);
    for (const state of spec.states) lines.push(`    ${state.name}' = ${assigned.get(state.name) ?? state.name},`);
    lines.push("  }");
  }
  lines.push("", "  action step = any {");
  for (const action of spec.actions) lines.push(`    ${action.name},`);
  lines.push("  }");
  for (const property of spec.properties) lines.push("", `  val ${safeName(property.name)} = ${generateQuintExpression(property.expressionAst)}`);
  for (const property of spec.liveness) lines.push("", `  temporal ${safeName(property.name)} = eventually(${generateQuintExpression(property.expressionAst)})`);
  for (const property of spec.recurrences) lines.push("", `  temporal ${safeName(property.name)} = always(eventually(${generateQuintExpression(property.expressionAst)}))`);
  for (const property of spec.stabilizations) lines.push("", `  temporal ${safeName(property.name)} = eventually(always(${generateQuintExpression(property.expressionAst)}))`);
  for (const property of spec.responses) lines.push("", `  temporal ${safeName(property.name)} = ${generateQuintExpression(property.triggerAst)} leadsTo ${generateQuintExpression(property.responseAst)}`);
  const fairActions = spec.actions.filter((action) => action.fairness);
  if (fairActions.length) {
    lines.push("", `  val fairnessVars = (${spec.states.map((state) => state.name).join(", ")})`);
    for (const action of fairActions) lines.push(`  temporal fair_${safeName(action.name)} = ${safeName(action.name)}.${action.fairness}Fair(fairnessVars)`);
  }
  lines.push("}", "");
  return lines.join("\n");
}
