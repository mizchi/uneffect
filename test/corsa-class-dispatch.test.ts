import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkCorsaProject } from "../src/frontends/corsa/corsa-check.js";

async function check(files: Record<string, string>) {
  const directory = mkdtempSync(join(tmpdir(), "uneffect-class-dispatch-"));
  try {
    for (const [file, text] of Object.entries(files)) writeFileSync(join(directory, file), text);
    const configFile = join(directory, "tsconfig.json");
    writeFileSync(configFile, JSON.stringify({
      compilerOptions: { strict: true, target: "ES2024", module: "NodeNext", lib: ["ES2024", "DOM"], types: [] },
      files: Object.keys(files),
    }));
    return await checkCorsaProject({ configFile });
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

type Result = Awaited<ReturnType<typeof check>>;

function summary(result: Result, name: string) {
  return result.summaries.find((item) => item.functionName === name);
}

function names(result: Result, name: string): string[] | undefined {
  return summary(result, name)?.effects.map((effect) => effect.kind === "capability" ? effect.name : effect.kind).sort();
}

describe("class construction and in-class dispatch", () => {
  it("links a construction to the constructor the class declares", async () => {
    const result = await check({ "main.ts": `
      class Reporter { constructor() { console.log("built"); } }
      class Quiet { constructor(readonly label: string) {} }
      export function loud() { new Reporter(); }
      export function silent() { new Quiet("x"); }
    ` });
    expect(result.errors).toBe(0);
    expect(names(result, "loud")).toEqual(["Console"]);
    expect(summary(result, "loud")?.evidence).toBe("trusted");
    expect(names(result, "silent")).toEqual([]);
    expect(summary(result, "silent")?.evidence).toBe("inferred");
  });

  it("runs the inherited constructor when a derived class declares none", async () => {
    const result = await check({ "main.ts": `
      class Base { constructor() { console.log("base"); } }
      class Middle extends Base {}
      class Derived extends Middle {}
      export function main() { new Derived(); }
    ` });
    expect(result.errors).toBe(0);
    expect(names(result, "main")).toEqual(["Console"]);
    expect(summary(result, "main")?.evidence).toBe("trusted");
  });

  it("carries the base constructor through an explicit super call", async () => {
    const result = await check({ "main.ts": `
      class Base { constructor() { console.log("base"); } }
      class Derived extends Base { constructor() { super(); localStorage.setItem("k", "v"); } }
      export function main() { new Derived(); }
    ` });
    expect(result.errors).toBe(0);
    expect(names(result, "Derived.constructor")).toEqual(["Console", "LocalStorageWrite"]);
    expect(names(result, "main")).toEqual(["Console", "LocalStorageWrite"]);
  });

  it("stays unknown when the base class has no analyzed body", async () => {
    const result = await check({ "main.ts": `
      declare class External { constructor(); }
      class Derived extends External { constructor() { super(); } }
      export function main() { new Derived(); }
    ` });
    expect(summary(result, "Derived.constructor")?.evidence).toBe("unknown");
    expect(summary(result, "main")?.evidence).toBe("unknown");
  });

  it("resolves a call on a hard-private method", async () => {
    const result = await check({ "main.ts": `
      class Widget {
        run() { this.#helper(); }
        #helper() { console.log("help"); }
      }
      export function main(widget: Widget) { widget.run(); }
    ` });
    expect(result.errors).toBe(0);
    // A `#` name is not a property: no subclass redeclares it, nothing outside the class body writes it, and
    // neither `Object.assign`, `Object.defineProperty` nor `delete` reaches it.
    expect(names(result, "Widget.run")).toEqual(["Console"]);
    expect(summary(result, "Widget.run")?.evidence).toBe("trusted");
    // A receiver the caller supplies may be any value of that type, so an external member call is not linked.
    expect(summary(result, "main")?.evidence).toBe("unknown");
  });

  it("does not resolve a call on a public method of this", async () => {
    const result = await check({ "main.ts": `
      class Widget {
        run() { this.helper(); }
        helper() { console.log("help"); }
      }
      export function main() { return new Widget(); }
    ` });
    expect(result.errors).toBe(0);
    // A subclass in a file this run did not read, or a write it cannot attribute, could replace the body.
    expect(summary(result, "Widget.run")?.evidence).toBe("unknown");
    expect(names(result, "Widget.run")).toEqual([]);
  });

  it("does not resolve a super member call", async () => {
    const result = await check({ "main.ts": `
      class Base { greet() { console.log("base"); } }
      class Sub extends Base { override greet() { super.greet(); } }
      export const made = new Sub();
    ` });
    expect(result.errors).toBe(0);
    // `super.m()` names the base declaration, but nothing here proves that declaration is still its body.
    expect(summary(result, "Sub.greet")?.evidence).toBe("unknown");
  });

  it("links a construction and a hard-private call across modules", async () => {
    const result = await check({
      "widget.ts": `export class Widget { constructor() { this.#boot(); } #boot() { console.log("boot"); } }`,
      "main.ts": `import { Widget } from "./widget.js"; export function main() { new Widget(); }`,
    });
    expect(result.errors).toBe(0);
    expect(names(result, "main")).toEqual(["Console"]);
  });

  it("keeps two classes declaring the same private name apart", async () => {
    const result = await check({ "main.ts": `
      class Quiet { run() { this.#step(); } #step() {} }
      class Loud { run() { this.#step(); } #step() { console.log("loud"); } }
      export const made = [new Quiet(), new Loud()];
    ` });
    expect(result.errors).toBe(0);
    expect(names(result, "Quiet.run")).toEqual([]);
    expect(summary(result, "Quiet.run")?.evidence).toBe("inferred");
    expect(names(result, "Loud.run")).toEqual(["Console"]);
  });

  it("keeps a construction of a class the analysis cannot see an explicit unknown", async () => {
    const result = await check({ "main.ts": `
      export function main() { return new Image(); }
    ` });
    expect(summary(result, "main")?.evidence).toBe("unknown");
  });

  it("does not resolve a member call on a receiver the caller supplies", async () => {
    const result = await check({ "main.ts": `
      export class Widget {
        private tag?: number;
        run() { console.log(this.tag); }
      }
      export function impostor(): Widget { return { run() { fetch("https://example.com"); } }; }
      export function main(widget: Widget) { widget.run(); }
    ` });
    // A class type is inhabited by more than its instances: an OPTIONAL private member imposes nothing on an
    // object literal, so the literal above type-checks and its body is what runs.
    expect(names(result, "main")).toEqual([]);
    expect(summary(result, "main")?.evidence).toBe("unknown");
  });

  it("attributes a field initializer to the construction that runs it", async () => {
    const result = await check({ "main.ts": `
      class Widget { readonly token = Math.random(); }
      export function main() { new Widget(); }
    ` });
    expect(result.errors).toBe(0);
    expect(names(result, "main")).toEqual(["Random"]);
  });
});
