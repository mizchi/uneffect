import ts from "@typescript/typescript6";
import { bindingIdentity, type BindingIdentity } from "./binding-identity.js";
import { analyzeAsyncSafetyInProgram, type AsyncSafetyDiagnostic, type AsyncSafetyOptions, type ResourceDisposal } from "./async-safety.js";
import { analyzeAsyncPatternsInProgram, generateNodeEventLoopQuint, generateWebEventLoopQuint, type AsyncPatternModel, type TimerPattern } from "./async-patterns.js";
import { analyzeCallableSummaries, type CallbackCardinality, type CallableSummary, type CallableSummaryDiagnostic } from "./callable-summary.js";
import type { PromiseChainModel, PromiseExecutorSettlement, SynchronousDivergenceReason } from "./promise-chains.js";
import { TypeScriptFrontendAdapter } from "./frontend-adapter.js";
import { interpretBuiltinCallSemantics } from "./builtin-semantic-interpreter.js";
import { classifyLexicalExecution } from "./lexical-execution.js";
import { expressionAtExclusiveConstArgumentPath } from "./call-graph.js";
import { analyzeProgramEffects, externalContractForCall, type ExternalFunctionEffectContract } from "./effects.js";
import type { BuiltinContractRegistry } from "./builtin-contracts.js";

export type HostNeutralLane = "inline" | "microtask" | "host-task" | "external" | "unknown";
export type HostNeutralCompletion = "normal" | "propagate-throw" | "throw" | "reject" | "host-report-throw" | "unknown";

interface HostNeutralTransitionBase {
  readonly id: string;
  readonly fileName: string;
  readonly owner: string;
  readonly lane: HostNeutralLane;
  readonly span: { start: number; end: number };
}

export interface InvokeCallbackTransition extends HostNeutralTransitionBase {
  readonly kind: "invoke-callback";
  readonly callback: string;
  readonly api: string;
  readonly cardinality: CallbackCardinality;
  readonly completion: HostNeutralCompletion;
  readonly schedulingSource?: "setTimeout" | "setInterval" | "requestAnimationFrame" | "EventTarget.prototype.addEventListener";
  readonly schedulingDelay?: number;
  /** Returned Promise whose settlement receives a converted callback throw. */
  readonly promise?: string;
  readonly promiseIdentity?: BindingIdentity;
}

export interface SettlePromiseTransition extends HostNeutralTransitionBase {
  readonly kind: "settle-promise";
  readonly promise: string;
  readonly promiseIdentity?: BindingIdentity;
  readonly outcomes: readonly PromiseExecutorSettlement[];
  readonly firstSettlementWins: true;
  readonly mayRemainPending: boolean;
  readonly mayDivergeSynchronously: boolean;
  readonly synchronousDivergenceReasons: readonly SynchronousDivergenceReason[];
  readonly ownership?: {
    readonly generation: number;
    readonly status: "floating" | "transferred" | "observed";
    readonly observations: readonly string[];
  };
}

export interface DisposeResourceTransition extends HostNeutralTransitionBase {
  readonly kind: "dispose-resource";
  readonly resource: string;
  readonly order: number;
  readonly completion: "throw" | "reject";
  readonly catchesFailure: boolean;
  readonly exits: ResourceDisposal["exits"];
}

export interface AbortSignalTransition extends HostNeutralTransitionBase {
  readonly kind: "abort-signal";
  readonly controller: string;
  readonly reason: string;
  readonly conditional: boolean;
  readonly completion: "normal";
}

export type HostNeutralTransition = InvokeCallbackTransition | SettlePromiseTransition | DisposeResourceTransition | AbortSignalTransition;
export type HostProfile = "web" | "node";
export type WebHostQueue = "synchronous" | "microtask" | "timer-task" | "animation-frame" | "event-task" | "external" | "unknown";
export type NodeHostQueue = "synchronous" | "next-tick" | "v8-microtask" | "timers" | "poll" | "check" | "close" | "external" | "unknown";
export interface HostScheduledTransition {
  readonly transition: HostNeutralTransition;
  readonly profile: HostProfile;
  readonly queue: WebHostQueue | NodeHostQueue;
  readonly evidence: "exact" | "unknown";
  readonly reason?: string;
}

export interface HostCancellationLink {
  readonly timerIndex?: number;
  readonly targetTransitionId?: string;
  readonly handle: string;
  readonly definite: boolean;
  readonly compatible: boolean;
  readonly evidence: "exact" | "unknown";
  readonly span: { start: number; end: number };
}

export interface HostExternalCompletionLink {
  readonly timerIndex: number;
  readonly targetTransitionId: string;
  readonly queue: TimerPattern["queue"];
  readonly evidence: "exact";
}

