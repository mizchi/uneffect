import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { openCorsaApiFrontend, resolveCorsaExecutable } from "../src/corsa-api-frontend.js";
import { openTypeScriptSemanticQuery } from "../src/typescript-semantic-query.js";

describe("Corsa API frontend", () => {
  it("resolves the package-owned TypeScript 7 native compiler without a consumer TypeScript 6 install", () => {
    expect(resolveCorsaExecutable({ cwd: resolve("test/fixtures/corsa-api-project") }))
      .toMatch(/@typescript\/typescript-[^/]+\/lib\/tsc(?:\.exe)?$/);
  });

  it("prefers an explicitly pinned compiler executable", () => {
    expect(resolveCorsaExecutable({
      cwd: resolve("test/fixtures/corsa-api-project"),
      corsaExecutable: "./vendor/tsgo",
    })).toBe(resolve("test/fixtures/corsa-api-project/vendor/tsgo"));
  });

  it("resolves TypeScript symbols and types without a TypeScript Program", async () => {
    const file = resolve("test/fixtures/corsa-api-project/index.ts");
    const frontend = await openCorsaApiFrontend({
      configFile: resolve("test/fixtures/corsa-api-project/tsconfig.json"),
      corsaExecutable: resolveCorsaExecutable(),
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

  it("uses the package-owned prebuilt compiler by default", async () => {
    const file = resolve("test/fixtures/corsa-api-project/index.ts");
    const frontend = await openCorsaApiFrontend({
      configFile: resolve("test/fixtures/corsa-api-project/tsconfig.json"),
    });
    try {
      expect(frontend.queryPosition(file, 13)).toMatchObject({
        symbol: { name: "answer" },
        type: { texts: ["42"] },
      });
    } finally {
      frontend.close();
    }
  });

  it("classifies only checker-authenticated DOM globals in the first effect slice", async () => {
    const file = resolve("test/fixtures/corsa-api-project/index.ts");
    const source = readFileSync(file, "utf8");
    const frontend = await openCorsaApiFrontend({ configFile: resolve("test/fixtures/corsa-api-project/tsconfig.json") });
    try {
      const consoleCall = source.indexOf("console.log(path)");
      const fetchCall = source.indexOf("fetch(\"https:");
      const localConsole = source.indexOf("console.log(\"local\")");
      const localFetch = source.indexOf("fetch(\"local\")");
      expect(frontend.classifyBuiltinCall(file, { calleePosition: consoleCall + "console.".length, receiverPosition: consoleCall }))
        .toMatchObject({ operation: "Console", symbol: { name: "log" }, receiver: { name: "console" } });
      expect(frontend.classifyBuiltinCall(file, { calleePosition: fetchCall })).toMatchObject({ operation: "Fetch" });
      expect(frontend.classifyBuiltinCall(file, { calleePosition: source.indexOf("request(") }))
        .toMatchObject({ operation: "Fetch", symbol: { name: "fetch" } });
      expect(frontend.classifyBuiltinCall(file, { calleePosition: localConsole + "console.".length, receiverPosition: localConsole })).toBeNull();
      expect(frontend.classifyBuiltinCall(file, { calleePosition: localFetch })).toBeNull();
    } finally {
      frontend.close();
    }
  });

  it("fails closed for a re-exported filesystem alias that Corsa cannot canonicalize yet", async () => {
    const file = resolve("test/fixtures/corsa-api-project/index.ts");
    const source = readFileSync(file, "utf8");
    const frontend = await openCorsaApiFrontend({ configFile: resolve("test/fixtures/corsa-api-project/tsconfig.json") });
    try {
      expect(frontend.classifyBuiltinCall(file, { calleePosition: source.indexOf("readText(path") })).toBeNull();
    } finally {
      frontend.close();
    }
  });

  it("fails closed when a file does not belong to the project", async () => {
    const frontend = await openCorsaApiFrontend({
      configFile: resolve("test/fixtures/corsa-api-project/tsconfig.json"),
      corsaExecutable: resolveCorsaExecutable(),
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
      corsaExecutable: resolveCorsaExecutable(),
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

  it("uses the checker symbol batch endpoint and exposes bounded alias traversal", async () => {
    const configFile = resolve("test/fixtures/corsa-api-project/tsconfig.json");
    const file = resolve("test/fixtures/corsa-api-project/index.ts");
    const source = readFileSync(file, "utf8");
    const frontend = await openCorsaApiFrontend({ configFile });
    try {
      const positions = [source.indexOf("console.log(path)"), source.indexOf("readText(path")];
      const symbols = frontend.getSymbolsAtPositions(file, positions);
      expect(symbols.map((symbol) => symbol?.name)).toEqual(["console", "readText"]);
      expect(symbols[0]).toEqual(frontend.getSymbolAtPosition(file, positions[0]!));
      const immediate = frontend.getImmediateAliasedSymbol(symbols[1]!);
      expect(immediate).toMatchObject({ name: "readText" });
      expect(immediate?.declarations?.[0]).toMatch(/fs-bridge\.ts$/);
      expect(frontend.getAliasedSymbol(symbols[1]!)).toMatchObject({ name: "unknown" });
    } finally {
      frontend.close();
    }
  });

  it("finds the 1.13.1 named checker methods on the published N-API client", async () => {
    const { CorsaApiClient } = await import("@corsa-bind/napi");
    const proto = (CorsaApiClient as unknown as { prototype: Record<string, unknown> }).prototype;
    for (const method of [
      "getSymbolsAtPositions", "getAliasedSymbol", "getImmediateAliasedSymbol", "getExportsOfModule",
      "getTypesAtPositions", "getPropertyOfType", "isTypeAssignableTo", "getSymbolOfType",
    ]) {
      expect(typeof proto[method], method).toBe("function");
    }
  });

  it("does not reach named checker relations through untyped callJson strings", () => {
    const source = readFileSync("src/corsa-api-frontend.ts", "utf8");
    for (const method of [
      "getSymbolsAtPositions", "getAliasedSymbol", "getImmediateAliasedSymbol", "getExportsOfModule",
      "getTypesAtPositions", "getPropertyOfType", "isTypeAssignableTo",
    ]) {
      expect(source, method).not.toMatch(new RegExp(String.raw`callJson\(\s*"${method}"`));
    }
    expect(source).not.toMatch(/callJson\(/);
  });

  it("resolves properties and assignability through typed Corsa adapters", async () => {
    const configFile = resolve("test/fixtures/corsa-api-project/tsconfig.json");
    const file = resolve("test/fixtures/corsa-api-project/index.ts");
    const source = readFileSync(file, "utf8");
    const frontend = await openCorsaApiFrontend({ configFile });
    try {
      const stringType = frontend.getTypeAtPosition(file, source.indexOf("path: string"));
      const numberType = frontend.getTypeAtPosition(file, source.indexOf("42"));
      expect(stringType).toMatchObject({ texts: expect.arrayContaining([expect.stringMatching(/string/i)]) });
      expect(frontend.getPropertyOfType(stringType!, "length")).toMatchObject({ name: "length" });
      expect(frontend.getPropertyOfType(stringType!, "__no_such_member__")).toBeNull();
      const fetchType = frontend.getTypeAtPosition(file, source.indexOf("fetch("));
      expect(frontend.getSymbolOfType(fetchType!)).toMatchObject({ name: "fetch" });
      const documentType = frontend.getTypeAtPosition(file, source.indexOf("document.createElement"));
      expect(frontend.getSymbolOfType(documentType!)).toMatchObject({ name: "Document" });
      expect(frontend.getPropertyOfType(documentType!, "createElement")).toMatchObject({ name: "createElement" });
      expect(frontend.isTypeAssignableTo(stringType!, stringType!)).toBe(true);
      expect(frontend.isTypeAssignableTo(numberType!, stringType!)).toBe(false);
    } finally {
      frontend.close();
    }
  });

  it("enumerates local module exports through the typed Corsa facade and TypeScript 6 checker", async () => {
    const configFile = resolve("test/fixtures/corsa-api-project/tsconfig.json");
    const file = resolve("test/fixtures/corsa-api-project/index.ts");
    const source = readFileSync(file, "utf8");
    const specifier = source.indexOf('"./fs-bridge.js"') + 1;
    const frontend = await openCorsaApiFrontend({ configFile });
    const typescript = openTypeScriptSemanticQuery({ configFile });
    try {
      const moduleSymbol = frontend.getSymbolAtPosition(file, specifier);
      expect(moduleSymbol).toMatchObject({ name: expect.stringMatching(/fs-bridge/) });
      const corsaExports = frontend.getExportsOfModule(moduleSymbol!).map((item) => item.name).sort();
      expect(corsaExports).toEqual(["readText"]);
      expect(typescript.getExportsAtPosition(file, specifier).map((item) => item.name).sort())
        .toEqual(corsaExports);
    } finally {
      frontend.close();
      typescript.close();
    }
  });
});
