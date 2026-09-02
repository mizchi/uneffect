import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { resolveStableRegion } from "../src/region-alias.js";

function analyze(body: string) {
  const directory = mkdtempSync(join(tmpdir(), "uneffect-region-alias-"));
  const fileName = join(directory, "entry.ts");
  writeFileSync(fileName, `
    declare function mutate(value: object): void;
    declare function escape(value: object): void;
    function run(state: { nested: object }, key: string) { ${body} }
  `);
  const program = ts.createProgram([fileName], { target: ts.ScriptTarget.ESNext, noEmit: true });
  const source = program.getSourceFile(fileName)!;
  let call: ts.CallExpression | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.getText(source) === "mutate") call = node;
    ts.forEachChild(node, visit);
  };
  visit(source);
  const result = resolveStableRegion(program.getTypeChecker(), call!.arguments[0]!, {
    scope: call!.parent.parent,
    permittedUse: call!.arguments[0]!,
  });
  rmSync(directory, { recursive: true, force: true });
  return result;
}

function analyzeRegionIds(body: string): string[] {
  const directory = mkdtempSync(join(tmpdir(), "uneffect-region-paths-"));
  try {
    const fileName = join(directory, "entry.ts");
    writeFileSync(fileName, `
      declare function mutate(value: object): void;
      function run(state: { left: object; right: object }) { ${body} }
    `);
    const program = ts.createProgram([fileName], { target: ts.ScriptTarget.ESNext, noEmit: true });
    const source = program.getSourceFile(fileName)!;
    const calls: ts.CallExpression[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && node.expression.getText(source) === "mutate") calls.push(node);
      ts.forEachChild(node, visit);
    };
    visit(source);
    return calls.map((call) => {
      const result = resolveStableRegion(program.getTypeChecker(), call.arguments[0]!, {
        scope: call.parent.parent,
        permittedUse: call.arguments[0]!,
      });
      if (result.status !== "resolved") throw new Error(`unexpected ${result.reason}`);
      return result.regionId;
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("common immutable region aliases", () => {
  it("resolves a non-escaping const alias chain and static property path", () => {
    expect(analyze(`
      const root = state;
      const target = root.nested;
      mutate(target);
    `)).toMatchObject({
      status: "resolved",
      region: "state.nested",
      aliases: [{ name: "target", binding: "const" }, { name: "root", binding: "const" }],
    });
  });

  it("assigns distinct machine identities to sibling property regions", () => {
    const [left, right, leftAgain] = analyzeRegionIds(`
      mutate(state.left);
      mutate(state.right);
      mutate(state["left"]);
    `);
    expect(left).not.toBe(right);
    expect(leftAgain).toBe(left);
  });

  it.each([
    ["mutable binding", `let target = state; mutate(target);`],
    ["computed key", `const target = state[key]; mutate(target);`],
    ["escaping alias", `const target = state; escape(target); mutate(target);`],
  ])("fails closed for %s", (_name, body) => {
    expect(analyze(body)).toMatchObject({ status: "unknown" });
  });
});
