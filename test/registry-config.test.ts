import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { builtinContractRegistry, findBuiltinContract, findModuleInitializationContract } from "../src/builtin-contracts.js";
import { loadBuiltinRegistryConfig, parseBuiltinRegistryConfig } from "../src/registry-config.js";

describe("versioned caller-owned registry configuration", () => {
  it("publishes a JSON Schema matching the runtime schema discriminator", () => {
    const schema = JSON.parse(readFileSync("schemas/uneffect-registry-v1.schema.json", "utf8")) as {
      $id: string; properties: { schema: { const: string }; builtinRegistryVersion: { const: number } };
      $defs: {
        symbol: { properties: { path: { minItems: number } } };
        builtinContract: { properties: { semantics: { $ref: string } } };
        builtinSemantics: { properties: { schema: { const: string } } };
      };
    };
    expect(schema.$id).toBe("https://github.com/mizchi/uneffect/schemas/uneffect-registry-v1.schema.json");
    expect(schema.properties.schema.const).toBe("uneffect-registry/v1");
    expect(schema.properties.builtinRegistryVersion.const).toBe(builtinContractRegistry.version);
    expect(schema.$defs.builtinContract.properties.semantics.$ref).toBe("#/$defs/builtinSemantics");
    expect(schema.$defs.symbol.properties.path.minItems).toBe(1);
    expect(schema.$defs.builtinSemantics.properties.schema.const).toBe("uneffect-semantic-primitives/v1");
    const manifest = JSON.parse(readFileSync("package.json", "utf8")) as { files: string[] };
    expect(manifest.files).toContain("schemas");
  });

  it("loads reviewed module initialization and static builtin effect overlays", () => {
    const registry = parseBuiltinRegistryConfig({
      $schema: "./node_modules/@mizchi/uneffect/schemas/uneffect-registry-v1.schema.json",
      schema: "uneffect-registry/v1",
      builtinRegistryVersion: 2,
      moduleInitializations: [{
        module: "@acme/telemetry",
        runtime: { kind: "package", version: "4.2.1" },
        effects: ['Net<"intake.example.com:443">'],
        evidence: "trusted",
        trustReason: "reviewed initialization",
        trustOwner: "observability-platform",
        trustExpiresOn: "2027-01-01",
      }],
      contracts: [{
        symbol: { module: "@acme/telemetry", export: "flush" },
        runtime: { kind: "package", version: "4.2.1" },
        evidence: "trusted",
        trustReason: "reviewed flush authority",
        trustOwner: "observability-platform",
        semantics: { schema: "uneffect-semantic-primitives/v1", primitives: [{ kind: "effect", capability: "Console" }] },
      }, {
        symbol: { module: "@acme/telemetry", export: "send" },
        runtime: { kind: "package", version: "4.2.1" },
        evidence: "trusted",
        trustReason: "reviewed generic callback contract",
        trustOwner: "observability-platform",
        semantics: {
          schema: "uneffect-semantic-primitives/v1",
          primitives: [
            { kind: "effect", capability: "Net", scope: { kind: "literal", value: "intake.example.com:443" } },
            { kind: "callback", target: { kind: "argument", index: 1 }, timing: "deferred", queue: "poll", cardinality: "0..1" },
          ],
        },
      }, {
        symbol: { module: "@acme/telemetry", export: "createReporter" },
        runtime: { kind: "package", version: "4.2.1" },
        evidence: "trusted",
        trustReason: "reviewed reporter factory",
        trustOwner: "observability-platform",
        semantics: { schema: "uneffect-semantic-primitives/v1", primitives: [{ kind: "mutate", target: { kind: "argument", index: 0 } }, { kind: "result", refinement: { kind: "fresh" } }] },
        callableResult: {
          semantics: { schema: "uneffect-semantic-primitives/v1", primitives: [{ kind: "effect", capability: "Console" }] },
          capturedCallbackArguments: [0],
        },
      }, {
        symbol: { module: "@acme/telemetry", export: "telemetry", path: ["client", "send"] },
        runtime: { kind: "package", version: "4.2.1" }, evidence: "trusted",
        trustReason: "reviewed rooted member", trustOwner: "observability-platform",
        semantics: { schema: "uneffect-semantic-primitives/v1", primitives: [{ kind: "effect", capability: "Console" }] },
      }],
    }, builtinContractRegistry);

    expect(registry.moduleInitializations[0]).toMatchObject({ module: "@acme/telemetry" });
    expect(registry.contracts[0]).toMatchObject({
      symbol: { module: "@acme/telemetry", export: "flush" },
      runtime: { kind: "package", version: "4.2.1" },
      semantics: { primitives: [{ kind: "effect", capability: "Console" }] },
    });
    expect(registry.contracts[1]).toMatchObject({
      symbol: { module: "@acme/telemetry", export: "send" },
      semantics: { schema: "uneffect-semantic-primitives/v1", primitives: [
        expect.objectContaining({ kind: "effect", capability: "Net" }),
        expect.objectContaining({ kind: "callback", queue: "poll" }),
      ] },
    });
    expect(registry.moduleInitializations).toContain(builtinContractRegistry.moduleInitializations[0]);
    expect(registry.contracts[2]).toMatchObject({
      semantics: { primitives: [{ kind: "mutate", target: { kind: "argument", index: 0 } }, { kind: "result", refinement: { kind: "fresh" } }] },
      callableResult: { semantics: { primitives: [{ kind: "effect", capability: "Console" }] }, capturedCallbackArguments: [0] },
    });
    expect(registry.contracts[3]).toMatchObject({
      symbol: { module: "@acme/telemetry", export: "telemetry", path: ["client", "send"] },
    });
  });

  it.each([
    [{ schema: "uneffect-registry/v2", builtinRegistryVersion: 2 }, "unsupported schema"],
    [{ schema: "uneffect-registry/v1", builtinRegistryVersion: 1 }, "builtin registry version"],
    [{ schema: "uneffect-registry/v1", builtinRegistryVersion: 2, ignored: true }, "unknown key"],
    [{ schema: "uneffect-registry/v1", builtinRegistryVersion: 2, moduleInitializations: [{
      module: "node:path", runtime: { kind: "package", version: "24" }, effects: [],
      evidence: "trusted", trustReason: "wrong runtime kind", trustOwner: "platform",
    }] }, "node: modules require a node runtime"],
    [{ schema: "uneffect-registry/v1", builtinRegistryVersion: 2, contracts: [{
      symbol: { module: "x", export: "f" }, runtime: { kind: "package", version: "1.0.0" }, evidence: "verified",
      semantics: { schema: "uneffect-semantic-primitives/v1", primitives: [{ kind: "effect", capability: "Console" }] },
    }] }, "evidence must be trusted"],
    [{ schema: "uneffect-registry/v1", builtinRegistryVersion: 2, contracts: [{
      symbol: { module: "x", export: "f", path: [] }, runtime: { kind: "package", version: "1.0.0" }, evidence: "trusted",
      trustReason: "reviewed", trustOwner: "platform",
    }] }, "expected at least one member"],
    [{ schema: "uneffect-registry/v1", builtinRegistryVersion: 2, contracts: [{
      symbol: { module: "x", export: "f" }, runtime: { kind: "package", version: "1.0.0" }, evidence: "trusted",
      semantics: { schema: "uneffect-semantic-primitives/v1", primitives: [{ kind: "effect", capability: "Fetch<" }] },
    }] }, "invalid effect"],
    [{ schema: "uneffect-registry/v1", builtinRegistryVersion: 2, contracts: [{
      symbol: { module: "x", export: "f" }, runtime: { kind: "package", version: "1.0.0" }, evidence: "trusted",
      trustReason: "reviewed", trustOwner: "platform", trustExpiresOn: "2027-02-30",
      semantics: { schema: "uneffect-semantic-primitives/v1", primitives: [{ kind: "effect", capability: "Console" }] },
    }] }, "valid calendar date"],
    [{ schema: "uneffect-registry/v1", builtinRegistryVersion: 2, contracts: [{
      symbol: { module: "x", export: "f" }, runtime: { kind: "package", version: "1.0.0" }, evidence: "trusted",
      trustReason: "reviewed", trustOwner: "platform",
      semantics: { schema: "uneffect-semantic-primitives/v1", primitives: [{ kind: "effect", capability: "Fetch<", scope: { kind: "value", target: { kind: "argument", index: 0 } } }] },
    }] }, "effect capability name"],
    [{ schema: "uneffect-registry/v1", builtinRegistryVersion: 2, contracts: [{
      symbol: { module: "external-package", export: "pureFactory" }, evidence: "trusted",
      trustReason: "reviewed", trustOwner: "platform",
    }] }, "package contracts require a package runtime"],
    [{ schema: "uneffect-registry/v1", builtinRegistryVersion: 2, contracts: [{
      symbol: { module: "global", export: "badMutation" }, evidence: "trusted",
      trustReason: "reviewed", trustOwner: "platform", receiverMutation: "yes",
    }] }, "unknown key"],
    [{ schema: "uneffect-registry/v1", builtinRegistryVersion: 2, contracts: [{
      symbol: { module: "x", export: "f" }, runtime: { kind: "package", version: "1.0.0" }, evidence: "trusted",
      trustReason: "reviewed", trustOwner: "platform",
      semantics: { schema: "uneffect-semantic-primitives/v1", primitives: [{ kind: "mystery" }] },
    }] }, "unsupported semantic primitive"],
  ])("rejects malformed or unsafe configuration %#", (input, message) => {
    expect(() => parseBuiltinRegistryConfig(input, builtinContractRegistry)).toThrow(message);
  });

  it("reports JSON parse errors with the configuration path", async () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-registry-config-"));
    const fileName = join(directory, "uneffect.registry.json");
    try {
      writeFileSync(fileName, "{ broken");
      await expect(loadBuiltinRegistryConfig(fileName)).rejects.toThrow(fileName);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("replaces same-identity base entries so stale defaults cannot be a fallback", () => {
    const registry = parseBuiltinRegistryConfig({
      schema: "uneffect-registry/v1", builtinRegistryVersion: 2,
      moduleInitializations: [{
        module: "typescript", runtime: { kind: "package", version: "99.0.0" }, effects: ["Console"],
        evidence: "trusted", trustReason: "application review", trustOwner: "compiler-platform",
      }],
      contracts: [{
        symbol: { module: "console", export: "log" }, evidence: "trusted",
        runtime: { kind: "package", version: "1.0.0" },
        trustReason: "application override", trustOwner: "runtime-platform",
      semantics: { schema: "uneffect-semantic-primitives/v1", primitives: [{ kind: "effect", capability: "Audit" }] },
      }],
      declarations: [{ library: "lib.dom.d.ts", compilerVersion: "custom", sha256: "a".repeat(64) }],
    }, builtinContractRegistry);

    expect(findModuleInitializationContract(registry, "typescript", { packageVersion: "6.0.3" })).toBeUndefined();
    expect(findBuiltinContract(registry, { module: "console", export: "log" })?.semantics?.primitives).toEqual([{ kind: "effect", capability: "Audit" }]);
    expect(registry.contracts.filter((item) => item.symbol.module === "console" && item.symbol.export === "log")).toHaveLength(1);
    expect(registry.declarations.filter((item) => item.library === "lib.dom.d.ts")).toEqual([
      { library: "lib.dom.d.ts", compilerVersion: "custom", sha256: "a".repeat(64) },
    ]);
  });
});
