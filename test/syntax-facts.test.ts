import { describe, expect, it } from "vitest";
import { analyzeTypeScriptControlFlow } from "../src/frontends/typescript/typescript-control-flow.js";
import {
  collectSyntaxFacts,
  enclosingFunction,
  parseSyntaxFacts,
  syntaxFactsCoverageDomains,
  syntaxFactsSchema,
} from "../src/frontends/oxc-syntax.js";

describe("versioned syntax facts", () => {
  it("keeps object handler bodies separate from their enclosing factory", () => {
    const source = `function factory() { return {
      run() { console.log("method") },
      arrow: () => console.log("arrow"),
      expression: function internal() { console.log("expression") },
      ["fixed-name"]() { console.log("literal") },
    }; }`;
    const facts = collectSyntaxFacts("handlers.ts", source);
    expect(facts.coverage.every(entry => entry.status === "complete")).toBe(true);
    expect(facts.functions.map(({ name, kind }) => ({ name, kind }))).toEqual([
      { name: "factory", kind: "function" },
      { name: "run", kind: "method" },
      { name: "arrow", kind: "arrow" },
      { name: "expression", kind: "function-expression" },
      { name: "fixed-name", kind: "method" },
    ]);
    expect(facts.sites.filter(site => site.name === "log").map(site => enclosingFunction(facts.functions, site.start)?.name))
      .toEqual(["run", "arrow", "expression", "fixed-name"]);
    expect(parseSyntaxFacts(JSON.parse(JSON.stringify(facts)))).toEqual(facts);
  });

  it("collects literal member names while retaining dynamic-key exclusions", () => {
    const source = `function run(key: string) {
      console["log"]("hello"); new globalThis["WebSocket"]("wss://example.com");
      void document["title"]; void [1, 2][0];
      console[key]("dynamic"); void document[key];
    }`;
    const facts = collectSyntaxFacts("literal-members.ts", source);
    expect(facts.sites.map(({ kind, name }) => ({ kind, name }))).toEqual([
      { kind: "call", name: "log" }, { kind: "construct", name: "WebSocket" },
      { kind: "property", name: "title" }, { kind: "property", name: "0" },
    ]);
    expect(facts.coverage.flatMap(entry => entry.exclusions).map(entry => entry.reason))
      .toEqual(["computed-call-target", "computed-property"]);
    expect(parseSyntaxFacts(JSON.parse(JSON.stringify(facts)))).toEqual(facts);
  });

  it("does not admit dynamic object names or accessor invocation semantics", () => {
    const facts = collectSyntaxFacts("dynamic-handlers.ts", `const key = "run";
      const handlers = { [key]() { console.log("dynamic") }, get value() { console.log("getter"); return 1; } };`);
    expect(facts.coverage.find(entry => entry.domain === "function-boundaries")?.exclusions.map(entry => entry.reason))
      .toEqual(["computed-function-name", "object-member-function"]);
  });

  it("does not drop property reads used as call or constructor arguments", () => {
    const facts = collectSyntaxFacts("arguments.ts", `function run(key: string) {
      consume(document["title"]); new Box(document.title); consume(document[key]);
    }`);
    expect(facts.sites.filter(site => site.kind === "property").map(site => site.name)).toEqual(["title", "title"]);
    expect(facts.coverage.find(entry => entry.domain === "property-sites")?.exclusions)
      .toEqual([expect.objectContaining({ reason: "computed-property" })]);
  });

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
