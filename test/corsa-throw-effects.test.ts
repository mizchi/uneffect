import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkCorsaProject } from "../src/frontends/corsa/corsa-check.js";
import { formatEffect } from "../src/effects/capabilities.js";

type Result = Awaited<ReturnType<typeof checkCorsaProject>>;

async function check(source: string, run: (result: Result) => void): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "uneffect-corsa-throw-"));
  try {
    const configFile = join(directory, "tsconfig.json");
    writeFileSync(join(directory, "index.ts"), source);
    writeFileSync(configFile, JSON.stringify({
      compilerOptions: { strict: true, target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", lib: ["ES2022"] },
      files: ["index.ts"],
    }));
    run(await checkCorsaProject({ configFile }));
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

const named = (result: Result) => Object.fromEntries(result.summaries
  .map((item) => [item.functionName, item.effects.map(formatEffect).sort()]));
const evidence = (result: Result) => Object.fromEntries(result.summaries.map((item) => [item.functionName, item.evidence]));

describe("throw statements on the native check", () => {
  it("names the error a throw constructs, from the checker's own symbol", async () => {
    await check(`export function base(reason: string): never { throw new Error(reason); }
export function ranged(reason: string): never { throw new RangeError(reason); }
`, (result) => {
      expect(named(result)).toEqual({ base: ["Throw<Error>"], ranged: ["Throw<RangeError>"] });
      // An inferred throw is read from this source, not taken from a reviewed contract.
      expect(evidence(result).base).toBe("inferred");
    });
  });

  it("keeps every branch of an operand the checker would reduce to one constructor", async () => {
    await check(`export function either(flag: boolean, reason: string): never {
  throw flag ? new RangeError(reason) : new TypeError(reason);
}
`, (result) => {
      expect(named(result).either).toEqual(["Throw<RangeError>", "Throw<TypeError>"]);
    });
  });

  it("refuses to name an operand the checker leaves open", async () => {
    await check(`declare const opaque: any;
export function unknownValue(value: unknown): never { throw value; }
export function anyValue(): never { throw opaque; }
export function plainString(): never { throw "not an error"; }
`, (result) => {
      expect(named(result)).toEqual({
        unknownValue: ["Throw<unknown>"], anyValue: ["Throw<unknown>"], plainString: ["Throw<unknown>"],
      });
    });
  });

  it("discharges a throw only where a catch in the same boundary can reach it", async () => {
    await check(`export function caught(): void { try { throw new Error("x"); } catch { /* handled */ } }
export function onlyFinally(): void { try { throw new Error("x"); } finally { /* cleanup */ } }
export function deferred(schedule: (run: () => void) => void): void {
  try { schedule(() => { throw new Error("later"); }); } catch { /* cannot reach the callback */ }
}
`, (result) => {
      expect(named(result).caught).toEqual([]);
      expect(named(result).onlyFinally).toEqual(["Throw<Error>"]);
      // The catch cannot catch what the callback throws when it later runs.
      expect(named(result)["<anonymous>"]).toEqual(["Throw<Error>"]);
    });
  });

  it("carries a throw to the caller and to the module that runs it", async () => {
    await check(`export function fails(): never { throw new RangeError("x"); }
export function calls(): never { return fails(); }
fails();
`, (result) => {
      expect(named(result).calls).toEqual(["Throw<RangeError>"]);
      expect(named(result)["<module>"]).toEqual(["Throw<RangeError>"]);
    });
  });

  it("names a user error class this run read, by its own name", async () => {
    await check(`export class AppError extends Error {}
export class Deeper extends AppError {}
export class Bag {}
export function app(): never { throw new AppError("x"); }
export function deep(): never { throw new Deeper("x"); }
export function bag(): never { throw new Bag() as never; }
`, (result) => {
      // `Throw<Error>` covers any NAMED error, so a name may only be spelled for a value that really is one.
      // The heritage is followed across the whole run, not only the file the throw is in.
      expect(named(result).app).toEqual(["Throw<AppError>"]);
      expect(named(result).deep).toEqual(["Throw<Deeper>"]);
      // A class that derives from nothing is not an error, and naming it would let `Throw<Error>` cover it.
      expect(named(result).bag).toEqual(["Throw<unknown>"]);
    });
  });

  it("declines to name a user class whose name a standard constructor already spells", async () => {
    await check(`export class RangeError extends Error {}
export function app(): never { throw new RangeError("x"); }
`, (result) => {
      // The effect language's subtyping is string equality plus the one `Throw<Error>` rule, so the two spell
      // the same term and a declaration written against the standard type would be satisfied by this one.
      expect(named(result).app).toEqual(["Throw<unknown>"]);
    });
  });

  it("does not drop a throw because its boundary is async", async () => {
    await check(`export async function rejects(): Promise<never> { throw new Error("x"); }
`, (result) => {
      expect(named(result).rejects).toEqual(["Throw<Error>"]);
    });
  });
});
