/** Experimental consumers of the public CFG facade, not published package APIs. */
export interface AnalysisOptions {
  /** Maximum processed blocks, including revisits. Defaults to 100,000. */
  readonly budget?: number;
}

export interface AnalysisUnknown {
  readonly status: "unknown";
  readonly reason: "invalid-input" | "invalid-cfg" | "lattice-conflict" | "proof-budget-exhausted" | "state-space-exhausted";
  readonly detail: string;
  readonly iterations: number;
}

export interface DependencyNode {
  readonly id: string;
  /** Dependencies point from consumer to input; impact travels in reverse. */
  readonly dependencies: readonly string[];
}

export type ImpactResult = AnalysisUnknown | {
  readonly status: "analyzed";
  readonly iterations: number;
  /** Includes changed nodes themselves. Sorted by node and then by cause. */
  readonly affected: readonly { readonly node: string; readonly causes: readonly string[] }[];
  readonly unaffected: readonly string[];
};

interface WorkflowStepBase {
  readonly id: string;
  /** Checked at step entry, before revokes/provides. */
  readonly requires?: readonly string[];
  readonly provides?: readonly string[];
  readonly revokes?: readonly string[];
  /** Alternatives for actions/joins; all branches are started by a fork. */
  readonly next: readonly string[];
}

export interface WorkflowActionStep extends WorkflowStepBase { readonly kind?: "action" }
export interface WorkflowForkStep extends WorkflowStepBase {
  readonly kind: "fork";
  readonly join: string;
}
export interface WorkflowJoinStep extends WorkflowStepBase {
  readonly kind: "join";
  readonly fork: string;
}
export type WorkflowStep = WorkflowActionStep | WorkflowForkStep | WorkflowJoinStep;

export interface WorkflowAnalysisOptions extends AnalysisOptions {
  /** Parallel state exploration limit. Defaults to 10,000 configurations. */
  readonly maxConfigurations?: number;
}

export type WorkflowDiagnostic =
  | { readonly step: string; readonly missing: readonly string[] }
  | { readonly kind: "blocked-join"; readonly step: string; readonly fork: string;
      /** Branch entry IDs absent at the reported reachable waiting configuration. */
      readonly waitingFor: readonly string[] };

export interface Workflow {
  readonly entry: string;
  readonly initial?: readonly string[];
  readonly steps: readonly WorkflowStep[];
}

export type WorkflowResult = AnalysisUnknown | {
  /** Valid means requirements hold; active parallel barriers remain reachable.
   * This does not establish termination or eventual scheduling of a join. */
  readonly status: "valid" | "invalid";
  readonly iterations: number;
  readonly diagnostics: readonly WorkflowDiagnostic[];
  /** Facts guaranteed at enabled step entry. A waiting join is observed only when
   * all branches have arrived. Unreachable/unenabled steps are absent. */
  readonly guaranteed: ReadonlyMap<string, readonly string[]>;
  readonly unreachable: readonly string[];
};
