import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { diagnosticHint } from "../src/support/diagnostics.js";
import { prepareCapabilityDslSources } from "../src/effects/capability-dsl-source.js";

describe("bugs found by registry dogfood", () => {
  it.each(["toString", "constructor", "__proto__", "not-a-diagnostic"])("does not return an inherited diagnostic hint for %s", code => {
    expect(diagnosticHint(code)).toBeUndefined();
    expect(diagnosticHint("effect/missing")).toEqual(expect.any(String));
  });

  it("requires capability specification files to belong to the selected project", () => {
    const fixture = JSON.parse(readFileSync("test/fixtures/oxc-capability-refinement-parity.json", "utf8"));
    const specification = fixture.capability[0].source as string;
    const entry = '/* uneffect:capability_from "./policy.uneffect.ts#Load" */\nexport function run() {}';
    const inherited = Object.assign(Object.create({ "src/policy.uneffect.ts": specification }), { "src/run.ts": entry });
    expect(() => prepareCapabilityDslSources(inherited)).toThrow(/does not exist in the selected project/);
    const own = { "src/run.ts": entry, "src/policy.uneffect.ts": specification };
    expect(prepareCapabilityDslSources(own).files["src/run.ts"]).toContain("uneffect:effect");
  });
});
