import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { uneffectVersion } from "../src/evidence.js";

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
    expect(readFileSync("crates/uneffect-core/Cargo.toml", "utf8")).toContain(`version = "${manifest.version}"`);
  });

  it("publishes explicit runtime, type, schema, and license surfaces", () => {
    expect(manifest.main).toBe("./dist/src/public.js");
    expect(manifest.types).toBe("./dist/src/public.d.ts");
    expect(manifest.exports).toHaveProperty(".");
    expect(manifest.exports).toHaveProperty("./corsa");
    expect(manifest.exports).toHaveProperty("./experimental");
    expect(manifest.exports).toHaveProperty("./spec");
    expect(manifest.exports).toHaveProperty("./schemas/*");
    expect(manifest.files).toEqual(expect.arrayContaining(["dist/src", "README.md", "CHANGELOG.md", "LICENSE", "docs", "schemas"]));
    expect(manifest.publishConfig).toMatchObject({ access: "public", provenance: true });
    expect(manifest.bin).toEqual({ uneffect: "dist/src/cli.js" });
    expect(manifest.engines).toEqual({ node: ">=24" });
    expect(manifest.peerDependencies?.typescript).toBe(">=6.0.0-dev.20260820 <7");
    expect(manifest.peerDependenciesMeta?.typescript).toEqual({ optional: true });
    expect(manifest.optionalDependencies?.["@corsa-bind/napi"]).toBe("1.13.0");
    expect(manifest.optionalDependencies?.["@typescript/typescript-darwin-arm64"]).toBe("7.0.2");
    expect(manifest.optionalDependencies?.["@typescript/native-preview"]).toBeUndefined();
    expect(manifest.repository).toEqual({ type: "git", url: "git+https://github.com/mizchi/uneffect.git" });
    expect(manifest.scripts?.prepack).toBe("pnpm build");
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
});
