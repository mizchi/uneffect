import { readFileSync, rmSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { writeEphemeralCorsaProject } from "../src/frontends/corsa/corsa-project.js";
import { collectSyntaxFacts } from "../src/frontends/oxc-syntax.js";
import { parseOxcSource, topLevelOxcFunctions } from "../src/frontends/oxc/source.js";

const jsxComponent = 'export function view(label: string) { return <div className="row">{label}</div>; }';
const angleAssertion = "export function widen(value: unknown) { return <string>value; }";

describe("shared Oxc parser language selection", () => {
  it("reads a .tsx file with the TSX grammar instead of rejecting its JSX", () => {
    const source = parseOxcSource("component.tsx", jsxComponent);
    expect(topLevelOxcFunctions(source).map(entry => entry.node.id.name)).toEqual(["view"]);
  });

  it("accepts the generic arrow form that only the TSX grammar disambiguates", () => {
    const source = parseOxcSource("identity.tsx", "export function make() { const id = <T,>(value: T) => value; return id; }");
    expect(topLevelOxcFunctions(source).map(entry => entry.node.id.name)).toEqual(["make"]);
  });

  it("keeps a .ts file on the TypeScript grammar, where the same angle brackets are an assertion", () => {
    const source = parseOxcSource("assert.ts", angleAssertion);
    expect(topLevelOxcFunctions(source).map(entry => entry.node.id.name)).toEqual(["widen"]);
  });

  it("rejects a TypeScript-only assertion written in a .tsx file rather than reading it as a ts file", () => {
    expect(() => parseOxcSource("assert.tsx", angleAssertion)).toThrow(/invalid TypeScript syntax/);
  });

  it("opens a file-specified check under a project that admits JSX", () => {
    const { configFile, directory } = writeEphemeralCorsaProject(["view.tsx"]);
    try {
      const config = JSON.parse(readFileSync(configFile, "utf8")) as { compilerOptions: { jsx?: string } };
      expect(config.compilerOptions.jsx).toBe("preserve");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("selects the same language the syntax-facts producer reports", () => {
    expect(collectSyntaxFacts("component.tsx", jsxComponent).source.language).toBe("tsx");
    expect(collectSyntaxFacts("assert.ts", angleAssertion).source.language).toBe("typescript");
    expect(() => parseOxcSource("component.tsx", jsxComponent)).not.toThrow();
    expect(() => parseOxcSource("assert.ts", angleAssertion)).not.toThrow();
  });
});
