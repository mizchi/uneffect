import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "@typescript/typescript6";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { initializationRule, lintPrerequisites } from "../src/lint/prerequisites.js";
import { lowerCorsaRuleCfg } from "../src/lint/corsa.js";
import { lowerTypeScriptRuleCfg } from "../src/lint/typescript.js";

describe.each(["typescript", "corsa"] as const)("%s prerequisite rule extraction", frontend => {
  let directory: string, fileName: string;
  beforeAll(() => { directory = mkdtempSync(join(tmpdir(), "uneffect-cfg-lint-")); fileName = join(directory, "input.mts"); });
  afterAll(() => rmSync(directory, { recursive: true, force: true }));
  async function lint(body: string, extra = "") {
    const source = `${extra}\ndeclare function initialize(x: object): void;\ndeclare function use(x: object): void;\ndeclare function reset(x: object): void;\nexport function run(client: object, flag: boolean, other: object) { ${body} }`;
    writeFileSync(fileName, source);
    const program = frontend === "typescript" ? ts.createProgram([fileName], {
      target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext, types: [], noEmit: true,
    }) : undefined;
    const options = { fileName, functionName: "run", bindings: [
      { functionName: "initialize", operation: "initialize", argumentIndex: 0 },
      { functionName: "use", operation: "use", argumentIndex: 0 },
      { functionName: "reset", operation: "reset", argumentIndex: 0 },
    ] };
    const lowered = program ? lowerTypeScriptRuleCfg(program, options) : await lowerCorsaRuleCfg(options);
    return { source, result: lowered.status === "lowered" ? lintPrerequisites(lowered.cfg, initializationRule) : lowered };
  }

  it.each([
    "initialize(client); use(client);",
    "if (flag) initialize(client); else initialize(client); use(client);",
    "if (flag) initialize(client); else return; use(client);",
    "if (flag) throw 'stop'; initialize(client); use(client);",
    "const alias = client; initialize(alias); use(client);",
    "{ const client = {}; initialize(client); use(client); } initialize(client); use(client);",
    "do { initialize(client); } while (flag); use(client);",
    "while (flag) { initialize(client); use(client); }",
    "return; use(client);",
    "if (flag) {} initialize(client); use(client);",
    "while (flag) {} initialize(client); use(client);",
  ])("accepts the supported safe fragment: %s", async body => {
    expect((await lint(body)).result).toMatchObject({ status: "clean", diagnostics: [] });
  });

  it.each([
    "use(client);",
    "if (flag) initialize(client); use(client);",
    "initialize(client); if (flag) reset(client); use(client);",
    "while (flag) initialize(client); use(client);",
    "do { if (flag) break; initialize(client); } while (flag); use(client);",
    "initialize(client); while (flag) { use(client); reset(client); }",
    "do { if (flag) continue; initialize(client); } while (flag); use(client);",
    "{ const client = {}; initialize(client); } use(client);",
  ])("finds a path without the prerequisite: %s", async body => {
    const { source, result } = await lint(body);
    expect(result.status).toBe("findings");
    if (result.status !== "findings") throw new Error("expected diagnostics");
    expect(result.diagnostics).toHaveLength(1);
    expect(source.slice(result.diagnostics[0]!.location.start, result.diagnostics[0]!.location.end)).toBe("use(client)");
  });

  it.each([
    "try { initialize(client); } catch {} use(client);",
    "flag && initialize(client); use(client);",
    "const setup = initialize; setup(client); use(client);",
    "{ const initialize = (x: object) => {}; initialize(client); } use(client);",
    "initialize(client); client = {}; use(client);",
    "initialize(client); return client;",
    "function later() { reset(client); } initialize(client); later(); use(client);",
    "const box = { client }; initialize(client); use(box.client);",
    "initialize(client); Object.assign(client, {}); use(client);",
    "for (;;) { initialize(client); break; } use(client);",
    "initialize(client); reset(other); use(client);",
    "while (flag) { const fresh = {}; initialize(fresh); use(fresh); }",
  ])("reports unsupported semantics without a positive verdict: %s", async body => {
    const { result } = await lint(body);
    expect(result).toMatchObject({ status: "unknown", reason: "unsupported-source" });
    expect(result).not.toHaveProperty("diagnostics");
  });

  it("rejects registered functions that are reassigned outside the selected function", async () => {
    expect((await lint("initialize(client); use(client);", "// @ts-ignore\ninitialize = (x: object) => {};")).result)
      .toMatchObject({ status: "unknown", reason: "unsupported-source" });
  });

  it("preserves locations and symbol identity after Unicode characters", async () => {
    const { source, result } = await lint("const 別名 = client; initialize(別名); reset(client); use(別名);", "// 日本語 🙂");
    expect(result.status).toBe("findings");
    if (result.status !== "findings") throw new Error("expected diagnostics");
    expect(source.slice(result.diagnostics[0]!.location.start, result.diagnostics[0]!.location.end)).toBe("use(別名)");
  });

  it.each([
    "({ initialize } = { initialize: (x: object) => {} });",
    "[initialize] = [(x: object) => {}];",
  ])("rejects destructuring writes to registered operations: %s", async write => {
    expect((await lint("initialize(client); use(client);", `// @ts-ignore\n${write}`)).result)
      .toMatchObject({ status: "unknown", reason: "unsupported-source" });
  });

  it("rejects implicit await using cleanup even with compiler diagnostics suppressed", async () => {
    expect((await lint("await using resource = client; initialize(resource); use(client);", "// @ts-nocheck")).result)
      .toMatchObject({ status: "unknown", reason: "unsupported-source" });
  });

  it("reports compiler errors instead of treating failed source extraction as clean", async () => {
    expect((await lint("initialize(missing); use(client);")).result).toMatchObject({ status: "unknown", reason: "typescript-error" });
  });
});
