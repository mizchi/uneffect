import { defineConfig } from "vitest/config";
import { ciTestTiers, resolveCiTestIncludes, type CiTestTier } from "./ci/test-tiers.js";

const requestedTier = process.env.UNEFFECT_CI_TIER as CiTestTier | undefined;
if (requestedTier && !(requestedTier in ciTestTiers)) throw new Error(`unknown UNEFFECT_CI_TIER: ${requestedTier}`);
const tierIncludes = resolveCiTestIncludes(requestedTier, process.argv);

export default defineConfig({
  test: {
    // Vitest 4 no longer excludes the compiled outDir in this project by
    // default. The TypeScript sources are authoritative; testing dist as a
    // second stale suite doubles solver load and can execute old schemas.
    include: tierIncludes ? [...tierIncludes] : ["**/*.test.ts"],
    exclude: ["dist/**", "node_modules/**"],
    // Several integration tests spawn Quint/Z3. Bounding workers avoids CPU
    // oversubscription turning the default 5s timeout into nondeterministic CI failures.
    maxWorkers: process.env.CI ? 2 : 4,
    // Z3's WASM heap is process-local and can approach its 2 GiB ceiling. Running
    // several solver-heavy files concurrently has caused both missing proof
    // candidates and hard Emscripten OOM aborts locally. Only the manifest-
    // checked verifier-free fast tier may schedule files concurrently.
    fileParallelism: requestedTier === "fast",
    // The fast tier parallelizes files even outside hosted CI. Solver-backed
    // project verification then sees the same contention as CI and needs the
    // same wall-clock allowance. A project-verification test takes about 19s
    // alone and can exceed 30s under two solver-heavy workers; assertion
    // failures and solver unknowns still fail normally rather than being
    // converted into passes.
    testTimeout: process.env.CI || requestedTier === "fast" ? 60_000 : 15_000,
  },
});