export interface HostFairnessObligation {
  readonly transitionId: string;
  readonly maximumSkips: number;
  readonly assumption: "bounded-host-progress";
  readonly evidence: "assumed";
}

export interface GenerateHostTransitionModelOptions {
  readonly profile: HostProfile;
  readonly moduleName: string;
  readonly fairnessBound?: number;
  readonly fairness?: "weak" | "strong";
  readonly nodeTopLevelMode?: "commonjs" | "esm";
  readonly externalFunctionEffects?: ReadonlyMap<string, ExternalFunctionEffectContract>;
  readonly builtinRegistry?: BuiltinContractRegistry;
}

export interface HostTransitionModel {
  readonly schema: "uneffect-host-transition-model/v1";
  readonly profile: HostProfile;
  readonly transitionAnalysis: HostNeutralTransitionAnalysis;
  readonly scheduled: readonly HostScheduledTransition[];
  readonly cancellations: readonly HostCancellationLink[];
  readonly externalCompletions: readonly HostExternalCompletionLink[];
  readonly fairness: readonly HostFairnessObligation[];
  readonly fairnessProperties: readonly string[];
  readonly quint: string;
}

export interface AbortControllerSummary {
  readonly index: number;
  readonly owner: string;
  readonly binding: string;
  readonly identity: BindingIdentity;
  readonly span: { start: number; end: number };
  readonly evidence: "exact";
}

export interface AbortSignalEvent {
  readonly controllerIndex: number;
  readonly controller: string;
  readonly owner: string;
  readonly reason: string;
  readonly conditional: boolean;
  readonly synchronous: boolean;
  readonly span: { start: number; end: number };
  readonly evidence: "exact";
}

export interface AbortCompositionControllerLink {
  readonly controllerIndex: number;
  readonly controller: string;
  readonly composition: number;
  readonly source: number;
  readonly evidence: "exact";
}

export interface AbortSignalAnalysis {
  readonly controllers: readonly AbortControllerSummary[];
  readonly events: readonly AbortSignalEvent[];
  readonly compositionLinks: readonly AbortCompositionControllerLink[];
}

export interface HostNeutralTransitionAnalysis {
  readonly schema: "uneffect-host-neutral-transitions/v1";
  readonly fileName: string;
  readonly transitions: readonly HostNeutralTransition[];
  readonly evidence: "inferred" | "unknown";
  readonly diagnostics: readonly (CallableSummaryDiagnostic | AsyncSafetyDiagnostic)[];
  readonly abortSignals: AbortSignalAnalysis;
}

export interface HostNeutralTransitionAnalysisOptions extends AsyncSafetyOptions {
  readonly externalFunctionEffects?: ReadonlyMap<string, ExternalFunctionEffectContract>;
  readonly builtinRegistry?: BuiltinContractRegistry;
}

function transitionId(fileName: string, owner: string, kind: string, index: number, start: number): string {
  return `${fileName}:${owner}:${kind}:${index}:${start}`;
}

function resolvedSymbol(checker: ts.TypeChecker, node: ts.Node): ts.Symbol | undefined {
  const symbol = checker.getSymbolAtLocation(node);
  return symbol && (symbol.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(symbol) : symbol;
}

function lexicalOwner(node: ts.Node): string {
  for (let current: ts.Node | undefined = node; current; current = current.parent) {
    if (ts.isFunctionDeclaration(current) || ts.isMethodDeclaration(current) || ts.isFunctionExpression(current)) {
      if (current.name) return current.name.getText(current.getSourceFile());
    }
    if (ts.isArrowFunction(current) && ts.isVariableDeclaration(current.parent) && ts.isIdentifier(current.parent.name)) return current.parent.name.text;
  }
  return "<module>";
}

function conditionalExecution(node: ts.Node): boolean {
  let boundary: ts.Node = node.getSourceFile();
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (ts.isFunctionLike(current) || ts.isSourceFile(current)) { boundary = current; break; }
  }
  return classifyLexicalExecution(node, boundary) !== "exactly-once";
}

function synchronousFunctionExecution(node: ts.Node): boolean {
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (ts.isFunctionLike(current)) return !(ts.canHaveModifiers(current)
      && ts.getModifiers(current)?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword));
  }
  return true;
}

