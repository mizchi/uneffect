import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { checkCorsaProject } from "../src/frontends/corsa/corsa-check.js";
import { createCorsaCheckJsonReport } from "../src/frontends/corsa/corsa-check-report.js";
import { runCli } from "../src/cli/cli-runner.js";
import { formatEffect } from "../src/effects/capabilities.js";
import { exitCode, type CliStreams } from "../src/cli/cli-support.js";

const configFile = resolve("test/fixtures/corsa-api-project/tsconfig.json");

function capture(): CliStreams & { stdout: string; stderr: string } {
  const io = {
    stdout: "", stderr: "",
    out(text: string) { io.stdout += text; },
    err(text: string) { io.stderr += text; },
  };
  return io;
}

function capabilityNames(result: Awaited<ReturnType<typeof checkCorsaProject>>): Record<string, string[]> {
  return Object.fromEntries(result.summaries.map((summary) => [
    summary.functionName,
    summary.effects.filter((effect) => effect.kind === "capability").map((effect) => effect.name),
  ]));
}

describe("Corsa-native project check", () => {
  it("authenticates literal member calls and isolates object handlers", async () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-corsa-handlers-"));
    try {
      const temporaryConfig = join(directory, "tsconfig.json");
      writeFileSync(join(directory, "index.ts"), `
        export function factory() { return {
          report: () => console["log"]("hello"),
          connect() { return new globalThis["WebSocket"]("wss://example.com"); },
        }; }
        export function shadowed(console: { log(value: string): void }) { console["log"]("local"); }
        export function cookies() { console.log(document["cookie"]); }
        export function shadowedCookie(document: { cookie: string }) { return String(document["cookie"]); }
      `);
      writeFileSync(temporaryConfig, JSON.stringify({ compilerOptions: { strict: true, target: "ES2024", module: "NodeNext", types: [] }, files: ["index.ts"] }));
      const checked = await checkCorsaProject({ configFile: temporaryConfig });
      expect(checked.errors).toBe(0);
      // `String(value)` accepts an unconstrained value, so the reviewed contract names the coercion it may run.
      expect(capabilityNames(checked)).toMatchObject({ factory: [], report: ["Console"], connect: ["Net"], shadowed: [],
        cookies: ["Console", "CookieRead"], shadowedCookie: ["InvokeUserCode"] });
      expect(checked.summaries.find(item => item.functionName === "shadowed")?.evidence).toBe("unknown");
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("carries inline callee effects through constructors and immediately invoked functions", async () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-corsa-boundaries-"));
    try {
      const temporaryConfig = join(directory, "tsconfig.json");
      writeFileSync(join(directory, "index.ts"), `
        class Base { constructor(readonly label: string) { console.log(label); } }
        export class Box extends Base {
          constructor(public value: number) { super("box"); }
        }
        export function wrap(): number { return (() => { console.log("iife"); return 1; })(); }
        export function quiet(): number { return (() => 2)(); }
        export function dispatch(handlers: Array<(value: string) => void>, index: number): void { handlers[index]("value"); }
        export function dynamicDocument(key: string): void { document[key as "write"]("value"); }
        export const started = (() => { console.log("module"); return true; })();
      `);
      writeFileSync(temporaryConfig, JSON.stringify({ compilerOptions: { strict: true, target: "ES2024", module: "NodeNext", types: [] }, files: ["index.ts"] }));
      const checked = await checkCorsaProject({ configFile: temporaryConfig });
      expect(checked.diagnostics.map(item => [item.line, item.domain, item.message.replace(/;.*$/, "")])).toEqual([
        [9, "syntax", "unsupported call-sites syntax (computed-call-target)"],
        [8, "bounds", "`handlers[index]` is dereferenced without an index guard"],
      ]);
      // `super(...)` names exactly the base the `extends` clause resolves to, so the base constructor composes.
      expect(capabilityNames(checked)).toMatchObject({ "Base.constructor": ["Console"], "Box.constructor": ["Console"], wrap: ["Console"], quiet: [], dispatch: [] });
      const evidence = Object.fromEntries(checked.summaries.map(item => [item.functionName, item.evidence]));
      expect(evidence).toMatchObject({ "Base.constructor": "trusted", "Box.constructor": "trusted", wrap: "trusted", quiet: "inferred", dispatch: "unknown" });
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("links every immediately invoked call form to its caller instead of claiming purity", async () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-corsa-iife-"));
    try {
      const temporaryConfig = join(directory, "tsconfig.json");
      writeFileSync(join(directory, "index.ts"), `
        export function parenthesized(): void { (function () { console.log("x"); })(); }
        export function arrow(): number { return (() => { console.log("x"); return 1; })(); }
        export function voidOperator(): void { void function () { console.log("x"); }(); }
        export function negated(): void { !function () { console.log("x"); }(); }
        export function assigned(): number { const value = function () { console.log("x"); return 2; }(); return value; }
        export function returned(): number { return function () { console.log("x"); return 3; }(); }
        export function pure(): number { return function () { return 4; }(); }
      `);
      writeFileSync(temporaryConfig, JSON.stringify({ compilerOptions: { strict: true, target: "ES2024", module: "NodeNext", types: [] }, files: ["index.ts"] }));
      const checked = await checkCorsaProject({ configFile: temporaryConfig });
      const named = ["parenthesized", "arrow", "voidOperator", "negated", "assigned", "returned"];
      for (const name of named) {
        expect(capabilityNames(checked)[name], name).toEqual(["Console"]);
        expect(checked.summaries.find(item => item.functionName === name)?.evidence, name).toBe("trusted");
      }
      // An inline callee whose own body is effect-free still proves nothing more than its callee does.
      expect(capabilityNames(checked).pure).toEqual([]);
      expect(checked.diagnostics).toEqual([]);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("marks an unresolved DOM member read and every DOM property write instead of claiming purity", async () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-corsa-property-"));
    try {
      const temporaryConfig = join(directory, "tsconfig.json");
      writeFileSync(join(directory, "index.ts"), `
        export function writeCookie(d: Document, value: string): void { d.cookie = value; }
        export function readCookie(d: Document): string { return d.cookie; }
        export function writeMarkup(element: Element, html: string): void { element.innerHTML = html; }
        export function styleWrite(element: HTMLElement, value: string): void { element.style.color = value; }
        export function uncontracted(element: HTMLElement, value: string): void { element.title = value; }
        export function plainRead(box: { label: string }): string { return box.label; }
      `);
      writeFileSync(temporaryConfig, JSON.stringify({ compilerOptions: { strict: true, target: "ES2024", module: "NodeNext", lib: ["ES2024", "DOM"], types: [] }, files: ["index.ts"] }));
      const checked = await checkCorsaProject({ configFile: temporaryConfig });
      const names = capabilityNames(checked);
      const evidence = Object.fromEntries(checked.summaries.map(item => [item.functionName, item.evidence]));
      expect(names.readCookie).toEqual(["CookieRead"]);
      // A write is not a read: the write branch of the contract selects the write capability.
      expect(names.writeCookie).toEqual(["CookieWrite"]);
      expect(names.writeMarkup).toContain("Dom");
      // Every member of a CSS declaration block is reviewed as one surface, so the write resolves.
      expect(evidence.styleWrite).toBe("trusted");
      expect(names.styleWrite).toEqual(["Dom", "InvokeUserCode"]);
      // A DOM member the catalog does not contract is an unknown, never an empty inferred proof.
      expect(evidence.uncontracted).toBe("unknown");
      expect(names.uncontracted).toEqual([]);
      // An ordinary object property carries no host semantics and stays a proof of effect freedom.
      expect(evidence.plainRead).toBe("inferred");
      expect(names.plainRead).toEqual([]);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("reaches the ECMAScript catalog, renders Throw, and fails closed on the rest", async () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-corsa-libes-"));
    try {
      const temporaryConfig = join(directory, "tsconfig.json");
      writeFileSync(join(directory, "index.ts"), `
        export function parseJson(text: string): unknown { return JSON.parse(text); }
        export function caughtParse(text: string): unknown { try { return JSON.parse(text); } catch { return null; } }
        export function jitter(): number { return Math.random(); }
        export function inlineCallback(list: string[]): void { list.forEach((value) => { console.log(value); }); }
        export function inlinePure(list: string[]): number { return list.filter((value) => value.length > 0).length; }
        export function referencedCallback(list: string[], handler: (value: string) => void): void { list.forEach(handler); }
        export function unmodelled(text: string): string { return text.replace("a", "b"); }
      `);
      writeFileSync(temporaryConfig, JSON.stringify({ compilerOptions: { strict: true, target: "ES2024", module: "NodeNext", lib: ["ES2024", "DOM"], types: [] }, files: ["index.ts"] }));
      const checked = await checkCorsaProject({ configFile: temporaryConfig });
      const names = capabilityNames(checked);
      const formatted = Object.fromEntries(checked.summaries.map(item => [item.functionName, item.effects.map(formatEffect)]));
      const evidence = Object.fromEntries(checked.summaries.map(item => [item.functionName, item.evidence]));
      // A reviewed throwing builtin becomes a Throw effect. This path has no CFG, so a catch does not discharge it.
      expect(formatted.parseJson).toContain("Throw<SyntaxError>");
      // An optional callback the call never passes invokes nothing, so the site stays classified.
      expect(evidence.parseJson).toBe("trusted");
      expect(formatted.caughtParse).toContain("Throw<SyntaxError>");
      expect(names.jitter).toEqual(["Random"]);
      // A callback argument written inline at the call site is linked, so its effects reach the caller.
      expect(names.inlineCallback).toEqual(["Console"]);
      expect(evidence.inlineCallback).toBe("trusted");
      expect(evidence.inlinePure).toBe("inferred");
      // A callback this path cannot see into is unknown, never an empty proof.
      expect(evidence.referencedCallback).toBe("unknown");
      // An ECMAScript member with no reviewed contract is unknown, not silently effect-free: `String#replace`
      // accepts a replacer function and is deliberately absent from the catalog.
      expect(evidence.unmodelled).toBe("unknown");
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("links immutable local function bindings and nested declarations to their callers", async () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-corsa-bindings-"));
    try {
      const temporaryConfig = join(directory, "tsconfig.json");
      writeFileSync(join(directory, "index.ts"), `
        const bound = (value: string): void => { console.log(value); };
        const expression = function named(value: string): void { console.log(value); };
        const quiet = (value: string): number => value.length;
        export function callsBound(): void { bound("x"); }
        export function callsExpression(): void { expression("x"); }
        export function callsQuiet(): number { return quiet("x"); }
        export function nestedHost(): void {
          function inner(): void { console.log("inner"); }
          inner();
        }
        const asyncBound = async (): Promise<void> => { console.log("async"); };
        export function callsAsync(): void { void asyncBound(); }
        let mutable = (): void => { console.log("mutable"); };
        mutable = (): void => {};
        export function callsMutable(): void { mutable(); }
      `);
      writeFileSync(temporaryConfig, JSON.stringify({ compilerOptions: { strict: true, target: "ES2024", module: "NodeNext", lib: ["ES2024", "DOM"], types: [] }, files: ["index.ts"] }));
      const checked = await checkCorsaProject({ configFile: temporaryConfig });
      const names = capabilityNames(checked);
      const evidence = Object.fromEntries(checked.summaries.map(item => [item.functionName, item.evidence]));
      expect(names.callsBound).toEqual(["Console"]);
      expect(names.callsExpression).toEqual(["Console"]);
      expect(names.nestedHost).toEqual(["Console"]);
      expect(evidence.callsQuiet).toBe("inferred");
      // An async boundary converts a throw into a rejection, so this path does not compose it yet.
      expect(evidence.callsAsync).toBe("unknown");
      // A reassigned binding has no single body to compose.
      expect(evidence.callsMutable).toBe("unknown");
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("proves effect freedom for reviewed pure standard-library members and keeps the rest unknown", async () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-corsa-pure-"));
    try {
      const temporaryConfig = join(directory, "tsconfig.json");
      writeFileSync(join(directory, "index.ts"), `
        export function textWork(value: string): string {
          return value.trim().toLowerCase().slice(1).substring(0, 2);
        }
        export function textBuild(value: string, count: number): string { return value.repeat(count); }
        export function textJoin(value: string, other: string): string { return value.concat(other); }
        export function textSplit(value: string): string[] { return value.split(","); }
        export function textQuery(value: string, needle: string): boolean {
          return value.startsWith(needle) && value.includes(needle) && value.indexOf(needle) >= 0;
        }
        export function collections(items: Set<string>, table: Map<string, number>, key: string): boolean {
          return items.has(key) && table.has(key) && table.get(key) !== undefined && Array.isArray([key]);
        }
        export function failure(message: string): Error { return new Error(message); }
        export function pattern(value: string, expression: RegExp): boolean { return expression.test(value); }
        export function coerced(value: unknown): number { return Number(value); }
      `);
      writeFileSync(temporaryConfig, JSON.stringify({ compilerOptions: { strict: true, target: "ES2024", module: "NodeNext", lib: ["ES2024"], types: [] }, files: ["index.ts"] }));
      const checked = await checkCorsaProject({ configFile: temporaryConfig });
      const evidence = Object.fromEntries(checked.summaries.map(item => [item.functionName, item.evidence]));
      const formatted = Object.fromEntries(checked.summaries.map(item => [item.functionName, item.effects.map(formatEffect)]));
      for (const name of ["textWork", "textQuery"]) expect(evidence[name], name).toBe("inferred");
      // `repeat` rejects a negative count by specification, so the throw is part of its contract.
      expect(formatted.textBuild).toEqual(["Throw<RangeError>"]);
      // Exhausting the implementation's string length limit is not modelled: `+` and a template literal reach
      // it too, so charging `concat` alone would describe the language inconsistently.
      expect(formatted.textJoin).toEqual([]);
      // A regular expression carries `lastIndex` state, which no reviewed contract describes.
      expect(evidence.pattern).toBe("unknown");
      // A conversion of an unconstrained value runs that value's own coercion method and can reject its result;
      // that is named rather than proved pure.
      expect(formatted.coerced).toEqual(["InvokeUserCode", "Throw<TypeError>"]);
      // `split` delegates to a `Symbol.split` method a well-typed splitter may define, so it is not claimed pure.
      expect(evidence.textSplit).toBe("unknown");
      // A collection member can run an overridden body, which no reviewed contract describes.
      expect(evidence.collections).toBe("unknown");
      // An error construction with a string message builds the object and performs nothing else.
      expect(formatted.failure).toEqual([]);
      expect(evidence.failure).toBe("inferred");
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("selects an inherited DOM contract only through the library's own interface inheritance", async () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-corsa-derived-"));
    try {
      const temporaryConfig = join(directory, "tsconfig.json");
      writeFileSync(join(directory, "index.ts"), `
        export function ownerOfElement(element: HTMLElement): Document | null { return element.ownerDocument; }
        export function ownerOfNode(node: Node): Document | null { return node.ownerDocument; }
        export function ambiguousLength(nodes: NodeList): number { return nodes.length; }
        export function storageLength(store: Storage): number { return store.length; }
      `);
      writeFileSync(temporaryConfig, JSON.stringify({ compilerOptions: { strict: true, target: "ES2024", module: "NodeNext", lib: ["ES2024", "DOM"], types: [] }, files: ["index.ts"] }));
      const checked = await checkCorsaProject({ configFile: temporaryConfig });
      const names = capabilityNames(checked);
      const evidence = Object.fromEntries(checked.summaries.map(item => [item.functionName, item.evidence]));
      // The receiver whose own type carries the reviewed contract resolves it.
      expect(names.ownerOfNode).toEqual(["Dom"]);
      expect(names.storageLength).toEqual(["LocalStorageRead"]);
      // `HTMLElement` reaches `Node#ownerDocument` through the inheritance the library declares, so the
      // reviewed contract of the declaring interface applies to the derived receiver too.
      expect(evidence.ownerOfElement).toBe("trusted");
      expect(names.ownerOfElement).toEqual(["Dom"]);
      // `NodeList` reaches no interface that declares a reviewed `length`, so matching on the member name
      // alone would attach `Storage#length` to it. It stays an explicit unknown.
      expect(evidence.ambiguousLength).toBe("unknown");
      expect(names.ambiguousLength).toEqual([]);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("attributes class initializer effects to the construction boundary", async () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-corsa-fields-"));
    try {
      const temporaryConfig = join(directory, "tsconfig.json");
      writeFileSync(join(directory, "index.ts"), `
        function leak(): string { document.cookie = "stolen"; return "1"; }
        export class Session {
          readonly token: string = leak();
          readonly cookie: string = document.cookie;
          constructor() {}
          quiet(): number { return 1; }
        }
        export class Implicit {
          readonly cookie: string = document.cookie;
        }
        export class Pure {
          readonly label = "x";
          constructor() {}
        }
      `);
      writeFileSync(temporaryConfig, JSON.stringify({ compilerOptions: { strict: true, target: "ES2024", module: "NodeNext", lib: ["ES2024", "DOM"], types: [] }, files: ["index.ts"] }));
      const checked = await checkCorsaProject({ configFile: temporaryConfig });
      const names = capabilityNames(checked);
      const evidence = Object.fromEntries(checked.summaries.map(item => [item.functionName, item.evidence]));
      // A field initializer runs on construction; its effects belong to the construction boundary, never nowhere.
      expect(names["Session.constructor"]?.sort()).toEqual(["CookieRead", "CookieWrite"]);
      expect(names["Implicit.constructor"]).toEqual(["CookieRead"]);
      expect(names["Pure.constructor"]).toEqual([]);
      expect(evidence["Pure.constructor"]).toBe("inferred");
      // A method body keeps its own smaller boundary.
      expect(names["Session.quiet"]).toEqual([]);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("does not give a referenced builtin the effects of calling it", async () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-corsa-reference-"));
    try {
      const temporaryConfig = join(directory, "tsconfig.json");
      writeFileSync(join(directory, "index.ts"), `
        export function referenceRandom(): () => number { return Math.random; }
        export function referenceParse(): (text: string) => unknown { return JSON.parse; }
        export function callRandom(): number { return Math.random(); }
      `);
      writeFileSync(temporaryConfig, JSON.stringify({ compilerOptions: { strict: true, target: "ES2024", module: "NodeNext", lib: ["ES2024"], types: [] }, files: ["index.ts"] }));
      const checked = await checkCorsaProject({ configFile: temporaryConfig });
      const names = capabilityNames(checked);
      const evidence = Object.fromEntries(checked.summaries.map(item => [item.functionName, item.evidence]));
      // Reading a function member performs none of the semantics its call would.
      expect(names.referenceRandom).toEqual([]);
      expect(evidence.referenceRandom).toBe("inferred");
      expect(names.referenceParse).toEqual([]);
      expect(evidence.referenceParse).toBe("inferred");
      expect(names.callRandom).toEqual(["Random"]);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("resolves a contract through a nested receiver and distinguishes every write form", async () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-corsa-receivers-"));
    try {
      const temporaryConfig = join(directory, "tsconfig.json");
      writeFileSync(join(directory, "index.ts"), `
        interface Env { doc: Document; store: Storage }
        export function nestedRead(env: Env): string { return env.doc.cookie; }
        export function nestedWrite(env: Env, value: string): void { env.doc.cookie = value; }
        export function nestedCall(env: Env, key: string): string | null { return env.store.getItem(key); }
        export function flatWrite(d: Document, value: string): void { d.cookie = value; }
        export function compound(d: Document, value: string): void { d.cookie += value; }
        export function destructured(d: Document, source: { cookie: string }): void { ({ cookie: d.cookie } = source); }
        export function arrayDestructured(d: Document, source: [string]): void { [d.cookie] = source; }
        export function loopTarget(d: Document, list: string[]): void { for (d.cookie of list) { } }
      `);
      writeFileSync(temporaryConfig, JSON.stringify({ compilerOptions: { strict: true, target: "ES2024", module: "NodeNext", lib: ["ES2024", "DOM"], types: [] }, files: ["index.ts"] }));
      const checked = await checkCorsaProject({ configFile: temporaryConfig });
      const names = capabilityNames(checked);
      // The receiver's type comes from its last identifier token, so a member receiver resolves like a direct one.
      expect(names.nestedRead).toEqual(["CookieRead"]);
      expect(names.nestedWrite).toEqual(["CookieWrite"]);
      expect(names.nestedCall).toEqual(["LocalStorageRead"]);
      expect(names.flatWrite).toEqual(["CookieWrite"]);
      // A compound assignment reads before it writes; a destructuring or `for...of` target only writes.
      expect(names.compound?.sort()).toEqual(["CookieRead", "CookieWrite"]);
      expect(names.destructured).toEqual(["CookieWrite"]);
      expect(names.arrayDestructured).toEqual(["CookieWrite"]);
      expect(names.loopTarget).toEqual(["CookieWrite"]);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("does not prove effect freedom for an accessor, and fails closed on callbacks it cannot locate", async () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-corsa-accessors-"));
    try {
      const temporaryConfig = join(directory, "tsconfig.json");
      writeFileSync(join(directory, "index.ts"), `
        export class Box {
          data = 1;
          get value(): string { return document.cookie; }
          set value(next: string) { document.cookie = next; }
        }
        const KEY = "value";
        export function readDirect(box: Box): string { return box.value; }
        export function readComputed(box: Box): string { return box[KEY]; }
        export function writeComputed(box: Box, next: string): void { box[KEY] = next; }
        export function readData(box: Box): number { return box.data; }
        const spread: [string, () => string] = ["a", () => { console.log("spread"); return "b"; }];
        export function spreadCallback(text: string): string { return text.replace(...spread); }
        export function chainedCallback(text: string): string {
          return text.trim().replace("a", () => { console.log("chained"); return "b"; });
        }
      `);
      writeFileSync(temporaryConfig, JSON.stringify({ compilerOptions: { strict: true, target: "ES2024", module: "NodeNext", lib: ["ES2024", "DOM"], types: [] }, files: ["index.ts"] }));
      const checked = await checkCorsaProject({ configFile: temporaryConfig });
      const names = capabilityNames(checked);
      const evidence = Object.fromEntries(checked.summaries.map(item => [item.functionName, item.evidence]));
      // Reading or writing an accessor runs its body; that is never a proof of effect freedom.
      for (const name of ["readDirect", "readComputed", "writeComputed"]) expect(evidence[name], name).toBe("unknown");
      // An ordinary data member carries no body.
      expect(evidence.readData).toBe("inferred");
      expect(names.readData).toEqual([]);
      // A spread argument list hides which argument is the callback; a chained call must not lose its own list.
      expect(evidence.spreadCallback).toBe("unknown");
      expect(names.chainedCallback).toEqual(["Console"]);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("does not import a JavaScript TypeScript 6 Program on the shipped check driver", () => {
    const driver = readFileSync("src/cli/check-command.ts", "utf8");
    const corsaCheck = readFileSync("src/frontends/corsa/corsa-check.ts", "utf8");
    expect(driver).not.toMatch(/from ["']\.\/check\.js["']/);
    expect(driver).not.toMatch(/from ["']typescript["']/);
    expect(driver).not.toMatch(/createCheckProgram|createProgram/);
    expect(corsaCheck).not.toMatch(/from ["']typescript["']/);
    expect(corsaCheck).not.toMatch(/createProgram/);
  });

  function launchCheck(args: string[]) {
    const hook = resolve("test/hooks/install-reject-js-typescript.mjs");
    return spawnSync(process.execPath, [
      "--import", hook,
      "--import", "tsx",
      resolve("src/cli/index.ts"),
      ...args,
    ], { encoding: "utf8", cwd: process.cwd() });
  }

  function expectAdmittedCatalog(stdout: string) {
    const report = JSON.parse(stdout) as { effects: Array<{ functionName: string; effects: string[] }> };
    const names = Object.fromEntries(report.effects.map((item) => [item.functionName, item.effects]));
    expect(names.loadAliased?.some((effect) => effect.startsWith("Fetch"))).toBe(true);
    expect(names.load?.some((effect) => effect === "Console" || effect.startsWith("Console"))).toBe(true);
    expect(names.makeNode?.some((effect) => effect.startsWith("Dom"))).toBe(true);
    expect(names.connect?.some((effect) => effect.startsWith("Net"))).toBe(true);
    expect(names.shadowed?.some((effect) => /^(?:Fetch|Console)/.test(effect))).toBe(false);
    expect(names.load?.some((effect) => effect.startsWith("FsRead"))).toBe(false);
    return names;
  }

  it("does not load the JavaScript typescript package for uneffect check --project", () => {
    const launched = launchCheck(["check", "--project", configFile, "--infer", "--json"]);
    expect(launched.status, launched.stderr).toBe(0);
    expect(launched.stderr).not.toMatch(/javascript typescript must not load/);
    expectAdmittedCatalog(launched.stdout);
  }, 60_000);

  it("does not load the JavaScript typescript package for file-specified uneffect check", () => {
    const launched = launchCheck([
      "check", resolve("test/fixtures/corsa-api-project/index.ts"), "--infer", "--json",
    ]);
    expect(launched.status, launched.stderr).toBe(0);
    expect(launched.stderr).not.toMatch(/javascript typescript must not load/);
    expectAdmittedCatalog(launched.stdout);
  }, 60_000);

  it("classifies admitted catalog identity without a TypeScript 6 Program", async () => {
    const checked = await checkCorsaProject({ configFile, requireAnnotations: false });
    const names = capabilityNames(checked);
    expect(names.load).toEqual(expect.arrayContaining(["Console", "Fetch"]));
    expect(names.load ?? []).not.toEqual(expect.arrayContaining(["FsRead"]));
    expect(names.loadAliased).toEqual(expect.arrayContaining(["Fetch"]));
    expect(names.shadowed ?? []).not.toEqual(expect.arrayContaining(["Fetch", "Console"]));
    expect(names.makeNode).toEqual(expect.arrayContaining(["Dom"]));
    expect(names.shadowedDocument ?? []).not.toEqual(expect.arrayContaining(["Dom"]));
    expect(names.connect).toEqual(expect.arrayContaining(["Net"]));
    expect(names.shadowedSocket ?? []).not.toEqual(expect.arrayContaining(["Net"]));
    expect(names["Reporter.report"]).toEqual(["Console"]);
    const load = checked.summaries.find((summary) => summary.functionName === "load");
    expect(load?.effects.some((effect) => effect.kind === "capability" && effect.name === "FsRead")).toBe(false);
  }, 60_000);

  it("fails closed when computed or dynamic call forms would hide an effect-bearing call", async () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-corsa-syntax-"));
    try {
      const sourceFile = join(directory, "index.ts");
      const temporaryConfig = join(directory, "tsconfig.json");
      writeFileSync(sourceFile, `
        export function main(registry: Record<string, () => void>, key: string): void {
          registry[key]()
        }
        export function chained(factory: () => () => void): void {
          factory()()
        }
        export function shadowedDocument(document: Record<string, () => void>, key: string): void {
          document[key]()
        }
        export function realDocument(key: string): void {
          document[key as "write"]("value")
        }
      `);
      writeFileSync(temporaryConfig, JSON.stringify({
        compilerOptions: { strict: true, target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext" },
        files: ["index.ts"],
      }));
      const checked = await checkCorsaProject({ configFile: temporaryConfig, requireAnnotations: false });
      // Checker-resolved non-DOM receivers and call results are unknown callees, never an empty inferred proof.
      const evidence = Object.fromEntries(checked.summaries.map(item => [item.functionName, item.evidence]));
      expect(evidence).toMatchObject({ main: "unknown", chained: "unknown", shadowedDocument: "unknown" });
      expect(checked.summaries.filter(item => item.evidence === "unknown").every(item => item.unknownReasons?.[0]?.code === "unresolved-call")).toBe(true);
      // A dynamic member of the real DOM document still blocks coverage because its contract cannot be selected.
      expect(checked.diagnostics).toEqual([expect.objectContaining({
        domain: "syntax", severity: "error", functionName: "realDocument",
        message: expect.stringContaining("computed-call-target"),
      })]);
      const io = capture();
      expect(await runCli(["check", "--project", temporaryConfig, "--infer", "--json", "--assurance", "no-unknown"], io)).toBe(exitCode.failed);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 60_000);

  it("exposes the same summaries through the default project-check CLI twice", async () => {
    const args = ["check", "--project", configFile, "--infer", "--json"];
    const first = capture();
    const second = capture();
    expect(await runCli(args, first)).toBe(exitCode.success);
    expect(await runCli(args, second)).toBe(exitCode.success);
    const report = JSON.parse(first.stdout) as { effects: Array<{ functionName: string; effects: string[] }> };
    const again = JSON.parse(second.stdout) as { effects: Array<{ functionName: string; effects: string[] }> };
    expect(again).toEqual(report);
    const names = Object.fromEntries(report.effects.map((item) => [item.functionName, item.effects]));
    expect(names.loadAliased?.some((effect) => effect.startsWith("Fetch"))).toBe(true);
    expect(names.load?.some((effect) => effect === "Console" || effect.startsWith("Console"))).toBe(true);
    expect(names.makeNode?.some((effect) => effect.startsWith("Dom"))).toBe(true);
    expect(names.connect?.some((effect) => effect.startsWith("Net"))).toBe(true);
    expect(names.shadowed?.some((effect) => /^(?:Fetch|Console)/.test(effect))).toBe(false);
    expect(names.shadowedDocument?.some((effect) => effect.startsWith("Dom"))).toBe(false);
    expect(names.shadowedSocket?.some((effect) => effect.startsWith("Net"))).toBe(false);
    expect(names.load?.some((effect) => effect.startsWith("FsRead"))).toBe(false);
    expect(createCorsaCheckJsonReport(await checkCorsaProject({ configFile, requireAnnotations: false })).schema)
      .toBe("uneffect-check/v1");
  }, 60_000);

  it("does not treat unclassified calls as an empty inferred proof", async () => {
    const checked = await checkCorsaProject({ configFile, requireAnnotations: false });
    const load = checked.summaries.find((summary) => summary.functionName === "load");
    const loadAliased = checked.summaries.find((summary) => summary.functionName === "loadAliased");
    expect(load).toMatchObject({ evidence: "unknown" });
    expect(load?.unknownReasons).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "unresolved-call" }),
    ]));
    expect(load?.effects.map((effect) => effect.kind === "capability" ? effect.name : effect.kind))
      .toEqual(expect.arrayContaining(["Console", "Fetch"]));
    expect(load?.effects.some((effect) => effect.kind === "capability" && effect.name === "FsRead")).toBe(false);
    expect(loadAliased).toMatchObject({ evidence: "trusted" });
    expect(loadAliased?.unknownReasons).toBeUndefined();

    const io = capture();
    expect(await runCli(["check", "--project", configFile, "--infer", "--json", "--assurance", "no-unknown"], io))
      .toBe(exitCode.failed);
    const report = JSON.parse(io.stdout) as { outcome: string; effects: Array<{ functionName: string; evidence: string }> };
    expect(report.outcome).toBe("failed");
    expect(report.effects.find((item) => item.functionName === "load")?.evidence).toBe("unknown");
  }, 60_000);
});
