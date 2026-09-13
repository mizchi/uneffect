import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkCorsaProject } from "../src/frontends/corsa/corsa-check.js";

async function check(files: Record<string, string>) {
  const directory = mkdtempSync(join(tmpdir(), "uneffect-higher-order-"));
  try {
    for (const [file, text] of Object.entries(files)) writeFileSync(join(directory, file), text);
    const configFile = join(directory, "tsconfig.json");
    writeFileSync(configFile, JSON.stringify({
      compilerOptions: { strict: true, target: "ES2024", module: "NodeNext", types: [] },
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

describe("user-defined higher-order effect composition", () => {
  it("names invoking a parameter as a capability instead of leaving the body unknown", async () => {
    const result = await check({ "main.ts": `
      export function apply(callback: () => void) { callback(); }
    ` });
    expect(result.errors).toBe(0);
    // Calling a parameter is not an unresolved site: the value is supplied by whoever calls this function,
    // and that obligation is what the capability names.
    expect(names(result, "apply")).toEqual(["InvokeUserCode"]);
    expect(summary(result, "apply")?.evidence).toBe("trusted");
  });

  it("composes the inline argument a caller supplies for the invoked parameter", async () => {
    const result = await check({ "main.ts": `
      function apply(callback: () => void) { callback(); }
      export function main() { apply(() => { console.log("supplied"); }); }
    ` });
    expect(result.errors).toBe(0);
    expect(names(result, "main")).toEqual(["Console", "InvokeUserCode"]);
    expect(summary(result, "main")?.evidence).toBe("trusted");
  });

  it("composes through a second parameter position and leaves untouched parameters alone", async () => {
    const result = await check({ "main.ts": `
      function pair(first: () => void, second: () => void) { second(); }
      export function main() { pair(() => { fetch("https://example.com"); }, () => { console.log("second"); }); }
    ` });
    expect(result.errors).toBe(0);
    // Only the invoked parameter composes; an argument the body never calls contributes nothing.
    expect(names(result, "main")).toEqual(["Console", "InvokeUserCode"]);
  });

  it("forwards the obligation when a caller passes its own parameter through", async () => {
    const result = await check({ "main.ts": `
      function apply(callback: () => void) { callback(); }
      export function relay(callback: () => void) { apply(callback); }
      export function main() { relay(() => { console.log("relayed"); }); }
    ` });
    expect(result.errors).toBe(0);
    expect(names(result, "relay")).toEqual(["InvokeUserCode"]);
    expect(names(result, "main")).toEqual(["Console", "InvokeUserCode"]);
  });

  it("stays unknown when the supplied argument has no analyzed boundary", async () => {
    const result = await check({ "main.ts": `
      function apply(callback: () => void) { callback(); }
      declare const handler: () => void;
      export function main() { apply(handler); }
    ` });
    // The obligation is undischarged, so the caller is unknown; what `apply` itself establishes is retained.
    expect(names(result, "main")).toEqual(["InvokeUserCode"]);
    expect(summary(result, "main")?.evidence).toBe("unknown");
  });

  it("stays unknown when a spread hides which argument the obligation names", async () => {
    const result = await check({ "main.ts": `
      function apply(callback: () => void) { callback(); }
      declare const supplied: [() => void];
      export function main() { apply(...supplied); }
    ` });
    expect(summary(result, "main")?.evidence).toBe("unknown");
  });

  it("does not treat a reassigned parameter as the caller's value", async () => {
    const result = await check({ "main.ts": `
      declare function replacement(): void;
      export function apply(callback: () => void) { callback = replacement; callback(); }
    ` });
    // The invoked value is no longer the one the caller supplied, so the body reaches an unresolved site.
    expect(names(result, "apply")).toEqual([]);
    expect(summary(result, "apply")?.evidence).toBe("unknown");
  });

  it("owes the obligation at the boundary that receives a parameter a nested closure invokes", async () => {
    const result = await check({ "main.ts": `
      function defer(callback: () => void) { return () => { callback(); }; }
      declare const handler: () => void;
      export function supplied() { return defer(() => { console.log("deferred"); }); }
      export function opaque() { return defer(handler); }
    ` });
    expect(result.errors).toBe(0);
    // `defer` invokes nothing itself, so it establishes no capability; the obligation it owes is structural.
    expect(names(result, "defer")).toEqual([]);
    expect(summary(result, "defer")?.evidence).toBe("inferred");
    // A caller is charged for the argument whether or not the returned closure is ever run: the composed set
    // is an upper bound, and an argument with no analyzed boundary leaves the caller unknown.
    expect(names(result, "supplied")).toEqual(["Console"]);
    expect(summary(result, "opaque")?.evidence).toBe("unknown");
  });

  it("propagates an invoked parameter through an analyzed callee chain", async () => {
    const result = await check({ "main.ts": `
      function apply(callback: () => void) { callback(); }
      function middle() { apply(() => { localStorage.setItem("k", "v"); }); }
      export function main() { middle(); }
    ` });
    expect(result.errors).toBe(0);
    expect(names(result, "main")).toEqual(["InvokeUserCode", "LocalStorageWrite"]);
  });

  it("does not compose an argument into a callee that never invokes it", async () => {
    const result = await check({ "main.ts": `
      function store(callback: () => void) { return callback; }
      export function main() { return store(() => { fetch("https://example.com"); }); }
    ` });
    expect(result.errors).toBe(0);
    // `store` only returns the value, so its caller performs nothing the argument would perform.
    expect(names(result, "main")).toEqual([]);
    expect(summary(result, "main")?.evidence).toBe("inferred");
  });
});
