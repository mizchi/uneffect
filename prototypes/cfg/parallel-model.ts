/** One live activation per fork ID; completed activations leave no arrival tokens. */
export interface BranchOwner { readonly fork: string; readonly branch: string }
export interface WorkflowToken { readonly step: string; readonly owner: BranchOwner | null }
export interface ForkActivation { readonly fork: string; readonly parent: BranchOwner | null }
export interface WorkflowConfiguration {
  readonly facts: readonly string[];
  readonly tokens: readonly WorkflowToken[];
  readonly activations: readonly ForkActivation[];
}
export interface WorkflowExecution {
  readonly step: string;
  readonly after: WorkflowConfiguration;
}

export function canonicalConfiguration(value: WorkflowConfiguration): WorkflowConfiguration {
  return {
    facts: [...new Set(value.facts)].sort(),
    tokens: [...value.tokens].sort((a, b) => compareJson(a, b)),
    activations: [...value.activations].sort((a, b) => compareJson(a, b)),
  };
}

function compareJson(a: unknown, b: unknown): number {
  const left = JSON.stringify(a), right = JSON.stringify(b);
  return left < right ? -1 : left > right ? 1 : 0;
}
