export type UneffectDirective =
  | "effect" | "effect_parameter" | "module_effect" | "effect_schema"
  | "capability_from"
  | "requires" | "ensures" | "invariant" | "decreases" | "assert" | "validate" | "returns"
  | "contract_from"
  | "refinement_from"
  | "trust" | "react"
  | "state" | "clock" | "init" | "action" | "action_when" | "action_fair" | "temporal"
  | "temporal_from"
  | "temporal_requires" | "temporal_ensures" | "temporal_modifies" | "temporal_throws" | "temporal_rejects"
  | "temporal_suspends" | "temporal_cancellable" | "temporal_terminates" | "temporal_eventually" | "temporal_repeatedly"
  | "temporal_stabilizes" | "temporal_response" | "temporal_fair"
  | "consumes_rejection" | "consumes_callback_rejection" | "consumes_rejection_when"
  | "consumes_callback_rejection_when" | "retains_resource" | "retains_resource_when"
  | "acquire" | "use" | "borrow" | "consume" | "release" | "transfer" | "escape";
export const uneffectDialects = [
  "unified", "trust", "react-component", "react-hook", "react-resource",
] as const;
export type UneffectDialect = (typeof uneffectDialects)[number];
export interface SourceSpan { start: number; end: number }
export interface LocatedAnnotation { value: string; span: SourceSpan }
export interface AnnotationDiagnostic {
  kind: "unknown-dialect" | "wrong-dialect" | "unknown-directive" | "missing-payload";
  directive: string; dialect?: string; span: SourceSpan; message: string;
}
interface PayloadLine { cleaned: string; start: number }
interface PayloadBlock { dialect: string; dialectSpan: SourceSpan; lines: PayloadLine[] }

const unifiedDirectives = new Set([
  "effect", "effect_parameter", "module_effect", "effect_schema", "capability_from",
  "requires", "ensures", "loop_invariant", "decreases", "assert", "validate", "returns", "contract_from", "refinement_from",
  "state", "clock", "init", "action", "action_when", "action_fair", "always", "eventually", "repeatedly", "stabilizes", "response", "fair", "temporal_from",
  "temporal_contract",
  "consumes_rejection", "consumes_callback_rejection", "consumes_rejection_when", "consumes_callback_rejection_when", "retains_resource", "retains_resource_when",
  "acquire", "use", "borrow", "consume", "release", "transfer", "escape",
]);

export function isCoreUneffectDirective(directive: string): boolean {
  return unifiedDirectives.has(directive);
}

export type UneffectPluginDirectiveKind = "marker" | "payload";
export interface UneffectPluginDirective {
  name: string;
  kind: UneffectPluginDirectiveKind;
  owner: string;
}

const namespacedPluginDirective = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_.]*$/;
const builtinPluginAuthority = {};
const pluginDirectives = new Map<string, UneffectPluginDirective>();

export class UneffectPluginError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UneffectPluginError";
  }
}

/**
 * Register namespaced plugin directives. Third-party plugins cannot occupy a
 * core directive or a namespace that is already a core directive, and cannot
 * steal a name already owned by another plugin.
 */
export function registerUneffectPlugin(
  plugin: { name: string; directives: ReadonlyArray<{ name: string; kind: UneffectPluginDirectiveKind }> },
  authority?: object,
): void {
  if (!/^[a-z][a-z0-9_]*$/.test(plugin.name)) throw new UneffectPluginError(`invalid plugin name \`${plugin.name}\``);
  for (const directive of plugin.directives) {
    if (!namespacedPluginDirective.test(directive.name) || !directive.name.startsWith(`${plugin.name}.`)) {
      throw new UneffectPluginError(`plugin directive \`${directive.name}\` must be namespaced under \`${plugin.name}\``);
    }
    const head = directive.name.slice(0, plugin.name.length);
    if (isCoreUneffectDirective(head) && authority !== builtinPluginAuthority) {
      throw new UneffectPluginError(`plugin directive \`${directive.name}\` collides with a core Uneffect directive`);
    }
    const owner = pluginDirectives.get(directive.name);
    if (owner) throw new UneffectPluginError(`plugin directive \`${directive.name}\` is already owned by \`${owner.owner}\``);
    pluginDirectives.set(directive.name, { name: directive.name, kind: directive.kind, owner: plugin.name });
  }
}

registerUneffectPlugin({
  name: "react",
  directives: [
    { name: "react.component", kind: "marker" },
    { name: "react.hook", kind: "marker" },
    { name: "react.acquire", kind: "payload" },
    { name: "react.release", kind: "payload" },
  ],
}, builtinPluginAuthority);

export function uneffectPluginDirectives(): readonly UneffectPluginDirective[] {
  return [...pluginDirectives.values()];
}

function reactPluginRole(name: string): string {
  return name.slice("react.".length);
}

