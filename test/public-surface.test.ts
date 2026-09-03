import { describe, expect, it } from "vitest";
import * as publicApi from "../src/public.js";
import * as experimental from "../src/experimental.js";

describe("0.3 public surface", () => {
  it("keeps durable high-level facades on the package root", () => {
    expect(publicApi.checkFiles).toBeTypeOf("function");
    expect(publicApi.verifyUneffectProject).toBeTypeOf("function");
    expect(publicApi.generateTemporalModel).toBeTypeOf("function");
    expect(publicApi.analyzeEffects).toBeTypeOf("function");
    expect(publicApi.analyzeProgramEffects).toBeTypeOf("function");
    expect(publicApi.parseEffectSet).toBeTypeOf("function");
    expect(publicApi.capabilityPermits).toBeTypeOf("function");
    expect(publicApi.verifyContracts).toBeTypeOf("function");
    expect(publicApi.verifyTypedArraySafety).toBeTypeOf("function");
    expect(publicApi.defineUneffectValidator).toBeTypeOf("function");
    expect(publicApi.extendBuiltinContractRegistry).toBeTypeOf("function");
    expect(publicApi.compareUneffectFrontends).toBeTypeOf("function");
    expect(publicApi.isContractRuntimeError).toBeTypeOf("function");
    expect(publicApi.parseNat).toBeTypeOf("function");
  });

  it("moves backend and internal IR operations behind experimental", () => {
    expect(publicApi).not.toHaveProperty("logicToSmt");
    expect(publicApi).not.toHaveProperty("executeZ3");
    expect(publicApi).not.toHaveProperty("solveBasicBlockFixedPoint");
    expect(publicApi).not.toHaveProperty("generateResourceSafetyQuint");
    expect(experimental.logicToSmt).toBeTypeOf("function");
    expect(experimental.executeZ3).toBeTypeOf("function");
    expect(experimental.solveBasicBlockFixedPoint).toBeTypeOf("function");
    expect(experimental.generateResourceSafetyQuint).toBeTypeOf("function");
  });
});
