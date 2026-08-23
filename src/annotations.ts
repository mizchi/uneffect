export type UneffectDirective =
  | "effect" | "effect_schema" | "requires" | "ensures" | "invariant" | "decreases" | "assert" | "validate"
  | "trust" | "trust_owner" | "trust_expires"
  | "refinement"
  | "abstraction"
  | "returns" | "state" | "clock" | "init" | "action" | "action_when" | "action_fair" | "temporal"
  | "temporal_requires" | "temporal_ensures" | "temporal_modifies" | "temporal_throws"
  | "temporal_rejects" | "temporal_suspends" | "temporal_cancellable"
  | "temporal_eventually" | "temporal_repeatedly" | "temporal_stabilizes" | "temporal_response" | "temporal_fair" | "consumes_rejection" | "consumes_callback_rejection"
  | "consumes_rejection_when" | "consumes_callback_rejection_when" | "retains_resource" | "retains_resource_when";

export interface SourceSpan { start: number; end: number }
export interface LocatedAnnotation { value: string; span: SourceSpan }
export interface AnnotationDiagnostic {
  kind: "unknown-directive" | "missing-payload";
  directive: string;
  span: SourceSpan;
  message: string;
}

interface PayloadLine { cleaned: string; start: number }

function uneffectPayloadLines(text: string, baseOffset: number): PayloadLine[][] {
  const blocks: PayloadLine[][] = [];
  for (const comment of text.matchAll(/\/\*([\s\S]*?)\*\//g)) {
    const body = comment[1]!;
    const bodyStart = baseOffset + comment.index! + 2;
    let relativeStart = 0;
    const lines = body.split(/\r?\n/).map((raw) => {
      const prefix = /^\s*\*?\s?/.exec(raw)?.[0].length ?? 0;
      const cleanedRaw = raw.slice(prefix);
      const line = { cleaned: cleanedRaw.trimEnd(), start: bodyStart + relativeStart + prefix };
      relativeStart += raw.length + (body[relativeStart + raw.length] === "\r" ? 2 : 1);
      return line;
    });
    const marker = lines.findIndex((line) => /\buneffect\s*:/.test(line.cleaned));
    if (marker < 0) continue;
    const markerLine = lines[marker]!;
    const markerMatch = /\buneffect\s*:\s*/.exec(markerLine.cleaned)!;
    const tailIndex = markerMatch.index + markerMatch[0].length;
    blocks.push([
      { cleaned: markerLine.cleaned.slice(tailIndex), start: markerLine.start + tailIndex },
      ...lines.slice(marker + 1),
    ]);
  }
  return blocks;
}

/** Extracts directive payloads together with absolute UTF-16 source offsets. */
export function extractLocatedAnnotations(
  text: string,
  directive: UneffectDirective | string,
  baseOffset = 0,
): LocatedAnnotation[] {
  const values: LocatedAnnotation[] = [];
  for (const payloadLines of uneffectPayloadLines(text, baseOffset)) {
    const pattern = new RegExp(`^${directive}\\s+(.+)$`, "i");
    for (const line of payloadLines) {
      const leading = /^\s*/.exec(line.cleaned)![0].length;
      const candidate = line.cleaned.slice(leading);
      const match = pattern.exec(candidate);
      if (!match) continue;
      const value = match[1]!.trim();
      const valueIndex = candidate.indexOf(match[1]!) + match[1]!.indexOf(value);
      const start = line.start + leading + valueIndex;
      values.push({ value, span: { start, end: start + value.length } });
    }
  }
  return values;
}

const directives = new Set<UneffectDirective>([
  "effect", "effect_schema", "requires", "ensures", "invariant", "decreases", "assert", "validate", "trust", "trust_owner", "trust_expires", "refinement", "abstraction", "returns",
  "state", "clock", "init", "action", "action_when", "action_fair", "temporal",
  "temporal_requires", "temporal_ensures", "temporal_modifies",
  "temporal_throws",
  "temporal_rejects", "temporal_suspends", "temporal_cancellable",
  "temporal_eventually", "temporal_repeatedly", "temporal_stabilizes", "temporal_response", "temporal_fair", "consumes_rejection", "consumes_callback_rejection",
  "consumes_rejection_when", "consumes_callback_rejection_when", "retains_resource", "retains_resource_when",
]);

export function validateUneffectAnnotations(text: string, baseOffset = 0, additionalDirectives: Iterable<string> = []): AnnotationDiagnostic[] {
  const accepted = new Set<string>([...directives, ...additionalDirectives]);
  const diagnostics: AnnotationDiagnostic[] = [];
  for (const lines of uneffectPayloadLines(text, baseOffset)) for (const line of lines) {
    const candidate = line.cleaned.trim();
    if (!candidate) continue;
    const match = /^([^\s]+)(?:\s+(.*))?$/.exec(candidate)!;
    const directive = match[1]!;
    const leading = line.cleaned.indexOf(candidate);
    const span = { start: line.start + leading, end: line.start + leading + candidate.length };
    if (!accepted.has(directive)) {
      diagnostics.push({
        kind: "unknown-directive", directive, span,
        message: `unknown Uneffect directive \`${directive}\``,
      });
    } else if (!match[2]?.trim()) {
      diagnostics.push({
        kind: "missing-payload", directive, span,
        message: `Uneffect directive \`${directive}\` requires a payload`,
      });
    }
  }
  return diagnostics;
}

/** Extracts Uneffect's comment DSL without participating in JSDoc tag semantics. */
export function extractAnnotations(text: string, directive: UneffectDirective | string): string[] {
  return extractLocatedAnnotations(text, directive).map((item) => item.value);
}
