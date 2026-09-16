import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkCorsaProject } from "../src/frontends/corsa/corsa-check.js";
import { formatEffect } from "../src/effects/capabilities.js";

async function check(source: string) {
  const directory = mkdtempSync(join(tmpdir(), "uneffect-standard-globals-"));
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

describe("standard global constructors and conversions", () => {
  it("proves an error construction performs nothing beyond building the object", async () => {
    const result = await check(`
      export function fail(reason: string): never { throw new Error(reason); }
      export function typed(reason: string): never { throw new TypeError(reason); }
    `);
    expect(result.errors).toBe(0);
    // The constructor declares a string message, so its coercion is total and reaches no user method; throwing
    // the result is the caller's control flow, not an effect of the construction.
    expect(names(result, "fail")).toEqual([]);
    expect(summary(result, "fail")?.evidence).toBe("inferred");
    expect(names(result, "typed")).toEqual([]);
  });

  it("separates the total numeric conversions from the ones that reach a user method", async () => {
    const result = await check(`
      export function parseNumber(text: string) { return parseInt(text, 10) + parseFloat(text); }
      export function rounded(value: number) { return Math.floor(Math.abs(value)); }
      export function text(value: unknown) { return String(value); }
      export function truthy(value: unknown) { return Boolean(value); }
    `);
    expect(result.errors).toBe(0);
    // `parseInt` and `Math.floor` take the primitives their signatures require, so ToString and ToNumber are total.
    expect(names(result, "parseNumber")).toEqual([]);
    expect(summary(result, "parseNumber")?.evidence).toBe("inferred");
    expect(names(result, "rounded")).toEqual([]);
    // `String(value)` coerces an arbitrary value, which runs its `toString` or `Symbol.toPrimitive`.
    expect(names(result, "text")).toEqual(["InvokeUserCode", "Throw<TypeError>"]);
    // ToBoolean reads no property and cannot throw.
    expect(names(result, "truthy")).toEqual([]);
  });

  it("composes the executor a promise construction runs synchronously", async () => {
    const result = await check(`
      export function later(): Promise<number> {
        return new Promise((ok) => { console.log("started"); ok(1); });
      }
      declare const executor: (ok: (value: number) => void) => void;
      export function opaque(): Promise<number> { return new Promise(executor); }
    `);
    expect(result.errors).toBe(0);
    // The executor runs before the constructor returns, so its effects are the construction's; the declared
    // executor is callable and construction is the only call form, so the constructor's TypeError is unreachable.
    // The executor itself invokes the `resolve` function it was handed, which is the capability it carries.
    expect(names(result, "later")).toEqual(["Console", "InvokeUserCode"]);
    expect(summary(result, "opaque")?.evidence).toBe("unknown");
  });

  it("resolves the standard constructions a page reaches for", async () => {
    const result = await check(`
      export function request() { return new XMLHttpRequest(); }
      export function address(value: string) { return new URL(value); }
      export function event(type: string) { return new Event(type); }
    `);
    expect(result.errors).toBe(0);
    expect(names(result, "request")).toEqual([]);
    expect(summary(result, "request")?.evidence).toBe("inferred");
    // The signature admits a URL object at both positions, so the conversion runs its stringifier first.
    expect(names(result, "address")).toEqual(["InvokeUserCode", "Throw<TypeError>"]);
    // The constructor has no throwing step of its own and the init dictionary is omitted, so nothing is read.
    expect(names(result, "event")).toEqual([]);
    expect(summary(result, "event")?.evidence).toBe("inferred");
  });

  it("reads the navigator and a measured rectangle", async () => {
    const result = await check(`
      export function agent() { return navigator.userAgent; }
      export function width(element: Element) { return element.getBoundingClientRect().width; }
    `);
    expect(result.errors).toBe(0);
    expect(names(result, "agent")).toEqual(["Dom"]);
    // The rectangle is a snapshot the layout read already produced, so reading it performs nothing.
    expect(names(result, "width")).toEqual(["Dom"]);
  });

  it("separates a writable measured rectangle from a read-only one", async () => {
    const result = await check(`
      export function move(element: Element) { const box = element.getBoundingClientRect(); box.x = 0; return box; }
      export function pin(entry: ResizeObserverEntry) { return entry.contentRect.x; }
    `);
    expect(result.errors).toBe(0);
    // `getBoundingClientRect` hands back a `DOMRect`, which redeclares the geometry members as writable.
    expect(names(result, "move")).toEqual(["Dom"]);
    expect(summary(result, "move")?.evidence).toBe("trusted");
    expect(names(result, "pin")).toEqual([]);
  });
});
