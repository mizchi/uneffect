export type UneffectDirective =
  | "effect" | "effect_parameter" | "module_effect" | "effect_schema"
  | "capability_from"
  | "requires" | "ensures" | "invariant" | "decreases" | "assert" | "validate" | "returns"
  | "contract_from"
  | "trust" | "trust_owner" | "trust_expires" | "refinement" | "abstraction" | "runtime" | "react"
  | "state" | "clock" | "init" | "action" | "action_when" | "action_fair" | "temporal"
  | "temporal_from"
  | "temporal_requires" | "temporal_ensures" | "temporal_modifies" | "temporal_throws" | "temporal_rejects"
  | "temporal_suspends" | "temporal_cancellable" | "temporal_eventually" | "temporal_repeatedly"
  | "temporal_stabilizes" | "temporal_response" | "temporal_fair"
  | "consumes_rejection" | "consumes_callback_rejection" | "consumes_rejection_when"
  | "consumes_callback_rejection_when" | "retains_resource" | "retains_resource_when";
export type UneffectDialect = "capability" | "contract" | "temporal" | "temporal-summary" | "async" | "refinement" | "runtime" | "trust" | "react-component" | "react-hook" | "react-resource";
export interface SourceSpan { start: number; end: number }
export interface LocatedAnnotation { value: string; span: SourceSpan }
export interface AnnotationDiagnostic {
  kind: "unknown-dialect" | "wrong-dialect" | "unknown-directive" | "missing-payload";
  directive: string; dialect?: string; span: SourceSpan; message: string;
}
interface PayloadLine { cleaned: string; start: number }
interface PayloadBlock { dialect: string; dialectSpan: SourceSpan; lines: PayloadLine[] }

const dialectDirectives: Record<UneffectDialect, ReadonlySet<string>> = {
  capability: new Set(["effect", "effect_parameter", "module_effect", "effect_schema", "from"]),
  contract: new Set(["requires", "ensures", "invariant", "decreases", "assert", "validate", "returns", "from"]),
  temporal: new Set(["state", "clock", "init", "action", "action_when", "action_fair", "invariant", "eventually", "repeatedly", "stabilizes", "response", "fair", "from"]),
  "temporal-summary": new Set(["requires", "ensures", "modifies", "throws", "rejects", "suspends", "cancellable", "eventually", "repeatedly", "stabilizes", "response", "fair"]),
  async: new Set(["consumes_rejection", "consumes_callback_rejection", "consumes_rejection_when", "consumes_callback_rejection_when", "retains_resource", "retains_resource_when"]),
  refinement: new Set(["refinement", "abstraction"]), runtime: new Set(["runtime", "returns"]),
  trust: new Set(["trust", "trust_owner", "trust_expires"]), "react-component": new Set(), "react-hook": new Set(),
  "react-resource": new Set(["acquire", "release"]),
};
const aliases: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  capability: { from: "capability_from" },
  contract: { from: "contract_from" },
  temporal: { invariant: "temporal", eventually: "temporal_eventually", repeatedly: "temporal_repeatedly", stabilizes: "temporal_stabilizes", response: "temporal_response", fair: "temporal_fair", from: "temporal_from" },
  "temporal-summary": { requires: "temporal_requires", ensures: "temporal_ensures", modifies: "temporal_modifies", throws: "temporal_throws", rejects: "temporal_rejects", suspends: "temporal_suspends", cancellable: "temporal_cancellable", eventually: "temporal_eventually", repeatedly: "temporal_repeatedly", stabilizes: "temporal_stabilizes", response: "temporal_response", fair: "temporal_fair" },
};

