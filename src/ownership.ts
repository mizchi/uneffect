import ts from "typescript";
import { resolvedSymbol, symbolIdentityKey } from "./binding-identity.js";
import { TypeScriptFrontendAdapter } from "./frontend-adapter.js";
import { interpretBuiltinCallSemantics, projectedArrayElements } from "./builtin-semantic-interpreter.js";
import { resolveStableRegion } from "./region-alias.js";
import { evaluateResourceProtocol, evaluateResourceProtocolCfg, resourceProtocolSchema, type ResourceProtocolModel, type ResourceProtocolState, type ResourceProtocolTransition } from "./resource-protocol.js";
import { resolveBuiltinTypedArrayWindowMethod } from "./typed-array-windows.js";
import { lowerResourceProtocolCfgInFunction, type ResourceTransitionSite } from "./resource-protocol-typescript.js";
import { collectCallableExceptionalTransitionSites } from "./resource-protocol-typescript.js";
import type { CallableSummary } from "./callable-summary.js";

export type OwnershipState = "available" | "detached" | "transferred" | "locked" | "shared" | "unknown";
export type OwnershipOperation = "clone" | "transfer" | "read" | "mutate";
export interface OwnershipEvent {
  operation: OwnershipOperation;
  resource: string;
  transferState?: Exclude<OwnershipState, "available" | "unknown">;
  /** Lexical finite branch choices that must hold for this event to execute. */
  controlPath?: readonly { id: number; branch: boolean }[];
  /** Multi-way lexical choices such as switch selection. */
  choicePath?: readonly { id: number; alternatives: number; choices: readonly number[] }[];
  /** The event is inside a loop whose iteration count is not proved to be at most one. */
  repeatable?: boolean;
  span: { start: number; end: number };
  /** TypeChecker-backed identity shared by immutable aliases of one resource. */
  regionId?: string;
}
export interface OwnershipDiagnostic {
  resource: string;
  operation: OwnershipOperation;
  state: OwnershipState;
  span: { start: number; end: number };
  regionId?: string;
  message: string;
}

export interface OwnershipResourceProtocolProjection {
  readonly model: ResourceProtocolModel;
  readonly unsupported: readonly { readonly event: number; readonly reason: "shared-memory-transfer" | "conditional-control" }[];
}

/** Projects the non-shared Transferable fragment into the common resource IR. */
export function lowerOwnershipEventsToResourceProtocol(events: readonly OwnershipEvent[]): OwnershipResourceProtocolProjection {
  const identities = new Map<string, OwnershipEvent>();
  for (const event of events) identities.set(event.regionId ?? event.resource, event);
  const unsupported: { event: number; reason: "shared-memory-transfer" | "conditional-control" }[] = [];
  const transitions: ResourceProtocolTransition[] = [];
  events.forEach((event, index) => {
    const resource = event.regionId ?? event.resource;
    if (event.controlPath?.length || event.choicePath?.length) unsupported.push({ event: index, reason: "conditional-control" });
    if (event.operation === "clone") return;
    if (event.operation === "read" || event.operation === "mutate") {
      transitions.push({ kind: "use", resource, at: index, evidence: "exact" });
      return;
    }
    if (event.transferState === "shared") {
      unsupported.push({ event: index, reason: "shared-memory-transfer" });
      return;
    }
    transitions.push({ kind: event.transferState === "detached" ? "invalidate" : "transfer",
      resource, at: index, evidence: "exact" });
  });
  return {
    model: {
      schema: "uneffect-resource-protocol/v1",
      resources: [...identities].map(([id, event]) => ({ id, label: event.resource, kind: "Transferable", initialState: "available" as const })),
      transitions,
    },
    unsupported,
  };
}

