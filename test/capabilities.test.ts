import { describe, expect, it } from "vitest";
import {
  capabilityPermits,
  parseEffectExpression,
  parseEffectSet,
  type CapabilityEffect,
} from "../src/capabilities.js";

describe("structured capability effects", () => {
  it("reserves none for the empty effect set", () => {
    expect(parseEffectSet("none")).toEqual([]);
    expect(() => parseEffectSet("none | Console")).toThrow(/must be the only member/);
    expect(() => parseEffectExpression("none")).toThrow(/empty effect set/);
  });

  it("parses nested unions and domain-specific atoms through the schema", () => {
    expect(parseEffectExpression('Fetch<GET | POST, "https://api.example.com/v1/**">')).toEqual({
      kind: "capability",
      name: "Fetch",
      arguments: [
        { kind: "finite", atoms: [{ kind: "token", value: "GET" }, { kind: "token", value: "POST" }] },
        { kind: "finite", atoms: [{ kind: "url", value: "https://api.example.com/v1/**" }] },
      ],
    });
  });

  it("represents a bare builtin capability with All arguments", () => {
    expect(parseEffectExpression("FsRead")).toEqual({
      kind: "capability",
      name: "FsRead",
      arguments: [{ kind: "all" }],
    });
  });

  it("uses the registered URL containment relation", () => {
    const allowed = parseEffectExpression('Fetch<GET | POST, "https://api.example.com/v1/**">') as CapabilityEffect;
    const actual = parseEffectExpression('Fetch<GET, "https://api.example.com/v1/users/1">') as CapabilityEffect;
    expect(capabilityPermits(allowed, actual)).toBe(true);
  });

  it("keeps qualified user capabilities structurally extensible", () => {
    expect(parseEffectExpression('app.Database<SELECT | UPDATE, "users">')).toMatchObject({
      kind: "capability",
      name: "app.Database",
      arguments: [
        { kind: "finite", atoms: [{ kind: "token", value: "SELECT" }, { kind: "token", value: "UPDATE" }] },
        { kind: "finite", atoms: [{ kind: "literal", value: "users" }] },
      ],
    });
  });

  it("normalizes WHATWG URL components and applies explicit query semantics", () => {
    const normalized = parseEffectExpression('Fetch<GET, "HTTPS://API.EXAMPLE.COM:443/a/../v1/**?mode=full">') as CapabilityEffect;
    expect(normalized.arguments[1]).toEqual({
      kind: "finite", atoms: [{ kind: "url", value: "https://api.example.com/v1/**?mode=full" }],
    });
    const exactQuery = parseEffectExpression('Fetch<GET, "https://api.example.com/v1/users?mode=full">') as CapabilityEffect;
    const otherQuery = parseEffectExpression('Fetch<GET, "https://api.example.com/v1/users?mode=other">') as CapabilityEffect;
    expect(capabilityPermits(normalized, exactQuery)).toBe(true);
    expect(capabilityPermits(normalized, otherQuery)).toBe(false);

    const noQueryConstraint = parseEffectExpression('Fetch<GET, "https://api.example.com/v1/**">') as CapabilityEffect;
    expect(capabilityPermits(noQueryConstraint, otherQuery)).toBe(true);
  });

  it("rejects URL fragments, wildcard authorities, and wildcard queries", () => {
    expect(() => parseEffectExpression('Fetch<GET, "https://*.example.com/**">')).toThrow();
    expect(() => parseEffectExpression('Fetch<GET, "https://example.com/**#fragment">')).toThrow();
    expect(() => parseEffectExpression('Fetch<GET, "https://example.com/**?q=*">')).toThrow();
  });

  it("uses Deno-compatible Host, Env, and Sys atom domains", () => {
    const net = parseEffectExpression('Net<"*.example.com">') as CapabilityEffect;
    const host = parseEffectExpression('Net<"api.example.com:443">') as CapabilityEffect;
    expect(capabilityPermits(net, host)).toBe(true);
    expect(capabilityPermits(parseEffectExpression('Env<"AWS_*">') as CapabilityEffect, parseEffectExpression('Env<"AWS_REGION">') as CapabilityEffect)).toBe(true);
    expect(() => parseEffectExpression("Sys<launchMissiles>")).toThrow(/unknown Deno Sys descriptor/);
  });

  it("normalizes path separators and rejects ambient environment anchors", () => {
    expect(parseEffectExpression('FsRead<"$TEMP\\cache\\**">')).toMatchObject({
      arguments: [{ atoms: [{ kind: "path", value: "$TEMP/cache/**" }] }],
    });
    expect(() => parseEffectExpression('FsRead<"$HOME/secrets">')).toThrow(/unknown symbolic path anchor/);
    expect(() => parseEffectExpression('FsRead<"$TEMP/../secrets">')).toThrow(/parent traversal/);
  });
});
