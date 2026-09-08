import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { lowerCorsaRegistryReadCfg } from "../src/lint/corsa.js";
import { lintPrerequisites, ownPropertyReadRule } from "../src/lint/index.js";

async function analyze(body: string, parameters = "table: Record<string, () => void>, key: string, other: string", budget?: number, flow: "expression" | "statement" = "expression", asynchronous = false) {
  const directory = mkdtempSync(join(tmpdir(), "uneffect-registry-rule-"));
  try {
    const fileName = join(directory, "input.ts");
    writeFileSync(fileName, `export ${asynchronous ? "async " : ""}function run(${parameters}) { ${body} }`);
    const lowered = await lowerCorsaRegistryReadCfg({ fileName, functionName: "run", registry: "table", flow });
    return lowered.status === "lowered" ? lintPrerequisites(lowered.cfg, ownPropertyReadRule, { budget }) : lowered;
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

describe("own property before registry read", () => {
  it.each(["freeze", "keys"])("does not trust a shadowed Object.%s for enumeration", async method => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-shadowed-enumeration-"));
    try {
      const fileName = join(directory, "input.ts");
      const mock = method === "freeze" ? "const Object = { freeze: <T>(value: T) => value, keys: globalThis.Object.keys };" : "";
      const params = method === "keys" ? 'Object: { keys(value: object): string[] }' : "";
      writeFileSync(fileName, `${mock} const flags: Readonly<Record<string, string>> = Object.freeze({ FsRead: "read" });
        export function run(${params}) { for (const name of Object.keys(flags)) { flags[name]; } }`);
      const lowered = await lowerCorsaRegistryReadCfg({ fileName, functionName: "run", registry: "flags" });
      expect(lowered.status).toBe("lowered");
      if (lowered.status === "lowered") expect(lintPrerequisites(lowered.cfg, ownPropertyReadRule).status).toBe("findings");
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it.each([["root.table", "findings"], ["alias", "clean"]])("keeps captured property regions separate from %s guards", async (guard, status) => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-captured-registry-"));
    try {
      const fileName = join(directory, "input.ts");
      writeFileSync(fileName, `export function run(root: { table: Record<string, string> }, key: string) {
        const alias = root.table; root.table = {}; return Object.hasOwn(${guard}, key) ? alias[key] : undefined;
      }`);
      const lowered = await lowerCorsaRegistryReadCfg({ fileName, functionName: "run", registry: "root.table" });
      expect(lowered.status).toBe("lowered");
      if (lowered.status === "lowered") expect(lintPrerequisites(lowered.cfg, ownPropertyReadRule).status).toBe(status);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
  it.each([
    [true, 'for (const name of Object.keys(flags)) { values.push(`--${prefix}-${flags[name]}`); }', "clean"],
    [false, 'for (const name of Object.keys(flags)) { values.push(`--${prefix}-${flags[name]}`); }', "findings"],
    [true, 'for (const name of Object.keys({ other: true })) { values.push(flags[name]); }', "findings"],
    [true, 'for (let name of Object.keys(flags)) { name = "constructor"; values.push(flags[name]); }', "findings"],
  ] as const)("authenticates frozen table enumeration: frozen=%s %s", async (frozen, body, status) => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-enumerated-registry-"));
    try {
      const fileName = join(directory, "input.ts");
      const initializer = frozen ? 'Object.freeze({ FsRead: "read" })' : '{ FsRead: "read" }';
      writeFileSync(fileName, `const flags: Readonly<Record<string, string>> = ${initializer}; export function run(prefix: string, values: string[]) { ${body} }`);
      const lowered = await lowerCorsaRegistryReadCfg({ fileName, functionName: "run", registry: "flags" });
      expect(lowered.status).toBe("lowered");
      if (lowered.status === "lowered") expect(lintPrerequisites(lowered.cfg, ownPropertyReadRule).status).toBe(status);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
  it.each([
    ['Object.hasOwn(table, key) ? `${table[key]}` : undefined;', "clean"],
    ['Object.hasOwn(table, key) ? `prefix:${"literal"}:${table[key]}` : undefined;', "clean"],
    ['`${table[key]}`;', "findings"],
    ['const value = { toString() { key = other; return ""; } }; Object.hasOwn(table, key) ? `${value}${table[key]}` : undefined;', "findings"],
    ['Object.hasOwn(table, key) ? `${other}${table[key]}` : undefined;', "findings"],
    ['Object.hasOwn(table, key) ? `${/pattern/}${table[key]}` : undefined;', "findings"],
  ])("models template evaluation and coercion: %s", async (body, status) => {
    expect((await analyze(body)).status).toBe(status);
  });
  it.each([
    ["const alias = table; return Object.hasOwn(alias, key) ? alias[key] : undefined;", "clean"],
    ["const alias = table; alias[key]();", "findings"],
    ["const alias = table; table = {}; return Object.hasOwn(table, key) ? alias[key] : undefined;", "findings"],
    ["const alias = table; const same = alias; return Object.hasOwn(alias, key) ? same[key] : undefined;", "clean"],
    ["const alias = table; return Object.hasOwn(table, key) ? alias[key] : undefined;", "findings"],
    ["let alias = table; return Object.hasOwn(alias, key) ? alias[key] : undefined;", "unknown"],
  ])("handles stable const aliases: %s", async (body, status) => {
    expect((await analyze(body)).status).toBe(status);
  });
  it("selects module const tables by native declaration identity", async () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-registry-module-"));
    try {
      const fileName = join(directory, "input.ts");
      writeFileSync(fileName, 'const handlers: Record<string, string> = { known: "value" }; export function run(key: string) { if (!Object.hasOwn(handlers, key)) return; return handlers[key]; }');
      const lowered = await lowerCorsaRegistryReadCfg({ fileName, functionName: "run", registry: "handlers", flow: "statement" });
      expect(lowered.status).toBe("lowered");
      if (lowered.status === "lowered") expect(lintPrerequisites(lowered.cfg, ownPropertyReadRule).status).toBe("clean");
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
  it.each([
    "if (!Object.hasOwn(table, key)) return; table[key]();",
    "if (Object.hasOwn(table, key)) table[key]();",
    'if (!Object.hasOwn(table, key)) throw new Error("missing"); const action = table[key]; action();',
    "if (Object.hasOwn(table, key)) { const action = table[key]; action(); } else { return; }",
    "return; table[key]();",
    "while (Object.hasOwn(table, key)) { table[key](); break; }",
  ])("carries statement guards and termination: %s", async body => {
    expect((await analyze(body, undefined, undefined, "statement")).status).toBe("clean");
  });
  it.each([
    'if (!Object.hasOwn(table, key)) return; key = "constructor"; table[key]();',
    "if (Object.hasOwn(table, key)) {} table[key]();",
    "if (!Object.hasOwn(table, other)) return; table[key]();",
    "if (!Object.hasOwn(table, key)) return; table = {}; table[key]();",
    "if (!Object.hasOwn(table, key)) return; delete table[key]; table[key]();",
    "const mutate = () => { key = other; }; if (!Object.hasOwn(table, key)) return; mutate(); table[key]();",
    "if (!Object.hasOwn(table, key)) return; while (other) { key = other; } table[key]();",
    "do { table[key](); } while (Object.hasOwn(table, key));",
    "Object.hasOwn(table, key); table[key]();",
    "if (Object.hasOwn(table, key)) { let key = other; table[key](); }",
  ])("invalidates or joins statement guarantees: %s", async body => {
    expect((await analyze(body, undefined, undefined, "statement")).status).toBe("findings");
  });
  it("does not apply an early-return guard across catch/finally", async () => {
    const body = "try { if (!Object.hasOwn(table, key)) return; } finally { key = other; } table[key]();";
    expect(await analyze(body, undefined, undefined, "statement")).toMatchObject({ status: "unknown", reason: "unsupported-source" });
  });
  it("discards guards at asynchronous suspension", async () => {
    expect((await analyze("if (!Object.hasOwn(table, key)) return; await Promise.resolve(); table[key]();",
      undefined, undefined, "statement", true)).status).toBe("findings");
  });
  it("rejects interleaved writes and reads in destructuring assignments", async () => {
    const body = "let action: (() => void) | undefined; if (!Object.hasOwn(table, key)) return; [key, action = table[key]] = [other, undefined];";
    expect(await analyze(body, undefined, undefined, "statement")).toMatchObject({ status: "unknown", reason: "unsupported-source" });
  });
  it.each([
    "const action = table[key]; if (!action) return; action();",
    "Object.hasOwn(table, other) ? table[key]() : undefined;",
    "Object.hasOwn(table, key) || table[key]();",
    'Object.hasOwn(table, key) ? (key = "constructor", table[key]()) : undefined;',
    'const mutate = () => { key = other; }; Object.hasOwn(table, key) ? (mutate(), table[key]()) : undefined;',
    'const values = { *[Symbol.iterator]() { key = other; yield 1; } }; Object.hasOwn(table, key) ? [...values, table[key]] : undefined;',
  ])("finds an unguarded read: %s", async body => {
    const result = await analyze(body);
    expect(result.status).toBe("findings");
    if (result.status === "findings") expect(result.diagnostics).toContainEqual(expect.objectContaining({ ruleId: "own-property-before-read", operation: "read", missing: ["own-property"] }));
  });

  it.each([
    "const action = Object.hasOwn(table, key) ? table[key] : undefined; if (action) action();",
    "Object.hasOwn(table, key) && table[key]();",
    "!Object.hasOwn(table, key) || table[key]();",
    "!Object.hasOwn(table, key) ? undefined : table[key]();",
    'Object.hasOwn(table, "constructor") ? table.constructor() : undefined;',
  ])("accepts an authenticated expression guard: %s", async body => {
    expect((await analyze(body)).status).toBe("clean");
  });

  it("does not trust a shadowed Object.hasOwn", async () => {
    const result = await analyze("Object.hasOwn(table, key) ? table[key]() : undefined;",
      "table: Record<string, () => void>, key: string, Object: { hasOwn(table: object, key: string): boolean }");
    expect(result.status).toBe("findings");
  });

  it.each([
    "if (!Object.hasOwn(table, key)) return; table[key]();",
    "if (Object.hasOwn(table, key)) table[key]();",
    "return () => table[key]();",
    'Object.hasOwn(table, key) ? { [other]: table[key] } : undefined;',
  ])("reports unsupported flow or aliases without an empty clean result: %s", async body => {
    expect((await analyze(body)).status).toBe("unknown");
  });

  it("retains the prerequisite proof budget", async () => {
    expect(await analyze("table[key]();", undefined, 1)).toMatchObject({ status: "unknown", reason: "proof-budget-exhausted" });
  });
  it("rejects native type errors before checking reads", async () => {
    expect(await analyze('const wrong: number = "wrong"; table[key]();')).toMatchObject({ status: "unknown", reason: "typescript-error" });
  });

  it("automatically distinguishes the actual buggy and fixed replay source without JavaScript TypeScript", () => {
    const file = resolve("src/evidence/model-replay.ts");
    const current = readFileSync(file, "utf8");
    // Verbatim model-replay.ts from b77d95d0; no Git history is required in CI.
    const original = readFileSync("test/fixtures/registry-replay-before.ts.txt", "utf8");
    const directory = mkdtempSync(join(tmpdir(), "uneffect-registry-dogfood-"));
    try {
      writeFileSync(join(directory, "package.json"), JSON.stringify({ type: "module" }));
      for (const [name, source, expected] of [["before", original, "findings"], ["after", current, "clean"]] as const) {
        const input = join(directory, `${name}.ts`), config = join(directory, "tsconfig.json");
        const relocated = source.replaceAll('"../spec/temporal-expressions.js"', JSON.stringify(resolve("src/spec/temporal-expressions.ts")))
          .replaceAll('"../spec/spec-ir.js"', JSON.stringify(resolve("src/spec/spec-ir.ts")));
        writeFileSync(input, relocated);
        writeFileSync(config, JSON.stringify({ extends: resolve("tsconfig.json"), compilerOptions: {
          noEmit: true, rootDir: "/", typeRoots: [resolve("node_modules/@types")], allowImportingTsExtensions: true,
        }, include: [], files: [input] }));
        const output = execFileSync(process.execPath, ["--import", resolve("test/hooks/install-reject-js-typescript.mjs"), "--import", "tsx", "--input-type=module", "-e", `
          import { lowerCorsaRegistryReadCfg } from ${JSON.stringify(resolve("src/lint/corsa.ts"))};
          import { ownPropertyReadRule, lintPrerequisites } from ${JSON.stringify(resolve("src/lint/index.ts"))};
          const lowered = await lowerCorsaRegistryReadCfg(${JSON.stringify({ fileName: input, functionName: "replayModelCounterexample", registry: "adapter.actions", configFile: config })});
          console.log(JSON.stringify(lowered.status === "lowered" ? lintPrerequisites(lowered.cfg, ownPropertyReadRule) : lowered));
        `], { encoding: "utf8", timeout: 60_000 });
        const result = JSON.parse(output);
        expect(result.status, output).toBe(expected);
        if (expected === "findings") {
          expect(result.diagnostics).toHaveLength(1);
          const span = result.diagnostics[0].location;
          expect(relocated.slice(span.start, span.end)).toBe("adapter.actions[step.action]");
        }
      }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