/** Compatibility evaluator used while the legacy ownership checker migrates. */
export function checkOwnershipWithResourceProtocol(events: readonly OwnershipEvent[]): OwnershipDiagnostic[] {
  const projection = lowerOwnershipEventsToResourceProtocol(events);
  const evaluation = evaluateResourceProtocol(projection.model);
  return evaluation.diagnostics.flatMap((diagnostic): OwnershipDiagnostic[] => {
    if (diagnostic.code !== "invalid-transition" || diagnostic.at === undefined) return [];
    const event = events[diagnostic.at];
    if (!event) return [];
    const identity = event.regionId ?? event.resource;
    const priorTransfer = events.slice(0, diagnostic.at).findLast((candidate) =>
      (candidate.regionId ?? candidate.resource) === identity && candidate.operation === "transfer");
    const state: OwnershipState = priorTransfer?.transferState
      ?? (diagnostic.state === "invalidated" ? "detached" : diagnostic.state === "transferred" ? "transferred" : "available");
    return [{
      resource: event.resource,
      operation: event.operation,
      state,
      span: event.span,
      ...(event.regionId ? { regionId: event.regionId } : {}),
      ...(event.transferState ? { transferState: event.transferState } : {}),
      message: event.operation === "transfer"
        ? `${event.resource} was already ${state}`
        : `cannot ${event.operation} ${event.resource} after it became ${state}`,
    }];
  });
}

function checkLinearOwnership(events: readonly OwnershipEvent[]): OwnershipDiagnostic[] {
  const states = new Map<string, OwnershipState>();
  const diagnostics: OwnershipDiagnostic[] = [];
  for (const event of events) {
    const identity = event.regionId ?? event.resource;
    const state = states.get(identity) ?? (event.transferState === "shared" ? "shared" : "available");
    if (event.operation === "transfer") {
      if (state === "shared" || state !== "available") diagnostics.push({ ...event, state, message: state === "shared" ? `${event.resource} is shared and is not Transferable` : `${event.resource} was already ${state}` });
      else states.set(identity, event.transferState ?? "transferred");
    } else if ((event.operation === "read" || event.operation === "mutate") && !["available", "shared"].includes(state)) {
      diagnostics.push({ ...event, state, message: `cannot ${event.operation} ${event.resource} after it became ${state}` });
    }
  }
  return diagnostics;
}

export function checkOwnership(events: readonly OwnershipEvent[]): OwnershipDiagnostic[] {
  const conditionIds = [...new Set(events.flatMap((event) => event.controlPath?.map(({ id }) => id) ?? []))];
  const choiceDomains = new Map<number, number>();
  for (const event of events) for (const choice of event.choicePath ?? []) choiceDomains.set(choice.id, choice.alternatives);
  if (conditionIds.length === 0 && choiceDomains.size === 0 && !events.some((event) => event.repeatable)) return checkLinearOwnership(events);
  const pathCount = 2 ** conditionIds.length * [...choiceDomains.values()].reduce((total, size) => total * size, 1);
  if (pathCount > 256) return events.filter((event) => event.controlPath?.length || event.choicePath?.length).map((event) => ({
    ...event, state: "unknown" as const, message: `ownership control-flow exceeds the 8-condition analysis budget`,
  }));
  const observed = new Map<string, { diagnostic: OwnershipDiagnostic; count: number; states: Set<OwnershipState> }>();
  const choiceEntries = [...choiceDomains];
  for (let pathIndex = 0; pathIndex < pathCount; pathIndex++) {
    const mask = pathIndex % (2 ** conditionIds.length);
    const assignment = new Map(conditionIds.map((id, index) => [id, (mask & (1 << index)) !== 0]));
    let choiceIndex = Math.floor(pathIndex / (2 ** conditionIds.length));
    const choices = new Map<number, number>();
    for (const [id, alternatives] of choiceEntries) {
      choices.set(id, choiceIndex % alternatives);
      choiceIndex = Math.floor(choiceIndex / alternatives);
    }
    const pathEvents = events.filter((event) => (event.controlPath?.every(({ id, branch }) => assignment.get(id) === branch) ?? true)
      && (event.choicePath?.every((choice) => choice.choices.includes(choices.get(choice.id)!)) ?? true));
    for (const diagnostic of checkLinearOwnership(pathEvents)) {
      const key = `${diagnostic.span.start}:${diagnostic.span.end}:${diagnostic.operation}:${diagnostic.regionId ?? diagnostic.resource}`;
      const entry = observed.get(key);
      if (entry) { entry.count++; entry.states.add(diagnostic.state); }
      else observed.set(key, { diagnostic, count: 1, states: new Set([diagnostic.state]) });
    }
  }
  const diagnostics: OwnershipDiagnostic[] = [...observed.values()].map(({ diagnostic, count, states }): OwnershipDiagnostic => count === pathCount && states.size === 1
    ? diagnostic
    : { ...diagnostic, state: "unknown" as const, message: `may ${diagnostic.operation} ${diagnostic.resource} after a conditional ownership transition` });
  for (const event of events) if (event.repeatable && event.operation === "transfer") {
    const duplicate = diagnostics.some((diagnostic) => diagnostic.operation === "transfer"
      && diagnostic.span.start === event.span.start && diagnostic.span.end === event.span.end);
    if (!duplicate) diagnostics.push({
      resource: event.resource, operation: event.operation, state: "unknown", span: event.span,
      ...(event.regionId ? { regionId: event.regionId } : {}),
      message: `may repeat transfer of ${event.resource} across loop iterations`,
    });
  }
  return diagnostics;
}

