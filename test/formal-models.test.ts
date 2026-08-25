import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { analyzeReactSemantics, generateReactLifecycleQuint, generateReactSuspenseBoundaryQuint, generateReactSuspenseBoundaryQuintFromAnalysis } from "../src/react-semantics.js";

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

  test("rejects commit effects produced only by a discarded concurrent render", () => {
    const analysis = analyzeReactSemantics("search-results.tsx", `
      import { useEffect } from "react"
      /* uneffect: react component */
      function SearchResults() {
        useEffect(() => { console.log("commit") }, [])
        return null
      }
    `);
    const directory = mkdtempSync(join(tmpdir(), "uneffect-react-interruption-"));
    const path = join(directory, "interruption.qnt");
    const run = (broken: boolean) => {
      writeFileSync(path, generateReactLifecycleQuint("react_interruption", analysis.components[0]!, "concurrentInterruption", {
        allowCommitEffectsWithoutCommit: broken,
      }));
      return spawnSync("pnpm", ["exec", "quint", "run", path,
        "--invariant=reactLifecycleSafe", "--max-steps=5", "--max-samples=500",
        "--seed=0x696e746572727570", "--verbosity=1"], { encoding: "utf8", timeout: 30_000 });
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

  test("rejects dependency setup owned by an uncommitted generation", () => {
    const analysis = analyzeReactSemantics("room.tsx", `
      import { useEffect } from "react"
      /* uneffect: react component */
      function Room({ id }: { id: string }) {
        useEffect(() => { console.log("connect", id); return () => console.log("disconnect", id) }, [id])
        return null
      }
    `);
    const directory = mkdtempSync(join(tmpdir(), "uneffect-react-generation-"));
    const path = join(directory, "generation.qnt");
    const run = (broken: boolean) => {
      writeFileSync(path, generateReactLifecycleQuint("react_generation", analysis.components[0]!, "dependencyChange", {
        allowSetupFromWrongCommit: broken,
      }));
      return spawnSync("pnpm", ["exec", "quint", "run", path,
        "--invariant=reactLifecycleSafe", "--max-steps=6", "--max-samples=500",
        "--seed=0x67656e6572617469", "--verbosity=1"], { encoding: "utf8", timeout: 30_000 });
    };
    try {
      const valid = run(false);
      expect(valid.error).toBeUndefined();
      expect(valid.status, valid.stdout + valid.stderr).toBe(0);
      const broken = run(true);
      expect(broken.error).toBeUndefined();
      expect(broken.status, broken.stdout + broken.stderr).toBe(1);
      expect(broken.stdout + broken.stderr).toContain("Invariant violated");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("rejects a Suspense retry commit before its suspension resolves", () => {
    const analysis = analyzeReactSemantics("profile.tsx", `
      import { useEffect } from "react"
      /* uneffect: react component */
      function Profile() { useEffect(() => { console.log("visible") }, []); return null }
    `);
    const directory = mkdtempSync(join(tmpdir(), "uneffect-react-suspense-"));
    const path = join(directory, "suspense.qnt");
    const run = (broken: boolean) => {
      writeFileSync(path, generateReactLifecycleQuint("react_suspense", analysis.components[0]!, "suspenseRetry", {
        allowRetryBeforeResolution: broken,
      }));
      return spawnSync("pnpm", ["exec", "quint", "run", path,
        "--invariant=reactLifecycleSafe", "--max-steps=6", "--max-samples=500",
        "--seed=0x73757370656e7365", "--verbosity=1"], { encoding: "utf8", timeout: 30_000 });
    };
    try {
      const valid = run(false);
      expect(valid.error).toBeUndefined();
      expect(valid.status, valid.stdout + valid.stderr).toBe(0);
      const broken = run(true);
      expect(broken.error).toBeUndefined();
      expect(broken.status, broken.stdout + broken.stderr).toBe(1);
      expect(broken.stdout + broken.stderr).toContain("Invariant violated");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("rejects a repeated Suspense attempt before the prior suspension resolves", () => {
    const analysis = analyzeReactSemantics("repeated-profile.tsx", `
      import { useEffect } from "react"
      /* uneffect: react component */
      function Profile() { useEffect(() => { console.log("visible") }, []); return null }
    `);
    const directory = mkdtempSync(join(tmpdir(), "uneffect-react-repeated-suspense-"));
    const path = join(directory, "repeated-suspense.qnt");
    const run = (broken: boolean) => {
      writeFileSync(path, generateReactLifecycleQuint("react_repeated_suspense", analysis.components[0]!, "repeatedSuspenseRetry", {
        allowRetryBeforeResolution: broken,
      }));
      return spawnSync("pnpm", ["exec", "quint", "run", path,
        "--invariant=reactLifecycleSafe", "--max-steps=8", "--max-samples=750",
        "--seed=0x7265706561746564", "--verbosity=1"], { encoding: "utf8", timeout: 30_000 });
    };
    try {
      const valid = run(false);
      expect(valid.error).toBeUndefined();
      expect(valid.status, valid.stdout + valid.stderr).toBe(0);
      const broken = run(true);
      expect(broken.error).toBeUndefined();
      expect(broken.status, broken.stdout + broken.stderr).toBe(1);
      expect(broken.stdout + broken.stderr).toContain("Invariant violated");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("rejects primary Effect setup before matching fallback cleanup", () => {
    const analyze = (name: string) => analyzeReactSemantics(`${name}.tsx`, `
      import { useEffect } from "react"
      /* uneffect: react component */
      function ${name}() { useEffect(() => { console.log("setup"); return () => console.log("cleanup") }, []); return null }
    `).components[0]!;
    const primary = analyze("Profile");
    const fallback = analyze("Spinner");
    const directory = mkdtempSync(join(tmpdir(), "uneffect-react-fallback-"));
    const path = join(directory, "fallback.qnt");
    const run = (fault: "none" | "setup" | "reveal") => {
      writeFileSync(path, generateReactSuspenseBoundaryQuint("react_fallback", primary, fallback, {
        allowPrimarySetupBeforeFallbackCleanup: fault === "setup",
        allowRevealBeforeResolution: fault === "reveal",
      }));
      return spawnSync("pnpm", ["exec", "quint", "run", path,
        "--invariant=suspenseBoundarySafe", "--max-steps=10", "--max-samples=1000",
        "--seed=0x66616c6c6261636b", "--verbosity=1"], { encoding: "utf8", timeout: 30_000 });
    };
    try {
      const valid = run("none");
      expect(valid.error).toBeUndefined();
      expect(valid.status, valid.stdout + valid.stderr).toBe(0);
      for (const fault of ["setup", "reveal"] as const) {
        const broken = run(fault);
        expect(broken.error).toBeUndefined();
        expect(broken.status, broken.stdout + broken.stderr).toBe(1);
        expect(broken.stdout + broken.stderr).toContain("Invariant violated");
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("runs the source-extracted Suspense boundary projection", () => {
    const analysis = analyzeReactSemantics("extracted-boundary.tsx", `
      import { Suspense, useEffect } from "react"
      /* uneffect: react component */ function Primary() { useEffect(() => () => console.log("hide"), []); return null }
      /* uneffect: react component */ function Fallback() { useEffect(() => () => console.log("hide"), []); return null }
      function App() { return <Suspense fallback={<Fallback />}><Primary /></Suspense> }
    `);
    const directory = mkdtempSync(join(tmpdir(), "uneffect-react-extracted-fallback-"));
    const path = join(directory, "extracted-fallback.qnt");
    try {
      writeFileSync(path, generateReactSuspenseBoundaryQuintFromAnalysis("react_extracted_fallback", analysis));
      const result = spawnSync("pnpm", ["exec", "quint", "run", path,
        "--invariant=suspenseBoundarySafe", "--max-steps=10", "--max-samples=1000",
        "--seed=0x6578747261637465", "--verbosity=1"], { encoding: "utf8", timeout: 30_000 });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(result.stdout + result.stderr).toContain("No violation found");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
