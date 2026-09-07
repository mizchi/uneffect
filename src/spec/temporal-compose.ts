import type { Node, CallExpression } from "oxc-parser";
import { parseOxcSource, topLevelOxcFunctions, oxcChildren, oxcParameterBinding, oxcParameterType, type NamedOxcFunction } from "../frontends/oxc/source.js";
import { extractAnnotations } from "../support/annotations.js";
import { parseSpec, type TemporalAssignment, type TemporalProperty, type TemporalResponse, type TemporalState } from "./spec-ir.js";
import { formatTemporalValueType, generateQuintExpression, parseTemporalExpression, temporalTypesCompatible, typeCheckTemporalExpression, type TemporalExpression, type TemporalValueType } from "./temporal-expressions.js";
import type { EvidenceStatus } from "../evidence/status.js";

export interface TemporalFunctionSummary {
  functionName: string;
  requires: TemporalExpression[];
  ensures: TemporalAssignment[];
  modifies: string[];
  throws: string[];
  rejects: string[];
  suspends: boolean;
  cancellable: boolean;
  /** Trusted claim that synchronous evaluation returns instead of diverging. */
  terminates: boolean;
  fairness?: "weak" | "strong";
  evidence: EvidenceStatus;
  span: { start: number; end: number };
}

export interface TemporalCall {
  caller: string;
  callee: string;
  index: number;
  normalTarget: number;
  errorTarget: number;
  catchesThrow: boolean;
  awaited: boolean;
  span: { start: number; end: number };
}

export interface TemporalComposition {
  fileName: string;
  root: string;
  entry: number;
  complete: number;
  states: TemporalState[];
  init: TemporalAssignment[];
  properties: TemporalProperty[];
  liveness: TemporalProperty[];
  recurrences: TemporalProperty[];
  stabilizations: TemporalProperty[];
  responses: TemporalResponse[];
  stutteringPolicy: "explicit-unchanged";
  summaries: Map<string, TemporalFunctionSummary>;
  calls: TemporalCall[];
}

function nextAssignment(input: string): TemporalAssignment {
  const match = /^([A-Za-z_$][\w$]*)'\s*=\s*(.+)$/.exec(input);
  if (!match) throw new Error(`invalid temporal_ensures assignment: ${input}`);
  const expression = match[2]!.trim();
  return { target: match[1]!, expression, expressionAst: parseTemporalExpression(expression) };
}
function booleanDirective(values: string[], name: string): boolean {
  if (values.length === 0) return false;
  if (values.length !== 1 || values[0] !== "true") throw new Error(`${name} currently requires the literal true`);
  return true;
}

interface GraphCall { callee: string; normal: GraphRef; error: GraphRef; awaited: boolean; span: { start: number; end: number } }
type GraphRef = GraphCall | "complete" | "throw";