interface CollectedOwnershipEvent extends OwnershipEvent { readonly sourceNode: ts.Node }

function collectOwnershipEventRecords(program: ts.Program, source: ts.SourceFile): CollectedOwnershipEvent[] {
  const adapter = new TypeScriptFrontendAdapter(program);
  const checker = program.getTypeChecker();
  const events: Array<OwnershipEvent & { expression?: ts.Expression }> = [];
  const transferSpans: Array<{ start: number; end: number }> = [];
  const sharedWindowSources = new Map<string, string>();
  const sharedWindowRoots = new Set<string>();
  const collectSharedWindows = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)
      && node.initializer && ts.isCallExpression(node.initializer)
      && ts.isPropertyAccessExpression(node.initializer.expression)
      && node.initializer.expression.name.text === "subarray"
      && ts.isIdentifier(node.initializer.expression.expression)) {
      const builtin = resolveBuiltinTypedArrayWindowMethod(program, node.initializer) === "subarray";
      const resultId = symbolIdentityKey(resolvedSymbol(checker, node.name));
      const sourceId = symbolIdentityKey(resolvedSymbol(checker, node.initializer.expression.expression));
      if (builtin && resultId && sourceId) {
        sharedWindowSources.set(resultId, sourceId);
        sharedWindowRoots.add(sourceId);
      }
    } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)
      && ts.isVariableDeclarationList(node.parent) && (node.parent.flags & ts.NodeFlags.Const) !== 0
      && node.initializer && ts.isIdentifier(node.initializer)) {
      const resultId = symbolIdentityKey(resolvedSymbol(checker, node.name));
      const sourceId = symbolIdentityKey(resolvedSymbol(checker, node.initializer));
      if (resultId && sourceId) sharedWindowSources.set(resultId, sourceId);
    }
    ts.forEachChild(node, collectSharedWindows);
  };
  collectSharedWindows(source);
  const followImmutableAliases = (identity: string): string | undefined => {
    const seen = new Set<string>();
    let current = identity;
    while (!seen.has(current)) {
      seen.add(current);
      const next = sharedWindowSources.get(current);
      if (!next) return current;
      current = next;
    }
    return undefined;
  };
  const sharedBackingRoots = new Set([...sharedWindowRoots].flatMap((identity) => {
    const root = followImmutableAliases(identity);
    return root ? [root] : [];
  }));
  const sharedBackingRegion = (identity: string): string | undefined => {
    const root = followImmutableAliases(identity);
    return root && sharedBackingRoots.has(root) ? root : undefined;
  };
  const clauseMayBreakSwitch = (clause: ts.CaseOrDefaultClause, owner: ts.SwitchStatement): boolean => {
    let found = false;
    const visitBreak = (node: ts.Node): void => {
      if (found || (node !== clause && ts.isFunctionLike(node))) return;
      if (ts.isBreakStatement(node) && !node.label) {
        for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
          if (ts.isIterationStatement(current, false) || ts.isSwitchStatement(current)) {
            if (current === owner) found = true;
            break;
          }
        }
      }
      ts.forEachChild(node, visitBreak);
    };
    visitBreak(clause);
    return found;
  };
  const controlContextFor = (node: ts.Node): {
    controlPath: readonly { id: number; branch: boolean }[];
    choicePath: readonly { id: number; alternatives: number; choices: readonly number[] }[];
    repeatable: boolean;
  } => {
    const path: { id: number; branch: boolean }[] = [];
    const choices: { id: number; alternatives: number; choices: readonly number[] }[] = [];
    let repeatable = false;
    for (let current: ts.Node | undefined = node; current?.parent; current = current.parent) {
      const parent: ts.Node = current.parent;
      if (ts.isIfStatement(parent)) {
        if (current === parent.thenStatement) path.push({ id: parent.getStart(source), branch: true });
        else if (current === parent.elseStatement) path.push({ id: parent.getStart(source), branch: false });
      } else if ((ts.isForStatement(parent) || ts.isForInStatement(parent) || ts.isForOfStatement(parent)
        || ts.isWhileStatement(parent) || ts.isDoStatement(parent)) && current === parent.statement) {
        if (!ts.isDoStatement(parent)) path.push({ id: parent.getStart(source), branch: true });
        repeatable = true;
      } else if ((ts.isCaseClause(current) || ts.isDefaultClause(current)) && ts.isCaseBlock(parent)
        && ts.isSwitchStatement(parent.parent)) {
        const clauses = parent.clauses;
        const target = clauses.indexOf(current);
        const hasDefault = clauses.some(ts.isDefaultClause);
        const alternatives = clauses.length + (hasDefault ? 0 : 1);
        const reachesTarget: number[] = [];
        for (let selected = 0; selected < clauses.length; selected++) {
          if (selected > target) continue;
          const stopped = clauses.slice(selected, target).some((clause) => clauseMayBreakSwitch(clause, parent.parent));
          if (!stopped) reachesTarget.push(selected);
        }
        choices.push({ id: parent.parent.getStart(source), alternatives, choices: reachesTarget });
      }
    }
    return { controlPath: path.reverse(), choicePath: choices.reverse(), repeatable };
  };
  const visit = (node: ts.Node): void => {
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "DataView" && node.arguments?.[0]) {
      const symbol = checker.getSymbolAtLocation(node.expression);
      const builtin = symbol?.declarations?.some((declaration) => program.isSourceFileDefaultLibrary(declaration.getSourceFile())) ?? false;
      const buffer = node.arguments[0]!;
      if (builtin && ts.isIdentifier(buffer)) events.push({ operation: "read", resource: buffer.text, expression: buffer, span: { start: buffer.getStart(source), end: buffer.getEnd() } });
    }
    if (ts.isCallExpression(node)) {
      const resolved = adapter.resolveCall(node);
      const semanticEvents = resolved?.semantics
        ? interpretBuiltinCallSemantics(resolved.semantics, node, { symbol: resolved.symbol, span: resolved.span }) : [];
      for (const event of semanticEvents) {
        if (event.kind === "clone" && event.target.status === "resolved") {
          const value = event.target.expression;
          events.push({ operation: "clone", resource: value.getText(source), expression: value, span: { start: value.getStart(source), end: value.getEnd() } });
        } else if (event.kind === "transfer") for (const item of projectedArrayElements(event.target) ?? []) {
          events.push({ operation: "transfer", resource: item.getText(source), expression: item, transferState: adapter.ownershipKind(item), span: { start: item.getStart(source), end: item.getEnd() } });
          transferSpans.push({ start: item.getStart(source), end: item.getEnd() });
        }
      }
    }
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && !transferSpans.some((span) => node.expression.getStart(source) >= span.start && node.expression.getEnd() <= span.end)) {
      const parent = node.parent;
      const mutate = ts.isBinaryExpression(parent) && parent.left === node && parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment;
      events.push({ operation: mutate ? "mutate" : "read", resource: node.expression.text, expression: node.expression, span: { start: node.getStart(source), end: node.getEnd() } });
    }
    if (ts.isElementAccessExpression(node) && ts.isIdentifier(node.expression)
      && !transferSpans.some((span) => node.expression.getStart(source) >= span.start && node.expression.getEnd() <= span.end)) {
      const parent = node.parent;
      const mutate = ts.isBinaryExpression(parent) && parent.left === node
        && parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment;
      events.push({ operation: mutate ? "mutate" : "read", resource: node.expression.text, expression: node.expression, span: { start: node.getStart(source), end: node.getEnd() } });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  const reviewedUses = events.flatMap((event) => event.expression ? [event.expression] : []);
  return events.flatMap(({ expression, ...event }): CollectedOwnershipEvent[] => {
    if (!expression) return [];
    const { controlPath, choicePath, repeatable } = controlContextFor(expression);
    const withControl = controlPath.length || choicePath.length || repeatable
      ? { ...event, ...(controlPath.length ? { controlPath } : {}), ...(choicePath.length ? { choicePath } : {}), ...(repeatable ? { repeatable: true } : {}) }
      : event;
    if (ts.isIdentifier(expression)) {
      const identity = symbolIdentityKey(resolvedSymbol(checker, expression));
      const backing = identity ? sharedBackingRegion(identity) : undefined;
      if (backing) return [{ ...withControl, regionId: backing, sourceNode: expression }];
    }
    let scope: ts.Node = source;
    for (let current: ts.Node | undefined = expression.parent; current; current = current.parent) {
      if (ts.isFunctionLike(current)) { scope = current; break; }
    }
    const region = resolveStableRegion(checker, expression, { scope, permittedUse: expression, permittedUses: reviewedUses });
    if (region.status === "resolved" && !region.runtimeDescriptorUnchecked) return [{ ...withControl, resource: region.region, regionId: region.regionId, sourceNode: expression }];
    const identity = ts.isIdentifier(expression) ? symbolIdentityKey(resolvedSymbol(checker, expression)) : undefined;
    return [{ ...(identity ? { ...withControl, regionId: identity } : withControl), sourceNode: expression }];
  }).sort((a, b) => a.span.start - b.span.start || (a.operation === "transfer" ? -1 : 1));
}

