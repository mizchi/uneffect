import {
  analyzeRefinementActionBodies,
  analyzeRefinementActionBodiesWithZ3,
  type RefinementActionAnalysis,
  type RefinementActionAnalysisOptions,
  type RefinementActionAnalysisWithZ3Options,
} from "../src/refinement-bindings.js";
import type { TemporalSpec } from "../src/spec-ir.js";
import { refinementManifest } from "./refinement-manifest.js";

function singleAction(spec: TemporalSpec): string {
  if (spec.actions.length !== 1) {
    throw new Error(`single-action refinement fixture expected one action, found ${spec.actions.length}`);
  }
  return spec.actions[0]!.name;
}

/** Manifest-first adapter for fixtures whose model action and export share one name. */
export function analyzeSingleActionRefinementBodies(
  fileName: string,
  text: string,
  adapterName: string,
  spec: TemporalSpec,
  options: RefinementActionAnalysisOptions = {},
): RefinementActionAnalysis {
  const action = singleAction(spec);
  return analyzeRefinementActionBodies(
    fileName, text, adapterName, spec, options,
    refinementManifest(fileName, adapterName, { [action]: action }),
  );
}

/** Z3 variant of the manifest-first single-action fixture adapter. */
export function analyzeSingleActionRefinementBodiesWithZ3(
  fileName: string,
  text: string,
  adapterName: string,
  spec: TemporalSpec,
  options: RefinementActionAnalysisWithZ3Options = {},
): Promise<RefinementActionAnalysis> {
  const action = singleAction(spec);
  return analyzeRefinementActionBodiesWithZ3(fileName, text, adapterName, spec, {
    ...options,
    manifest: refinementManifest(fileName, adapterName, { [action]: action }),
  });
}
