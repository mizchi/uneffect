import { parseSync } from "oxc-parser";
import { oxcLanguage } from "../oxc/source.js";
import { extractLocatedAnnotations, validateUneffectAnnotations, type SourceSpan } from "../../support/annotations.js";
import { formatEffect, isKnownEffect, parseEffectSet } from "../../effects/capabilities.js";

/** A directive or effect payload this source spells in a way the annotation language does not accept. */
export interface CorsaAnnotationProblem {
  readonly span: SourceSpan;
  readonly message: string;
}

export interface CorsaAnnotationFacts {
  /** Malformed directives and unparseable effect payloads, in source order. */
  readonly problems: readonly CorsaAnnotationProblem[];
  /**
   * Whether the source declares effects at all, and whether any of those declarations is about module
   * evaluation. Neither says whether a declaration holds — only that this file makes claims, which a run that
   * does not check them must not present as a proof.
   */
  readonly declaresEffects: boolean;
  readonly declaresModuleEffects: boolean;
}

/** The directives that declare an effect upper bound, as opposed to the other Uneffect dialects. */
const declarationDirectives = ["effect", "module_effect"] as const;

/**
 * Uneffect directives read from the source's COMMENT TOKENS rather than from its text.
 *
 * Scanning the raw text finds the directives this project writes inside string literals — the checker's own
 * diagnostic message templates interpolate a directive into the text they suggest, and the test fixtures hold
 * deliberately malformed ones — so a text scan reports the tool's own source as broken. Oxc already parses
 * these files and returns real comment ranges, which excludes every such occurrence.
 */
export function collectCorsaAnnotations(fileName: string, text: string): CorsaAnnotationFacts {
  const parsed = parseSync(fileName, text, { lang: oxcLanguage(fileName) });
  const problems: CorsaAnnotationProblem[] = [];
  let declaresEffects = false;
  let declaresModuleEffects = false;
  for (const comment of parsed.comments ?? []) {
    const slice = text.slice(comment.start, comment.end);
    for (const problem of validateUneffectAnnotations(slice, comment.start)) {
      problems.push({ span: problem.span, message: problem.message });
    }
    for (const directive of declarationDirectives) {
      for (const annotation of extractLocatedAnnotations(slice, directive, comment.start)) {
        declaresEffects = true;
        if (directive === "module_effect") declaresModuleEffects = true;
        // A payload the effect language cannot read is a declaration this run cannot compare against anything,
        // which the cardinal rule makes an explicit error rather than an annotation to skip over.
        try {
          for (const effect of parseEffectSet(annotation.value)) {
            // A name no capability answers to is not a weaker claim, it is a claim about nothing.
            if (!isKnownEffect(effect)) {
              problems.push({ span: annotation.span, message: `unknown effect ${formatEffect(effect)}` });
            }
          }
        } catch (cause) {
          problems.push({
            span: annotation.span,
            message: `invalid effect declaration: ${cause instanceof Error ? cause.message : String(cause)}`,
          });
        }
      }
    }
  }
  problems.sort((left, right) => left.span.start - right.span.start);
  return { problems, declaresEffects, declaresModuleEffects };
}