export function collectOwnershipEvents(program: ts.Program, source: ts.SourceFile): OwnershipEvent[] {
  return collectOwnershipEventRecords(program, source).map(({ sourceNode: _sourceNode, ...event }) => event);
}

function ownershipState(state: ResourceProtocolState): OwnershipState {
  if (state === "invalidated") return "detached";
  if (state === "transferred") return "transferred";
  if (state === "available") return "available";
  return "unknown";
}

function enclosingFunction(node: ts.Node): ts.FunctionLikeDeclaration | undefined {
  for (let current: ts.Node | undefined = node; current; current = current.parent) {
    if (ts.isFunctionLike(current) && "body" in current && current.body) return current as ts.FunctionLikeDeclaration;
  }
  return undefined;
}

function analyzeOwnershipFunctionWithCfg(
  program: ts.Program,
  source: ts.SourceFile,
  fn: ts.FunctionLikeDeclaration,
  records: readonly CollectedOwnershipEvent[],
  callableSummaries: readonly CallableSummary[],
): OwnershipDiagnostic[] | undefined {
  if (!fn.body || records.some((event) => event.transferState === "shared")) return undefined;
  const byIdentity = new Map<string, CollectedOwnershipEvent>();
  for (const event of records) byIdentity.set(event.regionId ?? event.resource, event);
  const model: ResourceProtocolModel = {
    schema: resourceProtocolSchema,
    resources: [...byIdentity].map(([id, event]) => ({ id, label: event.resource, kind: "Transferable", initialState: "available" as const })),
    transitions: [],
  };
  const sites: ResourceTransitionSite[] = records.map((event) => ({
    node: event.sourceNode,
    transitions: [{
      kind: event.operation === "read" || event.operation === "mutate" ? "use"
        : event.operation === "clone" ? "use"
        : event.transferState === "detached" ? "invalidate" : "transfer",
      resource: event.regionId ?? event.resource,
      at: event.span.start,
      evidence: "exact",
    }],
  }));
  sites.push(...collectCallableExceptionalTransitionSites(program, fn, callableSummaries));
  const lowered = lowerResourceProtocolCfgInFunction(source, fn, model, sites, {
    budget: { name: "ownership-typescript-cfg", limit: 256 },
  });
  if (lowered.status !== "exact") return undefined;
  const evaluation = evaluateResourceProtocolCfg(lowered.cfg);
  return evaluation.diagnostics.map((diagnostic): OwnershipDiagnostic => {
    const event = diagnostic.at === undefined ? records[0] : records.find((candidate) => candidate.span.start === diagnostic.at);
    const fallback = event ?? records[0]!;
    return {
      resource: fallback.resource,
      operation: fallback.operation,
      state: ownershipState(diagnostic.state),
      span: fallback.span,
      ...(fallback.regionId ? { regionId: fallback.regionId } : {}),
      message: diagnostic.code === "cfg-unknown"
        ? `ownership control flow is unknown: ${diagnostic.message}`
        : ownershipState(diagnostic.state) === "unknown" && fallback.operation === "transfer"
          ? `may repeat transfer of ${fallback.resource} across control-flow iterations`
          : ownershipState(diagnostic.state) === "unknown"
            ? `may ${fallback.operation} ${fallback.resource} after a conditional ownership transition`
        : fallback.operation === "transfer"
          ? `${fallback.resource} may already be ${ownershipState(diagnostic.state)}`
          : `cannot ${fallback.operation} ${fallback.resource} after it became ${ownershipState(diagnostic.state)}`,
    };
  });
}

