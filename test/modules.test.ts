import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { builtinContractRegistry, findBuiltinContract } from "../src/builtin-contracts.js";
import { effectSchema, parseEffectExpression } from "../src/capabilities.js";
import { installUneffectModules, parseUneffectModuleManifest } from "../src/modules.js";
import { createEvidenceArtifact, validateEvidenceArtifact } from "../src/evidence.js";
import ts from "typescript";

const auditModule = {
  $schema: "./node_modules/@mizchi/uneffect/schemas/uneffect-module-v1.schema.json",
  schema: "uneffect-module/v1",
  name: "@acme/audit-semantics",
  version: "1.2.0",
  namespace: "Acme.Audit",
  evidence: "trusted",
  trustOwner: "security-platform",
  trustReason: "reviewed against @acme/audit 4.1.0",
  effectSchemas: [{ name: "Acme.Audit.Emit", version: 1, arguments: ["literal"] }],
  registry: {
    schema: "uneffect-registry/v1",
    builtinRegistryVersion: 2,
    contracts: [{
      symbol: { module: "@acme/audit", export: "emit" },
      runtime: { kind: "package", version: "4.1.0" },
      evidence: "trusted",
      trustOwner: "security-platform",
      trustReason: "reviewed emit boundary",
      operation: { kind: "scoped-effect", effect: "Acme.Audit.Emit", effectScopeArgument: 0, effectScopeKind: "literal" },
    }],
  },
} as const;

describe("declarative Uneffect modules", () => {
  it("publishes a versioned manifest schema", () => {
    const schema = JSON.parse(readFileSync("schemas/uneffect-module-v1.schema.json", "utf8")) as any;
    expect(schema.properties.schema.const).toBe("uneffect-module/v1");
    expect(schema.properties.evidence.const).toBe("trusted");
  });

  it("installs namespaced schemas and reviewed contracts with a digest ledger", () => {
    const installed = installUneffectModules([auditModule], builtinContractRegistry);
    expect(effectSchema("Acme.Audit.Emit")).toEqual({ name: "Acme.Audit.Emit", version: 1, arguments: ["literal"] });
    expect(parseEffectExpression('Acme.Audit.Emit<"login">')).toMatchObject({ name: "Acme.Audit.Emit" });
    expect(findBuiltinContract(installed.registry, { module: "@acme/audit", export: "emit" })?.operation)
      .toMatchObject({ kind: "scoped-effect", effect: "Acme.Audit.Emit" });
    expect(installed.ledger).toEqual([expect.objectContaining({
      name: "@acme/audit-semantics", version: "1.2.0", namespace: "Acme.Audit", evidence: "trusted",
      digest: expect.stringMatching(/^[a-f0-9]{64}$/),
    })]);
    const fileName = "/virtual/module-ledger.ts", source = ts.createSourceFile(fileName, "export const x = 1", ts.ScriptTarget.Latest, true);
    const host = ts.createCompilerHost({});
    host.getSourceFile = (name) => name === fileName ? source : undefined;
    host.fileExists = (name) => name === fileName;
    host.readFile = (name) => name === fileName ? source.text : undefined;
    const program = ts.createProgram([fileName], {}, host);
    const artifact = createEvidenceArtifact(program, source, [], installed.registry);
    expect(artifact.modules).toEqual(installed.ledger);
    expect(validateEvidenceArtifact(program, source, [], { ...artifact, modules: [] }, installed.registry).reasons)
      .toContain("module-ledger-mismatch");
  });

  it.each([
    [{ ...auditModule, evidence: "verified" }, "evidence must be trusted"],
    [{ ...auditModule, effectSchemas: [{ name: "Other.Emit", version: 1, arguments: [] }] }, "must start with namespace"],
    [{ ...auditModule, ignored: true }, "unknown key"],
  ])("fails closed for unsafe module manifests %#", (input, message) => {
    expect(() => parseUneffectModuleManifest(input)).toThrow(message);
  });

  it("rejects two modules that claim the same semantic identity", () => {
    expect(() => installUneffectModules([auditModule, auditModule], builtinContractRegistry)).toThrow(/duplicate module/);
  });

  it("rolls back effect schemas when a contract fails validation", () => {
    const broken = {
      ...auditModule,
      name: "@acme/broken-semantics",
      namespace: "Acme.Broken",
      effectSchemas: [{ name: "Acme.Broken.Emit", version: 1, arguments: [] }],
      registry: { ...auditModule.registry, ignored: true },
    };
    expect(() => installUneffectModules([broken], builtinContractRegistry)).toThrow(/unknown key/);
    expect(effectSchema("Acme.Broken.Emit")).toBeUndefined();
  });
});