export function parseTemporalComposition(fileName: string, text: string, root: string): TemporalComposition {
  const source = parseOxcSource(fileName, text);
  const parsed = parseSpec(fileName, text, { temporalSymbols: new Map([["pc", "int"], ["suspended", "bool"], ["cancelled", "bool"]]) });
  const stateTypes = new Map<string, TemporalValueType>(parsed.temporal.states.map((state) => [state.name, state.type]));
  const declarations = new Map<string, NamedOxcFunction>();
  const summaries = new Map<string, TemporalFunctionSummary>();
  for (const declaration of topLevelOxcFunctions(source)) {
    const { node, comments } = declaration;
    declarations.set(node.id.name, node);
    const symbols = new Map(stateTypes);
    for (const parameter of node.params) {
      const binding = oxcParameterBinding(parameter), annotation = oxcParameterType(parameter);
      if (!binding || !annotation) continue;
      const typeName = source.textOf(annotation);
      const type = typeName === "boolean" ? "bool" : ["number", "Int", "Nat"].includes(typeName) ? "int" : undefined;
      if (type) symbols.set(binding.name, type);
    }
    const requires = extractAnnotations(comments, "temporal_requires").map(parseTemporalExpression);
    const ensures = extractAnnotations(comments, "temporal_ensures").map(nextAssignment);
    const modifies = extractAnnotations(comments, "temporal_modifies");
    const throws = extractAnnotations(comments, "temporal_throws");
    const rejects = extractAnnotations(comments, "temporal_rejects");
    const suspends = booleanDirective(extractAnnotations(comments, "temporal_suspends"), "temporal_suspends");
    const cancellable = booleanDirective(extractAnnotations(comments, "temporal_cancellable"), "temporal_cancellable");
    const terminates = booleanDirective(extractAnnotations(comments, "temporal_terminates"), "temporal_terminates");
    const fairnessValues = extractAnnotations(comments, "temporal_fair");
    const fairness = fairnessValues[0] as "weak" | "strong" | undefined;
    if (fairnessValues.length > 1 || (fairness !== undefined && fairness !== "weak" && fairness !== "strong")) throw new Error(`${node.id.name}: temporal_fair requires weak or strong`);
    for (const errorType of [...throws, ...rejects]) if (!/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(errorType)) throw new Error(`${node.id.name}: invalid temporal error type`);
    if (requires.length || ensures.length || modifies.length || throws.length || rejects.length || suspends || cancellable || terminates || fairness) {
      for (const requirement of requires) if (typeCheckTemporalExpression(requirement, symbols) !== "bool") throw new Error(`${node.id.name}: temporal_requires must be boolean`);
      for (const postcondition of ensures) {
        const targetType = stateTypes.get(postcondition.target);
        if (!targetType) throw new Error(`${node.id.name}: unknown temporal state \`${postcondition.target}\``);
        if (!temporalTypesCompatible(targetType, typeCheckTemporalExpression(postcondition.expressionAst, symbols))) throw new Error(`${node.id.name}: temporal_ensures type mismatch for \`${postcondition.target}\``);
      }
      const assigned = new Set(ensures.map((item) => item.target));
      if (modifies.some((name) => !assigned.has(name)) || ensures.some((item) => !modifies.includes(item.target))) throw new Error(`${node.id.name}: temporal_ensures targets must exactly match temporal_modifies`);
      summaries.set(node.id.name, { functionName: node.id.name, requires, ensures, modifies, throws, rejects, suspends, cancellable, terminates, fairness, evidence: "trusted", span: { start: declaration.start, end: declaration.end } });
    }
  }
  const rootNode = declarations.get(root);
  if (!rootNode) throw new Error(`unknown temporal composition root: ${root}`);

  const nodes: GraphCall[] = [];
  const parents = new Map<Node, Node>();
  const callsIn = (statement: Node): CallExpression[] => {
    const values: CallExpression[] = [];
    const visit = (node: Node): void => {
      if (node !== statement && ["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression", "TSDeclareFunction"].includes(node.type)) return;
      if (node.type === "CallExpression" && node.callee.type === "Identifier" && summaries.has(node.callee.name)) values.push(node);
      for (const child of oxcChildren(node)) { parents.set(child, node); visit(child); }
    };
    visit(statement);
    return values.sort((a, b) => a.start - b.start);
  };
  const compileAtomic = (statement: Node, continuation: GraphRef, handler: GraphRef): GraphRef => {
    let entry = statement.type === "ReturnStatement" ? "complete" as GraphRef : continuation;
    for (const call of callsIn(statement).reverse()) {
      const graph: GraphCall = { callee: (call.callee as { name: string }).name, normal: entry, error: handler, awaited: parents.get(call)?.type === "AwaitExpression", span: { start: call.start, end: call.end } };
      nodes.push(graph); entry = graph;
    }
    return entry;
  };
  const compileBlock = (statements: readonly Node[], continuation: GraphRef, handler: GraphRef): GraphRef => {
    let entry = continuation;
    for (const statement of [...statements].reverse()) {
      if (statement.type === "TryStatement") {
        const finallyEntry = statement.finalizer ? compileBlock(statement.finalizer.body, entry, handler) : entry;
        const catchEntry = statement.handler ? compileBlock(statement.handler.body.body, finallyEntry, handler) : handler;
        entry = compileBlock(statement.block.body, finallyEntry, catchEntry);
      } else if (statement.type === "BlockStatement") entry = compileBlock(statement.body, entry, handler);
      else entry = compileAtomic(statement, entry, handler);
    }
    return entry;
  };
  const entryRef = compileBlock(rootNode.body.body, "complete", "throw");
  const reachable = new Set<GraphCall>();
  const mark = (ref: GraphRef): void => { if (typeof ref === "object" && !reachable.has(ref)) { reachable.add(ref); mark(ref.normal); mark(ref.error); } };
  mark(entryRef);
  const ordered = [...reachable].sort((a, b) => a.span.start - b.span.start);
  const ids = new Map(ordered.map((node, index) => [node, index]));
  const complete = ordered.length;
  const target = (ref: GraphRef): number => ref === "complete" ? complete : ref === "throw" ? -1 : ids.get(ref)!;
  const calls: TemporalCall[] = ordered.map((node, index) => ({ caller: root, callee: node.callee, index, normalTarget: target(node.normal), errorTarget: target(node.error), catchesThrow: target(node.error) >= 0, awaited: node.awaited, span: node.span }));
  return { fileName, root, entry: target(entryRef), complete, calls, summaries, states: parsed.temporal.states, init: parsed.temporal.init, properties: parsed.temporal.properties, liveness: parsed.temporal.liveness, recurrences: parsed.temporal.recurrences, stabilizations: parsed.temporal.stabilizations, responses: parsed.temporal.responses, stutteringPolicy: parsed.temporal.stutteringPolicy };
}

