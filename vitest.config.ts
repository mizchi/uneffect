import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Several integration tests spawn Quint/Z3. Bounding workers avoids CPU
    // oversubscription turning the default 5s timeout into nondeterministic CI failures.
    maxWorkers: process.env.CI ? 2 : 4,
    // Synchronous verifier subprocesses can occupy every worker long enough for
    // Vitest's worker RPC to time out even though each test succeeds. Keep CI
    // file scheduling serial; the dedicated Z3/Quint jobs retain suite-level
    // parallelism.
    fileParallelism: !process.env.CI,
    testTimeout: process.env.CI ? 30_000 : 15_000,
  },
});
