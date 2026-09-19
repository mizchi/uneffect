import { parseSync } from "oxc-parser";
import { oxcLanguage } from "../oxc/source.js";
import { extractLocatedAnnotations, validateUneffectAnnotations, type SourceSpan } from "../../support/annotations.js";
import { formatEffect, isKnownEffect, parseEffectSet, type Effect } from "../../effects/capabilities.js";

type Node = { type?: string; start?: number; end?: number } & Record<string, unknown>;

const functionLike = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"]);

/** A directive or effect payload this source spells in a way the annotation language does not accept. */
export interface CorsaAnnotationProblem {
  readonly span: SourceSpan;
  readonly message: string;
}

/**
 * An effect upper bound the source declares, already parsed, with the boundary it is written on.
 *
 * `bodyStart` is the offset of the declared function's own body, which the consumer turns into a boundary with
 * the same `enclosingFunction` rule it uses everywhere else. `null` means the declaration is about module
 * evaluation. A declaration the rule could not bind to anything is reported as a problem instead, never
 * quietly credited to the next function — that would let a declaration written for something else silence a
 * violation in a boundary that never claimed anything.
 */
export interface CorsaEffectDeclaration {
  readonly span: SourceSpan;
  readonly effects: readonly Effect[];
  readonly bodyStart: number | null;
}

export interface CorsaAnnotationFacts {
  /** Every readable declaration, bound to the boundary that carries it. */
  readonly declarations: readonly CorsaEffectDeclaration[];
  /** Malformed directives and unparseable effect payloads, in source order. */
  readonly problems: readonly CorsaAnnotationProblem[];
  /** Readable declarations this run could not bind to a boundary, so they were never compared. */
  readonly unchecked: readonly CorsaAnnotationProblem[];
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
  const unchecked: CorsaAnnotationProblem[] = [];
  const declarations: CorsaEffectDeclaration[] = [];
  let declaresEffects = false;
  let declaresModuleEffects = false;
  /** Every node in the file, so the first one beginning after a comment can be found by offset. */
  const nodes: Node[] = [];
  const collect = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { for (const item of node) collect(item); return; }
    const item = node as Node;
    if (typeof item.type === "string" && typeof item.start === "number") nodes.push(item);
    for (const [key, child] of Object.entries(item)) { if (key !== "loc" && key !== "range") collect(child); }
  };
  collect(parsed.program.body);
  nodes.sort((left, right) => left.start! - right.start! || right.end! - left.end!);
  /**
   * The body of the function a declaration written immediately before `position` is about. The FIRST node that
   * begins at or after the comment has to be the declaration itself, reached only through the wrappers that
   * spell one — an export, a variable statement, a class member. Anything else in between (a class, an
   * interface member, a type, an expression) means the comment was written about something this path does not
   * carry a summary for, and the declaration is left unbound.
   */
  const declaredBody = (position: number): number | null => {
    const first = nodes.find((node) => node.start! >= position);
    let node: Node | undefined = first;
    for (let depth = 0; node !== undefined && depth < 8; depth += 1) {
      if (functionLike.has(node.type ?? "")) {
        const body = node.body as Node | undefined;
        return typeof body?.start === "number" ? body.start : null;
      }
      const next: unknown = node.type === "ExportNamedDeclaration" || node.type === "ExportDefaultDeclaration"
        ? node.declaration
        : node.type === "VariableDeclaration"
          ? (Array.isArray(node.declarations) && node.declarations.length === 1 ? (node.declarations[0] as Node).init : undefined)
          : node.type === "MethodDefinition" || node.type === "PropertyDefinition"
            || node.type === "AccessorProperty" || node.type === "Property"
            ? node.value
            : undefined;
      node = next && typeof next === "object" ? next as Node : undefined;
    }
    return null;
  };
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
          const effects = parseEffectSet(annotation.value);
          let readable = true;
          for (const effect of effects) {
            // A name no capability answers to is not a weaker claim, it is a claim about nothing.
            if (!isKnownEffect(effect)) {
              problems.push({ span: annotation.span, message: `unknown effect ${formatEffect(effect)}` });
              readable = false;
            }
          }
          if (!readable) continue;
          if (directive === "module_effect") { declarations.push({ span: annotation.span, effects, bodyStart: null }); continue; }
          const bodyStart = declaredBody(comment.end);
          if (bodyStart === null) {
            // Not a defect in the source: the declaration is in a position this path publishes no summary for,
            // such as an interface property signature. Saying it was not compared is the honest report, and
            // crediting it to the next function would silence a violation in a boundary that claimed nothing.
            unchecked.push({ span: annotation.span, message: "this effect declaration is not on a function this check carries a summary for, so it was not compared" });
            continue;
          }
          declarations.push({ span: annotation.span, effects, bodyStart });
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
  unchecked.sort((left, right) => left.span.start - right.span.start);
  return { problems, unchecked, declarations, declaresEffects, declaresModuleEffects };
}