const dialectDirectives: Record<UneffectDialect, ReadonlySet<string>> = {
  unified: unifiedDirectives,
  trust: new Set(["trust"]), "react-component": new Set(), "react-hook": new Set(),
  "react-resource": new Set(["acquire", "release"]),
};
const aliases: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  unified: {
    loop_invariant: "invariant", always: "temporal",
    eventually: "temporal_eventually", repeatedly: "temporal_repeatedly",
    stabilizes: "temporal_stabilizes", response: "temporal_response",
    fair: "temporal_fair",
  },
};
const temporalContractAliases: Readonly<Record<string, string>> = {
  requires: "temporal_requires", ensures: "temporal_ensures", modifies: "temporal_modifies",
  throws: "temporal_throws", rejects: "temporal_rejects", suspends: "temporal_suspends",
  cancellable: "temporal_cancellable", terminates: "temporal_terminates", eventually: "temporal_eventually",
  repeatedly: "temporal_repeatedly", stabilizes: "temporal_stabilizes",
  response: "temporal_response", fair: "temporal_fair",
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
    const headerName = headerMatch?.[1] ?? "";
    const unified = headerName === "" || unifiedDirectives.has(headerName);
    const dialect = unified ? "unified" : headerName;
    const dialectStart = headerName === ""
      ? markerLine.start + tailIndex
      : markerLine.start + markerLine.cleaned.indexOf(headerName, tailIndex);
    const inline = headerMatch?.[2];
    const inlineStart = inline ? markerLine.start + markerLine.cleaned.indexOf(inline, tailIndex + dialect.length) : 0;
    const headerDirective = unified && headerName !== ""
      ? [{ cleaned: header, start: dialectStart }]
      : inline ? [{ cleaned: inline, start: inlineStart }] : [];
    blocks.push({ dialect, dialectSpan: { start: dialectStart, end: dialectStart + headerName.length }, lines: [...headerDirective, ...lines.slice(marker + 1)] });
  }
  return blocks;
}
function canonicalDirective(dialect: string, directive: string): string { return aliases[dialect]?.[directive] ?? directive; }

