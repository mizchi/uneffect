import ts from "@typescript/typescript6";
import { extractAnnotations } from "./annotations.js";
import { parseSpec, type TemporalAssignment, type TemporalProperty, type TemporalResponse, type TemporalState } from "./spec-ir.js";
import { formatTemporalValueType, generateQuintExpression, parseTemporalExpression, temporalTypesCompatible, typeCheckTemporalExpression, type TemporalExpression, type TemporalValueType } from "./temporal-expressions.js";
import type { EvidenceStatus } from "./effects.js";

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

function leading(source: ts.SourceFile, node: ts.Node): string { return source.text.slice(node.getFullStart(), node.getStart(source)); }
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
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const parsed = parseSpec(fileName, text, { temporalSymbols: new Map([["pc", "int"], ["suspended", "bool"], ["cancelled", "bool"]]) });
  const stateTypes = new Map<string, TemporalValueType>(parsed.temporal.states.map((state) => [state.name, state.type]));
  const declarations = new Map<string, ts.FunctionDeclaration>();
  const summaries = new Map<string, TemporalFunctionSummary>();
  for (const node of source.statements) {
    if (!ts.isFunctionDeclaration(node) || !node.name || !node.body) continue;
    declarations.set(node.name.text, node);
    const comments = leading(source, node), symbols = new Map(stateTypes);
    for (const parameter of node.parameters) if (ts.isIdentifier(parameter.name) && parameter.type) {
      const typeName = parameter.type.getText(source);
      const type = typeName === "boolean" ? "bool" : ["number", "Int", "Nat"].includes(typeName) ? "int" : undefined;
      if (type) symbols.set(parameter.name.text, type);
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
    if (fairnessValues.length > 1 || (fairness !== undefined && fairness !== "weak" && fairness !== "strong")) throw new Error(`${node.name.text}: temporal_fair requires weak or strong`);
    for (const errorType of [...throws, ...rejects]) if (!/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(errorType)) throw new Error(`${node.name.text}: invalid temporal error type`);
    if (requires.length || ensures.length || modifies.length || throws.length || rejects.length || suspends || cancellable || terminates || fairness) {
      for (const requirement of requires) if (typeCheckTemporalExpression(requirement, symbols) !== "bool") throw new Error(`${node.name.text}: temporal_requires must be boolean`);
      for (const postcondition of ensures) {
        const targetType = stateTypes.get(postcondition.target);
        if (!targetType) throw new Error(`${node.name.text}: unknown temporal state \`${postcondition.target}\``);
        if (!temporalTypesCompatible(targetType, typeCheckTemporalExpression(postcondition.expressionAst, symbols))) throw new Error(`${node.name.text}: temporal_ensures type mismatch for \`${postcondition.target}\``);
      }
      const assigned = new Set(ensures.map((item) => item.target));
      if (modifies.some((name) => !assigned.has(name)) || ensures.some((item) => !modifies.includes(item.target))) throw new Error(`${node.name.text}: temporal_ensures targets must exactly match temporal_modifies`);
      summaries.set(node.name.text, { functionName: node.name.text, requires, ensures, modifies, throws, rejects, suspends, cancellable, terminates, fairness, evidence: "trusted", span: { start: node.getStart(source), end: node.getEnd() } });
    }
  }
  const rootNode = declarations.get(root);
  if (!rootNode) throw new Error(`unknown temporal composition root: ${root}`);

  const nodes: GraphCall[] = [];
  const callsIn = (statement: ts.Node): ts.CallExpression[] => {
    const values: ts.CallExpression[] = [];
    const visit = (node: ts.Node): void => {
      if (node !== statement && ts.isFunctionLike(node)) return;
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && summaries.has(node.expression.text)) values.push(node);
      ts.forEachChild(node, visit);
    };
    visit(statement);
    return values.sort((a, b) => a.getStart(source) - b.getStart(source));
  };
  const compileAtomic = (statement: ts.Statement, continuation: GraphRef, handler: GraphRef): GraphRef => {
    let entry = ts.isReturnStatement(statement) ? "complete" as GraphRef : continuation;
    for (const call of callsIn(statement).reverse()) {
      const graph: GraphCall = { callee: (call.expression as ts.Identifier).text, normal: entry, error: handler, awaited: ts.isAwaitExpression(call.parent), span: { start: call.getStart(source), end: call.getEnd() } };
      nodes.push(graph); entry = graph;
    }
    return entry;
  };
  const compileBlock = (statements: readonly ts.Statement[], continuation: GraphRef, handler: GraphRef): GraphRef => {
    let entry = continuation;
    for (const statement of [...statements].reverse()) {
      if (ts.isTryStatement(statement)) {
        const finallyEntry = statement.finallyBlock ? compileBlock(statement.finallyBlock.statements, entry, handler) : entry;
        const catchEntry = statement.catchClause ? compileBlock(statement.catchClause.block.statements, finallyEntry, handler) : handler;
        entry = compileBlock(statement.tryBlock.statements, finallyEntry, catchEntry);
      } else if (ts.isBlock(statement)) entry = compileBlock(statement.statements, entry, handler);
      else entry = compileAtomic(statement, entry, handler);
    }
    return entry;
  };
  const entryRef = compileBlock(rootNode.body!.statements, "complete", "throw");
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
