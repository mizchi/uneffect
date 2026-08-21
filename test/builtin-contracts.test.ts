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
});
