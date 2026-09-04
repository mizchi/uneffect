import { describe, expect, it } from "vitest";
import { analyzeTypeScriptControlFlow } from "../src/typescript-control-flow.js";
import {
  collectSyntaxFacts,
  enclosingFunction,
  parseSyntaxFacts,
  syntaxFactsCoverageDomains,
  syntaxFactsSchema,
} from "../src/oxc-syntax.js";

describe("versioned syntax facts", () => {
  it("normalizes supported function boundaries with the TypeScript bridge", () => {
    const source = `
      declare function run(value: number): number;
      declare function read(): number;
      declare function write(value: number): void;
      function top(value: number): number { return run(value) }
      class Box {
        method(value: number): number { return run(value) }
        get value(): number { return read() }
        set value(next: number) { write(next) }
      }
      const arrow = (value: number): number => run(value)
      const expression = function internal(value: number): number { return run(value) }
    `;
    const facts = collectSyntaxFacts("supported.ts", source);
    const typescript = analyzeTypeScriptControlFlow("supported.ts", source);

    expect(facts).toMatchObject({
      schema: syntaxFactsSchema,
      source: {
        fileName: "supported.ts", language: "typescript", length: source.length,
        digest: expect.stringMatching(/^[0-9a-f]{64}$/u),
      },
      parser: { name: "oxc-parser", version: expect.stringMatching(/^\d+\.\d+\.\d+/u) },
      coverage: syntaxFactsCoverageDomains.map((domain) => ({ domain, status: "complete", exclusions: [] })),
      errors: [],
    });
    expect(facts.functions.map(({ name, kind, start, end }) => ({ name, kind, start, end }))).toEqual(
      typescript.functions.map(({ name, kind, span }) => ({ name, kind, start: span.start, end: span.end })),
    );
    expect(facts.functions.map(({ name }) => name)).toEqual([
      "top", "Box.method", "Box.value", "Box.value", "arrow", "expression",
    ]);
    expect(parseSyntaxFacts(JSON.parse(JSON.stringify(facts)))).toEqual(facts);
  });

  it("reports unsupported syntax instead of silently dropping effect-bearing sites", () => {
    const source = `
      const key = "run" as const
      class Box { [key](): void { console.log("computed method") } }
      function main(registry: Record<string, () => void>): void {
        registry[key]()
        new registry[key]()
        void registry[key]
      }
    `;
    const facts = collectSyntaxFacts("unsupported.ts", source);
    expect(facts.coverage).toEqual([
      {
        domain: "function-boundaries", status: "partial",
        exclusions: [expect.objectContaining({ reason: "computed-function-name" })],
      },
      {
        domain: "call-sites", status: "partial",
        exclusions: [expect.objectContaining({ reason: "computed-call-target" })],
      },
      {
        domain: "construct-sites", status: "partial",
        exclusions: [expect.objectContaining({ reason: "computed-construct-target" })],
      },
      {
        domain: "property-sites", status: "partial",
        exclusions: [expect.objectContaining({ reason: "computed-property" })],
      },
    ]);
  });

  it("keeps anonymous boundaries and fails closed on call forms without a stable target", () => {
    const source = `
      export default function () { console.log("default") }
      function main(factory: () => () => void): void {
        [1].map(() => console.log("callback"))
        factory()()
        new (factory())()
        tag\`template\`
        void import("module")
      }
    `;
    const facts = collectSyntaxFacts("boundaries.ts", source);

    expect(facts.functions.map(({ name, kind }) => ({ name, kind }))).toEqual([
      { name: "<anonymous>", kind: "function" },
      { name: "main", kind: "function" },
      { name: "<anonymous>", kind: "arrow" },
    ]);
    const callbackLog = facts.sites.filter(({ name }) => name === "log")[1];
    expect(callbackLog && enclosingFunction(facts.functions, callbackLog.start)?.kind).toBe("arrow");
    expect(facts.coverage.find(({ domain }) => domain === "call-sites")).toEqual({
      domain: "call-sites",
      status: "partial",
      exclusions: [
        expect.objectContaining({ reason: "unsupported-call-target" }),
        expect.objectContaining({ reason: "tagged-template" }),
        expect.objectContaining({ reason: "dynamic-import" }),
      ],
    });
    expect(facts.coverage.find(({ domain }) => domain === "construct-sites")).toEqual({
      domain: "construct-sites",
      status: "partial",
      exclusions: [expect.objectContaining({ reason: "unsupported-construct-target" })],
    });
  });

  it("rejects forged, incomplete, and internally inconsistent syntax artifacts", () => {
    const result = collectSyntaxFacts("valid.ts", "export function main() { console.log('ok') }");
    expect(() => parseSyntaxFacts({ ...result, invented: true })).toThrow(/unknown key/u);
    expect(() => parseSyntaxFacts({ ...result, coverage: result.coverage.slice(1) })).toThrow(/coverage/u);
    expect(() => parseSyntaxFacts({ ...result, source: { ...result.source, digest: "forged" } })).toThrow(/digest/u);
    expect(() => parseSyntaxFacts({
      ...result,
      sites: result.sites.map((site) => ({ ...site, calleePosition: site.end + 1 })),
    })).toThrow(/calleePosition/u);
    expect(() => parseSyntaxFacts({ ...result, functions: [...result.functions, ...result.functions] }))
      .toThrow(/unique/u);
  });
});
