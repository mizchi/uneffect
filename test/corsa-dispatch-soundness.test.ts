import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkCorsaProject } from "../src/frontends/corsa/corsa-check.js";
import { formatEffect } from "../src/effects/capabilities.js";

async function check(files: Record<string, string>, rootFiles = Object.keys(files)) {
  const directory = mkdtempSync(join(tmpdir(), "uneffect-dispatch-soundness-"));
  try {
    for (const [file, text] of Object.entries(files)) writeFileSync(join(directory, file), text);
    const configFile = join(directory, "tsconfig.json");
    writeFileSync(configFile, JSON.stringify({
      compilerOptions: {
        strict: true, target: "ES2024", module: "NodeNext", lib: ["ES2024", "DOM"], types: [],
        experimentalDecorators: false,
      },
      files: rootFiles,
    }));
    return await checkCorsaProject({ configFile });
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

type Result = Awaited<ReturnType<typeof check>>;

function summary(result: Result, name: string) {
  return result.summaries.find((item) => item.functionName === name);
}

function names(result: Result, name: string): string[] | undefined {
  return summary(result, name)?.effects.map(formatEffect).sort();
}

describe("dispatch soundness", () => {
  it("counts argument positions past a TypeScript this parameter", async () => {
    const result = await check({ "main.ts": `
      function apply(this: void, callback: () => void) { callback(); }
      export function main() { apply(() => { console.log("supplied"); }); }
    ` });
    expect(result.errors).toBe(0);
    // `this` occupies a parameter slot but no argument position, so the obligation is owed at index 0.
    expect(names(result, "main")).toEqual(["Console", "InvokeUserCode"]);
  });

  it("discharges an invoked-parameter obligation at a construction and at internal dispatch", async () => {
    const result = await check({ "main.ts": `
      class Runner {
        constructor(callback: () => void) { callback(); }
        apply(callback: () => void) { callback(); }
        boot(callback: () => void) { this.apply(callback); }
      }
      declare const handler: () => void;
      export function supplied() { new Runner(() => { console.log("built"); }); }
      export function opaque() { new Runner(handler); }
      export function internal(runner: Runner) { return runner; }
    ` });
    expect(result.errors).toBe(0);
    expect(names(result, "supplied")).toEqual(["Console", "InvokeUserCode"]);
    // A construction discharges the constructor's obligation exactly as a plain call discharges a function's.
    expect(summary(result, "opaque")?.evidence).toBe("unknown");
  });

  it("does not trust a parameter a shorthand pattern may have written", async () => {
    const result = await check({ "main.ts": `
      function replacement() { console.log("replaced"); }
      export function apply(callback: () => void) { ({ callback } = { callback: replacement }); callback(); }
    ` });
    // The position query at a shorthand target reports the property, not the binding being assigned.
    expect(summary(result, "apply")?.evidence).toBe("unknown");
    expect(names(result, "apply")).toEqual([]);
  });

  it.each([
    'const Sub = class extends Base { override helper() { console.log("sub"); } };',
    'const Alias = Base; class Sub extends Alias { override helper() { console.log("sub"); } }',
    'declare function mixin(base: typeof Base): typeof Base; class Sub extends mixin(Base) { override helper() { console.log("sub"); } }',
  ])("keeps this dispatch unresolved when a subclass is not identifiable: %s", async (subclass) => {
    const result = await check({ "main.ts": `
      class Base { run() { this.helper(); } helper() {} }
      ${subclass}
      export function main(base: Base) { return base; }
    ` });
    expect(summary(result, "Base.run")?.evidence).toBe("unknown");
    expect(names(result, "Base.run")).toEqual([]);
  });

  it("does not let a static method stand in for the instance method a super call names", async () => {
    const result = await check({ "main.ts": `
      class Base { greet() { console.log("instance"); } static greet() {} }
      class Sub extends Base { override greet() { super.greet(); } }
      export function main(sub: Sub) { return sub; }
    ` });
    expect(result.errors).toBe(0);
    expect(names(result, "Sub.greet")).toEqual(["Console"]);
  });

  it("does not trust a method whose name is assigned anywhere in the analyzed files", async () => {
    const result = await check({ "main.ts": `
      class Base { run() { this.helper(); } helper() {} }
      Base.prototype.helper = function () { console.log("patched"); };
      export function main() { return new Base(); }
    ` });
    expect(summary(result, "Base.run")?.evidence).toBe("unknown");
  });

  it("does not resolve this dispatch outside a class body", async () => {
    const result = await check({ "main.ts": `
      class Shape { area() { return 0; } render() { return this.area(); } }
      export const impostor: Shape = {
        area() { console.log("side effect"); return 0; },
        render() { return this.area(); },
      };
    ` });
    // The object literal's `render` is not the class's, and its receiver is not an instance of the class.
    const literal = result.summaries.filter((item) => item.functionName === "render");
    expect(literal.some((item) => item.evidence === "unknown")).toBe(true);
  });

  it("keeps this dispatch unresolved when a file the project imports was not analyzed", async () => {
    const result = await check({
      "main.ts": `
        import { Sub } from "./sub.js";
        export class Base { run() { this.helper(); } helper() {} }
        export function drive() { return new Sub(); }
      `,
      "sub.ts": `
        import { Base } from "./main.js";
        export class Sub extends Base { override helper() { console.log("sub"); } }
      `,
    }, ["main.ts"]);
    expect(summary(result, "Base.run")?.evidence).toBe("unknown");
  });

  it("resolves a private method regardless of what a file it did not read could declare", async () => {
    const result = await check({
      "main.ts": `
        import { Sub } from "./sub.js";
        export class Base {
          run() { return this.helper(); }
          private helper() { console.log("private"); }
        }
        export function drive() { return new Sub(); }
      `,
      "sub.ts": `
        import { Base } from "./main.js";
        export class Sub extends Base {}
      `,
    }, ["main.ts"]);
    expect(result.errors).toBe(0);
    // TypeScript forbids a subclass from redeclaring a private member and forbids writing it from outside the
    // class body, so no unread file can change which body runs.
    expect(names(result, "Base.run")).toEqual(["Console"]);
    expect(summary(result, "Base.run")?.evidence).toBe("trusted");
  });

  it("does not trust a private method its own class overwrites", async () => {
    const result = await check({ "main.ts": `
      declare function replacement(): void;
      export class Base {
        run() { return this.helper(); }
        private helper() { console.log("private"); }
        swap() { this.helper = replacement; }
      }
    ` });
    expect(summary(result, "Base.run")?.evidence).toBe("unknown");
  });

  it("only counts a member write that could install a function", async () => {
    const result = await check({ "main.ts": `
      export class Widget {
        private readonly tag = 1;
        run() { console.log(this.tag); }
      }
      declare const flags: Record<string, boolean>;
      export function mark(key: string) { flags[key] = true; }
      export function main(widget: Widget) { widget.run(); }
    ` });
    expect(result.errors).toBe(0);
    // A boolean cannot stand in for a method, so the write leaves the class declaration standing.
    expect(names(result, "main")).toEqual(["Console"]);
  });

  it("does not resolve a member call once a computed write could reach the class", async () => {
    const result = await check({ "main.ts": `
      export class Widget {
        private readonly tag = 1;
        run() { console.log(this.tag); }
      }
      export function merge(target: any, key: string, value: unknown) { target[key] = value; }
      export function main(widget: Widget) { widget.run(); }
    ` });
    // A computed write through an `any` receiver could install a function on any object, this class included.
    // (The dynamic key on an `any` receiver is also reported as unsupported syntax, which is a separate finding.)
    expect(summary(result, "main")?.evidence).toBe("unknown");
    expect(names(result, "main")).toEqual([]);
  });

  it("resolves this dispatch when the imported modules were analyzed too", async () => {
    const result = await check({
      "main.ts": `
        import { helper } from "./util.js";
        export class Base { run() { this.log(); } log() { helper(); } }
        export function drive() { return new Base(); }
      `,
      "util.ts": `export function helper() { console.log("shared"); }`,
    });
    expect(result.errors).toBe(0);
    expect(names(result, "Base.run")).toEqual(["Console"]);
  });
});