export function analyzeAbortSignalsInProgram(
  program: ts.Program,
  source: ts.SourceFile,
  builtinRegistry?: BuiltinContractRegistry,
): AbortSignalAnalysis {
  const checker = program.getTypeChecker();
  const adapter = new TypeScriptFrontendAdapter(program, builtinRegistry);
  const controllers: AbortControllerSummary[] = [];
  const controllerSymbols = new Map<ts.Symbol, AbortControllerSummary>();
  const collectControllers = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isNewExpression(node.initializer)) {
      const constructor = resolvedSymbol(checker, node.initializer.expression);
      const builtin = constructor?.name === "AbortController" && constructor.declarations?.some((declaration) =>
        program.isSourceFileDefaultLibrary(declaration.getSourceFile()));
      const binding = resolvedSymbol(checker, node.name);
      if (builtin && binding) {
        const identity = bindingIdentity(binding);
        if (!identity) { ts.forEachChild(node, collectControllers); return; }
        const summary: AbortControllerSummary = {
          index: controllers.length,
          owner: lexicalOwner(node),
          binding: node.name.text,
          identity,
          span: { start: node.getStart(source), end: node.getEnd() },
          evidence: "exact",
        };
        controllers.push(summary);
        controllerSymbols.set(binding, summary);
      }
    }
    ts.forEachChild(node, collectControllers);
  };
  collectControllers(source);
  const events: AbortSignalEvent[] = [];
  const collectEvents = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const resolved = adapter.resolveCall(node);
      const protocol = resolved?.semantics
        ? interpretBuiltinCallSemantics(resolved.semantics, node, { symbol: resolved.symbol, span: resolved.span }, undefined,
          { resolveStaticString: (expression) => adapter.resolveStaticString(expression) })
          .find((event) => event.kind === "protocol" && event.name === "abort-controller" && event.transition === "abort")
        : undefined;
      const controllerInput = protocol?.kind === "protocol" ? protocol.inputs.controller : undefined;
      const receiver = controllerInput?.status === "resolved" && ts.isIdentifier(controllerInput.expression)
        ? resolvedSymbol(checker, controllerInput.expression) : undefined;
      const controller = receiver ? controllerSymbols.get(receiver) : undefined;
      const reasonInput = protocol?.kind === "protocol" ? protocol.inputs.reason : undefined;
      if (controller && protocol) events.push({
        controllerIndex: controller.index,
        controller: controller.binding,
        owner: lexicalOwner(node),
        reason: reasonInput?.status === "resolved" ? reasonInput.expression.getText(source) : "AbortError",
        conditional: conditionalExecution(node),
        synchronous: synchronousFunctionExecution(node),
        span: { start: node.getStart(source), end: node.getEnd() },
        evidence: "exact",
      });
    }
    ts.forEachChild(node, collectEvents);
  };
  collectEvents(source);
  const patterns = analyzeAsyncPatternsInProgram(program, source, { builtinRegistry });
  const compositionCalls = new Map<string, ts.CallExpression>();
  const collectCompositionCalls = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) compositionCalls.set(`${node.getStart(source)}:${node.getEnd()}`, node);
    ts.forEachChild(node, collectCompositionCalls);
  };
  collectCompositionCalls(source);
  const compositionLinks = patterns.abortCompositions.flatMap((composition, compositionIndex) => {
    const call = compositionCalls.get(`${composition.span.start}:${composition.span.end}`);
    const sources = call?.arguments[0];
    if (!sources || !ts.isArrayLiteralExpression(sources)) return [];
    return sources.elements.flatMap((element, sourceIndex): AbortCompositionControllerLink[] => {
      if (!ts.isPropertyAccessExpression(element) || element.name.text !== "signal" || !ts.isIdentifier(element.expression)) return [];
      const symbol = resolvedSymbol(checker, element.expression);
      const controller = symbol ? controllerSymbols.get(symbol) : undefined;
      return controller ? [{ controllerIndex: controller.index, controller: controller.binding, composition: compositionIndex, source: sourceIndex, evidence: "exact" }] : [];
    });
  });
  return { controllers, events, compositionLinks };
}

export function lowerCallableSummaryTransitions(summary: CallableSummary): HostNeutralTransition[] {
  return summary.callbackInvocations.map((invocation, index): InvokeCallbackTransition => ({
    kind: "invoke-callback",
    id: transitionId(summary.fileName, summary.id, "callback", index, invocation.span.start),
    fileName: summary.fileName,
    owner: summary.id,
    callback: invocation.callback,
    api: invocation.api,
    cardinality: invocation.cardinality,
    lane: invocation.timing === "inline" ? "inline"
      : invocation.queue === "external" ? "external"
      : invocation.timing === "promise-reaction" ? "microtask"
      : invocation.timing === "deferred" ? "host-task" : "unknown",
    completion: invocation.completion === "propagate-throw" ? "propagate-throw"
      : invocation.completion === "convert-throw-to-rejection" ? "reject"
      : invocation.completion,
    span: invocation.span,
  }));
}

