import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { uneffectVersion } from "../src/evidence.js";
import { effectBaselineToolVersion } from "../src/effect-baseline.js";

describe("0.3.0 release metadata", () => {
  const manifest = JSON.parse(readFileSync("package.json", "utf8")) as {
    name: string; version: string; main?: string; types?: string;
    exports: Record<string, unknown>; files: string[]; publishConfig: { access: string; provenance?: boolean };
    bin?: Record<string, string>; engines?: Record<string, string>; scripts?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    peerDependenciesMeta?: Record<string, { optional?: boolean }>;
    optionalDependencies?: Record<string, string>;
    repository?: { type: string; url: string };
  };

  it("keeps package and evidence versions synchronized", () => {
    expect(manifest.name).toBe("@mizchi/uneffect");
    expect(manifest.version).toBe("0.3.0");
    expect(uneffectVersion).toBe(manifest.version);
    expect(effectBaselineToolVersion).toBe(manifest.version);
    expect(readFileSync("crates/uneffect-core/Cargo.toml", "utf8")).toContain(`version = "${manifest.version}"`);
  });

  it("publishes explicit runtime, type, schema, and license surfaces", () => {
    expect(manifest.main).toBe("./dist/src/public.js");
    expect(manifest.types).toBe("./dist/src/public.d.ts");
    expect(manifest.exports).toHaveProperty(".");
    expect(manifest.exports).toHaveProperty("./corsa");
    expect(manifest.exports).toHaveProperty("./corsa/api");
    expect(manifest.exports).toHaveProperty("./experimental");
    expect(manifest.exports).toHaveProperty("./spec");
    expect(manifest.exports).toHaveProperty("./schemas/*");
    expect(manifest.files).toEqual(expect.arrayContaining(["dist/src", "README.md", "CHANGELOG.md", "LICENSE", "docs", "schemas"]));
    expect(manifest.publishConfig).toMatchObject({ access: "public", provenance: true });
    expect(manifest.bin).toEqual({ uneffect: "dist/src/cli.js" });
    expect(manifest.engines).toEqual({ node: ">=24" });
    expect(manifest.peerDependencies?.typescript).toBe(">=7.0.0");
    expect(manifest.peerDependencies?.["@typescript/typescript6"]).toBe(">=6.0.2");
    expect(manifest.peerDependenciesMeta?.typescript).toEqual({ optional: true });
    expect(manifest.peerDependenciesMeta?.["@typescript/typescript6"]).toEqual({ optional: true });
    expect(manifest.optionalDependencies?.["@corsa-bind/napi"]).toBe("1.13.1");
    expect(manifest.optionalDependencies?.["@typescript/typescript-darwin-arm64"]).toBe("7.0.2");
    expect(manifest.optionalDependencies?.["@typescript/native-preview"]).toBeUndefined();
    expect(manifest.repository).toEqual({ type: "git", url: "git+https://github.com/mizchi/uneffect.git" });
    expect(manifest.scripts?.prepack).toBe("pnpm build");
    expect(JSON.parse(readFileSync("schemas/uneffect-corsa-api-frontend-v1.schema.json", "utf8"))).toMatchObject({
      title: "Uneffect Corsa API frontend descriptor v1",
      properties: { schema: { const: "uneffect-corsa-api-frontend/v1" } },
    });
    expect(JSON.parse(readFileSync("schemas/uneffect-temporal-model-v1.schema.json", "utf8"))).toMatchObject({
      title: "Uneffect temporal model v1",
      properties: { schema: { const: "uneffect-temporal-model/v1" } },
    });
    expect(JSON.parse(readFileSync("schemas/uneffect-syntax-facts-v1.schema.json", "utf8"))).toMatchObject({
      title: "Uneffect syntax facts v1",
      properties: { schema: { const: "uneffect-syntax-facts/v1" } },
    });
    expect(JSON.parse(readFileSync("schemas/uneffect-typescript-control-flow-v1.schema.json", "utf8"))).toMatchObject({
      title: "Uneffect TypeScript control-flow analysis v1",
      properties: { schema: { const: "uneffect-typescript-control-flow/v1" } },
    });
  });

  it("documents the promoted bounded Corsa and temporal integration contracts", () => {
    const api = readFileSync("docs/public-api.md", "utf8");
    const stability = readFileSync("docs/stability.md", "utf8");
    const readme = readFileSync("README.md", "utf8");
    const matrix = readFileSync("docs/feature-matrix.md", "utf8");
    const changelog = readFileSync("CHANGELOG.md", "utf8");
    expect(api).toContain("`@mizchi/uneffect/corsa/api` | Public integration boundary");
    expect(api).toContain("`generateTemporalModel` and `parseTemporalModelResult`");
    expect(api).toContain("`AsyncSafetyDiagnostic` results");
    expect(api).not.toContain("`@mizchi/uneffect/corsa/api` | Public migration probe");
    expect(stability).toContain("Corsa semantic-query API descriptor");
    expect(stability).toContain("temporal model coverage contract");
    expect(stability).not.toContain("These are still experimental pre-1.0 APIs");
    expect(readme).toContain("two bounded public integration contracts are supported");
    expect(matrix).toContain("| Corsa semantic-query API contract | Tested fragment |");
    expect(matrix).toContain("| Temporal model facade contract | Tested fragment |");
    expect(changelog).toContain("Promoted the high-level temporal/Promise/resource facade contract");
  });

  it("documents the experimental 0.3 release without claiming general verification", () => {
    const changelog = readFileSync("CHANGELOG.md", "utf8"), readme = readFileSync("README.md", "utf8");
    const overview = readFileSync("docs/overview.md", "utf8");
    expect(changelog).toContain("## 0.3.0");
    expect(readme).toContain("0.3 is an experimental release");
    expect(readme).toContain("not a verifier for all of JavaScript");
    expect(readme).toContain("[Public API and compatibility](./docs/public-api.md)");
    expect(readme).toContain("[Feature overview](./docs/overview.md)");
    expect(overview).toContain("# Uneffect feature overview");
    expect(overview).toContain("## Effect tracking");
    expect(overview).toContain("## Hoare-style contracts");
    expect(overview).toContain("## Async, resources, and temporal models");
    expect(overview).toContain("## Programmatic public API");
    expect(overview).toContain("Unsupported or unknown");
  });

  it("publishes 0.3 through a version-guarded OIDC workflow", () => {
    const release = readFileSync(".github/workflows/release-please.yml", "utf8");
    const publish = readFileSync(".github/workflows/publish.yml", "utf8");
    const config = JSON.parse(readFileSync("release-please-config.json", "utf8")) as {
      packages: Record<string, { "extra-files": Array<{ path: string }> }>;
    };
    const releaseState = JSON.parse(readFileSync(".release-please-manifest.json", "utf8")) as Record<string, string>;
    expect(release).toContain("workflow_dispatch:");
    expect(release).toContain("RELEASE_PLEASE_APP_PRIVATE_KEY");
    expect(publish).toContain("release:\n    types: [published]");
    expect(publish).toContain("id-token: write");
    expect(publish).toContain("node ci/verify-release-tag.mjs");
    expect(publish).toContain("npm publish");
    expect(publish).not.toMatch(/NPM_TOKEN|NODE_AUTH_TOKEN/u);
    expect(config.packages["."]?.["extra-files"].map(({ path }) => path)).toEqual(expect.arrayContaining([
      "crates/uneffect-core/Cargo.toml", "src/evidence.ts", "src/effect-baseline.ts",
    ]));
    expect(releaseState).toEqual({ ".": manifest.version });

    const matched = spawnSync(process.execPath, ["ci/verify-release-tag.mjs"], {
      cwd: process.cwd(), env: { ...process.env, GITHUB_REF_NAME: `v${manifest.version}` }, encoding: "utf8",
    });
    expect(matched.status, matched.stderr).toBe(0);
    const mismatched = spawnSync(process.execPath, ["ci/verify-release-tag.mjs"], {
      cwd: process.cwd(), env: { ...process.env, GITHUB_REF_NAME: "v9.9.9" }, encoding: "utf8",
    });
    expect(mismatched.status).toBe(1);
    expect(mismatched.stderr).toContain("refusing to publish");
  });

  it("tests the lifecycle-built tarball as a fresh typed consumer and retains evidence", () => {
    const smoke = readFileSync("ci/smoke-package.mjs", "utf8");
    const workflow = readFileSync(".github/workflows/ci.yml", "utf8");
    const justfile = readFileSync("justfile", "utf8");

    expect(smoke).toContain('execFileSync("npm", ["pack", "--json"');
    expect(smoke).not.toContain('["pack", "--ignore-scripts"');
    for (const entrypoint of [
      '"@mizchi/uneffect"',
      '"@mizchi/uneffect/corsa"',
      '"@mizchi/uneffect/corsa/api"',
      '"@mizchi/uneffect/spec"',
    ]) expect(smoke).toContain(entrypoint);
    expect(smoke).toContain('"@mizchi/uneffect/schemas/uneffect-temporal-model-v1.schema.json"');
    expect(smoke).toContain('"@mizchi/uneffect/schemas/uneffect-corsa-api-frontend-v1.schema.json"');
    expect(smoke).toContain('execFileSync(typescriptCompiler, ["-p", typecheckConfig]');
    expect(smoke).toContain("unknownField");
    expect(smoke).toContain('"--omit=optional"');
    expect(smoke).toContain("No Corsa compiler was supplied");
    expect(smoke).toContain("Corsa API binding @corsa-bind/napi is unavailable");
    expect(smoke).toContain("uneffect.package-evidence/v1");
    expect(smoke).toContain("sha256");
    expect(workflow).toContain("package-contract-evidence-${{ github.run_id }}");
    expect(workflow).toContain(".uneffect/package-evidence");
    expect(justfile).toContain("node ci/smoke-package.mjs");
    expect(readFileSync("docs/stability.md", "utf8")).toContain("uneffect.package-evidence/v1");
    expect(readFileSync("docs/public-api.md", "utf8")).toContain("Other binding initialization or");
    expect(readFileSync("docs/releasing.md", "utf8")).toContain("all three verification fields to be `passed`");
  });
});
