import { describe, expect, it } from "vitest";
import { builtinContractRegistry } from "../src/builtin-contracts.js";

describe("builtin semantic overlays", () => {
  it("refines node:os tmpdir as the symbolic temporary root", () => {
    expect(builtinContractRegistry.contracts).toContainEqual({
      symbol: { module: "node:os", export: "tmpdir" },
      result: { kind: "path", pattern: "$TEMP" },
      evidence: "trusted",
    });
  });

  it("classifies every initial DOM operation kind", () => {
    const kinds = builtinContractRegistry.contracts.flatMap((contract) => contract.operation?.kind === "dom" ? [contract.operation.operation] : []);
    expect(new Set(kinds)).toEqual(new Set(["Read", "LayoutRead", "ValueWrite", "TreeWrite", "Create", "Listen", "Dispatch", "Parse"]));
  });

  it("registers AbortSignal composition by builtin symbol identity", () => {
    expect(builtinContractRegistry.contracts).toEqual(expect.arrayContaining([
      expect.objectContaining({ symbol: { module: "global", export: "AbortSignal.abort" }, operation: { kind: "abort-static", reasonArgument: 0 } }),
      expect.objectContaining({ symbol: { module: "global", export: "AbortSignal.any" }, operation: { kind: "abort-any", signalsArgument: 0 } }),
    ]));
  });

  it("registers prioritized scheduler tasks by builtin symbol identity", () => {
    expect(builtinContractRegistry.contracts).toContainEqual(expect.objectContaining({
      symbol: { module: "lib.dom", export: "Scheduler#postTask" },
      operation: { kind: "scheduler-post-task", callbackArgument: 0, optionsArgument: 1 },
    }));
    expect(builtinContractRegistry.contracts).toContainEqual(expect.objectContaining({
      symbol: { module: "lib.dom", export: "Scheduler#yield" },
      operation: { kind: "scheduler-yield" },
    }));
  });

  it("registers Node next-tick and check-phase scheduling by builtin identity", () => {
    expect(builtinContractRegistry.contracts).toEqual(expect.arrayContaining([
      expect.objectContaining({ symbol: { module: "lib.node", export: "Process#nextTick" }, operation: expect.objectContaining({ kind: "timer", queue: "next-tick" }) }),
      expect.objectContaining({ symbol: { module: "global", export: "setImmediate" }, operation: expect.objectContaining({ kind: "timer", queue: "check" }) }),
    ]));
  });

  it("marks one-shot node:fs completion callbacks without changing sync or Promise APIs", () => {
    const lookup = (module: string, name: string) => builtinContractRegistry.contracts.find((contract) => contract.symbol.module === module && contract.symbol.export === name)?.operation;
    for (const name of ["access", "readFile", "writeFile", "copyFile", "read", "write", "rename", "rm"]) {
      expect(lookup("node:fs", name)).toMatchObject({ kind: "fs", callbackArgumentFromEnd: 1, callbackQueue: "poll" });
    }
    expect(lookup("node:fs", "readFileSync")).not.toHaveProperty("callbackQueue");
    expect(lookup("node:fs/promises", "readFile")).not.toHaveProperty("callbackQueue");
    expect(lookup("node:fs", "watch")).not.toHaveProperty("callbackQueue");
  });
});
