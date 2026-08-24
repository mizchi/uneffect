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
    for (const name of ["watch", "watchFile"]) {
      expect(lookup("node:fs", name)).toMatchObject({
        kind: "fs", callbackArgumentFromEnd: 1, callbackMinimumArguments: 2,
        callbackMustBeCallable: true, callbackQueue: "poll", callbackRepeats: true,
      });
    }
  });

  it("registers node:net Server.close as an externally completed close-phase callback", () => {
    expect(builtinContractRegistry.contracts).toContainEqual(expect.objectContaining({
      symbol: { module: "node:net", export: "Server#close" },
      operation: { kind: "deferred-callback", callbackArgumentFromEnd: 1, queue: "close" },
    }));
  });

  it("registers node:net Server.listen as scoped next-tick work", () => {
    expect(builtinContractRegistry.contracts).toContainEqual(expect.objectContaining({
        symbol: { module: "node:net", export: "Server#listen" },
        operation: {
          kind: "deferred-callback", callbackArgumentFromEnd: 1, callbackMinimumArguments: 2,
          callbackMustBeCallable: true, queue: "next-tick", effect: "Net",
          effectScopeArgument: 0, effectScopeKind: "net-connect",
        },
      }));
  });

  it("registers node:net connection listeners as externally completed poll callbacks", () => {
    for (const name of ["connect", "createConnection"]) {
      expect(builtinContractRegistry.contracts).toContainEqual(expect.objectContaining({
        symbol: { module: "node:net", export: name },
        operation: { kind: "deferred-callback", callbackArgumentFromEnd: 1, queue: "poll", effect: "Net", effectScopeArgument: 0, effectScopeKind: "net-connect" },
      }));
    }
    expect(builtinContractRegistry.contracts).toContainEqual(expect.objectContaining({
      symbol: { module: "node:net", export: "Socket#connect" },
      operation: { kind: "deferred-callback", callbackArgumentFromEnd: 1, queue: "poll", effect: "Net", effectScopeArgument: 0, effectScopeKind: "net-connect" },
    }));
  });

  it("registers Node DNS callbacks as Net-capable poll work", () => {
    expect(builtinContractRegistry.contracts).toContainEqual(expect.objectContaining({
      symbol: { module: "node:dns", export: "lookup" },
      operation: { kind: "deferred-callback", callbackArgumentFromEnd: 1, queue: "poll", effect: "Net", effectScopeArgument: 0 },
    }));
    expect(builtinContractRegistry.contracts).toContainEqual(expect.objectContaining({
      symbol: { module: "node:dns", export: "lookupService" },
      operation: { kind: "deferred-callback", callbackArgumentFromEnd: 1, queue: "poll", effect: "Net" },
    }));
  });

  it("maps Node OS information APIs to Deno-compatible Sys authority", () => {
    const expected = new Map([
      ["hostname", "Sys<hostname>"],
      ["release", "Sys<osRelease>"],
      ["uptime", "Sys<osUptime>"],
      ["loadavg", "Sys<loadavg>"],
      ["networkInterfaces", "Sys<networkInterfaces>"],
      ["totalmem", "Sys<systemMemoryInfo>"],
      ["freemem", "Sys<systemMemoryInfo>"],
      ["cpus", "Sys<cpus>"],
      ["availableParallelism", "Sys<cpus>"],
      ["homedir", "Sys<homedir>"],
      ["userInfo", "Sys<username | uid | gid | homedir>"],
    ]);
    for (const [name, effect] of expected) {
      expect(builtinContractRegistry.contracts).toContainEqual(expect.objectContaining({
        symbol: { module: "node:os", export: name },
        operation: { kind: "effect", effect },
      }));
    }
  });

  it("registers node:crypto randomBytes as Random-capable poll work when a callback is supplied", () => {
    expect(builtinContractRegistry.contracts).toContainEqual(expect.objectContaining({
      symbol: { module: "node:crypto", export: "randomBytes" },
      operation: { kind: "deferred-callback", callbackArgumentFromEnd: 1, callbackMinimumArguments: 2, queue: "poll", effect: "Random" },
    }));
  });

  it("registers Node HTTP response listeners as scoped Net poll work", () => {
    for (const module of ["node:http", "node:https"]) for (const name of ["request", "get"]) {
      expect(builtinContractRegistry.contracts).toContainEqual(expect.objectContaining({
        symbol: { module, export: name },
        operation: {
          kind: "deferred-callback", callbackArgumentFromEnd: 1, callbackMinimumArguments: 2,
          callbackMustBeCallable: true, queue: "poll", effect: "Net", effectScopeArgument: 0,
          effectScopeKind: "http-request", effectDefaultPort: module === "node:https" ? 443 : 80,
        },
      }));
    }
  });

  it("registers Node server connection listeners as repeating external poll work", () => {
    for (const module of ["node:net", "node:http", "node:https"]) {
      expect(builtinContractRegistry.contracts).toContainEqual(expect.objectContaining({
        symbol: { module, export: "createServer" },
        operation: {
          kind: "deferred-callback", callbackArgumentFromEnd: 1, callbackMinimumArguments: 1,
          callbackMustBeCallable: true, queue: "poll", repeats: true,
        },
      }));
    }
  });

  it("registers child_process authority without confusing process lifetime with completion callbacks", () => {
    expect(builtinContractRegistry.contracts).toEqual(expect.arrayContaining([
      expect.objectContaining({ symbol: { module: "node:child_process", export: "exec" }, operation: expect.objectContaining({ kind: "deferred-callback", queue: "poll", effect: "Run" }) }),
      expect.objectContaining({ symbol: { module: "node:child_process", export: "execFile" }, operation: expect.objectContaining({ kind: "deferred-callback", queue: "poll", effect: "Run", effectScopeKind: "run-program" }) }),
      ...["execSync", "execFileSync", "spawn", "spawnSync", "fork"].map((name) => expect.objectContaining({
        symbol: { module: "node:child_process", export: name }, operation: expect.objectContaining({ kind: "scoped-effect", effect: "Run" }),
      })),
    ]));
  });
});
