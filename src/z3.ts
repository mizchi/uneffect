import { createRequire } from "node:module";
import { init } from "z3-solver";

/**
 * One initialization of the Z3 WASM build per process, shared by every checker.
 * There is no native Z3 dependency: the solver is the `z3-solver` package.
 */
let runtime: Promise<{ Context: unknown; Z3: { get_full_version(): string } }> | undefined;
let contexts = 0;

async function z3Runtime(): Promise<{ Context: any; Z3: { get_full_version(): string } }> {
  runtime ??= init() as never;
  return await (runtime as Promise<any>);
}

/** A fresh solver context with a unique name, so concurrent checkers cannot collide. */
export async function createZ3Context(purpose: string): Promise<any> {
  const { Context } = await z3Runtime();
  contexts += 1;
  return new Context(`uneffect_${purpose}_${process.pid}_${contexts}`);
}

/** The solver build that produced a result, recorded in evidence artifacts. */
export async function z3Version(): Promise<string> {
  try {
    return (await z3Runtime()).Z3.get_full_version();
  } catch {
    try {
      const packageVersion = (createRequire(import.meta.url)("z3-solver/package.json") as { version?: string }).version;
      return packageVersion ? `z3-solver ${packageVersion}` : "unknown";
    } catch {
      return "unknown";
    }
  }
}