export function analyzeOwnership(program: ts.Program, source: ts.SourceFile, callableSummaries: readonly CallableSummary[] = []): OwnershipDiagnostic[] {
  const records = collectOwnershipEventRecords(program, source);
  const byFunction = new Map<ts.FunctionLikeDeclaration, CollectedOwnershipEvent[]>();
  const outside: CollectedOwnershipEvent[] = [];
  for (const record of records) {
    const fn = enclosingFunction(record.sourceNode);
    if (!fn) outside.push(record);
    else {
      const events = byFunction.get(fn) ?? [];
      events.push(record);
      byFunction.set(fn, events);
    }
  }
  const diagnostics = [...byFunction].flatMap(([fn, events]) => analyzeOwnershipFunctionWithCfg(program, source, fn, events, callableSummaries) ?? checkOwnership(events));
  if (outside.length) diagnostics.push(...checkOwnership(outside));
  return diagnostics.sort((left, right) => left.span.start - right.span.start);
}

export function generateOwnershipQuint(moduleName: string, events: readonly OwnershipEvent[]): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(moduleName)) throw new Error(`invalid Quint module name: ${moduleName}`);
  if (events.some((event) => event.controlPath?.length || event.choicePath?.length)) {
    throw new Error("conditional ownership events require CFG-aware Quint generation");
  }
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
