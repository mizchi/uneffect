/** Versioned ESM ordering contracts, independent of compiler and graph implementations. */
export type ModuleInitializationEventKind =
  | "start"
  | "promise-launch"
  | "rejection-handler-attach"
  | "suspend"
  | "resume"
  | "reject"
  | "throw"
  | "complete";
export type ModuleInitializationUnknownKind =
  | "entry-not-found"
  | "cycle"
  | "external-static-import"
  | "dynamic-import"
  | "unhandled-top-level-promise-launch"
  | "unsupported-top-level-promise-handler"
  | "unsupported-mixed-top-level-async-shape"
  | "conditional-top-level-await"
  | "conditional-top-level-throw"
  | "class-initialization-order"
  | "typescript-error";

export interface ModuleInitializationEvent {
  id: string;
  kind: ModuleInitializationEventKind;
  span: { start: number; end: number };
}

export interface ModuleInitializationSourceEvidence {
  kind: "program-source";
  sourceDigest: string;
}

export interface ModuleInitializationConstraint {
  before: string;
  after: string;
  reason: "module-sequencing" | "static-dependency-completes" | "synchronous-cycle-dfs-execution";
  sourceFile: string;
  sourceSpan: { start: number; end: number };
  semanticRule: "source-order" | "ecma262-inner-module-evaluation-request" | "ecma262-inner-module-evaluation-execute";
  evidence: ModuleInitializationSourceEvidence;
}

export interface ModuleInitializationChoice {
  after: string;
  alternatives: [string, string];
  reason: "await-settlement";
}

export interface ModuleInitializationModule {
  fileName: string;
  dependencies: string[];
  /** Dependencies with no normal-completion event; this module body is unreachable on that modeled path. */
  blockedBy: string[];
  events: ModuleInitializationEvent[];
  choices: ModuleInitializationChoice[];
}

export interface ModuleInitializationCycleRequest {
  from: string;
  to: string;
  sourceSpan: { start: number; end: number };
  semanticRule: "ecma262-inner-module-evaluation-request" | "ecma262-inner-module-evaluation-revisit";
  evidence: ModuleInitializationSourceEvidence;
}

export interface ModuleInitializationCycleComponent {
  id: string;
  kind: "synchronous-side-effect-import-ring";
  root: string;
  modules: string[];
  executionOrder: string[];
  requests: ModuleInitializationCycleRequest[];
}

export interface ModuleInitializationUnknown {
  fileName: string;
  kind: ModuleInitializationUnknownKind;
  span?: { start: number; end: number };
  detail: string;
}

export interface ModuleInitializationOrder {
  schema: "uneffect-module-order/v1";
  schemaVersion: 1;
  entryFile: string;
  compiler: { typescriptVersion: string; compilerOptionsDigest: string };
  /** The extracted partial-order claim is proof-grade only when no unsupported boundary was encountered. */
  evidence: "verified" | "unknown";
  modules: ModuleInitializationModule[];
  constraints: ModuleInitializationConstraint[];
  cycleComponents: ModuleInitializationCycleComponent[];
  unknowns: ModuleInitializationUnknown[];
  claims: readonly [
    "represented module events follow source order on the normal-completion path",
    "an importer body starts only after every normally completed static dependency",
    "top-level await may resume or reject",
    "an unconditional top-level throw prevents normal completion",
    "a synchronous side-effect-import simple ring executes in specification DFS postorder",
    "a supported top-level Promise rejection handler is attached synchronously before module completion",
  ];
  exclusions: readonly [
    "host scheduling time is not modeled",
    "only synchronous side-effect-import simple rings have proof-grade cyclic order",
    "dynamic and external module bodies are not modeled",
    "Promise execution after a top-level launch is not modeled",
  ];
}

export interface ModuleInitializationV2Options {
  readonly proofBudget?: {
    readonly moduleControlFlowIterations?: number;
  };
}

export type ModuleInitializationEventKindV2 = ModuleInitializationEvent["kind"] | "branch" | "join";
export type ModuleInitializationControlFlowEdgeRole =
  | "sequence"
  | "branch-true"
  | "branch-false"
  | "await-resume"
  | "await-reject";

export interface ModuleInitializationEventV2 extends Omit<ModuleInitializationEvent, "kind"> {
  readonly kind: ModuleInitializationEventKindV2;
}

export interface ModuleInitializationControlFlowEdge {
  readonly from: string;
  readonly to: string;
  readonly completion: "normal" | "throw";
  readonly role: ModuleInitializationControlFlowEdgeRole;
  readonly sourceFile: string;
  readonly sourceSpan: { readonly start: number; readonly end: number };
  readonly evidence: ModuleInitializationSourceEvidence;
}

export interface ModuleInitializationControlFlowProof {
  readonly status: "converged" | "unknown";
  readonly iterations: number;
  readonly budget: { readonly name: "module-control-flow-iterations"; readonly limit: number };
  readonly reachableBy: Readonly<Record<string, readonly ModuleInitializationCompletionPath[]>>;
  readonly reason?: "proof-budget-exhausted" | "lattice-conflict" | "invalid-cfg" | "domain-postcondition-failed";
  readonly detail?: string;
}

export type ModuleInitializationCompletionPath = "branch-false" | "await-resume" | "await-reject";

export interface ModuleInitializationControlFlow {
  readonly entry: string;
  readonly completion: string;
  readonly selector: { readonly name: string; readonly span: { readonly start: number; readonly end: number } };
  readonly blocks: readonly ModuleInitializationEventV2[];
  readonly edges: readonly ModuleInitializationControlFlowEdge[];
  readonly proof: ModuleInitializationControlFlowProof;
}

export interface ModuleInitializationModuleV2 extends Omit<ModuleInitializationModule, "events"> {
  readonly events: ModuleInitializationEventV2[];
  readonly choices: ModuleInitializationChoice[];
  readonly controlFlow?: ModuleInitializationControlFlow;
}

export type ModuleInitializationUnknownV2 = ModuleInitializationUnknown | {
  readonly fileName: string;
  readonly kind: "module-control-flow-proof";
  readonly span?: { readonly start: number; readonly end: number };
  readonly detail: string;
};

export type ModuleInitializationConstraintV2 = ModuleInitializationConstraint | {
  readonly before: string;
  readonly after: string;
  readonly reason: "module-control-flow";
  readonly sourceFile: string;
  readonly sourceSpan: { readonly start: number; readonly end: number };
  readonly semanticRule: "conditional-source-order";
  readonly evidence: ModuleInitializationSourceEvidence;
};

export interface ModuleInitializationOrderV2 {
  readonly schema: "uneffect-module-order/v2";
  readonly schemaVersion: 2;
  readonly entryFile: string;
  readonly compiler: { readonly typescriptVersion: string; readonly compilerOptionsDigest: string };
  readonly evidence: "verified" | "unknown";
  readonly modules: ModuleInitializationModuleV2[];
  readonly constraints: ModuleInitializationConstraintV2[];
  readonly cycleComponents: ModuleInitializationCycleComponent[];
  readonly unknowns: ModuleInitializationUnknownV2[];
  readonly claims: readonly string[];
  readonly exclusions: readonly string[];
}

