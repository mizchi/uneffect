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

  it("leaves a write through an argument alone, which is where a fresh allocation is written", async () => {
    await check(`export function freezeFresh(): object { return Object.freeze({ a: 1 }); }
export function readOnly(values: readonly number[]): number { return values.length; }
`, (result) => {
      // `Object.freeze` writes through argument 0, not a receiver, and the object it writes did not exist
      // before the call. Argument-targeted mutators are a separate question this rule does not answer.
      expect(row(result, "freezeFresh")?.evidence).toBe("inferred");
      expect(row(result, "readOnly")?.evidence).toBe("inferred");
    });
  });
});
