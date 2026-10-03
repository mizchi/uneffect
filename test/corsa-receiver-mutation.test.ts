import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkCorsaProject } from "../src/frontends/corsa/corsa-check.js";
import { formatEffect } from "../src/effects/capabilities.js";

type Result = Awaited<ReturnType<typeof checkCorsaProject>>;

async function check(source: string, run: (result: Result) => void): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "uneffect-corsa-mutate-"));
  try {
    const configFile = join(directory, "tsconfig.json");
    writeFileSync(join(directory, "index.ts"), source);
    writeFileSync(configFile, JSON.stringify({
      compilerOptions: { strict: true, target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", lib: ["ES2022", "DOM"] },
      files: ["index.ts"],
    }));
    run(await checkCorsaProject({ configFile }));
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

const row = (result: Result, functionName: string) =>
  result.summaries.find((item) => item.functionName === functionName);
const effectsOf = (result: Result, functionName: string) =>
  (row(result, functionName)?.effects ?? []).map(formatEffect).sort();
const reasonText = (result: Result, functionName: string) =>
  (row(result, functionName)?.unknownReasons ?? []).map((item) => item.message).join(" ");

describe("a member write this path cannot name", () => {
  it("does not let a write to an object the boundary did not create read as a proof", async () => {
    await check(`interface Bag { n: number; deep: { m: number } }
export function writeProp(b: Bag): void { b.n = 1; }
export function writeNested(b: Bag): void { b.deep.m = 1; }
export function bump(b: Bag): void { b.n++; }
export function compound(b: Bag): void { b.n += 1; }
export function destructureInto(b: Bag): void { ({ n: b.n } = { n: 5 }); }
export function deleteProp(b: { opt?: number }): void { delete b.opt; }
export function caller(b: Bag): void { writeProp(b); }
`, (result) => {
      // Removing a property changes the object exactly as assigning one does.
      for (const name of ["writeProp", "writeNested", "bump", "compound", "destructureInto", "deleteProp"]) {
        expect([name, row(result, name)?.evidence]).toEqual([name, "unknown"]);
      }
      expect(reasonText(result, "writeProp")).toContain("the object whose n is written");
      expect(row(result, "caller")?.evidence).toBe("unknown");
    });
  });

  it("leaves a write to an object that did not exist before the call alone", async () => {
    await check(`export class Counter {
  calls = 0;
  ready = false;
  constructor(seed: number) { this.calls = seed; }
  bump(): void { this.calls++; }
}
export function localOnly(): number { let x = 0; x = 2; return x; }
`, (result) => {
      // A constructor and a field initializer write the instance being made, whose previous state no caller
      // can hold. A local binding is not a member of anything.
      expect(row(result, "Counter.constructor")?.evidence).toBe("inferred");
      expect(row(result, "localOnly")?.evidence).toBe("inferred");
      // A method writing the same field writes an object its caller already holds.
      expect(row(result, "Counter.bump")?.evidence).toBe("unknown");
    });
  });
});

describe("a write to a binding this boundary does not own", () => {
  it("does not let a write to an outer binding read as a proof", async () => {
    await check(`export let moduleCounter = 0;
export function writeModuleLet(): void { moduleCounter = 1; }
export function closureWrite(): () => void { let n = 0; return () => { n = 1; }; }
`, (result) => {
      expect(row(result, "writeModuleLet")?.evidence).toBe("unknown");
      expect(reasonText(result, "writeModuleLet")).toContain("the binding moduleCounter this boundary does not own");
      // The factory only creates the closure; the closure's own body is what writes the captured binding.
      expect(row(result, "closureWrite")?.evidence).toBe("inferred");
      expect(row(result, "<anonymous>")?.evidence).toBe("unknown");
    });
  });

  it("leaves a write to a binding the boundary owns alone, through every pattern", async () => {
    await check(`export function localOnly(): number { let x = 0; x = 2; return x; }
export function paramWrite(a: number): number { a = 1; return a; }
export function swapParams(a: number, b: number): number { [a, b] = [b, a]; return a - b; }
export function swapLocals(): number { let a = 1, b = 2; [a, b] = [b, a]; return a + b; }
export function objectPattern(): number { let n = 0; ({ n } = { n: 5 }); return n; }
export function shadowing(): number { let x = 0; x = 5; return x; }
export function hoistedVar(c: boolean): number { if (c) { var v = 1; } v = 2; return v ?? 0; }
export function caught(): number { let r = 0; try { r = 1; } catch { r = 2; } return r; }
`, (result) => {
      // A name the scope chain declares at or inside this boundary is private to the call. The scope walk has
      // to start at the assignment target, because a name nested in a pattern has no parent recorded yet.
      for (const name of ["localOnly", "paramWrite", "swapParams", "swapLocals",
        "objectPattern", "shadowing", "hoistedVar", "caught"]) {
        expect([name, row(result, name)?.evidence]).toEqual([name, "inferred"]);
      }
    });
  });
});

describe("a receiver write this path cannot name", () => {
  it("does not let a call whose only observable is a receiver write read as a proof", async () => {
    await check(`export function collect(values: number[]): void { values.push(1); }
export function store(m: Map<string, number>): void { m.set("a", 1); }
export function inPlace(values: number[]): number[] { return values.sort(); }
export function caller(values: number[]): void { collect(values); }
`, (result) => {
      for (const name of ["collect", "store", "inPlace"]) {
        expect([name, row(result, name)?.evidence]).toEqual([name, "unknown"]);
      }
      // The reason names the call, rather than the generic "a callee reaches a site outside the model".
      expect(reasonText(result, "collect")).toContain("the value push writes through");
      // And it reaches the caller through the ordinary fixed point.
      expect(row(result, "caller")?.evidence).toBe("unknown");
    });
  });

  it("leaves a contract that reports a capability of its own alone", async () => {
    await check(`export function addClass(el: Element): void { el.classList.add("x"); }
`, (result) => {
      // A boundary the contract already gives something to say is not made unknown by the write beside it.
      expect(effectsOf(result, "addClass")).toEqual(["Dom", "InvokeUserCode", "Throw<DOMException>"]);
      expect(row(result, "addClass")?.evidence).toBe("trusted");
    });
  });

  it("decides a write through an argument by whether the call allocated it", async () => {
    await check(`export function freezeFresh(): object { return Object.freeze({ a: 1 }); }
export function freezeArrayFresh(): readonly number[] { return Object.freeze([1, 2]); }
export function assignFresh(): { a: number } { return Object.assign({}, { a: 2 }); }
export function freezeHeld(o: { a: number }): object { return Object.freeze(o); }
export function assignInto(target: { a: number }): void { Object.assign(target, { a: 2 }); }
export function defineOnHeld(o: object): void { Object.defineProperty(o, "x", { value: 1 }); }
export function readOnly(values: readonly number[]): number { return values.length; }
`, (result) => {
      // An argument written at the call itself is held by nothing else yet, so writing it is private.
      for (const name of ["freezeFresh", "freezeArrayFresh", "assignFresh", "readOnly"]) {
        expect([name, row(result, name)?.evidence]).toEqual([name, "inferred"]);
      }
      // Anything the caller could also be holding is not.
      for (const name of ["freezeHeld", "assignInto", "defineOnHeld"]) {
        expect([name, row(result, name)?.evidence]).toEqual([name, "unknown"]);
      }
      expect(reasonText(result, "assignInto")).toContain("the value assign writes through");
    });
  });

  it("decides a receiver write by whether the receiver was allocated where it is written", async () => {
    await check(`export function lastSegment(source: string): string { return source.split("/").pop() ?? ""; }
export function sortedCopy(values: number[]): number[] { return values.slice().sort(); }
export function sortedLiteral(): number[] { return [3, 1, 2].sort(); }
export function dynamicSeparator(source: string, separator: string): string { return source.split(separator).pop() ?? ""; }
export function sortedTwice(values: number[]): number[] { return values.sort().reverse(); }
declare function same(values: number[]): number[];
export function throughOpaque(values: number[]): number | undefined { return same(values).pop(); }
`, (result) => {
      // A receiver the immediately preceding call allocated, or a literal written at the site, is held by
      // nothing else yet, so writing it is private to this boundary.
      for (const name of ["lastSegment", "sortedCopy", "sortedLiteral"]) {
        expect([name, row(result, name)?.evidence, effectsOf(result, name)]).toEqual([name, "inferred", []]);
      }
      // A separator that is not one string literal may select a custom Symbol.split, so nothing is fresh.
      expect(row(result, "dynamicSeparator")?.evidence).toBe("unknown");
      // `sort` returns its receiver, so the second write lands on the caller's array.
      expect(row(result, "sortedTwice")?.evidence).toBe("unknown");
      expect(reasonText(result, "sortedTwice")).toContain("the value reverse writes through");
      // A call with no reviewed contract may return a value the caller already holds.
      expect(row(result, "throughOpaque")?.evidence).toBe("unknown");
      expect(reasonText(result, "throughOpaque")).toContain("the value pop writes through");
    });
  });

  it("follows a const binding to an allocation only while nothing else can reach it", async () => {
    await check(`export const sink: string[][] = [];
export function lastSegmentViaLocal(source: string): string { const parts = source.split("/"); return parts.pop() ?? ""; }
export function parentPath(source: string): string { const parts = source.split("/"); parts.pop(); return parts.join("/"); }
export function sortedLength(): number { const xs = [3, 1, 2]; xs.sort(); return xs.length; }
export function escapesFirst(source: string): void { const parts = source.split("/"); sink.push(parts); parts.pop(); }
export function seenByCallback(source: string): string[][] {
  const parts = source.split("/");
  const views = parts.map((_, __, all) => all);
  parts.pop();
  return views;
}
export function laterInClosure(source: string): () => string | undefined { const parts = source.split("/"); return () => parts.pop(); }
export function heldByCaller(values: string[]): string | undefined { const parts = values; return parts.pop(); }
`, (result) => {
      // Every use of the binding is a member call that hands back a primitive or nothing, so the array never
      // leaves this boundary and writing it is private.
      for (const name of ["lastSegmentViaLocal", "parentPath", "sortedLength"]) {
        expect([name, row(result, name)?.evidence, effectsOf(result, name)]).toEqual([name, "inferred", []]);
      }
      // A use that publishes the array, a callback handed the receiver, a closure that runs later, and a binding
      // to a value the caller holds all let the write reach someone else.
      for (const name of ["escapesFirst", "seenByCallback", "heldByCaller"]) {
        expect([name, row(result, name)?.evidence]).toEqual([name, "unknown"]);
        expect(reasonText(result, name)).toContain("the value pop writes through");
      }
      // The closure is the boundary that writes, and by then the array has left the boundary that made it.
      const closure = result.summaries.find((item) => item.functionName === "<anonymous>"
        && (item.unknownReasons ?? []).some((reason) => reason.message.includes("the value pop writes through")));
      expect(closure?.evidence).toBe("unknown");
    });
  });

  it("leaves a write alone when the allocation leaves only by being returned", async () => {
    await check(`export const sink: string[][] = [];
export function collect(source: string[]): string[] { const out: string[] = []; for (const item of source) out.push(item); return out; }
export function index(keys: string[]): Map<string, number> { const map = new Map<string, number>(); map.set("a", 1); return map; }
export function unique(keys: string[]): Set<string> { const seen = new Set<string>(); seen.add("a"); return seen; }
export function returnedEarly(flag: boolean): string[] { const out: string[] = []; if (flag) return out; out.push("x"); return out; }
export function afterFinally(): string[] { const out: string[] = []; try { return out; } finally { out.push("late"); } }
export function publishedFirst(): string[] { const out: string[] = []; sink.push(out); out.push("x"); return out; }
export function yielded(): string[] { const out: string[] = []; const view = [out]; out.push("x"); return view[0] ?? []; }
`, (result) => {
      // Nothing outside the boundary can hold the allocation until it is returned, and the return ends the call.
      for (const name of ["collect", "index", "unique", "returnedEarly"]) {
        expect([name, row(result, name)?.evidence]).toEqual([name, "inferred"]);
      }
      // A finally block runs after the return hands the value out, and any other use can publish it first.
      for (const name of ["afterFinally", "publishedFirst", "yielded"]) {
        expect([name, row(result, name)?.evidence]).toEqual([name, "unknown"]);
        expect(reasonText(result, name)).toContain("the value push writes through");
      }
    });
  });
});