function payloadBlocks(text: string, baseOffset: number): PayloadBlock[] {
  const blocks: PayloadBlock[] = [];
  for (const comment of text.matchAll(/\/\*([\s\S]*?)\*\//g)) {
    const body = comment[1]!, bodyStart = baseOffset + comment.index! + 2;
    let relativeStart = 0;
    const lines = body.split(/\r?\n/).map((raw) => {
      const prefix = /^\s*\*?\s?/.exec(raw)?.[0].length ?? 0, cleanedRaw = raw.slice(prefix);
      const line = { cleaned: cleanedRaw.trimEnd(), start: bodyStart + relativeStart + prefix };
      relativeStart += raw.length + (body[relativeStart + raw.length] === "\r" ? 2 : 1);
      return line;
    });
    const marker = lines.findIndex((line) => /\buneffect\s*:/.test(line.cleaned));
    if (marker < 0) continue;
    const markerLine = lines[marker]!, markerMatch = /\buneffect\s*:\s*/.exec(markerLine.cleaned)!;
    const tailIndex = markerMatch.index + markerMatch[0].length;
    const header = markerLine.cleaned.slice(tailIndex).trim();
    const headerMatch = /^(\S+)(?:\s+(.+))?$/.exec(header);
    const dialect = headerMatch?.[1] ?? "";
    const dialectStart = markerLine.start + markerLine.cleaned.indexOf(dialect, tailIndex);
    const inline = headerMatch?.[2];
    const inlineStart = inline ? markerLine.start + markerLine.cleaned.indexOf(inline, tailIndex + dialect.length) : 0;
    blocks.push({ dialect, dialectSpan: { start: dialectStart, end: dialectStart + dialect.length }, lines: [...(inline ? [{ cleaned: inline, start: inlineStart }] : []), ...lines.slice(marker + 1)] });
  }
  return blocks;
}
function canonicalDirective(dialect: string, directive: string): string { return aliases[dialect]?.[directive] ?? directive; }

export function extractLocatedAnnotations(text: string, directive: UneffectDirective | string, baseOffset = 0): LocatedAnnotation[] {
  const values: LocatedAnnotation[] = [];
  for (const block of payloadBlocks(text, baseOffset)) {
    if (directive === "react" && (block.dialect === "react-component" || block.dialect === "react-hook")) {
      values.push({ value: block.dialect === "react-component" ? "component" : "hook", span: block.dialectSpan });
    }
    if (directive === "react" && block.dialect === "react-resource" && block.lines.length === 0) {
      values.push({ value: "", span: block.dialectSpan });
    }
    for (const line of block.lines) {
      const candidate = line.cleaned.trim(); if (!candidate) continue;
      const match = /^([^\s]+)(?:\s+(.+))?$/.exec(candidate)!;
      if (directive === "react" && block.dialect === "react-resource") {
        const value = [match[1], match[2]?.trim()].filter(Boolean).join(" "), start = line.start + line.cleaned.indexOf(match[1]!);
        values.push({ value, span: { start, end: start + value.length } });
        continue;
      }
      if (canonicalDirective(block.dialect, match[1]!) !== directive || !match[2]) continue;
      const value = match[2].trim(), start = line.start + line.cleaned.indexOf(value);
      values.push({ value, span: { start, end: start + value.length } });
    }
  }
  return values;
}

export function validateUneffectAnnotations(text: string, baseOffset = 0, additionalDirectives: Iterable<string> = []): AnnotationDiagnostic[] {
  const diagnostics: AnnotationDiagnostic[] = [];
  for (const block of payloadBlocks(text, baseOffset)) {
    const allowed = dialectDirectives[block.dialect as UneffectDialect];
    if (!allowed) { diagnostics.push({ kind: "unknown-dialect", directive: block.dialect, span: block.dialectSpan, message: `unknown Uneffect dialect \`${block.dialect || "(missing)"}\`` }); continue; }
    const accepted = block.dialect === "temporal" ? new Set([...allowed, ...additionalDirectives]) : allowed;
    for (const line of block.lines) {
      const candidate = line.cleaned.trim(); if (!candidate) continue;
      const match = /^([^\s]+)(?:\s+(.*))?$/.exec(candidate)!, name = match[1]!, leading = line.cleaned.indexOf(candidate);
      const span = { start: line.start + leading, end: line.start + leading + candidate.length };
      if (!accepted.has(name)) diagnostics.push({ kind: "wrong-dialect", directive: name, dialect: block.dialect, span, message: `Uneffect directive \`${name}\` is not valid in an \`uneffect:${block.dialect}\` block` });
      else if (!match[2]?.trim()) diagnostics.push({ kind: "missing-payload", directive: name, dialect: block.dialect, span, message: `Uneffect directive \`${name}\` requires a payload` });
    }
  }
  return diagnostics;
}
export function extractAnnotations(text: string, directive: UneffectDirective | string): string[] { return extractLocatedAnnotations(text, directive).map((item) => item.value); }
