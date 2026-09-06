/** Public dependency impact boundary; input extraction belongs to the caller. */
export { analyzeImpact } from "./impact.js";
export { parseDependencyGraph } from "./input.js";
export type { AnalysisOptions, AnalysisUnknown, DependencyNode, ImpactResult } from "./contracts.js";
