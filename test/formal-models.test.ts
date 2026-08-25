import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { analyzeReactSemantics, generateReactLifecycleQuint } from "../src/react-semantics.js";

const commonArgs = [
  "exec",
  "quint",
  "run",
  "--invariant=cacheIsSound",
  "--max-steps=10",
  "--max-samples=100",
  "--seed=0x123456789abcdef",
  "--verbosity=1",
];

function runModel(path: string) {
  return spawnSync("pnpm", [...commonArgs.slice(0, 3), path, ...commonArgs.slice(3)], {
    encoding: "utf8",
    timeout: 30_000,
  });
}

describe("async invalidation Quint model", () => {
  test("preserves cache soundness when suspension invalidates facts", () => {
    const result = runModel("specs/invalidate.qnt");
    expect(result.error).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout + result.stderr).toContain("No violation found");
  });

  test("the invariant detects the deliberately stale-cache model", () => {
    const result = runModel("specs/invalidate-broken.qnt");
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toContain("Invariant violated");
  });
});

describe("React lifecycle Quint projection", () => {
  test("preserves setup/cleanup order and exposes an early-cleanup counterexample", () => {
    const analysis = analyzeReactSemantics("panel.tsx", `
      import { useEffect } from "react"
      /* uneffect: react component */
      function Panel() {
        useEffect(() => { console.log("setup"); return () => console.log("cleanup") }, [])
        return null
      }
    `);
    const directory = mkdtempSync(join(tmpdir(), "uneffect-react-quint-"));
    const path = join(directory, "react.qnt");
    const run = (broken: boolean) => {
      writeFileSync(path, generateReactLifecycleQuint("react_lifecycle", analysis.components[0]!, "strictModeDevelopment", {
        allowCleanupBeforeSetup: broken,
      }));
      return spawnSync("pnpm", ["exec", "quint", "run", path,
        "--invariant=reactLifecycleSafe", "--max-steps=6", "--max-samples=500",
        "--seed=0x756e656666656374", "--verbosity=1"], { encoding: "utf8", timeout: 30_000 });
    };
    try {
      const valid = run(false);
      expect(valid.error).toBeUndefined();
      expect(valid.status, valid.stdout + valid.stderr).toBe(0);
      expect(valid.stdout + valid.stderr).toContain("No violation found");
      const broken = run(true);
      expect(broken.error).toBeUndefined();
      expect(broken.status, broken.stdout + broken.stderr).toBe(1);
      expect(broken.stdout + broken.stderr).toContain("Invariant violated");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
