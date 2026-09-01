import { createHash } from "node:crypto";
import ts from "typescript";
import { joinFlowValues, solveBasicBlockFixedPoint } from "./refinement-flow.js";
import {
  findHandlerJoinCandidates,
  HANDLER_CONTROL_ROOT_LIMIT,
  HANDLER_NESTED_TRY_ROOT_LIMIT,
  runHandlerJoinFixedPoint,
  type HandlerCompletionKind,
  type HandlerJoinCandidate,
} from "./refinement-handler-flow.js";
import { extractAnnotations, extractLocatedAnnotations } from "./annotations.js";
import type { ModelRefinementAdapter, ModelState } from "./model-replay.js";
import type { TemporalSpec } from "./spec-ir.js";
import type { TemporalBinaryOperator, TemporalExpression, TemporalValueType } from "./temporal-expressions.js";
import { formatTemporalValueType, generateRuntimeAssertionExpression, parseTemporalExpression } from "./temporal-expressions.js";
import { checkTemporalExpressionEquivalenceUnderAssumptionsWithZ3, checkTemporalExpressionEquivalenceWithZ3 } from "./spec-lint.js";
import type { Z3ExecutionOptions } from "./z3.js";
import {
  breakTransferTarget,
  continueTransferTarget,
  isTransferOwnedByLoop,
  type AbruptCompletion,
  type CompletionSummary,
} from "./completion-flow.js";
import {
  parseRefinementRuntimeIdentity,
  type RefinementRuntimeIdentity,
} from "./runtime-identities.js";
import { resolveStableRegion } from "./region-alias.js";

export type RefinementBindingRole = "create" | "observe" | "action" | "invariant";

export interface RefinementBinding {
  adapterName: string;
  version: string;
  role: RefinementBindingRole;
  modelName?: string;
  exportName: string;
  span: { start: number; end: number };
}

export interface RefinementBindingManifest {
  schema: "uneffect-refinement-bindings/v1";
  fileName: string;
  adapterName: string;
  version: string;
  runtimeIdentity?: RefinementRuntimeIdentity;
  create: string;
  observe: string;
  abstractions: Record<string, string>;
  actions: Record<string, string>;
  invariants: Record<string, string>;
}

export type RefinementBindingCoverageCode =
  | "missing-action-binding"
  | "unknown-action-binding"
  | "missing-invariant-binding"
  | "unknown-invariant-binding";

export interface RefinementBindingCoverageDiagnostic {
  code: RefinementBindingCoverageCode;
  adapterName: string;
  modelName: string;
  exportName?: string;
  message: string;
}

export type RefinementActionDiagnosticCode =
  | "missing-action-binding" | "unknown-action-binding"
  | "missing-action-guard" | "unexpected-action-guard" | "action-guard-mismatch"
  | "unsupported-action-body" | "action-update-mismatch";

export interface RefinementActionDiagnostic {
  code: RefinementActionDiagnosticCode;
  adapterName: string;
  modelName: string;
  exportName?: string;
  target?: string;
  expected?: string;
  actual?: string;
  message: string;
}

/** A declaration-bound action fact established in another TypeScript project. */
export interface ExternalRefinementActionContract {
  adapterName: string;
  version: string;
  modelName: string;
  exportName: string;
  runtimeIdentity?: RefinementRuntimeIdentity;
  /** Guard proved by the producer action body. The consumer may inherit it only through an exact sole direct call. */
  guard?: TemporalExpression;
  assignments: readonly { target: string; expressionAst: TemporalExpression }[];
  evidence: "verified" | "unknown";
  reason?: string;
}

export interface RefinementActionValidationOptions {
  /** Keys are `${declaration source file}:${declaration start}` identities in the consuming Program. */
  externalActions?: ReadonlyMap<string, ExternalRefinementActionContract>;
}

export interface RefinementActionProofBudget {
  /** Maximum monotone worklist rounds for one supported CFG loop seed. */
  cfgFixedPointIterations: number;
}

export const DEFAULT_REFINEMENT_ACTION_PROOF_BUDGET: Readonly<RefinementActionProofBudget> = {
  cfgFixedPointIterations: 64,
};

export interface RefinementActionAnalysisOptions {
  proofBudget?: Partial<RefinementActionProofBudget>;
}

interface RefinementTryCatchValueTrace {
  readonly modelName: string;
  readonly tryStart: number;
  readonly throwValue: TemporalExpression;
  readonly throwWhen: TemporalExpression;
  readonly tryUpdates: ReadonlyMap<string, TemporalExpression>;
  readonly catchUpdates: ReadonlyMap<string, TemporalExpression>;
}

interface RefinementRankingRecurrenceTrace {
  readonly modelName: string;
  readonly loopStart: number;
  readonly counterName: string;
  readonly counterDelta: number;
  readonly direction: "increase" | "decrease";
  readonly bound: number;
  readonly stop: number;
  readonly guard: TemporalExpression;
  readonly iterationUpdates: ReadonlyMap<string, TemporalExpression>;
  readonly summaryUpdates: ReadonlyMap<string, TemporalExpression>;
  readonly affineDependencies?: RefinementAffineDependencies;
  readonly booleanInvolutions?: RefinementBooleanInvolutions;
  readonly boundedSelfAffine?: RefinementBoundedSelfAffineTrace;
}

interface RefinementBoundedSelfAffineTrace {
  readonly rule: "precondition-bounded-self-affine" | "precondition-bounded-guarded-self-affine";
  readonly state: string;
  readonly counter: string;
  readonly multiplier: number;
  readonly precondition: {
    readonly expression: TemporalExpression;
    readonly text: string;
    readonly span: { start: number; end: number };
  };
  readonly budget: {
    readonly name: "cfg-recurrence-geometric-iterations";
    readonly limit: 8;
    readonly observed: number;
  };
  readonly update: { readonly state: string; readonly span: { start: number; end: number } };
  readonly activation?: {
    readonly selector: string;
    readonly when: boolean;
    readonly predecessor: "catch";
  };
}

export interface RefinementBoundedSelfAffine {
  readonly rule: "precondition-bounded-self-affine" | "precondition-bounded-guarded-self-affine";
  readonly state: string;
  readonly counter: string;
  readonly multiplier: number;
  readonly precondition: {
    readonly expression: string;
    readonly span: { start: number; end: number };
  };
  readonly budget: {
    readonly name: "cfg-recurrence-geometric-iterations";
    readonly limit: 8;
    readonly observed: number;
  };
  readonly update: { readonly state: string; readonly span: { start: number; end: number } };
  readonly activation?: {
    readonly selector: string;
    readonly when: boolean;
    readonly predecessor: "catch";
  };
}

export interface RefinementAffineDependencies {
  readonly rule: "source-ordered-upper-triangular-affine";
  readonly order: readonly [string, string];
  readonly updates: readonly [
    { state: string; span: { start: number; end: number } },
    { state: string; span: { start: number; end: number } },
  ];
  readonly edges: readonly [{ from: string; to: string; read: "entry" | "updated" }];
}

export interface RefinementBooleanInvolutions {
  readonly rule: "source-bound-boolean-involution";
  readonly budget: {
    readonly name: "cfg-recurrence-boolean-involutions";
    readonly limit: 1;
    readonly observed: 1;
  };
  readonly updates: readonly [{ state: string; span: { start: number; end: number } }];
}

interface RefinementHandlerValueJoinTrace {
  readonly modelName: string;
  readonly condition: TemporalExpression;
}

interface RefinementHandlerRegionTrace {
  readonly modelName: string;
  readonly tryStart: number;
  readonly tryEnd: number;
  readonly entry: ReadonlyMap<string, TemporalExpression>;
  readonly exit: ReadonlyMap<string, TemporalExpression>;
}

interface RefinementAliasRegionTrace {
  readonly modelName: string;
  readonly aliasName: string;
  readonly aliasSpan: { start: number; end: number };
  readonly helperName: string;
  readonly helperCallSpan: { start: number; end: number };
  readonly helperDeclarationSpan: { start: number; end: number };
  readonly helperDeclarationFile: string;
  readonly helperSymbolIdentity: string;
  readonly capabilityDeclaration: string;
}

interface RefinementActionTraceSink {
  readonly tryCatchJoins: RefinementTryCatchValueTrace[];
  readonly rankingRecurrences: RefinementRankingRecurrenceTrace[];
  readonly handlerValueJoins: RefinementHandlerValueJoinTrace[];
  readonly handlerRegions: RefinementHandlerRegionTrace[];
  readonly aliasRegions: RefinementAliasRegionTrace[];
}

export interface RefinementHandlerRecurrenceValueLattice {
  throwPayloads: readonly string[];
  normalSnapshots: readonly string[];
  expressionSnapshots: {
    tryNormal: Readonly<Record<string, string>>;
    catchNormal: Readonly<Record<string, string>>;
    joinedNormal: Readonly<Record<string, string>>;
  };
}

export interface RefinementScalarRecurrenceObligation {
  kind: "scalar-recurrence-fixed-point";
  adapterName: string;
  modelName: string;
  exportName: string;
  loopSpan: { start: number; end: number };
  status: "verified" | "unknown";
  reason?: "independent-proof-required" | "proof-budget-exhausted" | "lattice-conflict"
    | "unsupported-recurrence" | "action-validation-failed"
    | "recurrence-proof-refuted" | "recurrence-proof-unknown";
  budget: { name: "cfg-recurrence-iterations"; limit: number };
  backEdge: {
    from: string;
    to: string;
    rule: "source-bound-affine-transformer";
  };
  controlJoins?: readonly ({
    kind: "loop-invariant-cfg-diamond";
    order: 0 | 1;
    selector: { kind: "boolean-state"; state: string };
    rule: "predicate-correlated-affine-phi";
    predecessors: readonly [
      { branch: "then"; block: string },
      { branch: "else"; block: string },
    ];
    join: string;
  } | {
    kind: "loop-invariant-cfg-switch";
    order: 0 | 1;
    selector: { kind: "integer-state"; state: string };
    rule: "finite-literal-affine-phi";
    budget: {
      name: "cfg-recurrence-switch-cases";
      limit: 2;
      observed: 2;
    };
    predecessors: readonly [
      { case: string; block: string },
      { case: string; block: string },
      { case: "default"; block: string },
    ];
    join: string;
  } | {
    kind: "loop-invariant-cfg-value-join";
    order: 0 | 1;
    selector: { kind: "boolean-state"; state: string };
    rule: "source-bound-predecessor-value-phi";
    budget: {
      name: "cfg-recurrence-value-joins";
      limit: 1;
      observed: 1;
    };
    span: { start: number; end: number };
    predecessors: readonly [
      { branch: "then"; block: string; value: string },
      { branch: "else"; block: string; value: string },
    ];
    join: string;
  })[];
  affineDependencies?: RefinementAffineDependencies;
  booleanInvolutions?: RefinementBooleanInvolutions;
  boundedSelfAffine?: RefinementBoundedSelfAffine;
  memberBudget: {
    name: "cfg-recurrence-members";
    limit: 2 | 3 | 8;
    observed: number;
  };
  handlerCompletion?: {
    rule: "source-bound-handler-predecessors";
    trySpan: { start: number; end: number };
    predecessors: readonly ["normal", "throw"];
    retainedThrowPayload: boolean;
    retainedNormalSnapshot: boolean;
    mandatoryFinally: boolean;
    blocks: readonly string[];
    valueLattice: RefinementHandlerRecurrenceValueLattice;
  };
  fixedPoint: {
    iterations: number;
    converged: boolean;
    recurrence?: RefinementRankingRecurrenceEvidence;
    members: readonly {
      state: string;
      role: "ranking" | "scalar";
    }[];
  };
  recurrenceProof?: RefinementRecurrenceProof;
}

export interface RefinementHandlerJoinObligation {
  kind: "handler-join-fixed-point";
  adapterName: string;
  modelName: string;
  exportName: string;
  trySpan: { start: number; end: number };
  controlSpan: { start: number; end: number };
  controlShape: "if" | "switch" | "for-of" | "try";
  controlRoots: readonly {
    span: { start: number; end: number };
    shape: "if" | "switch" | "for-of" | "try";
  }[];
  controlRootBudget: {
    name: "handler-control-roots";
    limit: 2 | 3;
    observed: number;
  };
  finiteLoopBudget?: {
    name: "handler-loop-iterations";
    limit: 4;
    observed: number;
  };
  handlerNestingBudget?: {
    name: "handler-nesting-depth";
    limit: 2;
    observed: number;
  };
  controlRegion: "try" | "finally";
  status: "verified" | "unknown";
  reason?: "proof-budget-exhausted" | "unsupported-control-flow" | "action-validation-failed";
  budget: {
    name: "cfg-fixed-point-iterations";
    limit: number;
  };
  fixedPoint: {
    iterations: number;
    converged: boolean;
    blockCompletions: Readonly<Record<string, readonly HandlerCompletionKind[]>>;
  };
  completionJoin: {
    incoming: readonly HandlerCompletionKind[];
    outgoing: readonly HandlerCompletionKind[];
    caughtThrow: boolean;
    mandatoryFinally: boolean;
    finallyOverrides: readonly Extract<HandlerCompletionKind, "return" | "throw">[];
  };
  pathCorrelation?: {
    caughtWhen: string;
    rule: "same-predicate-branch-restriction";
  };
}

export interface RefinementLocalAliasHelperObligation {
  kind: "local-alias-helper";
  adapterName: string;
  modelName: string;
  exportName: string;
  status: "verified";
  evidence: "typescript-program";
  alias: {
    name: string;
    mutableObject: true;
    binding: "const";
    span: { start: number; end: number };
    regionId: string;
  };
  helper: {
    name: string;
    callSpan: { start: number; end: number };
    declarationSpan: { start: number; end: number };
    declarationFile: string;
    symbolIdentity: string;
  };
  capabilityCorrelation: {
    aliasRegion: string;
    declaration: string;
    rule: "source-correlated-not-equivalent";
  };
}

export interface RefinementHandlerScalarEnvironmentObligation {
  kind: "handler-scalar-environment-join";
  adapterName: string;
  modelName: string;
  exportName: string;
  status: "verified" | "unknown";
  reason?: "independent-proof-required" | "lattice-conflict" | "proof-budget-exhausted"
    | "region-budget-exhausted" | "scalar-cardinality-unsupported" | "unsupported-scalar-environment" | "scalar-proof-refuted"
    | "scalar-proof-unknown" | "predicate-correlation-lost";
  budget: { name: "cfg-fixed-point-iterations"; limit: number };
  regionBudget: { name: "handler-scalar-regions"; limit: 3; observed: number };
  fixedPoint: {
    iterations: number;
    converged: boolean;
    members: readonly {
      state: string;
      expected: string;
      actual: string;
      regions: readonly {
        id: string;
        span: { start: number; end: number };
        entry: string;
        exit: string;
      }[];
    }[];
  };
  conditionalJoin?: {
    kind: "if-handler-predecessors";
    predicate: string;
    rule: "predicate-correlated-phi";
    predecessors: readonly {
      branch: "then" | "else";
      regionId: string;
      span: { start: number; end: number };
    }[];
    successorRegionId: string;
  };
  proof?: {
    backend: "z3";
    status: "verified" | "refuted" | "unknown";
    checks: readonly {
      state: string;
      status: "verified" | "refuted" | "unknown";
      reason?: string;
    }[];
  };
}

export type RefinementActionObligation = RefinementScalarRecurrenceObligation
  | RefinementHandlerJoinObligation
  | RefinementHandlerScalarEnvironmentObligation
  | RefinementLocalAliasHelperObligation;

export interface RefinementRankingRecurrenceEvidence {
  counter: string;
  direction: "increase" | "decrease";
  delta: number;
  bound: number;
  stop: number;
  guard: string;
  iteration: Readonly<Record<string, string>>;
  summary: Readonly<Record<string, string>>;
  assumptions?: readonly string[];
  boundedSelfAffine?: RefinementBoundedSelfAffine;
  stable: boolean;
}

export interface RefinementActionAnalysis {
  schema: "uneffect-refinement-action-analysis/v2";
  schemaVersion: 2;
  fileName: string;
  adapterName: string;
  sourceDigest: string;
  typescriptVersion: string;
  diagnostics: RefinementActionDiagnostic[];
  obligations: RefinementActionObligation[];
}

export type RefinementInvariantDiagnosticCode = "missing-invariant-binding" | "unknown-invariant-binding" | "unsupported-invariant-body" | "invariant-expression-mismatch";

export interface RefinementInvariantDiagnostic {
  code: RefinementInvariantDiagnosticCode;
  adapterName: string;
  modelName: string;
  exportName?: string;
  expected?: string;
  actual?: string;
  message: string;
}

const refinementMismatchExpressions = new WeakMap<object, {
  expected: TemporalExpression;
  actual: TemporalExpression;
}>();

export type Z3RefinementDiagnostic<T> = T & {
  backend?: "z3";
  equivalence?: "different" | "unknown";
  reason?: string;
};

export type RefinementStateProjectionDiagnosticCode = "unsupported-create-body" | "unsupported-observe-body" | "create-state-mismatch" | "observe-state-mismatch" | "create-type-mismatch" | "observe-type-mismatch";

export interface RefinementStateProjectionDiagnostic {
  code: RefinementStateProjectionDiagnosticCode;
  adapterName: string;
  role: "create" | "observe";
  exportName: string;
  field?: string;
  expected?: string;
  actual?: string;
  message: string;
}

function parseBinding(value: string, exportName: string, span: { start: number; end: number }): RefinementBinding {
  const match = /^([A-Za-z_$][\w$]*)@([^\s@]+)\s+(create|observe|action\s+([A-Za-z_$][\w$]*)|invariant\s+([A-Za-z_$][\w$]*))$/.exec(value);
  if (!match) throw new Error(`invalid refinement binding on ${exportName}: ${value}`);
  const role: RefinementBindingRole = match[3] === "create" || match[3] === "observe" ? match[3] : match[4] ? "action" : "invariant";
  return { adapterName: match[1]!, version: match[2]!, role, ...(match[4] || match[5] ? { modelName: match[4] ?? match[5] } : {}), exportName, span };
}

/** Extracts function-role bindings without evaluating source expressions. */
export function extractRefinementBindings(fileName: string, text: string): RefinementBinding[] {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const bindings: RefinementBinding[] = [];
  const consumedAnnotations = new Set<string>();
  const annotationKey = (span: { start: number; end: number }): string => `${span.start}:${span.end}`;
  for (const node of source.statements) {
    if (!ts.isFunctionDeclaration(node) || !node.name) continue;
    const leading = text.slice(node.getFullStart(), node.getStart(source));
    for (const annotation of extractLocatedAnnotations(leading, "refinement", node.getFullStart())) {
      consumedAnnotations.add(annotationKey(annotation.span));
      if (!node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) throw new Error(`refinement binding target ${node.name.text} must be exported`);
      const binding = parseBinding(annotation.value, node.name.text, { start: node.getStart(source), end: node.getEnd() });
      const count = node.parameters.length;
      const validArity = binding.role === "action" ? count === 1 || count === 2 : count === 1;
      if (!validArity) throw new Error(`refinement ${binding.role} binding ${node.name.text} has ${count} parameters; expected ${binding.role === "action" ? "one runtime parameter and an optional trace-step parameter" : "exactly one parameter"}`);
      bindings.push(binding);
    }
  }
  const unsupported = extractLocatedAnnotations(text, "refinement")
    .find((annotation) => !consumedAnnotations.has(annotationKey(annotation.span)));
  if (unsupported) {
    throw new Error(`refinement annotations are supported only on top-level function declarations; unsupported annotation in ${fileName} at ${unsupported.span.start}`);
  }
  return bindings;
}

export function buildRefinementBindingManifest(fileName: string, text: string, adapterName: string): RefinementBindingManifest {
  const bindings = extractRefinementBindings(fileName, text).filter((binding) => binding.adapterName === adapterName);
  if (bindings.length === 0) throw new Error(`no refinement bindings found for ${adapterName}`);
  const versions = new Set(bindings.map((binding) => binding.version));
  if (versions.size !== 1) throw new Error(`refinement adapter ${adapterName} has inconsistent versions: ${[...versions].join(", ")}`);
  const singleton = (role: "create" | "observe"): string => {
    const matches = bindings.filter((binding) => binding.role === role);
    if (matches.length !== 1) throw new Error(`refinement adapter ${adapterName} requires exactly one ${role} binding`);
    return matches[0]!.exportName;
  };
  const named = (role: "action" | "invariant"): Record<string, string> => {
    const entries = bindings.filter((binding) => binding.role === role).map((binding) => [binding.modelName!, binding.exportName] as const);
    if (new Set(entries.map(([name]) => name)).size !== entries.length) throw new Error(`refinement adapter ${adapterName} has duplicate ${role} bindings`);
    return Object.fromEntries(entries);
  };
  const runtimeIdentities = extractAnnotations(text, "runtime").flatMap((value) => {
    const match = /^([A-Za-z_$][\w$]*)@([^\s@]+)\s*=\s*(\S+)$/.exec(value);
    if (!match) throw new Error(`invalid refinement runtime identity: ${value}`);
    if (match[1] !== adapterName) return [];
    if (match[2] !== bindings[0]!.version) {
      throw new Error(`refinement runtime identity ${match[1]} has version ${match[2]}, expected ${bindings[0]!.version}`);
    }
    const identity = parseRefinementRuntimeIdentity(match[3]!);
    if (!identity) {
      throw new Error(`unsupported refinement runtime identity: ${match[3]}; supported identities are globalThis and node:global@<major>#<realm>`);
    }
    return [identity];
  });
  if (runtimeIdentities.length > 1) throw new Error(`duplicate refinement runtime identity for ${adapterName}`);
  return {
    schema: "uneffect-refinement-bindings/v1", fileName, adapterName, version: bindings[0]!.version,
    ...(runtimeIdentities[0] ? { runtimeIdentity: runtimeIdentities[0] } : {}),
    create: singleton("create"), observe: singleton("observe"),
    abstractions: Object.fromEntries(parseAbstractionRelations(text, adapterName, bindings[0]!.version)),
    actions: named("action"), invariants: named("invariant"),
  };
}

function parseAbstractionRelations(
  text: string,
  adapterName: string,
  version: string,
  stateNames?: ReadonlySet<string>,
): Map<string, string> {
  const abstraction = new Map<string, string>();
  for (const value of extractAnnotations(text, "abstraction")) {
    const match = /^([A-Za-z_$][\w$]*)@([^\s@]+)\s+([A-Za-z_$][\w$]*)\s*=\s*(\S+)$/.exec(value);
    if (!match) throw new Error(`invalid abstraction relation: ${value}`);
    parseAbstractionValue(match[4]!);
    if (match[1] !== adapterName) continue;
    if (match[2] !== version) throw new Error(`abstraction relation ${match[1]} has version ${match[2]}, expected ${version}`);
    if (stateNames && !stateNames.has(match[3]!)) throw new Error(`abstraction relation refers to unknown model state ${match[3]}`);
    const concretePath = parseAbstractionValue(match[4]!).path;
    const overlaps = [...abstraction.values()].some((existing) => {
      const existingPath = parseAbstractionValue(existing).path;
      return existingPath === concretePath || existingPath.startsWith(`${concretePath}.`) || concretePath.startsWith(`${existingPath}.`);
    });
    if (abstraction.has(match[3]!) || overlaps) throw new Error(`duplicate or overlapping abstraction relation for ${match[3]} or ${match[4]}`);
    abstraction.set(match[3]!, match[4]!);
  }
  return abstraction;
}

function parseAbstractionValue(value: string): { kind: "identity" | "set-from-array" | "map-from-entries"; path: string } {
  const pathPattern = "[A-Za-z_$][\\w$]*(?:\\.[A-Za-z_$][\\w$]*)*";
  if (new RegExp(`^${pathPattern}$`).test(value)) return { kind: "identity", path: value };
  const set = new RegExp(`^Set\\((${pathPattern})\\)$`).exec(value);
  if (set) return { kind: "set-from-array", path: set[1]! };
  const map = new RegExp(`^Map\\((${pathPattern})\\)$`).exec(value);
  if (map) return { kind: "map-from-entries", path: map[1]! };
  throw new Error(`unsupported abstraction expression: ${value}`);
}

/** Checks structural coverage only; it does not prove that implementation bodies refine model transitions. */
export function validateRefinementBindingCoverage(
  fileName: string,
  text: string,
  adapterName: string,
  spec: TemporalSpec,
): RefinementBindingCoverageDiagnostic[] {
  const manifest = buildRefinementBindingManifest(fileName, text, adapterName);
  const compare = (
    kind: "action" | "invariant",
    modelNames: readonly string[],
    bindings: Record<string, string>,
  ): RefinementBindingCoverageDiagnostic[] => {
    const declared = new Set(modelNames);
    const bound = new Set(Object.keys(bindings));
    return [
      ...modelNames.filter((name) => !bound.has(name)).map((modelName) => ({
        code: `missing-${kind}-binding` as const,
        adapterName,
        modelName,
        message: `${kind} ${modelName} has no ${adapterName} refinement binding`,
      })),
      ...Object.entries(bindings).filter(([name]) => !declared.has(name)).map(([modelName, exportName]) => ({
        code: `unknown-${kind}-binding` as const,
        adapterName,
        modelName,
        exportName,
        message: `${kind} refinement ${exportName} refers to unknown model ${kind} ${modelName}`,
      })),
    ];
  };
  return [
    ...compare("action", spec.actions.map(({ name }) => name), manifest.actions),
    ...compare("invariant", spec.properties.map(({ name }) => name), manifest.invariants),
  ];
}

const temporalBinaryOperators = new Map<ts.SyntaxKind, TemporalBinaryOperator>([
  [ts.SyntaxKind.PlusToken, "add"], [ts.SyntaxKind.MinusToken, "subtract"],
  [ts.SyntaxKind.AsteriskToken, "multiply"], [ts.SyntaxKind.SlashToken, "divide"],
  [ts.SyntaxKind.PercentToken, "modulo"],
  [ts.SyntaxKind.EqualsEqualsEqualsToken, "eq"], [ts.SyntaxKind.ExclamationEqualsEqualsToken, "neq"],
  [ts.SyntaxKind.AmpersandAmpersandToken, "and"], [ts.SyntaxKind.BarBarToken, "or"],
  [ts.SyntaxKind.LessThanToken, "lt"], [ts.SyntaxKind.LessThanEqualsToken, "lte"],
  [ts.SyntaxKind.GreaterThanToken, "gt"], [ts.SyntaxKind.GreaterThanEqualsToken, "gte"],
]);

export function formatRefinementExpression(expression: TemporalExpression): string {
  return generateRuntimeAssertionExpression(expression);
}

function boundedSelfAffineEvidence(
  trace: RefinementBoundedSelfAffineTrace | undefined,
): RefinementBoundedSelfAffine | undefined {
  return trace ? {
    rule: trace.rule,
    state: trace.state,
    counter: trace.counter,
    multiplier: trace.multiplier,
    precondition: {
      expression: formatRefinementExpression(trace.precondition.expression),
      span: trace.precondition.span,
    },
    budget: trace.budget,
    update: trace.update,
    ...(trace.activation ? { activation: trace.activation } : {}),
  } : undefined;
}

function refinementExpressionKey(expression: TemporalExpression): string {
  const alphaNormalize = (value: TemporalExpression, bindings: ReadonlyMap<string, string> = new Map()): TemporalExpression => {
    if (value.kind === "name") return { ...value, name: bindings.get(value.name) ?? value.name };
    if (value.kind === "integer" || value.kind === "boolean" || value.kind === "string") return value;
    if (value.kind === "unary") return { ...value, operand: alphaNormalize(value.operand, bindings) };
    if (value.kind === "binary") return { ...value, left: alphaNormalize(value.left, bindings), right: alphaNormalize(value.right, bindings) };
    if (value.kind === "conditional") return { ...value, condition: alphaNormalize(value.condition, bindings), whenTrue: alphaNormalize(value.whenTrue, bindings), whenFalse: alphaNormalize(value.whenFalse, bindings) };
    if (value.kind === "array") return { ...value, elements: value.elements.map((item) => alphaNormalize(item, bindings)) };
    if (value.kind === "record") return { ...value, ...(value.base ? { base: alphaNormalize(value.base, bindings) } : {}), fields: Object.fromEntries(Object.entries(value.fields).map(([name, field]) => [name, alphaNormalize(field, bindings)])) };
    if (value.kind === "field") return { ...value, receiver: alphaNormalize(value.receiver, bindings) };
    if (value.kind === "lambda") {
      const canonical = `\u0000bound:${bindings.size}`;
      return { ...value, parameter: canonical, body: alphaNormalize(value.body, new Map(bindings).set(value.parameter, canonical)) };
    }
    if (value.kind === "call") return { ...value, arguments: value.arguments.map((item) => alphaNormalize(item, bindings)) };
    return { ...value, receiver: alphaNormalize(value.receiver, bindings), arguments: value.arguments.map((item) => alphaNormalize(item, bindings)) };
  };
  return JSON.stringify(alphaNormalize(expression), (_key, value) => value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)))
    : value);
}

function sameRefinementExpression(left: TemporalExpression, right: TemporalExpression): boolean {
  return refinementExpressionKey(left) === refinementExpressionKey(right);
}

function specializeExactRefinementCondition(
  expression: TemporalExpression,
  condition: TemporalExpression,
  value: boolean,
): TemporalExpression {
  if (sameRefinementExpression(expression, condition)) return { kind: "boolean", value };
  if (expression.kind === "unary") return {
    ...expression,
    operand: specializeExactRefinementCondition(expression.operand, condition, value),
  };
  if (expression.kind === "binary") return {
    ...expression,
    left: specializeExactRefinementCondition(expression.left, condition, value),
    right: specializeExactRefinementCondition(expression.right, condition, value),
  };
  if (expression.kind === "conditional") {
    if (sameRefinementExpression(expression.condition, condition)) {
      return specializeExactRefinementCondition(value ? expression.whenTrue : expression.whenFalse, condition, value);
    }
    return {
      ...expression,
      condition: specializeExactRefinementCondition(expression.condition, condition, value),
      whenTrue: specializeExactRefinementCondition(expression.whenTrue, condition, value),
      whenFalse: specializeExactRefinementCondition(expression.whenFalse, condition, value),
    };
  }
  return expression;
}

interface AffineStateExpression {
  constant: number;
  coefficients: ReadonlyMap<string, number>;
}

interface AffineLoopDelta {
  constant: number;
  counterCoefficient: number;
  driver?: string;
  driverCoefficient?: number;
  driverDelta?: number;
}

type PiecewiseAffineLoopDelta =
  | { kind: "affine"; value: AffineLoopDelta }
  | {
    kind: "conditional";
    condition: TemporalExpression;
    whenTrue: PiecewiseAffineLoopDelta;
    whenFalse: PiecewiseAffineLoopDelta;
  };

const MAX_AFFINE_LOOP_BRANCH_LEAVES = 8;
const MAX_AFFINE_LOOP_BREAK_UPDATES = 8;
const MAX_AFFINE_LOOP_BREAK_LEAVES = 8;
const MAX_AFFINE_LOOP_BOOLEAN_ATOMS = 16;
const MAX_BOUNDED_GEOMETRIC_ITERATIONS = 8;

/** Extracts an exact safe-integer affine form without guessing unsupported operations. */
function decomposeAffineStateExpression(expression: TemporalExpression): AffineStateExpression | undefined {
  const safe = (value: number): number | undefined => Number.isSafeInteger(value) ? value : undefined;
  const combine = (left: AffineStateExpression, right: AffineStateExpression, sign: 1 | -1): AffineStateExpression | undefined => {
    const constant = safe(left.constant + sign * right.constant);
    if (constant === undefined) return undefined;
    const coefficients = new Map(left.coefficients);
    for (const [name, coefficient] of right.coefficients) {
      const combined = safe((coefficients.get(name) ?? 0) + sign * coefficient);
      if (combined === undefined) return undefined;
      if (combined === 0) coefficients.delete(name); else coefficients.set(name, combined);
    }
    return { constant, coefficients };
  };
  const scale = (form: AffineStateExpression, coefficient: number): AffineStateExpression | undefined => {
    const constant = safe(form.constant * coefficient);
    if (constant === undefined) return undefined;
    const coefficients = new Map<string, number>();
    for (const [name, value] of form.coefficients) {
      const scaled = safe(value * coefficient);
      if (scaled === undefined) return undefined;
      if (scaled !== 0) coefficients.set(name, scaled);
    }
    return { constant, coefficients };
  };
  if (expression.kind === "integer") {
    const constant = Number(expression.value);
    return Number.isSafeInteger(constant) ? { constant, coefficients: new Map() } : undefined;
  }
  if (expression.kind === "name") return { constant: 0, coefficients: new Map([[expression.name, 1]]) };
  if (expression.kind === "unary" && expression.operator === "negate") {
    const operand = decomposeAffineStateExpression(expression.operand);
    return operand ? scale(operand, -1) : undefined;
  }
  if (expression.kind !== "binary") return undefined;
  const left = decomposeAffineStateExpression(expression.left);
  const right = decomposeAffineStateExpression(expression.right);
  if (!left || !right) return undefined;
  if (expression.operator === "add") return combine(left, right, 1);
  if (expression.operator === "subtract") return combine(left, right, -1);
  if (expression.operator !== "multiply") return undefined;
  if (left.coefficients.size === 0) return scale(right, left.constant);
  if (right.coefficients.size === 0) return scale(left, right.constant);
  return undefined;
}

function builtinCollectionKind(checker: ts.TypeChecker | undefined, node: ts.Expression): "Set" | "Map" | undefined {
  if (!checker) return undefined;
  const visit = (type: ts.Type, seen: ReadonlySet<ts.Type> = new Set()): "Set" | "Map" | undefined => {
    if (seen.has(type)) return undefined;
    const symbol = type.getSymbol() ?? type.aliasSymbol;
    const name = symbol?.getName();
    if ((name === "Set" || name === "Map")
      && (symbol?.declarations ?? []).some((declaration) => declaration.getSourceFile().isDeclarationFile)) return name;
    const constraint = checker.getBaseConstraintOfType(type);
    return constraint && constraint !== type ? visit(constraint, new Set([...seen, type])) : undefined;
  };
  return visit(checker.getTypeAtLocation(node));
}

function isDeclarationFileSymbol(checker: ts.TypeChecker | undefined, node: ts.Node, name: string): boolean {
  if (!checker) return false;
  let symbol = checker.getSymbolAtLocation(node);
  if (symbol && (symbol.flags & ts.SymbolFlags.Alias) !== 0) symbol = checker.getAliasedSymbol(symbol);
  return symbol?.getName() === name
    && (symbol.declarations ?? []).some((declaration) => declaration.getSourceFile().isDeclarationFile);
}

function replaceRefinementName(expression: TemporalExpression, from: string, to: string): TemporalExpression {
  if (expression.kind === "name") return expression.name === from ? { kind: "name", name: to } : expression;
  if (expression.kind === "integer" || expression.kind === "boolean" || expression.kind === "string") return expression;
  if (expression.kind === "unary") return { ...expression, operand: replaceRefinementName(expression.operand, from, to) };
  if (expression.kind === "binary") return { ...expression, left: replaceRefinementName(expression.left, from, to), right: replaceRefinementName(expression.right, from, to) };
  if (expression.kind === "conditional") return { ...expression, condition: replaceRefinementName(expression.condition, from, to), whenTrue: replaceRefinementName(expression.whenTrue, from, to), whenFalse: replaceRefinementName(expression.whenFalse, from, to) };
  if (expression.kind === "array") return { ...expression, elements: expression.elements.map((item) => replaceRefinementName(item, from, to)) };
  if (expression.kind === "record") return { ...expression, ...(expression.base ? { base: replaceRefinementName(expression.base, from, to) } : {}), fields: Object.fromEntries(Object.entries(expression.fields).map(([name, value]) => [name, replaceRefinementName(value, from, to)])) };
  if (expression.kind === "field") return { ...expression, receiver: replaceRefinementName(expression.receiver, from, to) };
  if (expression.kind === "lambda") return expression.parameter === from ? expression : { ...expression, body: replaceRefinementName(expression.body, from, to) };
  if (expression.kind === "call") return { ...expression, arguments: expression.arguments.map((item) => replaceRefinementName(item, from, to)) };
  return { ...expression, receiver: replaceRefinementName(expression.receiver, from, to), arguments: expression.arguments.map((item) => replaceRefinementName(item, from, to)) };
}

function canonicalizeAbstractionExpression(expression: TemporalExpression, abstraction: ReadonlyMap<string, string>): TemporalExpression {
  const expressionPath = (value: TemporalExpression): string[] | undefined => {
    if (value.kind === "name") return [value.name];
    if (value.kind !== "field") return undefined;
    const receiver = expressionPath(value.receiver);
    return receiver ? [...receiver, value.name] : undefined;
  };
  const concretePath = expressionPath(expression)?.join(".");
  if (concretePath) for (const [abstract, value] of abstraction) {
    const parsed = parseAbstractionValue(value);
    if (concretePath === parsed.path) return { kind: "name", name: abstract };
    if ((parsed.kind === "set-from-array" || parsed.kind === "map-from-entries") && concretePath === `${parsed.path}.length`) {
      return { kind: "method", receiver: { kind: "name", name: abstract }, name: "size", arguments: [] };
    }
  }
  if (expression.kind === "call" && (expression.name === "Set" || expression.name === "Map")
    && expression.arguments.length === 1) {
    const argumentPath = expressionPath(expression.arguments[0]!)?.join(".");
    if (argumentPath) for (const [abstract, value] of abstraction) {
      const parsed = parseAbstractionValue(value);
      const expectedKind = expression.name === "Set" ? "set-from-array" : "map-from-entries";
      if (parsed.kind === expectedKind && parsed.path === argumentPath) return { kind: "name", name: abstract };
    }
  }
  if (expression.kind === "integer" || expression.kind === "boolean" || expression.kind === "string" || expression.kind === "name") return expression;
  if (expression.kind === "unary") return { ...expression, operand: canonicalizeAbstractionExpression(expression.operand, abstraction) };
  if (expression.kind === "binary") return { ...expression, left: canonicalizeAbstractionExpression(expression.left, abstraction), right: canonicalizeAbstractionExpression(expression.right, abstraction) };
  if (expression.kind === "conditional") return { ...expression, condition: canonicalizeAbstractionExpression(expression.condition, abstraction), whenTrue: canonicalizeAbstractionExpression(expression.whenTrue, abstraction), whenFalse: canonicalizeAbstractionExpression(expression.whenFalse, abstraction) };
  if (expression.kind === "array") return { ...expression, elements: expression.elements.map((item) => canonicalizeAbstractionExpression(item, abstraction)) };
  if (expression.kind === "record") return { ...expression, ...(expression.base ? { base: canonicalizeAbstractionExpression(expression.base, abstraction) } : {}), fields: Object.fromEntries(Object.entries(expression.fields).map(([name, value]) => [name, canonicalizeAbstractionExpression(value, abstraction)])) };
  if (expression.kind === "field") {
    const fieldReceiver = canonicalizeAbstractionExpression(expression.receiver, abstraction);
    if (expression.name === "1" && fieldReceiver.kind === "method" && fieldReceiver.name === "get"
      && fieldReceiver.receiver.kind === "name"
      && parseAbstractionValue(abstraction.get(fieldReceiver.receiver.name) ?? fieldReceiver.receiver.name).kind === "map-from-entries") return fieldReceiver;
    return { ...expression, receiver: fieldReceiver };
  }
  if (expression.kind === "lambda") return { ...expression, body: canonicalizeAbstractionExpression(expression.body, abstraction) };
  if (expression.kind === "call") return { ...expression, arguments: expression.arguments.map((item) => canonicalizeAbstractionExpression(item, abstraction)) };
  const receiver = canonicalizeAbstractionExpression(expression.receiver, abstraction);
  const args = expression.arguments.map((item) => canonicalizeAbstractionExpression(item, abstraction));
  if (expression.name === "exists" && receiver.kind === "name"
    && args.length === 1 && args[0]?.kind === "lambda" && args[0].body.kind === "binary" && args[0].body.operator === "eq") {
    const abstractionKind = parseAbstractionValue(abstraction.get(receiver.name) ?? receiver.name).kind;
    const parameter = args[0].parameter;
    const leftIsParameter = args[0].body.left.kind === "name" && args[0].body.left.name === parameter;
    const rightIsParameter = args[0].body.right.kind === "name" && args[0].body.right.name === parameter;
    if (abstractionKind === "set-from-array" && leftIsParameter !== rightIsParameter) return {
      kind: "method", receiver, name: "contains",
      arguments: [leftIsParameter ? args[0].body.right : args[0].body.left],
    };
    const isKey = (value: TemporalExpression): boolean => value.kind === "field" && value.name === "0"
      && value.receiver.kind === "name" && value.receiver.name === parameter;
    const leftIsKey = isKey(args[0].body.left);
    const rightIsKey = isKey(args[0].body.right);
    if (abstractionKind === "map-from-entries" && leftIsKey !== rightIsKey) return {
      kind: "method", receiver: { kind: "method", receiver, name: "keys", arguments: [] }, name: "contains",
      arguments: [leftIsKey ? args[0].body.right : args[0].body.left],
    };
  }
  if ((expression.name === "forall" || expression.name === "exists") && receiver.kind === "name"
    && parseAbstractionValue(abstraction.get(receiver.name) ?? receiver.name).kind === "map-from-entries"
    && args.length === 1 && args[0]?.kind === "lambda") {
    const parameter = args[0].parameter;
    const rewriteValue = (value: TemporalExpression): TemporalExpression | undefined => {
      if (value.kind === "field" && value.name === "1" && value.receiver.kind === "name" && value.receiver.name === parameter) {
        return { kind: "name", name: parameter };
      }
      if (value.kind === "name") return value.name === parameter ? undefined : value;
      if (value.kind === "integer" || value.kind === "boolean" || value.kind === "string") return value;
      if (value.kind === "unary") { const operand = rewriteValue(value.operand); return operand ? { ...value, operand } : undefined; }
      if (value.kind === "binary") { const left = rewriteValue(value.left), right = rewriteValue(value.right); return left && right ? { ...value, left, right } : undefined; }
      if (value.kind === "conditional") {
        const condition = rewriteValue(value.condition), whenTrue = rewriteValue(value.whenTrue), whenFalse = rewriteValue(value.whenFalse);
        return condition && whenTrue && whenFalse ? { ...value, condition, whenTrue, whenFalse } : undefined;
      }
      if (value.kind === "field") { const nestedReceiver = rewriteValue(value.receiver); return nestedReceiver ? { ...value, receiver: nestedReceiver } : undefined; }
      if (value.kind === "array") { const elements = value.elements.map(rewriteValue); return elements.every((item): item is TemporalExpression => !!item) ? { ...value, elements } : undefined; }
      if (value.kind === "record") return undefined;
      if (value.kind === "lambda") return undefined;
      if (value.kind === "call") { const callArgs = value.arguments.map(rewriteValue); return callArgs.every((item): item is TemporalExpression => !!item) ? { ...value, arguments: callArgs } : undefined; }
      const methodReceiver = rewriteValue(value.receiver), methodArgs = value.arguments.map(rewriteValue);
      return methodReceiver && methodArgs.every((item): item is TemporalExpression => !!item) ? { ...value, receiver: methodReceiver, arguments: methodArgs } : undefined;
    };
    const body = rewriteValue(args[0].body);
    if (body) return {
      kind: "method", receiver: { kind: "method", receiver, name: "values", arguments: [] }, name: expression.name,
      arguments: [{ kind: "lambda", parameter, body }],
    };
  }
  return { ...expression, receiver, arguments: args };
}

function refinementFieldPath(
  target: ts.Expression,
  receiver: string,
  substitutions: ReadonlyMap<string, ts.Expression>,
): string[] | undefined {
  const matchesReceiver = (base: ts.Expression): boolean => {
    if (base.kind === ts.SyntaxKind.ThisKeyword) return true;
    if (!ts.isIdentifier(base)) return false;
    if (base.text === receiver) return true;
    const replacement = substitutions.get(base.text);
    return !!replacement && ts.isIdentifier(replacement) && replacement.text === receiver;
  };
  const path: string[] = [];
  let current = target;
  while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
    if (ts.isPropertyAccessExpression(current)) {
      path.unshift(current.name.text);
      current = current.expression;
      continue;
    }
    const argument = current.argumentExpression;
    const replacement = ts.isIdentifier(argument) ? substitutions.get(argument.text) : argument;
    if (!replacement || !ts.isStringLiteral(replacement)) return undefined;
    path.unshift(replacement.text);
    current = current.expression;
  }
  return path.length > 0 && matchesReceiver(current) ? path : undefined;
}

function refinementFieldName(
  target: ts.Expression,
  receiver: string,
  substitutions: ReadonlyMap<string, ts.Expression>,
): string | undefined {
  const path = refinementFieldPath(target, receiver, substitutions);
  return path?.length === 1 ? path[0] : undefined;
}

function normalizeRefinementExpression(
  node: ts.Expression,
  receiver: string,
  substitutions: ReadonlyMap<string, ts.Expression>,
  stateNames: ReadonlySet<string>,
  helpers: ReadonlyMap<string, ts.FunctionDeclaration> = new Map(),
  activeHelpers: ReadonlySet<string> = new Set(),
  symbolicSubstitutions: ReadonlyMap<string, TemporalExpression> = new Map(),
  checker?: ts.TypeChecker,
): TemporalExpression | undefined {
  if (ts.isParenthesizedExpression(node)) return normalizeRefinementExpression(node.expression, receiver, substitutions, stateNames, helpers, activeHelpers, symbolicSubstitutions, checker);
  if (ts.isNonNullExpression(node)) return normalizeRefinementExpression(node.expression, receiver, substitutions, stateNames, helpers, activeHelpers, symbolicSubstitutions, checker);
  if (ts.isNumericLiteral(node) && /^\d+$/.test(node.text)) return { kind: "integer", value: node.text };
  if (node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword) return { kind: "boolean", value: node.kind === ts.SyntaxKind.TrueKeyword };
  if (ts.isIdentifier(node)) {
    const symbolic = symbolicSubstitutions.get(node.text);
    if (symbolic) return { kind: "name", name: `\u0000local:${node.text}` };
    const replacement = substitutions.get(node.text);
    return replacement ? normalizeRefinementExpression(replacement, receiver, substitutions, stateNames, helpers, activeHelpers, symbolicSubstitutions, checker) : undefined;
  }
  const field = refinementFieldName(node, receiver, substitutions);
  if (field && stateNames.has(field)) return { kind: "name", name: field };
  if (ts.isPropertyAccessExpression(node)) {
    const base = normalizeRefinementExpression(node.expression, receiver, substitutions, stateNames, helpers, activeHelpers, symbolicSubstitutions, checker);
    if (base && node.name.text === "size") return { kind: "method", receiver: base, name: "size", arguments: [] };
    if (base) return { kind: "field", receiver: base, name: node.name.text };
  }
  if (ts.isElementAccessExpression(node) && node.argumentExpression && ts.isNumericLiteral(node.argumentExpression)) {
    const base = normalizeRefinementExpression(node.expression, receiver, substitutions, stateNames, helpers, activeHelpers, symbolicSubstitutions, checker);
    if (base) return { kind: "field", receiver: base, name: node.argumentExpression.text };
  }
  if (ts.isPrefixUnaryExpression(node) && (node.operator === ts.SyntaxKind.MinusToken || node.operator === ts.SyntaxKind.ExclamationToken)) {
    const operand = normalizeRefinementExpression(node.operand, receiver, substitutions, stateNames, helpers, activeHelpers, symbolicSubstitutions, checker);
    return operand ? { kind: "unary", operator: node.operator === ts.SyntaxKind.ExclamationToken ? "not" : "negate", operand } : undefined;
  }
  if (ts.isBinaryExpression(node)) {
    const operator = temporalBinaryOperators.get(node.operatorToken.kind);
    const left = normalizeRefinementExpression(node.left, receiver, substitutions, stateNames, helpers, activeHelpers, symbolicSubstitutions, checker);
    const right = normalizeRefinementExpression(node.right, receiver, substitutions, stateNames, helpers, activeHelpers, symbolicSubstitutions, checker);
    return operator && left && right ? { kind: "binary", operator, left, right } : undefined;
  }
  if (ts.isConditionalExpression(node)) {
    const condition = normalizeRefinementExpression(node.condition, receiver, substitutions, stateNames, helpers, activeHelpers, symbolicSubstitutions, checker);
    const whenTrue = normalizeRefinementExpression(node.whenTrue, receiver, substitutions, stateNames, helpers, activeHelpers, symbolicSubstitutions, checker);
    const whenFalse = normalizeRefinementExpression(node.whenFalse, receiver, substitutions, stateNames, helpers, activeHelpers, symbolicSubstitutions, checker);
    return condition && whenTrue && whenFalse ? { kind: "conditional", condition, whenTrue, whenFalse } : undefined;
  }
  if (ts.isObjectLiteralExpression(node)) {
    let base: TemporalExpression | undefined;
    const fields: Record<string, TemporalExpression> = {};
    for (let index = 0; index < node.properties.length; index++) {
      const property = node.properties[index]!;
      if (ts.isSpreadAssignment(property)) {
        if (index !== 0 || base) return undefined;
        base = normalizeRefinementExpression(property.expression, receiver, substitutions, stateNames, helpers, activeHelpers, symbolicSubstitutions, checker);
        if (!base) return undefined;
        continue;
      }
      if (ts.isShorthandPropertyAssignment(property)) {
        const value = normalizeRefinementExpression(property.name, receiver, substitutions, stateNames, helpers, activeHelpers, symbolicSubstitutions, checker);
        if (!value || Object.hasOwn(fields, property.name.text)) return undefined;
        fields[property.name.text] = value;
        continue;
      }
      if (!ts.isPropertyAssignment(property)) return undefined;
      const name = ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) ? property.name.text : undefined;
      const value = normalizeRefinementExpression(property.initializer, receiver, substitutions, stateNames, helpers, activeHelpers, symbolicSubstitutions, checker);
      if (!name || !value || Object.hasOwn(fields, name)) return undefined;
      fields[name] = value;
    }
    return { kind: "record", ...(base ? { base } : {}), fields };
  }
  if (checker && ts.isNewExpression(node) && ts.isIdentifier(node.expression)
    && (node.expression.text === "Set" || node.expression.text === "Map")
    && node.arguments?.length === 1
    && isDeclarationFileSymbol(checker, node.expression, node.expression.text)) {
    const argument = normalizeRefinementExpression(
      node.arguments[0]!, receiver, substitutions, stateNames, helpers,
      activeHelpers, symbolicSubstitutions, checker,
    );
    if (argument) return {
      kind: "call",
      name: node.expression.text,
      arguments: [argument],
    };
  }
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
    && node.expression.name.text === "find" && node.arguments.length === 1
    && isDeclarationFileSymbol(checker, node.expression.name, "find")) {
    const from = node.expression.expression, callback = node.arguments[0];
    const fromType = checker?.getTypeAtLocation(from), fromSymbol = fromType?.getSymbol() ?? fromType?.aliasSymbol;
    const builtinArray = fromSymbol?.getName() === "Array"
      && (fromSymbol.declarations ?? []).some((declaration) => declaration.getSourceFile().isDeclarationFile);
    if (builtinArray && callback && ts.isArrowFunction(callback) && callback.parameters.length === 1
      && ts.isIdentifier(callback.parameters[0]!.name) && !ts.isBlock(callback.body)) {
      const collection = normalizeRefinementExpression(from, receiver, substitutions, stateNames, helpers, activeHelpers, symbolicSubstitutions, checker);
      const parameter = callback.parameters[0]!.name.text;
      const nestedSymbols = new Map(symbolicSubstitutions).set(parameter, { kind: "name", name: parameter } as TemporalExpression);
      const body = normalizeRefinementExpression(callback.body, receiver, substitutions, stateNames, helpers, activeHelpers, nestedSymbols, checker);
      const isKey = (value: TemporalExpression): boolean => value.kind === "field" && value.name === "0"
        && value.receiver.kind === "name" && (value.receiver.name === parameter || value.receiver.name === `\u0000local:${parameter}`);
      const exactKeyPredicate = body?.kind === "binary" && body.operator === "eq" && isKey(body.left) !== isKey(body.right);
      if (collection && body?.kind === "binary" && exactKeyPredicate) {
        const leftIsKey = isKey(body.left);
        return { kind: "method", receiver: collection, name: "get", arguments: [leftIsKey ? body.right : body.left] };
      }
    }
  }
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
    && (node.expression.name.text === "keys" || node.expression.name.text === "values")
    && node.arguments.length === 0
    && builtinCollectionKind(checker, node.expression.expression) === "Map"
    && isDeclarationFileSymbol(checker, node.expression.name, node.expression.name.text)) {
    const collection = normalizeRefinementExpression(node.expression.expression, receiver, substitutions, stateNames, helpers, activeHelpers, symbolicSubstitutions, checker);
    if (collection) return { kind: "method", receiver: collection, name: node.expression.name.text, arguments: [] };
  }
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
    && (node.expression.name.text === "every" || node.expression.name.text === "some") && node.arguments.length === 1
    && isDeclarationFileSymbol(checker, node.expression.name, node.expression.name.text)) {
    const from = node.expression.expression;
    const callback = node.arguments[0];
    const normalizePredicate = (candidate: ts.Expression): { parameter: string; body: TemporalExpression } | undefined => {
      const declaration = ts.isArrowFunction(candidate)
        ? candidate
        : checker && (ts.isIdentifier(candidate) || ts.isPropertyAccessExpression(candidate))
          ? resolveProgramImmutableFunctionValue(checker, candidate)
          : undefined;
      if (!declaration?.body || declaration.parameters.length !== 1 || !ts.isIdentifier(declaration.parameters[0]!.name)) return undefined;
      const parameter = declaration.parameters[0]!.name.text;
      const nestedSymbols = new Map(symbolicSubstitutions).set(parameter, { kind: "name", name: parameter } as TemporalExpression);
      const callbackSubstitutions = new Map(substitutions);
      let callbackExpression: ts.Expression | undefined;
      if (ts.isBlock(declaration.body)) {
        const statements = [...declaration.body.statements];
        const returned = statements.pop();
        if (!returned || !ts.isReturnStatement(returned) || !returned.expression) return undefined;
        for (const statement of statements) {
          if (!ts.isVariableStatement(statement) || (statement.declarationList.flags & ts.NodeFlags.Const) === 0) return undefined;
          for (const variable of statement.declarationList.declarations) {
            if (!ts.isIdentifier(variable.name) || !variable.initializer
              || !normalizeRefinementExpression(variable.initializer, receiver, callbackSubstitutions, stateNames, helpers, activeHelpers, nestedSymbols, checker)) return undefined;
            callbackSubstitutions.set(variable.name.text, variable.initializer);
          }
        }
        callbackExpression = returned.expression;
      } else callbackExpression = declaration.body;
      if (!callbackExpression) return undefined;
      const body = normalizeRefinementExpression(
        callbackExpression, receiver, callbackSubstitutions, stateNames,
        helpers, activeHelpers, nestedSymbols, checker,
      );
      return body ? { parameter, body: replaceRefinementName(body, `\u0000local:${parameter}`, parameter) } : undefined;
    };
    const fromType = checker?.getTypeAtLocation(from);
    const fromSymbol = fromType?.getSymbol() ?? fromType?.aliasSymbol;
    const builtinArray = fromSymbol?.getName() === "Array"
      && (fromSymbol.declarations ?? []).some((declaration) => declaration.getSourceFile().isDeclarationFile);
    if (builtinArray && callback) {
      const collection = normalizeRefinementExpression(from, receiver, substitutions, stateNames, helpers, activeHelpers, symbolicSubstitutions, checker);
      const predicate = normalizePredicate(callback);
      if (collection && predicate) return {
        kind: "method", receiver: collection, name: node.expression.name.text === "some" ? "exists" : "forall",
        arguments: [{ kind: "lambda", parameter: predicate.parameter, body: predicate.body }],
      };
    }
    if (ts.isCallExpression(from) && ts.isPropertyAccessExpression(from.expression)
      && ts.isIdentifier(from.expression.expression) && from.expression.expression.text === "Array"
      && from.expression.name.text === "from" && from.arguments.length === 1
      && isDeclarationFileSymbol(checker, from.expression.name, "from")
      && callback) {
      const collection = normalizeRefinementExpression(from.arguments[0]!, receiver, substitutions, stateNames, helpers, activeHelpers, symbolicSubstitutions, checker);
      const supportedCollection = builtinCollectionKind(checker, from.arguments[0]!) === "Set"
        || collection?.kind === "method" && (collection.name === "keys" || collection.name === "values");
      const predicate = normalizePredicate(callback);
      if (collection && supportedCollection && predicate) return {
        kind: "method", receiver: collection, name: node.expression.name.text === "some" ? "exists" : "forall",
        arguments: [{ kind: "lambda", parameter: predicate.parameter, body: predicate.body }],
      };
    }
  }
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
    && (node.expression.name.text === "has" || node.expression.name.text === "includes") && node.arguments.length === 1
    && (node.expression.name.text === "has" || isDeclarationFileSymbol(checker, node.expression.name, "includes"))) {
    const collection = normalizeRefinementExpression(node.expression.expression, receiver, substitutions, stateNames, helpers, activeHelpers, symbolicSubstitutions, checker);
    const argument = normalizeRefinementExpression(node.arguments[0]!, receiver, substitutions, stateNames, helpers, activeHelpers, symbolicSubstitutions, checker);
    if (collection && argument) {
      const membershipReceiver: TemporalExpression = builtinCollectionKind(checker, node.expression.expression) === "Map"
        ? { kind: "method", receiver: collection, name: "keys", arguments: [] }
        : collection;
      return { kind: "method", receiver: membershipReceiver, name: "contains", arguments: [argument] };
    }
  }
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
    && node.expression.name.text === "get" && node.arguments.length === 1
    && builtinCollectionKind(checker, node.expression.expression) === "Map") {
    const collection = normalizeRefinementExpression(node.expression.expression, receiver, substitutions, stateNames, helpers, activeHelpers, symbolicSubstitutions, checker);
    const argument = normalizeRefinementExpression(node.arguments[0]!, receiver, substitutions, stateNames, helpers, activeHelpers, symbolicSubstitutions, checker);
    if (collection && argument) return { kind: "method", receiver: collection, name: "get", arguments: [argument] };
  }
  if (ts.isCallExpression(node) && (ts.isIdentifier(node.expression) || ts.isPropertyAccessExpression(node.expression))) {
    const name = ts.isIdentifier(node.expression) ? node.expression.text : node.expression.getText();
    const helper = helpers.get(name);
    if (!helper?.body || activeHelpers.has(name) || helper.parameters.length !== node.arguments.length
      || helper.body.statements.length !== 1) return undefined;
    const returned = helper.body.statements[0];
    if (!returned || !ts.isReturnStatement(returned) || !returned.expression) return undefined;
    const resolveArgument = (argument: ts.Expression, seen: ReadonlySet<string> = new Set()): ts.Expression | undefined => {
      if (!ts.isIdentifier(argument)) return argument;
      if (seen.has(argument.text)) return undefined;
      const replacement = substitutions.get(argument.text);
      if (!replacement) return argument;
      // Identically named parameters in different helper scopes are not an
      // alias cycle: the replacement is the caller's runtime receiver.
      if (ts.isIdentifier(replacement) && replacement.text === argument.text) return replacement;
      return resolveArgument(replacement, new Set([...seen, argument.text]));
    };
    const nested = new Map<string, ts.Expression>();
    for (let index = 0; index < helper.parameters.length; index++) {
      const parameter = helper.parameters[index]!;
      if (!ts.isIdentifier(parameter.name)) return undefined;
      const argument = resolveArgument(node.arguments[index]!);
      if (!argument) return undefined;
      nested.set(parameter.name.text, argument);
    }
    return normalizeRefinementExpression(returned.expression, receiver, nested, stateNames, helpers, new Set([...activeHelpers, name]), symbolicSubstitutions, checker);
  }
  return undefined;
}

function resolveProgramFunction(
  checker: ts.TypeChecker,
  expression: ts.Identifier | ts.PropertyAccessExpression,
  seen: ReadonlySet<ts.Symbol> = new Set(),
): ts.FunctionDeclaration | undefined {
  let symbol = checker.getSymbolAtLocation(expression)
    ?? (ts.isPropertyAccessExpression(expression) ? checker.getSymbolAtLocation(expression.name) : undefined);
  if (symbol && (symbol.flags & ts.SymbolFlags.Alias) !== 0) symbol = checker.getAliasedSymbol(symbol);
  if (!symbol || seen.has(symbol)) return undefined;
  const direct = symbol.declarations?.find(ts.isFunctionDeclaration);
  if (direct) return direct;
  const alias = symbol.declarations?.find((declaration): declaration is ts.VariableDeclaration =>
    ts.isVariableDeclaration(declaration)
    && ts.isVariableDeclarationList(declaration.parent)
    && (declaration.parent.flags & ts.NodeFlags.Const) !== 0
    && !!declaration.initializer
    && (ts.isIdentifier(declaration.initializer) || ts.isPropertyAccessExpression(declaration.initializer)));
  return alias?.initializer && (ts.isIdentifier(alias.initializer) || ts.isPropertyAccessExpression(alias.initializer))
    ? resolveProgramFunction(checker, alias.initializer, new Set([...seen, symbol]))
    : undefined;
}

type ImmutableFunctionValue = ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression;

function resolveProgramImmutableFunctionValue(
  checker: ts.TypeChecker,
  expression: ts.Identifier | ts.PropertyAccessExpression,
  seen: ReadonlySet<ts.Symbol> = new Set(),
): ImmutableFunctionValue | undefined {
  let symbol = checker.getSymbolAtLocation(expression)
    ?? (ts.isPropertyAccessExpression(expression) ? checker.getSymbolAtLocation(expression.name) : undefined);
  if (symbol && (symbol.flags & ts.SymbolFlags.Alias) !== 0) symbol = checker.getAliasedSymbol(symbol);
  if (!symbol || seen.has(symbol)) return undefined;
  const direct = symbol.declarations?.find(ts.isFunctionDeclaration);
  if (direct) return direct;
  const frozenProperty = symbol.declarations?.find((declaration): declaration is ts.PropertyAssignment =>
    ts.isPropertyAssignment(declaration)
    && ts.isObjectLiteralExpression(declaration.parent)
    && ts.isCallExpression(declaration.parent.parent)
    && declaration.parent.parent.arguments.length === 1
    && declaration.parent.parent.arguments[0] === declaration.parent
    && ts.isPropertyAccessExpression(declaration.parent.parent.expression)
    && declaration.parent.parent.expression.name.text === "freeze"
    && isDeclarationFileSymbol(checker, declaration.parent.parent.expression.name, "freeze"));
  if (frozenProperty) {
    const value = frozenProperty.initializer;
    if (ts.isArrowFunction(value) || ts.isFunctionExpression(value)) return value;
    if (ts.isIdentifier(value) || ts.isPropertyAccessExpression(value)) {
      return resolveProgramImmutableFunctionValue(checker, value, new Set([...seen, symbol]));
    }
    return undefined;
  }
  const binding = symbol.declarations?.find((declaration): declaration is ts.VariableDeclaration =>
    ts.isVariableDeclaration(declaration)
    && ts.isVariableDeclarationList(declaration.parent)
    && (declaration.parent.flags & ts.NodeFlags.Const) !== 0
    && !!declaration.initializer);
  const initializer = binding?.initializer;
  if (!initializer) return undefined;
  if (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) return initializer;
  return ts.isIdentifier(initializer) || ts.isPropertyAccessExpression(initializer)
    ? resolveProgramImmutableFunctionValue(checker, initializer, new Set([...seen, symbol]))
    : undefined;
}

function validateRefinementActionBodiesInSource(
  source: ts.SourceFile,
  text: string,
  adapterName: string,
  spec: TemporalSpec,
  checker?: ts.TypeChecker,
  program?: ts.Program,
  options: RefinementActionValidationOptions = {},
  traceSink?: RefinementActionTraceSink,
): RefinementActionDiagnostic[] {
  const fileName = source.fileName;
  const manifest = buildRefinementBindingManifest(fileName, text, adapterName);
  const functions = new Map(source.statements.filter(ts.isFunctionDeclaration).flatMap((node) => node.name ? [[node.name.text, node] as const] : []));
  const classes = new Map(source.statements.filter(ts.isClassDeclaration).flatMap((node) => node.name ? [[node.name.text, node] as const] : []));
  const stateNames = new Set(spec.states.map(({ name }) => name));
  const stateTypes = new Map(spec.states.map(({ name, type }) => [name, type]));
  const abstraction = parseAbstractionRelations(text, adapterName, manifest.version, stateNames);
  const concreteToAbstract = new Map([...abstraction].map(([abstract, value]) => [parseAbstractionValue(value).path, abstract]));
  const expressionStateNames = new Set([...stateNames, ...[...concreteToAbstract.keys()].map((path) => path.split(".")[0]!).filter(Boolean)]);
  const canonicalize = (expression: TemporalExpression): TemporalExpression => canonicalizeAbstractionExpression(expression, abstraction);
  const actionFieldPath = (node: ts.Expression, receiver: string, substitutions: ReadonlyMap<string, ts.Expression>): string[] | undefined => {
    const path = refinementFieldPath(node, receiver, substitutions);
    if (!path?.[0]) return path;
    for (const [abstract, value] of abstraction) {
      const concretePath = parseAbstractionValue(value).path.split(".");
      if (concretePath.every((part, index) => path[index] === part)) return [abstract, ...path.slice(concretePath.length)];
    }
    return path;
  };
  const diagnostics: RefinementActionDiagnostic[] = [];
  let currentModelName: string | undefined;
  let currentActionPrecondition: RefinementBoundedSelfAffineTrace["precondition"] | undefined;

  const functionPrecondition = (
    implementation: ts.FunctionDeclaration,
    receiver: string,
  ): RefinementBoundedSelfAffineTrace["precondition"] | undefined => {
    const start = implementation.getStart(source);
    const annotations = extractLocatedAnnotations(
      text.slice(implementation.getFullStart(), start), "requires", implementation.getFullStart(),
    );
    if (annotations.length !== 1) return undefined;
    const annotation = annotations[0]!;
    const expressionSource = ts.createSourceFile(
      "__uneffect_requires.ts", `const __requires = (${annotation.value});`,
      ts.ScriptTarget.Latest, true, ts.ScriptKind.TS,
    );
    const declaration = expressionSource.statements[0];
    const initializer = declaration && ts.isVariableStatement(declaration)
      ? declaration.declarationList.declarations[0]?.initializer : undefined;
    if (!initializer) return undefined;
    const expression = normalizeRefinementExpression(
      initializer, receiver, new Map(), expressionStateNames,
    );
    return expression ? {
      expression: canonicalize(expression),
      text: annotation.value,
      span: annotation.span,
    } : undefined;
  };

  const resolveFunction = (expression: ts.Identifier | ts.PropertyAccessExpression, seen: ReadonlySet<ts.Symbol> = new Set()): ts.FunctionDeclaration | undefined => {
    if (!checker) return ts.isIdentifier(expression) ? functions.get(expression.text) : undefined;
    return resolveProgramFunction(checker, expression, seen);
  };

  const localAliasRegion = (
    call: ts.CallExpression,
    receiverArgument: ts.Expression,
    receiver: string,
    substitutions: ReadonlyMap<string, ts.Expression>,
    helper: ts.FunctionDeclaration,
  ): Omit<RefinementAliasRegionTrace, "modelName"> | undefined | "unsupported" => {
    if (!checker || !ts.isIdentifier(receiverArgument)) return undefined;
    void substitutions;
    let owner: ts.Node | undefined = call;
    while (owner && !ts.isFunctionLike(owner)) owner = owner.parent;
    if (!owner) return "unsupported";
    const resolvedRegion = resolveStableRegion(checker, receiverArgument, {
      scope: owner, permittedUse: receiverArgument,
    });
    if (resolvedRegion.status === "resolved" && resolvedRegion.aliases.length === 0) return undefined;
    const alias = resolvedRegion.status === "resolved" ? resolvedRegion.aliases[0] : undefined;
    if (resolvedRegion.status !== "resolved" || resolvedRegion.region !== receiver
      || resolvedRegion.runtimeDescriptorUnchecked || !alias
      || (checker.getTypeAtLocation(receiverArgument).flags & ts.TypeFlags.Object) === 0) return "unsupported";
    if (!ts.isIdentifier(call.expression) || !helper.name || helper.getSourceFile() !== source
      || helper.typeParameters?.length || helper.parameters.length !== 1
      || !ts.isIdentifier(helper.parameters[0]!.name)) return "unsupported";
    const directSymbol = checker.getSymbolAtLocation(call.expression);
    if (!directSymbol?.declarations?.includes(helper)) return "unsupported";
    let unsupportedHelper = false;
    const inspectHelper = (node: ts.Node): void => {
      if (unsupportedHelper) return;
      if (node !== helper && ts.isFunctionLike(node)) { unsupportedHelper = true; return; }
      if (ts.isElementAccessExpression(node)) { unsupportedHelper = true; return; }
      ts.forEachChild(node, inspectHelper);
    };
    inspectHelper(helper.body!);
    if (unsupportedHelper) return "unsupported";
    const helperSource = helper.getSourceFile();
    const leading = helperSource.text.slice(helper.getFullStart(), helper.getStart(helperSource));
    const parameterName = (helper.parameters[0]!.name as ts.Identifier).text;
    const capabilityDeclaration = extractLocatedAnnotations(leading, "effect", helper.getFullStart())
      .map(({ value }) => value)
      .find((value) => value.split("|").some((part) => part.trim().startsWith(`Mutate<typeof ${parameterName}.`)));
    if (!capabilityDeclaration) return "unsupported";
    return {
      aliasName: receiverArgument.text,
      aliasSpan: alias.span,
      helperName: helper.name!.text,
      helperCallSpan: { start: call.getStart(source), end: call.getEnd() },
      helperDeclarationSpan: { start: helper.getStart(source), end: helper.getEnd() },
      helperDeclarationFile: helperSource.fileName,
      helperSymbolIdentity: `${helperSource.fileName}:${helper.getStart(helperSource)}`,
      capabilityDeclaration,
    };
  };

  const knownSubclassCache = new Map<ts.ClassDeclaration, boolean>();
  const hasDispatchSealingTrust = (runtimeClass: ts.ClassDeclaration): boolean => {
    const exported = runtimeClass.modifiers?.some((modifier) =>
      modifier.kind === ts.SyntaxKind.ExportKeyword || modifier.kind === ts.SyntaxKind.DefaultKeyword) ?? false;
    if (!exported) return true;
    const classSource = runtimeClass.getSourceFile();
    const leading = classSource.text.slice(runtimeClass.getFullStart(), runtimeClass.getStart(classSource));
    return extractAnnotations(leading, "trust").some((value) => /^dispatch-sealing\s+\S/.test(value.trim()));
  };
  const hasKnownSubclass = (runtimeClass: ts.ClassDeclaration): boolean => {
    const cached = knownSubclassCache.get(runtimeClass);
    if (cached !== undefined) return cached;
    let runtimeSymbol = checker && runtimeClass.name ? checker.getSymbolAtLocation(runtimeClass.name) : undefined;
    if (runtimeSymbol && (runtimeSymbol.flags & ts.SymbolFlags.Alias) !== 0) runtimeSymbol = checker!.getAliasedSymbol(runtimeSymbol);
    let found = false;
    const visit = (node: ts.Node): void => {
      if (found) return;
      if (ts.isClassDeclaration(node) && node !== runtimeClass) {
        for (const clause of node.heritageClauses ?? []) {
          if (clause.token !== ts.SyntaxKind.ExtendsKeyword) continue;
          for (const inherited of clause.types) {
            if (checker && runtimeSymbol) {
              let inheritedSymbol = checker.getSymbolAtLocation(inherited.expression);
              if (inheritedSymbol && (inheritedSymbol.flags & ts.SymbolFlags.Alias) !== 0) inheritedSymbol = checker.getAliasedSymbol(inheritedSymbol);
              if (inheritedSymbol === runtimeSymbol || inheritedSymbol?.declarations?.includes(runtimeClass)) { found = true; return; }
            } else if (runtimeClass.name && ts.isIdentifier(inherited.expression)
              && inherited.expression.text === runtimeClass.name.text) { found = true; return; }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    const roots = program
      ? program.getSourceFiles().filter((file) => !file.isDeclarationFile)
      : [source];
    for (const root of roots) visit(root);
    knownSubclassCache.set(runtimeClass, found);
    return found;
  };

  const resolveRuntimeClass = (parameter: ts.ParameterDeclaration | undefined): ts.ClassDeclaration | undefined => {
    const type = parameter?.type;
    if (!type || !ts.isTypeReferenceNode(type) || !ts.isIdentifier(type.typeName)) return undefined;
    if (!checker) {
      const runtimeClass = classes.get(type.typeName.text);
      return runtimeClass && hasDispatchSealingTrust(runtimeClass) && !hasKnownSubclass(runtimeClass) ? runtimeClass : undefined;
    }
    let symbol = checker.getSymbolAtLocation(type.typeName);
    if (symbol && (symbol.flags & ts.SymbolFlags.Alias) !== 0) symbol = checker.getAliasedSymbol(symbol);
    const runtimeClass = symbol?.declarations?.find(ts.isClassDeclaration);
    return runtimeClass && hasDispatchSealingTrust(runtimeClass) && !hasKnownSubclass(runtimeClass) ? runtimeClass : undefined;
  };

  const isBuiltinCollectionReceiver = (node: ts.Expression, kind: "set" | "map"): boolean => {
    if (!checker) return true;
    const expected = kind === "set" ? "Set" : "Map";
    const matches = (type: ts.Type, seen: ReadonlySet<ts.Type> = new Set()): boolean => {
      if (seen.has(type)) return false;
      const symbol = type.getSymbol() ?? type.aliasSymbol;
      if (symbol?.getName() === expected
        && (symbol.declarations ?? []).some((declaration) => declaration.getSourceFile().isDeclarationFile)) return true;
      const constraint = checker.getBaseConstraintOfType(type);
      return !!constraint && constraint !== type && matches(constraint, new Set([...seen, type]));
    };
    return matches(checker.getTypeAtLocation(node));
  };
  const isBuiltinArrayReceiver = (node: ts.Expression): boolean => {
    if (!checker) return false;
    const type = checker.getTypeAtLocation(node);
    const symbol = type.getSymbol() ?? type.aliasSymbol;
    return symbol?.getName() === "Array"
      && (symbol.declarations ?? []).some((declaration) => declaration.getSourceFile().isDeclarationFile);
  };

  const unwrap = (node: ts.Expression): ts.Expression => ts.isParenthesizedExpression(node) ? unwrap(node.expression) : node;
  const isSameRealmGlobalThis = (node: ts.Expression): boolean => {
    const value = unwrap(node);
    if (!checker || !ts.isIdentifier(value) || value.text !== "globalThis") return false;
    const symbol = checker.getSymbolAtLocation(value);
    if (!symbol) return false;
    return !(symbol.declarations ?? []).some((declaration) => {
      const named = declaration as ts.NamedDeclaration;
      return !declaration.getSourceFile().isDeclarationFile
        && !!named.name && ts.isIdentifier(named.name) && named.name.text === "globalThis";
    });
  };
  const isNodeCurrentRealmGlobal = (node: ts.Expression, version: string): boolean => {
    const value = unwrap(node);
    if (!checker || !ts.isIdentifier(value) || value.text !== "global") return false;
    const symbol = checker.getSymbolAtLocation(value);
    const declarations = symbol?.declarations ?? [];
    if (declarations.length === 0
      || !declarations.every((declaration) => declaration.getSourceFile().isDeclarationFile)) return false;
    return declarations.some((declaration) => {
      const fileName = declaration.getSourceFile().fileName.replaceAll("\\", "/");
      const marker = "/node_modules/@types/node/";
      const index = fileName.lastIndexOf(marker);
      if (index < 0) return false;
      const packageJson = ts.sys.readFile(`${fileName.slice(0, index + marker.length - 1)}/package.json`);
      if (!packageJson) return false;
      try {
        const packageVersion = (JSON.parse(packageJson) as { version?: unknown }).version;
        return typeof packageVersion === "string" && packageVersion.split(".")[0] === version;
      } catch {
        return false;
      }
    });
  };
  let runtimeIdentityFailure: string | undefined;
  const isManifestRuntimeArgument = (argument: ts.Expression): boolean => {
    const local = manifest.runtimeIdentity;
    if (!local) {
      runtimeIdentityFailure = "runtime identity is missing on the consumer adapter";
      return false;
    }
    const valid = local.kind === "ambient"
      ? isSameRealmGlobalThis(argument)
      : local.host === "node" && local.root === "global" && local.realm === "main"
        && isNodeCurrentRealmGlobal(argument, local.version);
    if (!valid) runtimeIdentityFailure = local.kind === "ambient"
      ? "runtime identity ecmascript:realm.globalThis is not backed by the TypeChecker-resolved builtin globalThis"
      : local.realm !== "main"
        ? `runtime identity mismatch: ${local.identity} is not the current Node realm`
        : `runtime identity ${local.identity} is not backed by the TypeChecker-resolved current-realm @types/node major ${local.version} ambient global`;
    return valid;
  };
  const sameRuntimeIdentity = (
    external: ExternalRefinementActionContract,
    argument: ts.Expression,
  ): boolean => {
    const local = manifest.runtimeIdentity;
    if (!local || !external.runtimeIdentity) {
      runtimeIdentityFailure = "runtime identity is missing on the consumer or producer adapter";
      return false;
    }
    if (external.runtimeIdentity.identity !== local.identity) {
      runtimeIdentityFailure = `runtime identity mismatch: consumer ${local.identity}, producer ${external.runtimeIdentity.identity}`;
      return false;
    }
    return isManifestRuntimeArgument(argument);
  };
  const earlyReturnGuard = (body: ts.Block, receiver: string): { guard?: TemporalExpression; updates: ts.Block } => {
    const first = body.statements[0];
    if (!first || !ts.isIfStatement(first) || first.elseStatement) return { updates: body };
    const returns = ts.isReturnStatement(first.thenStatement)
      ? !first.thenStatement.expression
      : ts.isBlock(first.thenStatement) && first.thenStatement.statements.length === 1
        && ts.isReturnStatement(first.thenStatement.statements[0]!) && !first.thenStatement.statements[0]!.expression;
    const condition = unwrap(first.expression);
    if (!returns || !ts.isPrefixUnaryExpression(condition) || condition.operator !== ts.SyntaxKind.ExclamationToken) return { updates: body };
    const guard = normalizeRefinementExpression(unwrap(condition.operand), receiver, new Map(), expressionStateNames);
    return guard ? { guard: canonicalize(guard), updates: ts.factory.createBlock(body.statements.slice(1), true) } : { updates: body };
  };

  const directExternalAction = (
    body: ts.Block,
    receiver: string,
  ): ExternalRefinementActionContract | undefined => {
    if (body.statements.length !== 1) return undefined;
    const statement = body.statements[0]!;
    const expression = ts.isExpressionStatement(statement) ? statement.expression
      : ts.isReturnStatement(statement) ? statement.expression : undefined;
    if (!expression || !ts.isCallExpression(expression) || expression.arguments.length !== 1) return undefined;
    if (!ts.isIdentifier(expression.expression) && !ts.isPropertyAccessExpression(expression.expression)) return undefined;
    const helper = resolveFunction(expression.expression);
    const helperSource = helper?.getSourceFile();
    if (!helper || !helperSource || helper.parameters.length !== 1) return undefined;
    const external = options.externalActions?.get(`${helperSource.fileName}:${helper.getStart(helperSource)}`);
    if (!external || external.evidence !== "verified" || external.adapterName !== adapterName
      || external.version !== manifest.version) return undefined;
    const argument = expression.arguments[0]!;
    if ((!ts.isIdentifier(argument) || argument.text !== receiver)
      && !sameRuntimeIdentity(external, argument)) return undefined;
    return external;
  };

  type ActionCompletion = CompletionSummary<
    TemporalExpression,
    TemporalExpression,
    ReadonlyMap<string, TemporalExpression>
  >;
  const completionPredicate = (completion: ActionCompletion, abrupt: AbruptCompletion): TemporalExpression => completion === abrupt
    ? { kind: "boolean", value: true }
    : completion === "normal" || typeof completion === "string" ? { kind: "boolean", value: false }
      : completion[abrupt === "return" ? "returnWhen"
        : abrupt === "throw" ? "throwWhen"
          : abrupt === "break" ? "breakWhen" : "continueWhen"]
        ?? { kind: "boolean", value: false };
  const completionThrowValue = (completion: ActionCompletion): TemporalExpression | undefined =>
    typeof completion === "object" ? completion.throwValue : undefined;
  const completionThrowLocals = (completion: ActionCompletion): ReadonlyMap<string, TemporalExpression> | undefined =>
    typeof completion === "object" ? completion.throwLocals : undefined;
  const completionReturnLocals = (completion: ActionCompletion): ReadonlyMap<string, TemporalExpression> | undefined =>
    typeof completion === "object" ? completion.returnLocals : undefined;
  const completionBreakLocals = (completion: ActionCompletion): ReadonlyMap<string, TemporalExpression> | undefined =>
    typeof completion === "object" ? completion.breakLocals : undefined;
  const completionContinueLocals = (completion: ActionCompletion): ReadonlyMap<string, TemporalExpression> | undefined =>
    typeof completion === "object" ? completion.continueLocals : undefined;
  const completionLabels = (
    completion: ActionCompletion,
    kind: "break" | "continue",
  ): ReadonlyMap<string, TemporalExpression> => typeof completion === "object"
    ? completion[kind === "break" ? "breakLabels" : "continueLabels"] ?? new Map()
    : new Map();
  const isBooleanCompletionPredicate = (expression: TemporalExpression, value: boolean): boolean => expression.kind === "boolean" && expression.value === value;
  const orCompletionPredicates = (left: TemporalExpression, right: TemporalExpression): TemporalExpression => {
    if (isBooleanCompletionPredicate(left, false)) return right;
    if (isBooleanCompletionPredicate(right, false)) return left;
    if (isBooleanCompletionPredicate(left, true) || isBooleanCompletionPredicate(right, true)) return { kind: "boolean", value: true };
    if (right.kind === "conditional" && sameRefinementExpression(left, right.condition)) {
      return orCompletionPredicates(left, right.whenFalse);
    }
    if (left.kind === "conditional" && sameRefinementExpression(right, left.condition)) {
      return orCompletionPredicates(right, left.whenFalse);
    }
    return { kind: "binary", operator: "or", left, right };
  };
  const andCompletionPredicates = (left: TemporalExpression, right: TemporalExpression): TemporalExpression => isBooleanCompletionPredicate(left, false) || isBooleanCompletionPredicate(right, false)
    ? { kind: "boolean", value: false }
    : isBooleanCompletionPredicate(left, true) ? right
      : isBooleanCompletionPredicate(right, true) ? left : { kind: "binary", operator: "and", left, right };
  const notCompletionPredicate = (expression: TemporalExpression): TemporalExpression => expression.kind === "boolean"
    ? { kind: "boolean", value: !expression.value }
    : { kind: "unary", operator: "not", operand: expression };
  const mergeCompletionLabels = (
    left: ReadonlyMap<string, TemporalExpression>,
    right: ReadonlyMap<string, TemporalExpression>,
    rightGuard: TemporalExpression = { kind: "boolean", value: true },
  ): ReadonlyMap<string, TemporalExpression> => {
    const merged = new Map(left);
    for (const [label, predicate] of right) {
      const guarded = andCompletionPredicates(rightGuard, predicate);
      if (isBooleanCompletionPredicate(guarded, false)) continue;
      const prior = merged.get(label);
      merged.set(label, prior ? orCompletionPredicates(prior, guarded) : guarded);
    }
    return merged;
  };
  const joinCompletionLabels = (
    condition: TemporalExpression,
    whenTrue: ReadonlyMap<string, TemporalExpression>,
    whenFalse: ReadonlyMap<string, TemporalExpression>,
  ): ReadonlyMap<string, TemporalExpression> => {
    const labels = new Set([...whenTrue.keys(), ...whenFalse.keys()]);
    const joined = new Map<string, TemporalExpression>();
    for (const label of labels) {
      const predicate = joinCompletionPredicate(
        condition,
        whenTrue.get(label) ?? { kind: "boolean", value: false },
        whenFalse.get(label) ?? { kind: "boolean", value: false },
      );
      if (!isBooleanCompletionPredicate(predicate, false)) joined.set(label, predicate);
    }
    return joined;
  };
  const labeledCompletionPredicate = (completion: ActionCompletion): TemporalExpression => {
    let predicate: TemporalExpression = { kind: "boolean", value: false };
    for (const value of [...completionLabels(completion, "break").values(), ...completionLabels(completion, "continue").values()]) {
      predicate = orCompletionPredicates(predicate, value);
    }
    return predicate;
  };
  const makeCompletion = (
    returnWhen: TemporalExpression,
    throwWhen: TemporalExpression,
    throwValue?: TemporalExpression,
    breakWhen: TemporalExpression = { kind: "boolean", value: false },
    continueWhen: TemporalExpression = { kind: "boolean", value: false },
    breakLabels: ReadonlyMap<string, TemporalExpression> = new Map(),
    continueLabels: ReadonlyMap<string, TemporalExpression> = new Map(),
    throwLocals?: ReadonlyMap<string, TemporalExpression>,
    returnLocals?: ReadonlyMap<string, TemporalExpression>,
    breakLocals?: ReadonlyMap<string, TemporalExpression>,
    continueLocals?: ReadonlyMap<string, TemporalExpression>,
  ): ActionCompletion => {
    const noReturn = isBooleanCompletionPredicate(returnWhen, false);
    const noThrow = isBooleanCompletionPredicate(throwWhen, false);
    const noBreak = isBooleanCompletionPredicate(breakWhen, false);
    const noContinue = isBooleanCompletionPredicate(continueWhen, false);
    const noBreakLabels = breakLabels.size === 0;
    const noContinueLabels = continueLabels.size === 0;
    if (noReturn && noThrow && noBreak && noContinue && noBreakLabels && noContinueLabels) return "normal";
    if (isBooleanCompletionPredicate(returnWhen, true) && noThrow && noBreak && noContinue && noBreakLabels && noContinueLabels && !returnLocals) return "return";
    if (isBooleanCompletionPredicate(throwWhen, true) && noReturn && noBreak && noContinue && noBreakLabels && noContinueLabels && !throwValue && !throwLocals) return "throw";
    if (isBooleanCompletionPredicate(breakWhen, true) && noReturn && noThrow && noContinue && noBreakLabels && noContinueLabels && !breakLocals) return "break";
    if (isBooleanCompletionPredicate(continueWhen, true) && noReturn && noThrow && noBreak && noBreakLabels && noContinueLabels && !continueLocals) return "continue";
    return {
      kind: "mixed",
      ...(noReturn ? {} : { returnWhen }),
      ...(noThrow ? {} : { throwWhen }),
      ...(noBreak ? {} : { breakWhen }),
      ...(noContinue ? {} : { continueWhen }),
      ...(noBreakLabels ? {} : { breakLabels }),
      ...(noContinueLabels ? {} : { continueLabels }),
      ...(throwValue ? { throwValue } : {}),
      ...(throwLocals ? { throwLocals } : {}),
      ...(returnLocals ? { returnLocals } : {}),
      ...(breakLocals ? { breakLocals } : {}),
      ...(continueLocals ? { continueLocals } : {}),
    };
  };
  const joinCompletionPredicate = (condition: TemporalExpression, whenTrue: TemporalExpression, whenFalse: TemporalExpression): TemporalExpression => {
    if (isBooleanCompletionPredicate(whenTrue, true) && isBooleanCompletionPredicate(whenFalse, false)) return condition;
    if (isBooleanCompletionPredicate(whenTrue, false) && isBooleanCompletionPredicate(whenFalse, true)) return notCompletionPredicate(condition);
    if (sameRefinementExpression(whenTrue, whenFalse)) return whenTrue;
    return { kind: "conditional", condition, whenTrue, whenFalse };
  };
  const joinThrowValue = (
    condition: TemporalExpression,
    whenTrue: ActionCompletion,
    whenFalse: ActionCompletion,
  ): TemporalExpression | undefined => {
    const trueThrows = completionPredicate(whenTrue, "throw");
    const falseThrows = completionPredicate(whenFalse, "throw");
    const trueValue = completionThrowValue(whenTrue);
    const falseValue = completionThrowValue(whenFalse);
    if (isBooleanCompletionPredicate(trueThrows, false)) return falseValue;
    if (isBooleanCompletionPredicate(falseThrows, false)) return trueValue;
    if (!trueValue || !falseValue) return undefined;
    return sameRefinementExpression(trueValue, falseValue)
      ? trueValue
      : joinCompletionPredicate(condition, trueValue, falseValue);
  };
  const completionEdgeLocals = (
    completion: ActionCompletion,
    abrupt: AbruptCompletion,
  ): ReadonlyMap<string, TemporalExpression> | undefined => abrupt === "return"
    ? completionReturnLocals(completion)
    : abrupt === "throw" ? completionThrowLocals(completion)
      : abrupt === "break" ? completionBreakLocals(completion)
        : completionContinueLocals(completion);
  const joinLocalSnapshots = (
    condition: TemporalExpression,
    whenTrue: ReadonlyMap<string, TemporalExpression>,
    whenFalse: ReadonlyMap<string, TemporalExpression>,
  ): ReadonlyMap<string, TemporalExpression> | undefined => {
    if (whenTrue.size !== whenFalse.size
      || [...whenTrue.keys()].some((name) => !whenFalse.has(name))) return undefined;
    return joinFlowValues<string, TemporalExpression, TemporalExpression>({
      keys: whenTrue.keys(),
      condition,
      original: (name) => whenTrue.get(name)!,
      whenTrue: (name) => whenTrue.get(name),
      whenFalse: (name) => whenFalse.get(name),
      equivalent: sameRefinementExpression,
      phi: (selected, trueValue, falseValue): TemporalExpression => ({
        kind: "conditional", condition: selected, whenTrue: trueValue, whenFalse: falseValue,
      }),
    });
  };
  const projectLocalSnapshot = (
    snapshot: ReadonlyMap<string, TemporalExpression>,
    visibleNames: Iterable<string>,
  ): Map<string, TemporalExpression> | undefined => {
    const projected = new Map<string, TemporalExpression>();
    for (const name of visibleNames) {
      const value = snapshot.get(name);
      if (!value) return undefined;
      projected.set(name, value);
    }
    return projected;
  };
  const joinVisibleLocalSnapshots = (
    condition: TemporalExpression,
    whenTrue: ReadonlyMap<string, TemporalExpression>,
    whenFalse: ReadonlyMap<string, TemporalExpression>,
    visibleNames: Iterable<string>,
  ): ReadonlyMap<string, TemporalExpression> | undefined => {
    const names = [...visibleNames];
    const trueProjection = projectLocalSnapshot(whenTrue, names);
    const falseProjection = projectLocalSnapshot(whenFalse, names);
    return trueProjection && falseProjection
      ? joinLocalSnapshots(condition, trueProjection, falseProjection)
      : undefined;
  };
  const joinEdgeLocals = (
    condition: TemporalExpression,
    abrupt: AbruptCompletion,
    whenTrue: ActionCompletion,
    whenFalse: ActionCompletion,
  ): ReadonlyMap<string, TemporalExpression> | undefined => {
    const trueAbrupt = completionPredicate(whenTrue, abrupt);
    const falseAbrupt = completionPredicate(whenFalse, abrupt);
    if (isBooleanCompletionPredicate(trueAbrupt, false)) return completionEdgeLocals(whenFalse, abrupt);
    if (isBooleanCompletionPredicate(falseAbrupt, false)) return completionEdgeLocals(whenTrue, abrupt);
    const trueLocals = completionEdgeLocals(whenTrue, abrupt);
    const falseLocals = completionEdgeLocals(whenFalse, abrupt);
    return trueLocals && falseLocals ? joinLocalSnapshots(condition, trueLocals, falseLocals) : undefined;
  };
  const sequenceThrowValue = (
    prior: ActionCompletion,
    continued: ActionCompletion,
  ): TemporalExpression | undefined => {
    const priorThrows = completionPredicate(prior, "throw");
    const continuedThrows = completionPredicate(continued, "throw");
    const priorValue = completionThrowValue(prior);
    const continuedValue = completionThrowValue(continued);
    if (isBooleanCompletionPredicate(priorThrows, true)) return priorValue;
    if (isBooleanCompletionPredicate(priorThrows, false)) return continuedValue;
    if (isBooleanCompletionPredicate(continuedThrows, false)) return priorValue;
    if (!priorValue || !continuedValue) return undefined;
    return sameRefinementExpression(priorValue, continuedValue)
      ? priorValue
      : { kind: "conditional", condition: priorThrows, whenTrue: priorValue, whenFalse: continuedValue };
  };
  const sequenceEdgeLocals = (
    prior: ActionCompletion,
    continued: ActionCompletion,
    abrupt: AbruptCompletion,
  ): ReadonlyMap<string, TemporalExpression> | undefined => {
    const priorAbrupt = completionPredicate(prior, abrupt);
    const continuedAbrupt = completionPredicate(continued, abrupt);
    if (isBooleanCompletionPredicate(priorAbrupt, true)) return completionEdgeLocals(prior, abrupt);
    if (isBooleanCompletionPredicate(priorAbrupt, false)) return completionEdgeLocals(continued, abrupt);
    if (isBooleanCompletionPredicate(continuedAbrupt, false)) return completionEdgeLocals(prior, abrupt);
    const priorLocals = completionEdgeLocals(prior, abrupt);
    const continuedLocals = completionEdgeLocals(continued, abrupt);
    return priorLocals && continuedLocals
      ? joinLocalSnapshots(priorAbrupt, priorLocals, continuedLocals)
      : undefined;
  };
  const joinIncomingCompletionLocals = (
    completion: ActionCompletion,
    normalLocals: ReadonlyMap<string, TemporalExpression>,
  ): Map<string, TemporalExpression> | undefined => {
    const hasMutableLocals = [...normalLocals.keys()].some((name) => name.startsWith("\u0000mutable:"));
    if (!hasMutableLocals) return new Map(normalLocals);
    if (!isBooleanCompletionPredicate(labeledCompletionPredicate(completion), false)) return undefined;
    let joined = new Map(normalLocals);
    for (const abrupt of ["return", "throw", "break", "continue"] as const) {
      const predicate = completionPredicate(completion, abrupt);
      if (isBooleanCompletionPredicate(predicate, false)) continue;
      const edgeLocals = completionEdgeLocals(completion, abrupt);
      if (!edgeLocals) return undefined;
      const projected = projectLocalSnapshot(edgeLocals, normalLocals.keys());
      if (!projected) return undefined;
      const next = joinLocalSnapshots(predicate, projected, joined);
      if (!next) return undefined;
      joined = new Map(next);
    }
    return joined;
  };
  const joinConsumedCompletionLocals = (
    completion: ActionCompletion,
    abrupt: "break" | "continue",
    normalLocals: ReadonlyMap<string, TemporalExpression>,
  ): Map<string, TemporalExpression> | undefined => {
    const predicate = completionPredicate(completion, abrupt);
    if (isBooleanCompletionPredicate(predicate, false)) return new Map(normalLocals);
    const hasMutableLocals = [...normalLocals.keys()].some((name) => name.startsWith("\u0000mutable:"));
    if (!hasMutableLocals) return new Map(normalLocals);
    const edgeLocals = completionEdgeLocals(completion, abrupt);
    if (!edgeLocals) return undefined;
    const projected = projectLocalSnapshot(edgeLocals, normalLocals.keys());
    if (!projected) return undefined;
    const joined = joinLocalSnapshots(predicate, projected, normalLocals);
    return joined ? new Map(joined) : undefined;
  };
  const projectCompletionLocalSnapshots = (
    completion: ActionCompletion,
    visibleNames: Iterable<string>,
  ): ActionCompletion | undefined => {
    if (typeof completion === "string") return completion;
    const names = [...visibleNames];
    const project = (snapshot: ReadonlyMap<string, TemporalExpression> | undefined) =>
      snapshot ? projectLocalSnapshot(snapshot, names) : undefined;
    const throwLocals = project(completionThrowLocals(completion));
    const returnLocals = project(completionReturnLocals(completion));
    const breakLocals = project(completionBreakLocals(completion));
    const continueLocals = project(completionContinueLocals(completion));
    if ((completionThrowLocals(completion) && !throwLocals)
      || (completionReturnLocals(completion) && !returnLocals)
      || (completionBreakLocals(completion) && !breakLocals)
      || (completionContinueLocals(completion) && !continueLocals)) return undefined;
    return makeCompletion(
      completionPredicate(completion, "return"),
      completionPredicate(completion, "throw"),
      completionThrowValue(completion),
      completionPredicate(completion, "break"),
      completionPredicate(completion, "continue"),
      completionLabels(completion, "break"),
      completionLabels(completion, "continue"),
      throwLocals,
      returnLocals,
      breakLocals,
      continueLocals,
    );
  };
  const maxFiniteExpansionIterations = 256;
  let finiteExpansionIterationsRemaining = maxFiniteExpansionIterations;
  let permittedGuardedExternal: ExternalRefinementActionContract | undefined;
  const collect = (
    body: ts.Block,
    receiver: string,
    runtimeClass: ts.ClassDeclaration | undefined,
    initialSubstitutions: ReadonlyMap<string, ts.Expression>,
    updates: Map<string, TemporalExpression> = new Map(),
    localValues: Map<string, TemporalExpression> = new Map(),
    activeCalls: ReadonlySet<string> = new Set(),
    allowTerminalReturn = true,
    allowTerminalThrow = false,
    allowBreak = false,
    allowContinue = false,
    ownedBreakLabel?: string,
    ownedContinueLabel?: string,
    activeBreakLabels: ReadonlySet<string> = new Set(),
    activeContinueLabels: ReadonlySet<string> = new Set(),
    allowMutableLoopWrites = false,
  ): ActionCompletion | undefined => {
    // Each lexical block gets its own immutable-alias environment. Recursive
    // branch collection receives a snapshot, so aliases declared in a nested
    // block cannot leak into its sibling or enclosing continuation.
    const substitutions = new Map(initialSubstitutions);
    const isRuntimeReceiverExpression = (expression: ts.Expression, seen: ReadonlySet<string> = new Set()): boolean => {
      const candidate = unwrap(expression);
      if (candidate.kind === ts.SyntaxKind.ThisKeyword) return receiver === "this";
      if (!ts.isIdentifier(candidate)) return false;
      if (candidate.text === receiver) return true;
      if (seen.has(candidate.text)) return false;
      const replacement = substitutions.get(candidate.text);
      return replacement !== undefined
        && isRuntimeReceiverExpression(replacement, new Set([...seen, candidate.text]));
    };
    const expandLocalSnapshots = (expression: TemporalExpression): TemporalExpression => {
      if (expression.kind === "name" && expression.name.startsWith("\u0000local:")) {
        return localValues.get(expression.name.slice("\u0000local:".length)) ?? expression;
      }
      if (expression.kind === "unary") return { ...expression, operand: expandLocalSnapshots(expression.operand) };
      if (expression.kind === "binary") return { ...expression, left: expandLocalSnapshots(expression.left), right: expandLocalSnapshots(expression.right) };
      if (expression.kind === "conditional") return { ...expression, condition: expandLocalSnapshots(expression.condition), whenTrue: expandLocalSnapshots(expression.whenTrue), whenFalse: expandLocalSnapshots(expression.whenFalse) };
      if (expression.kind === "field") {
        const receiver = expandLocalSnapshots(expression.receiver);
        const project = (value: TemporalExpression): TemporalExpression | undefined => {
          if (value.kind === "record") {
            const own = value.fields[expression.name];
            if (own) return expandLocalSnapshots(own);
            return value.base ? project(value.base) : undefined;
          }
          if (value.kind === "conditional") {
            const whenTrue = project(value.whenTrue);
            const whenFalse = project(value.whenFalse);
            if (!whenTrue || !whenFalse) return undefined;
            return sameRefinementExpression(whenTrue, whenFalse)
              ? whenTrue
              : { kind: "conditional", condition: value.condition, whenTrue, whenFalse };
          }
          return undefined;
        };
        return project(receiver) ?? { ...expression, receiver };
      }
      if (expression.kind === "record") return { ...expression, ...(expression.base ? { base: expandLocalSnapshots(expression.base) } : {}), fields: Object.fromEntries(Object.entries(expression.fields).map(([name, value]) => [name, expandLocalSnapshots(value)])) };
      if (expression.kind === "array") return { ...expression, elements: expression.elements.map(expandLocalSnapshots) };
      return expression;
    };
    const resolveCurrentState = (expression: TemporalExpression): TemporalExpression => {
      const canonical = canonicalize(expression);
      if (!sameRefinementExpression(canonical, expression)) return resolveCurrentState(canonical);
      if (expression.kind === "name") {
        const name = concreteToAbstract.get(expression.name) ?? expression.name;
        return updates.get(name) ?? { kind: "name", name };
      }
      if (expression.kind === "unary") return { ...expression, operand: resolveCurrentState(expression.operand) };
      if (expression.kind === "binary") return { ...expression, left: resolveCurrentState(expression.left), right: resolveCurrentState(expression.right) };
      if (expression.kind === "conditional") return { ...expression, condition: resolveCurrentState(expression.condition), whenTrue: resolveCurrentState(expression.whenTrue), whenFalse: resolveCurrentState(expression.whenFalse) };
      if (expression.kind === "field") return { ...expression, receiver: resolveCurrentState(expression.receiver) };
      if (expression.kind === "record") return { ...expression, ...(expression.base ? { base: resolveCurrentState(expression.base) } : {}), fields: Object.fromEntries(Object.entries(expression.fields).map(([name, value]) => [name, resolveCurrentState(value)])) };
      if (expression.kind === "array") return { ...expression, elements: expression.elements.map(resolveCurrentState) };
      return expression;
    };
    const selectField = (value: TemporalExpression, name: string): TemporalExpression => {
      if (value.kind === "record") {
        const updated = value.fields[name];
        if (updated) return updated;
        if (value.base) return selectField(value.base, name);
      }
      return { kind: "field", receiver: value, name };
    };
    const readPath = (root: string, fields: readonly string[]): TemporalExpression => fields.reduce<TemporalExpression>(
      (value, name) => selectField(value, name),
      updates.get(root) ?? { kind: "name", name: root },
    );
    const writePath = (root: string, fields: readonly string[], value: TemporalExpression): void => {
      if (fields.length === 0) { updates.set(root, value); return; }
      const updateRecord = (base: TemporalExpression, remaining: readonly string[]): TemporalExpression => {
        const [name, ...tail] = remaining;
        if (!name) return value;
        const fieldValue = tail.length === 0 ? value : updateRecord(selectField(base, name), tail);
        if (base.kind === "record" && base.base) return { ...base, fields: { ...base.fields, [name]: fieldValue } };
        return { kind: "record", base, fields: { [name]: fieldValue } };
      };
      const base = updates.get(root) ?? { kind: "name", name: root } as TemporalExpression;
      updates.set(root, updateRecord(base, fields));
    };
    const asBlock = (statement: ts.Statement | undefined): ts.Block => !statement
      ? ts.factory.createBlock([], true)
      : ts.isBlock(statement) ? statement : ts.factory.createBlock([statement], true);
    const substituteFiniteLoopBinding = (
      statement: ts.Statement,
      binding: string,
      replacement: ts.Expression,
    ): ts.Statement | undefined => {
      let unsupported = false;
      const pending: ts.Node[] = [statement];
      while (pending.length > 0) {
        const node = pending.pop()!;
        if (ts.isIdentifier(node) && node.text === binding) {
          const parent = node.parent;
          const shadowsBinding = ((ts.isVariableDeclaration(parent) || ts.isParameter(parent) || ts.isBindingElement(parent))
            && parent.name === node);
          if (shadowsBinding || (ts.isShorthandPropertyAssignment(parent) && parent.name === node)) unsupported = true;
        }
        node.forEachChild((child) => { pending.push(child); });
      }
      if (unsupported) return undefined;
      const transformed = ts.transform(statement, [(context) => {
        const visit: ts.Visitor = (node) => {
          if (ts.isIdentifier(node) && node.text === binding) {
            const parent = node.parent;
            const isPropertyName = (ts.isPropertyAccessExpression(parent) && parent.name === node)
              || ((ts.isPropertyAssignment(parent) || ts.isMethodDeclaration(parent) || ts.isPropertyDeclaration(parent)) && parent.name === node)
              || (ts.isLabeledStatement(parent) && parent.label === node)
              || ((ts.isBreakStatement(parent) || ts.isContinueStatement(parent)) && parent.label === node);
            if (!isPropertyName) return replacement;
          }
          return ts.visitEachChild(node, visit, context);
        };
        return (root) => ts.visitNode(root, visit) as ts.Statement;
      }]);
      const result = transformed.transformed[0];
      transformed.dispose();
      return result;
    };
    const expandFiniteLoopIterations = (
      statement: ts.Statement,
      binding: string,
      values: readonly ts.Expression[],
    ): readonly ts.Block[] | undefined => {
      if (values.length > finiteExpansionIterationsRemaining) return undefined;
      finiteExpansionIterationsRemaining -= values.length;
      const iterations: ts.Block[] = [];
      for (const value of values) {
        const statements: ts.Statement[] = [];
        for (const item of asBlock(statement).statements) {
          const expanded = substituteFiniteLoopBinding(item, binding, value);
          if (!expanded) return undefined;
          statements.push(expanded);
        }
        iterations.push(ts.factory.createBlock(statements, true));
      }
      return iterations;
    };
    const canonicalBoundedWhile = (
      declarationStatement: ts.VariableStatement,
      loopStatement: ts.Statement,
    ): { binding: string; body: ts.Block; values: readonly ts.Expression[] } | undefined => {
      const declaration = (declarationStatement.declarationList.flags & ts.NodeFlags.Let) !== 0
        && declarationStatement.declarationList.declarations.length === 1
        ? declarationStatement.declarationList.declarations[0] : undefined;
      const binding = declaration && ts.isIdentifier(declaration.name) ? declaration.name.text : undefined;
      const start = declaration?.initializer && ts.isNumericLiteral(declaration.initializer)
        ? Number(declaration.initializer.text) : undefined;
      const condition = ts.isWhileStatement(loopStatement) && ts.isBinaryExpression(loopStatement.expression)
        ? loopStatement.expression : undefined;
      const end = condition && condition.operatorToken.kind === ts.SyntaxKind.LessThanToken
        && ts.isIdentifier(condition.left) && condition.left.text === binding && ts.isNumericLiteral(condition.right)
        ? Number(condition.right.text) : undefined;
      const loopBody = ts.isWhileStatement(loopStatement) && ts.isBlock(loopStatement.statement)
        ? loopStatement.statement : undefined;
      const last = loopBody?.statements.at(-1);
      const increment = last && ts.isExpressionStatement(last) && ts.isPostfixUnaryExpression(last.expression)
        ? last.expression : undefined;
      const incrementsBinding = increment?.operator === ts.SyntaxKind.PlusPlusToken
        && ts.isIdentifier(increment.operand) && increment.operand.text === binding;
      if (!binding || start === undefined || end === undefined || !loopBody || !incrementsBinding
        || !Number.isSafeInteger(start) || !Number.isSafeInteger(end)
        || start < 0 || end < start || end - start > 64) return undefined;
      return {
        binding,
        body: ts.factory.createBlock(loopBody.statements.slice(0, -1), true),
        values: Array.from({ length: end - start }, (_, offset) => ts.factory.createNumericLiteral(start + offset)),
      };
    };
    const boundedForIterations = (statement: ts.ForStatement): readonly ts.Block[] | undefined => {
      const declaration = statement.initializer && ts.isVariableDeclarationList(statement.initializer)
        && (statement.initializer.flags & ts.NodeFlags.Let) !== 0
        && statement.initializer.declarations.length === 1 ? statement.initializer.declarations[0] : undefined;
      const loopName = declaration && ts.isIdentifier(declaration.name) ? declaration.name.text : undefined;
      const start = declaration?.initializer && ts.isNumericLiteral(declaration.initializer)
        ? Number(declaration.initializer.text) : undefined;
      const condition = statement.condition && ts.isBinaryExpression(statement.condition) ? statement.condition : undefined;
      const end = condition && condition.operatorToken.kind === ts.SyntaxKind.LessThanToken
        && ts.isIdentifier(condition.left) && condition.left.text === loopName && ts.isNumericLiteral(condition.right)
        ? Number(condition.right.text) : undefined;
      const increment = statement.incrementor;
      const incrementsLoop = increment && ts.isPostfixUnaryExpression(increment)
        && increment.operator === ts.SyntaxKind.PlusPlusToken
        && ts.isIdentifier(increment.operand) && increment.operand.text === loopName;
      if (!loopName || start === undefined || end === undefined || !incrementsLoop
        || !Number.isSafeInteger(start) || !Number.isSafeInteger(end)
        || start < 0 || end < start || end - start > 64) return undefined;
      return expandFiniteLoopIterations(
        statement.statement,
        loopName,
        Array.from({ length: end - start }, (_, offset) => ts.factory.createNumericLiteral(start + offset)),
      );
    };
    const boundedForOfIterations = (statement: ts.ForOfStatement): readonly ts.Block[] | undefined => {
      const declaration = ts.isVariableDeclarationList(statement.initializer)
        && (statement.initializer.flags & ts.NodeFlags.Const) !== 0
        && statement.initializer.declarations.length === 1 ? statement.initializer.declarations[0] : undefined;
      const loopName = declaration && ts.isIdentifier(declaration.name) && !declaration.initializer
        ? declaration.name.text : undefined;
      const iterable = ts.isAsExpression(statement.expression) ? statement.expression.expression : statement.expression;
      const values = ts.isArrayLiteralExpression(iterable) && iterable.elements.length <= 64
        && iterable.elements.every((element): element is ts.Expression => !ts.isSpreadElement(element)
          && (ts.isNumericLiteral(element) || element.kind === ts.SyntaxKind.TrueKeyword || element.kind === ts.SyntaxKind.FalseKeyword))
        ? [...iterable.elements] : undefined;
      if (statement.awaitModifier || !loopName || !values) return undefined;
      return expandFiniteLoopIterations(statement.statement, loopName, values);
    };
    const isUntrackedPrimitiveThrownValue = (expression: ts.Expression): boolean => {
      const value = unwrap(expression);
      return ts.isStringLiteral(value) || value.kind === ts.SyntaxKind.NullKeyword;
    };
    const pathCorrelatedConditional = (
      condition: TemporalExpression,
      whenTrue: TemporalExpression,
      whenFalse: TemporalExpression,
    ): { expression: TemporalExpression; correlated: boolean } => {
      const constrainedTrue = whenTrue.kind === "conditional"
        && sameRefinementExpression(condition, whenTrue.condition)
        ? whenTrue.whenTrue : whenTrue;
      const constrainedFalse = whenFalse.kind === "conditional"
        && sameRefinementExpression(condition, whenFalse.condition)
        ? whenFalse.whenFalse : whenFalse;
      const expression: TemporalExpression = sameRefinementExpression(constrainedTrue, constrainedFalse)
        ? constrainedTrue
        : { kind: "conditional", condition, whenTrue: constrainedTrue, whenFalse: constrainedFalse };
      return {
        expression,
        correlated: constrainedTrue !== whenTrue || constrainedFalse !== whenFalse,
      };
    };
    const mergeConditionalUpdates = (
      condition: TemporalExpression,
      whenTrue: ReadonlyMap<string, TemporalExpression>,
      whenFalse: ReadonlyMap<string, TemporalExpression>,
      before: ReadonlyMap<string, TemporalExpression>,
      target: Map<string, TemporalExpression> = updates,
      retainPathCorrelation = false,
    ): void => {
      target.clear();
      const joined = joinFlowValues<string, TemporalExpression, TemporalExpression>({
        keys: stateNames,
        condition,
        original: (name) => before.get(name) ?? { kind: "name", name } as TemporalExpression,
        whenTrue: (name) => whenTrue.get(name),
        whenFalse: (name) => whenFalse.get(name),
        equivalent: sameRefinementExpression,
        phi: (selected, trueValue, falseValue) => {
          if (isBooleanCompletionPredicate(selected, true)) return trueValue;
          if (isBooleanCompletionPredicate(selected, false)) return falseValue;
          const correlated = pathCorrelatedConditional(selected, trueValue, falseValue);
          if (retainPathCorrelation && correlated.correlated && traceSink && currentModelName) {
            traceSink.handlerValueJoins.push({ modelName: currentModelName, condition: selected });
          }
          return correlated.expression;
        },
      });
      for (const [name, merged] of joined) {
        if (!sameRefinementExpression(merged, { kind: "name", name })) target.set(name, merged);
      }
    };
    const mutableLocalMarker = (name: string): string => `\u0000mutable:${name}`;
    const mutableLocalSnapshot = (): Map<string, TemporalExpression> | undefined =>
      [...localValues.keys()].some((name) => name.startsWith("\u0000mutable:"))
        ? new Map(localValues) : undefined;
    const mergeConditionalLocalValues = (
      condition: TemporalExpression,
      whenTrue: ReadonlyMap<string, TemporalExpression>,
      whenFalse: ReadonlyMap<string, TemporalExpression>,
      before: ReadonlyMap<string, TemporalExpression>,
    ): void => {
      // Only bindings already visible before the branch may flow out. This is
      // the local-variable counterpart of the state phi join above; lexical
      // declarations created inside either branch remain scoped to that arm.
      const joined = joinFlowValues<string, TemporalExpression, TemporalExpression>({
        keys: [...before.keys()].filter((name) => !name.startsWith("\u0000mutable:")),
        condition,
        original: (name) => before.get(name)!,
        whenTrue: (name) => whenTrue.get(name),
        whenFalse: (name) => whenFalse.get(name),
        equivalent: sameRefinementExpression,
        phi: (selected, trueValue, falseValue): TemporalExpression => ({
          kind: "conditional", condition: selected, whenTrue: trueValue, whenFalse: falseValue,
        }),
      });
      for (const [name, value] of joined) localValues.set(name, value);
    };
    const applyContinuation = (
      completion: ActionCompletion,
      branchUpdates: Map<string, TemporalExpression>,
      continuation: ts.Block,
      branchLocals: Map<string, TemporalExpression> = new Map(localValues),
    ): ActionCompletion | undefined => {
      if (completion === "return" || completion === "throw" || completion === "break" || completion === "continue") return completion;
      if (completion === "normal") return collect(
        continuation, receiver, runtimeClass, substitutions,
        branchUpdates, branchLocals, activeCalls, allowTerminalReturn, allowTerminalThrow,
        allowBreak, allowContinue, ownedBreakLabel, ownedContinueLabel,
        activeBreakLabels, activeContinueLabels, allowMutableLoopWrites,
      );
      const beforeContinuation = new Map(branchUpdates);
      const continuingUpdates = new Map(branchUpdates);
      const continued = collect(
        continuation, receiver, runtimeClass, substitutions,
        continuingUpdates, new Map(branchLocals), activeCalls, allowTerminalReturn, allowTerminalThrow,
        allowBreak, allowContinue, ownedBreakLabel, ownedContinueLabel,
        activeBreakLabels, activeContinueLabels, allowMutableLoopWrites,
      );
      if (!continued) return undefined;
      const priorReturn = completionPredicate(completion, "return");
      const priorThrow = completionPredicate(completion, "throw");
      const priorBreak = completionPredicate(completion, "break");
      const priorContinue = completionPredicate(completion, "continue");
      const priorLabeled = labeledCompletionPredicate(completion);
      const priorAbrupt = orCompletionPredicates(
        orCompletionPredicates(
          orCompletionPredicates(orCompletionPredicates(priorReturn, priorThrow), priorBreak), priorContinue,
        ),
        priorLabeled,
      );
      const normalWhen = notCompletionPredicate(priorAbrupt);
      mergeConditionalUpdates(priorAbrupt, beforeContinuation, continuingUpdates, beforeContinuation, branchUpdates);
      return makeCompletion(
        orCompletionPredicates(priorReturn, andCompletionPredicates(normalWhen, completionPredicate(continued, "return"))),
        orCompletionPredicates(priorThrow, andCompletionPredicates(normalWhen, completionPredicate(continued, "throw"))),
        sequenceThrowValue(completion, continued),
        orCompletionPredicates(priorBreak, andCompletionPredicates(normalWhen, completionPredicate(continued, "break"))),
        orCompletionPredicates(priorContinue, andCompletionPredicates(normalWhen, completionPredicate(continued, "continue"))),
        mergeCompletionLabels(completionLabels(completion, "break"), completionLabels(continued, "break"), normalWhen),
        mergeCompletionLabels(completionLabels(completion, "continue"), completionLabels(continued, "continue"), normalWhen),
        sequenceEdgeLocals(completion, continued, "throw"),
        sequenceEdgeLocals(completion, continued, "return"),
        sequenceEdgeLocals(completion, continued, "break"),
        sequenceEdgeLocals(completion, continued, "continue"),
      );
    };
    const collectFiniteLoopIterations = (
      iterations: readonly ts.Block[],
      index: number,
      branchUpdates: Map<string, TemporalExpression>,
      branchLocals: Map<string, TemporalExpression>,
      transferLabel?: string,
      allowIterationContinue = true,
    ): ActionCompletion | undefined => {
      const iteration = iterations[index];
      if (!iteration) return "normal";
      const completion = collect(
        iteration, receiver, runtimeClass, substitutions,
        branchUpdates, branchLocals, activeCalls,
        allowTerminalReturn, allowTerminalThrow, true, allowIterationContinue, transferLabel, transferLabel,
        transferLabel ? new Set([...activeBreakLabels, transferLabel]) : activeBreakLabels,
        transferLabel ? new Set([...activeContinueLabels, transferLabel]) : activeContinueLabels,
        true,
      );
      if (!completion) return undefined;
      const nextIterationLocals = joinConsumedCompletionLocals(completion, "continue", branchLocals);
      if (!nextIterationLocals) return undefined;
      const falsePredicate: TemporalExpression = { kind: "boolean", value: false };
      const targetedBreak = transferLabel
        ? completionLabels(completion, "break").get(transferLabel) ?? falsePredicate
        : falsePredicate;
      const remainingBreakLabels = new Map(completionLabels(completion, "break"));
      const remainingContinueLabels = new Map(completionLabels(completion, "continue"));
      if (transferLabel) {
        remainingBreakLabels.delete(transferLabel);
        remainingContinueLabels.delete(transferLabel);
      }
      const afterContinue = makeCompletion(
        completionPredicate(completion, "return"),
        completionPredicate(completion, "throw"),
        completionThrowValue(completion),
        orCompletionPredicates(completionPredicate(completion, "break"), targetedBreak),
        { kind: "boolean", value: false },
        remainingBreakLabels,
        remainingContinueLabels,
        completionThrowLocals(completion),
        completionReturnLocals(completion),
        completionBreakLocals(completion),
      );
      if (index + 1 >= iterations.length) {
        branchLocals.clear();
        for (const [name, value] of nextIterationLocals) branchLocals.set(name, value);
        return afterContinue;
      }
      if (afterContinue === "return" || afterContinue === "throw" || afterContinue === "break") return afterContinue;
      if (afterContinue === "normal") {
        const next = collectFiniteLoopIterations(
          iterations, index + 1, branchUpdates, nextIterationLocals, transferLabel, allowIterationContinue,
        );
        if (!next) return undefined;
        branchLocals.clear();
        for (const [name, value] of nextIterationLocals) branchLocals.set(name, value);
        return next;
      }

      const beforeNext = new Map(branchUpdates);
      const nextUpdates = new Map(branchUpdates);
      const next = collectFiniteLoopIterations(
        iterations, index + 1, nextUpdates, nextIterationLocals, transferLabel, allowIterationContinue,
      );
      if (!next) return undefined;
      const priorReturn = completionPredicate(afterContinue, "return");
      const priorThrow = completionPredicate(afterContinue, "throw");
      const priorBreak = completionPredicate(afterContinue, "break");
      const priorLabeled = labeledCompletionPredicate(afterContinue);
      const priorAbrupt = orCompletionPredicates(
        orCompletionPredicates(orCompletionPredicates(priorReturn, priorThrow), priorBreak),
        priorLabeled,
      );
      const normalWhen = notCompletionPredicate(priorAbrupt);
      mergeConditionalUpdates(priorAbrupt, beforeNext, nextUpdates, beforeNext, branchUpdates);
      branchLocals.clear();
      for (const [name, value] of nextIterationLocals) branchLocals.set(name, value);
      return makeCompletion(
        orCompletionPredicates(priorReturn, andCompletionPredicates(normalWhen, completionPredicate(next, "return"))),
        orCompletionPredicates(priorThrow, andCompletionPredicates(normalWhen, completionPredicate(next, "throw"))),
        sequenceThrowValue(afterContinue, next),
        orCompletionPredicates(priorBreak, andCompletionPredicates(normalWhen, completionPredicate(next, "break"))),
        completionPredicate(next, "continue"),
        mergeCompletionLabels(completionLabels(afterContinue, "break"), completionLabels(next, "break"), normalWhen),
        mergeCompletionLabels(completionLabels(afterContinue, "continue"), completionLabels(next, "continue"), normalWhen),
        sequenceEdgeLocals(afterContinue, next, "throw"),
        sequenceEdgeLocals(afterContinue, next, "return"),
        sequenceEdgeLocals(afterContinue, next, "break"),
        sequenceEdgeLocals(afterContinue, next, "continue"),
      );
    };
    const consumeLoopTransfers = (
      completion: ActionCompletion,
      branchUpdates: Map<string, TemporalExpression>,
      continuation: ts.Block,
      branchLocals: Map<string, TemporalExpression> = localValues,
    ): ActionCompletion | undefined => {
      const afterBreak = joinConsumedCompletionLocals(completion, "break", branchLocals);
      if (!afterBreak) return undefined;
      branchLocals.clear();
      for (const [name, value] of afterBreak) branchLocals.set(name, value);
      const escaping = makeCompletion(
        completionPredicate(completion, "return"),
        completionPredicate(completion, "throw"),
        completionThrowValue(completion),
        { kind: "boolean", value: false },
        { kind: "boolean", value: false },
        completionLabels(completion, "break"),
        completionLabels(completion, "continue"),
        completionThrowLocals(completion),
        completionReturnLocals(completion),
      );
      if (escaping === "normal") return collect(
        continuation, receiver, runtimeClass, substitutions,
        branchUpdates, new Map(branchLocals), activeCalls,
        allowTerminalReturn, allowTerminalThrow, allowBreak, allowContinue,
        ownedBreakLabel, ownedContinueLabel,
        activeBreakLabels, activeContinueLabels,
        allowMutableLoopWrites,
      );
      return applyContinuation(escaping, branchUpdates, continuation, branchLocals);
    };
    const isOwnedLabeledBlock = (statement: ts.LabeledStatement): statement is ts.LabeledStatement & { statement: ts.Block } => {
      if (!ts.isBlock(statement.statement)) return false;
      let invalid = false;
      let foundOwnedBreak = false;
      const pending: ts.Node[] = [...statement.statement.getChildren(source)];
      while (pending.length > 0) {
        const node = pending.pop()!;
        if (ts.isFunctionLike(node) || ts.isClassLike(node) || ts.isLabeledStatement(node)
          || ts.isReturnStatement(node)
          || ts.isContinueStatement(node) && !!node.label) {
          invalid = true;
          continue;
        }
        if (ts.isBreakStatement(node) && node.label) {
          if (node.label.text !== statement.label.text) invalid = true;
          else foundOwnedBreak = true;
          continue;
        }
        pending.push(...node.getChildren(source));
      }
      return !invalid && foundOwnedBreak;
    };
    for (let statementIndex = 0; statementIndex < body.statements.length; statementIndex++) {
      const statement = body.statements[statementIndex]!;
      const terminalReturn = ts.isReturnStatement(statement);
      if (terminalReturn && !allowTerminalReturn) return undefined;
      if (terminalReturn && !statement.expression) return makeCompletion(
        { kind: "boolean", value: true },
        { kind: "boolean", value: false },
        undefined,
        { kind: "boolean", value: false },
        { kind: "boolean", value: false },
        new Map(),
        new Map(),
        undefined,
        mutableLocalSnapshot(),
      );
      if (terminalReturn && !ts.isCallExpression(statement.expression!)) {
        const returned = normalizeRefinementExpression(
          statement.expression!, receiver, substitutions, expressionStateNames, new Map(), new Set(), localValues,
        );
        if (!returned) return undefined;
        // Action refinements compare state transitions, not function result values.
        // Still resolve the expression so unsupported/effectful results are not discarded.
        void expandLocalSnapshots(resolveCurrentState(returned));
        return makeCompletion(
          { kind: "boolean", value: true },
          { kind: "boolean", value: false },
          undefined,
          { kind: "boolean", value: false },
          { kind: "boolean", value: false },
          new Map(),
          new Map(),
          undefined,
          mutableLocalSnapshot(),
        );
      }
      if (ts.isThrowStatement(statement)) {
        if (!allowTerminalThrow) return undefined;
        if (!isUntrackedPrimitiveThrownValue(statement.expression)) {
          const thrown = normalizeRefinementExpression(
            statement.expression, receiver, substitutions, expressionStateNames, new Map(), new Set(), localValues,
          );
          if (!thrown) return undefined;
          return makeCompletion(
            { kind: "boolean", value: false },
            { kind: "boolean", value: true },
            expandLocalSnapshots(resolveCurrentState(thrown)),
            { kind: "boolean", value: false },
            { kind: "boolean", value: false },
            new Map(),
            new Map(),
            new Map(localValues),
          );
        }
        return "throw";
      }
      if (ts.isBreakStatement(statement)) {
        const target = breakTransferTarget(statement.label?.text);
        const ownedBreak = isTransferOwnedByLoop({ completion: "break", target }, ownedBreakLabel);
        const ownedLabeledBreak = statement.label !== undefined && ownedBreak;
        if (statement.label && !ownedBreak) {
          if (!activeBreakLabels.has(statement.label.text)) return undefined;
          return makeCompletion(
            { kind: "boolean", value: false },
            { kind: "boolean", value: false },
            undefined,
            { kind: "boolean", value: false },
            { kind: "boolean", value: false },
            new Map([[statement.label.text, { kind: "boolean", value: true }]]),
          );
        }
        if (!ownedLabeledBreak && !allowBreak) return undefined;
        return makeCompletion(
          { kind: "boolean", value: false },
          { kind: "boolean", value: false },
          undefined,
          { kind: "boolean", value: true },
          { kind: "boolean", value: false },
          new Map(),
          new Map(),
          undefined,
          undefined,
          mutableLocalSnapshot(),
        );
      }
      if (ts.isContinueStatement(statement)) {
        const target = continueTransferTarget(statement.label?.text);
        const ownedContinue = isTransferOwnedByLoop({ completion: "continue", target }, ownedContinueLabel);
        if (statement.label && !ownedContinue) {
          if (!activeContinueLabels.has(statement.label.text)) return undefined;
          return makeCompletion(
            { kind: "boolean", value: false },
            { kind: "boolean", value: false },
            undefined,
            { kind: "boolean", value: false },
            { kind: "boolean", value: false },
            new Map(),
            new Map([[statement.label.text, { kind: "boolean", value: true }]]),
          );
        }
        if (!allowContinue) return undefined;
        return makeCompletion(
          { kind: "boolean", value: false },
          { kind: "boolean", value: false },
          undefined,
          { kind: "boolean", value: false },
          { kind: "boolean", value: true },
          new Map(),
          new Map(),
          undefined,
          undefined,
          undefined,
          mutableLocalSnapshot(),
        );
      }
      if (ts.isBlock(statement)) {
        const visibleNames = [...localValues.keys()];
        const nestedLocals = new Map(localValues);
        const completion = collect(
          statement, receiver, runtimeClass, substitutions,
          updates, nestedLocals, activeCalls,
          allowTerminalReturn, allowTerminalThrow, allowBreak, allowContinue,
          ownedBreakLabel, ownedContinueLabel,
          activeBreakLabels, activeContinueLabels,
          allowMutableLoopWrites,
        );
        if (!completion) return undefined;
        const projectedNormal = projectLocalSnapshot(nestedLocals, visibleNames);
        const projectedCompletion = projectCompletionLocalSnapshots(completion, visibleNames);
        if (!projectedNormal || !projectedCompletion) return undefined;
        localValues.clear();
        for (const [name, value] of projectedNormal) localValues.set(name, value);
        if (projectedCompletion === "normal") continue;
        return applyContinuation(
          projectedCompletion, updates, ts.factory.createBlock(body.statements.slice(statementIndex + 1), true),
          localValues,
        );
      }
      if (ts.isLabeledStatement(statement)) {
        if (ts.isForStatement(statement.statement) || ts.isForOfStatement(statement.statement)) {
          const iterations = ts.isForStatement(statement.statement)
            ? boundedForIterations(statement.statement)
            : boundedForOfIterations(statement.statement);
          if (!iterations) return undefined;
          const completion = collectFiniteLoopIterations(iterations, 0, updates, localValues, statement.label.text);
          return completion ? consumeLoopTransfers(
            completion, updates, ts.factory.createBlock(body.statements.slice(statementIndex + 1), true),
          ) : undefined;
        }
        if (!isOwnedLabeledBlock(statement)) return undefined;
        const labeledLocals = new Map(localValues);
        const completion = collect(
          statement.statement, receiver, runtimeClass, substitutions,
          updates, labeledLocals, activeCalls, allowTerminalReturn, allowTerminalThrow,
          allowBreak, allowContinue, statement.label.text, ownedContinueLabel,
          activeBreakLabels, activeContinueLabels,
          allowMutableLoopWrites,
        );
        if (!completion) return undefined;
        const afterBreak = joinConsumedCompletionLocals(completion, "break", labeledLocals);
        if (!afterBreak) return undefined;
        localValues.clear();
        for (const [name, value] of afterBreak) localValues.set(name, value);
        const escapingCompletion = makeCompletion(
          completionPredicate(completion, "return"),
          completionPredicate(completion, "throw"),
          completionThrowValue(completion),
          { kind: "boolean", value: false },
          completionPredicate(completion, "continue"),
          completionLabels(completion, "break"),
          completionLabels(completion, "continue"),
          completionThrowLocals(completion),
          completionReturnLocals(completion),
          undefined,
          completionContinueLocals(completion),
        );
        if (escapingCompletion === "normal") continue;
        return applyContinuation(
          escapingCompletion, updates, ts.factory.createBlock(body.statements.slice(statementIndex + 1), true),
          localValues,
        );
      }
      if (ts.isVariableStatement(statement) && statementIndex + 1 < body.statements.length) {
        const loop = canonicalBoundedWhile(statement, body.statements[statementIndex + 1]!);
        if (loop && !localValues.has(loop.binding) && !substitutions.has(loop.binding)) {
          const iterations = expandFiniteLoopIterations(
            loop.body,
            loop.binding,
            loop.values,
          );
          if (!iterations) return undefined;
          const completion = collectFiniteLoopIterations(iterations, 0, updates, localValues, undefined, false);
          return completion ? consumeLoopTransfers(
            completion, updates, ts.factory.createBlock(body.statements.slice(statementIndex + 2), true),
          ) : undefined;
        }
      }
      if (ts.isWhileStatement(statement)) {
        // Literal false is an exact zero-iteration reduction. The additional
        // affine countdown fragment computes a symbolic loop fixed point
        // without bounding or expanding the number of iterations.
        if (statement.expression.kind === ts.SyntaxKind.FalseKeyword) continue;
        const normalizedGuard = normalizeRefinementExpression(
          statement.expression, receiver, substitutions, expressionStateNames, new Map(), new Set(), localValues,
        );
        const signedSafeInteger = (expression: TemporalExpression): number | undefined => {
          if (expression.kind === "integer") {
            const value = Number(expression.value);
            return Number.isSafeInteger(value) ? value : undefined;
          }
          if (expression.kind === "unary" && expression.operator === "negate" && expression.operand.kind === "integer") {
            const value = -Number(expression.operand.value);
            return Number.isSafeInteger(value) ? value : undefined;
          }
          return undefined;
        };
        if (!normalizedGuard || normalizedGuard.kind !== "binary" || !["gt", "gte", "lt", "lte"].includes(normalizedGuard.operator)
          || normalizedGuard.left.kind !== "name" || !stateNames.has(normalizedGuard.left.name)
        ) return undefined;
        const bound = signedSafeInteger(normalizedGuard.right);
        if (bound === undefined) return undefined;
        const descending = normalizedGuard.operator === "gt" || normalizedGuard.operator === "gte";
        const inclusive = normalizedGuard.operator === "gte" || normalizedGuard.operator === "lte";
        const stopValue = inclusive ? bound + (descending ? -1 : 1) : bound;
        if (!Number.isSafeInteger(stopValue)) return undefined;
        const integerExpression = (value: number): TemporalExpression => value >= 0
          ? { kind: "integer", value: String(value) }
          : { kind: "unary", operator: "negate", operand: { kind: "integer", value: String(-value) } };
        const counterName = normalizedGuard.left.name;
        const entryValues = new Map<string, TemporalExpression>();
        for (const name of stateNames) {
          entryValues.set(name, expandLocalSnapshots(resolveCurrentState({ kind: "name", name })));
        }
        const entryGuard = expandLocalSnapshots(resolveCurrentState(normalizedGuard));
        const loopUpdates = new Map<string, TemporalExpression>();
        const loopCompletion = collect(
          asBlock(statement.statement), receiver, runtimeClass, substitutions,
          loopUpdates, new Map(localValues), activeCalls,
          false, false, true, true,
          undefined, undefined, activeBreakLabels, activeContinueLabels,
        );
        if (!loopCompletion) return undefined;
        const breakWhen = completionPredicate(loopCompletion, "break");
        const hasInvariantEarlyBreak = !isBooleanCompletionPredicate(breakWhen, false);
        const hasOnlyConsumedLoopTransfer = isBooleanCompletionPredicate(completionPredicate(loopCompletion, "return"), false)
          && isBooleanCompletionPredicate(completionPredicate(loopCompletion, "throw"), false)
          && isBooleanCompletionPredicate(labeledCompletionPredicate(loopCompletion), false);
        if (loopCompletion !== "normal" && !hasOnlyConsumedLoopTransfer) return undefined;
        const specializeCondition = (
          expression: TemporalExpression,
          condition: TemporalExpression,
          value: boolean,
        ): TemporalExpression => {
          if (sameRefinementExpression(expression, condition)) return { kind: "boolean", value };
          if (expression.kind === "unary") return {
            ...expression, operand: specializeCondition(expression.operand, condition, value),
          };
          if (expression.kind === "binary") return {
            ...expression,
            left: specializeCondition(expression.left, condition, value),
            right: specializeCondition(expression.right, condition, value),
          };
          if (expression.kind === "conditional") {
            if (sameRefinementExpression(expression.condition, condition)) {
              return specializeCondition(value ? expression.whenTrue : expression.whenFalse, condition, value);
            }
            return {
              ...expression,
              condition: specializeCondition(expression.condition, condition, value),
              whenTrue: specializeCondition(expression.whenTrue, condition, value),
              whenFalse: specializeCondition(expression.whenFalse, condition, value),
            };
          }
          return expression;
        };
        const predicateAtoms = (expression: TemporalExpression, atoms: TemporalExpression[]): boolean => {
          if (expression.kind === "boolean") return true;
          if (expression.kind === "unary" && expression.operator === "not") {
            return predicateAtoms(expression.operand, atoms);
          }
          if (expression.kind === "binary" && (expression.operator === "and" || expression.operator === "or")) {
            return predicateAtoms(expression.left, atoms) && predicateAtoms(expression.right, atoms);
          }
          if (expression.kind === "conditional") {
            return predicateAtoms(expression.condition, atoms)
              && predicateAtoms(expression.whenTrue, atoms)
              && predicateAtoms(expression.whenFalse, atoms);
          }
          if (!atoms.some((atom) => sameRefinementExpression(atom, expression))) atoms.push(expression);
          return atoms.length <= MAX_AFFINE_LOOP_BOOLEAN_ATOMS;
        };
        const evaluatePredicate = (
          expression: TemporalExpression,
          atoms: readonly TemporalExpression[],
          values: readonly boolean[],
        ): boolean | undefined => {
          if (expression.kind === "boolean") return expression.value;
          if (expression.kind === "unary" && expression.operator === "not") {
            const operand = evaluatePredicate(expression.operand, atoms, values);
            return operand === undefined ? undefined : !operand;
          }
          if (expression.kind === "binary" && (expression.operator === "and" || expression.operator === "or")) {
            const left = evaluatePredicate(expression.left, atoms, values);
            const right = evaluatePredicate(expression.right, atoms, values);
            if (left === undefined || right === undefined) return undefined;
            return expression.operator === "and" ? left && right : left || right;
          }
          if (expression.kind === "conditional") {
            const condition = evaluatePredicate(expression.condition, atoms, values);
            return condition === undefined
              ? undefined
              : evaluatePredicate(condition ? expression.whenTrue : expression.whenFalse, atoms, values);
          }
          const index = atoms.findIndex((atom) => sameRefinementExpression(atom, expression));
          return index < 0 ? undefined : values[index];
        };
        const predicateEntails = (
          assumptions: readonly { expression: TemporalExpression; value: boolean }[],
          goal: TemporalExpression,
          expected: boolean,
        ): boolean => {
          const atoms: TemporalExpression[] = [];
          if (![...assumptions.map(({ expression }) => expression), goal]
            .every((expression) => predicateAtoms(expression, atoms))) return false;
          let sawModel = false;
          for (let bits = 0; bits < 2 ** atoms.length; bits++) {
            const values = atoms.map((_, index) => Boolean(bits & (1 << index)));
            if (!assumptions.every(({ expression, value }) => evaluatePredicate(expression, atoms, values) === value)) continue;
            sawModel = true;
            if (evaluatePredicate(goal, atoms, values) !== expected) return false;
          }
          return sawModel;
        };
        const specializeEntailedConditions = (
          expression: TemporalExpression,
          assumptions: readonly { expression: TemporalExpression; value: boolean }[],
        ): TemporalExpression => {
          if (expression.kind === "unary") return {
            ...expression,
            operand: specializeEntailedConditions(expression.operand, assumptions),
          };
          if (expression.kind === "binary") return {
            ...expression,
            left: specializeEntailedConditions(expression.left, assumptions),
            right: specializeEntailedConditions(expression.right, assumptions),
          };
          if (expression.kind === "conditional") {
            if (predicateEntails(assumptions, expression.condition, true)) {
              return specializeEntailedConditions(expression.whenTrue, [
                ...assumptions, { expression: expression.condition, value: true },
              ]);
            }
            if (predicateEntails(assumptions, expression.condition, false)) {
              return specializeEntailedConditions(expression.whenFalse, [
                ...assumptions, { expression: expression.condition, value: false },
              ]);
            }
            const whenTrue = specializeEntailedConditions(expression.whenTrue, [
              ...assumptions, { expression: expression.condition, value: true },
            ]);
            const whenFalse = specializeEntailedConditions(expression.whenFalse, [
              ...assumptions, { expression: expression.condition, value: false },
            ]);
            return sameRefinementExpression(whenTrue, whenFalse)
              ? whenTrue
              : { ...expression, whenTrue, whenFalse };
          }
          return expression;
        };
        const specializedStateUpdate = (name: string, value: boolean): TemporalExpression => {
          const expression = loopUpdates.get(name) ?? { kind: "name", name } as TemporalExpression;
          if (sameRefinementExpression(expression, { kind: "name", name })) return expression;
          const specializeTrueConjunction = (
            current: TemporalExpression,
            condition: TemporalExpression,
          ): TemporalExpression => {
            let specialized = specializeCondition(current, condition, true);
            if (condition.kind === "binary" && condition.operator === "and") {
              specialized = specializeTrueConjunction(specialized, condition.left);
              specialized = specializeTrueConjunction(specialized, condition.right);
            } else if (condition.kind === "conditional"
              && isBooleanCompletionPredicate(condition.whenTrue, true)
              && specialized.kind === "conditional"
              && sameRefinementExpression(specialized.condition, condition.condition)) {
              const whenFalse = specializeTrueConjunction(specialized.whenFalse, condition.whenFalse);
              specialized = sameRefinementExpression(specialized.whenTrue, whenFalse)
                ? specialized.whenTrue
                : { ...specialized, whenFalse };
            } else if (condition.kind === "conditional"
              && isBooleanCompletionPredicate(condition.whenFalse, true)
              && specialized.kind === "conditional"
              && sameRefinementExpression(specialized.condition, condition.condition)) {
              const whenTrue = specializeTrueConjunction(specialized.whenTrue, condition.whenTrue);
              specialized = sameRefinementExpression(whenTrue, specialized.whenFalse)
                ? specialized.whenFalse
                : { ...specialized, whenTrue };
            }
            return specialized;
          };
          const specializeFalseDisjunction = (
            current: TemporalExpression,
            condition: TemporalExpression,
          ): TemporalExpression => {
            let specialized = specializeCondition(current, condition, false);
            if (condition.kind === "binary" && condition.operator === "or") {
              specialized = specializeFalseDisjunction(specialized, condition.left);
              specialized = specializeFalseDisjunction(specialized, condition.right);
            } else if (condition.kind === "conditional"
              && isBooleanCompletionPredicate(condition.whenTrue, true)) {
              specialized = specializeCondition(specialized, condition.condition, false);
              specialized = specializeFalseDisjunction(specialized, condition.whenFalse);
            } else if (condition.kind === "conditional"
              && isBooleanCompletionPredicate(condition.whenFalse, true)) {
              specialized = specializeCondition(specialized, condition.condition, true);
              specialized = specializeFalseDisjunction(specialized, condition.whenTrue);
            }
            return specialized;
          };
          const structurallySpecialized = value
            ? specializeTrueConjunction(expression, breakWhen)
            : specializeFalseDisjunction(expression, breakWhen);
          return specializeEntailedConditions(structurallySpecialized, [{ expression: breakWhen, value }]);
        };
        const iterationUpdates = hasInvariantEarlyBreak
          ? new Map([...stateNames].map((name) => [name, specializedStateUpdate(name, false)]))
          : loopUpdates;
        const counterForm = decomposeAffineStateExpression(iterationUpdates.get(counterName) ?? { kind: "name", name: counterName });
        const counterDelta = counterForm?.constant;
        if (!counterForm || counterForm.coefficients.size !== 1 || counterForm.coefficients.get(counterName) !== 1) return undefined;
        if (counterDelta === undefined || (descending ? counterDelta >= 0 : counterDelta <= 0)) return undefined;
        const directMutationSpans = new Map<string, { start: number; end: number }[]>();
        if (ts.isBlock(statement.statement)) for (const child of statement.statement.statements) {
          if (!ts.isExpressionStatement(child)) continue;
          const expression = child.expression;
          const target = ts.isPostfixUnaryExpression(expression) || ts.isPrefixUnaryExpression(expression)
            ? expression.operand
            : ts.isBinaryExpression(expression)
              && expression.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
              && expression.operatorToken.kind <= ts.SyntaxKind.LastAssignment
              ? expression.left : undefined;
          if (!target || !ts.isPropertyAccessExpression(target) || !stateNames.has(target.name.text)) continue;
          const spans = directMutationSpans.get(target.name.text) ?? [];
          spans.push({ start: child.getStart(source), end: child.getEnd() });
          directMutationSpans.set(target.name.text, spans);
        }
        const caughtMutationSpans = new Map<string, { start: number; end: number }[]>();
        const collectCaughtMutations = (node: ts.Node, insideCatch = false): void => {
          const caught = insideCatch || ts.isCatchClause(node);
          if (caught && ts.isExpressionStatement(node)) {
            const expression = node.expression;
            const target = ts.isPostfixUnaryExpression(expression) || ts.isPrefixUnaryExpression(expression)
              ? expression.operand
              : ts.isBinaryExpression(expression)
                && expression.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
                && expression.operatorToken.kind <= ts.SyntaxKind.LastAssignment
                ? expression.left : undefined;
            if (target && ts.isPropertyAccessExpression(target) && stateNames.has(target.name.text)) {
              const spans = caughtMutationSpans.get(target.name.text) ?? [];
              spans.push({ start: node.getStart(source), end: node.getEnd() });
              caughtMutationSpans.set(target.name.text, spans);
            }
          }
          ts.forEachChild(node, (child) => collectCaughtMutations(child, caught));
        };
        collectCaughtMutations(statement.statement);
        interface UpperTriangularDependency {
          readonly driver: string;
          readonly dependent: string;
          readonly coefficient: number;
          readonly driverDelta: number;
          readonly read: "entry" | "updated";
          readonly driverSpan: { start: number; end: number };
          readonly dependentSpan: { start: number; end: number };
        }
        const affineForms = new Map([...stateNames].map((name) => [
          name,
          decomposeAffineStateExpression(iterationUpdates.get(name) ?? { kind: "name", name }),
        ]));
        const boundedCounterPrecondition = (): number | undefined => {
          const expression = currentActionPrecondition?.expression;
          if (!expression || expression.kind !== "binary" || expression.operator !== "and") return undefined;
          const lower = expression.left;
          const upper = expression.right;
          if (lower.kind !== "binary" || lower.operator !== "gte"
            || lower.left.kind !== "name" || lower.left.name !== counterName
            || lower.right.kind !== "integer" || lower.right.value !== "0"
            || upper.kind !== "binary" || upper.operator !== "lte"
            || upper.left.kind !== "name" || upper.left.name !== counterName
            || upper.right.kind !== "integer") return undefined;
          const value = Number(upper.right.value);
          return Number.isSafeInteger(value) && value >= 1
            && value <= MAX_BOUNDED_GEOMETRIC_ITERATIONS ? value : undefined;
        };
        const geometricBound = boundedCounterPrecondition();
        interface GeometricCandidate {
          readonly name: string;
          readonly multiplier: number;
          readonly span: { start: number; end: number };
          readonly activation?: {
            readonly selector: string;
            readonly when: boolean;
            readonly predecessor: "catch";
          };
        }
        const geometricCandidates: GeometricCandidate[] = geometricBound === undefined ? [] : [...affineForms].flatMap<GeometricCandidate>(([name, form]) => {
          if (!form || name === counterName || form.constant !== 0 || form.coefficients.size !== 1) return [];
          const multiplier = form.coefficients.get(name);
          const spans = directMutationSpans.get(name);
          if (multiplier === undefined || !Number.isSafeInteger(multiplier) || multiplier <= 1
            || spans?.length !== 1 || !Number.isSafeInteger(multiplier ** geometricBound)) return [];
          return [{ name, multiplier, span: spans[0]! }];
        });
        const guardedGeometricCandidates: GeometricCandidate[] = geometricBound === undefined ? [] : [...stateNames].flatMap<GeometricCandidate>((name) => {
          if (name === counterName) return [];
          const expression = iterationUpdates.get(name);
          const spans = caughtMutationSpans.get(name);
          if (!expression || expression.kind !== "conditional"
            || expression.condition.kind !== "name"
            || stateTypes.get(expression.condition.name) !== "bool"
            || spans?.length !== 1) return [];
          const selector = expression.condition.name;
          const selectorUpdate = iterationUpdates.get(selector) ?? { kind: "name", name: selector } as TemporalExpression;
          if (!sameRefinementExpression(selectorUpdate, { kind: "name", name: selector })) return [];
          const multiplierFor = (branch: TemporalExpression): number | undefined => {
            const form = decomposeAffineStateExpression(branch);
            if (!form || form.constant !== 0 || form.coefficients.size !== 1) return undefined;
            const multiplier = form.coefficients.get(name);
            return multiplier !== undefined && Number.isSafeInteger(multiplier) && multiplier > 1
              && Number.isSafeInteger(multiplier ** geometricBound) ? multiplier : undefined;
          };
          const identity = (branch: TemporalExpression): boolean => sameRefinementExpression(
            branch, { kind: "name", name },
          );
          const trueMultiplier = multiplierFor(expression.whenTrue);
          const falseMultiplier = multiplierFor(expression.whenFalse);
          if (trueMultiplier !== undefined && identity(expression.whenFalse)) return [{
            name, multiplier: trueMultiplier, span: spans[0]!,
            activation: { selector, when: true as const, predecessor: "catch" as const },
          }];
          if (falseMultiplier !== undefined && identity(expression.whenTrue)) return [{
            name, multiplier: falseMultiplier, span: spans[0]!,
            activation: { selector, when: false as const, predecessor: "catch" as const },
          }];
          return [];
        });
        const allGeometricCandidates = [...geometricCandidates, ...guardedGeometricCandidates];
        const geometric = allGeometricCandidates.length === 1 && currentActionPrecondition
          ? allGeometricCandidates[0] : undefined;
        const dependencyCandidates = [...affineForms].flatMap(([dependent, form]) => {
          if (!form || dependent === counterName || form.coefficients.get(dependent) !== 1) return [];
          const foreign = [...form.coefficients].filter(([symbol, coefficient]) =>
            coefficient !== 0 && symbol !== dependent && symbol !== counterName);
          if (foreign.length !== 1) return [];
          const [driver, coefficient] = foreign[0]!;
          const driverForm = affineForms.get(driver);
          if (!driverForm || driver === counterName || driverForm.coefficients.size !== 1
            || driverForm.coefficients.get(driver) !== 1 || driverForm.constant === 0
            || !Number.isSafeInteger(coefficient) || !Number.isSafeInteger(driverForm.constant)) return [];
          const driverSpans = directMutationSpans.get(driver);
          const dependentSpans = directMutationSpans.get(dependent);
          if (driverSpans?.length !== 1 || dependentSpans?.length !== 1) return [];
          const driverSpan = driverSpans[0]!;
          const dependentSpan = dependentSpans[0]!;
          return [{
            driver, dependent, coefficient, driverDelta: driverForm.constant,
            read: driverSpan.start < dependentSpan.start ? "updated" as const : "entry" as const,
            driverSpan,
            dependentSpan,
          }];
        });
        const upperTriangular = dependencyCandidates.length === 1
          ? dependencyCandidates[0] : undefined;
        const affineDelta = (name: string, expression: TemporalExpression): AffineLoopDelta | undefined => {
          const form = decomposeAffineStateExpression(expression);
          if (!form || form.coefficients.get(name) !== 1) return undefined;
          const foreign = [...form.coefficients].filter(([symbol, coefficient]) =>
            coefficient !== 0 && symbol !== name && symbol !== counterName);
          if (foreign.length === 0) return {
            constant: form.constant,
            counterCoefficient: form.coefficients.get(counterName) ?? 0,
          };
          if (!upperTriangular || name !== upperTriangular.dependent || foreign.length !== 1
            || foreign[0]![0] !== upperTriangular.driver
            || foreign[0]![1] !== upperTriangular.coefficient) return undefined;
          return {
            constant: form.constant,
            counterCoefficient: form.coefficients.get(counterName) ?? 0,
            driver: upperTriangular.driver,
            driverCoefficient: upperTriangular.coefficient,
            driverDelta: upperTriangular.driverDelta,
          };
        };
        const scalarNames = (expression: TemporalExpression): ReadonlySet<string> | undefined => {
          if (expression.kind === "integer" || expression.kind === "boolean" || expression.kind === "string") return new Set();
          if (expression.kind === "name") return new Set([expression.name]);
          if (expression.kind === "unary") return scalarNames(expression.operand);
          if (expression.kind === "binary") {
            const left = scalarNames(expression.left);
            const right = scalarNames(expression.right);
            return left && right ? new Set([...left, ...right]) : undefined;
          }
          if (expression.kind === "conditional") {
            const condition = scalarNames(expression.condition);
            const whenTrue = scalarNames(expression.whenTrue);
            const whenFalse = scalarNames(expression.whenFalse);
            return condition && whenTrue && whenFalse
              ? new Set([...condition, ...whenTrue, ...whenFalse])
              : undefined;
          }
          return undefined;
        };
        const atLoopEntry = (expression: TemporalExpression): TemporalExpression | undefined => {
          if (expression.kind === "integer" || expression.kind === "boolean" || expression.kind === "string") return expression;
          if (expression.kind === "name") return entryValues.get(expression.name) ?? expression;
          if (expression.kind === "unary") {
            const operand = atLoopEntry(expression.operand);
            return operand ? { ...expression, operand } : undefined;
          }
          if (expression.kind === "binary") {
            const left = atLoopEntry(expression.left);
            const right = atLoopEntry(expression.right);
            return left && right ? { ...expression, left, right } : undefined;
          }
          if (expression.kind === "conditional") {
            const condition = atLoopEntry(expression.condition);
            const whenTrue = atLoopEntry(expression.whenTrue);
            const whenFalse = atLoopEntry(expression.whenFalse);
            return condition && whenTrue && whenFalse
              ? { ...expression, condition, whenTrue, whenFalse }
              : undefined;
          }
          return undefined;
        };
        const piecewiseDelta = (
          name: string,
          expression: TemporalExpression,
        ): { value: PiecewiseAffineLoopDelta; leaves: number } | undefined => {
          const direct = affineDelta(name, expression);
          if (direct) return { value: { kind: "affine", value: direct }, leaves: 1 };
          const liftConditional = (current: TemporalExpression): TemporalExpression | undefined => {
            if (current.kind === "unary" && current.operand.kind === "conditional") return {
              kind: "conditional",
              condition: current.operand.condition,
              whenTrue: { ...current, operand: current.operand.whenTrue },
              whenFalse: { ...current, operand: current.operand.whenFalse },
            };
            if (current.kind !== "binary") return undefined;
            if (current.left.kind === "conditional") return {
              kind: "conditional",
              condition: current.left.condition,
              whenTrue: { ...current, left: current.left.whenTrue },
              whenFalse: { ...current, left: current.left.whenFalse },
            };
            if (current.right.kind === "conditional") return {
              kind: "conditional",
              condition: current.right.condition,
              whenTrue: { ...current, right: current.right.whenTrue },
              whenFalse: { ...current, right: current.right.whenFalse },
            };
            return undefined;
          };
          if (expression.kind !== "conditional") {
            const lifted = liftConditional(expression);
            return lifted ? piecewiseDelta(name, lifted) : undefined;
          }
          const conditionNames = scalarNames(expression.condition);
          if (!conditionNames || [...conditionNames].some((conditionName) => stateNames.has(conditionName)
            && !sameRefinementExpression(
              loopUpdates.get(conditionName) ?? { kind: "name", name: conditionName },
              { kind: "name", name: conditionName },
            ))) return undefined;
          const whenTrue = piecewiseDelta(name, expression.whenTrue);
          const whenFalse = piecewiseDelta(name, expression.whenFalse);
          const condition = atLoopEntry(expression.condition);
          if (!whenTrue || !whenFalse || !condition
            || whenTrue.leaves + whenFalse.leaves > MAX_AFFINE_LOOP_BRANCH_LEAVES) return undefined;
          return {
            value: {
              kind: "conditional", condition,
              whenTrue: whenTrue.value, whenFalse: whenFalse.value,
            },
            leaves: whenTrue.leaves + whenFalse.leaves,
          };
        };
        const deltas = new Map<string, PiecewiseAffineLoopDelta>();
        const booleanInvolutionNames = [...stateNames].filter((name) => {
          if (stateTypes.get(name) !== "bool") return false;
          const expression = iterationUpdates.get(name) ?? { kind: "name", name } as TemporalExpression;
          return expression.kind === "unary" && expression.operator === "not"
            && expression.operand.kind === "name" && expression.operand.name === name;
        });
        if ([...stateNames].some((name) => stateTypes.get(name) === "bool"
          && (directMutationSpans.get(name)?.length ?? 0) > 1)) return undefined;
        if (booleanInvolutionNames.length > 1) return undefined;
        const booleanInvolutionName = booleanInvolutionNames[0];
        const booleanInvolutionSpans = booleanInvolutionName
          ? directMutationSpans.get(booleanInvolutionName) : undefined;
        if (booleanInvolutionName && booleanInvolutionSpans?.length !== 1) return undefined;
        const breakUpdates = new Map<string, TemporalExpression>();
        let stateChangingBreakUpdates = 0;
        let stateChangingBreakLeaves = 0;
        const breakConditionNames = hasInvariantEarlyBreak ? scalarNames(breakWhen) : new Set<string>();
        const breakCondition = hasInvariantEarlyBreak ? atLoopEntry(breakWhen) : undefined;
        if (!breakConditionNames || (hasInvariantEarlyBreak && !breakCondition)
          || [...breakConditionNames].some((name) => stateNames.has(name)
            && !sameRefinementExpression(
              loopUpdates.get(name) ?? { kind: "name", name },
              { kind: "name", name },
            ))) return undefined;
        for (const name of stateNames) {
          const breakUpdateExpression: TemporalExpression = hasInvariantEarlyBreak
            ? specializedStateUpdate(name, true)
            : { kind: "name", name };
          if (hasInvariantEarlyBreak && !sameRefinementExpression(
            breakUpdateExpression,
            { kind: "name", name },
          )) {
            // Break-side updates are evaluated from the loop-entry snapshot:
            // the invariant condition makes this path execute at most once, so
            // they are not part of the recurrence. The ranking counter may
            // change only by the exact ordinary iteration delta, as happens
            // when a mandatory finally block advances it before consuming the
            // break. Other state fields share the explicit update budget.
            if (name === counterName) {
              const breakCounterForm = decomposeAffineStateExpression(breakUpdateExpression);
              if (!breakCounterForm || breakCounterForm.constant !== counterDelta
                || breakCounterForm.coefficients.size !== 1
                || breakCounterForm.coefficients.get(counterName) !== 1) return undefined;
            } else {
              const breakPiecewise = piecewiseDelta(name, breakUpdateExpression);
              if (!breakPiecewise
                || ++stateChangingBreakUpdates > MAX_AFFINE_LOOP_BREAK_UPDATES
                || (stateChangingBreakLeaves += breakPiecewise.leaves) > MAX_AFFINE_LOOP_BREAK_LEAVES) return undefined;
            }
            const breakUpdate = atLoopEntry(breakUpdateExpression);
            if (!breakUpdate) return undefined;
            breakUpdates.set(name, breakUpdate);
          }
          if (name === counterName) {
            deltas.set(name, { kind: "affine", value: { constant: counterDelta, counterCoefficient: 0 } });
            continue;
          }
          if (geometric && name === geometric.name) continue;
          if (name === booleanInvolutionName) continue;
          const delta = piecewiseDelta(name, iterationUpdates.get(name) ?? { kind: "name", name });
          if (!delta) return undefined;
          deltas.set(name, delta.value);
        }
        const stepValue = Math.abs(counterDelta);
        if (!Number.isSafeInteger(stepValue) || stepValue <= 0) return undefined;
        const zero: TemporalExpression = { kind: "integer", value: "0" };
        const one: TemporalExpression = { kind: "integer", value: "1" };
        const stop = integerExpression(stopValue);
        const entryCounter = entryValues.get(counterName)!;
        const distance: TemporalExpression = descending
          ? stopValue === 0 ? entryCounter : { kind: "binary", operator: "subtract", left: entryCounter, right: stop }
          : { kind: "binary", operator: "subtract", left: stop, right: entryCounter };
        const step = integerExpression(stepValue);
        const loopIterations: TemporalExpression = stepValue === 1 ? distance : (() => {
          const remainder: TemporalExpression = {
            kind: "binary", operator: "modulo", left: distance, right: step,
          };
          const divisible: TemporalExpression = {
            kind: "binary", operator: "subtract", left: distance, right: remainder,
          };
          const quotient: TemporalExpression = {
            kind: "binary", operator: "divide", left: divisible, right: step,
          };
          const roundUp: TemporalExpression = {
            kind: "conditional",
            condition: { kind: "binary", operator: "gt", left: remainder, right: zero },
            whenTrue: one, whenFalse: zero,
          };
          return { kind: "binary", operator: "add", left: quotient, right: roundUp };
        })();
        const iterations: TemporalExpression = {
          kind: "conditional", condition: entryGuard,
          whenTrue: loopIterations, whenFalse: zero,
        };
        const multiplyByInteger = (expression: TemporalExpression, coefficient: number): TemporalExpression => {
          if (coefficient === 0) return zero;
          if (coefficient === 1) return expression;
          if (coefficient === -1) return { kind: "unary", operator: "negate", operand: expression };
          return { kind: "binary", operator: "multiply", left: integerExpression(coefficient), right: expression };
        };
        const addInteger = (expression: TemporalExpression, value: number): TemporalExpression => value === 0 ? expression : {
          kind: "binary", operator: value > 0 ? "add" : "subtract",
          left: expression, right: integerExpression(Math.abs(value)),
        };
        const triangularLoopIterations: TemporalExpression = {
          kind: "binary", operator: "divide",
          left: {
            kind: "binary", operator: "multiply", left: loopIterations,
            right: { kind: "binary", operator: "subtract", left: loopIterations, right: one },
          },
          right: integerExpression(2),
        };
        const loopCounterSeries: TemporalExpression = {
          kind: "binary", operator: "add",
          left: { kind: "binary", operator: "multiply", left: loopIterations, right: entryCounter },
          right: multiplyByInteger(triangularLoopIterations, counterDelta),
        };
        const totalFor = (delta: AffineLoopDelta): TemporalExpression => {
          if (delta.driver && delta.driverCoefficient !== undefined && delta.driverDelta !== undefined) {
            const entryDriver = entryValues.get(delta.driver);
            if (!entryDriver) return zero;
            const canonicalUnitCountdown = counterDelta === -1
              && sameRefinementExpression(loopIterations, entryCounter);
            if (canonicalUnitCountdown) {
              const driverEntryTotal = multiplyByInteger({
                kind: "binary", operator: "multiply", left: loopIterations, right: entryDriver,
              }, delta.driverCoefficient);
              const quadraticCoefficient = delta.driverCoefficient * delta.driverDelta;
              const linearCoefficient = 2 * delta.constant - quadraticCoefficient;
              const reducibleByTwo = quadraticCoefficient % 2 === 0 && linearCoefficient % 2 === 0;
              const polynomialNumerator: TemporalExpression = {
                kind: "binary", operator: "multiply", left: loopIterations,
                right: addInteger(
                  multiplyByInteger(loopIterations, reducibleByTwo
                    ? quadraticCoefficient / 2 : quadraticCoefficient),
                  reducibleByTwo ? linearCoefficient / 2 : linearCoefficient,
                ),
              };
              const polynomial = reducibleByTwo ? polynomialNumerator : {
                kind: "binary", operator: "divide",
                left: polynomialNumerator, right: integerExpression(2),
              } as TemporalExpression;
              const counterTotal = multiplyByInteger(loopCounterSeries, delta.counterCoefficient);
              return delta.counterCoefficient === 0
                ? { kind: "binary", operator: "add", left: driverEntryTotal, right: polynomial }
                : {
                  kind: "binary", operator: "add",
                  left: { kind: "binary", operator: "add", left: driverEntryTotal, right: polynomial },
                  right: counterTotal,
                };
            }
            const driverSeries: TemporalExpression = {
              kind: "binary", operator: "add",
              left: { kind: "binary", operator: "multiply", left: loopIterations, right: entryDriver },
              right: multiplyByInteger(triangularLoopIterations, delta.driverDelta),
            };
            const terms: TemporalExpression[] = [];
            if (delta.constant !== 0) terms.push(multiplyByInteger(loopIterations, delta.constant));
            if (delta.counterCoefficient !== 0) terms.push(multiplyByInteger(loopCounterSeries, delta.counterCoefficient));
            if (delta.driverCoefficient !== 0) terms.push(multiplyByInteger(driverSeries, delta.driverCoefficient));
            return terms.length === 0 ? zero : terms.slice(1).reduce<TemporalExpression>((left, right) => ({
              kind: "binary", operator: "add", left, right,
            }), terms[0]!);
          }
          const canonicalUnitCountdown = counterDelta === -1
            && sameRefinementExpression(loopIterations, entryCounter)
            && delta.counterCoefficient !== 0;
          return canonicalUnitCountdown ? (() => {
            const reducibleByTwo = delta.counterCoefficient % 2 === 0
              && (delta.counterCoefficient + 2 * delta.constant) % 2 === 0;
            const linearCoefficient = reducibleByTwo ? delta.counterCoefficient / 2 : delta.counterCoefficient;
            const linearConstant = reducibleByTwo
              ? (delta.counterCoefficient + 2 * delta.constant) / 2
              : delta.counterCoefficient + 2 * delta.constant;
            const numerator: TemporalExpression = {
              kind: "binary", operator: "multiply", left: entryCounter,
              right: addInteger(
                multiplyByInteger(entryCounter, linearCoefficient),
                linearConstant,
              ),
            };
            return reducibleByTwo ? numerator : {
              kind: "binary", operator: "divide", left: numerator, right: integerExpression(2),
            };
          })() : (() => {
            const constantTotal = multiplyByInteger(loopIterations, delta.constant);
            const counterTotal = multiplyByInteger(loopCounterSeries, delta.counterCoefficient);
            return delta.constant === 0 ? counterTotal
              : delta.counterCoefficient === 0 ? constantTotal
              : { kind: "binary", operator: "add", left: constantTotal, right: counterTotal };
          })();
        };
        const totalForPiecewise = (piecewise: PiecewiseAffineLoopDelta): TemporalExpression => piecewise.kind === "affine"
          ? totalFor(piecewise.value)
          : {
            kind: "conditional", condition: piecewise.condition,
            whenTrue: totalForPiecewise(piecewise.whenTrue),
            whenFalse: totalForPiecewise(piecewise.whenFalse),
          };
        const piecewiseStutters = (piecewise: PiecewiseAffineLoopDelta): boolean => piecewise.kind === "affine"
          ? piecewise.value.constant === 0
            && piecewise.value.counterCoefficient === 0
            && (piecewise.value.driverCoefficient ?? 0) === 0
          : piecewiseStutters(piecewise.whenTrue) && piecewiseStutters(piecewise.whenFalse);
        for (const [name, piecewise] of deltas) {
          const entryValue = entryValues.get(name)!;
          if (name === counterName) {
            const breakCounter = breakUpdates.get(name) ?? entryCounter;
            const totalDecrease: TemporalExpression = stepValue === 1 ? loopIterations : {
              kind: "binary", operator: "multiply", left: step, right: loopIterations,
            };
            updates.set(name, {
              kind: "conditional", condition: entryGuard,
              whenTrue: hasInvariantEarlyBreak ? {
                kind: "conditional", condition: breakCondition!,
                whenTrue: breakCounter,
                whenFalse: stepValue === 1 ? stop : {
                  kind: "binary", operator: descending ? "subtract" : "add", left: entryCounter, right: totalDecrease,
                },
              } : stepValue === 1 ? stop : {
                kind: "binary", operator: descending ? "subtract" : "add", left: entryCounter, right: totalDecrease,
              },
              whenFalse: entryValue,
            });
            continue;
          }
          const unguardedTotal = totalForPiecewise(piecewise);
          if (!hasInvariantEarlyBreak) {
            if (piecewiseStutters(piecewise)) continue;
            updates.set(name, {
              kind: "binary", operator: "add", left: entryValue,
              right: {
                kind: "conditional", condition: entryGuard,
                whenTrue: unguardedTotal, whenFalse: zero,
              },
            });
            continue;
          }
          const breakUpdate = breakUpdates.get(name) ?? entryValue;
          if (piecewiseStutters(piecewise) && sameRefinementExpression(breakUpdate, entryValue)) continue;
          const repeatedValue: TemporalExpression = piecewiseStutters(piecewise) ? entryValue : {
            kind: "binary", operator: "add", left: entryValue, right: unguardedTotal,
          };
          updates.set(name, {
            kind: "conditional", condition: entryGuard,
            whenTrue: {
              kind: "conditional", condition: breakCondition!, whenTrue: breakUpdate, whenFalse: repeatedValue,
            },
            whenFalse: entryValue,
          });
        }
        if (geometric) {
          if (hasInvariantEarlyBreak || stepValue !== 1 || counterDelta !== -1
            || !sameRefinementExpression(loopIterations, entryCounter)) return undefined;
          const entryValue = entryValues.get(geometric.name)!;
          let factor: TemporalExpression = one;
          for (let iteration = geometricBound!; iteration >= 1; iteration--) {
            factor = {
              kind: "conditional",
              condition: {
                kind: "binary", operator: "eq", left: entryCounter, right: integerExpression(iteration),
              },
              whenTrue: integerExpression(geometric.multiplier ** iteration),
              whenFalse: factor,
            };
          }
          const activatedFactor: TemporalExpression = geometric.activation ? {
            kind: "conditional",
            condition: geometric.activation.when
              ? { kind: "name", name: geometric.activation.selector }
              : { kind: "unary", operator: "not", operand: { kind: "name", name: geometric.activation.selector } },
            whenTrue: factor,
            whenFalse: one,
          } : factor;
          updates.set(geometric.name, {
            kind: "conditional", condition: entryGuard,
            whenTrue: { kind: "binary", operator: "multiply", left: entryValue, right: activatedFactor },
            whenFalse: entryValue,
          });
        }
        if (booleanInvolutionName) {
          if (hasInvariantEarlyBreak || stepValue !== 1) return undefined;
          const entryValue = entryValues.get(booleanInvolutionName)!;
          const evenIterations: TemporalExpression = {
            kind: "binary", operator: "eq",
            left: { kind: "binary", operator: "modulo", left: loopIterations, right: integerExpression(2) },
            right: zero,
          };
          updates.set(booleanInvolutionName, {
            kind: "conditional", condition: entryGuard,
            whenTrue: {
              kind: "conditional", condition: evenIterations,
              whenTrue: entryValue,
              whenFalse: { kind: "unary", operator: "not", operand: entryValue },
            },
            whenFalse: entryValue,
          });
        }
        const sourceOrderedAffineUpdates = upperTriangular
          ? upperTriangular.driverSpan.start < upperTriangular.dependentSpan.start
            ? [
              { state: upperTriangular.driver, span: upperTriangular.driverSpan },
              { state: upperTriangular.dependent, span: upperTriangular.dependentSpan },
            ] as const
            : [
              { state: upperTriangular.dependent, span: upperTriangular.dependentSpan },
              { state: upperTriangular.driver, span: upperTriangular.driverSpan },
            ] as const
          : undefined;
        if (traceSink && currentModelName) traceSink.rankingRecurrences.push({
          modelName: currentModelName,
          loopStart: statement.getStart(source),
          counterName,
          counterDelta,
          direction: descending ? "decrease" : "increase",
          bound,
          stop: stopValue,
          guard: entryGuard,
          iterationUpdates: new Map([...stateNames].map((name) => [
            name,
            iterationUpdates.get(name) ?? { kind: "name", name },
          ])),
          summaryUpdates: new Map([...stateNames].map((name) => [
            name,
            updates.get(name) ?? entryValues.get(name) ?? { kind: "name", name },
          ])),
          ...(geometric && currentActionPrecondition ? {
            boundedSelfAffine: {
              rule: geometric.activation
                ? "precondition-bounded-guarded-self-affine" as const
                : "precondition-bounded-self-affine" as const,
              state: geometric.name,
              counter: counterName,
              multiplier: geometric.multiplier,
              precondition: currentActionPrecondition,
              budget: {
                name: "cfg-recurrence-geometric-iterations" as const,
                limit: MAX_BOUNDED_GEOMETRIC_ITERATIONS as 8,
                observed: geometricBound!,
              },
              update: { state: geometric.name, span: geometric.span },
              ...(geometric.activation ? { activation: geometric.activation } : {}),
            },
          } : {}),
          ...(upperTriangular && sourceOrderedAffineUpdates ? {
            affineDependencies: {
              rule: "source-ordered-upper-triangular-affine" as const,
              order: [sourceOrderedAffineUpdates[0].state, sourceOrderedAffineUpdates[1].state] as const,
              updates: sourceOrderedAffineUpdates,
              edges: [{
                from: upperTriangular.driver,
                to: upperTriangular.dependent,
                read: upperTriangular.read,
              }] as const,
            },
          } : {}),
          ...(booleanInvolutionName ? {
            booleanInvolutions: {
              rule: "source-bound-boolean-involution" as const,
              budget: {
                name: "cfg-recurrence-boolean-involutions" as const,
                limit: 1 as const,
                observed: 1 as const,
              },
              updates: [{
                state: booleanInvolutionName,
                span: booleanInvolutionSpans![0]!,
              }] as const,
            },
          } : {}),
        });
        continue;
      }
      if (ts.isDoStatement(statement)) {
        // `do S while (false)` executes S exactly once. Keep the loop body in
        // its own lexical environment and compose abrupt completion with the
        // outer continuation just like a bare block.
        if (statement.expression.kind !== ts.SyntaxKind.FalseKeyword) return undefined;
        const completion = collect(
          asBlock(statement.statement), receiver, runtimeClass, substitutions,
          updates, new Map(localValues), activeCalls, allowTerminalReturn, allowTerminalThrow, true,
          true,
        );
        if (!completion) return undefined;
        return consumeLoopTransfers(
          completion, updates, ts.factory.createBlock(body.statements.slice(statementIndex + 1), true),
        );
      }
      if (ts.isForStatement(statement)) {
        const iterations = boundedForIterations(statement);
        if (!iterations) return undefined;
        const completion = collectFiniteLoopIterations(iterations, 0, updates, localValues);
        return completion ? consumeLoopTransfers(
          completion, updates, ts.factory.createBlock(body.statements.slice(statementIndex + 1), true),
        ) : undefined;
      }
      if (ts.isForOfStatement(statement)) {
        const iterations = boundedForOfIterations(statement);
        if (!iterations) return undefined;
        const completion = collectFiniteLoopIterations(iterations, 0, updates, localValues);
        return completion ? consumeLoopTransfers(
          completion, updates, ts.factory.createBlock(body.statements.slice(statementIndex + 1), true),
        ) : undefined;
      }
      if (ts.isTryStatement(statement)) {
        const handlerRegionEntry = new Map(updates);
        let residualCompletion: ActionCompletion = "normal";
        let postCatchLocals: ReadonlyMap<string, TemporalExpression> | undefined;
        if (statement.catchClause) {
          const catchVisibleNames = [...localValues.keys()];
          const tryLocals = new Map(localValues);
          const tryCompletion = collect(
            statement.tryBlock, receiver, runtimeClass, substitutions,
            updates, tryLocals, activeCalls, true, true,
            allowBreak, allowContinue, ownedBreakLabel, ownedContinueLabel,
            activeBreakLabels, activeContinueLabels,
            allowMutableLoopWrites,
          );
          if (!tryCompletion) return undefined;
          const throwWhen = completionPredicate(tryCompletion, "throw");
          if (isBooleanCompletionPredicate(throwWhen, false)) {
            // Within the supported refinement fragment every abrupt edge is
            // explicit in ActionCompletion. A catch clause with no incoming
            // throw edge is unreachable and must not make an otherwise exact
            // transition unknown merely because its body is unmodeled.
            residualCompletion = tryCompletion;
          } else {
            const beforeCatch = new Map(updates);
            const caughtUpdates = new Map(updates);
            const throwLocals = completionThrowLocals(tryCompletion);
            if (!throwLocals && [...localValues.keys()].some((name) => name.startsWith("\u0000mutable:"))) return undefined;
            const catchLocals = new Map(throwLocals ?? localValues);
            const catchVariable = statement.catchClause.variableDeclaration?.name;
            const throwValue = completionThrowValue(tryCompletion);
            if (catchVariable && ts.isIdentifier(catchVariable) && throwValue) {
              catchLocals.set(catchVariable.text, throwValue);
            }
            const catchCompletion = collect(
              statement.catchClause.block, receiver, runtimeClass, substitutions,
              caughtUpdates, catchLocals, activeCalls, true, true,
              allowBreak, allowContinue, ownedBreakLabel, ownedContinueLabel,
              activeBreakLabels, activeContinueLabels,
              allowMutableLoopWrites,
            );
            if (!catchCompletion) return undefined;
            if (traceSink && currentModelName && throwValue) traceSink.tryCatchJoins.push({
              modelName: currentModelName,
              tryStart: statement.getStart(source),
              throwValue,
              throwWhen,
              tryUpdates: new Map(beforeCatch),
              catchUpdates: new Map(caughtUpdates),
            });
            const hasMutableCatchLocals = catchVisibleNames.some((name) => name.startsWith("\u0000mutable:"));
            const projectedCatchLocals = hasMutableCatchLocals
              ? projectLocalSnapshot(catchLocals, catchVisibleNames)
              : undefined;
            const projectedThrowLocals = hasMutableCatchLocals && throwLocals
              ? projectLocalSnapshot(throwLocals, catchVisibleNames)
              : undefined;
            if (hasMutableCatchLocals && (!projectedCatchLocals || !projectedThrowLocals)) return undefined;
            const catchMutatesVisibleLocal = hasMutableCatchLocals && catchVisibleNames.some((name) =>
              !name.startsWith("\u0000mutable:")
              && !sameRefinementExpression(projectedCatchLocals!.get(name)!, projectedThrowLocals!.get(name)!));
            const catchThrowWhen = completionPredicate(catchCompletion, "throw");
            const catchHasUnsupportedMutableAbrupt = !isBooleanCompletionPredicate(
              labeledCompletionPredicate(catchCompletion), false,
            );
            if (catchMutatesVisibleLocal && catchHasUnsupportedMutableAbrupt) return undefined;
            const rawCatchThrowLocals = completionThrowLocals(catchCompletion);
            const catchThrowLocals = hasMutableCatchLocals && rawCatchThrowLocals
              ? projectLocalSnapshot(rawCatchThrowLocals, catchVisibleNames)
              : rawCatchThrowLocals;
            if (hasMutableCatchLocals
              && !isBooleanCompletionPredicate(catchThrowWhen, false)
              && !catchThrowLocals) return undefined;
            const catchAbruptWhen = orCompletionPredicates(
              orCompletionPredicates(
                orCompletionPredicates(
                  completionPredicate(catchCompletion, "return"), catchThrowWhen,
                ),
                completionPredicate(catchCompletion, "break"),
              ),
              orCompletionPredicates(
                completionPredicate(catchCompletion, "continue"),
                labeledCompletionPredicate(catchCompletion),
              ),
            );
            const catchNormalWhen = notCompletionPredicate(catchAbruptWhen);
            if (!isBooleanCompletionPredicate(catchNormalWhen, false) && projectedCatchLocals) {
              postCatchLocals = isBooleanCompletionPredicate(throwWhen, true)
                ? projectedCatchLocals
                : joinVisibleLocalSnapshots(throwWhen, projectedCatchLocals, tryLocals, catchVisibleNames);
              if (!postCatchLocals) return undefined;
            }
            if (isBooleanCompletionPredicate(throwWhen, true)) {
              updates.clear();
              for (const [name, value] of caughtUpdates) updates.set(name, value);
            } else mergeConditionalUpdates(throwWhen, caughtUpdates, beforeCatch, beforeCatch, updates, true);
            const tryReturnWhen = completionPredicate(tryCompletion, "return");
            const catchReturnWhen = completionPredicate(catchCompletion, "return");
            const tryReturnLocals = completionReturnLocals(tryCompletion);
            const rawCatchReturnLocals = completionReturnLocals(catchCompletion);
            const catchReturnLocals = hasMutableCatchLocals && rawCatchReturnLocals
              ? projectLocalSnapshot(rawCatchReturnLocals, catchVisibleNames)
              : rawCatchReturnLocals;
            if (hasMutableCatchLocals
              && !isBooleanCompletionPredicate(catchReturnWhen, false)
              && !catchReturnLocals) return undefined;
            const tryBreakWhen = completionPredicate(tryCompletion, "break");
            const catchBreakWhen = completionPredicate(catchCompletion, "break");
            const tryBreakLocals = completionBreakLocals(tryCompletion);
            const rawCatchBreakLocals = completionBreakLocals(catchCompletion);
            const catchBreakLocals = hasMutableCatchLocals && rawCatchBreakLocals
              ? projectLocalSnapshot(rawCatchBreakLocals, catchVisibleNames)
              : rawCatchBreakLocals;
            if (hasMutableCatchLocals
              && !isBooleanCompletionPredicate(catchBreakWhen, false)
              && !catchBreakLocals) return undefined;
            const tryContinueWhen = completionPredicate(tryCompletion, "continue");
            const catchContinueWhen = completionPredicate(catchCompletion, "continue");
            const tryContinueLocals = completionContinueLocals(tryCompletion);
            const rawCatchContinueLocals = completionContinueLocals(catchCompletion);
            const catchContinueLocals = hasMutableCatchLocals && rawCatchContinueLocals
              ? projectLocalSnapshot(rawCatchContinueLocals, catchVisibleNames)
              : rawCatchContinueLocals;
            if (hasMutableCatchLocals
              && !isBooleanCompletionPredicate(catchContinueWhen, false)
              && !catchContinueLocals) return undefined;
            const residualReturnLocals = isBooleanCompletionPredicate(tryReturnWhen, false)
              ? catchReturnLocals
              : isBooleanCompletionPredicate(catchReturnWhen, false)
                ? tryReturnLocals
                : tryReturnLocals && catchReturnLocals
                  ? joinVisibleLocalSnapshots(tryReturnWhen, tryReturnLocals, catchReturnLocals, localValues.keys())
                  : undefined;
            const residualBreakLocals = isBooleanCompletionPredicate(tryBreakWhen, false)
              ? catchBreakLocals
              : isBooleanCompletionPredicate(catchBreakWhen, false)
                ? tryBreakLocals
                : tryBreakLocals && catchBreakLocals
                  ? joinVisibleLocalSnapshots(tryBreakWhen, tryBreakLocals, catchBreakLocals, localValues.keys())
                  : undefined;
            const residualContinueLocals = isBooleanCompletionPredicate(tryContinueWhen, false)
              ? catchContinueLocals
              : isBooleanCompletionPredicate(catchContinueWhen, false)
                ? tryContinueLocals
                : tryContinueLocals && catchContinueLocals
                  ? joinVisibleLocalSnapshots(
                    tryContinueWhen, tryContinueLocals, catchContinueLocals, localValues.keys(),
                  )
                  : undefined;
            residualCompletion = makeCompletion(
              orCompletionPredicates(
                completionPredicate(tryCompletion, "return"),
                andCompletionPredicates(throwWhen, completionPredicate(catchCompletion, "return")),
              ),
              andCompletionPredicates(throwWhen, completionPredicate(catchCompletion, "throw")),
              completionThrowValue(catchCompletion),
              orCompletionPredicates(
                completionPredicate(tryCompletion, "break"),
                andCompletionPredicates(throwWhen, completionPredicate(catchCompletion, "break")),
              ),
              orCompletionPredicates(
                completionPredicate(tryCompletion, "continue"),
                andCompletionPredicates(throwWhen, completionPredicate(catchCompletion, "continue")),
              ),
              mergeCompletionLabels(
                completionLabels(tryCompletion, "break"),
                completionLabels(catchCompletion, "break"),
                throwWhen,
              ),
              mergeCompletionLabels(
                completionLabels(tryCompletion, "continue"),
                completionLabels(catchCompletion, "continue"),
                throwWhen,
              ),
              catchThrowLocals,
              residualReturnLocals,
              residualBreakLocals,
              residualContinueLocals,
            );
          }
          localValues.clear();
          for (const [name, value] of postCatchLocals ?? tryLocals) localValues.set(name, value);
        } else {
          const tryLocals = new Map(localValues);
          const tryCompletion = collect(
            statement.tryBlock, receiver, runtimeClass, substitutions,
            updates, tryLocals, activeCalls, true, true,
            allowBreak, allowContinue, ownedBreakLabel, ownedContinueLabel,
            activeBreakLabels, activeContinueLabels,
            allowMutableLoopWrites,
          );
          if (!tryCompletion) return undefined;
          residualCompletion = tryCompletion;
          localValues.clear();
          for (const [name, value] of tryLocals) localValues.set(name, value);
        }
        if (traceSink && currentModelName && statement.catchClause && !statement.finallyBlock) {
          traceSink.handlerRegions.push({
            modelName: currentModelName,
            tryStart: statement.getStart(source),
            tryEnd: statement.getEnd(),
            entry: handlerRegionEntry,
            exit: new Map(updates),
          });
        }
        if (!statement.finallyBlock) {
          if (residualCompletion === "normal") continue;
        } else {
          const priorReturn = completionPredicate(residualCompletion, "return");
          const priorThrow = completionPredicate(residualCompletion, "throw");
          const priorBreak = completionPredicate(residualCompletion, "break");
          const priorContinue = completionPredicate(residualCompletion, "continue");
          const beforeFinallyUpdates = new Map(updates);
          const normalBeforeFinallyLocals = new Map(localValues);
          const finallyLocals = joinIncomingCompletionLocals(residualCompletion, localValues);
          if (!finallyLocals) return undefined;
          const joinedBeforeFinallyLocals = new Map(finallyLocals);
          const finallyCompletion = collect(
            statement.finallyBlock, receiver, runtimeClass, substitutions,
            updates, finallyLocals, activeCalls, true, true,
            allowBreak, allowContinue, ownedBreakLabel, ownedContinueLabel,
            activeBreakLabels, activeContinueLabels,
            allowMutableLoopWrites,
          );
          if (!finallyCompletion) return undefined;
          const finallyMutatesVisibleLocal = [...joinedBeforeFinallyLocals.keys()].some((name) =>
            !name.startsWith("\u0000mutable:")
            && !sameRefinementExpression(joinedBeforeFinallyLocals.get(name)!, finallyLocals.get(name)!));
          if (finallyMutatesVisibleLocal) {
            const finallyReturn = completionPredicate(finallyCompletion, "return");
            const finallyThrow = completionPredicate(finallyCompletion, "throw");
            const finallyBreak = completionPredicate(finallyCompletion, "break");
            const finallyContinue = completionPredicate(finallyCompletion, "continue");
            // Return, supported normalized throw, and loop-owned transfers
            // carry explicit snapshots. Cross/nested labeled overrides still
            // need target-specific edge ownership.
            if (!isBooleanCompletionPredicate(labeledCompletionPredicate(finallyCompletion), false)) return undefined;
            const finallyNormal = notCompletionPredicate(orCompletionPredicates(
              orCompletionPredicates(
                orCompletionPredicates(finallyReturn, finallyThrow), finallyBreak,
              ),
              finallyContinue,
            ));
            const replayFinally = (
              incoming: ReadonlyMap<string, TemporalExpression>,
            ): { completion: ActionCompletion; normalLocals: Map<string, TemporalExpression> } | undefined => {
              const replayLocals = new Map(incoming);
              // The joined evaluation above owns state updates. Replays only
              // project the mandatory local transformation onto each incoming
              // completion edge, so their copied update maps are discarded.
              const replayCompletion = collect(
                statement.finallyBlock!, receiver, runtimeClass, substitutions,
                new Map(beforeFinallyUpdates), replayLocals, activeCalls, true, true,
                allowBreak, allowContinue, ownedBreakLabel, ownedContinueLabel,
                activeBreakLabels, activeContinueLabels,
                allowMutableLoopWrites,
              );
              if (!replayCompletion
                || !isBooleanCompletionPredicate(labeledCompletionPredicate(replayCompletion), false)) return undefined;
              return { completion: replayCompletion, normalLocals: replayLocals };
            };
            const normalReplay = replayFinally(normalBeforeFinallyLocals);
            if (!normalReplay) return undefined;
            const replayEdge = (abrupt: AbruptCompletion): ReadonlyMap<string, TemporalExpression> | undefined => {
              if (isBooleanCompletionPredicate(completionPredicate(residualCompletion, abrupt), false)) return undefined;
              const incoming = completionEdgeLocals(residualCompletion, abrupt);
              return incoming ? replayFinally(incoming)?.normalLocals : undefined;
            };
            const throwAfterFinallyLocals = replayEdge("throw");
            const returnAfterFinallyLocals = replayEdge("return");
            const breakAfterFinallyLocals = replayEdge("break");
            const continueAfterFinallyLocals = replayEdge("continue");
            if ((!isBooleanCompletionPredicate(priorThrow, false) && !throwAfterFinallyLocals)
              || (!isBooleanCompletionPredicate(priorReturn, false) && !returnAfterFinallyLocals)
              || (!isBooleanCompletionPredicate(priorBreak, false) && !breakAfterFinallyLocals)
              || (!isBooleanCompletionPredicate(priorContinue, false) && !continueAfterFinallyLocals)) return undefined;
            localValues.clear();
            for (const [name, value] of normalReplay.normalLocals) localValues.set(name, value);
            const transformedPrior = makeCompletion(
              priorReturn,
              priorThrow,
              completionThrowValue(residualCompletion),
              priorBreak,
              priorContinue,
              completionLabels(residualCompletion, "break"),
              completionLabels(residualCompletion, "continue"),
              throwAfterFinallyLocals,
              returnAfterFinallyLocals,
              breakAfterFinallyLocals,
              continueAfterFinallyLocals,
            );
            residualCompletion = makeCompletion(
              orCompletionPredicates(finallyReturn, andCompletionPredicates(finallyNormal, priorReturn)),
              orCompletionPredicates(finallyThrow, andCompletionPredicates(finallyNormal, priorThrow)),
              sequenceThrowValue(finallyCompletion, transformedPrior),
              orCompletionPredicates(finallyBreak, andCompletionPredicates(finallyNormal, priorBreak)),
              orCompletionPredicates(finallyContinue, andCompletionPredicates(finallyNormal, priorContinue)),
              mergeCompletionLabels(new Map(), completionLabels(residualCompletion, "break"), finallyNormal),
              mergeCompletionLabels(new Map(), completionLabels(residualCompletion, "continue"), finallyNormal),
              sequenceEdgeLocals(finallyCompletion, transformedPrior, "throw"),
              sequenceEdgeLocals(finallyCompletion, transformedPrior, "return"),
              sequenceEdgeLocals(finallyCompletion, transformedPrior, "break"),
              sequenceEdgeLocals(finallyCompletion, transformedPrior, "continue"),
            );
          } else {
            const finallyReturn = completionPredicate(finallyCompletion, "return");
            const finallyThrow = completionPredicate(finallyCompletion, "throw");
            const finallyBreak = completionPredicate(finallyCompletion, "break");
            const finallyContinue = completionPredicate(finallyCompletion, "continue");
            const finallyNormal = notCompletionPredicate(orCompletionPredicates(
              orCompletionPredicates(
                orCompletionPredicates(finallyReturn, finallyThrow), finallyBreak,
              ),
              orCompletionPredicates(finallyContinue, labeledCompletionPredicate(finallyCompletion)),
            ));
            residualCompletion = makeCompletion(
              orCompletionPredicates(finallyReturn, andCompletionPredicates(finallyNormal, priorReturn)),
              orCompletionPredicates(finallyThrow, andCompletionPredicates(finallyNormal, priorThrow)),
              sequenceThrowValue(finallyCompletion, residualCompletion),
              orCompletionPredicates(finallyBreak, andCompletionPredicates(finallyNormal, priorBreak)),
              orCompletionPredicates(finallyContinue, andCompletionPredicates(finallyNormal, priorContinue)),
              mergeCompletionLabels(
                completionLabels(finallyCompletion, "break"),
                completionLabels(residualCompletion, "break"),
                finallyNormal,
              ),
              mergeCompletionLabels(
                completionLabels(finallyCompletion, "continue"),
                completionLabels(residualCompletion, "continue"),
                finallyNormal,
              ),
              sequenceEdgeLocals(finallyCompletion, residualCompletion, "throw"),
              sequenceEdgeLocals(finallyCompletion, residualCompletion, "return"),
              sequenceEdgeLocals(finallyCompletion, residualCompletion, "break"),
              sequenceEdgeLocals(finallyCompletion, residualCompletion, "continue"),
            );
          }
          if (residualCompletion === "normal") continue;
        }
        const priorReturn = completionPredicate(residualCompletion, "return");
        const priorThrow = completionPredicate(residualCompletion, "throw");
        const priorBreak = completionPredicate(residualCompletion, "break");
        const priorContinue = completionPredicate(residualCompletion, "continue");
        const priorLabeled = labeledCompletionPredicate(residualCompletion);
        const priorAbrupt = orCompletionPredicates(
          orCompletionPredicates(
            orCompletionPredicates(orCompletionPredicates(priorReturn, priorThrow), priorBreak), priorContinue,
          ),
          priorLabeled,
        );
        if (isBooleanCompletionPredicate(priorAbrupt, true)) return residualCompletion;
        const beforeContinuation = new Map(updates);
        const continuingUpdates = new Map(updates);
        const continuingLocals = new Map(localValues);
        const continued = collect(
          ts.factory.createBlock(body.statements.slice(statementIndex + 1), true), receiver, runtimeClass, substitutions,
          continuingUpdates, continuingLocals, activeCalls, allowTerminalReturn, allowTerminalThrow,
          allowBreak, allowContinue, ownedBreakLabel, ownedContinueLabel,
          activeBreakLabels, activeContinueLabels,
          allowMutableLoopWrites,
        );
        if (!continued) return undefined;
        const normalWhen = notCompletionPredicate(priorAbrupt);
        mergeConditionalUpdates(priorAbrupt, beforeContinuation, continuingUpdates, beforeContinuation);
        localValues.clear();
        for (const [name, value] of continuingLocals) localValues.set(name, value);
        return makeCompletion(
          orCompletionPredicates(priorReturn, andCompletionPredicates(normalWhen, completionPredicate(continued, "return"))),
          orCompletionPredicates(priorThrow, andCompletionPredicates(normalWhen, completionPredicate(continued, "throw"))),
          sequenceThrowValue(residualCompletion, continued),
          orCompletionPredicates(priorBreak, andCompletionPredicates(normalWhen, completionPredicate(continued, "break"))),
          orCompletionPredicates(priorContinue, andCompletionPredicates(normalWhen, completionPredicate(continued, "continue"))),
          mergeCompletionLabels(completionLabels(residualCompletion, "break"), completionLabels(continued, "break"), normalWhen),
          mergeCompletionLabels(completionLabels(residualCompletion, "continue"), completionLabels(continued, "continue"), normalWhen),
          sequenceEdgeLocals(residualCompletion, continued, "throw"),
          sequenceEdgeLocals(residualCompletion, continued, "return"),
          sequenceEdgeLocals(residualCompletion, continued, "break"),
          sequenceEdgeLocals(residualCompletion, continued, "continue"),
        );
      }
      if (ts.isIfStatement(statement)) {
        const normalizedCondition = normalizeRefinementExpression(statement.expression, receiver, substitutions, expressionStateNames, new Map(), new Set(), localValues);
        if (!normalizedCondition) return undefined;
        const condition = expandLocalSnapshots(resolveCurrentState(normalizedCondition));
        const before = new Map(updates);
        const trueBlock = asBlock(statement.thenStatement);
        const falseBlock = asBlock(statement.elseStatement);
        const trueUpdates = new Map(before);
        const falseUpdates = new Map(before);
        const beforeLocals = new Map(localValues);
        const trueLocals = new Map(localValues);
        const falseLocals = new Map(localValues);
        let whenTrue = collect(trueBlock, receiver, runtimeClass, substitutions, trueUpdates, trueLocals, activeCalls, allowTerminalReturn, allowTerminalThrow, allowBreak, allowContinue, ownedBreakLabel, ownedContinueLabel, activeBreakLabels, activeContinueLabels, allowMutableLoopWrites);
        let whenFalse = collect(falseBlock, receiver, runtimeClass, substitutions, falseUpdates, falseLocals, activeCalls, allowTerminalReturn, allowTerminalThrow, allowBreak, allowContinue, ownedBreakLabel, ownedContinueLabel, activeBreakLabels, activeContinueLabels, allowMutableLoopWrites);
        if (!whenTrue || !whenFalse) return undefined;
        const hasAbruptBranch = whenTrue !== "normal" || whenFalse !== "normal";
        if (hasAbruptBranch) {
          const continuation = ts.factory.createBlock(body.statements.slice(statementIndex + 1), true);
          whenTrue = applyContinuation(whenTrue, trueUpdates, continuation, trueLocals);
          whenFalse = applyContinuation(whenFalse, falseUpdates, continuation, falseLocals);
          if (!whenTrue || !whenFalse) return undefined;
          const abruptWhen = (completion: ActionCompletion): TemporalExpression => orCompletionPredicates(
            orCompletionPredicates(
              orCompletionPredicates(
                completionPredicate(completion, "return"), completionPredicate(completion, "throw"),
              ),
              completionPredicate(completion, "break"),
            ),
            orCompletionPredicates(completionPredicate(completion, "continue"), labeledCompletionPredicate(completion)),
          );
          const trueAbrupt = abruptWhen(whenTrue);
          const falseAbrupt = abruptWhen(whenFalse);
          const trueNormal = notCompletionPredicate(trueAbrupt);
          const falseNormal = notCompletionPredicate(falseAbrupt);
          const replaceLocals = (sourceLocals: ReadonlyMap<string, TemporalExpression>): void => {
            localValues.clear();
            for (const [name, value] of sourceLocals) localValues.set(name, value);
          };
          if (isBooleanCompletionPredicate(trueNormal, false)
            && !isBooleanCompletionPredicate(falseNormal, false)) replaceLocals(falseLocals);
          else if (isBooleanCompletionPredicate(falseNormal, false)
            && !isBooleanCompletionPredicate(trueNormal, false)) replaceLocals(trueLocals);
          else if (!isBooleanCompletionPredicate(trueNormal, false)
            && !isBooleanCompletionPredicate(falseNormal, false)) {
            mergeConditionalLocalValues(condition, trueLocals, falseLocals, beforeLocals);
          }
        }
        mergeConditionalUpdates(condition, trueUpdates, falseUpdates, before);
        if (!hasAbruptBranch) mergeConditionalLocalValues(condition, trueLocals, falseLocals, beforeLocals);
        if (hasAbruptBranch) {
          return makeCompletion(
            joinCompletionPredicate(condition, completionPredicate(whenTrue, "return"), completionPredicate(whenFalse, "return")),
            joinCompletionPredicate(condition, completionPredicate(whenTrue, "throw"), completionPredicate(whenFalse, "throw")),
            joinThrowValue(condition, whenTrue, whenFalse),
            joinCompletionPredicate(condition, completionPredicate(whenTrue, "break"), completionPredicate(whenFalse, "break")),
            joinCompletionPredicate(condition, completionPredicate(whenTrue, "continue"), completionPredicate(whenFalse, "continue")),
            joinCompletionLabels(condition, completionLabels(whenTrue, "break"), completionLabels(whenFalse, "break")),
            joinCompletionLabels(condition, completionLabels(whenTrue, "continue"), completionLabels(whenFalse, "continue")),
            joinEdgeLocals(condition, "throw", whenTrue, whenFalse),
            joinEdgeLocals(condition, "return", whenTrue, whenFalse),
            joinEdgeLocals(condition, "break", whenTrue, whenFalse),
            joinEdgeLocals(condition, "continue", whenTrue, whenFalse),
          );
        }
        continue;
      }
      if (ts.isSwitchStatement(statement)) {
        const normalizedDiscriminant = normalizeRefinementExpression(
          statement.expression, receiver, substitutions, expressionStateNames, new Map(), new Set(), localValues,
        );
        if (!normalizedDiscriminant) return undefined;
        const discriminant = expandLocalSnapshots(resolveCurrentState(normalizedDiscriminant));
        const clauses = [...statement.caseBlock.clauses];
        const caseMatches: TemporalExpression[] = [];
        const caseKeys = new Set<string>();
        for (const clause of clauses) {
          if (!ts.isCaseClause(clause)) continue;
          const label = normalizeRefinementExpression(
            clause.expression, receiver, substitutions, expressionStateNames, new Map(), new Set(), localValues,
          );
          if (!label || label.kind !== "integer" && label.kind !== "boolean") return undefined;
          const key = refinementExpressionKey(label);
          if (caseKeys.has(key)) return undefined;
          caseKeys.add(key);
          caseMatches.push({ kind: "binary", operator: "eq", left: discriminant, right: label });
        }
        if (clauses.filter(ts.isDefaultClause).length > 1) return undefined;
        const before = new Map(updates);
        const branches: Array<{
          condition: TemporalExpression;
          updates: Map<string, TemporalExpression>;
          locals: Map<string, TemporalExpression>;
          completion: ActionCompletion;
        }> = [];
        let defaultUpdates: Map<string, TemporalExpression> | undefined;
        let defaultLocals: Map<string, TemporalExpression> | undefined;
        let defaultCompletion: ActionCompletion = "normal";
        const beforeLocals = new Map(localValues);
        let caseIndex = 0;
        for (let entry = 0; entry < clauses.length; entry++) {
          const clause = clauses[entry]!;
          const condition = ts.isCaseClause(clause) ? caseMatches[caseIndex++]! : undefined;
          const pathStatements: ts.Statement[] = [];
          let stopped = false;
          for (let clauseIndex = entry; clauseIndex < clauses.length && !stopped; clauseIndex++) {
            const statements = [...clauses[clauseIndex]!.statements];
            const abruptIndex = statements.findIndex((candidate) => ts.isBreakStatement(candidate)
              || ts.isContinueStatement(candidate) || ts.isReturnStatement(candidate) || ts.isThrowStatement(candidate));
            if (abruptIndex >= 0) {
              const abrupt = statements[abruptIndex]!;
              if (abruptIndex !== statements.length - 1) return undefined;
              if (ts.isBreakStatement(abrupt) && !abrupt.label) {
                pathStatements.push(...statements.slice(0, abruptIndex));
              } else pathStatements.push(...statements);
              stopped = true;
            } else pathStatements.push(...statements);
          }
          const branchUpdates = new Map(before);
          const branchLocals = new Map(beforeLocals);
          const branch = collect(
            ts.factory.createBlock(pathStatements, true), receiver, runtimeClass, substitutions,
            branchUpdates, branchLocals, activeCalls, allowTerminalReturn, allowTerminalThrow,
            allowBreak, allowContinue, ownedBreakLabel, ownedContinueLabel,
            activeBreakLabels, activeContinueLabels,
            allowMutableLoopWrites,
          );
          if (!branch) return undefined;
          if (condition) branches.push({ condition, updates: branchUpdates, locals: branchLocals, completion: branch });
          else {
            defaultUpdates = branchUpdates;
            defaultLocals = branchLocals;
            defaultCompletion = branch;
          }
        }
        updates.clear();
        for (const name of stateNames) {
          const original = before.get(name) ?? { kind: "name", name } as TemporalExpression;
          let merged = defaultUpdates?.get(name) ?? original;
          for (let index = branches.length - 1; index >= 0; index--) {
            const branch = branches[index]!;
            const value = branch.updates.get(name) ?? original;
            if (!sameRefinementExpression(value, merged)) merged = {
              kind: "conditional", condition: branch.condition, whenTrue: value, whenFalse: merged,
            };
          }
          if (!sameRefinementExpression(merged, { kind: "name", name })) updates.set(name, merged);
        }
        for (const name of [...beforeLocals.keys()].filter((candidate) => !candidate.startsWith("\u0000mutable:"))) {
          const original = beforeLocals.get(name)!;
          let merged = defaultLocals?.get(name) ?? original;
          for (let index = branches.length - 1; index >= 0; index--) {
            const branch = branches[index]!;
            const value = branch.locals.get(name) ?? original;
            if (!sameRefinementExpression(value, merged)) merged = {
              kind: "conditional", condition: branch.condition, whenTrue: value, whenFalse: merged,
            };
          }
          localValues.set(name, merged);
        }
        let caseMatched: TemporalExpression = { kind: "boolean", value: false };
        for (const branch of branches) caseMatched = orCompletionPredicates(caseMatched, branch.condition);
        const defaultSelected = notCompletionPredicate(caseMatched);
        let returnWhen = andCompletionPredicates(
          defaultSelected, completionPredicate(defaultCompletion, "return"),
        );
        let throwWhen = andCompletionPredicates(
          defaultSelected, completionPredicate(defaultCompletion, "throw"),
        );
        for (const branch of branches) {
          returnWhen = orCompletionPredicates(returnWhen, andCompletionPredicates(
            branch.condition, completionPredicate(branch.completion, "return"),
          ));
          throwWhen = orCompletionPredicates(throwWhen, andCompletionPredicates(
            branch.condition, completionPredicate(branch.completion, "throw"),
          ));
        }
        if (isBooleanCompletionPredicate(completionPredicate(defaultCompletion, "return"), true)
          && branches.every((branch) => isBooleanCompletionPredicate(completionPredicate(branch.completion, "return"), true))) {
          returnWhen = { kind: "boolean", value: true };
        }
        if (isBooleanCompletionPredicate(completionPredicate(defaultCompletion, "throw"), true)
          && branches.every((branch) => isBooleanCompletionPredicate(completionPredicate(branch.completion, "throw"), true))) {
          throwWhen = { kind: "boolean", value: true };
        }
        let selectedCompletion = defaultCompletion;
        for (let index = branches.length - 1; index >= 0; index--) {
          const branch = branches[index]!;
          selectedCompletion = makeCompletion(
            joinCompletionPredicate(
              branch.condition,
              completionPredicate(branch.completion, "return"),
              completionPredicate(selectedCompletion, "return"),
            ),
            joinCompletionPredicate(
              branch.condition,
              completionPredicate(branch.completion, "throw"),
              completionPredicate(selectedCompletion, "throw"),
            ),
            joinThrowValue(branch.condition, branch.completion, selectedCompletion),
            joinCompletionPredicate(
              branch.condition,
              completionPredicate(branch.completion, "break"),
              completionPredicate(selectedCompletion, "break"),
            ),
            joinCompletionPredicate(
              branch.condition,
              completionPredicate(branch.completion, "continue"),
              completionPredicate(selectedCompletion, "continue"),
            ),
            joinCompletionLabels(
              branch.condition,
              completionLabels(branch.completion, "break"),
              completionLabels(selectedCompletion, "break"),
            ),
            joinCompletionLabels(
              branch.condition,
              completionLabels(branch.completion, "continue"),
              completionLabels(selectedCompletion, "continue"),
            ),
            joinEdgeLocals(branch.condition, "throw", branch.completion, selectedCompletion),
            joinEdgeLocals(branch.condition, "return", branch.completion, selectedCompletion),
            joinEdgeLocals(branch.condition, "break", branch.completion, selectedCompletion),
            joinEdgeLocals(branch.condition, "continue", branch.completion, selectedCompletion),
          );
        }
        const switchCompletion = makeCompletion(
          returnWhen,
          throwWhen,
          completionThrowValue(selectedCompletion),
          completionPredicate(selectedCompletion, "break"),
          completionPredicate(selectedCompletion, "continue"),
          completionLabels(selectedCompletion, "break"),
          completionLabels(selectedCompletion, "continue"),
          completionThrowLocals(selectedCompletion),
          completionReturnLocals(selectedCompletion),
          completionBreakLocals(selectedCompletion),
          completionContinueLocals(selectedCompletion),
        );
        if (switchCompletion !== "normal") {
          return applyContinuation(
            switchCompletion, updates, ts.factory.createBlock(body.statements.slice(statementIndex + 1), true),
          );
        }
        continue;
      }
      if (ts.isVariableStatement(statement)) {
        const mutable = (statement.declarationList.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) === ts.NodeFlags.Let;
        if (!mutable && (statement.declarationList.flags & ts.NodeFlags.Const) === 0) return undefined;
        for (const declaration of statement.declarationList.declarations) {
          if (!ts.isIdentifier(declaration.name) || !declaration.initializer
            || localValues.has(declaration.name.text) || substitutions.has(declaration.name.text)) return undefined;
          const localName = declaration.name.text;
          const resolveReceiverAlias = (expression: ts.Expression, seen: ReadonlySet<string> = new Set()): ts.Expression | undefined => {
            const candidate = unwrap(expression);
            if (candidate.kind === ts.SyntaxKind.ThisKeyword) return receiver === "this" ? candidate : undefined;
            if (!ts.isIdentifier(candidate)) return undefined;
            if (candidate.text === receiver) return candidate;
            if (seen.has(candidate.text)) return undefined;
            const replacement = substitutions.get(candidate.text);
            return replacement ? resolveReceiverAlias(replacement, new Set([...seen, candidate.text])) : undefined;
          };
          const receiverAlias = resolveReceiverAlias(declaration.initializer);
          if (receiverAlias) {
            if (mutable) return undefined;
            substitutions.set(localName, receiverAlias);
            continue;
          }
          if (mutable) {
            const declarationSymbol = checker && ts.isIdentifier(declaration.name)
              ? checker.getSymbolAtLocation(declaration.name) : undefined;
            let owner: ts.Node | undefined = declaration.parent;
            while (owner && !ts.isFunctionLike(owner)) owner = owner.parent;
            let hasSupportedWrite = false;
            const findWrite = (candidate: ts.Node): void => {
              if (hasSupportedWrite || ts.isFunctionLike(candidate) && candidate !== owner) return;
              if (ts.isBinaryExpression(candidate) && ts.isIdentifier(candidate.left)
                && [ts.SyntaxKind.EqualsToken, ts.SyntaxKind.PlusEqualsToken, ts.SyntaxKind.MinusEqualsToken]
                  .includes(candidate.operatorToken.kind)
                && (declarationSymbol
                  ? checker!.getSymbolAtLocation(candidate.left) === declarationSymbol
                  : candidate.left.text === localName)) {
                hasSupportedWrite = true;
                return;
              }
              candidate.forEachChild(findWrite);
            };
            if (!owner) return undefined;
            owner.forEachChild(findWrite);
            if (!hasSupportedWrite) return undefined;
          }
          const value = normalizeRefinementExpression(declaration.initializer, receiver, substitutions, expressionStateNames, new Map(), new Set(), localValues);
          if (!value) return undefined;
          localValues.set(localName, expandLocalSnapshots(resolveCurrentState(value)));
          if (mutable) localValues.set(mutableLocalMarker(localName), { kind: "boolean", value: true });
        }
        continue;
      }
      if (!ts.isExpressionStatement(statement) && !terminalReturn) return undefined;
      const node = ts.isReturnStatement(statement) ? statement.expression! : statement.expression;
      if (ts.isCallExpression(node) && (ts.isIdentifier(node.expression)
        || checker !== undefined && ts.isPropertyAccessExpression(node.expression) && resolveFunction(node.expression) !== undefined)) {
        const helperName = node.expression.getText();
        const helper = resolveFunction(node.expression);
        const helperSource = helper?.getSourceFile();
        const declarationKey = helper && helperSource
          ? `${helperSource.fileName}:${helper.getStart(helperSource)}` : undefined;
        const external = declarationKey ? options.externalActions?.get(declarationKey) : undefined;
        const callKey = helper ? `function:${helper.getSourceFile().fileName}:${helper.pos}` : `function:${helperName}`;
        if (helper && !helper.body && external?.evidence === "verified"
          && external.adapterName === adapterName && external.version === manifest.version
          && helper.parameters.length === 1 && node.arguments.length === 1) {
          if (external.guard && external !== permittedGuardedExternal) return undefined;
          const receiverArgument = node.arguments[0]!;
          const substitutedReceiver = ts.isIdentifier(receiverArgument) ? substitutions.get(receiverArgument.text) : undefined;
          const receiverMatches = receiverArgument.kind === ts.SyntaxKind.ThisKeyword
            || ts.isIdentifier(receiverArgument) && (receiverArgument.text === receiver
              || (substitutedReceiver !== undefined && ts.isIdentifier(substitutedReceiver) && substitutedReceiver.text === receiver));
          if ((!receiverMatches && !sameRuntimeIdentity(external, receiverArgument))
            || external.assignments.some(({ target }) => !stateNames.has(target))) return undefined;
          const resolved = external.assignments.map(({ target, expressionAst }) => [
            target, expandLocalSnapshots(resolveCurrentState(expressionAst)),
          ] as const);
          for (const [target, expression] of resolved) updates.set(target, expression);
          if (terminalReturn) return "return";
          continue;
        }
        if (!helper?.body || activeCalls.has(callKey) || helper.parameters.length !== node.arguments.length
          || helper.parameters.length === 0 || helper.parameters.some((parameter) => !ts.isIdentifier(parameter.name))) return undefined;
        const receiverArgument = node.arguments[0]!;
        const runtimeReceiver = ts.isIdentifier(receiverArgument)
          && (receiverArgument.text === "global" || receiverArgument.text === "globalThis")
          && isManifestRuntimeArgument(receiverArgument);
        const aliasRegion = runtimeReceiver ? undefined
          : localAliasRegion(node, receiverArgument, receiver, substitutions, helper);
        if (aliasRegion === "unsupported") return undefined;
        if (aliasRegion && traceSink && currentModelName) {
          if (traceSink.aliasRegions.some((region) => region.modelName === currentModelName)) return undefined;
          traceSink.aliasRegions.push({ modelName: currentModelName, ...aliasRegion });
        }
        const substitutedReceiver = ts.isIdentifier(receiverArgument) ? substitutions.get(receiverArgument.text) : undefined;
        const receiverMatches = receiverArgument.kind === ts.SyntaxKind.ThisKeyword
          || ts.isIdentifier(receiverArgument) && (receiverArgument.text === receiver
            || (substitutedReceiver !== undefined && ts.isIdentifier(substitutedReceiver) && substitutedReceiver.text === receiver));
        if (!receiverMatches && !runtimeReceiver
          && !(external ? sameRuntimeIdentity(external, receiverArgument) : isManifestRuntimeArgument(receiverArgument))) return undefined;
        const helperLocals = new Map<string, TemporalExpression>();
        for (let index = 1; index < helper.parameters.length; index++) {
          const argument = normalizeRefinementExpression(node.arguments[index]!, receiver, substitutions, expressionStateNames, new Map(), new Set(), localValues);
          if (!argument) return undefined;
          helperLocals.set((helper.parameters[index]!.name as ts.Identifier).text, expandLocalSnapshots(resolveCurrentState(argument)));
        }
        const helperReceiver = (helper.parameters[0]!.name as ts.Identifier).text;
        if (!collect(helper.body, helperReceiver, undefined, new Map(), updates, helperLocals, new Set([...activeCalls, callKey]), true)) return undefined;
        if (terminalReturn) return "return";
        continue;
      }
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const [target, ...fields] = actionFieldPath(node.expression.expression, receiver, substitutions) ?? [];
        let targetType = target ? stateTypes.get(target) : undefined;
        for (const field of fields) {
          if (!targetType || typeof targetType === "string" || targetType.kind !== "record") { targetType = undefined; break; }
          targetType = targetType.fields[field];
        }
        const relation = target ? abstraction.get(target) : undefined;
        if (target && stateNames.has(target) && targetType && relation
          && parseAbstractionValue(relation).kind === "set-from-array"
          && typeof targetType !== "string" && targetType.kind === "set"
          && fields.length === 0 && node.expression.name.text === "push" && node.arguments.length === 1
          && isBuiltinArrayReceiver(node.expression.expression)) {
          const element = normalizeRefinementExpression(node.arguments[0]!, receiver, substitutions, expressionStateNames, new Map(), new Set(), localValues);
          if (!element) return undefined;
          writePath(target, [], {
            kind: "method", receiver: readPath(target, []), name: "union",
            arguments: [{ kind: "call", name: "Set", arguments: [expandLocalSnapshots(resolveCurrentState(element))] }],
          });
          continue;
        }
        if (target && stateNames.has(target) && targetType && relation
          && parseAbstractionValue(relation).kind === "map-from-entries"
          && typeof targetType !== "string" && targetType.kind === "map"
          && fields.length === 0 && node.expression.name.text === "push" && node.arguments.length === 1
          && isBuiltinArrayReceiver(node.expression.expression)
          && ts.isArrayLiteralExpression(node.arguments[0]!) && node.arguments[0]!.elements.length === 2) {
          const key = normalizeRefinementExpression(node.arguments[0]!.elements[0]!, receiver, substitutions, expressionStateNames, new Map(), new Set(), localValues);
          const value = normalizeRefinementExpression(node.arguments[0]!.elements[1]!, receiver, substitutions, expressionStateNames, new Map(), new Set(), localValues);
          if (!key || !value) return undefined;
          const resolvedKey = expandLocalSnapshots(resolveCurrentState(key));
          const current = readPath(target, []);
          const putReceiver = current.kind === "method" && current.name === "remove" && current.arguments.length === 1
            && sameRefinementExpression(current.arguments[0]!, resolvedKey) ? current.receiver : current;
          writePath(target, [], {
            kind: "method", receiver: putReceiver, name: "put",
            arguments: [resolvedKey, expandLocalSnapshots(resolveCurrentState(value))],
          });
          continue;
        }
        if (target && stateNames.has(target) && targetType && node.expression.name.text === "clear" && node.arguments.length === 0
          && typeof targetType !== "string" && (targetType.kind === "set" || targetType.kind === "map")
          && isBuiltinCollectionReceiver(node.expression.expression, targetType.kind)) {
          writePath(target, fields, targetType.kind === "set"
            ? { kind: "call", name: "Set", arguments: [] }
            : { kind: "call", name: "Map", arguments: [{ kind: "array", elements: [] }] });
          continue;
        }
        if (target && stateNames.has(target) && targetType && node.expression.name.text === "delete" && node.arguments.length === 1
          && typeof targetType !== "string" && (targetType.kind === "set" || targetType.kind === "map")
          && isBuiltinCollectionReceiver(node.expression.expression, targetType.kind)) {
          const item = normalizeRefinementExpression(node.arguments[0]!, receiver, substitutions, expressionStateNames, new Map(), new Set(), localValues);
          if (!item) return undefined;
          const argument = expandLocalSnapshots(resolveCurrentState(item));
          writePath(target, fields, targetType.kind === "set"
            ? { kind: "method", receiver: readPath(target, fields), name: "exclude", arguments: [{ kind: "call", name: "Set", arguments: [argument] }] }
            : { kind: "method", receiver: readPath(target, fields), name: "remove", arguments: [argument] });
          continue;
        }
        if (target && stateNames.has(target) && targetType && node.expression.name.text === "add"
          && typeof targetType !== "string" && targetType.kind === "set" && node.arguments.length === 1
          && isBuiltinCollectionReceiver(node.expression.expression, "set")) {
          const element = normalizeRefinementExpression(node.arguments[0]!, receiver, substitutions, expressionStateNames, new Map(), new Set(), localValues);
          if (!element) return undefined;
          writePath(target, fields, {
            kind: "method", receiver: readPath(target, fields), name: "union",
            arguments: [{ kind: "call", name: "Set", arguments: [expandLocalSnapshots(resolveCurrentState(element))] }],
          });
          continue;
        }
        if (target && stateNames.has(target) && targetType && node.expression.name.text === "set"
          && typeof targetType !== "string" && targetType.kind === "map" && node.arguments.length === 2
          && isBuiltinCollectionReceiver(node.expression.expression, "map")) {
          const key = normalizeRefinementExpression(node.arguments[0]!, receiver, substitutions, expressionStateNames, new Map(), new Set(), localValues);
          const value = normalizeRefinementExpression(node.arguments[1]!, receiver, substitutions, expressionStateNames, new Map(), new Set(), localValues);
          if (!key || !value) return undefined;
          writePath(target, fields, {
            kind: "method", receiver: readPath(target, fields), name: "put",
            arguments: [expandLocalSnapshots(resolveCurrentState(key)), expandLocalSnapshots(resolveCurrentState(value))],
          });
          continue;
        }
      }
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
        && isRuntimeReceiverExpression(node.expression.expression) && runtimeClass) {
        const methodName = node.expression.name.text;
        const method = runtimeClass.members.find((member): member is ts.MethodDeclaration => ts.isMethodDeclaration(member) && ts.isIdentifier(member.name) && member.name.text === methodName);
        if (!method?.body || method.parameters.length !== node.arguments.length) return undefined;
        const nestedSubstitutions = new Map<string, ts.Expression>();
        method.parameters.forEach((parameter, index) => {
          if (ts.isIdentifier(parameter.name)) nestedSubstitutions.set(parameter.name.text, node.arguments[index]!);
        });
        const callKey = `method:${runtimeClass.name?.text ?? "<anonymous>"}.${methodName}`;
        if (activeCalls.has(callKey) || !collect(method.body, "this", runtimeClass, nestedSubstitutions, updates, new Map(localValues), new Set([...activeCalls, callKey]), true)) return undefined;
        if (terminalReturn) return "return";
        continue;
      }
      if (ts.isPostfixUnaryExpression(node) || ts.isPrefixUnaryExpression(node)) {
        if (node.operator !== ts.SyntaxKind.PlusPlusToken && node.operator !== ts.SyntaxKind.MinusMinusToken) return undefined;
        const [target, ...fields] = actionFieldPath(node.operand, receiver, substitutions) ?? [];
        if (!target || !stateNames.has(target)) return undefined;
        writePath(target, fields, { kind: "binary", operator: node.operator === ts.SyntaxKind.PlusPlusToken ? "add" : "subtract", left: readPath(target, fields), right: { kind: "integer", value: "1" } });
        continue;
      }
      if (ts.isBinaryExpression(node)) {
        if (ts.isIdentifier(node.left) && localValues.has(mutableLocalMarker(node.left.text))) {
          const ownershipNode = ts.getOriginalNode(node);
          const sourceFileName = ownershipNode.getSourceFile()?.fileName;
          if (sourceFileName === "__uneffect_labeled_block.ts") return undefined;
          const finiteExpansionNode = allowMutableLoopWrites;
          let owner: ts.Node | undefined = ownershipNode.parent;
          while (owner && !ts.isFunctionLike(owner)) {
            if (ts.isBlock(owner) && ts.isCaseClause(owner.parent)) return undefined;
            if ((!finiteExpansionNode && ts.isIterationStatement(owner, false))
              || (ts.isLabeledStatement(owner) && owner.label.text !== ownedBreakLabel)) return undefined;
            owner = owner.parent;
          }
          const current = localValues.get(node.left.text);
          const right = normalizeRefinementExpression(
            node.right, receiver, substitutions, expressionStateNames, new Map(), new Set(), localValues,
          );
          if (!current || !right) return undefined;
          const resolvedRight = expandLocalSnapshots(resolveCurrentState(right));
          if (node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
            localValues.set(node.left.text, resolvedRight);
          } else if (node.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken
            || node.operatorToken.kind === ts.SyntaxKind.MinusEqualsToken) {
            localValues.set(node.left.text, {
              kind: "binary",
              operator: node.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken ? "add" : "subtract",
              left: current,
              right: resolvedRight,
            });
          } else return undefined;
          continue;
        }
        const rawLeftPath = refinementFieldPath(node.left, receiver, substitutions)?.join(".");
        const computedArrayRelation = rawLeftPath
          ? [...abstraction].find(([, value]) => {
              const parsed = parseAbstractionValue(value);
              return parsed.kind === "set-from-array" && (rawLeftPath === parsed.path || rawLeftPath === `${parsed.path}.length`)
                || parsed.kind === "map-from-entries" && (rawLeftPath === parsed.path || rawLeftPath === `${parsed.path}.length`);
            })
          : undefined;
        if (computedArrayRelation) {
          const [abstract, relation] = computedArrayRelation;
          const parsedRelation = parseAbstractionValue(relation);
          const concretePath = parsedRelation.path;
          if (node.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return undefined;
          if (rawLeftPath === `${concretePath}.length`) {
            if (!ts.isNumericLiteral(node.right) || node.right.text !== "0") return undefined;
            writePath(abstract, [], parsedRelation.kind === "set-from-array"
              ? { kind: "call", name: "Set", arguments: [] }
              : { kind: "call", name: "Map", arguments: [{ kind: "array", elements: [] }] });
            continue;
          }
          if (!checker || !ts.isCallExpression(node.right) || !ts.isPropertyAccessExpression(node.right.expression)
            || node.right.expression.name.text !== "filter" || node.right.arguments.length !== 1
            || !isDeclarationFileSymbol(checker, node.right.expression.name, "filter")
            || !isBuiltinArrayReceiver(node.right.expression.expression)
            || refinementFieldPath(node.right.expression.expression, receiver, substitutions)?.join(".") !== concretePath) return undefined;
          const callback = node.right.arguments[0];
          if (!callback || !ts.isArrowFunction(callback) || callback.parameters.length !== 1
            || !ts.isIdentifier(callback.parameters[0]!.name)) return undefined;
          const callbackExpression = ts.isBlock(callback.body)
            ? callback.body.statements.length === 1 && ts.isReturnStatement(callback.body.statements[0]!)
              && callback.body.statements[0]!.expression ? unwrap(callback.body.statements[0]!.expression!) : undefined
            : unwrap(callback.body);
          if (!callbackExpression || !ts.isBinaryExpression(callbackExpression)
            || callbackExpression.operatorToken.kind !== ts.SyntaxKind.ExclamationEqualsEqualsToken) return undefined;
          const parameter = callback.parameters[0]!.name.text;
          const matchesElement = (expression: ts.Expression): boolean => parsedRelation.kind === "set-from-array"
            ? ts.isIdentifier(expression) && expression.text === parameter
            : ts.isElementAccessExpression(expression) && ts.isIdentifier(expression.expression)
              && expression.expression.text === parameter && !!expression.argumentExpression
              && ts.isNumericLiteral(expression.argumentExpression) && expression.argumentExpression.text === "0";
          const leftMatches = matchesElement(callbackExpression.left);
          const rightMatches = matchesElement(callbackExpression.right);
          if (leftMatches === rightMatches) return undefined;
          const excludedNode = leftMatches ? callbackExpression.right : callbackExpression.left;
          const excluded = normalizeRefinementExpression(excludedNode, receiver, substitutions, expressionStateNames, new Map(), new Set(), localValues, checker);
          if (!excluded) return undefined;
          const argument = expandLocalSnapshots(resolveCurrentState(excluded));
          writePath(abstract, [], parsedRelation.kind === "set-from-array" ? {
            kind: "method", receiver: readPath(abstract, []), name: "exclude",
            arguments: [{ kind: "call", name: "Set", arguments: [argument] }],
          } : { kind: "method", receiver: readPath(abstract, []), name: "remove", arguments: [argument] });
          continue;
        }
        const [target, ...fields] = actionFieldPath(node.left, receiver, substitutions) ?? [];
        if (!target || !stateNames.has(target)) return undefined;
        const right = normalizeRefinementExpression(node.right, receiver, substitutions, expressionStateNames, new Map(), new Set(), localValues);
        if (!right) return undefined;
        const resolvedRight = expandLocalSnapshots(resolveCurrentState(right));
        if (node.operatorToken.kind === ts.SyntaxKind.EqualsToken) writePath(target, fields, resolvedRight);
        else if (node.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken
          || node.operatorToken.kind === ts.SyntaxKind.MinusEqualsToken
          || node.operatorToken.kind === ts.SyntaxKind.AsteriskEqualsToken) {
          writePath(target, fields, {
            kind: "binary",
            operator: node.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken ? "add"
              : node.operatorToken.kind === ts.SyntaxKind.MinusEqualsToken ? "subtract" : "multiply",
            left: readPath(target, fields), right: resolvedRight,
          });
        } else return undefined;
        continue;
      }
      return undefined;
    }
    return "normal";
  };

  const finiteLoopNestingWithinLimit = (root: ts.Node, limit = 64): boolean => {
    const boundedForCount = (statement: ts.ForStatement): number | undefined => {
      const declaration = statement.initializer && ts.isVariableDeclarationList(statement.initializer)
        && statement.initializer.declarations.length === 1 ? statement.initializer.declarations[0] : undefined;
      const name = declaration && ts.isIdentifier(declaration.name) ? declaration.name.text : undefined;
      const start = declaration?.initializer && ts.isNumericLiteral(declaration.initializer)
        ? Number(declaration.initializer.text) : undefined;
      const condition = statement.condition && ts.isBinaryExpression(statement.condition)
        && statement.condition.operatorToken.kind === ts.SyntaxKind.LessThanToken
        && ts.isIdentifier(statement.condition.left) && statement.condition.left.text === name
        && ts.isNumericLiteral(statement.condition.right) ? Number(statement.condition.right.text) : undefined;
      return start !== undefined && condition !== undefined && Number.isSafeInteger(start) && Number.isSafeInteger(condition)
        && condition >= start ? condition - start : undefined;
    };
    const visit = (node: ts.Node, product: number): boolean => {
      if (ts.isFunctionLike(node) && node !== root || ts.isClassLike(node)) return true;
      if (ts.isForStatement(node)) {
        const count = boundedForCount(node);
        if (count !== undefined) {
          const nestedProduct = product * count;
          return nestedProduct <= limit && visit(node.statement, nestedProduct);
        }
      }
      if (ts.isForOfStatement(node)) {
        const iterable = ts.isAsExpression(node.expression) ? node.expression.expression : node.expression;
        if (ts.isArrayLiteralExpression(iterable)) {
          const nestedProduct = product * iterable.elements.length;
          return nestedProduct <= limit && visit(node.statement, nestedProduct);
        }
      }
      let valid = true;
      node.forEachChild((child) => { if (valid) valid = visit(child, product); });
      return valid;
    };
    return visit(root, 1);
  };

  for (const action of spec.actions) {
    currentModelName = action.name;
    runtimeIdentityFailure = undefined;
    const exportName = manifest.actions[action.name];
    if (!exportName) {
      diagnostics.push({ code: "missing-action-binding", adapterName, modelName: action.name, message: `action ${action.name} has no ${adapterName} refinement binding to verify` });
      continue;
    }
    const implementation = functions.get(exportName);
    const runtimeParameter = implementation?.parameters[0];
    const receiver = runtimeParameter && ts.isIdentifier(runtimeParameter.name) ? runtimeParameter.name.text : undefined;
    currentActionPrecondition = implementation && receiver
      ? functionPrecondition(implementation, receiver) : undefined;
    const guardedBody = implementation?.body && receiver ? earlyReturnGuard(implementation.body, receiver) : undefined;
    const inheritedExternal = guardedBody && receiver
      ? directExternalAction(guardedBody.updates, receiver) : undefined;
    const actualGuard = guardedBody?.guard ?? inheritedExternal?.guard;
    if (action.guard && !actualGuard) {
      diagnostics.push({ code: "missing-action-guard", adapterName, modelName: action.name, exportName, expected: formatRefinementExpression(action.guard.expressionAst), actual: "<missing>", message: `${exportName} does not enforce model action guard ${action.guard.expression}` });
    } else if (!action.guard && actualGuard) {
      diagnostics.push({ code: "unexpected-action-guard", adapterName, modelName: action.name, exportName, expected: "<none>", actual: formatRefinementExpression(actualGuard), message: `${exportName} enforces an early-return guard absent from model action ${action.name}` });
    } else if (action.guard && actualGuard && !sameRefinementExpression(action.guard.expressionAst, actualGuard)) {
      diagnostics.push({ code: "action-guard-mismatch", adapterName, modelName: action.name, exportName, expected: formatRefinementExpression(action.guard.expressionAst), actual: formatRefinementExpression(actualGuard), message: `${exportName} enforces ${formatRefinementExpression(actualGuard)}, expected ${action.guard.expression}` });
    }
    if (guardedBody?.guard && inheritedExternal?.guard
      && !sameRefinementExpression(guardedBody.guard, inheritedExternal.guard)) {
      diagnostics.push({
        code: "action-guard-mismatch", adapterName, modelName: action.name, exportName,
        expected: formatRefinementExpression(inheritedExternal.guard),
        actual: formatRefinementExpression(guardedBody.guard),
        message: `${exportName} guard ${formatRefinementExpression(guardedBody.guard)} does not match child action guard ${formatRefinementExpression(inheritedExternal.guard)}`,
      });
    }
    const updates = new Map<string, TemporalExpression>();
    finiteExpansionIterationsRemaining = maxFiniteExpansionIterations;
    permittedGuardedExternal = inheritedExternal;
    const completion = guardedBody && receiver && finiteLoopNestingWithinLimit(guardedBody.updates)
      ? collect(guardedBody.updates, receiver, resolveRuntimeClass(runtimeParameter), new Map(), updates)
      : undefined;
    permittedGuardedExternal = undefined;
    if (!completion) {
      diagnostics.push({
        code: "unsupported-action-body", adapterName, modelName: action.name, exportName,
        message: runtimeIdentityFailure
          ? `${exportName} cannot compose the external action: ${runtimeIdentityFailure}`
          : `${exportName} uses an action body outside the supported scalar refinement fragment`,
      });
      continue;
    }
    const expected = new Map(action.assignments.map(({ target, expressionAst }) => [target, expressionAst]));
    for (const state of spec.states) {
      const expectedExpression = expected.get(state.name) ?? { kind: "name", name: state.name } as const;
      const actualExpression = updates.get(state.name) ?? { kind: "name", name: state.name } as const;
      if (sameRefinementExpression(expectedExpression, actualExpression)) continue;
      const diagnostic: RefinementActionDiagnostic = {
        code: "action-update-mismatch", adapterName, modelName: action.name, exportName, target: state.name,
        expected: formatRefinementExpression(expectedExpression), actual: formatRefinementExpression(actualExpression),
        message: `${exportName} updates ${state.name} as ${formatRefinementExpression(actualExpression)}, expected ${formatRefinementExpression(expectedExpression)}`,
      };
      refinementMismatchExpressions.set(diagnostic, { expected: expectedExpression, actual: actualExpression });
      diagnostics.push(diagnostic);
    }
  }
  currentModelName = undefined;
  currentActionPrecondition = undefined;
  const modelActions = new Set(spec.actions.map(({ name }) => name));
  for (const [modelName, exportName] of Object.entries(manifest.actions)) {
    if (modelActions.has(modelName)) continue;
    diagnostics.push({ code: "unknown-action-binding", adapterName, modelName, exportName, message: `action refinement ${exportName} refers to unknown model action ${modelName}` });
  }
  return diagnostics;
}

/** Proves a deliberately small, zero-runtime scalar update fragment against model actions. */
export function validateRefinementActionBodies(
  fileName: string,
  text: string,
  adapterName: string,
  spec: TemporalSpec,
): RefinementActionDiagnostic[] {
  return validateRefinementActionBodiesInSource(
    ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS), text, adapterName, spec,
  );
}

interface RankingLoopJoinCandidate {
  readonly whileStatement: ts.WhileStatement;
  readonly tryStatement: ts.TryStatement;
  readonly throwStatement: ts.ThrowStatement;
  readonly handler: HandlerJoinCandidate;
}

function findRankingLoopThrowJoinCandidates(body: ts.Block): RankingLoopJoinCandidate[] {
  const candidates: RankingLoopJoinCandidate[] = [];
  const containedThrows = (root: ts.Node): ts.ThrowStatement[] => {
    const found: ts.ThrowStatement[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isFunctionLike(node)) return;
      if (ts.isThrowStatement(node)) { found.push(node); return; }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(root, visit);
    return found;
  };
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionLike(node) && node !== body.parent) return;
    if (ts.isWhileStatement(node)) {
      const loopBody = ts.isBlock(node.statement)
        ? node.statement
        : ts.factory.createBlock([node.statement], true);
      const handlers = findHandlerJoinCandidates(loopBody);
      for (const statement of loopBody.statements) {
        if (!ts.isTryStatement(statement) || !statement.catchClause) continue;
        const handler = handlers.find((item) => item.tryStatement === statement);
        const hasUnsupportedLoopCompletion = handler?.blocks.some((block) => block.edges.some(
          (edge) => edge.completion !== undefined
            && edge.completion !== "normal"
            && edge.completion !== "throw",
        ));
        if (!handler || handler.lowering !== "supported" || handler.controlRegion !== "try"
          || !handler.catchesThrow || handler.finallyOverrides.length > 0
          || handler.finiteLoop || hasUnsupportedLoopCompletion) continue;
        const throws = containedThrows(statement.tryBlock);
        const hasNormalStatement = statement.tryBlock.statements.some((item) => !ts.isThrowStatement(item));
        if (throws.length === 1 && hasNormalStatement) candidates.push({
          whileStatement: node,
          tryStatement: statement,
          throwStatement: throws[0]!,
          handler,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(body, visit);
  return candidates;
}

interface HandlerRecurrenceValueState {
  readonly normal: ReadonlyMap<string, Readonly<Record<string, string>>>;
  readonly throws: ReadonlyMap<string, string>;
  readonly recurrences: ReadonlyMap<string, RefinementRankingRecurrenceEvidence>;
}

function runHandlerBackedScalarRecurrenceFixedPoint(
  candidate: RankingLoopJoinCandidate,
  source: ts.SourceFile,
  limit: number,
  trace?: RefinementTryCatchValueTrace,
  recurrenceTrace?: RefinementRankingRecurrenceTrace,
): {
  iterations: number;
  converged: boolean;
  conflict: boolean;
  handlerCfg: { reused: true; blocks: readonly string[] };
  recurrence?: RefinementRankingRecurrenceEvidence;
  valueLattice: {
    throwPayloads: readonly string[];
    normalSnapshots: readonly string[];
    expressionSnapshots: {
      tryNormal: Readonly<Record<string, string>>;
      catchNormal: Readonly<Record<string, string>>;
      joinedNormal: Readonly<Record<string, string>>;
    };
  };
} {
  const value = (
    normal: readonly (readonly [string, Readonly<Record<string, string>>])[] = [],
    throws: readonly (readonly [string, string])[] = [],
    recurrences: readonly (readonly [string, RefinementRankingRecurrenceEvidence])[] = [],
  ): HandlerRecurrenceValueState => ({
    normal: new Map(normal), throws: new Map(throws), recurrences: new Map(recurrences),
  });
  const key = (state: HandlerRecurrenceValueState): string => JSON.stringify({
    normal: [...state.normal].sort(([left], [right]) => left.localeCompare(right)),
    throws: [...state.throws].sort(([left], [right]) => left.localeCompare(right)),
    recurrences: [...state.recurrences].sort(([left], [right]) => left.localeCompare(right)),
  });
  const specializedUpdates = (
    updates?: ReadonlyMap<string, TemporalExpression>,
    throwPath?: boolean,
  ): ReadonlyMap<string, TemporalExpression> => new Map([...(updates ?? [])]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, expression]) => [name,
        trace && throwPath !== undefined
          ? specializeExactRefinementCondition(expression, trace.throwWhen, throwPath)
          : expression]));
  const formatUpdates = (updates: ReadonlyMap<string, TemporalExpression>): Readonly<Record<string, string>> =>
    Object.fromEntries([...updates].map(([name, expression]) => [name, formatRefinementExpression(expression)]));
  const tryExpressions = specializedUpdates(trace?.tryUpdates, false);
  const catchExpressions = specializedUpdates(trace?.catchUpdates, true);
  const joinedExpressions = trace ? joinFlowValues({
    keys: new Set([...tryExpressions.keys(), ...catchExpressions.keys()]),
    condition: trace.throwWhen,
    original: (name) => ({ kind: "name", name }) as TemporalExpression,
    whenTrue: (name) => catchExpressions.get(name),
    whenFalse: (name) => tryExpressions.get(name),
    equivalent: sameRefinementExpression,
    phi: (condition, whenTrue, whenFalse): TemporalExpression => ({
      kind: "conditional", condition, whenTrue, whenFalse,
    }),
  }) : new Map<string, TemporalExpression>();
  const tryNormal = formatUpdates(tryExpressions);
  const catchNormal = formatUpdates(catchExpressions);
  const joinedNormal = formatUpdates(joinedExpressions);
  const recurrenceKey = `${candidate.whileStatement.getStart(source)}:${candidate.whileStatement.getEnd()}`;
  const recurrence: RefinementRankingRecurrenceEvidence | undefined = recurrenceTrace ? {
    counter: recurrenceTrace.counterName,
    direction: recurrenceTrace.direction,
    delta: recurrenceTrace.counterDelta,
    bound: recurrenceTrace.bound,
    stop: recurrenceTrace.stop,
    guard: formatRefinementExpression(recurrenceTrace.guard),
    iteration: formatUpdates(recurrenceTrace.iterationUpdates),
    summary: formatUpdates(recurrenceTrace.summaryUpdates),
    ...(recurrenceTrace.boundedSelfAffine
      ? { assumptions: [formatRefinementExpression(recurrenceTrace.boundedSelfAffine.precondition.expression)] }
      : {}),
    ...(recurrenceTrace.boundedSelfAffine
      ? { boundedSelfAffine: boundedSelfAffineEvidence(recurrenceTrace.boundedSelfAffine)! } : {}),
    stable: false,
  } : undefined;
  const payload = trace ? formatRefinementExpression(trace.throwValue) : candidate.throwStatement.expression.getText(source);
  const throwSnapshot = `throw@${candidate.throwStatement.getStart(source)}:${candidate.throwStatement.getEnd()}`;
  const result = solveBasicBlockFixedPoint({
    entry: "header",
    initial: value([["entry", {}]]),
    budget: { name: "cfg-recurrence-iterations", limit },
    lattice: {
      bottom: () => value(),
      equivalent: (left, right) => key(left) === key(right),
      join: (left, right) => {
        const normal = new Map(left.normal);
        for (const [snapshot, expressions] of right.normal) {
          const existing = normal.get(snapshot);
          if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(expressions)) return {
            status: "conflict" as const,
            reason: `normal snapshot ${snapshot} reached the join with incompatible expressions`,
          };
          normal.set(snapshot, expressions);
        }
        const throws = new Map(left.throws);
        for (const [throwPayload, snapshot] of right.throws) {
          const existing = throws.get(throwPayload);
          if (existing !== undefined && existing !== snapshot) return {
            status: "conflict" as const,
            reason: `throw payload ${throwPayload} reached the join with incompatible snapshots`,
          };
          throws.set(throwPayload, snapshot);
        }
        const recurrences = new Map(left.recurrences);
        for (const [identity, incoming] of right.recurrences) {
          const existing = recurrences.get(identity);
          if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(incoming)) return {
            status: "conflict" as const,
            reason: `ranking recurrence ${identity} reached the join with incompatible transformers`,
          };
          recurrences.set(identity, incoming);
        }
        return {
          status: "joined" as const,
          value: value([...normal], [...throws], [...recurrences]),
        };
      },
    },
    blocks: [
      { id: "header", transfer: (input) => [{ to: "entry", value: input }] },
      ...candidate.handler.blocks.map((block) => ({
        id: block.id,
        transfer: (input: HandlerRecurrenceValueState) => {
          if (block.id === "try-completion") {
            const edges: Array<{ to: string; value: HandlerRecurrenceValueState }> = [];
            if (input.throws.size > 0) edges.push({ to: "catch", value: input });
            if (input.normal.size > 0) edges.push({
              to: "handler-join",
              value: value([["try-normal", tryNormal]], [], [...input.recurrences]),
            });
            return edges;
          }
          if (block.id === "catch") return [{
            to: block.edges[0]!.to,
            value: value([["catch-normal", catchNormal]], [], [...input.recurrences]),
          }];
          if (block.id === "handler-join") {
            const normal = new Map(input.normal);
            if (normal.has("try-normal") && normal.has("catch-normal")) normal.set("joined-normal", joinedNormal);
            return block.edges.map((edge) => ({
              to: edge.to, value: value([...normal], [], [...input.recurrences]),
            }));
          }
          if (block.id === "exit") {
            const recurrences = new Map(input.recurrences);
            if (recurrence) recurrences.set(recurrenceKey, recurrence);
            const joined = value([...input.normal], [...input.throws], [...recurrences]);
            return [{ to: "header", value: joined }, { to: "loop-exit", value: joined }];
          }
          return block.edges.map((edge) => {
            if (edge.completion === "throw") return {
              to: edge.to,
              value: value([], [[payload, throwSnapshot]], [...input.recurrences]),
            };
            return { to: edge.to, value: input };
          });
        },
      })),
      { id: "loop-exit", transfer: () => [] },
    ],
  });
  const catchState = result.states.get("catch") ?? value();
  const exitState = result.states.get("loop-exit") ?? value();
  const retainedRecurrence = exitState.recurrences.get(recurrenceKey);
  return {
    iterations: result.iterations,
    converged: result.status === "converged",
    conflict: result.status === "unknown" && result.reason === "lattice-conflict",
    handlerCfg: { reused: true, blocks: candidate.handler.blocks.map((block) => block.id) },
    recurrence: retainedRecurrence
      ? { ...retainedRecurrence, stable: result.status === "converged" }
      : undefined,
    valueLattice: {
      throwPayloads: [...catchState.throws.keys()].sort(),
      normalSnapshots: [...exitState.normal.keys()].filter((snapshot) => snapshot !== "entry").sort(),
      expressionSnapshots: { tryNormal, catchNormal, joinedNormal },
    },
  };
}

interface ScalarRecurrenceCandidate {
  readonly whileStatement: ts.WhileStatement;
  readonly backEdgeStatement: ts.Statement;
  readonly conditionals: readonly {
    readonly statement: ts.IfStatement;
    readonly predicate: string;
    readonly thenBlock: string;
    readonly elseBlock: string;
    readonly join: string;
  }[];
  readonly finiteSwitch?: {
    readonly statement: ts.SwitchStatement;
    readonly discriminant: string;
    readonly cases: readonly [
      { readonly value: string; readonly block: string },
      { readonly value: string; readonly block: string },
    ];
    readonly defaultBlock: string;
    readonly join: string;
  };
  readonly valueJoin?: {
    readonly expression: ts.ConditionalExpression;
    readonly predicate: string;
    readonly thenBlock: string;
    readonly elseBlock: string;
    readonly whenTrue: TemporalExpression;
    readonly whenFalse: TemporalExpression;
    readonly join: string;
  };
}

function findScalarRecurrenceCandidates(body: ts.Block, spec: TemporalSpec): ScalarRecurrenceCandidate[] {
  const candidates: ScalarRecurrenceCandidate[] = [];
  const containsTemporalConditional = (expression: TemporalExpression): boolean => {
    if (expression.kind === "conditional") return true;
    if (expression.kind === "binary") return containsTemporalConditional(expression.left)
      || containsTemporalConditional(expression.right);
    if (expression.kind === "unary") return containsTemporalConditional(expression.operand);
    return false;
  };
  const containsTry = (root: ts.Node): boolean => {
    let found = false;
    const visit = (node: ts.Node): void => {
      if (found || ts.isFunctionLike(node)) return;
      if (ts.isTryStatement(node)) { found = true; return; }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(root, visit);
    return found;
  };
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionLike(node) && node !== body.parent) return;
    if (ts.isWhileStatement(node) && ts.isBlock(node.statement)
      && node.statement.statements.length > 0 && !containsTry(node.statement)) {
      const directIfs = node.statement.statements.filter(ts.isIfStatement);
      const directSwitches = node.statement.statements.filter(ts.isSwitchStatement);
      let totalIfCount = 0;
      let totalSwitchCount = 0;
      const conditionalExpressions: ts.ConditionalExpression[] = [];
      const countLoopIf = (child: ts.Node): void => {
        if (ts.isFunctionLike(child)) return;
        if (ts.isIfStatement(child)) totalIfCount++;
        if (ts.isSwitchStatement(child)) totalSwitchCount++;
        if (ts.isConditionalExpression(child)) conditionalExpressions.push(child);
        ts.forEachChild(child, countLoopIf);
      };
      ts.forEachChild(node.statement, countLoopIf);
      const branchStatement = (statement: ts.Statement): ts.Statement | undefined =>
        ts.isBlock(statement) && statement.statements.length === 1
          ? statement.statements[0] : ts.isBlock(statement) ? undefined : statement;
      const conditionals = directIfs.length >= 1 && directIfs.length <= 2
        && totalIfCount === directIfs.length ? directIfs.flatMap((statement) => {
          const predicate = ts.isPropertyAccessExpression(statement.expression)
            ? statement.expression.name.text : undefined;
          const thenStatement = branchStatement(statement.thenStatement);
          const elseStatement = statement.elseStatement
            ? branchStatement(statement.elseStatement) : undefined;
          return predicate && thenStatement ? [{
            statement,
            predicate,
            thenBlock: `statement:${thenStatement.getStart()}`,
            elseBlock: elseStatement
              ? `statement:${elseStatement.getStart()}`
              : `identity:${statement.getStart()}`,
            join: `if-join:${statement.getStart()}`,
          }] : [];
        }) : [];
      const finiteSwitch = directSwitches.length === 1 && totalSwitchCount === 1 ? (() => {
          const statement = directSwitches[0]!;
          const discriminant = ts.isPropertyAccessExpression(statement.expression)
            ? statement.expression.name.text : undefined;
          const clauses = [...statement.caseBlock.clauses];
          const cases = clauses.filter(ts.isCaseClause);
          const defaults = clauses.filter(ts.isDefaultClause);
          if (!discriminant || clauses.length !== 3 || cases.length !== 2 || defaults.length !== 1) return undefined;
          const branchBlock = (clause: ts.CaseOrDefaultClause): string | undefined => {
            const statements = [...clause.statements];
            if (statements.length < 2) return undefined;
            const terminal = statements.at(-1)!;
            if (!ts.isBreakStatement(terminal) || terminal.label) return undefined;
            if (statements.slice(0, -1).some((child) => ts.isBreakStatement(child)
              || ts.isContinueStatement(child) || ts.isReturnStatement(child)
              || ts.isThrowStatement(child))) return undefined;
            return `${ts.isDefaultClause(clause) ? "default" : "case"}:${statements[0]!.getStart()}`;
          };
          const normalizedCases = cases.map((clause) => {
            if (!ts.isNumericLiteral(clause.expression)) return undefined;
            const numeric = Number(clause.expression.text);
            const block = branchBlock(clause);
            return Number.isSafeInteger(numeric) && block
              ? { value: String(numeric), block } : undefined;
          });
          const defaultBlock = branchBlock(defaults[0]!);
          if (!normalizedCases[0] || !normalizedCases[1] || !defaultBlock
            || normalizedCases[0].value === normalizedCases[1].value) return undefined;
          return {
            statement,
            discriminant,
            cases: [normalizedCases[0], normalizedCases[1]] as const,
            defaultBlock,
            join: `switch-join:${statement.getStart()}`,
          };
        })() : undefined;
      const valueJoin = conditionalExpressions.length === 1 ? (() => {
        const expression = conditionalExpressions[0]!;
        if (!ts.isPropertyAccessExpression(expression.condition)
          || !ts.isIdentifier(expression.condition.expression)) return undefined;
        const receiver = expression.condition.expression.text;
        const predicate = expression.condition.name.text;
        const stateNames = new Set(spec.states.map(({ name }) => name));
        const whenTrue = normalizeRefinementExpression(
          expression.whenTrue, receiver, new Map(), stateNames,
        );
        const whenFalse = normalizeRefinementExpression(
          expression.whenFalse, receiver, new Map(), stateNames,
        );
        if (!whenTrue || !whenFalse || containsTemporalConditional(whenTrue)
          || containsTemporalConditional(whenFalse)) return undefined;
        return {
          expression,
          predicate,
          thenBlock: `expression:${expression.whenTrue.getStart()}`,
          elseBlock: `expression:${expression.whenFalse.getStart()}`,
          whenTrue,
          whenFalse,
          join: `value-join:${expression.getStart()}`,
        };
      })() : undefined;
      candidates.push({
        whileStatement: node,
        backEdgeStatement: node.statement.statements.at(-1)!,
        conditionals: conditionals.length === directIfs.length ? conditionals : [],
        ...(finiteSwitch && conditionals.length === directIfs.length ? { finiteSwitch } : {}),
        ...(valueJoin && directIfs.length === 0 && directSwitches.length === 0
          ? { valueJoin } : {}),
      });
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(body, visit);
  return candidates;
}

function recurrenceEvidenceFromTrace(
  trace: RefinementRankingRecurrenceTrace,
  stable: boolean,
): RefinementRankingRecurrenceEvidence {
  const formatUpdates = (updates: ReadonlyMap<string, TemporalExpression>): Readonly<Record<string, string>> =>
    Object.fromEntries([...updates].map(([name, expression]) => [name, formatRefinementExpression(expression)]));
  return {
    counter: trace.counterName,
    direction: trace.direction,
    delta: trace.counterDelta,
    bound: trace.bound,
    stop: trace.stop,
    guard: formatRefinementExpression(trace.guard),
    iteration: formatUpdates(trace.iterationUpdates),
    summary: formatUpdates(trace.summaryUpdates),
    ...(trace.boundedSelfAffine
      ? { assumptions: [formatRefinementExpression(trace.boundedSelfAffine.precondition.expression)] }
      : {}),
    ...(trace.boundedSelfAffine
      ? { boundedSelfAffine: boundedSelfAffineEvidence(trace.boundedSelfAffine)! } : {}),
    stable,
  };
}

function runScalarRecurrenceFixedPoint(
  candidate: ScalarRecurrenceCandidate,
  source: ts.SourceFile,
  spec: TemporalSpec,
  trace: RefinementRankingRecurrenceTrace | undefined,
  limit: number,
): {
  readonly iterations: number;
  readonly converged: boolean;
  readonly conflict: boolean;
  readonly recurrence?: RefinementRankingRecurrenceEvidence;
  readonly members: readonly { state: string; role: "ranking" | "scalar" }[];
  readonly backEdge: RefinementScalarRecurrenceObligation["backEdge"];
  readonly controlJoins?: RefinementScalarRecurrenceObligation["controlJoins"];
  readonly affineDependencies?: RefinementAffineDependencies;
  readonly booleanInvolutions?: RefinementBooleanInvolutions;
  readonly boundedSelfAffine?: RefinementBoundedSelfAffine;
  readonly unsupportedPiecewise: boolean;
} {
  const header = `while-header:${candidate.whileStatement.getStart(source)}`;
  const back = `statement:${candidate.backEdgeStatement.getStart(source)}`;
  const candidateRecurrence = trace ? recurrenceEvidenceFromTrace(trace, false) : undefined;
  const containsConditional = (expression: TemporalExpression): boolean => {
    if (expression.kind === "conditional") return true;
    if (expression.kind === "binary") return containsConditional(expression.left) || containsConditional(expression.right);
    if (expression.kind === "unary") return containsConditional(expression.operand);
    return false;
  };
  const piecewise = trace ? [...trace.iterationUpdates.values()].some(containsConditional) : false;
  const predicates = new Set([
    ...candidate.conditionals.map(({ predicate }) => predicate),
    ...(candidate.valueJoin ? [candidate.valueJoin.predicate] : []),
  ]);
  const finiteSwitch = candidate.finiteSwitch;
  const switchValues = new Set(finiteSwitch?.cases.map(({ value }) => value) ?? []);
  const joinCount = candidate.conditionals.length + (finiteSwitch ? 1 : 0)
    + (candidate.valueJoin ? 1 : 0);
  const mixedInOrder = candidate.conditionals.length === 1 && finiteSwitch
    ? candidate.conditionals[0]!.statement.getStart(source) < finiteSwitch.statement.getStart(source)
    : true;
  const valueJoinIsolated = !candidate.valueJoin
    || (candidate.conditionals.length === 0 && !finiteSwitch && joinCount === 1);
  const shapeValid = joinCount >= 1 && joinCount <= 2 && mixedInOrder && valueJoinIsolated
    && (candidate.conditionals.length === 0 || predicates.size === candidate.conditionals.length)
    && !(finiteSwitch && candidate.conditionals.length > 1);
  const selectorsStable = !!trace && candidate.conditionals.every(({ predicate }) =>
    spec.states.some(({ name, type }) => name === predicate && type === "bool")
    && predicate !== trace.counterName
    && formatRefinementExpression(trace.iterationUpdates.get(predicate)
      ?? { kind: "name", name: predicate }) === predicate)
    && (!finiteSwitch || (
      spec.states.some(({ name, type }) => name === finiteSwitch.discriminant && type === "int")
      && finiteSwitch.discriminant !== trace.counterName
      && formatRefinementExpression(trace.iterationUpdates.get(finiteSwitch.discriminant)
        ?? { kind: "name", name: finiteSwitch.discriminant }) === finiteSwitch.discriminant
    ))
    && (!candidate.valueJoin || (
      spec.states.some(({ name, type }) => name === candidate.valueJoin!.predicate && type === "bool")
      && candidate.valueJoin.predicate !== trace.counterName
      && formatRefinementExpression(trace.iterationUpdates.get(candidate.valueJoin.predicate)
        ?? { kind: "name", name: candidate.valueJoin.predicate }) === candidate.valueJoin.predicate
    ));
  const usedSelectors = new Set<string>();
  const selectorKey = (expression: TemporalExpression): string | undefined => {
    if (expression.kind === "name" && predicates.has(expression.name)) return `boolean:${expression.name}`;
    if (finiteSwitch && expression.kind === "binary" && expression.operator === "eq"
      && expression.left.kind === "name" && expression.left.name === finiteSwitch.discriminant
      && expression.right.kind === "integer" && switchValues.has(expression.right.value)) {
      return `switch:${finiteSwitch.discriminant}:${expression.right.value}`;
    }
    return undefined;
  };
  const everyConditionalUsesSelectors = (expression: TemporalExpression): boolean => {
    if (expression.kind === "conditional") {
      const key = selectorKey(expression.condition);
      if (!key) return false;
      usedSelectors.add(key);
      return everyConditionalUsesSelectors(expression.whenTrue)
        && everyConditionalUsesSelectors(expression.whenFalse);
    }
    if (expression.kind === "binary") return everyConditionalUsesSelectors(expression.left)
      && everyConditionalUsesSelectors(expression.right);
    if (expression.kind === "unary") return everyConditionalUsesSelectors(expression.operand);
    return true;
  };
  const expressionsValid = !!trace && [...trace.iterationUpdates.values()].every(everyConditionalUsesSelectors);
  const matchesValueJoin = (expression: TemporalExpression): boolean => {
    if (expression.kind === "conditional") {
      const matches = candidate.valueJoin
        && expression.condition.kind === "name"
        && expression.condition.name === candidate.valueJoin.predicate
        && sameRefinementExpression(expression.whenTrue, candidate.valueJoin.whenTrue)
        && sameRefinementExpression(expression.whenFalse, candidate.valueJoin.whenFalse);
      return Boolean(matches) || matchesValueJoin(expression.condition)
        || matchesValueJoin(expression.whenTrue) || matchesValueJoin(expression.whenFalse);
    }
    if (expression.kind === "binary") return matchesValueJoin(expression.left)
      || matchesValueJoin(expression.right);
    if (expression.kind === "unary") return matchesValueJoin(expression.operand);
    return false;
  };
  const valueJoinMatchesTrace = !candidate.valueJoin || Boolean(trace
    && [...trace.iterationUpdates.values()].some(matchesValueJoin));
  const selectorsUsed = candidate.conditionals.every(({ predicate }) => usedSelectors.has(`boolean:${predicate}`))
    && (!finiteSwitch || [...switchValues].every((value) =>
      usedSelectors.has(`switch:${finiteSwitch.discriminant}:${value}`)))
    && (!candidate.valueJoin || usedSelectors.has(`boolean:${candidate.valueJoin.predicate}`));
  const joinsValid = shapeValid && selectorsStable && expressionsValid
    && selectorsUsed && valueJoinMatchesTrace;
  const controlJoins = joinsValid ? [
    ...candidate.conditionals.map((conditional) => ({
      start: conditional.statement.getStart(source),
      evidence: {
        kind: "loop-invariant-cfg-diamond" as const,
        selector: { kind: "boolean-state" as const, state: conditional.predicate },
        rule: "predicate-correlated-affine-phi" as const,
        predecessors: [
          { branch: "then" as const, block: conditional.thenBlock },
          { branch: "else" as const, block: conditional.elseBlock },
        ] as const,
        join: conditional.join,
      },
    })),
    ...(finiteSwitch ? [(() => {
      const [firstCase, secondCase] = finiteSwitch.cases;
      return {
        start: finiteSwitch.statement.getStart(source),
        evidence: {
          kind: "loop-invariant-cfg-switch" as const,
          selector: { kind: "integer-state" as const, state: finiteSwitch.discriminant },
          rule: "finite-literal-affine-phi" as const,
          budget: { name: "cfg-recurrence-switch-cases" as const, limit: 2 as const, observed: 2 as const },
          predecessors: [
            { case: firstCase.value, block: firstCase.block },
            { case: secondCase.value, block: secondCase.block },
            { case: "default" as const, block: finiteSwitch.defaultBlock },
          ] as const,
          join: finiteSwitch.join,
        },
      };
    })()] : []),
    ...(candidate.valueJoin ? [{
      start: candidate.valueJoin.expression.getStart(source),
      evidence: {
        kind: "loop-invariant-cfg-value-join" as const,
        selector: { kind: "boolean-state" as const, state: candidate.valueJoin.predicate },
        rule: "source-bound-predecessor-value-phi" as const,
        budget: { name: "cfg-recurrence-value-joins" as const, limit: 1 as const, observed: 1 as const },
        span: {
          start: candidate.valueJoin.expression.getStart(source),
          end: candidate.valueJoin.expression.getEnd(),
        },
        predecessors: [
          {
            branch: "then" as const,
            block: candidate.valueJoin.thenBlock,
            value: formatRefinementExpression(candidate.valueJoin.whenTrue),
          },
          {
            branch: "else" as const,
            block: candidate.valueJoin.elseBlock,
            value: formatRefinementExpression(candidate.valueJoin.whenFalse),
          },
        ] as const,
        join: candidate.valueJoin.join,
      },
    }] : []),
  ].sort((left, right) => left.start - right.start).map(({ evidence }, order) => ({
    ...evidence,
    order: order === 0 ? 0 as const : 1 as const,
  })) : undefined;
  const changed = candidateRecurrence
    ? spec.states.filter(({ name, type }) => (type === "int" || type === "bool")
      && candidateRecurrence.iteration[name] !== undefined
      && candidateRecurrence.iteration[name] !== name)
    : [];
  const members = changed.map(({ name }) => ({
    state: name,
    role: name === trace?.counterName ? "ranking" as const : "scalar" as const,
  })).sort((left, right) => left.role === right.role ? left.state.localeCompare(right.state)
    : left.role === "ranking" ? -1 : 1);
  interface Value {
    readonly reachable: boolean;
    readonly recurrences: ReadonlyMap<string, RefinementRankingRecurrenceEvidence>;
  }
  const value = (
    reachable = false,
    recurrences: ReadonlyMap<string, RefinementRankingRecurrenceEvidence> = new Map(),
  ): Value => ({ reachable, recurrences });
  const key = (item: Value): string => JSON.stringify({
    reachable: item.reachable,
    recurrences: [...item.recurrences].sort(([left], [right]) => left.localeCompare(right)),
  });
  const recurrenceKey = `${candidate.whileStatement.getStart(source)}:${candidate.whileStatement.getEnd()}`;
  const result = solveBasicBlockFixedPoint<Value>({
    entry: header,
    initial: value(true),
    budget: { name: "cfg-recurrence-iterations", limit },
    lattice: {
      bottom: () => value(),
      equivalent: (left, right) => key(left) === key(right),
      join: (left, right) => {
        if (!left.reachable) return { status: "joined" as const, value: right };
        if (!right.reachable) return { status: "joined" as const, value: left };
        const joined = new Map(left.recurrences);
        for (const [identity, incoming] of right.recurrences) {
          const existing = joined.get(identity);
          if (existing && JSON.stringify(existing) !== JSON.stringify(incoming)) return {
            status: "conflict" as const,
            reason: `recurrence ${identity} reached its back edge with incompatible transformers`,
          };
          joined.set(identity, incoming);
        }
        return { status: "joined" as const, value: value(true, joined) };
      },
    },
    blocks: [
      { id: header, transfer: (input) => [{ to: back, value: input }, { to: "loop-exit", value: input }] },
      { id: back, transfer: (input) => {
        const output = new Map(input.recurrences);
        const memberLimit = trace?.affineDependencies ? 3 : 2;
        if (candidateRecurrence && members.length >= 1 && members.length <= memberLimit) {
          output.set(recurrenceKey, candidateRecurrence);
        }
        return [{ to: header, value: value(input.reachable, output) }];
      } },
      { id: "loop-exit", transfer: () => [] },
    ],
  });
  const retained = result.states.get("loop-exit")?.recurrences.get(recurrenceKey);
  return {
    iterations: result.iterations,
    converged: result.status === "converged",
    conflict: result.status === "unknown" && result.reason === "lattice-conflict",
    ...(retained ? { recurrence: { ...retained, stable: result.status === "converged" } } : {}),
    members,
    backEdge: { from: back, to: header, rule: "source-bound-affine-transformer" },
    ...(controlJoins ? { controlJoins } : {}),
    ...(trace?.affineDependencies ? { affineDependencies: trace.affineDependencies } : {}),
    ...(trace?.booleanInvolutions ? { booleanInvolutions: trace.booleanInvolutions } : {}),
    ...(trace?.boundedSelfAffine ? { boundedSelfAffine: {
      rule: trace.boundedSelfAffine.rule,
      state: trace.boundedSelfAffine.state,
      counter: trace.boundedSelfAffine.counter,
      multiplier: trace.boundedSelfAffine.multiplier,
      precondition: {
        expression: formatRefinementExpression(trace.boundedSelfAffine.precondition.expression),
        span: trace.boundedSelfAffine.precondition.span,
      },
      budget: trace.boundedSelfAffine.budget,
      update: trace.boundedSelfAffine.update,
      ...(trace.boundedSelfAffine.activation
        ? { activation: trace.boundedSelfAffine.activation } : {}),
    } } : {}),
    unsupportedPiecewise: (piecewise || Boolean(candidate.valueJoin)) && !controlJoins,
  };
}

interface HandlerScalarEnvironmentResult {
  readonly iterations: number;
  readonly converged: boolean;
  readonly conflict: boolean;
  readonly members: readonly {
    readonly state: string;
    readonly expected: TemporalExpression;
    readonly actual: TemporalExpression;
    readonly regions: RefinementHandlerScalarEnvironmentObligation["fixedPoint"]["members"][number]["regions"];
  }[];
  readonly predicateCorrelated: boolean;
  readonly conditionalJoin?: RefinementHandlerScalarEnvironmentObligation["conditionalJoin"];
}

const HANDLER_SCALAR_REGION_LIMIT = 3;

/**
 * Carries the evaluator's source-bound region summaries through the same CFG
 * worklist used for completion reachability. Region summaries are admitted
 * only when the environment entering each source-keyed region is exactly the
 * environment emitted by its predecessor; intervening unmodeled writes are a
 * lattice conflict rather than an implicit identity transfer.
 */
function runHandlerScalarEnvironmentFixedPoint(
  candidate: HandlerJoinCandidate,
  traces: readonly RefinementHandlerRegionTrace[],
  spec: TemporalSpec,
  action: TemporalSpec["actions"][number],
  limit: number,
): HandlerScalarEnvironmentResult {
  const stateExpression = (environment: ReadonlyMap<string, TemporalExpression>, name: string): TemporalExpression =>
    environment.get(name) ?? { kind: "name", name };
  const environmentKey = (environment: ReadonlyMap<string, TemporalExpression>): string => JSON.stringify(
    spec.states.map(({ name }) => [name, formatRefinementExpression(stateExpression(environment, name))]),
  );
  const normalizeEnvironment = (environment: ReadonlyMap<string, TemporalExpression>): ReadonlyMap<string, TemporalExpression> =>
    new Map(spec.states.map(({ name }) => [name, stateExpression(environment, name)]));
  const controls = candidate.controlStatements.filter(ts.isTryStatement);
  const byStart = new Map(traces.map((trace) => [trace.tryStart, trace]));
  const conditional = candidate.conditionalHandlerJoin;
  const regionControls = conditional
    ? [conditional.thenRegion, conditional.elseRegion, conditional.successorRegion]
    : controls;
  const regions = regionControls.flatMap((control) => {
    const trace = byStart.get(control.getStart());
    return trace ? [{ control, trace }] : [];
  });
  const runtimeStateExpression = (expression: ts.Expression): TemporalExpression | undefined =>
    ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression)
      && spec.states.some(({ name }) => name === expression.name.text)
      ? { kind: "name", name: expression.name.text }
      : ts.isIdentifier(expression) && spec.states.some(({ name }) => name === expression.text)
        ? { kind: "name", name: expression.text }
        : undefined;
  const firstCondition = (root: ts.Node): TemporalExpression | undefined => {
    let found: TemporalExpression | undefined;
    const visit = (node: ts.Node): void => {
      if (found || ts.isFunctionLike(node)) return;
      if (ts.isIfStatement(node)) {
        found = runtimeStateExpression(node.expression);
        if (found) return;
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(root, visit);
    return found;
  };
  const containsConditionalCondition = (
    expression: TemporalExpression,
    condition: TemporalExpression,
  ): boolean => {
    if (expression.kind === "conditional") return sameRefinementExpression(expression.condition, condition)
      || containsConditionalCondition(expression.condition, condition)
      || containsConditionalCondition(expression.whenTrue, condition)
      || containsConditionalCondition(expression.whenFalse, condition);
    if (expression.kind === "binary") return containsConditionalCondition(expression.left, condition)
      || containsConditionalCondition(expression.right, condition);
    if (expression.kind === "unary") return containsConditionalCondition(expression.operand, condition);
    if (expression.kind === "array") return expression.elements.some((item) => containsConditionalCondition(item, condition));
    if (expression.kind === "record") return Boolean(expression.base && containsConditionalCondition(expression.base, condition))
      || Object.values(expression.fields).some((item) => containsConditionalCondition(item, condition));
    if (expression.kind === "field") return containsConditionalCondition(expression.receiver, condition);
    if (expression.kind === "lambda") return containsConditionalCondition(expression.body, condition);
    if (expression.kind === "call") return expression.arguments.some((item) => containsConditionalCondition(item, condition));
    if (expression.kind === "method") return containsConditionalCondition(expression.receiver, condition)
      || expression.arguments.some((item) => containsConditionalCondition(item, condition));
    return false;
  };
  const hasCorrelatedConditional = (
    expression: TemporalExpression,
    predicate: TemporalExpression,
    thenCondition: TemporalExpression,
    elseCondition: TemporalExpression,
  ): boolean => {
    if (expression.kind === "conditional"
      && sameRefinementExpression(expression.condition, predicate)
      && containsConditionalCondition(expression.whenTrue, thenCondition)
      && containsConditionalCondition(expression.whenFalse, elseCondition)) return true;
    if (expression.kind === "conditional") return hasCorrelatedConditional(expression.condition, predicate, thenCondition, elseCondition)
      || hasCorrelatedConditional(expression.whenTrue, predicate, thenCondition, elseCondition)
      || hasCorrelatedConditional(expression.whenFalse, predicate, thenCondition, elseCondition);
    if (expression.kind === "binary") return hasCorrelatedConditional(expression.left, predicate, thenCondition, elseCondition)
      || hasCorrelatedConditional(expression.right, predicate, thenCondition, elseCondition);
    if (expression.kind === "unary") return hasCorrelatedConditional(expression.operand, predicate, thenCondition, elseCondition);
    return false;
  };
  const predicate = conditional ? runtimeStateExpression(conditional.predicate) : undefined;
  const thenCondition = conditional ? firstCondition(conditional.thenRegion.tryBlock) : undefined;
  const elseCondition = conditional ? firstCondition(conditional.elseRegion.tryBlock) : undefined;
  const predicateCorrelated = !conditional || Boolean(predicate && thenCondition && elseCondition
    && action.assignments.filter(({ target }) => spec.states.some(({ name, type }) => name === target && type === "int"))
      .every(({ expressionAst }) => hasCorrelatedConditional(expressionAst, predicate, thenCondition, elseCondition)));
  const conditionalJoin = conditional && predicate ? {
    kind: "if-handler-predecessors" as const,
    predicate: formatRefinementExpression(predicate),
    rule: "predicate-correlated-phi" as const,
    predecessors: [
      {
        branch: "then" as const,
        regionId: `nested-handler-join:${conditional.thenRegion.getStart()}`,
        span: { start: conditional.thenRegion.getStart(), end: conditional.thenRegion.getEnd() },
      },
      {
        branch: "else" as const,
        regionId: `nested-handler-join:${conditional.elseRegion.getStart()}`,
        span: { start: conditional.elseRegion.getStart(), end: conditional.elseRegion.getEnd() },
      },
    ],
    successorRegionId: `nested-handler-join:${conditional.successorRegion.getStart()}`,
  } : undefined;
  const changedScalarStates = spec.states.filter(({ name, type }) => type === "int"
    && regions.length > 0
    && !sameRefinementExpression(
      stateExpression(regions[0]!.trace.entry, name),
      stateExpression(regions.at(-1)!.trace.exit, name),
    ));
  const members = changedScalarStates
    .map(({ name: state }) => ({
      state,
      expected: action.assignments.find(({ target }) => target === state)?.expressionAst
        ?? { kind: "name", name: state } as TemporalExpression,
      actual: regions.length > 0
        ? stateExpression(regions.at(-1)!.trace.exit, state)
        : { kind: "name", name: state } as TemporalExpression,
      regions: regions.map(({ trace }) => ({
        id: `nested-handler-join:${trace.tryStart}`,
        span: { start: trace.tryStart, end: trace.tryEnd },
        entry: formatRefinementExpression(stateExpression(trace.entry, state)),
        exit: formatRefinementExpression(stateExpression(trace.exit, state)),
      })),
    }))
    .sort((left, right) => left.state.localeCompare(right.state));
  if (candidate.lowering !== "supported" || regionControls.length < 2
    || regionControls.length > HANDLER_SCALAR_REGION_LIMIT || regions.length !== regionControls.length
    || members.length < 1 || members.length > 2) {
    return { iterations: 0, converged: false, conflict: false, members, predicateCorrelated, conditionalJoin };
  }

  interface Value {
    readonly environment: ReadonlyMap<string, TemporalExpression>;
    readonly invalid: boolean;
    readonly reachable: boolean;
    readonly branch?: "then" | "else" | "joined";
  }
  const value = (
    environment: ReadonlyMap<string, TemporalExpression>,
    invalid = false,
    reachable = true,
    branch?: Value["branch"],
  ): Value => ({
    environment: normalizeEnvironment(environment), invalid, reachable, ...(branch ? { branch } : {}),
  });
  const equivalent = (left: Value, right: Value): boolean => left.reachable === right.reachable
    && left.invalid === right.invalid
    && left.branch === right.branch
    && environmentKey(left.environment) === environmentKey(right.environment);
  const result = solveBasicBlockFixedPoint<Value>({
    entry: "entry",
    initial: value(new Map()),
    budget: { name: "cfg-fixed-point-iterations", limit },
    lattice: {
      bottom: () => value(new Map(), false, false),
      equivalent,
      join: (left, right) => !left.reachable ? { status: "joined", value: right }
        : !right.reachable ? { status: "joined", value: left }
        : left.invalid || right.invalid
        ? { status: "conflict", reason: "a source-keyed region received an invalid scalar environment" }
        : conditional && predicate && predicateCorrelated
          && ((left.branch === "then" && right.branch === "else")
            || (left.branch === "else" && right.branch === "then"))
          ? { status: "joined", value: value(joinFlowValues({
              keys: spec.states.map(({ name }) => name),
              condition: predicate,
              original: (name) => ({ kind: "name", name }) as TemporalExpression,
              whenTrue: (name) => stateExpression(
                left.branch === "then" ? left.environment : right.environment,
                name,
              ),
              whenFalse: (name) => stateExpression(
                left.branch === "else" ? left.environment : right.environment,
                name,
              ),
              equivalent: sameRefinementExpression,
              phi: (condition, whenTrue, whenFalse): TemporalExpression => ({
                kind: "conditional", condition, whenTrue, whenFalse,
              }),
            }), false, true, "joined") }
        : environmentKey(left.environment) !== environmentKey(right.environment)
          ? { status: "conflict", reason: "scalar expressions disagree at a source-keyed CFG join" }
          : { status: "joined", value: left },
    },
    blocks: candidate.blocks.map((block) => ({
      id: block.id,
      transfer: (input: Value) => {
        const tryMatch = /^try:(\d+)$/.exec(block.id);
        const joinMatch = /^nested-handler-join:(\d+)$/.exec(block.id);
        let output = input;
        if (conditional && block.id === `if:${conditional.ifStatement.getStart()}`) {
          return block.edges.map((edge, index) => ({
            to: edge.to,
            value: value(input.environment, input.invalid, input.reachable, index === 0 ? "then" : "else"),
          }));
        }
        if (tryMatch) {
          const trace = byStart.get(Number(tryMatch[1]));
          if (trace && environmentKey(input.environment) !== environmentKey(normalizeEnvironment(trace.entry))) {
            output = value(input.environment, true, input.reachable, input.branch);
          }
        }
        if (joinMatch) {
          const trace = byStart.get(Number(joinMatch[1]));
          if (trace) output = value(trace.exit, output.invalid, output.reachable, output.branch);
        }
        return block.edges.map((edge) => ({ to: edge.to, value: output }));
      },
    })),
  });
  const exit = result.states.get("exit");
  const conflict = result.status === "unknown" && result.reason === "lattice-conflict"
    || [...result.states.values()].some((item) => item.invalid);
  return {
    iterations: result.iterations,
    converged: result.status === "converged" && !conflict,
    conflict,
    members: members.map((member) => ({
      ...member,
      actual: exit ? stateExpression(exit.environment, member.state) : member.actual,
    })),
    predicateCorrelated,
    conditionalJoin,
  };
}

/**
 * Returns diagnostics together with explicit proof-budget evidence for the
 * first reusable ranking-loop CFG fixed-point fragment. Unsupported bodies and
 * exhausted budgets remain machine-readable non-proofs.
 */
export function analyzeRefinementActionBodies(
  fileName: string,
  text: string,
  adapterName: string,
  spec: TemporalSpec,
  options: RefinementActionAnalysisOptions = {},
): RefinementActionAnalysis {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const manifest = buildRefinementBindingManifest(fileName, text, adapterName);
  const functions = new Map(source.statements.filter(ts.isFunctionDeclaration)
    .flatMap((node) => node.name ? [[node.name.text, node] as const] : []));
  const limit = options.proofBudget?.cfgFixedPointIterations
    ?? DEFAULT_REFINEMENT_ACTION_PROOF_BUDGET.cfgFixedPointIterations;
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new Error(`cfgFixedPointIterations must be a positive safe integer; received ${String(limit)}`);
  }
  const traceSink: RefinementActionTraceSink = {
    tryCatchJoins: [], rankingRecurrences: [], handlerValueJoins: [], handlerRegions: [], aliasRegions: [],
  };
  const diagnostics = validateRefinementActionBodiesInSource(
    source, text, adapterName, spec, undefined, undefined, {}, traceSink,
  );
  const obligations: RefinementActionObligation[] = [];
  for (const action of spec.actions) {
    const exportName = manifest.actions[action.name];
    const implementation = exportName ? functions.get(exportName) : undefined;
    if (!exportName || !implementation?.body) continue;
    for (const candidate of findHandlerJoinCandidates(implementation.body)) {
      const fixedPoint = runHandlerJoinFixedPoint(candidate, limit);
      const actionDiagnostics = diagnostics.filter((diagnostic) => diagnostic.modelName === action.name);
      const pathCorrelation = traceSink.handlerValueJoins.find((item) => item.modelName === action.name);
      const verified = candidate.lowering === "supported" && fixedPoint.converged && actionDiagnostics.length === 0;
      obligations.push({
        kind: "handler-join-fixed-point",
        adapterName,
        modelName: action.name,
        exportName,
        trySpan: {
          start: candidate.tryStatement.getStart(source),
          end: candidate.tryStatement.getEnd(),
        },
        controlSpan: {
          start: candidate.controlStatement.getStart(source),
          end: candidate.controlStatement.getEnd(),
        },
        controlShape: candidate.controlShape,
        controlRoots: candidate.controlStatements.map((statement) => ({
          span: { start: statement.getStart(source), end: statement.getEnd() },
          shape: ts.isIfStatement(statement) ? "if" as const
            : ts.isSwitchStatement(statement) ? "switch" as const
            : ts.isForOfStatement(statement) ? "for-of" as const : "try" as const,
        })),
        controlRootBudget: {
          name: "handler-control-roots",
          limit: candidate.controlShape === "try"
            ? HANDLER_NESTED_TRY_ROOT_LIMIT
            : HANDLER_CONTROL_ROOT_LIMIT,
          observed: candidate.controlStatements.length,
        },
        ...(candidate.finiteLoop ? { finiteLoopBudget: {
          name: "handler-loop-iterations" as const,
          limit: 4 as const,
          observed: candidate.finiteLoop.iterations,
        } } : {}),
        ...(candidate.handlerNesting !== undefined ? { handlerNestingBudget: {
          name: "handler-nesting-depth" as const,
          limit: 2 as const,
          observed: candidate.handlerNesting,
        } } : {}),
        controlRegion: candidate.controlRegion,
        status: verified ? "verified" : "unknown",
        ...(candidate.lowering === "unsupported"
          ? { reason: "unsupported-control-flow" as const }
          : !fixedPoint.converged
          ? { reason: "proof-budget-exhausted" as const }
          : actionDiagnostics.length > 0 ? { reason: "action-validation-failed" as const } : {}),
        budget: { name: "cfg-fixed-point-iterations", limit },
        fixedPoint: {
          iterations: fixedPoint.iterations,
          converged: fixedPoint.converged,
          blockCompletions: fixedPoint.blockCompletions,
        },
        completionJoin: {
          incoming: fixedPoint.incoming,
          outgoing: fixedPoint.outgoing,
          caughtThrow: candidate.catchesThrow && fixedPoint.incoming.includes("throw"),
          mandatoryFinally: candidate.mandatoryFinally,
          finallyOverrides: candidate.finallyOverrides,
        },
        ...(pathCorrelation ? { pathCorrelation: {
          caughtWhen: formatRefinementExpression(pathCorrelation.condition),
          rule: "same-predicate-branch-restriction" as const,
        } } : {}),
      });
      if (candidate.controlShape === "try" || candidate.conditionalHandlerJoin) {
        const regionTraces = traceSink.handlerRegions.filter((trace) => trace.modelName === action.name);
        const scalar = runHandlerScalarEnvironmentFixedPoint(candidate, regionTraces, spec, action, limit);
        const observed = candidate.conditionalHandlerJoin
          ? 3
          : candidate.controlStatements.filter(ts.isTryStatement).length;
        if (scalar.members.length > 0) obligations.push({
          kind: "handler-scalar-environment-join",
          adapterName,
          modelName: action.name,
          exportName,
          status: "unknown",
          reason: !scalar.predicateCorrelated
            ? "predicate-correlation-lost"
            : observed > HANDLER_SCALAR_REGION_LIMIT
            ? "region-budget-exhausted"
            : scalar.members.length > 2
              ? "scalar-cardinality-unsupported"
            : scalar.conflict
              ? "lattice-conflict"
              : !scalar.converged
                ? "proof-budget-exhausted"
                : "independent-proof-required",
          budget: { name: "cfg-fixed-point-iterations", limit },
          regionBudget: { name: "handler-scalar-regions", limit: HANDLER_SCALAR_REGION_LIMIT, observed },
          fixedPoint: {
            iterations: scalar.iterations,
            converged: scalar.converged,
            members: scalar.members.map((member) => ({
              state: member.state,
              expected: formatRefinementExpression(member.expected),
              actual: formatRefinementExpression(member.actual),
              regions: member.regions,
            })),
          },
          ...(scalar.conditionalJoin ? { conditionalJoin: scalar.conditionalJoin } : {}),
        });
      }
      if ((!fixedPoint.converged || candidate.lowering === "unsupported")
        && !actionDiagnostics.some((diagnostic) => diagnostic.code === "unsupported-action-body")) {
        diagnostics.push({
          code: "unsupported-action-body",
          adapterName,
          modelName: action.name,
          exportName,
          message: candidate.lowering === "unsupported"
            ? `${exportName} contains handler control outside the reusable CFG fragment`
            : `${exportName} exceeded the cfg-fixed-point-iterations proof budget (${limit})`,
        });
      }
    }
    const candidates = findRankingLoopThrowJoinCandidates(implementation.body);
    for (const _candidate of candidates) {
      const trace = traceSink.tryCatchJoins.find((item) =>
        item.modelName === action.name && item.tryStart === _candidate.tryStatement.getStart(source));
      const recurrenceTrace = traceSink.rankingRecurrences.find((item) =>
        item.modelName === action.name && item.loopStart === _candidate.whileStatement.getStart(source));
      const fixedPoint = runHandlerBackedScalarRecurrenceFixedPoint(_candidate, source, limit, trace, recurrenceTrace);
      const actionDiagnostics = diagnostics.filter((diagnostic) => diagnostic.modelName === action.name);
      const actionUnsupported = actionDiagnostics.some((diagnostic) => diagnostic.code === "unsupported-action-body");
      const retainedThrowPayload = fixedPoint.valueLattice.throwPayloads.length === 1;
      const retainedNormalSnapshot = fixedPoint.valueLattice.normalSnapshots.includes("try-normal")
        && fixedPoint.valueLattice.normalSnapshots.includes("catch-normal")
        && fixedPoint.valueLattice.normalSnapshots.includes("joined-normal");
      const structurallySupported = fixedPoint.converged && !fixedPoint.conflict
        && fixedPoint.recurrence?.stable === true
        && retainedThrowPayload && retainedNormalSnapshot && actionDiagnostics.length === 0;
      const members = fixedPoint.recurrence ? spec.states.filter(({ name, type }) =>
        type === "int" && fixedPoint.recurrence!.iteration[name] !== undefined
          && fixedPoint.recurrence!.iteration[name] !== name).map(({ name }) => ({
            state: name,
            role: name === fixedPoint.recurrence!.counter ? "ranking" as const : "scalar" as const,
          })).sort((left, right) => left.role === right.role ? left.state.localeCompare(right.state)
            : left.role === "ranking" ? -1 : 1) : [];
      obligations.push({
        kind: "scalar-recurrence-fixed-point",
        adapterName,
        modelName: action.name,
        exportName,
        loopSpan: {
          start: _candidate.whileStatement.getStart(source),
          end: _candidate.whileStatement.getEnd(),
        },
        status: "unknown",
        ...(fixedPoint.conflict
          ? { reason: "lattice-conflict" as const }
          : !fixedPoint.converged
          ? { reason: "proof-budget-exhausted" as const }
          : actionUnsupported ? { reason: "unsupported-recurrence" as const }
            : actionDiagnostics.length > 0 ? { reason: "action-validation-failed" as const }
              : !structurallySupported || members.length < 1 || members.length > 8
                ? { reason: "unsupported-recurrence" as const }
                : { reason: "independent-proof-required" as const }),
        budget: { name: "cfg-recurrence-iterations", limit },
        backEdge: {
          from: `try:${_candidate.tryStatement.getStart(source)}`,
          to: `while-header:${_candidate.whileStatement.getStart(source)}`,
          rule: "source-bound-affine-transformer",
        },
        memberBudget: { name: "cfg-recurrence-members", limit: 8, observed: members.length },
        ...(recurrenceTrace?.boundedSelfAffine
          ? { boundedSelfAffine: boundedSelfAffineEvidence(recurrenceTrace.boundedSelfAffine)! }
          : {}),
        fixedPoint: {
          iterations: fixedPoint.iterations,
          converged: fixedPoint.converged,
          ...(fixedPoint.recurrence ? { recurrence: fixedPoint.recurrence } : {}),
          members,
        },
        handlerCompletion: {
          rule: "source-bound-handler-predecessors",
          trySpan: {
            start: _candidate.tryStatement.getStart(source),
            end: _candidate.tryStatement.getEnd(),
          },
          predecessors: ["normal", "throw"],
          retainedThrowPayload: structurallySupported && retainedThrowPayload,
          retainedNormalSnapshot: structurallySupported && retainedNormalSnapshot,
          mandatoryFinally: _candidate.handler.mandatoryFinally,
          blocks: fixedPoint.handlerCfg.blocks,
          valueLattice: fixedPoint.valueLattice,
        },
      });
      if (!fixedPoint.converged && !actionUnsupported) diagnostics.push({
        code: "unsupported-action-body",
        adapterName,
        modelName: action.name,
        exportName,
        message: `${exportName} exceeded the cfg-recurrence-iterations proof budget (${limit})`,
      });
    }
    for (const candidate of findScalarRecurrenceCandidates(implementation.body, spec)) {
      const trace = traceSink.rankingRecurrences.find((item) =>
        item.modelName === action.name && item.loopStart === candidate.whileStatement.getStart(source));
      const fixedPoint = runScalarRecurrenceFixedPoint(candidate, source, spec, trace, limit);
      const actionDiagnostics = diagnostics.filter((diagnostic) => diagnostic.modelName === action.name);
      const supported = Boolean(trace && fixedPoint.recurrence
        && fixedPoint.members.length >= 1
        && fixedPoint.members.length <= (fixedPoint.affineDependencies ? 3 : 2)
        && !fixedPoint.unsupportedPiecewise);
      obligations.push({
        kind: "scalar-recurrence-fixed-point",
        adapterName,
        modelName: action.name,
        exportName,
        loopSpan: {
          start: candidate.whileStatement.getStart(source),
          end: candidate.whileStatement.getEnd(),
        },
        status: "unknown",
        reason: fixedPoint.conflict
          ? "lattice-conflict"
          : !fixedPoint.converged
            ? "proof-budget-exhausted"
            : !supported
              ? "unsupported-recurrence"
              : actionDiagnostics.length > 0
                ? "action-validation-failed"
                : "independent-proof-required",
        budget: { name: "cfg-recurrence-iterations", limit },
        backEdge: fixedPoint.backEdge,
        memberBudget: {
          name: "cfg-recurrence-members",
          limit: fixedPoint.affineDependencies ? 3 : 2,
          observed: fixedPoint.members.length,
        },
        ...(fixedPoint.controlJoins ? { controlJoins: fixedPoint.controlJoins } : {}),
        ...(fixedPoint.affineDependencies ? { affineDependencies: fixedPoint.affineDependencies } : {}),
        ...(fixedPoint.booleanInvolutions ? { booleanInvolutions: fixedPoint.booleanInvolutions } : {}),
        ...(fixedPoint.boundedSelfAffine ? { boundedSelfAffine: fixedPoint.boundedSelfAffine } : {}),
        fixedPoint: {
          iterations: fixedPoint.iterations,
          converged: fixedPoint.converged,
          ...(fixedPoint.recurrence ? { recurrence: fixedPoint.recurrence } : {}),
          members: fixedPoint.members,
        },
      });
      if ((!supported || !fixedPoint.converged || fixedPoint.conflict)
        && !actionDiagnostics.some((diagnostic) => diagnostic.code === "unsupported-action-body")) {
        diagnostics.push({
          code: "unsupported-action-body",
          adapterName,
          modelName: action.name,
          exportName,
          message: !fixedPoint.converged
            ? `${exportName} exceeded the cfg-recurrence-iterations proof budget (${limit})`
            : `${exportName} does not admit a bounded affine CFG recurrence`,
        });
      }
    }
  }
  return {
    schema: "uneffect-refinement-action-analysis/v2",
    schemaVersion: 2,
    fileName,
    adapterName,
    sourceDigest: createHash("sha256").update(text).digest("hex"),
    typescriptVersion: ts.version,
    diagnostics,
    obligations,
  };
}

/**
 * Adds TypeChecker-backed evidence for the deliberately bounded local mutable
 * object alias fragment. Syntax-only analysis never emits this obligation.
 */
export function analyzeRefinementActionBodiesInProgram(
  program: ts.Program,
  fileName: string,
  adapterName: string,
  spec: TemporalSpec,
  options: RefinementActionAnalysisOptions = {},
): RefinementActionAnalysis {
  const source = program.getSourceFile(fileName);
  if (!source) throw new Error(`TypeScript program does not contain refinement source ${fileName}`);
  const traceSink: RefinementActionTraceSink = {
    tryCatchJoins: [], rankingRecurrences: [], handlerValueJoins: [], handlerRegions: [], aliasRegions: [],
  };
  const diagnostics = validateRefinementActionBodiesInSource(
    source, source.text, adapterName, spec, program.getTypeChecker(), program, {}, traceSink,
  );
  const base = analyzeRefinementActionBodies(fileName, source.text, adapterName, spec, options);
  const manifest = buildRefinementBindingManifest(fileName, source.text, adapterName);
  const invalidModels = new Set(diagnostics.map(({ modelName }) => modelName));
  const aliasObligations: RefinementLocalAliasHelperObligation[] = traceSink.aliasRegions
    .filter(({ modelName }) => !invalidModels.has(modelName))
    .map((trace) => ({
      kind: "local-alias-helper",
      adapterName,
      modelName: trace.modelName,
      exportName: manifest.actions[trace.modelName]!,
      status: "verified",
      evidence: "typescript-program",
      alias: {
        name: trace.aliasName,
        mutableObject: true,
        binding: "const",
        span: trace.aliasSpan,
        regionId: `alias-region:${createHash("sha256")
          .update(`${fileName}:${trace.aliasSpan.start}:${trace.aliasSpan.end}`)
          .digest("hex").slice(0, 16)}`,
      },
      helper: {
        name: trace.helperName,
        callSpan: trace.helperCallSpan,
        declarationSpan: trace.helperDeclarationSpan,
        declarationFile: trace.helperDeclarationFile,
        symbolIdentity: trace.helperSymbolIdentity,
      },
      capabilityCorrelation: {
        aliasRegion: trace.aliasName,
        declaration: trace.capabilityDeclaration,
        rule: "source-correlated-not-equivalent",
      },
    }));
  return {
    ...base,
    diagnostics,
    obligations: [...base.obligations, ...aliasObligations],
  };
}

export interface RefinementRecurrenceProofCheck {
  kind: "base" | "step" | "ranking";
  state: string;
  status: "verified" | "refuted" | "unknown";
  reason?: string;
}

export interface RefinementRecurrenceProof {
  backend: "z3";
  status: "verified" | "refuted" | "unknown";
  checks: readonly RefinementRecurrenceProofCheck[];
  assumptions?: readonly string[];
}

function substituteRefinementState(
  expression: TemporalExpression,
  updates: ReadonlyMap<string, TemporalExpression>,
): TemporalExpression {
  if (expression.kind === "name") return updates.get(expression.name) ?? expression;
  if (expression.kind === "integer" || expression.kind === "boolean" || expression.kind === "string") return expression;
  if (expression.kind === "unary") return {
    ...expression, operand: substituteRefinementState(expression.operand, updates),
  };
  if (expression.kind === "binary") return {
    ...expression,
    left: substituteRefinementState(expression.left, updates),
    right: substituteRefinementState(expression.right, updates),
  };
  if (expression.kind === "conditional") return {
    ...expression,
    condition: substituteRefinementState(expression.condition, updates),
    whenTrue: substituteRefinementState(expression.whenTrue, updates),
    whenFalse: substituteRefinementState(expression.whenFalse, updates),
  };
  if (expression.kind === "array") return {
    ...expression, elements: expression.elements.map((item) => substituteRefinementState(item, updates)),
  };
  if (expression.kind === "record") return {
    ...expression,
    ...(expression.base ? { base: substituteRefinementState(expression.base, updates) } : {}),
    fields: Object.fromEntries(Object.entries(expression.fields)
      .map(([name, value]) => [name, substituteRefinementState(value, updates)])),
  };
  if (expression.kind === "field") return {
    ...expression, receiver: substituteRefinementState(expression.receiver, updates),
  };
  if (expression.kind === "lambda") return updates.has(expression.parameter) ? expression : {
    ...expression, body: substituteRefinementState(expression.body, updates),
  };
  if (expression.kind === "call") return {
    ...expression, arguments: expression.arguments.map((item) => substituteRefinementState(item, updates)),
  };
  return {
    ...expression,
    receiver: substituteRefinementState(expression.receiver, updates),
    arguments: expression.arguments.map((item) => substituteRefinementState(item, updates)),
  };
}

/**
 * Independently checks an emitted affine recurrence certificate. Base and step
 * obligations establish that the summary is an inductive solution; the
 * ranking obligation establishes a well-founded distance to the guard's stop.
 */
export async function verifyRefinementRecurrenceCertificateWithZ3(
  spec: TemporalSpec,
  certificate: RefinementRankingRecurrenceEvidence,
  options: Z3ExecutionOptions = {},
): Promise<RefinementRecurrenceProof> {
  if (!certificate.stable) return {
    backend: "z3", status: "unknown",
    checks: [{
      kind: "ranking", state: certificate.counter, status: "unknown", reason: "worklist-not-converged",
    }],
  };
  const checks: RefinementRecurrenceProofCheck[] = [];
  let assumptions: TemporalExpression[] = [];
  const record = async (
    kind: RefinementRecurrenceProofCheck["kind"],
    state: string,
    left: TemporalExpression,
    right: TemporalExpression,
  ): Promise<void> => {
    const result = await checkTemporalExpressionEquivalenceUnderAssumptionsWithZ3(
      spec, left, right, assumptions, options,
    );
    checks.push(result.status === "equivalent"
      ? { kind, state, status: "verified" }
      : result.status === "different"
        ? { kind, state, status: "refuted" }
        : { kind, state, status: "unknown", reason: result.reason });
  };
  try {
    assumptions = (certificate.assumptions ?? []).map(parseTemporalExpression);
    const stateTypes = new Map(spec.states.map((state) => [state.name, state.type]));
    const guard = parseTemporalExpression(certificate.guard);
    const iterations = new Map(Object.entries(certificate.iteration)
      .map(([name, expression]) => [name, parseTemporalExpression(expression)]));
    const summaries = new Map(Object.entries(certificate.summary)
      .map(([name, expression]) => [name, parseTemporalExpression(expression)]));
    if (!stateTypes.has(certificate.counter)
      || stateTypes.get(certificate.counter) !== "int"
      || !iterations.has(certificate.counter)
      || Object.keys(certificate.iteration).some((name) => !stateTypes.has(name))
      || Object.keys(certificate.summary).some((name) => !stateTypes.has(name))) {
      return {
        backend: "z3", status: "unknown",
        checks: [{ kind: "ranking", state: certificate.counter, status: "unknown", reason: "certificate-state-domain-mismatch" }],
      };
    }
    const signedInteger = (expression: TemporalExpression): number | undefined => {
      if (expression.kind === "integer") {
        const value = Number(expression.value);
        return Number.isSafeInteger(value) ? value : undefined;
      }
      if (expression.kind === "unary" && expression.operator === "negate" && expression.operand.kind === "integer") {
        const value = -Number(expression.operand.value);
        return Number.isSafeInteger(value) ? value : undefined;
      }
      return undefined;
    };
    const bounded = certificate.boundedSelfAffine;
    const boundedMetadataMismatch = (): RefinementRecurrenceProof => ({
      backend: "z3",
      status: "refuted",
      checks: [{
        kind: "step",
        state: bounded?.state ?? certificate.counter,
        status: "refuted",
        reason: "bounded-self-affine-metadata-mismatch",
      }],
      ...(certificate.assumptions?.length ? { assumptions: certificate.assumptions } : {}),
    });
    if ((certificate.assumptions?.length ?? 0) > 0 && !bounded) {
      return boundedMetadataMismatch();
    }
    if (bounded) {
      const assumption = assumptions.length === 1 ? assumptions[0] : undefined;
      const upper = assumption?.kind === "binary" && assumption.operator === "and"
        ? assumption.right : undefined;
      const lower = assumption?.kind === "binary" && assumption.operator === "and"
        ? assumption.left : undefined;
      const observed = upper?.kind === "binary" ? signedInteger(upper.right) : undefined;
      const iteration = iterations.get(bounded.state);
      const iterationForm = iteration ? decomposeAffineStateExpression(iteration) : undefined;
      const branchMultiplier = (branch: TemporalExpression | undefined): number | undefined => {
        const form = branch ? decomposeAffineStateExpression(branch) : undefined;
        return form?.constant === 0 && form.coefficients.size === 1
          ? form.coefficients.get(bounded.state) : undefined;
      };
      const branchIdentity = (branch: TemporalExpression | undefined): boolean => !!branch
        && sameRefinementExpression(branch, { kind: "name", name: bounded.state });
      const activation = bounded.activation;
      const guardedIterationMatches = !!activation
        && bounded.rule === "precondition-bounded-guarded-self-affine"
        && activation.predecessor === "catch"
        && stateTypes.get(activation.selector) === "bool"
        && iteration?.kind === "conditional"
        && iteration.condition.kind === "name"
        && iteration.condition.name === activation.selector
        && (activation.when
          ? branchMultiplier(iteration.whenTrue) === bounded.multiplier && branchIdentity(iteration.whenFalse)
          : branchIdentity(iteration.whenTrue) && branchMultiplier(iteration.whenFalse) === bounded.multiplier)
        && sameRefinementExpression(
          iterations.get(activation.selector) ?? { kind: "name", name: activation.selector },
          { kind: "name", name: activation.selector },
        );
      const directIterationMatches = !activation
        && bounded.rule === "precondition-bounded-self-affine"
        && iterationForm?.constant === 0
        && iterationForm.coefficients.size === 1
        && iterationForm.coefficients.get(bounded.state) === bounded.multiplier;
      const expectedPrecondition = assumption ? formatRefinementExpression(assumption) : undefined;
      const metadataMatches = bounded.counter === certificate.counter
        && bounded.state !== bounded.counter
        && stateTypes.get(bounded.state) === "int"
        && bounded.update.state === bounded.state
        && bounded.budget.name === "cfg-recurrence-geometric-iterations"
        && bounded.budget.limit === MAX_BOUNDED_GEOMETRIC_ITERATIONS
        && Number.isSafeInteger(bounded.budget.observed)
        && bounded.budget.observed >= 1
        && bounded.budget.observed <= MAX_BOUNDED_GEOMETRIC_ITERATIONS
        && Number.isSafeInteger(bounded.multiplier)
        && bounded.multiplier > 1
        && Number.isSafeInteger(bounded.multiplier ** bounded.budget.observed)
        && certificate.assumptions?.length === 1
        && certificate.assumptions[0] === bounded.precondition.expression
        && expectedPrecondition === bounded.precondition.expression
        && lower?.kind === "binary" && lower.operator === "gte"
        && lower.left.kind === "name" && lower.left.name === bounded.counter
        && signedInteger(lower.right) === 0
        && upper?.kind === "binary" && upper.operator === "lte"
        && upper.left.kind === "name" && upper.left.name === bounded.counter
        && observed === bounded.budget.observed
        && (directIterationMatches || guardedIterationMatches);
      if (!metadataMatches) return boundedMetadataMismatch();
    }
    const guardBound = guard.kind === "binary" ? signedInteger(guard.right) : undefined;
    const guardDirection = guard.kind === "binary" && (guard.operator === "gt" || guard.operator === "gte")
      ? "decrease" : guard.kind === "binary" && (guard.operator === "lt" || guard.operator === "lte")
        ? "increase" : undefined;
    const guardInclusive = guard.kind === "binary" && (guard.operator === "gte" || guard.operator === "lte");
    const expectedStop = guardBound === undefined || !guardDirection ? undefined
      : guardInclusive ? guardBound + (guardDirection === "decrease" ? -1 : 1) : guardBound;
    const counterForm = decomposeAffineStateExpression(iterations.get(certificate.counter)!);
    const rankingMetadataMatches = guard.kind === "binary"
      && guard.left.kind === "name" && guard.left.name === certificate.counter
      && guardDirection === certificate.direction
      && guardBound === certificate.bound
      && expectedStop === certificate.stop
      && counterForm?.coefficients.size === 1
      && counterForm.coefficients.get(certificate.counter) === 1
      && counterForm.constant === certificate.delta
      && (certificate.direction === "decrease" ? certificate.delta < 0 : certificate.delta > 0);
    if (!rankingMetadataMatches) return {
      backend: "z3", status: "refuted",
      checks: [{
        kind: "ranking", state: certificate.counter, status: "refuted", reason: "ranking-metadata-mismatch",
      }],
    };
    for (const state of spec.states) {
      const original: TemporalExpression = { kind: "name", name: state.name };
      const summary = summaries.get(state.name) ?? original;
      const baseLeft: TemporalExpression = {
        kind: "conditional", condition: guard, whenTrue: original, whenFalse: summary,
      };
      await record("base", state.name, baseLeft, original);
      const steppedSummary = substituteRefinementState(summary, iterations);
      await record("step", state.name, {
        kind: "conditional", condition: guard, whenTrue: summary, whenFalse: original,
      }, {
        kind: "conditional", condition: guard, whenTrue: steppedSummary, whenFalse: original,
      });
    }
    const counter: TemporalExpression = { kind: "name", name: certificate.counter };
    const nextCounter = iterations.get(certificate.counter)!;
    const stop: TemporalExpression = certificate.stop >= 0
      ? { kind: "integer", value: String(certificate.stop) }
      : { kind: "unary", operator: "negate", operand: { kind: "integer", value: String(-certificate.stop) } };
    const measure = (value: TemporalExpression): TemporalExpression => ({
      kind: "binary", operator: "subtract",
      left: certificate.direction === "decrease" ? value : stop,
      right: certificate.direction === "decrease" ? stop : value,
    });
    const currentMeasure = measure(counter);
    const nextMeasure = measure(nextCounter);
    const nextGuard = substituteRefinementState(guard, iterations);
    const positive: TemporalExpression = {
      kind: "binary", operator: "gt", left: currentMeasure, right: { kind: "integer", value: "0" },
    };
    const decreasesIfContinuing: TemporalExpression = {
      kind: "conditional", condition: nextGuard,
      whenTrue: {
        kind: "binary", operator: "and",
        left: { kind: "binary", operator: "gt", left: nextMeasure, right: { kind: "integer", value: "0" } },
        right: { kind: "binary", operator: "lt", left: nextMeasure, right: currentMeasure },
      },
      whenFalse: { kind: "boolean", value: true },
    };
    await record("ranking", certificate.counter, {
      kind: "conditional", condition: guard,
      whenTrue: { kind: "binary", operator: "and", left: positive, right: decreasesIfContinuing },
      whenFalse: { kind: "boolean", value: true },
    }, { kind: "boolean", value: true });
  } catch (cause) {
    return {
      backend: "z3", status: "unknown",
      checks: [{
        kind: "ranking", state: certificate.counter, status: "unknown",
        reason: cause instanceof Error ? cause.message : String(cause),
      }],
    };
  }
  return {
    backend: "z3",
    status: checks.some((check) => check.status === "refuted") ? "refuted"
      : checks.some((check) => check.status === "unknown") ? "unknown" : "verified",
    checks,
    ...(certificate.assumptions?.length ? { assumptions: certificate.assumptions } : {}),
  };
}

export interface RefinementActionAnalysisWithZ3Options {
  analysis?: RefinementActionAnalysisOptions;
  z3?: Z3ExecutionOptions;
}

/** Adds independent Z3 base/step/ranking checks to every retained recurrence certificate. */
export async function analyzeRefinementActionBodiesWithZ3(
  fileName: string,
  text: string,
  adapterName: string,
  spec: TemporalSpec,
  options: RefinementActionAnalysisWithZ3Options = {},
): Promise<RefinementActionAnalysis> {
  const analysis = analyzeRefinementActionBodies(fileName, text, adapterName, spec, options.analysis);
  const addedDiagnostics: RefinementActionDiagnostic[] = [];
  const dischargedScalarMismatches = new Set<string>();
  const obligations = await Promise.all(analysis.obligations.map(async (obligation): Promise<RefinementActionObligation> => {
    if (obligation.kind === "handler-scalar-environment-join") {
      const { members } = obligation.fixedPoint;
      if (obligation.reason !== "independent-proof-required" || members.length < 1) return obligation;
      const checks: NonNullable<RefinementHandlerScalarEnvironmentObligation["proof"]>["checks"][number][] = [];
      for (const member of members) {
        const result = await checkTemporalExpressionEquivalenceWithZ3(
          spec,
          parseTemporalExpression(member.actual),
          parseTemporalExpression(member.expected),
          options.z3,
        );
        checks.push(result.status === "equivalent"
          ? { state: member.state, status: "verified" }
          : result.status === "different"
            ? { state: member.state, status: "refuted" }
            : { state: member.state, status: "unknown", reason: result.reason });
      }
      const proofStatus = checks.some((check) => check.status === "refuted") ? "refuted" as const
        : checks.some((check) => check.status === "unknown") ? "unknown" as const : "verified" as const;
      if (proofStatus === "verified") {
        for (const member of members) dischargedScalarMismatches.add(`${obligation.modelName}\0${member.state}`);
        return {
          ...obligation,
          status: "verified",
          reason: undefined,
          proof: { backend: "z3", status: "verified", checks },
        };
      }
      const proof = { backend: "z3" as const, status: proofStatus, checks };
      addedDiagnostics.push({
        code: "unsupported-action-body",
        adapterName,
        modelName: obligation.modelName,
        exportName: obligation.exportName,
        message: `${obligation.exportName} scalar handler environment ${proof.status === "refuted" ? "failed" : "could not complete"} independent Z3 validation`,
      });
      return {
        ...obligation,
        status: "unknown",
        reason: proof.status === "refuted" ? "scalar-proof-refuted" : "scalar-proof-unknown",
        proof,
      };
    }
    if (obligation.kind === "scalar-recurrence-fixed-point") {
      const certificate = obligation.fixedPoint.recurrence;
      if (!certificate || obligation.reason !== "independent-proof-required") return obligation;
      const recurrenceProof = await verifyRefinementRecurrenceCertificateWithZ3(spec, certificate, options.z3);
      if (recurrenceProof.status === "verified") return {
        ...obligation,
        status: "verified",
        reason: undefined,
        recurrenceProof,
      };
      const reason = recurrenceProof.status === "refuted"
        ? "recurrence-proof-refuted" as const : "recurrence-proof-unknown" as const;
      addedDiagnostics.push({
        code: "unsupported-action-body",
        adapterName,
        modelName: obligation.modelName,
        exportName: obligation.exportName,
        message: `${obligation.exportName} CFG recurrence ${recurrenceProof.status === "refuted" ? "failed" : "could not complete"} independent Z3 base/step/ranking validation`,
      });
      return {
        ...obligation,
        status: "unknown",
        reason,
        recurrenceProof,
        ...(obligation.handlerCompletion ? { handlerCompletion: {
          ...obligation.handlerCompletion,
          retainedThrowPayload: false,
          retainedNormalSnapshot: false,
        } } : {}),
      };
    }
    return obligation;
  }));
  return {
    ...analysis,
    diagnostics: [
      ...analysis.diagnostics.filter((diagnostic) => diagnostic.code !== "action-update-mismatch"
        || !diagnostic.target
        || !dischargedScalarMismatches.has(`${diagnostic.modelName}\0${diagnostic.target}`)),
      ...addedDiagnostics,
    ],
    obligations,
  };
}

/** Uses TypeScript symbol identity to reject collection-like subclasses and user-defined lookalikes. */
export function validateRefinementActionBodiesInProgram(
  program: ts.Program,
  fileName: string,
  adapterName: string,
  spec: TemporalSpec,
  options: RefinementActionValidationOptions = {},
): RefinementActionDiagnostic[] {
  const source = program.getSourceFile(fileName);
  if (!source) throw new Error(`TypeScript program does not contain refinement source ${fileName}`);
  return validateRefinementActionBodiesInSource(source, source.text, adapterName, spec, program.getTypeChecker(), program, options);
}

function collectProgramHelperFunctions(source: ts.SourceFile, checker: ts.TypeChecker): Map<string, ts.FunctionDeclaration> {
  const functions = new Map(source.statements.filter(ts.isFunctionDeclaration).flatMap((node) => node.name ? [[node.name.text, node] as const] : []));
  const ambiguous = new Set<string>();
  const scanned = new Set<ts.FunctionDeclaration>();
  const scan = (root: ts.Node): void => {
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && (ts.isIdentifier(node.expression) || ts.isPropertyAccessExpression(node.expression))) {
        const helper = resolveProgramFunction(checker, node.expression);
        if (helper) {
          const name = ts.isIdentifier(node.expression) ? node.expression.text : node.expression.getText();
          const existing = functions.get(name);
          if (existing && existing !== helper) { functions.delete(name); ambiguous.add(name); }
          else if (!ambiguous.has(name)) functions.set(name, helper);
          if (!scanned.has(helper)) { scanned.add(helper); if (helper.body) scan(helper.body); }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(root);
  };
  scan(source);
  return functions;
}

function validateRefinementInvariantBodiesInSource(
  source: ts.SourceFile,
  text: string,
  adapterName: string,
  spec: TemporalSpec,
  checker?: ts.TypeChecker,
): RefinementInvariantDiagnostic[] {
  const fileName = source.fileName;
  const manifest = buildRefinementBindingManifest(fileName, text, adapterName);
  const functions = checker
    ? collectProgramHelperFunctions(source, checker)
    : new Map(source.statements.filter(ts.isFunctionDeclaration).flatMap((node) => node.name ? [[node.name.text, node] as const] : []));
  const stateNames = new Set(spec.states.map(({ name }) => name));
  const abstraction = parseAbstractionRelations(text, adapterName, manifest.version, stateNames);
  const concreteToAbstract = new Map([...abstraction].map(([abstract, value]) => [parseAbstractionValue(value).path, abstract]));
  const expressionStateNames = new Set([...stateNames, ...[...concreteToAbstract.keys()].map((path) => path.split(".")[0]!).filter(Boolean)]);
  const canonicalize = (expression: TemporalExpression): TemporalExpression => canonicalizeAbstractionExpression(expression, abstraction);
  const diagnostics: RefinementInvariantDiagnostic[] = [];
  for (const property of spec.properties) {
    const exportName = manifest.invariants[property.name];
    if (!exportName) {
      diagnostics.push({ code: "missing-invariant-binding", adapterName, modelName: property.name, message: `invariant ${property.name} has no ${adapterName} refinement binding to verify` });
      continue;
    }
    const implementation = functions.get(exportName);
    const runtimeParameter = implementation?.parameters[0];
    const receiver = runtimeParameter && ts.isIdentifier(runtimeParameter.name) ? runtimeParameter.name.text : undefined;
    const statements = implementation?.body ? [...implementation.body.statements] : [];
    const returned = statements.pop();
    const substitutions = new Map<string, ts.Expression>();
    let supportedLocals = true;
    for (const statement of statements) {
      if (!ts.isVariableStatement(statement) || (statement.declarationList.flags & ts.NodeFlags.Const) === 0) {
        supportedLocals = false;
        break;
      }
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || !declaration.initializer
          || !normalizeRefinementExpression(declaration.initializer, receiver ?? "", substitutions, expressionStateNames, functions, new Set(), new Map(), checker)) {
          supportedLocals = false;
          break;
        }
        substitutions.set(declaration.name.text, declaration.initializer);
      }
      if (!supportedLocals) break;
    }
    const normalized = receiver && supportedLocals && returned && ts.isReturnStatement(returned) && returned.expression
      ? normalizeRefinementExpression(returned.expression, receiver, substitutions, expressionStateNames, functions, new Set(), new Map(), checker)
      : undefined;
    const actual = normalized ? canonicalize(normalized) : undefined;
    if (!actual) {
      diagnostics.push({ code: "unsupported-invariant-body", adapterName, modelName: property.name, exportName, message: `${exportName} is not a single supported scalar return predicate` });
      continue;
    }
    if (sameRefinementExpression(property.expressionAst, actual)) continue;
    const diagnostic: RefinementInvariantDiagnostic = {
      code: "invariant-expression-mismatch", adapterName, modelName: property.name, exportName,
      expected: formatRefinementExpression(property.expressionAst), actual: formatRefinementExpression(actual),
      message: `${exportName} returns ${formatRefinementExpression(actual)}, expected ${formatRefinementExpression(property.expressionAst)}`,
    };
    refinementMismatchExpressions.set(diagnostic, { expected: property.expressionAst, actual });
    diagnostics.push(diagnostic);
  }
  const modelProperties = new Set(spec.properties.map(({ name }) => name));
  for (const [modelName, exportName] of Object.entries(manifest.invariants)) {
    if (modelProperties.has(modelName)) continue;
    diagnostics.push({ code: "unknown-invariant-binding", adapterName, modelName, exportName, message: `invariant refinement ${exportName} refers to unknown temporal property ${modelName}` });
  }
  return diagnostics;
}

/** Proves a single-return, side-effect-free scalar predicate against temporal safety properties. */
export function validateRefinementInvariantBodies(
  fileName: string,
  text: string,
  adapterName: string,
  spec: TemporalSpec,
): RefinementInvariantDiagnostic[] {
  return validateRefinementInvariantBodiesInSource(
    ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS), text, adapterName, spec,
  );
}

/** Resolves imported pure invariant helpers through a TypeScript Program. */
export function validateRefinementInvariantBodiesInProgram(
  program: ts.Program,
  fileName: string,
  adapterName: string,
  spec: TemporalSpec,
): RefinementInvariantDiagnostic[] {
  const source = program.getSourceFile(fileName);
  if (!source) throw new Error(`TypeScript program does not contain refinement source ${fileName}`);
  return validateRefinementInvariantBodiesInSource(source, source.text, adapterName, spec, program.getTypeChecker());
}

async function dischargeExpressionMismatchesWithZ3<T extends { code: string; expected?: string; actual?: string }>(
  diagnostics: readonly T[],
  mismatchCode: string,
  spec: TemporalSpec,
): Promise<Array<Z3RefinementDiagnostic<T>>> {
  const discharged: Array<Z3RefinementDiagnostic<T>> = [];
  for (const diagnostic of diagnostics) {
    if (diagnostic.code !== mismatchCode || !diagnostic.expected || !diagnostic.actual) {
      discharged.push(diagnostic);
      continue;
    }
    const expressions = refinementMismatchExpressions.get(diagnostic);
    const result = await checkTemporalExpressionEquivalenceWithZ3(spec,
      expressions?.expected ?? parseTemporalExpression(diagnostic.expected),
      expressions?.actual ?? parseTemporalExpression(diagnostic.actual));
    if (result.status === "equivalent") continue;
    discharged.push({
      ...diagnostic,
      backend: "z3",
      equivalence: result.status,
      ...(result.status === "unknown" ? { reason: result.reason } : {}),
    });
  }
  return discharged;
}

/** Keeps exact action expressions on the fast path, then proves scalar guard and update mismatches with Z3. */
export async function validateRefinementActionBodiesWithZ3(
  fileName: string, text: string, adapterName: string, spec: TemporalSpec,
): Promise<Array<Z3RefinementDiagnostic<RefinementActionDiagnostic>>> {
  const guards = await dischargeExpressionMismatchesWithZ3(
    validateRefinementActionBodies(fileName, text, adapterName, spec), "action-guard-mismatch", spec,
  );
  return dischargeExpressionMismatchesWithZ3(guards, "action-update-mismatch", spec);
}

/** Combines TypeChecker-backed builtin identity checks with Z3 guard and scalar-update equivalence. */
export async function validateRefinementActionBodiesInProgramWithZ3(
  program: ts.Program, fileName: string, adapterName: string, spec: TemporalSpec,
  options: RefinementActionValidationOptions = {},
): Promise<Array<Z3RefinementDiagnostic<RefinementActionDiagnostic>>> {
  const guards = await dischargeExpressionMismatchesWithZ3(
    validateRefinementActionBodiesInProgram(program, fileName, adapterName, spec, options), "action-guard-mismatch", spec,
  );
  return dischargeExpressionMismatchesWithZ3(guards, "action-update-mismatch", spec);
}

/** Proves normalized single-return invariant predicates by logical rather than syntactic equivalence. */
export async function validateRefinementInvariantBodiesWithZ3(
  fileName: string, text: string, adapterName: string, spec: TemporalSpec,
): Promise<Array<Z3RefinementDiagnostic<RefinementInvariantDiagnostic>>> {
  return dischargeExpressionMismatchesWithZ3(validateRefinementInvariantBodies(fileName, text, adapterName, spec), "invariant-expression-mismatch", spec);
}

/** Combines Program-resolved invariant helpers with Z3 predicate equivalence. */
export async function validateRefinementInvariantBodiesInProgramWithZ3(
  program: ts.Program, fileName: string, adapterName: string, spec: TemporalSpec,
): Promise<Array<Z3RefinementDiagnostic<RefinementInvariantDiagnostic>>> {
  return dischargeExpressionMismatchesWithZ3(
    validateRefinementInvariantBodiesInProgram(program, fileName, adapterName, spec), "invariant-expression-mismatch", spec,
  );
}

function typescriptTemporalShapeMismatch(
  checker: ts.TypeChecker,
  actual: ts.Type,
  expected: TemporalValueType,
  location: ts.Node,
  path: readonly string[] = [],
): readonly string[] | undefined {
  if ((actual.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never)) !== 0) return path;
  if (typeof expected === "string") {
    const flag = expected === "int" ? ts.TypeFlags.Number : ts.TypeFlags.Boolean;
    if ((actual.flags & flag) !== 0) return undefined;
    if (actual.isIntersection() && actual.types.some((part) => (part.flags & flag) !== 0)) return undefined;
    return path;
  }
  if (expected.kind === "set" || expected.kind === "map") {
    const expectedName = expected.kind === "set" ? "Set" : "Map";
    const resolveBuiltin = (type: ts.Type, seen: ReadonlySet<ts.Type> = new Set()): readonly ts.Type[] | undefined => {
      if (seen.has(type)) return undefined;
      const symbol = type.getSymbol() ?? type.aliasSymbol;
      if (symbol?.getName() === expectedName
        && (symbol.declarations ?? []).some((declaration) => declaration.getSourceFile().isDeclarationFile)) {
        return (type.flags & ts.TypeFlags.Object) !== 0
          ? checker.getTypeArguments(type as ts.TypeReference)
          : [];
      }
      const constraint = checker.getBaseConstraintOfType(type);
      return constraint && constraint !== type ? resolveBuiltin(constraint, new Set([...seen, type])) : undefined;
    };
    const arguments_ = resolveBuiltin(actual);
    if (!arguments_) return path;
    if (expected.kind === "set") {
      if (expected.element === "never") return undefined;
      const element = arguments_[0];
      return element ? typescriptTemporalShapeMismatch(checker, element, expected.element, location, [...path, "<element>"]) : path;
    }
    const [key, value] = arguments_;
    const keyMismatch = expected.key === "never" || !key ? undefined : typescriptTemporalShapeMismatch(checker, key, expected.key, location, [...path, "<key>"]);
    if (keyMismatch) return keyMismatch;
    if (expected.value === "never") return undefined;
    return value ? typescriptTemporalShapeMismatch(checker, value, expected.value, location, [...path, "<value>"]) : path;
  }
  if ((actual.flags & ts.TypeFlags.Object) === 0 && !actual.isIntersection()) return path;
  for (const [name, fieldType] of Object.entries(expected.fields)) {
    const property = actual.getProperty(name);
    if (!property) return [...path, name];
    const declaration = property.valueDeclaration ?? property.declarations?.[0] ?? location;
    const mismatch = typescriptTemporalShapeMismatch(checker, checker.getTypeOfSymbolAtLocation(property, declaration), fieldType, declaration, [...path, name]);
    if (mismatch) return mismatch;
  }
  return undefined;
}

function validateRefinementStateProjectionInSource(
  source: ts.SourceFile,
  text: string,
  adapterName: string,
  spec: TemporalSpec,
  checker?: ts.TypeChecker,
): RefinementStateProjectionDiagnostic[] {
  const fileName = source.fileName;
  const manifest = buildRefinementBindingManifest(fileName, text, adapterName);
  const functions = checker
    ? collectProgramHelperFunctions(source, checker)
    : new Map(source.statements.filter(ts.isFunctionDeclaration).flatMap((node) => node.name ? [[node.name.text, node] as const] : []));
  const classes = new Map(source.statements.filter(ts.isClassDeclaration).flatMap((node) => node.name ? [[node.name.text, node] as const] : []));
  const stateNames = new Set(spec.states.map(({ name }) => name));
  const stateTypes = new Map(spec.states.map(({ name, type }) => [name, type]));
  const abstraction = parseAbstractionRelations(text, adapterName, manifest.version, stateNames);
  const concreteToAbstract = new Map([...abstraction].map(([abstract, value]) => [parseAbstractionValue(value).path, abstract]));
  const identity = () => new Map(spec.states.map(({ name }) => [name, { kind: "name", name } as TemporalExpression]));

  const extract = (
    implementation: ts.FunctionDeclaration,
    role: "create" | "observe",
    activeHelpers: ReadonlySet<string> = new Set(),
  ): Map<string, TemporalExpression> | undefined => {
    const implementationName = implementation.name?.text;
    if (!implementationName || activeHelpers.has(implementationName)) return undefined;
    const nextActiveHelpers = new Set([...activeHelpers, implementationName]);
    const parameter = implementation.parameters[0];
    const receiver = parameter && ts.isIdentifier(parameter.name) ? parameter.name.text : undefined;
    if (!receiver || !implementation.body || implementation.body.statements.length === 0) return undefined;
    const aliases = new Map<string, string>();
    const statements = [...implementation.body.statements];
    const returned = statements.pop();
    if (!returned || !ts.isReturnStatement(returned) || !returned.expression) return undefined;
    for (const statement of statements) {
      if (role !== "observe" || !ts.isVariableStatement(statement)
        || (statement.declarationList.flags & ts.NodeFlags.Const) === 0 || statement.declarationList.declarations.length !== 1) return undefined;
      const declaration = statement.declarationList.declarations[0];
      if (!declaration?.initializer || !ts.isIdentifier(declaration.initializer) || declaration.initializer.text !== receiver || !ts.isObjectBindingPattern(declaration.name)) return undefined;
      for (const element of declaration.name.elements) {
        if (element.dotDotDotToken || !ts.isIdentifier(element.name)) return undefined;
        const field = element.propertyName && ts.isIdentifier(element.propertyName) ? element.propertyName.text : element.name.text;
        if (!stateNames.has(field)) return undefined;
        aliases.set(element.name.text, field);
      }
    }
    const accessPath = (node: ts.Expression): string[] | undefined => {
      if (ts.isIdentifier(node)) {
        if (node.text === receiver) return [];
        const alias = aliases.get(node.text);
        return alias ? [alias] : undefined;
      }
      if (!ts.isPropertyAccessExpression(node)) return undefined;
      const base = accessPath(node.expression);
      if (!base) return undefined;
      const combined = [...base, node.name.text];
      if (role === "observe") for (const [abstract, value] of abstraction) {
        const parsed = parseAbstractionValue(value);
        if (parsed.kind !== "identity") continue;
        const concretePath = parsed.path.split(".");
        if (combined.length >= concretePath.length && concretePath.every((part, index) => combined[index] === part)) {
          return [abstract, ...combined.slice(concretePath.length)];
        }
      }
      return combined;
    };
    const pathExpression = (path: readonly string[]): TemporalExpression | undefined => {
      const [root, ...fields] = path;
      if (!root || !stateNames.has(root)) return undefined;
      return fields.reduce<TemporalExpression>((value, name) => ({ kind: "field", receiver: value, name }), { kind: "name", name: root });
    };
    const normalizeProjectionExpression = (node: ts.Expression): TemporalExpression | undefined => {
      if (role === "observe" && checker && ts.isNewExpression(node)
        && ts.isIdentifier(node.expression) && (node.expression.text === "Set" || node.expression.text === "Map")
        && node.arguments?.length === 1 && isDeclarationFileSymbol(checker, node.expression, node.expression.text)) {
        const concrete = refinementFieldPath(node.arguments[0]!, receiver, new Map())?.join(".");
        for (const [abstract, value] of abstraction) {
          const parsed = parseAbstractionValue(value);
          const expected = parsed.kind === "set-from-array" ? "Set" : parsed.kind === "map-from-entries" ? "Map" : undefined;
          if (expected === node.expression.text && parsed.path === concrete) return { kind: "name", name: abstract };
        }
      }
      const path = accessPath(node);
      if (path) return pathExpression(path);
      if (!ts.isObjectLiteralExpression(node)) {
        const roots = [...concreteToAbstract.keys()].map((value) => value.split(".")[0]!).filter(Boolean);
        const normalized = normalizeRefinementExpression(node, receiver, new Map(), new Set([...stateNames, ...roots]));
        return normalized ? canonicalizeAbstractionExpression(normalized, abstraction) : undefined;
      }
      const fields: Record<string, TemporalExpression> = {};
      for (const property of node.properties) {
        if (!ts.isPropertyAssignment(property)) return undefined;
        const name = ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) ? property.name.text : undefined;
        const value = normalizeProjectionExpression(property.initializer);
        if (!name || !value || Object.hasOwn(fields, name)) return undefined;
        fields[name] = value;
      }
      return { kind: "record", fields };
    };
    const expandedIdentity = (type: TemporalValueType, path: readonly string[]): TemporalExpression | undefined => {
      if (typeof type === "string" || type.kind !== "record") return pathExpression(path);
      const fields: Record<string, TemporalExpression> = {};
      for (const [name, fieldType] of Object.entries(type.fields)) {
        const value = expandedIdentity(fieldType, [...path, name]);
        if (!value) return undefined;
        fields[name] = value;
      }
      return { kind: "record", fields };
    };
    const expression = returned.expression;
    if (ts.isIdentifier(expression) && expression.text === receiver) return identity();
    if (ts.isCallExpression(expression)
      && (ts.isIdentifier(expression.expression) || ts.isPropertyAccessExpression(expression.expression))
      && expression.arguments.length === 1 && ts.isIdentifier(expression.arguments[0]!)
      && expression.arguments[0]!.text === receiver) {
      const helperName = ts.isIdentifier(expression.expression) ? expression.expression.text : expression.expression.getText();
      const helper = functions.get(helperName);
      if (!helper?.body || helper.parameters.length !== 1 || !ts.isIdentifier(helper.parameters[0]!.name)) return undefined;
      return extract(helper, role, nextActiveHelpers);
    }
    if (role === "create" && ts.isCallExpression(expression)
      && ts.isPropertyAccessExpression(expression.expression)
      && ts.isIdentifier(expression.expression.expression) && expression.expression.expression.text === "Object"
      && expression.expression.name.text === "assign" && expression.arguments.length === 2
      && ts.isNewExpression(expression.arguments[0]!) && ts.isIdentifier(expression.arguments[0]!.expression)
      && ts.isIdentifier(expression.arguments[1]!) && expression.arguments[1]!.text === receiver) {
      const runtimeClass = classes.get(expression.arguments[0]!.expression.text);
      const transparentConstruction = runtimeClass && !runtimeClass.heritageClauses?.length
        && runtimeClass.members.every((member) => !ts.isConstructorDeclaration(member) && !ts.isGetAccessorDeclaration(member) && !ts.isSetAccessorDeclaration(member));
      if (!transparentConstruction) return undefined;
      return identity();
    }
    if (!ts.isObjectLiteralExpression(expression)) return undefined;
    const projection = new Map<string, TemporalExpression>();
    if (role === "create" && abstraction.size > 0) {
      const initializerAt = (object: ts.ObjectLiteralExpression, path: readonly string[]): ts.Expression | undefined => {
        const [head, ...tail] = path;
        const property = head && object.properties.find((candidate): candidate is ts.PropertyAssignment =>
          ts.isPropertyAssignment(candidate)
          && (ts.isIdentifier(candidate.name) || ts.isStringLiteral(candidate.name))
          && candidate.name.text === head);
        if (!property) return undefined;
        if (tail.length === 0) return property.initializer;
        return ts.isObjectLiteralExpression(property.initializer) ? initializerAt(property.initializer, tail) : undefined;
      };
      for (const { name, type } of spec.states) {
        const relation = abstraction.get(name);
        const parsed = relation ? parseAbstractionValue(relation) : { kind: "identity" as const, path: name };
        const initializer = initializerAt(expression, parsed.path.split("."));
        let value: TemporalExpression | undefined;
        if ((parsed.kind === "set-from-array" || parsed.kind === "map-from-entries") && checker && initializer && ts.isCallExpression(initializer)
          && ts.isPropertyAccessExpression(initializer.expression)
          && ts.isIdentifier(initializer.expression.expression) && initializer.expression.expression.text === "Array"
          && initializer.expression.name.text === "from" && initializer.arguments.length === 1
          && isDeclarationFileSymbol(checker, initializer.expression.name, "from")) {
          const source = accessPath(initializer.arguments[0]!);
          if (source?.length === 1 && source[0] === name) value = { kind: "name", name };
        } else if (initializer) value = normalizeProjectionExpression(initializer);
        const expanded = expandedIdentity(type, [name]);
        if (value && expanded && sameRefinementExpression(value, expanded)) value = { kind: "name", name };
        if (!value) return undefined;
        projection.set(name, value);
      }
      return projection;
    }
    for (const property of expression.properties) {
      if (ts.isSpreadAssignment(property)) {
        if (!ts.isIdentifier(property.expression) || property.expression.text !== receiver) return undefined;
        for (const [name, value] of identity()) projection.set(name, value);
        continue;
      }
      if (ts.isShorthandPropertyAssignment(property)) {
        const field = aliases.get(property.name.text);
        if (!field || !stateNames.has(property.name.text)) return undefined;
        projection.set(property.name.text, { kind: "name", name: field });
        continue;
      }
      if (!ts.isPropertyAssignment(property)) return undefined;
      const propertyName = ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) ? property.name.text : undefined;
      const field = propertyName && role === "create" ? concreteToAbstract.get(propertyName) ?? propertyName : propertyName;
      if (!field || !stateNames.has(field)) return undefined;
      const alias = ts.isIdentifier(property.initializer) ? aliases.get(property.initializer.text) : undefined;
      let value = alias
        ? { kind: "name", name: alias } as TemporalExpression
        : normalizeProjectionExpression(property.initializer);
      if (!value) return undefined;
      const type = stateTypes.get(field);
      const expanded = type ? expandedIdentity(type, [field]) : undefined;
      if (expanded && sameRefinementExpression(value, expanded)) value = { kind: "name", name: field };
      projection.set(field, value);
    }
    return projection;
  };

  const diagnostics: RefinementStateProjectionDiagnostic[] = [];
  const expectedStateType: TemporalValueType = { kind: "record", fields: Object.fromEntries(spec.states.map(({ name, type }) => [name, type])) };
  const concreteStateMismatch = (actual: ts.Type, location: ts.Node): readonly string[] | undefined => {
    if ((actual.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never)) !== 0) return [];
    if ((actual.flags & ts.TypeFlags.Object) === 0 && !actual.isIntersection()) return [];
    for (const { name, type } of spec.states) {
      const relation = abstraction.get(name);
      const parsed = relation ? parseAbstractionValue(relation) : { kind: "identity" as const, path: name };
      let current = actual;
      let declaration: ts.Node = location;
      for (const part of parsed.path.split(".")) {
        const property = current.getProperty(part);
        if (!property) return [name];
        declaration = property.valueDeclaration ?? property.declarations?.[0] ?? declaration;
        current = checker!.getTypeOfSymbolAtLocation(property, declaration);
      }
      let mismatch: readonly string[] | undefined;
      if (parsed.kind === "set-from-array") {
        if (typeof type === "string" || type.kind !== "set") mismatch = [name];
        else {
          const symbol = current.getSymbol() ?? current.aliasSymbol;
          const builtinArray = symbol?.getName() === "Array"
            && (symbol.declarations ?? []).some((candidate) => candidate.getSourceFile().isDeclarationFile);
          const element = builtinArray && (current.flags & ts.TypeFlags.Object) !== 0
            ? checker!.getTypeArguments(current as ts.TypeReference)[0]
            : undefined;
          mismatch = element && type.element !== "never"
            ? typescriptTemporalShapeMismatch(checker!, element, type.element, declaration, [name, "<element>"])
            : element ? undefined : [name];
        }
      } else if (parsed.kind === "map-from-entries") {
        if (typeof type === "string" || type.kind !== "map") mismatch = [name];
        else {
          const symbol = current.getSymbol() ?? current.aliasSymbol;
          const builtinArray = symbol?.getName() === "Array"
            && (symbol.declarations ?? []).some((candidate) => candidate.getSourceFile().isDeclarationFile);
          const element = builtinArray && (current.flags & ts.TypeFlags.Object) !== 0
            ? checker!.getTypeArguments(current as ts.TypeReference)[0]
            : undefined;
          const tupleArguments = element && checker!.isTupleType(element)
            ? checker!.getTypeArguments(element as ts.TypeReference)
            : undefined;
          const [key, value] = tupleArguments ?? [];
          mismatch = !key || !value || tupleArguments?.length !== 2 ? [name]
            : type.key !== "never" && typescriptTemporalShapeMismatch(checker!, key, type.key, declaration, [name, "<key>"])
              || type.value !== "never" && typescriptTemporalShapeMismatch(checker!, value, type.value, declaration, [name, "<value>"])
              || undefined;
        }
      } else mismatch = typescriptTemporalShapeMismatch(checker!, current, type, declaration, [name]);
      if (mismatch) return mismatch;
    }
    return undefined;
  };
  for (const role of ["create", "observe"] as const) {
    const exportName = manifest[role];
    const implementation = functions.get(exportName);
    if (checker && implementation) {
      const parameter = implementation.parameters[0];
      const parameterMismatch = parameter
        ? role === "create"
          ? typescriptTemporalShapeMismatch(checker, checker.getTypeAtLocation(parameter), expectedStateType, parameter)
          : concreteStateMismatch(checker.getTypeAtLocation(parameter), parameter)
        : [];
      const signature = checker.getSignatureFromDeclaration(implementation);
      const returnMismatch = signature
        ? role === "observe"
          ? typescriptTemporalShapeMismatch(checker, checker.getReturnTypeOfSignature(signature), expectedStateType, implementation)
          : concreteStateMismatch(checker.getReturnTypeOfSignature(signature), implementation)
        : [];
      const mismatch = parameterMismatch ?? returnMismatch;
      if (mismatch) {
        diagnostics.push({
          code: `${role}-type-mismatch`, adapterName, role, exportName,
          ...(mismatch[0] ? { field: mismatch[0] } : {}),
          expected: formatTemporalValueType(expectedStateType),
          actual: parameterMismatch ? (parameter ? checker.typeToString(checker.getTypeAtLocation(parameter)) : "<missing>") : (signature ? checker.typeToString(checker.getReturnTypeOfSignature(signature)) : "<missing>"),
          message: `${exportName} ${parameterMismatch ? "parameter" : "return"} type does not match temporal state${mismatch.length ? ` at ${mismatch.join(".")}` : ""}`,
        });
        continue;
      }
    }
    const projection = implementation ? extract(implementation, role) : undefined;
    if (!projection) {
      diagnostics.push({ code: `unsupported-${role}-body`, adapterName, role, exportName, message: `${exportName} is outside the supported state-projection fragment` });
      continue;
    }
    for (const { name } of spec.states) {
      const actual = projection.get(name);
      if (actual?.kind === "name" && actual.name === name) continue;
      diagnostics.push({
        code: `${role}-state-mismatch`, adapterName, role, exportName, field: name, expected: name,
        actual: actual ? formatRefinementExpression(actual) : "<missing>",
        message: `${exportName} projects ${name} as ${actual ? formatRefinementExpression(actual) : "<missing>"}, expected ${name}`,
      });
    }
  }
  return diagnostics;
}

/** Proves that create and observe each preserve every model state field by name. */
export function validateRefinementStateProjection(
  fileName: string,
  text: string,
  adapterName: string,
  spec: TemporalSpec,
): RefinementStateProjectionDiagnostic[] {
  return validateRefinementStateProjectionInSource(
    ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS), text, adapterName, spec,
  );
}

/** Resolves imported create/observe wrappers through TypeScript symbol identity. */
export function validateRefinementStateProjectionInProgram(
  program: ts.Program,
  fileName: string,
  adapterName: string,
  spec: TemporalSpec,
): RefinementStateProjectionDiagnostic[] {
  const source = program.getSourceFile(fileName);
  if (!source) throw new Error(`TypeScript program does not contain refinement source ${fileName}`);
  return validateRefinementStateProjectionInSource(source, source.text, adapterName, spec, program.getTypeChecker());
}

function callable(exports: Record<string, unknown>, name: string): (...args: any[]) => any {
  const value = exports[name];
  if (typeof value !== "function") throw new Error(`refinement binding export ${name} is not callable`);
  return value as (...args: any[]) => any;
}

/** Resolves an extracted manifest against already-loaded module exports for test/replay tooling. */
export function createAnnotatedRefinementAdapter<State extends object = ModelState, Runtime = unknown>(
  fileName: string,
  text: string,
  exports: Record<string, unknown>,
  adapterName: string,
): ModelRefinementAdapter<Runtime, State> {
  const manifest = buildRefinementBindingManifest(fileName, text, adapterName);
  return {
    schema: "uneffect-refinement-adapter/v1", name: manifest.adapterName, version: manifest.version,
    abstractions: manifest.abstractions,
    create: callable(exports, manifest.create), observe: callable(exports, manifest.observe),
    actions: Object.fromEntries(Object.entries(manifest.actions).map(([name, binding]) => [name, callable(exports, binding)])),
    invariants: Object.fromEntries(Object.entries(manifest.invariants).map(([name, binding]) => [name, callable(exports, binding)])),
  } as ModelRefinementAdapter<Runtime, State>;
}

/** Emits a reviewable module that references implementation exports without runtime wrappers. */
export function generateRefinementAdapterModule(fileName: string, text: string, moduleSpecifier: string, adapterName: string): string {
  const manifest = buildRefinementBindingManifest(fileName, text, adapterName);
  const record = (entries: Record<string, string>) => `{ ${Object.entries(entries).map(([name, binding]) => `${JSON.stringify(name)}: implementation.${binding}`).join(", ")} }`;
  return `import * as implementation from ${JSON.stringify(moduleSpecifier)}\n\nexport const ${adapterName}RefinementAdapter = {\n  schema: "uneffect-refinement-adapter/v1",\n  name: ${JSON.stringify(adapterName)},\n  version: ${JSON.stringify(manifest.version)},\n  abstractions: ${JSON.stringify(manifest.abstractions)},\n  create: implementation.${manifest.create},\n  observe: implementation.${manifest.observe},\n  actions: ${record(manifest.actions)},\n  invariants: ${record(manifest.invariants)},\n} as const\n`;
}
