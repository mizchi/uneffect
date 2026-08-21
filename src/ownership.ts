import ts from "typescript";
import { TypeScriptFrontendAdapter } from "./frontend-adapter.js";

export type OwnershipState = "available" | "detached" | "transferred" | "locked" | "shared";
export type OwnershipOperation = "clone" | "transfer" | "read" | "mutate";
export interface OwnershipEvent {
  operation: OwnershipOperation;
  resource: string;
  transferState?: Exclude<OwnershipState, "available">;
  span: { start: number; end: number };
}
export interface OwnershipDiagnostic {
  resource: string;
  operation: OwnershipOperation;
  state: OwnershipState;
  span: { start: number; end: number };
  message: string;
}

export function checkOwnership(events: readonly OwnershipEvent[]): OwnershipDiagnostic[] {
  const states = new Map<string, OwnershipState>();
  const diagnostics: OwnershipDiagnostic[] = [];
  for (const event of events) {
    const state = states.get(event.resource) ?? (event.transferState === "shared" ? "shared" : "available");
    if (event.operation === "transfer") {
      if (state === "shared" || state !== "available") diagnostics.push({ ...event, state, message: state === "shared" ? `${event.resource} is shared and is not Transferable` : `${event.resource} was already ${state}` });
      else states.set(event.resource, event.transferState ?? "transferred");
    } else if ((event.operation === "read" || event.operation === "mutate") && !["available", "shared"].includes(state)) {
      diagnostics.push({ ...event, state, message: `cannot ${event.operation} ${event.resource} after it became ${state}` });
    }
  }
  return diagnostics;
}

function transferList(call: ts.CallExpression, index: number): readonly ts.Expression[] {
  const value = call.arguments[index];
  if (value && ts.isArrayLiteralExpression(value)) return value.elements.filter(ts.isExpression);
  if (value && ts.isObjectLiteralExpression(value)) for (const property of value.properties) {
    if (ts.isPropertyAssignment(property) && property.name.getText().replace(/["']/g, "") === "transfer" && ts.isArrayLiteralExpression(property.initializer)) return property.initializer.elements.filter(ts.isExpression);
  }
  return [];
}

export function collectOwnershipEvents(program: ts.Program, source: ts.SourceFile): OwnershipEvent[] {
  const adapter = new TypeScriptFrontendAdapter(program);
  const checker = program.getTypeChecker();
  const events: OwnershipEvent[] = [];
  const transferSpans: Array<{ start: number; end: number }> = [];
  const visit = (node: ts.Node): void => {
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "DataView" && node.arguments?.[0]) {
      const symbol = checker.getSymbolAtLocation(node.expression);
      const builtin = symbol?.declarations?.some((declaration) => program.isSourceFileDefaultLibrary(declaration.getSourceFile())) ?? false;
      const buffer = node.arguments[0]!;
      if (builtin && ts.isIdentifier(buffer)) events.push({ operation: "read", resource: buffer.text, span: { start: buffer.getStart(source), end: buffer.getEnd() } });
    }
    if (ts.isCallExpression(node)) {
      const operation = adapter.resolveCall(node)?.operation;
      if (operation?.kind === "clone") {
        const value = node.arguments[operation.valueArgument];
        if (value) events.push({ operation: "clone", resource: value.getText(source), span: { start: value.getStart(source), end: value.getEnd() } });
        for (const item of transferList(node, operation.transferArgument)) {
          events.push({ operation: "transfer", resource: item.getText(source), transferState: adapter.ownershipKind(item), span: { start: item.getStart(source), end: item.getEnd() } });
          transferSpans.push({ start: item.getStart(source), end: item.getEnd() });
        }
      }
    }
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && !transferSpans.some((span) => node.expression.getStart(source) >= span.start && node.expression.getEnd() <= span.end)) {
      const parent = node.parent;
      const mutate = ts.isBinaryExpression(parent) && parent.left === node && parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment;
      events.push({ operation: mutate ? "mutate" : "read", resource: node.expression.text, span: { start: node.getStart(source), end: node.getEnd() } });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return events.sort((a, b) => a.span.start - b.span.start || (a.operation === "transfer" ? -1 : 1));
}

export function analyzeOwnership(program: ts.Program, source: ts.SourceFile): OwnershipDiagnostic[] {
  return checkOwnership(collectOwnershipEvents(program, source));
}

export function generateOwnershipQuint(moduleName: string, events: readonly OwnershipEvent[]): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(moduleName)) throw new Error(`invalid Quint module name: ${moduleName}`);
  const resources = [...new Set(events.map((event) => event.resource))];
  const safe = new Map<string, boolean>(resources.map((resource) => [resource, true]));
  const state = new Map<string, OwnershipState>();
  const lines = [`module ${moduleName} {`, "  var pc: int", "  var ok: bool", "", "  action init = all {", "    pc' = 0,", "    ok' = true,", "  }"];
  events.forEach((event, index) => {
    const current = state.get(event.resource) ?? (event.transferState === "shared" ? "shared" : "available");
    let valid = true;
    if (event.operation === "transfer") {
      valid = current === "available";
      if (valid) state.set(event.resource, event.transferState ?? "transferred");
    } else if (event.operation === "read" || event.operation === "mutate") valid = current === "available" || current === "shared";
    safe.set(event.resource, safe.get(event.resource)! && valid);
    lines.push("", `  action event_${index} = all {`, `    pc == ${index},`, `    pc' = ${index + 1},`, `    ok' = (ok and ${valid}),`, "  }");
  });
  lines.push("", "  action step = any {");
  events.forEach((_event, index) => lines.push(`    event_${index},`));
  lines.push("  }", "", "  val ownershipSafe = ok", "}", "");
  return lines.join("\n");
}
