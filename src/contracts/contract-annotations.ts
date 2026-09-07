import { extractLocatedAnnotations, validateUneffectAnnotations, type LocatedAnnotation } from "../support/annotations.js";

const directives = ["requires", "ensures", "contract_from", "loop_invariant"] as const;
export function nativeContractAnnotations(text: string, baseOffset = 0): LocatedAnnotation[] {
  return [
    ...directives.flatMap(directive => extractLocatedAnnotations(text, directive, baseOffset)),
    ...validateUneffectAnnotations(text, baseOffset)
      .filter(diagnostic => directives.some(directive => directive === diagnostic.directive))
      .map(diagnostic => ({ value: "", span: diagnostic.span })),
  ];
}

/** Cheap gate; the native verifier subsequently restricts this to actual Oxc comments. */
export function hasNativeContractCandidates(text: string): boolean { return nativeContractAnnotations(text).length > 0; }
