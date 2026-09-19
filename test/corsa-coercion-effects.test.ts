import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkCorsaProject } from "../src/frontends/corsa/corsa-check.js";
import { formatEffect } from "../src/effects/capabilities.js";

type Result = Awaited<ReturnType<typeof checkCorsaProject>>;

async function check(source: string, run: (result: Result) => void): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "uneffect-corsa-coerce-"));
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

/** The pair a conversion that reaches a user method carries, the same one `String` and `Number` are reviewed for. */
const conversion = ["InvokeUserCode", "Throw<TypeError>"];

describe("implicit conversion to a primitive", () => {
  it("charges a template substitution and a concatenation that can run a user method", async () => {
    await check(`const loud = { toString(): string { console.log("printed"); return "x"; } };
export function interpolate(): string { return \`\${loud}\`; }
export function concat(): string { return "a" + loud; }
`, (result) => {
      // Reporting nothing here was a positive claim of effect freedom for a body that writes to stdout.
      expect(effectsOf(result, "interpolate")).toEqual(conversion);
      expect(effectsOf(result, "concat")).toEqual(conversion);
    });
  });

  it("charges nothing when every operand is already a primitive", async () => {
    await check(`enum Kind { A = 1, B = 2 }
export function fromNumber(n: number): string { return \`n=\${n}\`; }
export function fromUnion(v: string | number | boolean | null | undefined): string { return \`v=\${v}\`; }
export function fromLiteralUnion(v: "a" | "b"): string { return \`v=\${v}\`; }
type Kind = "a" | "b" | "c";
type Level = 1 | 2 | 3;
export function fromAliasedStrings(v: Kind): string { return \`v=\${v}\`; }
export function fromAliasedNumbers(v: Level): string { return \`v=\${v}\`; }
export function fromEnum(k: Kind): string { return \`k=\${k}\`; }
export function fromBigInt(a: bigint, b: bigint): bigint { return a % b; }
export function fromLiterals(): string { return \`n=\${1}\` + "x"; }
export function comparison(a: number, b: number): boolean { return a < b; }
export function strings(a: string, b: string): string { return a + b; }
`, (result) => {
      // A named alias prints as its own name, so its constituents are asked about rather than read.
      for (const name of ["fromNumber", "fromUnion", "fromLiteralUnion", "fromAliasedStrings",
        "fromAliasedNumbers", "fromEnum", "fromBigInt", "fromLiterals", "comparison", "strings"]) {
        expect([name, effectsOf(result, name)]).toEqual([name, []]);
      }
    });
  });

  it("charges an operand whose type the checker gave and which is not a primitive", async () => {
    await check(`export function fromAny(v: any): string { return \`v=\${v}\`; }
export function fromUnknown(v: unknown): string { return \`v=\${v}\`; }
export function fromObject(v: { a: number }): string { return \`v=\${v}\`; }
export function fromArray(v: readonly string[]): string { return \`v=\${v}\`; }
type Objs = { a: number } | { b: number };
type Mixed = string | { a: number };
export function fromAliasedObjects(v: Objs): string { return \`v=\${v}\`; }
export function fromAliasedMixed(v: Mixed): string { return \`v=\${v}\`; }
export function fromSymbol(v: symbol): string { return \`v=\${String(v)}\`; }
`, (result) => {
      // The conversion is KNOWN to reach a user method here: the checker gave a type and it is an object, a
      // symbol, or a union containing one.
      for (const name of ["fromObject", "fromArray", "fromSymbol", "fromAliasedObjects", "fromAliasedMixed"]) {
        expect([name, effectsOf(result, name)]).toEqual([name, conversion]);
      }
      // `any` and `unknown` say nothing either way. Naming an effect on that basis would be a claim about a
      // construct the path did not analyze, so the boundary is unresolved instead.
      for (const name of ["fromAny", "fromUnknown"]) {
        expect([name, effectsOf(result, name), row(result, name)?.evidence]).toEqual([name, [], "unknown"]);
      }
    });
  });

  it("charges nothing for a tagged template, which hands its substitutions over unconverted", async () => {
    await check(`declare function tag(parts: TemplateStringsArray, ...values: unknown[]): string;
export function tagged(v: { a: number }): string { return tag\`v=\${v}\`; }
`, (result) => {
      expect(effectsOf(result, "tagged")).toEqual([]);
    });
  });
});
