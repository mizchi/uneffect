import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Several integration tests spawn Quint/Z3. Bounding workers avoids CPU
    // oversubscription turning the default 5s timeout into nondeterministic CI failures.
    maxWorkers: process.env.CI ? 2 : 4,
    testTimeout: process.env.CI ? 30_000 : 15_000,
  },
});
