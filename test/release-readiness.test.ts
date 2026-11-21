import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { uneffectVersion } from "../src/evidence/evidence.js";
import { effectBaselineToolVersion } from "../src/effects/effect-baseline.js";

describe("release metadata", () => {
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
    expect(uneffectVersion).toBe(manifest.version);
    expect(effectBaselineToolVersion).toBe(manifest.version);
    const check = spawnSync(process.execPath, ["ci/bump-version.mjs", "--check"], { encoding: "utf8" });
    expect(check.status, check.stderr).toBe(0);
    expect(check.stdout).toContain(manifest.version);
  });

  it("publishes explicit runtime, type, schema, and license surfaces", () => {
    expect(manifest.main).toBe("./dist/src/api/public.js");
    expect(manifest.types).toBe("./dist/src/api/public.d.ts");
    expect(manifest.exports).toHaveProperty(".");
    expect(manifest.exports).toHaveProperty("./corsa");
    expect(manifest.exports).toHaveProperty("./corsa/api");
    expect(manifest.exports).toHaveProperty("./experimental");
    expect(manifest.exports).toHaveProperty("./experimental/corsa");
    expect(manifest.exports).toHaveProperty("./spec");
    expect(manifest.exports).toHaveProperty("./schemas/*");
    expect(manifest.files).toEqual(expect.arrayContaining(["dist/src", "README.md", "CHANGELOG.md", "LICENSE", "docs", "schemas"]));
    expect(manifest.publishConfig).toMatchObject({ access: "public", provenance: true });
    expect(manifest.bin).toEqual({ uneffect: "dist/src/cli/index.js" });
    expect(manifest.engines).toEqual({ node: ">=24" });
    expect(manifest.peerDependencies).toMatchObject({
      "@informalsystems/quint": ">=0.32.0 <0.33.0",
      "@oxlint/plugins": ">=1.80.0 <2.0.0",
      "corsa-oxlint": ">=1.12.4 <2.0.0",
      "oxlint": ">=1.80.0 <2.0.0",
      "typescript": ">=7.0.0 <8.0.0",
    });
    expect(manifest.peerDependenciesMeta?.typescript).toEqual({ optional: true });
    expect(manifest.peerDependencies?.["@typescript/typescript6"]).toBeUndefined();
    expect(manifest.peerDependenciesMeta?.["@typescript/typescript6"]).toBeUndefined();
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
    const syntaxFacts = JSON.parse(readFileSync("schemas/uneffect-syntax-facts-v1.schema.json", "utf8"));
    expect(syntaxFacts).toMatchObject({
      title: "Uneffect syntax facts v1",
      properties: { schema: { const: "uneffect-syntax-facts/v1" } },
    });
    // A published v1 inventory does not change in place: neither direction of enum drift may pass CI.
    expect(syntaxFacts.$defs.function.properties.kind.enum)
      .toEqual(["function", "method", "getter", "setter", "arrow", "function-expression"]);
    expect(syntaxFacts.$defs.exclusion.properties.reason.enum).toEqual([
      "computed-function-name", "constructor-boundary", "object-member-function",
      "computed-call-target", "unsupported-call-target", "tagged-template", "dynamic-import",
      "computed-construct-target", "unsupported-construct-target", "computed-property",
    ]);
    expect(syntaxFacts.$defs.coverage.properties.domain.enum)
      .toEqual(["function-boundaries", "call-sites", "construct-sites", "property-sites"]);
    expect(syntaxFacts.$defs.site.properties.kind.enum).toEqual(["call", "construct", "property"]);
    const checkSchema = JSON.parse(readFileSync("schemas/uneffect-check-v1.schema.json", "utf8"));
    expect(checkSchema.$defs.diagnostic.properties.domain.enum).toEqual(["syntax", "contract"]);
    expect(checkSchema.$defs.diagnostic.properties.kind.enum).toEqual(["syntax", "contract"]);
    expect(JSON.parse(readFileSync("schemas/uneffect-typescript-control-flow-v1.schema.json", "utf8"))).toMatchObject({
      title: "Uneffect TypeScript control-flow analysis v1",
      properties: { schema: { const: "uneffect-typescript-control-flow/v1" } },
    });
  });

  it("locks exact runtime exports and declaration signatures for every durable entrypoint", () => {
    const baseline = JSON.parse(readFileSync("api/public-api-v0.3.json", "utf8")) as {
      schema: string;
      entrypoints: Record<string, { runtime: string[]; declarations: Array<{ name: string }> }>;
    };
    expect(baseline.schema).toBe("uneffect-public-api-snapshot/v1");
    expect(Object.keys(baseline.entrypoints).sort()).toEqual([".", "./cfg", "./corsa", "./corsa/api", "./impact", "./module-order", "./spec", "./workflow"]);
    expect(baseline.entrypoints["./workflow"]?.runtime).toEqual(["parseWorkflow", "verifyWorkflow"]);
    expect(baseline.entrypoints["./impact"]?.runtime).toEqual(["analyzeImpact", "parseDependencyGraph"]);
    expect(baseline.entrypoints["."]?.runtime).toContain("generateTemporalModel");
    expect(baseline.entrypoints["."]?.runtime).toContain("uneffectDialects");
    expect(baseline.entrypoints["./corsa/api"]?.runtime).toContain("openCorsaApiFrontend");
    expect(baseline.entrypoints["./spec"]?.runtime).toContain("uneffectSpecVersion");

    const corsa = readFileSync("src/api/corsa-public.ts", "utf8");
    expect(corsa).not.toContain("export *");
    expect(corsa).toContain("checkCorsaProject");
    const experimentalCorsa = readFileSync("src/api/corsa-experimental.ts", "utf8");
    expect(experimentalCorsa).toContain('export * from "../frontends/corsa/corsa-checker-exporter.js"');
    expect(experimentalCorsa).toContain('export * from "../frontends/corsa/corsa-builtin-calls.js"');

    const apiCheck = readFileSync("ci/check-public-api.mjs", "utf8");
    expect(apiCheck).toContain("uneffect-public-api-snapshot/v1");
    expect(apiCheck).toContain("public API snapshot drift");
    expect(readFileSync("justfile", "utf8")).toContain("node ci/check-public-api.mjs");
  });

  it("documents the promoted bounded Corsa and temporal integration contracts", () => {
    const api = readFileSync("docs/public-api.md", "utf8");
    const stability = readFileSync("docs/stability.md", "utf8");
    const readme = readFileSync("README.md", "utf8");
    const matrix = readFileSync("docs/feature-matrix.md", "utf8");
    const changelog = readFileSync("CHANGELOG.md", "utf8");
    expect(api).toContain("`@mizchi/uneffect/corsa/api` | Public integration boundary");
    expect(api).toContain("The v1 field and enum inventories are immutable");
    expect(api).toContain("permanent v1 compatibility subset");
    expect(api).toContain("`generateTemporalModel` and `parseTemporalModelResult`");
    expect(api).toContain("`AsyncSafetyDiagnostic` results");
    expect(api).not.toContain("`@mizchi/uneffect/corsa/api` | Public migration probe");
    expect(stability).toContain("Corsa semantic-query API descriptor");
    expect(stability).toContain("temporal model coverage contract");
    expect(stability).toContain("snapshot, v1 authoring subset");
    expect(stability).not.toContain("Public JavaScript APIs, CLI options");
    expect(stability).not.toContain("These are still experimental pre-1.0 APIs");
    expect(readme).toContain("two bounded public integration contracts are supported");
    expect(matrix).toContain("| Corsa semantic-query API contract | Tested fragment |");
    expect(matrix).toContain("| Temporal model facade contract | Tested fragment |");
    expect(changelog).toContain("Promoted the high-level temporal/Promise/resource facade contract");
  });

  it("documents the experimental 0.5 release without claiming general verification", () => {
    const changelog = readFileSync("CHANGELOG.md", "utf8"), readme = readFileSync("README.md", "utf8");
    const overview = readFileSync("docs/overview.md", "utf8");
    expect(changelog).toContain("## 0.3.0");
    expect(changelog).toContain("## 0.4.0");
    expect(changelog).toContain("## 0.5.0");
    expect(readme).toContain("0.5 is an experimental release");
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

  it("publishes on a v* tag push through a version-guarded OIDC workflow", () => {
    const publish = readFileSync(".github/workflows/publish.yml", "utf8");
    for (const retired of [
      ".github/workflows/release-please.yml", "release-please-config.json", ".release-please-manifest.json",
    ]) expect(existsSync(retired), retired).toBe(false);
    expect(publish).toMatch(/^on:\n  push:\n    tags: \['v\*'\]\n\n/mu);
    expect(publish).not.toMatch(/release:\s*\n\s*types:|workflow_dispatch|pull_request/u);
    expect(publish).toContain("contents: write");
    expect(publish).toContain("id-token: write");
    expect(publish).toContain("registry-url: https://registry.npmjs.org");
    expect(publish).not.toMatch(/NPM_TOKEN|NODE_AUTH_TOKEN|RELEASE_PLEASE|create-github-app-token/u);
    for (const action of publish.matchAll(/uses: (\S+)/gu)) expect(action[1]).toMatch(/@[0-9a-f]{40}$/u);

    const steps = [
      "pnpm install --frozen-lockfile",
      "node ci/verify-release-tag.mjs",
      "node ci/bump-version.mjs --check",
      "pnpm exec tsc -p tsconfig.json --noEmit",
      "pnpm vitest run test/release-readiness.test.ts test/effect-baseline.test.ts",
      "pnpm build",
      "npm pack --dry-run",
      "node ci/check-public-api.mjs",
      "node ci/smoke-package.mjs",
      "npm install -g npm@11",
      "npm publish --tag next",
      "node ci/release-notes.mjs",
      "gh release create",
    ].map((step) => [step, publish.indexOf(step)] as const);
    for (const [step, index] of steps) expect(index, step).toBeGreaterThan(-1);
    expect(steps.map(([, index]) => index)).toEqual(steps.map(([, index]) => index).toSorted((a, b) => a - b));
    expect(publish).toContain("--generate-notes");

    const verifyTag = (env: Record<string, string>) => spawnSync(process.execPath, ["ci/verify-release-tag.mjs"], {
      cwd: process.cwd(), env: { ...process.env, GITHUB_REF_TYPE: "tag", ...env }, encoding: "utf8",
    });
    const matched = verifyTag({ GITHUB_REF_NAME: `v${manifest.version}` });
    expect(matched.status, matched.stderr).toBe(0);
    const branch = verifyTag({ GITHUB_REF_NAME: `v${manifest.version}`, GITHUB_REF_TYPE: "branch" });
    expect(branch.status).toBe(1);
    expect(branch.stderr).toContain("not a tag");
    const mismatched = verifyTag({ GITHUB_REF_NAME: "v9.9.9" });
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
      '"@mizchi/uneffect/experimental/corsa"',
      '"@mizchi/uneffect/spec"',
    ]) expect(smoke).toContain(entrypoint);
    expect(smoke).toContain('"@mizchi/uneffect/schemas/uneffect-temporal-model-v1.schema.json"');
    expect(smoke).toContain('"@mizchi/uneffect/schemas/uneffect-corsa-api-frontend-v1.schema.json"');
    expect(smoke).toContain('execFileSync(process.execPath, [typescriptCompiler, "-p", typecheckConfig]');
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
    const releasing = readFileSync("docs/releasing.md", "utf8");
    expect(releasing).toContain("all three verification fields to be `passed`");
    expect(releasing).toContain("api/public-api-v0.3.json");
    expect(releasing).toContain("baseline to hide a removal");
  });
});

