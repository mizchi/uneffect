/** Prototype contracts: source extraction and prerequisite analysis are independent. */
export interface RuleLocation { readonly fileName: string; readonly start: number; readonly end: number }
export interface RuleEvent {
  readonly operation: string;
  /** Declaration/region identity, not the variable's display name. */
  readonly subject: string;
  readonly location: RuleLocation;
}
export interface RuleCfg {
  readonly entry: string;
  readonly blocks: readonly {
    readonly id: string;
    readonly successors: readonly string[];
    readonly events: readonly RuleEvent[];
  }[];
}
export interface PrerequisiteOperation {
  readonly requires?: readonly string[];
  readonly provides?: readonly string[];
  readonly revokes?: readonly string[];
}
export interface PrerequisiteRule {
  readonly id: string;
  readonly operations: Readonly<Record<string, PrerequisiteOperation>>;
}
export interface RuleAnalysisOptions { readonly budget?: number }
export interface RuleDiagnostic {
  readonly ruleId: string;
  readonly subject: string;
  readonly operation: string;
  readonly missing: readonly string[];
  readonly location: RuleLocation;
  /** Missing guarantees describe abstract paths, not a concrete execution witness. */
  readonly message: string;
}
export interface RuleUnknown {
  readonly status: "unknown";
  readonly reason: "invalid-input" | "invalid-cfg" | "lattice-conflict" | "proof-budget-exhausted"
    | "state-space-exhausted" | "unsupported-source" | "typescript-error" | "frontend-error";
  readonly detail: string;
  readonly location?: RuleLocation;
}
export type RuleAnalysisResult = RuleUnknown | {
  readonly status: "clean" | "findings";
  readonly diagnostics: readonly RuleDiagnostic[];
  readonly iterations: number;
};
/** The caller trusts these source-local function declarations as synchronous operations. */
export interface SourceRuleBinding {
  readonly functionName: string;
  readonly operation: string;
  readonly argumentIndex: number;
}
export interface SourceRuleOptions {
  readonly fileName: string;
  readonly functionName: string;
  readonly bindings: readonly SourceRuleBinding[];
}
export type SourceRuleLowering = RuleUnknown | { readonly status: "lowered"; readonly cfg: RuleCfg };

/** Compatibility names for the optional TypeScript Program adapter. */
export type TypeScriptRuleBinding = SourceRuleBinding;
export type TypeScriptRuleOptions = SourceRuleOptions;
export type TypeScriptRuleLowering = SourceRuleLowering;
