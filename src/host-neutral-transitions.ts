import ts from "typescript";
import { analyzeAsyncSafetyInProgram, type AsyncSafetyDiagnostic, type AsyncSafetyOptions, type ResourceDisposal } from "./async-safety.js";
import { analyzeCallableSummaries, type CallbackCardinality, type CallableSummary, type CallableSummaryDiagnostic } from "./callable-summary.js";
import type { PromiseChainModel, PromiseExecutorSettlement } from "./promise-chains.js";

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
}

export interface SettlePromiseTransition extends HostNeutralTransitionBase {
  readonly kind: "settle-promise";
  readonly promise: string;
  readonly outcomes: readonly PromiseExecutorSettlement[];
  readonly firstSettlementWins: true;
  readonly mayRemainPending: boolean;
}

export interface DisposeResourceTransition extends HostNeutralTransitionBase {
  readonly kind: "dispose-resource";
  readonly resource: string;
  readonly order: number;
  readonly completion: "throw" | "reject";
  readonly catchesFailure: boolean;
  readonly exits: ResourceDisposal["exits"];
}

export type HostNeutralTransition = InvokeCallbackTransition | SettlePromiseTransition | DisposeResourceTransition;
export type HostProfile = "web" | "node";
export type WebHostQueue = "synchronous" | "microtask" | "timer-task" | "event-task" | "external" | "unknown";
export type NodeHostQueue = "synchronous" | "next-tick" | "v8-microtask" | "timers" | "poll" | "check" | "close" | "external" | "unknown";
export interface HostScheduledTransition {
  readonly transition: HostNeutralTransition;
  readonly profile: HostProfile;
  readonly queue: WebHostQueue | NodeHostQueue;
  readonly evidence: "exact" | "unknown";
  readonly reason?: string;
}

export interface HostNeutralTransitionAnalysis {
  readonly schema: "uneffect-host-neutral-transitions/v1";
  readonly fileName: string;
  readonly transitions: readonly HostNeutralTransition[];
  readonly evidence: "inferred" | "unknown";
  readonly diagnostics: readonly (CallableSummaryDiagnostic | AsyncSafetyDiagnostic)[];
}

function transitionId(fileName: string, owner: string, kind: string, index: number, start: number): string {
  return `${fileName}:${owner}:${kind}:${index}:${start}`;
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
      : invocation.timing === "promise-reaction" ? "microtask"
      : invocation.timing === "deferred" ? "host-task" : "unknown",
    completion: invocation.completion === "propagate-throw" ? "propagate-throw"
      : invocation.completion === "convert-throw-to-rejection" ? "reject"
      : invocation.completion,
    span: invocation.span,
  }));
}

export function lowerPromiseChainTransitions(fileName: string, model: PromiseChainModel): HostNeutralTransition[] {
  const settlements = model.executors.map((executor, index): SettlePromiseTransition => ({
    kind: "settle-promise",
    id: transitionId(fileName, executor.owner, "settle", index, executor.span.start),
    fileName,
    owner: executor.owner,
    promise: executor.owner,
    lane: "inline",
    outcomes: executor.possibleSettlements,
    firstSettlementWins: true,
    mayRemainPending: executor.mayRemainPending,
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
  if (transition.lane === "external") return { queue: "external", evidence: "exact" };
  if (transition.lane === "unknown") return { queue: "unknown", evidence: "unknown", reason: "the neutral transition has no reviewed scheduling lane" };
  if (transition.kind === "invoke-callback") {
    if (transition.api === "setTimeout") return { queue: profile === "web" ? "timer-task" : "timers", evidence: "exact" };
    if (transition.api === "EventTarget.prototype.addEventListener") return profile === "web"
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

/** Connects callable, Promise, and resource analyses before a host scheduler is selected. */
export function analyzeHostNeutralTransitions(
  program: ts.Program,
  source: ts.SourceFile,
  options: AsyncSafetyOptions = {},
): HostNeutralTransitionAnalysis {
  const callables = analyzeCallableSummaries(program);
  const async = analyzeAsyncSafetyInProgram(program, source, options);
  const summaries = callables.summaries.filter((summary) => summary.fileName === source.fileName);
  const combined = composeHostNeutralTransitions(
    ...summaries.map(lowerCallableSummaryTransitions),
    lowerPromiseChainTransitions(source.fileName, async.promiseChains),
    lowerResourceDisposalTransitions(source.fileName, async.disposals),
  );
  const seenInvocations = new Set<string>();
  const transitions = combined.filter((transition) => {
    if (transition.kind !== "invoke-callback") return true;
    const key = `${transition.fileName}:${transition.span.start}:${transition.span.end}:${transition.api}`;
    if (seenInvocations.has(key)) return false;
    seenInvocations.add(key);
    return true;
  });
  const diagnostics = [
    ...callables.diagnostics.filter((diagnostic) => diagnostic.fileName === source.fileName),
    ...async.diagnostics,
  ];
  return {
    schema: "uneffect-host-neutral-transitions/v1",
    fileName: source.fileName,
    transitions,
    evidence: diagnostics.length > 0 || summaries.some((summary) => summary.evidence === "unknown") ? "unknown" : "inferred",
    diagnostics,
  };
}
