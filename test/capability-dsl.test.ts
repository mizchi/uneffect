import { describe, expect, it } from "vitest";
import { verifyUneffectProject } from "../src/project-verification.js";
import { parseCapabilityDsl } from "../src/capability-dsl.js";
import { effectSchema } from "../src/capabilities.js";

const specification = `
  import { Builtin, Console, Custom, Fetch, FsRead, Throw, defineCapability, defineEffectSchema } from "@mizchi/uneffect/spec";
  const Audit = defineEffectSchema({ name: "Audit", arguments: ["literal"] });
  export const Log = defineCapability({ effects: [Console()] });
  export const AuditOnly = defineCapability({ effects: [Custom(Audit, { arguments: [["metric.write"]] })] });
  export const Load = defineCapability({ effects: [
    Fetch({ methods: ["GET", "POST"], urls: ["https://api.example.com/**"] }),
    FsRead({ paths: ["$WORKSPACE_ROOT/config/**"] }),
    Throw(TypeError),
    Builtin("Net", { arguments: [["api.example.com:443"]] }),
    Builtin("Dom", { arguments: [["AttributeWrite"], ["root"]] }),
    Builtin("CookieRead"),
    Custom(Audit, { arguments: [["metric.write"]] }),
  ] });
`;

describe("TypeScript capability DSL", () => {
  it("lowers typed capability descriptors to the existing effect IR", () => {
    expect(parseCapabilityDsl("policy.uneffect.ts", specification, "Load")).toEqual([
      expect.objectContaining({ kind: "capability", name: "Fetch" }),
      expect.objectContaining({ kind: "capability", name: "FsRead" }),
      { kind: "throw", errorType: "TypeError" },
      expect.objectContaining({ kind: "capability", name: "Net", arguments: [{ kind: "finite", atoms: [{ kind: "host", value: "api.example.com:443" }] }] }),
      expect.objectContaining({ kind: "capability", name: "Dom", arguments: [
        { kind: "finite", atoms: [{ kind: "token", value: "AttributeWrite" }] },
        { kind: "finite", atoms: [{ kind: "region", value: "root" }] },
      ] }),
      expect.objectContaining({ kind: "capability", name: "CookieRead" }),
      expect.objectContaining({ kind: "capability", name: "Audit", arguments: [
        { kind: "finite", atoms: [{ kind: "literal", value: "metric.write" }] },
      ] }),
    ]);
    expect(effectSchema("Audit")).toBeUndefined();
  });

  it("connects a capability export to the existing effect analyzer", async () => {
    const result = await verifyUneffectProject({ files: {
      "src/log.ts": `/* uneffect:capability_from "./policy.uneffect.ts#Log" */\nexport function log() { console.log("ok") }`,
      "src/policy.uneffect.ts": specification,
    } });
    expect(result.diagnostics).toEqual([]);
    expect(result.effects.summaries.find((summary) => summary.functionName === "log"))
      .toMatchObject({ evidence: "verified", effects: [{ kind: "capability", name: "Console" }] });
  });

  it("keeps user schemas project-local while the analyzer understands their domains", async () => {
    const result = await verifyUneffectProject({ files: {
      "src/audit.ts": `/* uneffect:capability_from "./policy.uneffect.ts#AuditOnly" */\nexport function audit() {}`,
      "src/policy.uneffect.ts": specification,
    } });
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ functionName: "audit", kind: "unused", effect: 'Audit<"metric.write">' }));
    expect(result.diagnostics).not.toContainEqual(expect.objectContaining({ functionName: "audit", kind: "unknown" }));
    expect(effectSchema("Audit")).toBeUndefined();
  });

  it("fails closed on dynamic descriptors and missing exports", () => {
    expect(() => parseCapabilityDsl("bad.uneffect.ts", specification.replace("Console()", "chooseEffect()"), "Log"))
      .toThrow(/unsupported capability descriptor/);
    expect(() => parseCapabilityDsl("bad.uneffect.ts", specification, "Missing"))
      .toThrow(/does not export capability Missing/);
    expect(() => parseCapabilityDsl("bad.uneffect.ts", specification.replace('Builtin("Net", { arguments: [["api.example.com:443"]] })', 'Builtin("UnknownEffect")'), "Load"))
      .toThrow(/unknown builtin Effect schema/);
    expect(() => parseCapabilityDsl("bad.uneffect.ts", specification.replace('arguments: ["literal"]', 'arguments: ["mystery"]'), "Load"))
      .toThrow(/unknown Effect schema atom domain/);
  });
});
