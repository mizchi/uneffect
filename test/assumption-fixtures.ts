import { parseAssumptionRegistry } from "../src/assumption-registry.js";

const digest = (character: string): string => character.repeat(64);

export const reviewedAssumptions = parseAssumptionRegistry({
  schema: "uneffect-assumption-registry/v1",
  records: [
    { id: "wire-format-v1", domain: "typed-array", reason: "validated by the wire-format review", owner: "binary-platform", expiresOn: "2027-01-31", reviewDigest: digest("a") },
    { id: "packet-tag-v1", domain: "typed-array", reason: "reviewed packet tag", owner: "wire-team", expiresOn: "2027-04-01", reviewDigest: digest("b") },
    { id: "telemetry-wire-v1", domain: "typed-array", reason: "validated by the telemetry wire-format conformance suite", owner: "telemetry-platform", expiresOn: "2027-06-30", reviewDigest: digest("c") },
    { id: "runtime-summary-v1", domain: "temporal-contract", reason: "reviewed runtime summary", owner: "runtime-team", expiresOn: "2026-12-31", reviewDigest: digest("d") },
    { id: "telemetry-temporal-v1", domain: "temporal-contract", reason: "reviewed telemetry temporal summary", owner: "telemetry-platform", expiresOn: "2027-06-30", reviewDigest: digest("e") },
    { id: "closed-runtime-v1", domain: "dispatch-sealing", reason: "application owns the complete class graph", owner: "runtime-team", expiresOn: "2027-02-28", reviewDigest: digest("f") },
    { id: "telemetry-runtime-v1", domain: "dispatch-sealing", reason: "application owns the complete telemetry class graph", owner: "telemetry-platform", expiresOn: "2027-08-31", reviewDigest: digest("1") }
  ],
});
