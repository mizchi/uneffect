import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkCorsaProject } from "../src/frontends/corsa/corsa-check.js";
import { parseDomInterfaceGraph } from "../src/frontends/corsa/dom-inheritance.js";

async function check(source: string) {
  const directory = mkdtempSync(join(tmpdir(), "uneffect-dom-inheritance-"));
  try {
    writeFileSync(join(directory, "main.ts"), source);
    const configFile = join(directory, "tsconfig.json");
    writeFileSync(configFile, JSON.stringify({
      compilerOptions: { strict: true, target: "ES2024", module: "NodeNext", lib: ["ES2024", "DOM"], types: [] },
      files: ["main.ts"],
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

describe("standard DOM interface inheritance", () => {
  it("orders ancestors nearest first and tolerates type arguments in the heritage clause", () => {
    const graph = parseDomInterfaceGraph(`
      interface EventTarget { addEventListener(): void }
      interface Node extends EventTarget { }
      interface ParentNode extends Node { }
      interface Element extends Node, ParentNode { }
      interface Holder<T> extends Owner<Map<string, T>, number>, Node { }
    `);
    expect(graph.ancestors("Element")).toEqual(["Node", "ParentNode", "EventTarget"]);
    expect(graph.ancestors("Holder")).toEqual(["Owner", "Node", "EventTarget"]);
    expect(graph.ancestors("EventTarget")).toEqual([]);
    expect(graph.ancestors("Absent")).toEqual([]);
  });

  it("merges repeated declarations and terminates on a cycle", () => {
    const graph = parseDomInterfaceGraph(`
      interface A extends B { }
      interface A extends C { }
      interface B extends A { }
      interface C { }
    `);
    expect(graph.ancestors("A")).toEqual(["B", "C"]);
  });

  it("selects a reviewed contract a base interface declares for a derived receiver", async () => {
    const result = await check(`
      declare const host: HTMLDivElement;
      export function find() { return host.querySelector("a"); }
      export function readText() { return host.textContent; }
      export function writeText() { host.textContent = "replaced"; }
    `);
    expect(result.errors).toBe(0);
    // `querySelector` is declared by `ParentNode` and `textContent` by `Node`; neither is the receiver's type.
    expect(names(result, "find")).toEqual(["Dom"]);
    expect(summary(result, "find")?.evidence).toBe("trusted");
    expect(names(result, "readText")).toEqual(["Dom"]);
    expect(names(result, "writeText")).toEqual(["Dom", "InvokeUserCode"]);
  });

  it("does not select a DOM contract for a user interface that shares the member name", async () => {
    const result = await check(`
      interface Local { querySelector(selector: string): void }
      declare const local: Local;
      export function find() { local.querySelector("a"); }
    `);
    expect(names(result, "find")).toEqual([]);
    expect(summary(result, "find")?.evidence).toBe("unknown");
  });

  it("keeps a DOM member with no reviewed contract an explicit unknown", async () => {
    const result = await check(`
      declare const host: HTMLDivElement;
      export function focus() { host.blur(); }
    `);
    expect(summary(result, "focus")?.evidence).toBe("unknown");
  });

  it("reads a receiver mutation as an ownership fact rather than an unmodelled primitive", async () => {
    const result = await check(`
      export function collect(values: number[]) { values.push(1); }
      declare const host: HTMLDivElement;
      export function attach() { host.setAttribute("data-state", "ready"); }
    `);
    expect(result.errors).toBe(0);
    // `Array#push` mutates its receiver and performs nothing else; mutation is what the ownership analysis
    // reads, not a capability this summary can claim.
    expect(names(result, "collect")).toEqual([]);
    expect(summary(result, "collect")?.evidence).toBe("inferred");
    expect(names(result, "attach")).toEqual(["Dom", "InvokeUserCode"]);
  });
});
