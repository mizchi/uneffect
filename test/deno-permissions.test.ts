import { describe, expect, it } from "vitest";
import { capabilityPermits, parseEffectExpression, type CapabilityEffect, type Effect } from "../src/capabilities.js";
import { projectDenoPermissions, resolveTargetTemp } from "../src/deno-permissions.js";

const effects = (source: string): Effect[] => source.split(" + ").map(parseEffectExpression);

describe("Deno permission projection", () => {
  it("projects common capability sets and keeps deny policy separate", () => {
    const result = projectDenoPermissions({
      allow: effects('FsRead<"$WORKSPACE_ROOT/data/**"> + Net<"api.example.com:443"> + Env<"AWS_*"> + Sys<hostname | cpus>'),
      deny: effects('Net<"blocked.example.com">'),
    }, { anchors: { WORKSPACE_ROOT: "/repo" }, platform: "posix" });
    expect(result.args).toEqual([
      "--allow-read=/repo/data",
      "--allow-net=api.example.com:443",
      "--allow-env=AWS_*",
      "--allow-sys=cpus,hostname",
      "--deny-net=blocked.example.com",
    ]);
  });

  it("requires explicit symbolic anchor bindings", () => {
    expect(() => projectDenoPermissions({ allow: effects('FsRead<"$CWD/data">'), deny: [] }, { anchors: {}, platform: "posix" }))
      .toThrow(/missing path anchor binding: CWD/);
  });

  it("invalidates the projection artifact digest when anchor bindings change", () => {
    const policy = { allow: effects('FsRead<"$WORKSPACE_ROOT/data/**">'), deny: [] };
    const first = projectDenoPermissions(policy, { anchors: { WORKSPACE_ROOT: "/repo-a" }, platform: "posix" });
    const second = projectDenoPermissions(policy, { anchors: { WORKSPACE_ROOT: "/repo-b" }, platform: "posix" });
    expect(first.bindingDigest).not.toBe(second.bindingDigest);
  });

  it("resolves TEMP from the selected target rather than the analyzer host", () => {
    expect(resolveTargetTemp({ runtime: "node", os: "windows", environment: { TEMP: "C:\\TargetTemp", TMP: "C:\\Other" } })).toBe("C:\\TargetTemp");
    expect(resolveTargetTemp({ runtime: "deno", os: "linux", environment: {} })).toBe("/tmp");
  });

  it("compares paths and environment names with the selected target policy", () => {
    const allowed = parseEffectExpression('FsRead<"$WORKSPACE_ROOT/src/**">') as CapabilityEffect;
    const actual = parseEffectExpression('FsRead<"$CWD/SRC/file.ts">') as CapabilityEffect;
    expect(capabilityPermits(allowed, actual, { platform: "windows", anchors: { WORKSPACE_ROOT: "C:\\Repo", CWD: "c:\\repo" } })).toBe(true);
    const envAllowed = parseEffectExpression('Env<"path">') as CapabilityEffect;
    const envActual = parseEffectExpression('Env<"PATH">') as CapabilityEffect;
    expect(capabilityPermits(envAllowed, envActual, { platform: "windows", anchors: {} })).toBe(true);
    expect(capabilityPermits(envAllowed, envActual, { platform: "posix", anchors: {} })).toBe(false);
  });

  it("records FFI and dynamic-loader subprocess escalation boundaries", () => {
    const ffi = projectDenoPermissions({ allow: effects('Ffi<"$CWD/native.so">'), deny: [] }, { anchors: { CWD: "/repo" }, platform: "posix" });
    expect(ffi.sandboxEscapes).toEqual([{ capability: "Ffi", reason: "native code executes outside the JavaScript permission sandbox" }]);
    const run = projectDenoPermissions({ allow: effects('Run<"git"> + Env<"LD_PRELOAD">'), deny: [] }, { anchors: {}, platform: "posix" });
    expect(run.args).toContain("--allow-run");
    expect(run.scopes.Run).toEqual(["<all>"]);
    expect(run.sandboxEscapes).toEqual([{ capability: "Run", reason: "dynamic-loader environment access can inject code into an allowed subprocess" }]);
  });
});
