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
      compilerOptions: { strict: true, target: "ES2024", module: "NodeNext", lib: ["ES2024", "DOM"], types: [] },
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

  it("discharges an invoked-parameter obligation at a construction", async () => {
    const result = await check({ "main.ts": `
      class Runner { constructor(callback: () => void) { callback(); } }
      declare const handler: () => void;
      export function supplied() { new Runner(() => { console.log("built"); }); }
      export function opaque() { new Runner(handler); }
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

  it("resolves a hard-private method regardless of what an unread file could declare", async () => {
    const result = await check({
      "main.ts": `
        import { Sub } from "./sub.js";
        export class Base {
          run() { return this.#helper(); }
          #helper() { console.log("private"); }
        }
        export function drive() { return new Sub(); }
      `,
      "sub.ts": `
        import { Base } from "./main.js";
        export class Sub extends Base {}
      `,
    }, ["main.ts"]);
    expect(result.errors).toBe(0);
    // A `#` name is not a property, so no file this run did not read can redeclare or overwrite it.
    expect(names(result, "Base.run")).toEqual(["Console"]);
    expect(summary(result, "Base.run")?.evidence).toBe("trusted");
  });

  it.each([
    'class Sub extends Base { override helper() { console.log("sub"); } }',
    'const Sub = class extends Base { override helper() { console.log("sub"); } };',
    'Base.prototype.helper = function () { console.log("patched"); };',
    'Object.assign(Base.prototype, { helper() { console.log("assigned"); } });',
  ])("does not resolve a public method whatever could replace it: %s", async (replacement) => {
    const result = await check({ "main.ts": `
      class Base { run() { this.helper(); } helper() {} }
      ${replacement}
      export function main() { return new Base(); }
    ` });
    expect(summary(result, "Base.run")?.evidence).toBe("unknown");
    expect(names(result, "Base.run")).toEqual([]);
  });

  it("does not resolve a this call written outside a class body", async () => {
    const result = await check({ "main.ts": `
      class Shape { area() { return 0; } render() { return this.area(); } }
      export const impostor: Shape = {
        area() { console.log("side effect"); return 0; },
        render() { return this.area(); },
      };
    ` });
    // The object literal's `render` is not the class's, and its receiver is not an instance of the class.
    const literal = result.summaries.filter((item) => item.functionName === "render");
    expect(literal.every((item) => item.evidence === "unknown")).toBe(true);
  });

  it("composes an inline handler assigned to an event handler property", async () => {
    const result = await check({ "main.ts": `
      declare const request: XMLHttpRequest;
      declare const handler: () => void;
      export function inline() { request.onload = () => { console.log("done"); }; }
      export function opaque() { request.onerror = handler; }
    ` });
    expect(result.errors).toBe(0);
    expect(names(result, "inline")).toEqual(["Console", "Dom"]);
    expect(summary(result, "opaque")?.evidence).toBe("unknown");
  });

  it("discharges an obligation through a frozen effect table exactly as through a plain call", async () => {
    const result = await check({ "main.ts": `
      function boom() { console.log("effect"); }
      declare const opaque: () => void;
      const table = Object.freeze({ run: (callback: () => void) => { callback(); } });
      export function plain() { table.run(boom); }
      export function held() { table.run(opaque); }
    ` });
    expect(result.errors).toBe(0);
    expect(names(result, "plain")).toEqual(["Console", "InvokeUserCode"]);
    expect(summary(result, "held")?.evidence).toBe("unknown");
  });

  it("supplies the arguments an immediately invoked function receives", async () => {
    const result = await check({ "main.ts": `
      function boom() { console.log("effect"); }
      export function main() { (function (callback: () => void) { callback(); })(boom); }
    ` });
    expect(result.errors).toBe(0);
    expect(names(result, "main")).toEqual(["Console", "InvokeUserCode"]);
  });

  it("does not discharge an obligation with a boundary that owes one of its own", async () => {
    const result = await check({ "main.ts": `
      function boom() { console.log("effect"); }
      function supplier(apply: (inner: () => void) => void) { apply(boom); }
      export function main() { supplier((inner: () => void) => { inner(); }); }
    ` });
    // Whatever fills the supplied boundary's own parameter is chosen inside `supplier`, not at this call.
    expect(summary(result, "main")?.evidence).toBe("unknown");
  });

  it("does not let a nested class body borrow the enclosing class's scope", async () => {
    const result = await check({ "main.ts": `
      class Quiet { constructor() {} }
      class Loud { constructor() { console.log("loud"); } }
      class Outer {
        #step() { return 1; }
        own() { return this.#step(); }
        nest() {
          const Inner = class { #step() { fetch("https://example.com"); return 2; } run() { return this.#step(); } };
          return Inner;
        }
      }
      class Host extends Quiet {
        make() { return class extends Loud { constructor() { super(); } }; }
      }
      export const made = [new Outer(), new Host()];
    ` });
    expect(result.errors).toBe(0);
    // A class this path cannot identify resets the scope, so neither `this.#step()` nor `super()` inside it
    // reaches the enclosing class's declarations.
    expect(names(result, "Outer.own")).toEqual([]);
    expect(summary(result, "Outer.own")?.evidence).toBe("inferred");
    expect(summary(result, "Inner.run")?.evidence).toBe("unknown");
    expect(summary(result, "constructor")?.evidence).toBe("unknown");
  });

  it("does not discharge an obligation with a named boundary that owes one of its own", async () => {
    const result = await check({ "main.ts": `
      function boom() { console.log("effect"); }
      function forwarder(inner: () => void) { inner(); }
      function apply(callback: () => void) { callback(); }
      export function main() { apply(forwarder); }
    ` });
    // `forwarder` owes an argument of its own, and `apply` chooses it, not this call.
    expect(summary(result, "main")?.evidence).toBe("unknown");
  });

  it("does not compose a contract callback or a handler that owes an obligation", async () => {
    const result = await check({ "main.ts": `
      declare const request: XMLHttpRequest;
      function forwarder(inner: () => void) { inner(); }
      export function each(values: Array<() => void>) { values.forEach(forwarder); }
      export function register() { request.onload = forwarder; }
    ` });
    // A contract and an event both supply the callback's arguments themselves, so neither discharges its
    // invoked-parameter obligation here.
    expect(summary(result, "each")?.evidence).toBe("unknown");
    expect(summary(result, "register")?.evidence).toBe("unknown");
  });

  it("charges a static initializer to the scope that evaluates the class declaration", async () => {
    const result = await check({ "main.ts": `
      export function declaresStaticOnly() {
        class Counter { static { console.log("static block"); } }
        return Counter.name;
      }
      export function declaresBoth() {
        class Mixed { static { console.log("static block"); } value = 1; }
        return Mixed.name;
      }
    ` });
    expect(result.errors).toBe(0);
    // A static block runs when the declaration is evaluated, not at construction.
    expect(names(result, "declaresStaticOnly")).toEqual(["Console"]);
    // With a sibling instance initializer the construction boundary covers the class body by span, so the
    // declaring scope is unresolved rather than a proof of effect freedom.
    expect(summary(result, "declaresBoth")?.evidence).toBe("unknown");
  });

  it("does not drop a handler registration through a receiver the checker cannot name", async () => {
    const result = await check({ "main.ts": `
      declare const loose: { onload: (() => void) | null } | null;
      export function opaque() { if (loose) { loose.onload = () => { document.cookie = "a=b"; }; } }
      declare const anything: any;
      export function untyped() { anything.onload = () => { document.cookie = "a=b"; }; }
    ` });
    // A member the checker resolves to no declaration is unknown, never a proof that the assignment did nothing.
    expect(summary(result, "untyped")?.evidence).toBe("unknown");
    expect(names(result, "untyped")).toEqual([]);
  });
});