/** Lower authenticated external callback contracts at their concrete call sites. */
export function lowerExternalCallableTransitions(
  program: ts.Program,
  source: ts.SourceFile,
  contracts: ReadonlyMap<string, ExternalFunctionEffectContract>,
): { transitions: HostNeutralTransition[]; diagnostics: CallableSummaryDiagnostic[] } {
  const checker = program.getTypeChecker();
  const transitions: HostNeutralTransition[] = [], diagnostics: CallableSummaryDiagnostic[] = [];
  let index = 0;
  const promiseTarget = (call: ts.CallExpression): { promise: string; promiseIdentity?: BindingIdentity } => {
    if (ts.isVariableDeclaration(call.parent) && call.parent.initializer === call && ts.isIdentifier(call.parent.name)) {
      const symbol = resolvedSymbol(checker, call.parent.name);
      const identity = bindingIdentity(symbol);
      return { promise: call.parent.name.text, ...(identity ? { promiseIdentity: identity } : {}) };
    }
    return { promise: call.getText(source) };
  };
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const contract = externalContractForCall(checker, node, contracts);
      if (contract?.evidence === "verified") {
        const callbacks = contract.callbackParameters ?? [];
        const target = promiseTarget(node);
        const resultType = checker.getNonNullableType(checker.getTypeAtLocation(node));
        const then = checker.getPropertyOfType(resultType, "then");
        const returnsPromise = Boolean(then && checker.getTypeOfSymbolAtLocation(then, node).getCallSignatures().length > 0);
        for (const callback of callbacks) {
        const argument = node.arguments[callback.index];
        const selected = argument && callback.path?.length
          ? expressionAtExclusiveConstArgumentPath(checker, argument, callback.path, {
            call: node,
            argumentIndex: callback.index,
            preservesContainer: callback.containerAccess === "borrow-readonly",
          }) : argument;
        const span = { start: node.getStart(source), end: node.getEnd() };
        if (!selected) {
          diagnostics.push({
            fileName: source.fileName, functionName: lexicalOwner(node), span,
            message: `external callback ${callback.name} of ${contract.functionName ?? node.expression.getText(source)} cannot be resolved at its declared argument path`,
          });
        }
        if (callback.completion === "convert-throw-to-rejection" && !returnsPromise) {
          diagnostics.push({
            fileName: source.fileName, functionName: lexicalOwner(node), span,
            message: `external callback ${callback.name} converts throws to rejection but ${contract.functionName ?? node.expression.getText(source)} does not return a TypeChecker-visible Promise`,
          });
        }
        transitions.push({
          kind: "invoke-callback",
          id: transitionId(source.fileName, lexicalOwner(node), "external-callback", index++, span.start),
          fileName: source.fileName,
          owner: lexicalOwner(node),
          callback: selected?.getText(source) ?? "<unresolved>",
          api: contract.functionName ?? node.expression.getText(source),
          cardinality: callback.cardinality,
          lane: !selected ? "unknown" : callback.timing === "inline" ? "inline"
            : callback.timing === "promise-reaction" ? "microtask"
            : callback.timing === "deferred" ? "host-task" : "unknown",
          completion: !selected ? "unknown" : callback.completion === "propagate-throw" ? "propagate-throw"
            : callback.completion === "convert-throw-to-rejection" ? "reject" : callback.completion,
          ...(callback.schedulingSource ? { schedulingSource: callback.schedulingSource } : {}),
          ...(callback.schedulingDelay !== undefined ? { schedulingDelay: callback.schedulingDelay } : {}),
          ...(callback.completion === "convert-throw-to-rejection" && returnsPromise ? target : {}),
          span,
        });
      }
        if (returnsPromise && callbacks.some((callback) => callback.completion === "convert-throw-to-rejection")) {
          transitions.push({
            kind: "settle-promise",
            id: transitionId(source.fileName, lexicalOwner(node), "external-promise", index++, node.getStart(source)),
            fileName: source.fileName,
            owner: lexicalOwner(node),
            ...target,
            lane: "microtask",
            outcomes: ["fulfilled", "rejected"],
            firstSettlementWins: true,
            mayRemainPending: true,
            mayDivergeSynchronously: true,
            synchronousDivergenceReasons: ["opaque-call"],
            span: { start: node.getStart(source), end: node.getEnd() },
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { transitions, diagnostics };
}

export function lowerPromiseChainTransitions(fileName: string, model: PromiseChainModel): HostNeutralTransition[] {
  const settlements = model.executors.map((executor, index): SettlePromiseTransition => ({
    kind: "settle-promise",
    id: transitionId(fileName, executor.owner, "settle", index, executor.span.start),
    fileName,
    owner: executor.owner,
    promise: executor.binding ?? executor.owner,
    ...(executor.identity ? { promiseIdentity: executor.identity } : {}),
    lane: executor.settlementSource === "external-resolvers" ? "external" : "inline",
    outcomes: executor.possibleSettlements,
    firstSettlementWins: true,
    mayRemainPending: executor.mayRemainPending,
    mayDivergeSynchronously: executor.mayDivergeSynchronously,
    synchronousDivergenceReasons: executor.synchronousDivergenceReasons,
    span: executor.span,
  }));
  const reactions = model.chains.flatMap((chain, chainIndex) => chain.links.flatMap((link, linkIndex) =>
    link.handlers.map((handler, handlerIndex): InvokeCallbackTransition => ({
      kind: "invoke-callback",
      id: transitionId(fileName, chain.owner, `reaction-${chainIndex}-${linkIndex}`, handlerIndex, link.span.start),
      fileName,
      owner: chain.owner,
      callback: handler,
      api: `Promise.prototype.${link.kind}`,
      cardinality: "0..1",
      lane: "microtask",
      completion: "reject",
      span: link.span,
    })),
  ));
  return [...settlements, ...reactions];
}

export function lowerResourceDisposalTransitions(
  fileName: string,
  disposals: readonly ResourceDisposal[],
): HostNeutralTransition[] {
  return disposals.map((disposal, index): DisposeResourceTransition => ({
    kind: "dispose-resource",
    id: transitionId(fileName, disposal.owner, `dispose-${disposal.binding}`, index, disposal.disposalPoint),
    fileName,
    owner: disposal.owner,
    resource: disposal.binding,
    order: disposal.order,
    lane: disposal.asynchronous ? "microtask" : "inline",
    completion: disposal.failureKind,
    catchesFailure: disposal.catchesFailure,
    exits: disposal.exits,
    span: { start: disposal.disposalPoint, end: disposal.disposalPoint },
  }));
}

function asyncPatternApi(timer: TimerPattern): string {
  if (timer.queue === "timer" && timer.handleFamily === "timeout") return "setTimeout";
  if (timer.queue === "microtask") return "queueMicrotask";
  if (timer.queue === "animation-frame") return "requestAnimationFrame";
  if (timer.queue === "next-tick") return "process.nextTick";
  if (timer.queue === "check") return "setImmediate";
  return `host.${timer.queue}`;
}

export function lowerAsyncPatternTransitions(fileName: string, model: AsyncPatternModel): InvokeCallbackTransition[] {
  return model.timers.map((timer, index) => ({
    kind: "invoke-callback",
    id: transitionId(fileName, timer.owner, `async-pattern-${timer.queue}`, index, timer.span.start),
    fileName,
    owner: timer.owner,
    callback: timer.callback,
    api: asyncPatternApi(timer),
    cardinality: timer.repeats ? "0..n" : "0..1",
    lane: timer.queue === "microtask" || timer.queue === "next-tick" ? "microtask"
      : timer.externallyReady || timer.queue === "poll" || timer.queue === "close" ? "external" : "host-task",
    completion: "host-report-throw",
    span: timer.span,
  }));
}

function runActionNames(timer: TimerPattern, index: number, profile: HostProfile): string[] {
  const base = profile === "node"
    ? timer.queue === "next-tick" ? `drain_next_tick_${index}`
      : timer.queue === "microtask" ? `drain_microtask_${index}`
      : timer.queue === "check" ? `run_check_${index}`
      : timer.queue === "poll" ? `run_poll_${index}`
      : timer.queue === "close" ? `run_close_${index}` : `run_timer_${index}`
    : timer.queue === "microtask" ? `drain_microtask_${index}`
      : timer.queue === "animation-frame" ? `run_animation_frame_${index}`
      : timer.queue === "external" ? `run_external_event_${index}`
      : timer.kind === "scheduler-post-task" ? `run_scheduler_task_${index}`
      : timer.kind === "scheduler-yield" ? `run_scheduler_yield_${index}`
      : timer.kind === "abort-timeout" ? `run_abort_timeout_task_${index}` : `run_timer_task_${index}`;
  return timer.callbackAlternatives?.length
    ? timer.callbackAlternatives.map((_, alternative) => `${base}_alt_${alternative}`)
    : [base];
}

function attachExecutableFairness(
  quint: string,
  patterns: AsyncPatternModel,
  profile: HostProfile,
  kind: "weak" | "strong" | undefined,
  definitelyCancelled: ReadonlySet<string>,
  patternTransitions: readonly InvokeCallbackTransition[],
): { quint: string; properties: string[] } {
  if (!kind) return { quint, properties: [] };
  const variableNames = [...quint.matchAll(/^\s*var\s+([A-Za-z_][A-Za-z0-9_]*):/gmu)].map((match) => match[1]!);
  if (variableNames.length === 0) throw new Error("generated host model exposes no state variables for fairness");
  const declarations: string[] = ["", `  val hostFairnessVars = (${variableNames.join(", ")})`];
  const properties: string[] = [];
  patterns.timers.forEach((timer, index) => {
    const transition = patternTransitions[index]!;
    if (definitelyCancelled.has(transition.id)) return;
    const actions = runActionNames(timer, index, profile);
    const property = `fair_host_${index}`;
    if (actions.length === 1) declarations.push(`  temporal ${property} = ${actions[0]}.${kind}Fair(hostFairnessVars)`);
    else {
      const aggregate = `fair_host_action_${index}`;
      declarations.push(`  action ${aggregate} = any {`, ...actions.map((action) => `    ${action},`), "  }");
      declarations.push(`  temporal ${property} = ${aggregate}.${kind}Fair(hostFairnessVars)`);
    }
    properties.push(property);
    if (timer.externallyReady || timer.queue === "poll" || timer.queue === "close") {
      const externalProperty = `fair_external_${index}`;
      declarations.push(`  temporal ${externalProperty} = complete_${timer.queue}_${index}.${kind}Fair(hostFairnessVars)`);
      properties.push(externalProperty);
    }
  });
  const close = quint.lastIndexOf("}");
  if (close < 0) throw new Error("generated host model has no module terminator");
  return { quint: `${quint.slice(0, close).trimEnd()}\n${declarations.join("\n")}\n}\n`, properties };
}

export function composeHostNeutralTransitions(
  ...groups: readonly (readonly HostNeutralTransition[])[]
): HostNeutralTransition[] {
  const transitions = groups.flat();
  const ids = new Set<string>();
  for (const transition of transitions) {
    if (ids.has(transition.id)) throw new Error(`duplicate host-neutral transition id: ${transition.id}`);
    ids.add(transition.id);
  }
  return transitions;
}

function hostQueue(transition: HostNeutralTransition, profile: HostProfile): Omit<HostScheduledTransition, "transition" | "profile"> {
  if (transition.lane === "inline") return { queue: "synchronous", evidence: "exact" };
  if (transition.lane === "microtask") return { queue: profile === "web" ? "microtask" : "v8-microtask", evidence: "exact" };
  if (transition.lane === "external") {
    if (transition.kind === "invoke-callback" && transition.api === "host.external") return profile === "web"
      ? { queue: "event-task", evidence: "exact" }
      : { queue: "unknown", evidence: "unknown", reason: "a DOM external event has no reviewed Node/libuv phase" };
    return { queue: "external", evidence: "exact" };
  }
  if (transition.lane === "unknown") return { queue: "unknown", evidence: "unknown", reason: "the neutral transition has no reviewed scheduling lane" };
  if (transition.kind === "invoke-callback") {
    const source = transition.schedulingSource ?? transition.api;
    if (source === "setTimeout" || source === "setInterval") return { queue: profile === "web" ? "timer-task" : "timers", evidence: "exact" };
    if (source === "requestAnimationFrame") return profile === "web"
      ? { queue: "animation-frame", evidence: "exact" }
      : { queue: "unknown", evidence: "unknown", reason: "requestAnimationFrame has no reviewed Node/libuv phase" };
    if (source === "EventTarget.prototype.addEventListener") return profile === "web"
      ? { queue: "event-task", evidence: "exact" }
      : { queue: "unknown", evidence: "unknown", reason: "EventTarget delivery has no single reviewed Node/libuv phase" };
  }
  return { queue: "unknown", evidence: "unknown", reason: `host-task ${transition.kind} has no reviewed ${profile} queue mapping` };
}

export function lowerHostNeutralTransitions(
  transitions: readonly HostNeutralTransition[],
  profile: HostProfile,
): HostScheduledTransition[] {
  return transitions.map((transition) => ({ transition, profile, ...hostQueue(transition, profile) }));
}

export function lowerAbortSignalTransitions(fileName: string, analysis: AbortSignalAnalysis): AbortSignalTransition[] {
  return analysis.events.map((event, index) => ({
    kind: "abort-signal",
    id: transitionId(fileName, event.owner, `abort-${event.controller}`, index, event.span.start),
    fileName,
    owner: event.owner,
    controller: event.controller,
    reason: event.reason,
    conditional: event.conditional,
    lane: "inline",
    completion: "normal",
    span: event.span,
  }));
}

function appendExternalPromiseReactions(
  model: PromiseChainModel,
  transitions: readonly HostNeutralTransition[],
): PromiseChainModel {
  const executors = [...model.executors], chains = [...model.chains];
  for (const transition of transitions) {
    if (transition.kind !== "invoke-callback" || transition.lane !== "microtask"
      || transition.completion !== "reject" || !transition.promise) continue;
    const executor = executors.length;
    executors.push({
      owner: transition.owner,
      binding: transition.promise,
      ...(transition.promiseIdentity ? { identity: transition.promiseIdentity } : {}),
      callback: `<external:${transition.api}>`,
      synchronous: true,
      throwBecomesRejection: true,
      settlementSource: "external-resolvers",
      events: [],
      possibleSettlements: ["fulfilled", "rejected"],
      mayRemainPending: true,
      mayDivergeSynchronously: true,
      synchronousDivergenceReasons: ["opaque-call"],
      span: transition.span,
    });
    chains.push({
      owner: transition.owner,
      source: transition.promise,
      executor,
      links: [{
        kind: "then",
        handlers: [transition.callback],
        handlerReturns: ["unknown"],
        span: transition.span,
      }],
      span: transition.span,
    });
  }
  return { executors, thenables: [...model.thenables], chains };
}

/** Connects callable, Promise, and resource analyses before a host scheduler is selected. */
export function analyzeHostNeutralTransitions(
  program: ts.Program,
  source: ts.SourceFile,
  options: HostNeutralTransitionAnalysisOptions = {},
): HostNeutralTransitionAnalysis {
  const callables = analyzeCallableSummaries(program, analyzeProgramEffects(program, {
    requireAnnotations: false,
    builtinRegistry: options.builtinRegistry,
    externalFunctionEffects: options.externalFunctionEffects,
  }), options.builtinRegistry);
  const async = analyzeAsyncSafetyInProgram(program, source, options);
  const abortSignals = analyzeAbortSignalsInProgram(program, source, options.builtinRegistry);
  const summaries = callables.summaries.filter((summary) => summary.fileName === source.fileName);
  const external = options.externalFunctionEffects
    ? lowerExternalCallableTransitions(program, source, options.externalFunctionEffects)
    : { transitions: [], diagnostics: [] };
  const combined = composeHostNeutralTransitions(
    ...summaries.map(lowerCallableSummaryTransitions),
    external.transitions,
    lowerPromiseChainTransitions(source.fileName, async.promiseChains),
    lowerResourceDisposalTransitions(source.fileName, async.disposals),
    lowerAbortSignalTransitions(source.fileName, abortSignals),
  );
  const ownershipByIdentity = new Map(async.promiseBindings.flatMap((binding) => binding.identity
    ? [[`${binding.identity.fileName}:${binding.identity.declarationStart}`, binding] as const] : []));
  const seenInvocations = new Set<string>();
  const transitions = combined.filter((transition) => {
    if (transition.kind !== "invoke-callback") return true;
    const key = `${transition.fileName}:${transition.span.start}:${transition.span.end}:${transition.api}`;
    if (seenInvocations.has(key)) return false;
    seenInvocations.add(key);
    return true;
  }).map((transition): HostNeutralTransition => {
    if (transition.kind !== "settle-promise" || !transition.promiseIdentity) return transition;
    const binding = ownershipByIdentity.get(`${transition.promiseIdentity.fileName}:${transition.promiseIdentity.declarationStart}`);
    return binding ? { ...transition, ownership: {
      generation: binding.generation, status: binding.status, observations: binding.observations,
    } } : transition;
  });
  const diagnostics = [
    ...callables.diagnostics.filter((diagnostic) => diagnostic.fileName === source.fileName),
    ...external.diagnostics,
    ...async.diagnostics,
  ];
  return {
    schema: "uneffect-host-neutral-transitions/v1",
    fileName: source.fileName,
    transitions,
    evidence: diagnostics.length > 0 || summaries.some((summary) => summary.evidence === "unknown") ? "unknown" : "inferred",
    diagnostics,
    abortSignals,
  };
}

export function generateHostTransitionModel(
  program: ts.Program,
  source: ts.SourceFile,
  options: GenerateHostTransitionModelOptions,
): HostTransitionModel {
  if (options.fairnessBound !== undefined && (!Number.isSafeInteger(options.fairnessBound) || options.fairnessBound < 0)) {
    throw new Error("fairnessBound must be a non-negative safe integer");
  }
  const transitionAnalysis = analyzeHostNeutralTransitions(program, source, {
    externalFunctionEffects: options.externalFunctionEffects,
    builtinRegistry: options.builtinRegistry,
  });
  const asyncSafety = analyzeAsyncSafetyInProgram(program, source);
  const patterns = analyzeAsyncPatternsInProgram(program, source, { builtinRegistry: options.builtinRegistry });
  for (const transition of transitionAnalysis.transitions) {
    if (transition.kind !== "invoke-callback" || !transition.schedulingSource) continue;
    const queue = transition.schedulingSource === "setTimeout" || transition.schedulingSource === "setInterval" ? "timer"
      : transition.schedulingSource === "requestAnimationFrame" ? "animation-frame"
      : options.profile === "web" ? "external" : undefined;
    if (!queue || queue === "timer" && transition.schedulingDelay === undefined) continue;
    patterns.timers.push({
      owner: transition.owner, callback: transition.callback,
      recursive: false, repeats: transition.schedulingSource === "setInterval",
      ...(queue === "timer" ? { delay: transition.schedulingDelay } : {}),
      queue, ...(queue === "timer" ? { handleFamily: "timeout" as const }
        : queue === "animation-frame" ? { handleFamily: "animation-frame" as const } : {}),
      span: transition.span,
    });
  }
  for (const link of transitionAnalysis.abortSignals.compositionLinks) {
    const event = transitionAnalysis.abortSignals.events.find((candidate) =>
      candidate.controllerIndex === link.controllerIndex && candidate.synchronous && !candidate.conditional);
    const composition = patterns.abortCompositions[link.composition];
    if (!event || !composition || composition.initiallyAbortedSource !== undefined) continue;
    composition.initiallyAbortedSource = link.source;
    composition.sourceReasons[link.source] = event.reason;
    for (const timer of patterns.timers) if (timer.abortComposition === link.composition) timer.initiallyCancelled = true;
  }
  const patternTransitions = lowerAsyncPatternTransitions(source.fileName, patterns);
  const patternSpans = new Set(patternTransitions.map((transition) => `${transition.span.start}:${transition.span.end}`));
  const transitions = composeHostNeutralTransitions(
    patternTransitions,
    transitionAnalysis.transitions.filter((transition) => transition.kind !== "invoke-callback"
      || !patternSpans.has(`${transition.span.start}:${transition.span.end}`)),
  );
  const scheduled = lowerHostNeutralTransitions(transitions, options.profile);
  const cancellations = patterns.cancellations.map((cancellation): HostCancellationLink => {
    const target = cancellation.timer === undefined ? undefined : patternTransitions[cancellation.timer];
    const exact = target !== undefined && cancellation.compatible === true;
    return {
      timerIndex: cancellation.timer,
      targetTransitionId: target?.id,
      handle: cancellation.handle,
      definite: cancellation.definite,
      compatible: cancellation.compatible === true,
      evidence: exact ? "exact" : "unknown",
      span: cancellation.span,
    };
  });
  const externalCompletions = patterns.timers.flatMap((timer, timerIndex): HostExternalCompletionLink[] =>
    timer.externallyReady || timer.queue === "poll" || timer.queue === "close"
      ? [{ timerIndex, targetTransitionId: patternTransitions[timerIndex]!.id, queue: timer.queue, evidence: "exact" }]
      : [],
  );
  const definitelyCancelled = new Set(cancellations.flatMap((cancellation) =>
    cancellation.definite && cancellation.targetTransitionId ? [cancellation.targetTransitionId] : []));
  const fairness = options.fairnessBound === undefined ? [] : scheduled.flatMap((item): HostFairnessObligation[] =>
    item.evidence === "exact" && item.queue !== "synchronous" && !definitelyCancelled.has(item.transition.id)
      ? [{ transitionId: item.transition.id, maximumSkips: options.fairnessBound!, assumption: "bounded-host-progress", evidence: "assumed" }]
      : [],
  );
  const promiseModel = appendExternalPromiseReactions(asyncSafety.promiseChains, transitionAnalysis.transitions);
  const hostQuint = options.profile === "web"
    ? generateWebEventLoopQuint(options.moduleName, patterns, {}, promiseModel)
    : generateNodeEventLoopQuint(options.moduleName, patterns, { topLevelMode: options.nodeTopLevelMode ?? "commonjs" }, promiseModel);
  const executableFairness = attachExecutableFairness(
    hostQuint, patterns, options.profile, options.fairness, definitelyCancelled, patternTransitions,
  );
  return {
    schema: "uneffect-host-transition-model/v1",
    profile: options.profile,
    transitionAnalysis: { ...transitionAnalysis, transitions },
    scheduled,
    cancellations,
    externalCompletions,
    fairness,
    fairnessProperties: executableFairness.properties,
    quint: executableFairness.quint,
  };
}
