import { resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { analyzeCorsaEffectParity } from "../src/corsa-effect-parity.js";
import { openCorsaApiFrontend } from "../src/corsa-api-frontend.js";
import { loadTypeScriptProject } from "../src/typescript-project.js";

describe("Corsa effect parity sidecar", () => {
  it("agrees for authenticated globals and reports an unsupported stable alias", async () => {
    const configFile = resolve("test/fixtures/corsa-api-project/tsconfig.json");
    const project = loadTypeScriptProject(configFile);
    const program = ts.createProgram(project.fileNames, project.compilerOptions);
    const frontend = await openCorsaApiFrontend({ configFile });
    try {
      const result = analyzeCorsaEffectParity(program, frontend);
      expect(result.schema).toBe("uneffect-corsa-effect-parity/v1");
      expect(result.entries.map(({ operation, status }) => [operation, status])).toEqual([
        ["Console", "agree"],
        ["Fetch", "agree"],
        ["Fetch", "mismatch"],
      ]);
      expect(result.entries[2]).toMatchObject({ typescript: "Fetch" });
      expect(result.entries[2]?.corsa).toBeUndefined();
      expect(result.summary).toEqual({ agree: 2, mismatch: 1 });
    } finally {
      frontend.close();
    }
  });
});
