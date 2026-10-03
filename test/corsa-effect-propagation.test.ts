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
  it("propagates synchronous inline bodies through frozen table member calls", async () => {
    const result = await check({ "main.ts": `
      const handlers = Object.freeze({ log() { console.log("method"); }, "send": () => fetch("https://example.com") });
      function middle() { handlers.log(); handlers["send"](); }
      export function main() { middle(); }
    ` });
    expect(result.errors).toBe(0);
    for (const name of ["middle", "main"]) {
      expect(names(result, name)?.sort()).toEqual(["Console", "Fetch", "Net"]);
      // Every site in the reachable subgraph resolves to an analyzed body or a reviewed contract, so the
      // composed set is an upper bound the analysis established rather than a partial observation.
      expect(result.summaries.find(item => item.functionName === name)?.evidence).toBe("trusted");
    }
  });

  it("authenticates frozen table receiver identities across renamed imports", async () => {
    const files = {
      "table.ts": 'export const handlers = Object.freeze({ log: () => console.log("real") });',
      "main.ts": 'import { handlers as actual } from "./table.js"; export function main() { actual.log(); } export function shadowed(actual: { log(): void }) { actual.log(); }',
    };
    const result = await check(files);
    expect(names(result, "main")).toEqual(["Console"]);
    expect(names(result, "shadowed")).toEqual([]);
    expect(names(await check(files, ["main.ts"]), "main")).toEqual([]);
  });

  it.each([
    'const handlers = { log() { console.log("mutable"); } };',
    'const Object = { freeze: <T>(value: T) => value }; const handlers = Object.freeze({ log() { console.log("fake"); } });',
    'const handlers = Object.freeze({ async log() { console.log("deferred"); } });',
    'const handlers = Object.freeze({ *log() { console.log("deferred"); } });',
    'const other = { log() {} }; const handlers = Object.freeze({ log() { console.log("overwritten"); }, ...other });',
  ])("does not infer frozen dispatch for unsupported tables: %s", async declaration => {
    const result = await check({ "main.ts": `${declaration} export function main() { handlers.log(); }` });
    expect(names(result, "main")).toEqual([]);
    expect(result.summaries.find(item => item.functionName === "main")?.evidence).toBe("unknown");
  });

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
    // The parameter shadows the analyzed declaration, so none of its effects are borrowed; invoking the value
    // the caller supplied is what this body establishes.
    expect(names(result, "shadowed")).toEqual(["InvokeUserCode"]);
    // Read out of this body rather than supplied by a reviewed contract, so the evidence is inferred.
    expect(result.summaries.find(item => item.functionName === "shadowed")?.evidence).toBe("inferred");
  });

  it("keeps mutable aliases, methods, and generators unverified while proving a resolved pure cycle", async () => {
    const result = await check({ "main.ts": `
      function leaf() { console.log("leaf"); }
      const alias = leaf;
      const object = { method: leaf };
      function* generator() { console.log("deferred"); yield 1; }
      export function indirect() { alias(); object.method(); generator(); }
      function a() { b(); } function b() { a(); }
    ` });
    expect(names(result, "indirect")).toEqual([]);
    // An aliased binding, an object member, and a generator body are outside the direct-call model.
    expect(result.summaries.find(item => item.functionName === "indirect")?.evidence).toBe("unknown");
    // A cycle whose every edge resolves to an analyzed body reaches a fixed point with no unresolved site in it.
    for (const name of ["a", "b"]) expect(result.summaries.find(item => item.functionName === name)?.evidence).toBe("inferred");
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
    // The same-named export resolves to the analyzed body in its own module, not to the louder one.
    expect(result.summaries.find(item => item.functionName === "quiet")?.evidence).toBe("inferred");
    expect(result.summaries.find(item => item.functionName === "loud")?.evidence).toBe("trusted");
  });

  it("follows a call through an ES module namespace import to the exported body", async () => {
    const files = {
      "leaf.ts": `export function report() { console.log("leaf"); }
        export function quiet() { return 1; }
        export const table = { report() { console.log("table"); } };
        export namespace Legacy { export function report() { console.log("legacy"); } }`,
      "main.ts": `import * as leaf from "./leaf.js"; import { Legacy } from "./leaf.js";
        export function loud() { leaf.report(); }
        export function silent() { return leaf.quiet(); }
        export function nested() { leaf.table.report(); }
        export function declaredNamespace() { Legacy.report(); }`,
    };
    const result = await check(files);
    const evidence = (name: string) => result.summaries.find(item => item.functionName === name)?.evidence;
    // A module namespace object exposes the module's own exports, so the member names the exported function.
    expect([names(result, "loud"), evidence("loud")]).toEqual([["Console"], "trusted"]);
    expect([names(result, "silent"), evidence("silent")]).toEqual([[], "inferred"]);
    // A receiver that is itself a member, and a TypeScript namespace whose members are writable properties of
    // an ordinary object, are not that.
    expect(evidence("nested")).toBe("unknown");
    expect(evidence("declaredNamespace")).toBe("unknown");
    // A body outside the selected files is still not borrowed.
    const selected = await check(files, ["main.ts"]);
    expect(selected.summaries.find(item => item.functionName === "silent")?.evidence).toBe("unknown");
  });

  it("follows a chain of module namespaces and stops at the first ordinary object", async () => {
    const result = await check({
      "leaf.ts": `export function report() { console.log("leaf"); }
        export namespace Legacy { export function report() { console.log("legacy"); } }`,
      "bridge.ts": `export * as inner from "./leaf.js"; export const plain = { report() {} };`,
      "main.ts": `import * as bridge from "./bridge.js";
        export function chained() { bridge.inner.report(); }
        export function throughDeclared() { bridge.inner.Legacy.report(); }
        export function throughObject() { bridge.plain.report(); }`,
    });
    const evidence = (name: string) => result.summaries.find(item => item.functionName === name)?.evidence;
    // A re-exported namespace is the module's namespace object, whose properties are its exports.
    expect([names(result, "chained"), evidence("chained")]).toEqual([["Console"], "trusted"]);
    // A TypeScript namespace and an exported object are ordinary objects whose members can be rewritten.
    for (const name of ["throughDeclared", "throughObject"]) expect([name, evidence(name)]).toEqual([name, "unknown"]);
  });

  it("follows a tagged template to the tag it calls", async () => {
    const result = await check({ "main.ts": `
      function loud(parts: TemplateStringsArray, ...values: unknown[]) { console.log(parts.length); return values.length; }
      function quiet(parts: TemplateStringsArray) { return parts.length; }
      declare function external(parts: TemplateStringsArray): string;
      const table = { tag(parts: TemplateStringsArray) { console.log(parts.length); } };
      export function a() { return loud\`x\${1}\`; }
      export function b() { return quiet\`x\`; }
      export function c() { return external\`x\`; }
      export function d() { table.tag\`x\`; }
      export function e() { return String.raw\`x\`; }
      function run(parts: TemplateStringsArray, task: () => void) { task(); return parts.length; }
      export function f() { return run\`x\${() => console.log("task")}\`; }
    ` });
    const evidence = (name: string) => result.summaries.find(item => item.functionName === name)?.evidence;
    // A tagged template calls its tag with the strings array and the substitutions, so an identifier tag is
    // linked to the body it names exactly as a direct call is.
    expect([names(result, "a"), evidence("a")]).toEqual([["Console"], "trusted"]);
    expect([names(result, "b"), evidence("b")]).toEqual([[], "inferred"]);
    // A tag with no analyzed body, or one read off a mutable object, is not.
    for (const name of ["c", "d", "e"]) expect([name, evidence(name)]).toEqual([name, "unknown"]);
    // A tag that invokes a substitution is not discharged by a function written there: the substitutions do
    // not sit at the argument positions an ordinary call would put them in.
    expect(evidence("f")).toBe("unknown");
    // A tag the caller supplies is invoked exactly as a call to that parameter is, and the caller that supplies
    // it owes what it runs.
    const supplied = await check({ "main.ts": `
      export function run(tag: (parts: TemplateStringsArray) => void) { tag\`x\`; }
      export function caller() { run(() => { console.log("x"); }); }
    ` });
    expect([names(supplied, "run"), supplied.summaries.find(item => item.functionName === "run")?.evidence]).toEqual([["InvokeUserCode"], "inferred"]);
    expect(names(supplied, "caller")?.sort()).toEqual(["Console", "InvokeUserCode"]);
    // The construct is no longer reported as syntax this path could not see.
    expect(result.diagnostics.filter(item => item.domain === "syntax")).toEqual([]);
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
