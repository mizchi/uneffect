import { describe, expect, it } from "vitest";
import { verifyUneffectProject } from "../src/project-verification.js";
import { parseCapabilityDsl } from "../src/capability-dsl.js";

const specification = `
  import { Console, Fetch, FsRead, Throw, defineCapability } from "@mizchi/uneffect/spec";
  export const Log = defineCapability({ effects: [Console()] });
  export const Load = defineCapability({ effects: [
    Fetch({ methods: ["GET", "POST"], urls: ["https://api.example.com/**"] }),
    FsRead({ paths: ["$WORKSPACE_ROOT/config/**"] }),
    Throw(TypeError),
  ] });
`;

describe("TypeScript capability DSL", () => {
  it("lowers typed capability descriptors to the existing effect IR", () => {
    expect(parseCapabilityDsl("policy.uneffect.ts", specification, "Load")).toEqual([
      expect.objectContaining({ kind: "capability", name: "Fetch" }),
      expect.objectContaining({ kind: "capability", name: "FsRead" }),
      { kind: "throw", errorType: "TypeError" },
    ]);
  });

  it("connects a capability export to the existing effect analyzer", async () => {
    const result = await verifyUneffectProject({ files: {
      "src/log.ts": `/* uneffect:capability from "./policy.uneffect.ts#Log" */\nexport function log() { console.log("ok") }`,
      "src/policy.uneffect.ts": specification,
    } });
    expect(result.diagnostics).toEqual([]);
    expect(result.effects.summaries.find((summary) => summary.functionName === "log"))
      .toMatchObject({ evidence: "verified", effects: [{ kind: "capability", name: "Console" }] });
  });

  it("fails closed on dynamic descriptors and missing exports", () => {
    expect(() => parseCapabilityDsl("bad.uneffect.ts", specification.replace("Console()", "chooseEffect()"), "Log"))
      .toThrow(/unsupported capability descriptor/);
    expect(() => parseCapabilityDsl("bad.uneffect.ts", specification, "Missing"))
      .toThrow(/does not export capability Missing/);
  });
});
