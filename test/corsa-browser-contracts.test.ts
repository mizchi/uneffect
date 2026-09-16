import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkCorsaProject } from "../src/frontends/corsa/corsa-check.js";
import { formatEffect } from "../src/effects/capabilities.js";

async function check(source: string) {
  const directory = mkdtempSync(join(tmpdir(), "uneffect-browser-contracts-"));
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
  return summary(result, name)?.effects.map(formatEffect).sort();
}

describe("reviewed browser platform contracts", () => {
  it("names the network a legacy request performs", async () => {
    const result = await check(`
      declare const request: XMLHttpRequest;
      export function open() { request.open("GET", "/endpoint"); }
      export function send() { request.send(); }
      export function read() { return request.responseText; }
      export function status() { return request.status; }
    `);
    expect(result.errors).toBe(0);
    // open() terminates the fetch controller of a reused request and fires readystatechange before returning.
    expect(names(result, "open")).toEqual(["InvokeUserCode", "Net", "Throw<DOMException>"]);
    expect(names(result, "send")).toEqual(["InvokeUserCode", "Net", "Throw<DOMException>"]);
    // Reading a response before it settles throws; the bytes themselves are already in the process.
    expect(names(result, "read")).toEqual(["Throw<DOMException>"]);
    expect(names(result, "status")).toEqual([]);
    expect(summary(result, "status")?.evidence).toBe("inferred");
  });

  it("registers an event handler property as a listener that runs deferred code", async () => {
    const result = await check(`
      declare const request: XMLHttpRequest;
      export function subscribe() { request.onload = () => { console.log("done"); }; }
      declare const handler: () => void;
      export function opaque() { request.onerror = handler; }
    `);
    expect(result.errors).toBe(0);
    // Assigning the handler registers it; what the registered function performs is part of the registration.
    expect(names(result, "subscribe")).toEqual(["Console", "Dom"]);
    expect(summary(result, "subscribe")?.evidence).toBe("trusted");
    // A handler with no analyzed boundary leaves the registration unknown rather than effect-free.
    expect(summary(result, "opaque")?.evidence).toBe("unknown");
  });

  it("covers a style declaration whose whole surface reads and writes the same region", async () => {
    const result = await check(`
      export function hide(element: HTMLElement) { element.style.display = "none"; }
      export function measure(element: HTMLElement) { return element.style.getPropertyValue("width"); }
      export function tag(element: HTMLElement) { element.dataset.state = "ready"; }
      export function mark(element: HTMLElement) { element.classList.add("active"); }
    `);
    expect(result.errors).toBe(0);
    // A write through any of these surfaces runs the element's custom element reactions and validates its
    // input; a read performs neither, so only the read is a bare region read.
    expect(names(result, "hide")).toEqual(["Dom", "InvokeUserCode", "Throw<DOMException>"]);
    expect(names(result, "measure")).toEqual(["Dom", "InvokeUserCode", "Throw<DOMException>"]);
    // `dataset.state` names no declared property: it reaches the interface's own index signature.
    expect(names(result, "tag")).toEqual(["Dom", "InvokeUserCode", "Throw<DOMException>"]);
    expect(names(result, "mark")).toEqual(["Dom", "InvokeUserCode", "Throw<DOMException>"]);
    for (const name of ["hide", "measure", "tag", "mark"]) expect(summary(result, name)?.evidence, name).toBe("trusted");
  });

  it("composes a deferred handler through a thenable receiver", async () => {
    const result = await check(`
      export function chained(pending: PromiseLike<number>) { pending.then(() => { console.log("settled"); }); }
    `);
    expect(result.errors).toBe(0);
    // A `PromiseLike` is any value with a `then` method, so calling it is a call into code the caller supplied:
    // the handler composes, and the call itself is user code that may throw synchronously.
    expect(names(result, "chained")).toEqual(["Console", "InvokeUserCode", "Throw<unknown>"]);
  });

  it("names the failures of the standard URI functions", async () => {
    const result = await check(`
      export function encodeOne(value: string) { return encodeURIComponent(value); }
      export function decodeOne(value: string) { return decodeURIComponent(value); }
      export function encodeAll(value: string) { return encodeURI(value); }
      export function decodeAll(value: string) { return decodeURI(value); }
    `);
    expect(result.errors).toBe(0);
    for (const name of ["encodeOne", "decodeOne", "encodeAll", "decodeAll"]) {
      expect(names(result, name), name).toEqual(["Throw<URIError>"]);
    }
  });

  it("reads the document tree and schedules through the window surface", async () => {
    const result = await check(`
      export function body() { return document.body; }
      export function tags() { return document.getElementsByTagName("script"); }
      export function later(view: Window) { view.setTimeout(() => { console.log("tick"); }, 0); }
      export function viewport(view: Window) { return view.innerWidth; }
      export function global() { return window.innerWidth; }
    `);
    expect(result.errors).toBe(0);
    expect(names(result, "body")).toEqual(["Dom"]);
    expect(names(result, "tags")).toEqual(["Dom"]);
    expect(names(result, "later")).toEqual(["Console", "Timer"]);
    expect(names(result, "viewport")).toEqual(["Dom", "Throw<DOMException>"]);
    // The global `window` is typed as an intersection with the global scope, which carries no interface the
    // reviewed keys name; the Corsa boundary exposes no constituent query, so the member stays unknown.
    expect(summary(result, "global")?.evidence).toBe("unknown");
  });

  it("names a structured clone as the capability the catalog already describes", async () => {
    const result = await check(`
      export function copy(value: { a: number }) { return structuredClone(value); }
    `);
    expect(result.errors).toBe(0);
    // The optional transfer list is not supplied, so nothing is transferred.
    expect(names(result, "copy")).toEqual(["Clone", "Throw<DOMException>"]);
  });
});
