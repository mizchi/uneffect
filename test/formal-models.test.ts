import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, test } from "vitest";
import { analyzeReactProgram, analyzeReactSemantics, generateReactActionQueueQuint, generateReactLifecycleQuint, generateReactNestedSuspenseQuintFromAnalysis, generateReactSuspenseBoundaryQuint, generateReactSuspenseBoundaryQuintFromAnalysis, generateReactSuspenseFallbackQuint, generateReactSuspenseTreeQuintFromAnalysis, generateReactTransitionQuint, generateReactTransitionSuspenseQuint } from "../src/react-semantics.js";

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
  test("permits fallback only after a new or urgent Suspense update suspends", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-react-fallback-eligible-"));
    const path = join(directory, "fallback-eligible.qnt");
    const boundary = {
      instance: "Suspense@0", primary: "Results", fallback: "Spinner",
      primaryKey: "results.tsx:Results", fallbackKey: "results.tsx:Spinner",
      primaryNodes: [{ kind: "component" as const, displayName: "Results", componentKey: "results.tsx:Results" }],
      span: { start: 0, end: 1 },
    };
    const run = (scenario: "newlyMountedTransition" | "urgentUpdate", fault: "none" | "early-fallback" | "unresolved-commit" | "retained-fallback") => {
      writeFileSync(path, generateReactSuspenseFallbackQuint("react_fallback_eligible", boundary, {
        scenario,
        allowFallbackBeforeSuspension: fault === "early-fallback",
        allowCommitBeforeResolution: fault === "unresolved-commit",
        allowFallbackAfterCommit: fault === "retained-fallback",
      }));
      return spawnSync("pnpm", ["exec", "quint", "run", path,
        "--invariant=reactSuspenseFallbackSafe", "--max-steps=9", "--max-samples=10000",
        "--seed=0x66616c6c6261636b", "--verbosity=1"], { encoding: "utf8", timeout: 30_000 });
    };
    try {
      for (const scenario of ["newlyMountedTransition", "urgentUpdate"] as const) {
        const valid = run(scenario, "none");
        expect(valid.error).toBeUndefined();
        expect(valid.status, `${scenario}: ${valid.stdout}${valid.stderr}`).toBe(0);
        expect(valid.stdout + valid.stderr).toContain("No violation found");
      }
      for (const fault of ["early-fallback", "unresolved-commit", "retained-fallback"] as const) {
        const broken = run("newlyMountedTransition", fault);
        expect(broken.error).toBeUndefined();
        expect(broken.status, `${fault}: ${broken.stdout}${broken.stderr}`).toBe(1);
        expect(broken.stdout + broken.stderr).toContain("Invariant violated");
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("keeps already revealed Suspense content visible during a Transition retry", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-react-transition-suspense-"));
    const path = join(directory, "transition-suspense.qnt");
    const boundary = {
      instance: "Suspense@0", primary: "Results", fallback: "Spinner",
      primaryKey: "results.tsx:Results", fallbackKey: "results.tsx:Spinner",
      primaryNodes: [{ kind: "component" as const, displayName: "Results", componentKey: "results.tsx:Results" }],
      span: { start: 0, end: 1 },
    };
    const run = (fault: "none" | "fallback" | "unresolved-commit" | "interrupt-hide") => {
      writeFileSync(path, generateReactTransitionSuspenseQuint("react_transition_suspense", boundary, {
        allowFallbackDuringTransition: fault === "fallback",
        allowCommitBeforeResolution: fault === "unresolved-commit",
        allowHideContentOnInterrupt: fault === "interrupt-hide",
      }));
      return spawnSync("pnpm", ["exec", "quint", "run", path,
        "--invariant=reactTransitionSuspenseSafe", "--max-steps=10", "--max-samples=10000",
        "--seed=0x73757370656e7365", "--verbosity=1"], { encoding: "utf8", timeout: 30_000 });
    };
    try {
      const valid = run("none");
      expect(valid.error).toBeUndefined();
      expect(valid.status, valid.stdout + valid.stderr).toBe(0);
      expect(valid.stdout + valid.stderr).toContain("No violation found");
      for (const fault of ["fallback", "unresolved-commit", "interrupt-hide"] as const) {
        const broken = run(fault);
        expect(broken.error).toBeUndefined();
        expect(broken.status, `${fault}: ${broken.stdout}${broken.stderr}`).toBe(1);
        expect(broken.stdout + broken.stderr).toContain("Invariant violated");
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("keeps a Transition pending through Actions and interruptible render", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-react-transition-"));
    const path = join(directory, "transition.qnt");
    const run = (fault: "none" | "pending" | "unsettled-commit" | "interrupted-commit") => {
      writeFileSync(path, generateReactTransitionQuint("react_transition", {
        maxActions: 3,
        allowEarlyPendingClear: fault === "pending",
        allowCommitBeforeActionsSettle: fault === "unsettled-commit",
        allowCommitInterruptedRender: fault === "interrupted-commit",
      }));
      return spawnSync("pnpm", ["exec", "quint", "run", path,
        "--invariant=reactTransitionSafe", "--max-steps=10", "--max-samples=10000",
        "--seed=0x7472616e73697469", "--verbosity=1"], { encoding: "utf8", timeout: 30_000 });
    };
    try {
      const valid = run("none");
      expect(valid.error).toBeUndefined();
      expect(valid.status, valid.stdout + valid.stderr).toBe(0);
      expect(valid.stdout + valid.stderr).toContain("No violation found");
      for (const fault of ["pending", "unsettled-commit", "interrupted-commit"] as const) {
        const broken = run(fault);
        expect(broken.error).toBeUndefined();
        expect(broken.status, `${fault}: ${broken.stdout}${broken.stderr}`).toBe(1);
        expect(broken.stdout + broken.stderr).toContain("Invariant violated");
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("serializes queued Actions and cancels the tail after failure", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-react-actions-"));
    const path = join(directory, "actions.qnt");
    const run = (fault: "none" | "concurrent" | "after-failure" | "pending") => {
      writeFileSync(path, generateReactActionQueueQuint("react_actions", {
        maxQueuedActions: 3,
        allowConcurrentStart: fault === "concurrent",
        allowStartAfterFailure: fault === "after-failure",
        allowPendingMismatch: fault === "pending",
      }));
      return spawnSync("pnpm", ["exec", "quint", "run", path,
        "--invariant=reactActionQueueSafe", "--max-steps=8", "--max-samples=10000",
        "--seed=0x7265616374616374", "--verbosity=1"], { encoding: "utf8", timeout: 30_000 });
    };
    try {
      const valid = run("none");
      expect(valid.error).toBeUndefined();
      expect(valid.status, valid.stdout + valid.stderr).toBe(0);
      expect(valid.stdout + valid.stderr).toContain("No violation found");
      for (const fault of ["concurrent", "after-failure", "pending"] as const) {
        const broken = run(fault);
        expect(broken.error).toBeUndefined();
        expect(broken.status, `${fault}: ${broken.stdout}${broken.stderr}`).toBe(1);
        expect(broken.stdout + broken.stderr).toContain("Invariant violated");
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

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

  test("keeps a leaf suspension at its nearest nested Suspense boundary", () => {
    const analysis = analyzeReactSemantics("nested-boundary.tsx", `
      import { Suspense } from "react"
      /* uneffect: react component */ function Primary() { return null }
      /* uneffect: react component */ function InnerFallback() { return null }
      /* uneffect: react component */ function OuterFallback() { return null }
      function App() { return <Suspense fallback={<OuterFallback />}><Suspense fallback={<InnerFallback />}><Primary /></Suspense></Suspense> }
    `);
    const directory = mkdtempSync(join(tmpdir(), "uneffect-react-nested-boundary-"));
    const path = join(directory, "nested-boundary.qnt");
    const run = (broken: boolean) => {
      writeFileSync(path, generateReactNestedSuspenseQuintFromAnalysis("react_nested_boundary", analysis, 0, {
        allowAncestorFallbackCommit: broken,
      }));
      return spawnSync("pnpm", ["exec", "quint", "run", path,
        "--invariant=nestedSuspenseSafe", "--max-steps=6", "--max-samples=500",
        "--seed=0x6e65737465645f62", "--verbosity=1"], { encoding: "utf8", timeout: 30_000 });
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

  test("rejects a fallback owned by a different branch of a Suspense tree", () => {
    const sourceText = `
      import { Suspense, use } from "react"
      const innerPromise = Promise.resolve("inner")
      /* uneffect: react component */ function OuterLeaf() { return null }
      /* uneffect: react component */ function InnerLeaf() { use(innerPromise); return null }
      /* uneffect: react component */ function OuterFallback() { return null }
      /* uneffect: react component */ function InnerFallback() { return null }
      function App() { return <Suspense fallback={<OuterFallback />}><><OuterLeaf /><Suspense fallback={<InnerFallback />}><InnerLeaf /></Suspense></></Suspense> }
    `;
    const sourceAnalysis = analyzeReactSemantics("suspense-tree.tsx", sourceText);
    const compilerOptions: ts.CompilerOptions = { target: ts.ScriptTarget.ES2024, jsx: ts.JsxEmit.Preserve, noEmit: true };
    const host = ts.createCompilerHost(compilerOptions), originalGetSourceFile = host.getSourceFile.bind(host);
    host.getSourceFile = (fileName, languageVersion, onError, fresh) => fileName === "suspense-tree.tsx"
      ? ts.createSourceFile(fileName, sourceText, languageVersion, true, ts.ScriptKind.TSX)
      : originalGetSourceFile(fileName, languageVersion, onError, fresh);
    const programResult = analyzeReactProgram(ts.createProgram(["suspense-tree.tsx"], compilerOptions, host)).get("suspense-tree.tsx")!;
    expect(sourceAnalysis.suspenseBoundaries).toHaveLength(programResult.suspenseBoundaries.length);
    const directory = mkdtempSync(join(tmpdir(), "uneffect-react-suspense-tree-"));
    const path = join(directory, "suspense-tree.qnt");
    const run = (broken: boolean) => {
      writeFileSync(path, generateReactSuspenseTreeQuintFromAnalysis("react_suspense_tree", programResult, 0, {
        allowWrongFallbackOwner: broken,
        requireKnownSuspension: true,
      }));
      return spawnSync("pnpm", ["exec", "quint", "run", path,
        "--invariant=suspenseTreeSafe", "--max-steps=6", "--max-samples=800",
        "--seed=0x737573705f747265", "--verbosity=1"], { encoding: "utf8", timeout: 30_000 });
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
});
