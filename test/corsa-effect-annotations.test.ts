import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkCorsaProject } from "../src/frontends/corsa/corsa-check.js";

type Result = Awaited<ReturnType<typeof checkCorsaProject>>;

async function check(
  source: string,
  run: (result: Result) => void,
  options: { requireAnnotations?: boolean } = {},
): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "uneffect-corsa-annot-"));
  try {
    const configFile = join(directory, "tsconfig.json");
    writeFileSync(join(directory, "index.ts"), source);
    writeFileSync(configFile, JSON.stringify({
      compilerOptions: { strict: true, target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", lib: ["ES2022", "DOM"] },
      files: ["index.ts"],
    }));
    run(await checkCorsaProject({ configFile, requireAnnotations: options.requireAnnotations ?? true }));
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

const row = (result: Result, functionName: string) =>
  result.summaries.find((item) => item.functionName === functionName);

const reasons = (result: Result, functionName: string) =>
  (row(result, functionName)?.unknownReasons ?? []).map((item) => item.code).sort();

describe("declared effects on the native path", () => {
  it("reports an effect the declaration does not permit", async () => {
    await check(`/* uneffect:effect none */
export function lies(): void { console.log("hi"); }
`, (result) => {
      const missing = result.diagnostics.filter((item) => item.kind === "missing");
      expect(missing.map((item) => `${item.functionName}:${item.line}:${item.message}`))
        .toEqual(["lies:1:lies requires /* uneffect:effect Console */"]);
    });
  });

  it("reads two blocks on one boundary as one declaration", async () => {
    await check(`/* uneffect:effect Console */
/* uneffect:effect Random */
export function both(): void { console.log("hi"); void Math.random(); }
`, (result) => {
      // Comparing them separately would report the effect each one omits while the other spells it out.
      expect(result.diagnostics.filter((item) => item.domain === "effect")).toEqual([]);
    });
  });

  it("binds a declaration written on an object-literal method", async () => {
    await check(`export const commands = {
  /* uneffect:effect none */
  run() { console.log("hi"); },
};
`, (result) => {
      expect(result.diagnostics.filter((item) => item.kind === "missing").map((item) => item.message))
        .toEqual(["run requires /* uneffect:effect Console */"]);
    });

    // The same annotation one line higher is about the const, whose initializer is not a function.
    await check(`/* uneffect:effect none */
export const commands = { run() { console.log("hi"); } };
`, (result) => {
      expect(result.diagnostics.filter((item) => item.domain === "effect").map((item) => item.kind))
        .toEqual(["unchecked"]);
    });
  });

  it("does not credit a declaration written on something else to the next function", async () => {
    await check(`/* uneffect:effect Console */
export class Holder { run(): void { console.log("hi"); } }
`, (result) => {
      // Crediting it would silence a real violation in a boundary that never claimed anything, so an
      // unbindable declaration is an error of its own instead.
      const effects = result.diagnostics.filter((item) => item.domain === "effect");
      expect(effects.map((item) => `${item.severity}:${item.kind}`)).toEqual(["warning:unchecked"]);
      // A position this path publishes no summary for is its own limit, not a defect in the source, so it
      // warns rather than failing the check.
      expect(result.errors).toBe(0);
    });
  });

  it("does not report an effect it could not name as one the declaration is missing", async () => {
    await check(`class Custom { constructor(public m: string) {} }
/* uneffect:effect none */
export function odd(): never { throw new Custom("x") as never; }
`, (result) => {
      // `Throw<unknown>` is a throw whose class went unresolved and `effectPermits` leaves it uncovered by
      // anything, so it says the declaration could not be decided rather than that it is wrong.
      expect(result.diagnostics.filter((item) => item.kind === "missing")).toEqual([]);
      expect(row(result, "odd")?.evidence).toBe("unknown");
      expect(reasons(result, "odd")).toContain("unchecked-declaration");
    });
  });

  it("leaves a source that declares nothing exactly as it was", async () => {
    await check(`export function plain(): void { console.log("hi"); }
`, (result) => {
      expect(row(result, "plain")?.evidence).toBe("trusted");
      expect(reasons(result, "plain")).toEqual([]);
      expect(result.diagnostics).toEqual([]);
    });
  });

  it("does not report a declaration that permits more than the analysis found", async () => {
    await check(`/* uneffect:effect Console | Random */
export function writes(): void { console.log("hi"); }
`, (result) => {
      // An over-declaration is a permission the code does not use. Reporting it needs a COMPLETE effect set,
      // and this path does not have one: measured over this repository, every such report was refuted.
      expect(result.diagnostics.filter((item) => item.domain === "effect")).toEqual([]);
    });
  });

  it("changes nothing when the caller did not ask for the declarations to be checked", async () => {
    await check(`/* uneffect:effect none */
export function lies(): void { console.log("hi"); }
`, (result) => {
      expect(row(result, "lies")?.evidence).toBe("trusted");
      expect(result.diagnostics.filter((item) => item.kind === "missing")).toEqual([]);
    }, { requireAnnotations: false });
  });

  it("reports a malformed directive, an unknown effect and an unreadable payload", async () => {
    await check(`/* uneffect:effct Console */
export function typo(): void {}
/* uneffect:effect Telepathy */
export function unknownName(): void {}
/* uneffect:effect FsRead<<<> */
export function malformed(): void {}
`, (result) => {
      const messages = result.diagnostics
        .filter((item) => item.domain === "effect")
        .map((item) => `${item.line}:${item.kind}:${item.message}`);
      expect(messages).toEqual([
        "1:invalid:unknown Uneffect dialect `effct`",
        "3:invalid:unknown effect Telepathy",
        "5:invalid:invalid effect declaration: path atoms must be string literals",
      ]);
    });
  });

  it("reads directives from comment tokens, not from the source text", async () => {
    await check(`export const hint = \`/* uneffect:nonsense \${"X"} */\`;
export function plain(): void { console.log("hi"); }
`, (result) => {
      // This project writes directives inside string literals — its own diagnostic messages suggest one — so a
      // text scan reports the tool's own source as carrying broken annotations.
      expect(result.diagnostics.filter((item) => item.domain === "effect")).toEqual([]);
      expect(row(result, "plain")?.evidence).toBe("trusted");
    });
  });

  it("gives a module-evaluation declaration a boundary to compare against", async () => {
    await check(`/* uneffect:module_effect none */
export const name = "widget";
`, (result) => {
      // A file with nothing to run publishes no module boundary, but one that claims something about module
      // evaluation has made a claim, and an absent row would leave the claim uncompared.
      expect(row(result, "<module>")?.evidence).toBe("inferred");
      expect(result.diagnostics.filter((item) => item.domain === "effect")).toEqual([]);
    });

    await check(`/* uneffect:module_effect none */
console.log("at import");
`, (result) => {
      expect(result.diagnostics.filter((item) => item.kind === "missing").map((item) => item.message))
        .toEqual(["<module> requires /* uneffect:module_effect Console */"]);
    });
  });
});