function safeName(name: string): string { if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`invalid Quint name: ${name}`); return name; }
export function generateComposedQuint(moduleName: string, composition: TemporalComposition, options: { enforceRequires?: boolean } = {}): string {
  const enforceRequires = options.enforceRequires ?? true;
  const init = new Map(composition.init.map((item) => [item.target, generateQuintExpression(item.expressionAst)]));
  const lines = [`module ${safeName(moduleName)} {`, "  var pc: int", "  var suspended: bool", "  var cancelled: bool"];
  for (const state of composition.states) lines.push(`  var ${safeName(state.name)}: ${formatTemporalValueType(state.type)}`);
  lines.push("", "  action init = all {", `    pc' = ${composition.entry},`, "    suspended' = false,", "    cancelled' = false,");
  for (const state of composition.states) { const value = init.get(state.name); if (value === undefined) throw new Error(`missing init for ${state.name}`); lines.push(`    ${state.name}' = ${value},`); }
  lines.push("  }");
  const emitExit = (name: string, call: TemporalCall, target: number, updates = new Map<string, string>(), suspended = false, cancelled = false, controlGuard?: string): void => {
    const summary = composition.summaries.get(call.callee)!;
    lines.push("", `  action ${name}_${call.index}_${safeName(call.callee)} = all {`, `    pc == ${call.index},`);
    if (controlGuard) lines.push(`    ${controlGuard},`);
    if (enforceRequires) for (const requirement of summary.requires) lines.push(`    ${generateQuintExpression(requirement)},`);
    lines.push(`    pc' = ${target},`, `    suspended' = ${suspended},`, `    cancelled' = ${cancelled},`);
    for (const state of composition.states) lines.push(`    ${state.name}' = ${updates.get(state.name) ?? state.name},`);
    lines.push("  }");
  };
  for (const call of composition.calls) {
    const summary = composition.summaries.get(call.callee)!;
    emitExit("call", call, call.normalTarget, new Map(summary.ensures.map((item) => [item.target, generateQuintExpression(item.expressionAst)])), false, false, "not(suspended)");
    if (summary.throws.length) emitExit("throw", call, call.errorTarget);
    if (summary.rejects.length) emitExit("reject", call, call.awaited ? call.errorTarget : -2);
    if (summary.suspends) emitExit("suspend", call, call.index, new Map(), true, false, "not(suspended)");
    if (summary.suspends) emitExit("resume", call, call.index, new Map(), false, false, "suspended");
    if (summary.cancellable) emitExit("cancel", call, -3, new Map(), false, true, "suspended");
  }
  lines.push("", "  action step = any {");
  for (const call of composition.calls) {
    const summary = composition.summaries.get(call.callee)!;
    lines.push(`    call_${call.index}_${safeName(call.callee)},`);
    if (summary.throws.length) lines.push(`    throw_${call.index}_${safeName(call.callee)},`);
    if (summary.rejects.length) lines.push(`    reject_${call.index}_${safeName(call.callee)},`);
    if (summary.suspends) lines.push(`    suspend_${call.index}_${safeName(call.callee)},`, `    resume_${call.index}_${safeName(call.callee)},`);
    if (summary.cancellable) lines.push(`    cancel_${call.index}_${safeName(call.callee)},`);
  }
  lines.push("  }");
  for (const property of composition.properties) lines.push("", `  val ${safeName(property.name)} = ${generateQuintExpression(property.expressionAst)}`);
  for (const property of composition.liveness) lines.push("", `  temporal ${safeName(property.name)} = eventually(${generateQuintExpression(property.expressionAst)})`);
  for (const property of composition.recurrences) lines.push("", `  temporal ${safeName(property.name)} = always(eventually(${generateQuintExpression(property.expressionAst)}))`);
  for (const property of composition.stabilizations) lines.push("", `  temporal ${safeName(property.name)} = eventually(always(${generateQuintExpression(property.expressionAst)}))`);
  for (const property of composition.responses) lines.push("", `  temporal ${safeName(property.name)} = ${generateQuintExpression(property.triggerAst)} leadsTo ${generateQuintExpression(property.responseAst)}`);
  const fairCalls = composition.calls.filter((call) => composition.summaries.get(call.callee)!.fairness);
  if (fairCalls.length) {
    const stateTuple = ["pc", "suspended", "cancelled", ...composition.states.map((state) => state.name)].join(", ");
    lines.push("", `  val fairnessVars = (${stateTuple})`);
    for (const call of fairCalls) {
      const summary = composition.summaries.get(call.callee)!;
      const action = summary.suspends ? `resume_${call.index}_${safeName(call.callee)}` : `call_${call.index}_${safeName(call.callee)}`;
      lines.push(`  temporal fair_${call.index}_${safeName(call.callee)} = ${action}.${summary.fairness}Fair(fairnessVars)`);
    }
  }
  lines.push("}", "");
  return lines.join("\n");
}
