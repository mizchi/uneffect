import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { inspectCorsaWorkspaceBuildOutputs } from "../src/project/corsa-build-output.js";
import { composeCorsaWorkspaceSummaries, type CorsaWorkspaceSummary, type CorsaWorkspaceSummaryCall } from "../src/project/corsa-workspace-summaries.js";
import { resolveCorsaExecutable } from "../src/frontends/corsa/corsa-api-frontend.js";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
async function fixture(run: (directory: string, configFile: string, summaries: CorsaWorkspaceSummary[], calls: CorsaWorkspaceSummaryCall[]) => Promise<void>, appSource?: string, setup?: (directory: string) => void) {
  const directory = mkdtempSync(join(tmpdir(), "uneffect-workspace-summaries-"));
  const producer = "export function value(n: number): number { return n + 1; }";
  const source = appSource ?? 'import { value as left } from "../left/index.js"; import { value as right } from "../right/index.js"; export const answer = left(1) + right(2);';
  for (const name of ["left", "right", "app"]) {
    mkdirSync(join(directory, name));
    writeFileSync(join(directory, name, "index.ts"), name === "app" ? source : producer);
    writeFileSync(join(directory, name, "tsconfig.json"), JSON.stringify({ compilerOptions: {
      strict: true, composite: true, target: "ES2022", module: "NodeNext", outDir: "dist", types: [],
    }, files: ["index.ts"], references: name === "app" ? [{ path: "../left" }, { path: "../right" }] : [] }));
  }
  const configFile = join(directory, "app", "tsconfig.json");
  try {
    setup?.(directory);
    execFileSync(resolveCorsaExecutable(), ["--build", configFile], { stdio: "pipe" });
    const build = inspectCorsaWorkspaceBuildOutputs({ configFile });
    expect(build.status, build.message).toBe("verified");
    const summaries = ["left", "right"].map((name): CorsaWorkspaceSummary => ({
      id: name, compiler: { version: build.compiler.version, digest: build.compiler.digest },
      projectFile: join(directory, name, "tsconfig.json"),
      inputDigest: build.projects.find(project => project.configFile === join(directory, name, "tsconfig.json"))!.inputDigest!,
      source: { fileName: join(directory, name, "index.ts"), digest: hash(readFileSync(join(directory, name, "index.ts"), "utf8")), span: { start: 0, end: producer.length } },
      evidence: "verified", claims: { requires: ["n >= 0"], ensures: ["result === n + 1"], effects: name === "left" ? ["Console"] : [] },
    }));
    const calls = ["left(1)", "right(2)"].flatMap(text => {
      const start = source.indexOf(text);
      return start < 0 ? [] : [{ projectFile: configFile, fileName: join(directory, "app", "index.ts"), span: { start, end: start + text.length } }];
    });
    await run(directory, configFile, summaries, calls);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

describe("native workspace summary composition", () => {
  it("binds requires/ensures/effects by exact native source identity, keeping persisted authority trusted", async () => {
    await fixture(async (_directory, configFile, summaries, calls) => {
      const result = await composeCorsaWorkspaceSummaries({ configFile, summaries, calls });
      expect(result.status, JSON.stringify(result.blockers)).toBe("bound");
      expect(result.bindings.map(binding => [binding.summaryId, binding.claims.effects])).toEqual([["left", ["Console"]], ["right", []]]);
      expect(result.bindings.every(binding => binding.evidence === "trusted" && binding.linkage === "verified" && binding.producerEvidence === "verified")).toBe(true);
      expect(result.bindings[0]?.claims.ensures).toEqual(["result === n + 1"]);
      expect(result.bindings[0]?.arguments).toEqual([{ parameter: "n", span: { start: calls[0]!.span.end - 2, end: calls[0]!.span.end - 1 } }]);
    });
  });
  it.each(["compiler", "input", "source", "span", "duplicate", "inferred", "unknown", "claims"])("refuses %s summary evidence", async change => {
    await fixture(async (_directory, configFile, summaries, calls) => {
      const original = summaries[0]!;
      if (change === "compiler") summaries[0] = { ...original, compiler: { ...original.compiler, version: "6.0.3" } };
      if (change === "input") summaries[0] = { ...original, inputDigest: "0".repeat(64) };
      if (change === "source") summaries[0] = { ...original, source: { ...original.source, digest: "0".repeat(64) } };
      if (change === "span") summaries[0] = { ...original, source: { ...original.source, span: { start: 1, end: original.source.span.end } } };
      if (change === "duplicate") summaries.push({ ...original, id: "duplicate" });
      if (change === "inferred" || change === "unknown") summaries[0] = { ...original, evidence: change };
      if (change === "claims") summaries[0] = { ...original, claims: { effects: [42] } as unknown as CorsaWorkspaceSummary["claims"] };
      const result = await composeCorsaWorkspaceSummaries({ configFile, summaries, calls });
      expect(result.status).toBe("unknown");
      expect(result.bindings.some(binding => binding.summaryId === "left" || binding.summaryId === "duplicate")).toBe(false);
      expect(result.blockers.length).toBeGreaterThan(0);
    });
  });
  it("rejects stale summaries even after current outputs have been rebuilt", async () => {
    await fixture(async (directory, configFile, summaries, calls) => {
      writeFileSync(join(directory, "left", "index.ts"), "export function value(n: number): number { return n + 2; }");
      execFileSync(resolveCorsaExecutable(), ["--build", configFile], { stdio: "pipe" });
      const result = await composeCorsaWorkspaceSummaries({ configFile, summaries, calls });
      expect(result.build.status).toBe("verified");
      expect(result.status).toBe("unknown");
      expect(result.bindings.some(binding => binding.summaryId === "left")).toBe(false);
    });
  });
  it("blocks all binding when producer declarations have been changed", async () => {
    await fixture(async (directory, configFile, summaries, calls) => {
      writeFileSync(join(directory, "left", "dist", "index.d.ts"), "export declare function value(n: string): string;");
      const result = await composeCorsaWorkspaceSummaries({ configFile, summaries, calls });
      expect(result.build.status).toBe("mismatch");
      expect(result.status).toBe("unknown");
      expect(result.bindings).toEqual([]);
    });
  });
  it.each([
    'import { value as left } from "../left/index.js"; function call(left: (n: number) => number) { return left(1); }',
    'import { value } from "../left/index.js"; let left = value; export const answer = left(1);',
  ])("rejects shadowed imports and mutable local aliases", async source => {
    await fixture(async (_directory, configFile, summaries, calls) => {
      const result = await composeCorsaWorkspaceSummaries({ configFile, summaries, calls });
      expect(result.status).toBe("unknown");
      expect(result.bindings).toEqual([]);
    }, source);
  });
  it("does not bind a same-signature replacement of an exported function", async () => {
    await fixture(async (directory, configFile, summaries, calls) => {
      const source = readFileSync(join(directory, "left", "index.ts"), "utf8") + "\n// @ts-expect-error: exercise binding stability despite suppressed diagnostics\nvalue = (n: number) => n + 5;";
      writeFileSync(join(directory, "left", "index.ts"), source);
      execFileSync(resolveCorsaExecutable(), ["--build", configFile], { stdio: "pipe" });
      const build = inspectCorsaWorkspaceBuildOutputs({ configFile });
      summaries[0] = { ...summaries[0]!, inputDigest: build.projects[0]!.inputDigest!, source: { ...summaries[0]!.source, digest: hash(source) } };
      const result = await composeCorsaWorkspaceSummaries({ configFile, summaries, calls });
      expect(result.status).toBe("unknown");
      expect(result.bindings.some(binding => binding.summaryId === "left")).toBe(false);
    });
  });
  it("rejects a mutable exported alias even when its call signature points to the original function", async () => {
    await fixture(async (_directory, configFile, summaries, calls) => {
      const result = await composeCorsaWorkspaceSummaries({ configFile, summaries, calls });
      expect(result.status).toBe("unknown");
      expect(result.bindings).toEqual([]);
    }, 'import { forwarded as left } from "../left/index.js"; export const answer = left(1);', directory => {
      const file = join(directory, "left", "index.ts");
      writeFileSync(file, readFileSync(file, "utf8") + "\nexport let forwarded = value; forwarded = (n: number) => n + 9;");
    });
  });
  it.each(['ns.value', 'ns["value"]'])("rejects a consumer that replaces %s before calling the imported binding", async target => {
    const source = 'import { value as left } from "../left/index.js"; import * as ns from "../left/index.js";\n'
      + `// @ts-expect-error: model a consumer that suppresses import assignment diagnostics\n${target} = (n: number) => n + 9;\nexport const answer = left(1);`;
    await fixture(async (directory, configFile, summaries, calls) => {
      expect(execFileSync(process.execPath, ["-p", `require(${JSON.stringify(join(directory, "dist", "app", "index.js"))}).answer`], { encoding: "utf8" }).trim()).toBe("10");
      const result = await composeCorsaWorkspaceSummaries({ configFile, summaries, calls });
      expect(result.status).toBe("unknown");
      expect(result.bindings).toEqual([]);
    }, source, directory => {
      for (const name of ["left", "right", "app"]) {
        const file = join(directory, name, "tsconfig.json"), config = JSON.parse(readFileSync(file, "utf8"));
        config.compilerOptions.outDir = `../dist/${name}`;
        writeFileSync(file, JSON.stringify(config));
      }
    });
  });
  it("follows native re-export aliases and preserves Unicode/CRLF argument coordinates", async () => {
    const source = '// 日本語 😀\r\nimport { renamed as left } from "../left/barrel.js"; export const answer = left(1);';
    await fixture(async (_directory, configFile, summaries, calls) => {
      const result = await composeCorsaWorkspaceSummaries({ configFile, summaries, calls });
      expect(result.status, JSON.stringify(result.blockers)).toBe("bound");
      expect(result.bindings[0]?.summaryId).toBe("left");
      expect(source.slice(result.bindings[0]!.arguments[0]!.span.start, result.bindings[0]!.arguments[0]!.span.end)).toBe("1");
    }, source, directory => {
      writeFileSync(join(directory, "left", "barrel.ts"), 'export { value as renamed } from "./index.js";');
      const file = join(directory, "left", "tsconfig.json"), config = JSON.parse(readFileSync(file, "utf8"));
      config.files.push("barrel.ts");
      writeFileSync(file, JSON.stringify(config));
    });
  });
  it("rejects an incomplete call range", async () => {
    await fixture(async (_directory, configFile, summaries, calls) => {
      calls[0] = { ...calls[0]!, span: { ...calls[0]!.span, end: calls[0]!.span.end - 1 } };
      const result = await composeCorsaWorkspaceSummaries({ configFile, summaries, calls });
      expect(result.status).toBe("unknown");
      expect(result.bindings.some(binding => binding.summaryId === "left")).toBe(false);
    });
  });
  it("does not allow caller mutation to change claims while native snapshots open", async () => {
    await fixture(async (_directory, configFile, summaries, calls) => {
      const pending = composeCorsaWorkspaceSummaries({ configFile, summaries, calls });
      (summaries[0]!.claims.effects as string[]).push("Fetch");
      const result = await pending;
      expect(result.status, JSON.stringify(result.blockers)).toBe("bound");
      expect(result.bindings[0]?.claims.effects).toEqual(["Console"]);
    });
  });
  it("clears bindings if workspace outputs change while native snapshots open", async () => {
    await fixture(async (directory, configFile, summaries, calls) => {
      const pending = composeCorsaWorkspaceSummaries({ configFile, summaries, calls });
      writeFileSync(join(directory, "left", "dist", "index.js"), "// modified during native open");
      const result = await pending;
      expect(result.status).toBe("unknown");
      expect(result.bindings).toEqual([]);
      expect(result.blockers.some(blocker => blocker.message.includes("changed during summary composition"))).toBe(true);
    });
  });
  it("runs with JavaScript compiler imports forbidden", async () => {
    await fixture(async (_directory, configFile, summaries, calls) => {
      const script = `import { registerHooks } from 'node:module'; import assert from 'node:assert/strict';
        registerHooks({ resolve(specifier, context, next) { if (/^(?:typescript(?:\\/|$)|@typescript\\/typescript6(?:\\/|$))/.test(specifier)) throw new Error('compiler forbidden'); return next(specifier, context); } });
        const { composeCorsaWorkspaceSummaries } = await import('./src/project/corsa-workspace-summaries.ts');
        const result = await composeCorsaWorkspaceSummaries(${JSON.stringify({ configFile, summaries, calls })});
        assert.equal(result.status, 'bound', JSON.stringify(result.blockers));`;
      execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { stdio: "pipe", timeout: 30_000 });
    });
  });
});
