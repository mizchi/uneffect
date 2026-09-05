import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("repository examples and skill", () => {
  it("keeps every example and dogfood fixture covered by the repository gate", () => {
    const check = readFileSync("ci/check-examples.mjs", "utf8");
    expect(check).toContain('["exec", "tsc", "-p", "examples/tsconfig.json"]');
    expect(check).toContain('file.startsWith("examples/dogfood/")');
    expect(check).toContain("examples not reachable from a test or smoke command");
    expect(check).toContain('["spec", "temporal", "examples/async-patterns.ts"');
    expect(check).toContain('["check", "examples/dogfood/node-cli.ts"]');
  });

  it("validates the distributable Uneffect skill and its references", () => {
    const check = readFileSync("ci/check-skills.mjs", "utf8");
    expect(check).toContain('basename(file) === "SKILL.md"');
    expect(check).toContain('join(dirname(manifest), "agents/openai.yaml")');
    expect(check).toContain("missing local link");
    expect(check).toContain("references removed CLI command");
  });

  it("connects repository artifact checks to local and remote release gates", () => {
    const justfile = readFileSync("justfile", "utf8");
    const workflow = readFileSync(".github/workflows/ci.yml", "utf8");
    expect(justfile).toContain("examples-check:");
    expect(justfile).toContain("skills-check:");
    expect(justfile).toMatch(/ci-fast:[\s\S]*just examples-check[\s\S]*just skills-check/);
    expect(justfile).toMatch(/release-check:[\s\S]*just examples-check[\s\S]*just skills-check/);
    expect(justfile.match(/check --typescript-program --infer[^\n]+src\/doctor-command\.ts/gu)).toHaveLength(1);
    expect(justfile).toContain("check --infer --effect-baseline dogfood/effect-baseline.json src/static-evaluation.ts src/ownership-evidence-cache.ts");
    expect(workflow).toContain("run: just ci-fast");
    expect(workflow).toContain("integration-shard: [core, applications, dogfood]");
    const packageFiles = JSON.parse(readFileSync("package.json", "utf8")).files as string[];
    expect(packageFiles).toEqual(expect.arrayContaining(["examples/*.ts", "skills"]));
  });
});
