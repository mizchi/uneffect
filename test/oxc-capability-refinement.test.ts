import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { parseCapabilityDslWithSchemas, prepareCapabilityDslLinks } from "../src/effects/capability-dsl.js";
import { parseRefinementDsl, resolveRefinementDslLink } from "../src/refinement/refinement-dsl.js";

const fixture = JSON.parse(readFileSync("test/fixtures/oxc-capability-refinement-parity.json", "utf8")) as {
  capability: Array<{ source: string; parsed: unknown; prepared: unknown }>;
  refinement: Array<{ source: string; parsed: unknown; link: unknown }>;
};
const capability = fixture.capability[0]!.source, refinement = fixture.refinement[0]!.source;
const json = (value: unknown): unknown => JSON.parse(JSON.stringify(value, (_key, value) => value instanceof Map ? [...value] : value));
const linked = (source: string) => ({ "src/run.ts": '/* uneffect:capability_from "./policy.uneffect.ts#Load" */\nexport function run() {}', "src/policy.uneffect.ts": source });

describe("Oxc capability/refinement migration", () => {
  it.each(fixture.capability)("preserves effects, local schemas, and generated annotations %#", item => {
    expect(json(parseCapabilityDslWithSchemas("policy.uneffect.ts", item.source, "Load"))).toEqual(item.parsed);
    expect(json(prepareCapabilityDslLinks(linked(item.source)))).toEqual(item.prepared);
  });
  it.each(fixture.refinement)("preserves bindings, projections, runtime identity, and manifest %#", item => {
    expect(json(parseRefinementDsl("counter.uneffect.ts", item.source))).toEqual(item.parsed);
    expect(json(resolveRefinementDslLink("src/counter.ts", '/* uneffect:refinement_from "./counter.uneffect.ts#default" */', { "src/counter.uneffect.ts": item.source }))).toEqual(item.link);
  });
  it.each([
    ['optional factory', 'defineCapability({', 'defineCapability?.({'],
    ['optional schema', 'defineEffectSchema({', 'defineEffectSchema?.({'],
    ['optional descriptor', 'Console()', 'Console?.()'],
    ['type-only import', 'import {', 'import type {'],
    ['schema extra field', 'name: "Audit",', 'name: "Audit", unknown: 1,'],
    ['schema extra argument', 'arguments: ["literal"] });', 'arguments: ["literal"] }, {});'],
    ['computed property', 'effects:', '["effects"]:'],
    ['duplicate property', 'effects: [Console()]', 'effects: [Console()], effects: []'],
  ])("rejects unsupported capability %s", (_name, from, to) => {
    expect(() => parseCapabilityDslWithSchemas("invalid.uneffect.ts", capability.replace(from!, to!), "Log")).toThrow();
  });
  it.each([
    ['optional factory', 'defineRefinement({', 'defineRefinement?.({'],
    ['optional projection', 'identityProjection("value")', 'identityProjection?.("value")'],
    ['optional runtime', 'globalRuntime()', 'globalRuntime?.()'],
    ['type-only helper', 'import { defineRefinement', 'import type { defineRefinement'],
    ['duplicate action', 'actions: { increment }', 'actions: { increment, increment }'],
    ['duplicate abstraction', 'value: identityProjection("value")', 'value: identityProjection("value"), value: identityProjection("other")'],
    ['prototype abstraction', 'value: identityProjection("value")', '__proto__: identityProjection("value")'],
    ['computed key', 'actions:', '["actions"]:'],
  ])("rejects unsupported refinement %s", (_name, from, to) => {
    expect(() => parseRefinementDsl("invalid.uneffect.ts", refinement.replace(from!, to!))).toThrow();
  });
  it("rejects parser recovery and annotation escapes", () => {
    expect(() => parseCapabilityDslWithSchemas("invalid.uneffect.ts", capability + "const = ;", "Load")).toThrow();
    expect(() => parseRefinementDsl("invalid.uneffect.ts", refinement + "const = ;")).toThrow();
    expect(() => prepareCapabilityDslLinks(linked(capability.replaceAll('metric.write', 'metric*/write')))).toThrow();
  });
  it("keeps delimiters inside literal builtin atoms", () => {
    const result = parseCapabilityDslWithSchemas("policy.uneffect.ts", capability.replace('"featureFlag", "counter"', '"a | b"'), "Load");
    expect(result.effects).toContainEqual(expect.objectContaining({ name: "GlobalVarsRead", arguments: [{ kind: "finite", atoms: [{ kind: "literal", value: "a | b" }] }] }));
  });
  it("loads source APIs with JavaScript TypeScript imports blocked", () => {
    const script = `
      import { registerHooks } from 'node:module'; import assert from 'node:assert/strict';
      registerHooks({ resolve(specifier, context, next) {
        if (/^(?:typescript(?:\\/|$)|@typescript\\/typescript6(?:\\/|$))/.test(specifier)) throw new Error('JavaScript compiler forbidden: ' + specifier);
        return next(specifier, context);
      } });
      const api = await import('./src/spec/analysis-api.ts');
      const capability = ${JSON.stringify(capability)}, refinement = ${JSON.stringify(refinement)};
      assert.equal(api.parseCapabilityDslWithSchemas('policy.uneffect.ts', capability, 'Load').schemas.get('Audit').name, 'Audit');
      assert.equal(api.prepareCapabilityDslSources({'src/run.ts':'/* uneffect:capability_from "./policy.uneffect.ts#Load" */','src/policy.uneffect.ts':capability}).schemas.size, 1);
      assert.equal(api.parseRefinementDsl('counter.uneffect.ts', refinement).create, 'create');
      assert.equal(api.resolveRefinementDslSourceLink('src/counter.ts','/* uneffect:refinement_from "./counter.uneffect.ts#default" */',{'src/counter.uneffect.ts':refinement}).schema, 'uneffect-refinement-bindings/v1');
    `;
    execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { stdio: "pipe", timeout: 30_000 });
  });
});