describe("release scripts", () => {
  const stamped = ["src/evidence/evidence.ts", "src/effects/effect-baseline.ts"];
  const scratchRoot = (): string => {
    const root = mkdtempSync(join(tmpdir(), "uneffect-release-"));
    for (const file of ["package.json", ...stamped]) {
      mkdirSync(join(root, file, ".."), { recursive: true });
      cpSync(file, join(root, file));
    }
    return root;
  };
  const run = (script: string, args: string[], env: Record<string, string> = {}) =>
    spawnSync(process.execPath, [script, ...args], { encoding: "utf8", env: { ...process.env, ...env } });

  it("marks the stamped runtime versions for the bump script, not release-please", () => {
    for (const file of stamped) {
      const source = readFileSync(file, "utf8");
      expect(source.match(/"[^"]+"; \/\/ x-release-version$/gmu), file).toHaveLength(1);
      expect(source).not.toContain("release-please");
    }
  });

  it("bumps package.json and the stamped runtime versions together", () => {
    const root = scratchRoot();
    try {
      const bumped = run("ci/bump-version.mjs", ["9.8.7-rc.0", "--root", root]);
      expect(bumped.status, bumped.stderr).toBe(0);
      const manifest = readFileSync(join(root, "package.json"), "utf8");
      expect((JSON.parse(manifest) as { version: string }).version).toBe("9.8.7-rc.0");
      expect(manifest.endsWith("}\n")).toBe(true);
      expect(manifest.replace('"version": "9.8.7-rc.0"', "")).toBe(
        readFileSync("package.json", "utf8").replace(/"version": "[^"]+"/u, ""),
      );
      for (const file of stamped) {
        expect(readFileSync(join(root, file), "utf8")).toContain('"9.8.7-rc.0"; // x-release-version');
      }
      expect(run("ci/bump-version.mjs", ["--check", "--root", root]).status).toBe(0);

      const stale = join(root, stamped[1]!);
      writeFileSync(stale, readFileSync(stale, "utf8").replace('"9.8.7-rc.0"', '"0.0.1"'));
      const drift = run("ci/bump-version.mjs", ["--check", "--root", root]);
      expect(drift.status).toBe(1);
      expect(drift.stderr).toContain("src/effects/effect-baseline.ts");
      expect(drift.stderr).toContain("0.0.1");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a missing, v-prefixed, or non-semver version without writing", () => {
    const root = scratchRoot();
    try {
      for (const args of [[], ["v1.2.3"], ["1.2"], ["latest"]]) {
        const result = run("ci/bump-version.mjs", [...args, "--root", root]);
        expect(result.status, args.join(" ")).toBe(1);
        expect(result.stderr).toContain("usage:");
      }
      expect(readFileSync(join(root, "package.json"), "utf8")).toBe(readFileSync("package.json", "utf8"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("extracts one version's release notes from release-please and git-cliff headings", () => {
    const root = mkdtempSync(join(tmpdir(), "uneffect-notes-"));
    try {
      const changelog = join(root, "CHANGELOG.md");
      writeFileSync(changelog, [
        "# Changelog", "", "Header.", "",
        "## 0.6.0 (2026-12-01)", "", "### Added", "", "- Cliff entry by @someone", "",
        "## 0.6.0-rc.0 (2026-11-30)", "", "- Candidate entry", "",
        "## [0.5.1](https://github.com/mizchi/uneffect/compare/v0.5.0...v0.5.1) (2026-09-29)", "",
        "### Fixed", "", "- Release-please entry", "",
        "## 0.5.0", "", "- Plain entry", "",
        "## 0.4.0 - 2026-09-17", "", "- Dated entry", "",
      ].join("\n"));
      const notes = (version: string, env: Record<string, string> = {}) =>
        run("ci/release-notes.mjs", [...(version === "" ? [] : [version]), "--changelog", changelog], env);

      expect(notes("0.6.0").stdout).toBe("### Added\n\n- Cliff entry by @someone\n");
      expect(notes("0.6.0-rc.0").stdout).toBe("- Candidate entry\n");
      expect(notes("0.5.1").stdout).toBe("### Fixed\n\n- Release-please entry\n");
      expect(notes("0.5.0").stdout).toBe("- Plain entry\n");
      expect(notes("0.4.0").stdout).toBe("- Dated entry\n");
      expect(notes("", { GITHUB_REF_NAME: "v0.5.1" }).stdout).toBe("### Fixed\n\n- Release-please entry\n");
      const missing = notes("0.5");
      expect(missing.status).toBe(0);
      expect(missing.stdout).toBe("");
      expect(run("ci/release-notes.mjs", ["0.5.1", "--changelog", join(root, "absent.md")]).stdout).toBe("");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps the changelog prependable by git-cliff", () => {
    const changelog = readFileSync("CHANGELOG.md", "utf8"), cliff = readFileSync("cliff.toml", "utf8");
    const header = /^header = """\n([\s\S]*?)"""$/mu.exec(cliff)?.[1];
    expect(header).toBeDefined();
    expect(changelog.startsWith(`${header}\n## `)).toBe(true);
    expect(changelog).not.toContain("## Unreleased");
    const current = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };
    expect(run("ci/release-notes.mjs", [current.version]).stdout).not.toBe("");
  });
});
