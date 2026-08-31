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
    };
    expect(schema.$id).toBe("https://github.com/mizchi/uneffect/schemas/uneffect-registry-v1.schema.json");
    expect(schema.properties.schema.const).toBe("uneffect-registry/v1");
    expect(schema.properties.builtinRegistryVersion.const).toBe(builtinContractRegistry.version);
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
        operation: { kind: "effect", effect: "Console" },
      }, {
        symbol: { module: "@acme/telemetry", export: "createReporter" },
        runtime: { kind: "package", version: "4.2.1" },
        evidence: "trusted",
        trustReason: "reviewed reporter factory",
        trustOwner: "observability-platform",
        result: { kind: "fresh" },
        callableResult: {
          operation: { kind: "effect", effect: "Console" },
          capturedCallbackArguments: [0],
        },
      }],
    }, builtinContractRegistry);

    expect(registry.moduleInitializations[0]).toMatchObject({ module: "@acme/telemetry" });
    expect(registry.contracts[0]).toMatchObject({
      symbol: { module: "@acme/telemetry", export: "flush" },
      runtime: { kind: "package", version: "4.2.1" },
      operation: { kind: "effect", effect: "Console" },
    });
    expect(registry.moduleInitializations).toContain(builtinContractRegistry.moduleInitializations[0]);
    expect(registry.contracts[1]).toMatchObject({
      result: { kind: "fresh" },
      callableResult: { operation: { kind: "effect", effect: "Console" }, capturedCallbackArguments: [0] },
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
      operation: { kind: "effect", effect: "Console" },
    }] }, "evidence must be trusted"],
    [{ schema: "uneffect-registry/v1", builtinRegistryVersion: 2, contracts: [{
      symbol: { module: "x", export: "f" }, runtime: { kind: "package", version: "1.0.0" }, evidence: "trusted",
      operation: { kind: "effect", effect: "Fetch<" },
    }] }, "invalid effect"],
    [{ schema: "uneffect-registry/v1", builtinRegistryVersion: 2, contracts: [{
      symbol: { module: "x", export: "f" }, runtime: { kind: "package", version: "1.0.0" }, evidence: "trusted",
      trustReason: "reviewed", trustOwner: "platform", trustExpiresOn: "2027-02-30",
      operation: { kind: "effect", effect: "Console" },
    }] }, "valid calendar date"],
    [{ schema: "uneffect-registry/v1", builtinRegistryVersion: 2, contracts: [{
      symbol: { module: "x", export: "f" }, runtime: { kind: "package", version: "1.0.0" }, evidence: "trusted",
      trustReason: "reviewed", trustOwner: "platform",
      operation: { kind: "scoped-effect", effect: "Fetch<" },
    }] }, "effect capability name"],
    [{ schema: "uneffect-registry/v1", builtinRegistryVersion: 2, contracts: [{
      symbol: { module: "external-package", export: "pureFactory" }, evidence: "trusted",
      trustReason: "reviewed", trustOwner: "platform",
    }] }, "package contracts require a package runtime"],
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
        operation: { kind: "effect", effect: "Audit" },
      }],
      declarations: [{ library: "lib.dom.d.ts", compilerVersion: "custom", sha256: "a".repeat(64) }],
    }, builtinContractRegistry);

    expect(findModuleInitializationContract(registry, "typescript", { packageVersion: "6.0.3" })).toBeUndefined();
    expect(findBuiltinContract(registry, { module: "console", export: "log" })?.operation).toEqual({ kind: "effect", effect: "Audit" });
    expect(registry.contracts.filter((item) => item.symbol.module === "console" && item.symbol.export === "log")).toHaveLength(1);
    expect(registry.declarations.filter((item) => item.library === "lib.dom.d.ts")).toEqual([
      { library: "lib.dom.d.ts", compilerVersion: "custom", sha256: "a".repeat(64) },
    ]);
  });
});
