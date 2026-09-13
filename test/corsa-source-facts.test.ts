import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkCorsaProject, type CorsaCheckResult } from "../src/frontends/corsa/corsa-check.js";
import { createCorsaCheckJsonReport } from "../src/frontends/corsa/corsa-check-report.js";
import { openCorsaApiFrontend } from "../src/frontends/corsa/corsa-api-frontend.js";

async function project<T>(text: string, run: (result: CorsaCheckResult, file: string) => T | Promise<T>, lib: string[] = ["es2018"]): Promise<T> {
  const directory = mkdtempSync(join(tmpdir(), "uneffect-index-access-"));
  const file = join(directory, "input.ts"), configFile = join(directory, "tsconfig.json");
  writeFileSync(file, text);
  writeFileSync(configFile, JSON.stringify({ compilerOptions: { strict: true, target: "es2018", lib, module: "commonjs", types: [] }, files: [file] }));
  try { return await run(await checkCorsaProject({ configFile }), file); } finally { rmSync(directory, { recursive: true, force: true }); }
}

const bounds = (result: CorsaCheckResult) => result.diagnostics.filter(item => item.domain === "bounds");
const syntax = (result: CorsaCheckResult) => result.diagnostics.filter(item => item.domain === "syntax");

describe("unchecked array index dereference", () => {
  it("reports a split() pair whose second element is dereferenced without a length guard", async () => {
    await project(`
export function parseCookie(cookies?: { value: string }[]): Record<string, string> {
  if (!cookies) return {};
  return cookies.reduce((map: Record<string, string>, cookie: { value: string }) => {
    cookie.value.split(";").forEach((pair: string) => {
      const parts = pair.split("=");
      map[parts[0].trim()] = parts[1].trim();
    });
    return map;
  }, {});
}
`, (result) => {
      expect(syntax(result)).toEqual([]);
      expect(bounds(result)).toEqual([expect.objectContaining({
        domain: "bounds", kind: "unchecked-index", severity: "error", line: 7, functionName: "<anonymous>",
        message: expect.stringContaining("parts[1]"),
      })]);
      expect(bounds(result)[0]?.notes?.map(note => note.label)).toEqual(["because", "hint"]);
      expect(result.errors).toBe(1);
    });
  });

  it("accepts the length early-return repair of the same shape", async () => {
    await project(`
export function parseCookie(value: string): Record<string, string> {
  const map: Record<string, string> = {};
  value.split(";").forEach((pair: string) => {
    const parts = pair.split("=");
    if (parts.length < 2) {
      return;
    }
    map[parts[0].trim()] = parts[1].trim();
  });
  return map;
}
`, (result) => {
      expect(result.diagnostics).toEqual([]);
      expect(result.errors).toBe(0);
    });
  });

  it("does not trust split() beyond its guaranteed first element", async () => {
    await project(`
export function first(value: string, limit: number): string {
  const parts = value.split(",");
  const limited = value.split(",", limit);
  const zeroLimited = value.split(",", 0);
  const reassigned = value.split(",");
  return parts[0].trim() + limited[0].trim() + zeroLimited[0].trim() + reassigned[0].trim();
}
export function later(value: string): string {
  let parts = value.split(",");
  parts = [];
  return parts[0].trim();
}
`, (result) => {
      expect(bounds(result).map(item => [item.functionName, /`([^`]+)`/.exec(item.message)?.[1]])).toEqual([
        ["first", "limited[0]"], ["first", "zeroLimited[0]"], ["later", "parts[0]"],
      ]);
    });
  });

  it("recognizes length-bounded for loops including length aliases and reverse iteration", async () => {
    await project(`
export function loops(list: string[], other: string[], count: number): number {
  let total = 0;
  for (let i = 0; i < list.length; i++) total += list[i].length;
  for (let i = 0, l = list.length; i < l; ++i) total += list[i].length;
  for (let i = list.length - 1; i >= 0; i--) total += list[i].length;
  for (let i = 0; list.length > i; i++) total += list[i].length;
  for (let i = 0; i < count; i++) total += list[i].length;
  for (let i = 0; i < other.length; i++) total += list[i].length;
  for (let i = 0; i <= list.length; i++) total += list[i].length;
  return total;
}
`, (result) => {
      expect(bounds(result).map(item => item.line)).toEqual([8, 9, 10]);
    });
  });

  it("recognizes conditional guards on the length or the element itself", async () => {
    await project(`
export function guarded(list: string[], index: number): string {
  let out = "";
  if (list.length > 1) out += list[1].trim();
  if (list.length >= 2) out += list[1].trim();
  if (list.length === 2) out += list[1].trim();
  if (list.length) out += list[0].trim();
  if (list[1] !== undefined) out += list[1].trim();
  if (list[1] != null) out += list[1].trim();
  if (list[1]) out += list[1].trim();
  if (typeof list[1] === "string") out += list[1].trim();
  if (index < list.length) out += list[index].trim();
  if (index < list.length && out) out += list[index].trim();
  out += list[1] ? list[1].trim() : "";
  out += list[1] && list[1].trim();
  out += list[1]?.trim() ?? "";
  if (list.length > 1) out += list[2].trim();
  if (list.length >= 2) out += list[2].trim();
  if (list.length === 2) out += list[2].trim();
  if (out) out += list[1].trim();
  if (index < list.length) out += list[1].trim();
  if (list[0]) out += list[1].trim();
  return out;
}
`, (result) => {
      expect(bounds(result).map(item => item.line)).toEqual([17, 18, 19, 20, 21, 22]);
    });
  });

  it("recognizes early exits that leave the index in range", async () => {
    await project(`
export function exits(list: string[], flag: boolean): string {
  if (list.length < 2) return "";
  const second = list[1].trim();
  if (list.length <= 2) throw new Error("short");
  const third = list[2].trim();
  if (list[3] === undefined) return second;
  const fourth = list[3].trim();
  if (!list[4] || flag) return third;
  const fifth = list[4].trim();
  if (list.length < 6 && flag) return fourth;
  const sixth = list[5].trim();
  if (list.length < 2) { fifth.trim(); }
  const seventh = list[6].trim();
  return sixth + seventh;
}
export function loopExit(list: string[]): number {
  let total = 0;
  for (const value of list) {
    if (list.length < 3) continue;
    total += list[2].length + value.length;
  }
  return total;
}
`, (result) => {
      expect(bounds(result).map(item => item.line)).toEqual([12, 14]);
    });
  });

  it("covers readonly arrays, element calls, nested member receivers, and leaves other receivers alone", async () => {
    await project(`
class Holder {
  items: readonly string[] = [];
  handlers: Array<(value: string) => void> = [];
  table: Record<string, string[]> = {};
  run(nodes: NodeList, tuple: [string, string], loose: any, key: string, matched: RegExpMatchArray): void {
    this.items[0].trim();
    this.handlers[0]("value");
    this.table[key].push("value");
    nodes[0].textContent;
    tuple[1].trim();
    loose[key].trim();
    matched[1].trim();
  }
}
`, (result) => {
      expect(bounds(result).map(item => [item.line, /`([^`]+)`/.exec(item.message)?.[1]])).toEqual([
        [7, "this.items[0]"], [8, "this.handlers[0]"], [10, "nodes[0]"],
      ]);
      expect(bounds(result).every(item => item.functionName === "Holder.run")).toBe(true);
      // Dynamic keys on checker-resolved non-DOM receivers are admitted; an `any` receiver remains excluded.
      expect(syntax(result).map(item => item.line)).toEqual([12]);
    }, ["es2018", "dom"]);
  });

  it("admits computed reads and writes on checker-resolved non-DOM receivers", async () => {
    await project(`
export function lookup(table: Record<string, number>, list: number[], key: string, index: number, w: Window, d: Document): number {
  table[key] = list[index] + table[key];
  const dynamicDocument = d[key as "title"];
  const dynamicWindow = (w as any)[key];
  return list[index] + String(dynamicDocument).length + Number(dynamicWindow);
}
`, (result) => {
      expect(bounds(result)).toEqual([]);
      expect(syntax(result).map(item => [item.line, item.message.includes("computed-property")])).toEqual([[4, true], [5, true]]);
    }, ["es2018", "dom"]);
  });

  it("treats a literal-typed constant key as a static member name", async () => {
    await project(`
declare global { interface Window { __checked?: Record<string, true> } }
const COOKIE = "cookie";
const FLAG = "__checked";
const SECOND = 1;
export function readCookie(d: Document): string { return d[COOKIE]; }
export function flag(w: Window): boolean { w[FLAG] = w[FLAG] ?? {}; return w[FLAG] !== undefined; }
export function nested(w: Window, unit: string): boolean { return w[FLAG]![unit] === true; }
const DOCUMENT = "document";
export function globalFlag(): boolean { window[FLAG] = window[FLAG] ?? {}; return window[FLAG] !== undefined; }
export function globalDocument(): Document { return window[DOCUMENT]; }
export function second(list: string[]): string { return list[SECOND].trim(); }
export function loose(w: any): unknown { return w[FLAG]; }
export function dynamicKey(d: Document, key: string): unknown { return d[key as "title"]; }
export function declaredKey(d: Document, key: "cookie"): string { return d[key]; }
`, (result) => {
      const effects = Object.fromEntries(result.summaries.map(item => [item.functionName, item.effects.map(effect => effect.kind === "capability" ? effect.name : effect.kind)]));
      expect(effects).toMatchObject({ readCookie: ["CookieRead"], flag: [], nested: [], globalFlag: [], globalDocument: [], second: [], loose: [], dynamicKey: [], declaredKey: ["CookieRead"] });
      // A receiver that is itself a computed member has no token whose type is the element type, and a DOM member of the
      // intersection-typed global `window` has no owner for contract selection; both stay excluded.
      expect(syntax(result).map(item => item.functionName)).toEqual(["nested", "globalDocument", "loose", "dynamicKey"]);
      expect(bounds(result).map(item => [item.functionName, /`([^`]+)`/.exec(item.message)?.[1]])).toEqual([["second", "list[SECOND]"]]);
    }, ["es2018", "dom"]);
  });

  it("keeps an unresolved import type excluded even though its display text is not any", async () => {
    await project(`
import type { RemoteHeaders } from "./missing-module";
export function header(headers: RemoteHeaders, key: string): unknown { return headers[key]; }
`, (result) => {
      expect(syntax(result).map(item => [item.functionName, item.message.includes("computed-property")])).toEqual([["header", true]]);
      expect(bounds(result)).toEqual([]);
    });
  });

  it("selects the same DOM contract through a nested receiver as through a direct one", async () => {
    await project(`
const HTML = "innerHTML";
interface Holder { node: Element }
class Owner { node: Element = document.body; write(value: string): void { this.node[HTML] = value; } }
export function nested(holder: Holder, value: string): void { holder.node[HTML] = value; }
export function direct(element: Element, value: string): void { element[HTML] = value; }
export function owned(owner: Owner, value: string): void { owner.write(value); }
`, (result) => {
      const effects = Object.fromEntries(result.summaries.map(item => [item.functionName, item.effects.map(effect => effect.kind === "capability" ? effect.name : effect.kind)]));
      expect(effects.nested).toEqual(effects.direct);
      expect(effects.direct).toContain("Dom");
      expect(effects["Owner.write"]).toContain("Dom");
      expect(syntax(result)).toEqual([]);
    }, ["es2018", "dom"]);
  });

  it("keeps a dynamic key fail-closed when the receiver inherits an effect-bearing DOM member", async () => {
    await project(`
interface Widget extends Element { custom: number }
interface Plain { label: string; count: number }
export function widget(element: Widget, key: string): unknown { return element[key]; }
export function plain(value: Plain, key: string): unknown { return (value as never as Record<string, unknown>)[key]; }
export function plainDirect(value: Plain, key: "label" | "count"): unknown { return value[key]; }
`, (result) => {
      // A dynamic key on a receiver that can select a DOM contract is not evidence of effect freedom.
      expect(syntax(result).map(item => item.functionName)).toEqual(["widget"]);
      expect(result.summaries.find(item => item.functionName === "plainDirect")?.evidence).toBe("inferred");
    }, ["es2018", "dom"]);
  });

  it("does not trust split() with an empty, regular-expression, or non-literal separator", async () => {
    await project(`
export function emptySeparator(value: string): string { const parts = value.split(""); return parts[0].trim(); }
export function patternSeparator(value: string): string { const parts = value.split(/,/); return parts[0].trim(); }
export function dynamicSeparator(value: string, separator: string): string { const parts = value.split(separator); return parts[0].trim(); }
export function literalSeparator(value: string): string { const parts = value.split(","); return parts[0].trim(); }
`, (result) => {
      expect(bounds(result).map(item => item.functionName)).toEqual(["emptySeparator", "patternSeparator", "dynamicSeparator"]);
    });
  });

  it("does not trust a split result whose identity or contents escape the fragment", async () => {
    await project(`
export function aliased(value: string): string { const parts = value.split(","); const other = parts; other.shift(); return parts[0].trim(); }
export function deleted(value: string): string { const parts = value.split(","); delete parts[0]; return parts[0].trim(); }
export function passed(value: string, sink: (items: string[]) => void): string { const parts = value.split(","); sink(parts); return parts[0].trim(); }
export function truncated(value: string): string { const parts = value.split(","); parts.length = 0; return parts[0].trim(); }
export function kept(value: string): string { const parts = value.split(","); return parts[0].trim() + parts.length; }
`, (result) => {
      expect(bounds(result).map(item => item.functionName)).toEqual(["aliased", "deleted", "passed", "truncated"]);
    });
  });

  it("does not trust a length snapshot or an index that a later mutation invalidates", async () => {
    await project(`
export function staleSnapshot(list: string[], index: number): string {
  const length = list.length;
  list.pop();
  if (index < length) return list[index].trim();
  return "";
}
export function mutableSnapshot(list: string[], index: number): string {
  let length = list.length;
  length = 1000;
  if (index < length) return list[index].trim();
  return "";
}
export function reassignedIndex(list: string[], index: number): string {
  if (index >= list.length) return "";
  index = 9999;
  return list[index].trim();
}
export function shrunkAfterGuard(list: string[]): string {
  let out = "";
  while (list.length) { list.shift(); out += list[0].trim(); }
  return out;
}
export function consumedBeforeShrink(list: string[]): string {
  let out = "";
  while (list.length) { out += list[0].trim(); list.shift(); }
  return out;
}
`, (result) => {
      expect(bounds(result).map(item => item.functionName))
        .toEqual(["staleSnapshot", "mutableSnapshot", "reassignedIndex", "shrunkAfterGuard"]);
    });
  });

  it("recognizes a const receiver alias and entries() iteration as guards", async () => {
    await project(`
export function viaAlias(list: string[]): string {
  const same = list;
  return same.length > 0 ? list[0].trim() : "";
}
export function viaEntries(list: string[]): number {
  let total = 0;
  for (const [index, value] of list.entries()) total += list[index].length + value.length;
  return total;
}
export function viaOtherAlias(list: string[], other: string[]): string {
  const same = other;
  return same.length > 0 ? list[0].trim() : "";
}
`, (result) => {
      expect(bounds(result).map(item => item.functionName)).toEqual(["viaOtherAlias"]);
    });
  });

  it("admits a numeric key only on a receiver whose numeric index selects an element, not a stored value", async () => {
    await project(`
export function collections(nodes: NodeList, elements: HTMLCollection, classes: DOMTokenList, list: string[], index: number): string {
  const a = nodes[index];
  const b = elements[0];
  const c = classes[index];
  const d = list[index];
  return String(a) + String(b) + String(c) + d;
}
export function storageByNumber(index: number): unknown { return localStorage[index]; }
export function stillDynamic(d: Document, key: string): unknown { return d[key]; }
`, (result) => {
      // A numeric key on Storage reads a stored item through its string index signature, so it stays fail-closed.
      expect(syntax(result).map(item => item.functionName)).toEqual(["storageByNumber", "stillDynamic"]);
      expect(bounds(result)).toEqual([]);
    }, ["es2018", "dom"]);
  });

  it("bounds-checks a DOM indexed collection the same way as an array", async () => {
    await project(`
export function unguarded(nodes: NodeListOf<Element>, index: number): string | null {
  return nodes[index].getAttribute("href");
}
export function guardedByLength(nodes: NodeListOf<Element>): string {
  let out = "";
  for (let i = 0; i < nodes.length; i++) out += nodes[i].tagName;
  return out;
}
export function guardedByItem(elements: HTMLCollection, index: number): string {
  return index < elements.length ? elements[index].tagName : "";
}
export function firstUnguarded(elements: HTMLCollection): string {
  return elements[0].tagName;
}
export function notACollection(map: Record<string, { id: string }>, key: string): string {
  return map[key].id;
}
`, (result) => {
      expect(bounds(result).map(item => [item.functionName, /\`([^\`]+)\`/.exec(item.message)?.[1]]))
        .toEqual([["unguarded", "nodes[index]"], ["firstUnguarded", "elements[0]"]]);
      expect(syntax(result)).toEqual([]);
    }, ["es2018", "dom"]);
  });

  it("pins the compiler type-flag numbering the admission rules read", async () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-index-flags-"));
    const file = join(directory, "flags.ts"), configFile = join(directory, "tsconfig.json");
    writeFileSync(file, `declare const values: {
  anyValue: any; unknownValue: unknown; neverValue: never; stringValue: string; numberValue: number;
  numberLiteral: 7; stringLiteral: "lit"; objectValue: object; iface: Document; arr: string[];
};
export const used = values;
`);
    writeFileSync(configFile, JSON.stringify({ compilerOptions: { strict: true, target: "es2020", lib: ["es2020", "dom"], module: "commonjs", types: [] }, files: [file] }));
    try {
      const frontend = await openCorsaApiFrontend({ configFile });
      try {
        const source = readFileSync(file, "utf8");
        const flagOf = (name: string) => frontend.getTypeAtPosition(file, source.indexOf(`${name}:`))?.flags;
        // These are the compiler's values, not the JavaScript TypeScript 6 ones; the admission rules depend on them.
        expect(flagOf("anyValue")).toBe(1);
        expect(flagOf("unknownValue")).toBe(2);
        expect(flagOf("neverValue")).toBe(262144);
        expect(flagOf("numberValue")).toBe(64);
        expect(flagOf("numberLiteral")).toBe(2048);
        expect(flagOf("stringValue")).toBe(32);
        expect(flagOf("stringLiteral")).toBe(1024);
        expect(flagOf("objectValue")).toBe(131072);
        expect(flagOf("iface")).toBe(1048576);
        expect(flagOf("arr")).toBe(1048576);
      } finally { frontend.close(); }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("publishes the bounds diagnostic code in the versioned report", async () => {
    await project(`
export function second(list: string[]): string { return list[1].trim(); }
`, (result) => {
      const report = createCorsaCheckJsonReport(result);
      expect(report.outcome).toBe("failed");
      expect(report.diagnostics.map(item => item.code)).toEqual(["bounds/unchecked-index"]);
      expect(report.diagnostics[0]?.notes.length).toBe(2);
    });
  });
});