export function extractLocatedAnnotations(text: string, directive: UneffectDirective | string, baseOffset = 0): LocatedAnnotation[] {
  const values: LocatedAnnotation[] = [];
  for (const block of payloadBlocks(text, baseOffset)) {
    if (block.dialect === directive
      && !dialectDirectives[block.dialect as UneffectDialect]) {
      for (const line of block.lines) {
        const value = line.cleaned.trim();
        if (!value) continue;
        const start = line.start + line.cleaned.indexOf(value);
        values.push({ value, span: { start, end: start + value.length } });
      }
      continue;
    }
    if (directive === "react" && (block.dialect === "react-component" || block.dialect === "react-hook")) {
      values.push({ value: block.dialect === "react-component" ? "component" : "hook", span: block.dialectSpan });
    }
    const dialectPlugin = pluginDirectives.get(block.dialect);
    if (dialectPlugin && (directive === block.dialect || (directive === "react" && dialectPlugin.owner === "react"))) {
      if (dialectPlugin.kind === "marker") {
        if (directive === "react") values.push({ value: reactPluginRole(dialectPlugin.name), span: block.dialectSpan });
        continue;
      }
      for (const line of block.lines) {
        const payload = line.cleaned.trim();
        if (!payload) continue;
        const value = directive === "react" ? `${reactPluginRole(dialectPlugin.name)} ${payload}` : payload;
        const start = line.start + line.cleaned.indexOf(payload);
        values.push({ value, span: { start, end: start + payload.length } });
      }
      continue;
    }
    if (directive === "react" && block.dialect === "react-resource" && block.lines.length === 0) {
      values.push({ value: "", span: block.dialectSpan });
    }
    for (const line of block.lines) {
      const candidate = line.cleaned.trim(); if (!candidate) continue;
      const match = /^([^\s]+)(?:\s+(.+))?$/.exec(candidate)!;
      const linePlugin = block.dialect === "unified" ? pluginDirectives.get(match[1]!) : undefined;
      if (linePlugin && (directive === linePlugin.name || (directive === "react" && linePlugin.owner === "react"))) {
        if (linePlugin.kind === "marker") {
          if (directive === "react" && !match[2]) {
            values.push({ value: reactPluginRole(linePlugin.name), span: { start: line.start + line.cleaned.indexOf(match[1]!), end: line.start + line.cleaned.indexOf(match[1]!) + match[1]!.length } });
          }
          continue;
        }
        if (!match[2]?.trim()) continue;
        const payload = match[2].trim();
        const value = directive === "react" ? `${reactPluginRole(linePlugin.name)} ${payload}` : payload;
        const start = line.start + line.cleaned.indexOf(payload);
        values.push({ value, span: { start, end: start + payload.length } });
        continue;
      }
      if (directive === "react" && block.dialect === "react-resource") {
        const value = [match[1], match[2]?.trim()].filter(Boolean).join(" "), start = line.start + line.cleaned.indexOf(match[1]!);
        values.push({ value, span: { start, end: start + value.length } });
        continue;
      }
      if (block.dialect === "unified" && match[1] === "temporal_contract" && match[2]) {
        const clause = /^([^\s]+)(?:\s+(.+))?$/.exec(match[2].trim());
        if (!clause || temporalContractAliases[clause[1]!] !== directive || !clause[2]) continue;
        const value = clause[2].trim(), start = line.start + line.cleaned.indexOf(value);
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

/* uneffect:effect_parameter additionalDirectives extends none */
export function validateUneffectAnnotations(text: string, baseOffset = 0, additionalDirectives: Iterable<string> = []): AnnotationDiagnostic[] {
  const diagnostics: AnnotationDiagnostic[] = [];
  const additional = new Set(additionalDirectives);
  for (const block of payloadBlocks(text, baseOffset)) {
    const allowed = dialectDirectives[block.dialect as UneffectDialect];
    const dialectPlugin = pluginDirectives.get(block.dialect);
    if (!allowed && additional.has(block.dialect)) {
      const payload = block.lines.map((line) => line.cleaned.trim()).find(Boolean);
      if (!payload) diagnostics.push({ kind: "missing-payload", directive: block.dialect, dialect: "unified", span: block.dialectSpan, message: `Uneffect directive \`${block.dialect}\` requires a payload` });
      continue;
    }
    if (dialectPlugin) {
      const payload = block.lines.map((line) => line.cleaned.trim()).find(Boolean);
      if (dialectPlugin.kind === "marker" && payload) {
        diagnostics.push({ kind: "unknown-directive", directive: block.dialect, dialect: "unified", span: block.dialectSpan, message: `Uneffect plugin directive \`${block.dialect}\` does not take a payload` });
      }
      if (dialectPlugin.kind === "payload" && !payload) {
        diagnostics.push({ kind: "missing-payload", directive: block.dialect, dialect: "unified", span: block.dialectSpan, message: `Uneffect plugin directive \`${block.dialect}\` requires a payload` });
      }
      continue;
    }
    if (!allowed) { diagnostics.push({ kind: "unknown-dialect", directive: block.dialect, span: block.dialectSpan, message: `unknown Uneffect dialect \`${block.dialect || "(missing)"}\`` }); continue; }
    const accepted = block.dialect === "unified" ? new Set([...allowed, ...additional]) : allowed;
    for (const line of block.lines) {
      const candidate = line.cleaned.trim(); if (!candidate) continue;
      const match = /^([^\s]+)(?:\s+(.*))?$/.exec(candidate)!, name = match[1]!, leading = line.cleaned.indexOf(candidate);
      const span = { start: line.start + leading, end: line.start + leading + candidate.length };
      const linePlugin = pluginDirectives.get(name);
      if (block.dialect === "unified" && linePlugin) {
        if (linePlugin.kind === "marker" && match[2]?.trim()) diagnostics.push({ kind: "unknown-directive", directive: name, dialect: "unified", span, message: `Uneffect plugin directive \`${name}\` does not take a payload` });
        else if (linePlugin.kind === "payload" && !match[2]?.trim()) diagnostics.push({ kind: "missing-payload", directive: name, dialect: "unified", span, message: `Uneffect plugin directive \`${name}\` requires a payload` });
        continue;
      }
      if (!accepted.has(name)) diagnostics.push({ kind: "wrong-dialect", directive: name, dialect: block.dialect, span, message: `Uneffect directive \`${name}\` is not valid in an \`uneffect:${block.dialect}\` block` });
      else if (block.dialect === "unified" && name === "temporal_contract") {
        const clause = /^([^\s]+)(?:\s+(.*))?$/.exec(match[2]?.trim() ?? ""), clauseName = clause?.[1] ?? "temporal_contract";
        const clauseStart = line.start + leading + candidate.indexOf(clauseName, name.length);
        const clauseSpan = { start: clauseStart, end: clauseStart + clauseName.length };
        if (!temporalContractAliases[clauseName]) diagnostics.push({ kind: "unknown-directive", directive: clauseName, dialect: "temporal_contract", span: clauseSpan, message: `unknown Uneffect temporal contract clause \`${clauseName}\`` });
        else if (!clause?.[2]?.trim()) diagnostics.push({ kind: "missing-payload", directive: clauseName, dialect: "temporal_contract", span: clauseSpan, message: `Uneffect temporal contract clause \`${clauseName}\` requires a payload` });
      }
      else if (!match[2]?.trim()) diagnostics.push({ kind: "missing-payload", directive: name, dialect: block.dialect, span, message: `Uneffect directive \`${name}\` requires a payload` });
    }
  }
  return diagnostics;
}
export function extractAnnotations(text: string, directive: UneffectDirective | string): string[] { return extractLocatedAnnotations(text, directive).map((item) => item.value); }
