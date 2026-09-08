/** Experimental, compiler-independent prerequisite analysis. */
export { initializationRule, ownPropertyReadRule, lintPrerequisites } from "./prerequisites.js";
export type {
  RuleLocation, RuleEvent, RuleCfg, PrerequisiteOperation, PrerequisiteRule,
  RuleAnalysisOptions, RuleDiagnostic, RuleUnknown, RuleAnalysisResult,
  SourceRuleBinding, SourceRuleOptions, SourceRuleLowering, RegistryReadRuleOptions,
} from "./contracts.js";
