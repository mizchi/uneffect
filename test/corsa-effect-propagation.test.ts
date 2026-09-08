import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkCorsaProject } from "../src/frontends/corsa/corsa-check.js";

async function check(files: Record<string, string>, selected?: string[]) {
  const directory = mkdtempSync(join(tmpdir(), "uneffect-native-effects-"));
  try {
    for (const [file, text] of Object.entries(files)) writeFileSync(join(directory, file), text);
    const configFile = join(directory, "tsconfig.json");
    writeFileSync(configFile, JSON.stringify({ compilerOptions: { strict: true, target: "ES2024", module: "NodeNext", types: [] }, files: Object.keys(files) }));
    return await checkCorsaProject({ configFile, fileNames: selected?.map(file => join(directory, file)) });
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

function names(result: Awaited<ReturnType<typeof check>>, name: string) {
  return result.summaries.find(item => item.functionName === name)?.effects.map(effect => effect.kind === "capability" ? effect.name : effect.kind);
}

describe("native direct-call effect propagation", () => {
  it("retains known effects through multiple callers without upgrading incomplete evidence", async () => {
    const result = await check({ "main.ts": `
      export function main() { middle(); }
      function middle() { leaf(); }
      function leaf() { console.log("leaf"); external(); }
      declare function external(): void;
    ` });
    expect(result.errors).toBe(0);
    for (const name of ["main", "middle", "leaf"]) {
      expect(names(result, name)).toEqual(["Console"]);
      expect(result.summaries.find(item => item.functionName === name)?.evidence).toBe("unknown");
    }
  });

  it("uses native identity across renamed imports and preserves selected-file boundaries", async () => {
    const files = {
      "main.ts": `import { report as renamed } from "./leaf.js"; export function main() { renamed(); }`,
      "leaf.ts": `export function report() { console.log("leaf"); }`,
    };
    expect(names(await check(files), "main")).toEqual(["Console"]);
    const selected = await check(files, ["main.ts"]);
    expect(names(selected, "main")).toEqual([]);
    expect(selected.summaries[0]?.evidence).toBe("unknown");
  });

  it("converges on recursion and does not borrow effects from a same-name parameter", async () => {
    const result = await check({ "main.ts": `
      function left() { right(); console.log("left"); }
      function right() { left(); fetch("https://example.com"); }
      export function main() { right(); }
      export function shadowed(left: () => void) { left(); }
    ` });
    for (const name of ["left", "right", "main"]) expect(names(result, name)?.sort()).toEqual(["Console", "Fetch", "Net"]);
    expect(names(result, "shadowed")).toEqual([]);
    expect(result.summaries.find(item => item.functionName === "shadowed")?.evidence).toBe("unknown");
  });

  it("keeps mutable aliases, methods, generators, and pure call cycles unverified", async () => {
    const result = await check({ "main.ts": `
      function leaf() { console.log("leaf"); }
      const alias = leaf;
      const object = { method: leaf };
      function* generator() { console.log("deferred"); yield 1; }
      export function indirect() { alias(); object.method(); generator(); }
      function a() { b(); } function b() { a(); }
    ` });
    expect(names(result, "indirect")).toEqual([]);
    for (const name of ["indirect", "a", "b"]) expect(result.summaries.find(item => item.functionName === name)?.evidence).toBe("unknown");
  });

  it.each(["leaf = replacement;", "({ leaf } = { leaf: replacement });", "[leaf] = [replacement];"])("does not link a reassigned declaration to its stale body: %s", async assignment => {
    const result = await check({ "main.ts": `
      function leaf() { console.log("stale body"); }
      declare function replacement(): void;
      ${assignment}
      export function main() { leaf(); }
    ` });
    expect(names(result, "main")).toEqual([]);
    expect(result.summaries.find(item => item.functionName === "main")?.evidence).toBe("unknown");
  });

  it("does not merge same-name declarations across modules and follows re-exports", async () => {
    const result = await check({
      "loud.ts": `export function report() { console.log("loud"); }`,
      "quiet.ts": `export function report() { return true; }`,
      "bridge.ts": `export { report as relay } from "./loud.js";`,
      "main.ts": `import { relay } from "./bridge.js"; import { report } from "./quiet.js";
        export function loud() { relay(); } export function quiet() { report(); }`,
    });
    expect(names(result, "loud")).toEqual(["Console"]);
    expect(names(result, "quiet")).toEqual([]);
    expect(result.summaries.find(item => item.functionName === "quiet")?.evidence).toBe("unknown");
  });

  it.each(["deferred();", "eval(code); leaf();"])("keeps async invocation and dynamic scope outside the direct-call model: %s", async invocation => {
    const result = await check({ "main.ts": `
      async function deferred() { console.log("deferred"); }
      function leaf() { console.log("dynamically replaceable"); }
      export function main(code: string) { ${invocation} }
    ` });
    expect(names(result, "main")).toEqual([]);
    expect(result.summaries.find(item => item.functionName === "main")?.evidence).toBe("unknown");
  });
});
