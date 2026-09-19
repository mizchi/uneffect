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
  it("does not present a boundary as proven when it declares effects this run did not check", async () => {
    await check(`/* uneffect:effect none */
export function lies(): void { console.log("hi"); }
`, (result) => {
      // The declaration is a claim. A run that accepts `requireAnnotations` and compares nothing must say so,
      // or its silence reads as the check having passed.
      expect(row(result, "lies")?.evidence).toBe("unknown");
      expect(reasons(result, "lies")).toContain("unchecked-declaration");
    });
  });

  it("leaves a source that declares nothing exactly as it was", async () => {
    await check(`export function plain(): void { console.log("hi"); }
`, (result) => {
      expect(row(result, "plain")?.evidence).toBe("trusted");
      expect(reasons(result, "plain")).toEqual([]);
    });
  });

  it("changes nothing when the caller did not ask for the declarations to be checked", async () => {
    await check(`/* uneffect:effect none */
export function lies(): void { console.log("hi"); }
`, (result) => {
      expect(row(result, "lies")?.evidence).toBe("trusted");
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

  it("gives a module-evaluation declaration a boundary to be undecided about", async () => {
    await check(`/* uneffect:module_effect none */
export const name = "widget";
`, (result) => {
      // A file with nothing to run publishes no module boundary, but one that claims something about module
      // evaluation has made a claim, and an absent row would read as there being nothing to check.
      expect(row(result, "<module>")?.evidence).toBe("unknown");
      expect(reasons(result, "<module>")).toEqual(["unchecked-declaration"]);
    });
  });
});
