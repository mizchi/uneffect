import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { generateComposedQuint, parseTemporalComposition } from "../src/temporal-compose.js";

const source = `
/*
 * uneffect:
 * state phase: int
 * init phase = 0
 * temporal completedInOrder: pc !== 2 || phase === 2
 */
/*
 * uneffect:
 * temporal_requires phase === 0
 * temporal_ensures phase' = 1
 * temporal_modifies phase
 */
function open() {}
/*
 * uneffect:
 * temporal_requires phase === 1
 * temporal_ensures phase' = 2
 * temporal_modifies phase
 */
function close() {}
function main() { open(); close() }
`;

function runQuint(program: string, invariant = "completedInOrder"): ReturnType<typeof spawnSync> {
  const directory = mkdtempSync(join(tmpdir(), "uneffect-compose-"));
  const path = join(directory, "compose.qnt");
  writeFileSync(path, program);
  return spawnSync("pnpm", ["exec", "quint", "run", path, `--invariant=${invariant}`, "--max-steps=6", "--max-samples=100", "--seed=0x1234", "--verbosity=1"], { encoding: "utf8", timeout: 30_000 });
}

describe("temporal function-summary composition", () => {
  it("infers the local call sequence and composes verified summaries", () => {
    const composition = parseTemporalComposition("calls.ts", source, "main");
    expect(composition.calls.map((call) => call.callee)).toEqual(["open", "close"]);
    expect(composition.summaries.get("open")?.evidence).toBe("trusted");
    expect(composition.stutteringPolicy).toBe("explicit-unchanged");
    expect(composition.calls.every((call) => call.span.start < call.span.end)).toBe(true);
    const result = runQuint(generateComposedQuint("composed", composition));
    const output = String(result.stdout) + String(result.stderr);
    expect(result.status, output).toBe(0);
    expect(output).toContain("No violation found");
  });

  it("keeps a negative control where omitted call preconditions expose bad ordering", () => {
    const reversed = source.replace("open(); close()", "close(); open()");
    const composition = parseTemporalComposition("broken.ts", reversed, "main");
    const result = runQuint(generateComposedQuint("broken", composition, { enforceRequires: false }));
    expect(result.status).not.toBe(0);
    expect(String(result.stdout) + String(result.stderr)).toMatch(/Invariant.*violated|violation found/i);
  });

  it("discharges a declared synchronous throw at a try/catch boundary", () => {
    const throwing = `
      /* uneffect: state phase: int */
      /* uneffect: init phase = 0 */
      /* uneffect: temporal neverEscapes: pc !== -1 */
      /*
       * uneffect:
       * temporal_throws RangeError
       */
      function dangerous() {}
      function main() { try { dangerous() } catch {} }
    `;
    const composition = parseTemporalComposition("caught.ts", throwing, "main");
    expect(composition.calls[0]).toMatchObject({ callee: "dangerous", catchesThrow: true });
    const result = runQuint(generateComposedQuint("caught", composition), "neverEscapes");
    expect(result.status, String(result.stdout) + String(result.stderr)).toBe(0);
  });

  it("keeps an uncaught throw as an escaping control state", () => {
    const throwing = `
      /* uneffect: state phase: int */
      /* uneffect: init phase = 0 */
      /* uneffect: temporal neverEscapes: pc !== -1 */
      /* uneffect: temporal_throws RangeError */
      function dangerous() {}
      function main() { dangerous() }
    `;
    const composition = parseTemporalComposition("uncaught.ts", throwing, "main");
    expect(composition.calls[0]).toMatchObject({ catchesThrow: false });
    const result = runQuint(generateComposedQuint("uncaught", composition), "neverEscapes");
    expect(result.status).not.toBe(0);
    expect(String(result.stdout) + String(result.stderr)).toMatch(/Invariant.*violated|violation found/i);
  });

  it("composes non-empty catch/finally bodies and skips statements after return", () => {
    const supported = `
      /* uneffect: state phase: int */
      /* uneffect: init phase = 0 */
      /* uneffect: temporal_throws Error */ function dangerous() {}
      /* uneffect: temporal_ensures phase' = phase + 1 */
      /* uneffect: temporal_modifies phase */ function recover() {}
      /* uneffect: temporal_ensures phase' = phase + 1 */
      /* uneffect: temporal_modifies phase */ function cleanup() {}
      function main() { try { dangerous() } catch { recover() } finally { cleanup() } return; dangerous() }
    `;
    const composition = parseTemporalComposition("catch.ts", supported, "main");
    expect(composition.calls.map((call) => call.callee)).toEqual(["dangerous", "recover", "cleanup"]);
    expect(composition.calls[0]?.errorTarget).toBe(1);
    expect(composition.calls[0]?.normalTarget).toBe(2);
    expect(composition.calls[1]?.normalTarget).toBe(2);
  });

  it("models awaited rejection, suspension, resume, and cancellation exits", () => {
    const asyncSource = `
      /* uneffect: state phase: int */
      /* uneffect: init phase = 0 */
      /* uneffect: temporal neverRejects: pc !== -2 */
      /* uneffect: temporal neverCancels: !cancelled */
      /* uneffect: temporal_eventually finishes: pc === 1 */
      /* uneffect: temporal_rejects Error */
      /* uneffect: temporal_suspends true */
      /* uneffect: temporal_cancellable true */
      /* uneffect: temporal_fair weak */
      async function wait() {}
      async function main() { try { await wait() } catch {} }
    `;
    const composition = parseTemporalComposition("async.ts", asyncSource, "main");
    expect(composition.calls[0]).toMatchObject({ awaited: true, catchesThrow: true });
    const program = generateComposedQuint("async_exits", composition);
    expect(program).toContain("action reject_0_wait");
    expect(program).toContain("action suspend_0_wait");
    expect(program).toContain("action cancel_0_wait");
    expect(program).toContain("temporal finishes = eventually(pc == 1)");
    expect(program).toContain("resume_0_wait.weakFair(fairnessVars)");
    const directory = mkdtempSync(join(tmpdir(), "uneffect-liveness-"));
    const path = join(directory, "liveness.qnt");
    writeFileSync(path, program);
    const typecheck = spawnSync("pnpm", ["exec", "quint", "typecheck", path], { encoding: "utf8", timeout: 30_000 });
    expect(typecheck.status, typecheck.stdout + typecheck.stderr).toBe(0);
    expect(runQuint(program, "neverRejects").status).toBe(0);
    const cancelled = runQuint(program, "neverCancels");
    expect(cancelled.status).not.toBe(0);
    expect(String(cancelled.stdout) + String(cancelled.stderr)).toMatch(/Invariant.*violated|violation found/i);
  }, 20_000);
});
