import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { uneffectVersion } from "../src/evidence.js";

describe("0.1.0 release metadata", () => {
  const manifest = JSON.parse(readFileSync("package.json", "utf8")) as {
    name: string; version: string; main?: string; types?: string;
    exports: Record<string, unknown>; files: string[]; publishConfig: { access: string; provenance?: boolean };
  };

  it("keeps package and evidence versions synchronized", () => {
    expect(manifest.name).toBe("@mizchi/uneffect");
    expect(manifest.version).toBe("0.1.0");
    expect(uneffectVersion).toBe(manifest.version);
  });

  it("publishes explicit runtime, type, schema, and license surfaces", () => {
    expect(manifest.main).toBe("./dist/src/index.js");
    expect(manifest.types).toBe("./dist/src/index.d.ts");
    expect(manifest.exports).toHaveProperty(".");
    expect(manifest.exports).toHaveProperty("./corsa");
    expect(manifest.exports).toHaveProperty("./schemas/*");
    expect(manifest.files).toEqual(expect.arrayContaining(["dist/src", "README.md", "CHANGELOG.md", "LICENSE", "docs", "schemas"]));
    expect(manifest.publishConfig).toMatchObject({ access: "public", provenance: true });
  });

  it("documents the experimental 0.1 release without claiming general verification", () => {
    const changelog = readFileSync("CHANGELOG.md", "utf8"), readme = readFileSync("README.md", "utf8");
    expect(changelog).toContain("## 0.1.0");
    expect(readme).toContain("0.1 is an experimental release");
    expect(readme).toContain("not a verifier for all of JavaScript");
  });
});
