import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { builtinContractRegistry, extendBuiltinContractRegistry, findModuleInitializationContract, resolveModuleInitializationContract, type BuiltinContractRegistry } from "../src/builtin-contracts.js";

describe("builtin semantic overlays", () => {
  it("binds reviewed module initialization to the observed runtime version", () => {
    expect(findModuleInitializationContract(builtinContractRegistry, "effect", { packageVersion: "3.22.1" }))
      .toMatchObject({ module: "effect", runtime: { kind: "package", version: "3.22.1" } });
    expect(findModuleInitializationContract(builtinContractRegistry, "effect", { packageVersion: "3.23.0" }))
      .toBeUndefined();
    expect(findModuleInitializationContract(builtinContractRegistry, "effect", {}))
      .toBeUndefined();

    expect(findModuleInitializationContract(builtinContractRegistry, "node:path", { nodeMajor: 24 }))
      .toMatchObject({ module: "node:*", runtime: { kind: "node", major: 24 } });
    expect(findModuleInitializationContract(builtinContractRegistry, "node:path", { nodeMajor: 25 }))
      .toBeUndefined();
  });

  it("extends the registry without losing defaults and prefers an exact module contract", () => {
    const extended = extendBuiltinContractRegistry(builtinContractRegistry, {
      moduleInitializations: [{
        module: "node:path", runtime: { kind: "node", major: 24 }, effects: ["Console"], evidence: "trusted",
        trustReason: "application-specific review", trustOwner: "platform-team",
      }],
    });

    expect(extended.contracts).toBe(builtinContractRegistry.contracts);
    expect(findModuleInitializationContract(extended, "node:path", { nodeMajor: 24 }))
      .toMatchObject({ module: "node:path", effects: ["Console"], trustOwner: "platform-team" });
    expect(findModuleInitializationContract(extended, "node:fs", { nodeMajor: 24 }))
      .toMatchObject({ module: "node:*", effects: [] });
  });

  it("never trusts a module contract bound to the wrong runtime kind", () => {
    const unversioned: BuiltinContractRegistry = {
      version: 2, declarations: [], contracts: [], moduleInitializations: [{
        module: "opaque-package", runtime: { kind: "node", major: 24 }, effects: [], evidence: "trusted",
        trustReason: "incomplete review", trustOwner: "test",
      }, {
        module: "node:path", runtime: { kind: "package", version: "24.0.0" }, effects: [], evidence: "trusted",
        trustReason: "incomplete review", trustOwner: "test",
      }],
    };

    expect(findModuleInitializationContract(unversioned, "opaque-package", { packageVersion: "1.0.0" }))
      .toBeUndefined();
    expect(findModuleInitializationContract(unversioned, "node:path", { nodeMajor: 24 }))
      .toBeUndefined();
  });

  it("reads the version from the package resolved for the importing source", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-module-contract-version-"));
    try {
      const packageDirectory = join(directory, "node_modules", "reviewed-package");
      mkdirSync(packageDirectory, { recursive: true });
      writeFileSync(join(packageDirectory, "package.json"), JSON.stringify({
        name: "reviewed-package", version: "1.2.3", types: "index.d.ts",
      }));
      writeFileSync(join(packageDirectory, "index.d.ts"), "export declare const value: number\n");
      const entry = join(directory, "entry.ts");
      writeFileSync(entry, 'import "reviewed-package"\n');
      const program = ts.createProgram([entry], {
        module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, noEmit: true,
      });
      const registry = (packageVersion: string): BuiltinContractRegistry => ({
        version: 2, declarations: [], contracts: [], moduleInitializations: [{
          module: "reviewed-package", runtime: { kind: "package", version: packageVersion }, effects: [], evidence: "trusted",
          trustReason: "test review", trustOwner: "test owner",
        }],
      });

      expect(resolveModuleInitializationContract(program, entry, "reviewed-package", registry("1.2.3")))
        .toMatchObject({ runtime: { kind: "package", version: "1.2.3" } });
      expect(resolveModuleInitializationContract(program, entry, "reviewed-package", registry("1.2.4")))
        .toBeUndefined();
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("refines node:os tmpdir as the symbolic temporary root", () => {
    expect(builtinContractRegistry.contracts).toContainEqual({
      symbol: { module: "node:os", export: "tmpdir" },
      result: { kind: "path", pattern: "$TEMP" },
      evidence: "trusted",
    });
  });

  it("classifies every initial DOM operation kind", () => {
    const kinds = builtinContractRegistry.contracts.flatMap((contract) => contract.operation?.kind === "dom" ? contract.operation.operations : []);
    expect(new Set(kinds)).toEqual(new Set(["AttributeRead", "AttributeWrite", "NodeRead", "NodeWrite", "TextRead", "TextWrite", "LayoutRead", "Create", "Listen", "Dispatch", "Parse"]));
    expect(builtinContractRegistry.contracts).toEqual(expect.arrayContaining([
      expect.objectContaining({ symbol: { module: "lib.dom", export: "Element#getAttribute" }, operation: expect.objectContaining({ kind: "dom", operations: ["AttributeRead"] }) }),
      expect.objectContaining({ symbol: { module: "lib.dom", export: "Element#setAttribute" }, operation: expect.objectContaining({ kind: "dom", operations: ["AttributeWrite"] }) }),
      expect.objectContaining({ symbol: { module: "lib.dom", export: "ParentNode#querySelector" }, operation: expect.objectContaining({ kind: "dom", operations: ["NodeRead"] }) }),
      expect.objectContaining({ symbol: { module: "lib.dom", export: "Node#appendChild" }, operation: expect.objectContaining({ kind: "dom", operations: ["NodeWrite"] }) }),
      expect.objectContaining({ symbol: { module: "lib.dom", export: "Element#attributes" }, operation: expect.objectContaining({ kind: "dom-property", readOperations: ["AttributeRead"], writeOperations: [] }) }),
      expect.objectContaining({ symbol: { module: "lib.dom", export: "Node#parentNode" }, operation: expect.objectContaining({ kind: "dom-property", readOperations: ["NodeRead"], writeOperations: [] }) }),
      expect.objectContaining({ symbol: { module: "lib.dom", export: "ParentNode#children" }, operation: expect.objectContaining({ kind: "dom-property", readOperations: ["NodeRead"], writeOperations: [] }) }),
      expect.objectContaining({ symbol: { module: "lib.dom", export: "CharacterData#data" }, operation: expect.objectContaining({ kind: "dom-property", readOperations: ["TextRead"], writeOperations: ["TextWrite"] }) }),
      expect.objectContaining({ symbol: { module: "lib.dom", export: "Element#hasAttribute" }, operation: expect.objectContaining({ kind: "dom", operations: ["AttributeRead"] }) }),
      expect.objectContaining({ symbol: { module: "lib.dom", export: "Element#toggleAttribute" }, operation: expect.objectContaining({ kind: "dom", operations: ["AttributeWrite"], mutatesReceiver: true, invokesUserCode: true }) }),
      expect.objectContaining({ symbol: { module: "lib.dom", export: "Node#insertBefore" }, operation: expect.objectContaining({ kind: "dom", operations: ["NodeWrite"], mutatesReceiver: true, mutatesArguments: [0, 1], invokesUserCode: true }) }),
      expect.objectContaining({ symbol: { module: "lib.dom", export: "CharacterData#replaceData" }, operation: expect.objectContaining({ kind: "dom", operations: ["TextWrite"], mutatesReceiver: true }) }),
      expect.objectContaining({ symbol: { module: "lib.dom", export: "Node#cloneNode" }, operation: expect.objectContaining({ kind: "dom", operations: ["NodeRead", "Create"] }) }),
      expect.objectContaining({ symbol: { module: "lib.dom", export: "Node#normalize" }, operation: expect.objectContaining({ kind: "dom", operations: ["NodeWrite", "TextWrite"], mutatesReceiver: true }) }),
      expect.objectContaining({ symbol: { module: "lib.dom", export: "Element#insertAdjacentHTML" }, operation: expect.objectContaining({ kind: "dom", operations: ["Parse", "NodeWrite"], mutatesReceiver: true, invokesUserCode: true }) }),
      expect.objectContaining({ symbol: { module: "lib.dom", export: "NamedNodeMap#getNamedItem" }, operation: expect.objectContaining({ kind: "dom", operations: ["AttributeRead"] }) }),
      expect.objectContaining({ symbol: { module: "lib.dom", export: "NamedNodeMap#setNamedItem" }, operation: expect.objectContaining({ kind: "dom", operations: ["AttributeWrite"], mutatesReceiver: true, mutatesArguments: [0], invokesUserCode: true }) }),
      expect.objectContaining({ symbol: { module: "lib.dom", export: "Element#innerHTML" }, operation: expect.objectContaining({ kind: "dom-property", readOperations: ["NodeRead", "AttributeRead", "TextRead"], writeOperations: ["Parse", "NodeWrite"], mutatesReceiverOnWrite: true, invokesUserCodeOnWrite: true }) }),
      expect.objectContaining({ symbol: { module: "lib.dom", export: "HTMLElement#offsetWidth" }, operation: expect.objectContaining({ kind: "dom-property", readOperations: ["LayoutRead"], writeOperations: [] }) }),
      expect.objectContaining({ symbol: { module: "lib.dom", export: "Element#outerHTML" }, operation: expect.objectContaining({ kind: "dom-property", readOperations: ["NodeRead", "AttributeRead", "TextRead"], writeOperations: ["Parse", "NodeWrite"], writeRegion: "parentNode", mutatesReceiverOnWrite: true, mutatesWriteRegionOnWrite: true, invokesUserCodeOnWrite: true }) }),
    ]));
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
      operation: { kind: "deferred-callback", callbackArgumentFromEnd: 1, queue: "close", closesReceiverFamily: "server" },
    }));
  });

  it("registers node:fs FSWatcher.close as receiver-handle cancellation", () => {
    expect(builtinContractRegistry.contracts).toContainEqual(expect.objectContaining({
      symbol: { module: "node:fs", export: "FSWatcher#close" },
      operation: { kind: "timer-clear", handleReceiver: true, family: "watcher" },
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
          callbackMustBeCallable: true, queue: "poll", repeats: true, resultHandleFamily: "server",
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
