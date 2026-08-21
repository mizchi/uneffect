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
});
