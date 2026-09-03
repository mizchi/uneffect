import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { openCorsaApiFrontend } from "../src/corsa-api-frontend.js";
import { openTypeScriptSemanticQuery } from "../src/typescript-semantic-query.js";

describe("Corsa API frontend", () => {
  it("resolves TypeScript symbols and types without a TypeScript Program", async () => {
    const file = resolve("test/fixtures/corsa-api-project/index.ts");
    const frontend = await openCorsaApiFrontend({
      configFile: resolve("test/fixtures/corsa-api-project/tsconfig.json"),
      corsaExecutable: resolve("node_modules/.bin/tsgo"),
    });

    try {
      const symbol = frontend.getSymbolAtPosition(file, 13);
      const type = frontend.getTypeAtPosition(file, 13);

      expect(symbol).toMatchObject({ name: "answer" });
      expect(type?.texts).toContain("42");
      expect(frontend.compilerRevision).toMatch(/^corsa-api@/);
    } finally {
      frontend.close();
    }
  });

  it("fails closed when a file does not belong to the project", async () => {
    const frontend = await openCorsaApiFrontend({
      configFile: resolve("test/fixtures/corsa-api-project/tsconfig.json"),
      corsaExecutable: resolve("node_modules/.bin/tsgo"),
    });

    try {
      expect(() => frontend.getTypeAtPosition(resolve("missing.ts"), 0)).toThrow(/not part of the Corsa project/);
    } finally {
      frontend.close();
    }
  });

  it("matches the reference TypeScript semantic-query contract", async () => {
    const configFile = resolve("test/fixtures/corsa-api-project/tsconfig.json");
    const file = resolve("test/fixtures/corsa-api-project/index.ts");
    const corsa = await openCorsaApiFrontend({
      configFile,
      corsaExecutable: resolve("node_modules/.bin/tsgo"),
    });
    const typescript = openTypeScriptSemanticQuery({ configFile });

    try {
      const corsaFact = corsa.queryPosition(file, 13);
      const typescriptFact = typescript.queryPosition(file, 13);
      expect({ symbol: corsaFact.symbol?.name, type: corsaFact.type?.texts[0] }).toEqual({
        symbol: typescriptFact.symbol?.name,
        type: typescriptFact.type?.texts[0],
      });
    } finally {
      corsa.close();
      typescript.close();
    }
  });
});
