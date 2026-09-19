import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkCorsaProject } from "../src/frontends/corsa/corsa-check.js";
import { formatEffect } from "../src/effects/capabilities.js";

type Result = Awaited<ReturnType<typeof checkCorsaProject>>;

async function check(
  files: Record<string, string>,
  run: (result: Result) => void,
  options: { legacy?: boolean } = {},
): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "uneffect-corsa-deco-"));
  try {
    const configFile = join(directory, "tsconfig.json");
    for (const [name, source] of Object.entries(files)) writeFileSync(join(directory, name), source);
    writeFileSync(configFile, JSON.stringify({
      compilerOptions: {
        strict: true, target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", lib: ["ES2022", "DOM"],
        ...(options.legacy === true ? { experimentalDecorators: true } : {}),
      },
      include: ["*.ts"],
    }));
    run(await checkCorsaProject({ configFile }));
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

const row = (result: Result, fileName: string, functionName: string) => result.summaries
  .find((item) => (item.fileName ?? "").endsWith(`/${fileName}`) && item.functionName === functionName);

const effectsOf = (result: Result, fileName: string, functionName: string) =>
  (row(result, fileName, functionName)?.effects ?? []).map(formatEffect).sort();

describe("when a decorator's work runs", () => {
  it("does not prove a module effect-free because its only decorator is on a parameter", async () => {
    await check({
      "dep.ts": `function inject(target: unknown, key: string | symbol | undefined, index: number): void {
  console.log("applied");
  void target; void key; void index;
}
export class Widget { constructor(@inject dep: number) { void dep; } }
`,
      "index.ts": `import "./dep.js";
export function pure(a: number): number { return a + 1; }
`,
    }, (result) => {
      // Importing dep.ts applies the decorator once, so neither module may claim to have run nothing.
      expect(row(result, "dep.ts", "<module>")?.evidence).toBe("unknown");
      expect(row(result, "index.ts", "<module>")?.evidence).toBe("unknown");
    }, { legacy: true });
  });

  it("does not reach trusted while a parameter decorator's capabilities stay unseen", async () => {
    await check({
      "index.ts": `function inject(target: unknown, key: string | symbol | undefined, index: number): void {
  void fetch("https://example.com/register");
  void target; void key; void index;
}
export class Widget {
  size = 1;
  static { console.log("static block ran"); }
  constructor(@inject dep: number) { void dep; }
}
`,
    }, (result) => {
      // One reviewed builtin call inside the class body must not promote the module to the top of the ladder
      // while the decorator's own Fetch and Net are absent from the same row.
      expect(effectsOf(result, "index.ts", "<module>")).toEqual(["Console"]);
      expect(row(result, "index.ts", "<module>")?.evidence).toBe("unknown");
    }, { legacy: true });
  });

  it("charges a parameter decorator's factory to the declaration, not to every construction", async () => {
    await check({
      "index.ts": `function inject(): ParameterDecorator { console.log("factory"); return () => {}; }
export class Widget { size = 1; constructor(@inject() dep: number) { void dep; } }
export function build(): Widget { return new Widget(1); }
`,
    }, (result) => {
      // The factory runs once, where the class is declared. Constructing runs it zero times.
      expect(effectsOf(result, "index.ts", "<module>")).toEqual(["Console"]);
      expect(effectsOf(result, "index.ts", "Widget.constructor")).toEqual([]);
      expect(effectsOf(result, "index.ts", "build")).toEqual([]);
    }, { legacy: true });
  });

  it("charges a method decorator's factory to the declaration even with no instance initializer", async () => {
    await check({
      "index.ts": `function make(): (v: unknown, c: ClassMethodDecoratorContext) => void { console.log("factory"); return () => {}; }
export class Widget { @make() run(): void {} }
`,
    }, (result) => {
      // A decorated member's own syntax boundary starts at its `@` token, so without the redirect the factory
      // call would be charged to the member and reported once per call of it.
      expect(effectsOf(result, "index.ts", "<module>")).toEqual(["Console"]);
      expect(effectsOf(result, "index.ts", "Widget.run")).toEqual([]);
    });
  });

  it("does not present a decorated member's declared body as a proof about the member", async () => {
    await check({
      "index.ts": `function instrument(): (value: () => void, context: ClassMethodDecoratorContext) => () => void {
  return (value) => function (this: unknown): void { console.log("wrapped call"); value.call(this); };
}
export class Widget { @instrument() run(): void {} size = 1; }
`,
    }, (result) => {
      // The decorator's return value replaces the member, so the declared body is not the one that runs.
      expect(row(result, "index.ts", "Widget.run")?.evidence).toBe("unknown");
    });
  });
});
