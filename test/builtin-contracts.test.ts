import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { builtinContractRegistry, extendBuiltinContractRegistry, findBuiltinContract, findModuleInitializationContract, resolveModuleInitializationContract, type BuiltinContractRegistry } from "../src/builtin-contracts.js";
import { builtinSemanticCatalog, compileBuiltinSemanticCatalog } from "../src/builtin-semantic-catalog.js";

describe("builtin semantic overlays", () => {
  it("compiles versioned JavaScript, Node, and DOM semantic definitions", () => {
    expect(builtinSemanticCatalog.schema).toBe("uneffect-builtin-semantics/v1");
    expect(new Set(builtinSemanticCatalog.definitions.map((item) => item.platform))).toEqual(new Set(["javascript", "node", "dom"]));
    const contracts = compileBuiltinSemanticCatalog(builtinSemanticCatalog);
    expect(contracts).toHaveLength(builtinSemanticCatalog.definitions.length);
    expect(contracts.every((item) => item.evidence === "trusted")).toBe(true);
    expect(builtinSemanticCatalog.definitions).toEqual(expect.arrayContaining([
      expect.objectContaining({ platform: "javascript", symbol: { module: "lib.es", export: "Array#map" }, operation: { kind: "inline-callback", callbackArguments: [0] } }),
      expect.objectContaining({ platform: "javascript", symbol: { module: "lib.es", export: "Array#sort" }, operation: expect.objectContaining({ kind: "inline-callback", callbackArguments: [0] }), receiverMutation: true }),
      expect.objectContaining({ platform: "javascript", symbol: { module: "lib.es", export: "PromiseConstructor#all" }, operation: { kind: "promise-combinator", combinator: "all", iterableArgument: 0 } }),
      expect.objectContaining({ platform: "javascript", symbol: { module: "global", export: "Math.random" }, operation: { kind: "effect", effect: "Random" } }),
      expect.objectContaining({ platform: "dom", symbol: { module: "global", export: "structuredClone" }, operation: { kind: "clone", valueArgument: 0, transferArgument: 1 } }),
      expect.objectContaining({ platform: "node", symbol: { module: "node:fs", export: "readFile" }, operation: expect.objectContaining({ kind: "fs", read: true, write: false, readPathArgument: 0 }) }),
      expect.objectContaining({ platform: "node", symbol: { module: "node:fs/promises", export: "writeFile" }, operation: expect.objectContaining({ kind: "fs", read: false, write: true, writePathArgument: 0 }) }),
      expect.objectContaining({ platform: "node", symbol: { module: "node:fs", export: "copyFileSync" }, operation: expect.objectContaining({ kind: "fs", read: true, write: true, readPathArgument: 0, writePathArgument: 1 }) }),
      expect.objectContaining({ platform: "node", symbol: { module: "node:fs", export: "read" }, operation: expect.objectContaining({ kind: "fs", read: true, write: false, mutateArgument: 1 }) }),
      expect.objectContaining({ platform: "node", symbol: { module: "node:os", export: "tmpdir" }, result: { kind: "path", pattern: "$TEMP" } }),
      expect.objectContaining({ platform: "node", symbol: { module: "node:os", export: "cpus" }, operation: { kind: "effect", effect: "Sys<cpus>" } }),
      expect.objectContaining({ platform: "node", symbol: { module: "node:crypto", export: "randomBytes" }, operation: expect.objectContaining({ kind: "deferred-callback", effect: "Random", queue: "poll" }) }),
      expect.objectContaining({ platform: "node", symbol: { module: "node:crypto", export: "randomUUID" }, operation: { kind: "effect", effect: "Random" } }),
      expect.objectContaining({ platform: "node", symbol: { module: "node:child_process", export: "execFile" }, operation: expect.objectContaining({ kind: "deferred-callback", effect: "Run", effectScopeArgument: 0, effectScopeKind: "run-program" }) }),
      expect.objectContaining({ platform: "node", symbol: { module: "node:child_process", export: "spawnSync" }, operation: { kind: "scoped-effect", effect: "Run", effectScopeArgument: 0, effectScopeKind: "run-program" } }),
      expect.objectContaining({ platform: "node", symbol: { module: "node:net", export: "Server#listen" }, operation: expect.objectContaining({ kind: "deferred-callback", effect: "Net", effectScopeKind: "net-connect" }) }),
      expect.objectContaining({ platform: "node", symbol: { module: "node:https", export: "request" }, operation: expect.objectContaining({ kind: "deferred-callback", effect: "Net", effectScopeKind: "http-request", effectDefaultPort: 443 }) }),
      expect.objectContaining({ platform: "node", symbol: { module: "node:dns", export: "lookup" }, operation: expect.objectContaining({ kind: "deferred-callback", effect: "Net", queue: "poll" }) }),
      expect.objectContaining({ platform: "node", symbol: { module: "lib.node", export: "Process#nextTick" }, operation: { kind: "timer", callbackArgument: 0, repeats: false, queue: "next-tick" } }),
      expect.objectContaining({ platform: "node", symbol: { module: "node:timers", export: "setImmediate" }, operation: { kind: "timer", callbackArgument: 0, repeats: false, queue: "check" } }),
      expect.objectContaining({ platform: "dom", symbol: { module: "global", export: "fetch" }, operation: { kind: "fetch" } }),
      expect.objectContaining({ platform: "javascript", symbol: { module: "global", export: "console.error" }, operation: { kind: "effect", effect: "Console" } }),
      expect.objectContaining({ platform: "dom", symbol: { module: "global", export: "setTimeout" }, operation: { kind: "timer", callbackArgument: 0, delayArgument: 1, repeats: false, queue: "timer" } }),
      expect.objectContaining({ platform: "dom", symbol: { module: "global", export: "AbortSignal.any" }, operation: { kind: "abort-any", signalsArgument: 0 } }),
      expect.objectContaining({ platform: "dom", symbol: { module: "lib.dom", export: "Scheduler#postTask" }, operation: { kind: "scheduler-post-task", callbackArgument: 0, optionsArgument: 1 } }),
      expect.objectContaining({ platform: "dom", symbol: { module: "lib.dom", export: "Crypto#getRandomValues" }, operation: { kind: "effect", effect: "Random" } }),
      expect.objectContaining({ platform: "dom", symbol: { module: "lib.dom", export: "Worker#postMessage" }, operation: { kind: "clone", valueArgument: 0, transferArgument: 1 } }),
      expect.objectContaining({ platform: "dom", symbol: { module: "lib.dom", export: "ParentNode#querySelector" }, operation: { kind: "dom", operations: ["NodeRead"], queryArgument: 0 } }),
      expect.objectContaining({ platform: "dom", symbol: { module: "lib.dom", export: "Element#setAttribute" }, operation: { kind: "dom", operations: ["AttributeWrite"], mutatesReceiver: true, invokesUserCode: true } }),
      expect.objectContaining({ platform: "dom", symbol: { module: "lib.dom", export: "Node#appendChild" }, operation: { kind: "dom", operations: ["NodeWrite"], mutatesReceiver: true, mutatesArguments: [0], invokesUserCode: true } }),
      expect.objectContaining({ platform: "dom", symbol: { module: "lib.dom", export: "EventTarget#dispatchEvent" }, operation: { kind: "dom", operations: ["Dispatch"], invokesUserCode: true } }),
      expect.objectContaining({ platform: "dom", symbol: { module: "lib.dom", export: "DOMParser#parseFromString" }, operation: { kind: "dom", operations: ["Parse"] } }),
      expect.objectContaining({ platform: "dom", symbol: { module: "lib.dom", export: "Node#textContent" }, operation: expect.objectContaining({ kind: "dom-property", readOperations: ["TextRead"], writeOperations: ["TextWrite", "NodeWrite"], mutatesReceiverOnWrite: true }) }),
      expect.objectContaining({ platform: "dom", symbol: { module: "lib.dom", export: "Element#innerHTML" }, operation: expect.objectContaining({ kind: "dom-property", readOperations: ["NodeRead", "AttributeRead", "TextRead"], writeOperations: ["Parse", "NodeWrite"] }) }),
      expect.objectContaining({ platform: "dom", symbol: { module: "lib.dom", export: "HTMLScriptElement#src" }, operation: { kind: "dom-property", readOperations: ["PropertyRead"], writeOperations: ["PropertyWrite"], mutatesReceiverOnWrite: true } }),
      expect.objectContaining({ platform: "dom", symbol: { module: "lib.dom", export: "Document#cookie" }, operation: { kind: "effect-property", readEffect: "CookieRead", writeEffect: "CookieWrite" } }),
      expect.objectContaining({ platform: "dom", symbol: { module: "lib.dom", export: "Storage#length" }, operation: { kind: "effect-property", readEffect: "LocalStorageRead" } }),
    ]));
    expect(() => compileBuiltinSemanticCatalog({ ...builtinSemanticCatalog, definitions: [
      builtinSemanticCatalog.definitions[0]!, builtinSemanticCatalog.definitions[0]!,
    ] })).toThrow("duplicate builtin semantic definition");
  });
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

  it("registers synchronous collection callbacks and pure host helpers", () => {
    expect(builtinContractRegistry.contracts).toEqual(expect.arrayContaining([
      expect.objectContaining({ symbol: { module: "lib.es", export: "Array#map" }, operation: { kind: "inline-callback", callbackArguments: [0] } }),
      expect.objectContaining({ symbol: { module: "lib.es", export: "Array#flatMap" }, operation: { kind: "inline-callback", callbackArguments: [0] } }),
      expect.objectContaining({ symbol: { module: "lib.es", export: "Array#toSorted" }, operation: expect.objectContaining({ kind: "inline-callback", callbackArguments: [0] }), result: { kind: "fresh" } }),
      expect.objectContaining({ symbol: { module: "lib.es", export: "Array#slice" } }),
      expect.objectContaining({ symbol: { module: "lib.es", export: "Array#join" } }),
      expect.objectContaining({ symbol: { module: "node:module", export: "createRequire" } }),
      expect.objectContaining({ symbol: { module: "node:path", export: "join" } }),
      expect.objectContaining({ symbol: { module: "lib.node", export: "Process#cwd" } }),
    ]));
    for (const [module, name] of [["lib.es", "Array#slice"], ["lib.es", "Array#join"], ["node:module", "createRequire"], ["node:path", "join"], ["lib.node", "Process#cwd"]]) {
      expect(builtinContractRegistry.contracts.find((contract) => contract.symbol.module === module && contract.symbol.export === name)?.operation).toBeUndefined();
    }
  });

  it("pins reviewed synchronous TypeScript traversal callback shapes", () => {
    expect(builtinContractRegistry.contracts).toEqual(expect.arrayContaining([
      expect.objectContaining({ symbol: { module: "typescript", export: "Node#forEachChild" }, runtime: { kind: "package", version: "6.0.3" }, operation: { kind: "inline-callback", callbackArguments: [0, 1], optionalCallbackArguments: [1] } }),
      expect.objectContaining({ symbol: { module: "typescript", export: "forEachChild" }, runtime: { kind: "package", version: "6.0.3" }, operation: { kind: "inline-callback", callbackArguments: [1, 2], optionalCallbackArguments: [2] } }),
      expect.objectContaining({ symbol: { module: "typescript", export: "visitNode" }, runtime: { kind: "package", version: "6.0.3" }, operation: { kind: "inline-callback", callbackArguments: [1] } }),
      expect.objectContaining({ symbol: { module: "typescript", export: "visitEachChild" }, runtime: { kind: "package", version: "6.0.3" }, operation: { kind: "inline-callback", callbackArguments: [1] } }),
      expect.objectContaining({ symbol: { module: "typescript", export: "transform" }, runtime: { kind: "package", version: "6.0.3" }, operation: { kind: "inline-callback", callbackArguments: [], callbackArrayArguments: [1], callbackArrayReturnDepth: 1 } }),
    ]));
  });

  it("binds reviewed Valibot schema factories to the exact package version", () => {
    for (const name of ["pipe", "number", "safeInteger", "brand", "minValue", "maxValue", "finite"]) {
      expect(findBuiltinContract(builtinContractRegistry, { module: "valibot", export: name })).toMatchObject({
        runtime: { kind: "package", version: "1.4.2" },
        evidence: "trusted",
      });
    }
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
