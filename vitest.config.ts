import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Several integration tests spawn Quint/Z3. Bounding workers avoids CPU
    // oversubscription turning the default 5s timeout into nondeterministic CI failures.
    maxWorkers: 4,
    testTimeout: 15_000,
  },
});
