import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "@typescript/typescript6";
import { describe, expect, it } from "vitest";
import { builtinContractRegistry, extendBuiltinContractRegistry, findBuiltinContract, findModuleInitializationContract, resolveModuleInitializationContract, type BuiltinContractRegistry } from "../src/builtin-contracts.js";
import { builtinSemanticCatalog, compileBuiltinSemanticCatalog } from "../src/builtin-semantic-catalog.js";

describe("builtin semantic overlays", () => {
  it("compiles versioned JavaScript, Node, DOM, and package semantic definitions", () => {
    expect(builtinSemanticCatalog.schema).toBe("uneffect-builtin-semantics/v1");
    expect(new Set(builtinSemanticCatalog.definitions.map((item) => item.platform))).toEqual(new Set(["javascript", "node", "dom", "package"]));
    const contracts = compileBuiltinSemanticCatalog(builtinSemanticCatalog);
    expect(contracts).toHaveLength(builtinSemanticCatalog.definitions.length);
    expect(contracts.every((item) => item.evidence === "trusted")).toBe(true);
    expect(builtinContractRegistry.contracts).toHaveLength(contracts.length);
    expect(builtinSemanticCatalog.definitions).toEqual(expect.arrayContaining([
      expect.objectContaining({ platform: "javascript", symbol: { module: "lib.es", export: "Array#map" }, semantics: expect.objectContaining({ primitives: expect.arrayContaining([expect.objectContaining({ kind: "callback", timing: "sync" }), { kind: "result", refinement: { kind: "fresh" } }]) }) }),
      ...["Array#concat", "ReadonlyArray#concat"].map((exportName) => expect.objectContaining({
        platform: "javascript", symbol: { module: "lib.es", export: exportName },
        semantics: expect.objectContaining({ primitives: [{ kind: "result", refinement: { kind: "fresh" } }] }),
      })),
      expect.objectContaining({ platform: "javascript", symbol: { module: "lib.es", export: "Array#sort" }, semantics: expect.objectContaining({ primitives: expect.arrayContaining([{ kind: "mutate", target: { kind: "receiver" } }, expect.objectContaining({ kind: "callback", timing: "sync" })]) }) }),
      expect.objectContaining({ platform: "javascript", symbol: { module: "lib.es", export: "Uint8Array#forEach" }, semantics: expect.objectContaining({ primitives: [expect.objectContaining({ kind: "callback", timing: "sync", thisArgument: { kind: "argument", index: 1, optional: true } })] }) }),
      expect.objectContaining({ platform: "javascript", symbol: { module: "lib.es", export: "BigInt64Array#sort" }, semantics: expect.objectContaining({ primitives: expect.arrayContaining([expect.objectContaining({ kind: "callback", timing: "sync" }), { kind: "mutate", target: { kind: "receiver" } }]) }) }),
      expect.objectContaining({ platform: "javascript", symbol: { module: "lib.es", export: "Float64Array#map" }, semantics: expect.objectContaining({ primitives: expect.arrayContaining([expect.objectContaining({ kind: "callback" }), { kind: "result", refinement: { kind: "fresh" } }]) }) }),
      expect.objectContaining({ platform: "javascript", symbol: { module: "lib.es", export: "ArrayBuffer#resize" }, semantics: expect.objectContaining({ primitives: expect.arrayContaining([{ kind: "mutate", target: { kind: "receiver" } }, { kind: "throw", error: "TypeError" }, { kind: "throw", error: "RangeError" }]) }) }),
      expect.objectContaining({ platform: "javascript", symbol: { module: "lib.es", export: "ObjectConstructor#assign" }, semantics: expect.objectContaining({ primitives: expect.arrayContaining([expect.objectContaining({ kind: "mutate", target: { kind: "argument", index: 0 } }), expect.objectContaining({ kind: "result", refinement: expect.objectContaining({ kind: "alias" }) })]) }) }),
      expect.objectContaining({ platform: "javascript", symbol: { module: "lib.es", export: "ObjectConstructor#create" }, semantics: expect.objectContaining({ primitives: [expect.objectContaining({ kind: "result", refinement: { kind: "fresh" } })] }) }),
      expect.objectContaining({ platform: "javascript", symbol: { module: "lib.es", export: "ObjectConstructor#freeze" }, semantics: expect.objectContaining({ primitives: expect.arrayContaining([expect.objectContaining({ kind: "mutate", target: { kind: "argument", index: 0 } })]) }) }),
      expect.objectContaining({ platform: "javascript", symbol: { module: "lib.es", export: "Reflect#defineProperty" }, semantics: expect.objectContaining({ primitives: [expect.objectContaining({ kind: "mutate", target: { kind: "argument", index: 0 } })] }) }),
      expect.objectContaining({ platform: "javascript", symbol: { module: "lib.es", export: "PromiseConstructor#all" }, semantics: expect.objectContaining({ primitives: [
        expect.objectContaining({ kind: "protocol", name: "promise-combinator", transition: "all", inputs: { iterable: { kind: "argument", index: 0 } } }),
      ] }) }),
      expect.objectContaining({ platform: "javascript", symbol: { module: "lib.es", export: "PromiseConstructor#withResolvers" }, semantics: expect.objectContaining({ primitives: expect.arrayContaining([
        { kind: "result", refinement: { kind: "fresh" } },
        expect.objectContaining({ kind: "protocol", name: "promise-capability", transition: "create" }),
      ]) }) }),
      expect.objectContaining({ platform: "javascript", symbol: { module: "lib.es", export: "PromiseConstructor#try" }, semantics: expect.objectContaining({ primitives: expect.arrayContaining([
        expect.objectContaining({ kind: "callback", timing: "sync", completion: "convert-throw-to-rejection", invocationRestArguments: { from: 1 } }),
        expect.objectContaining({ kind: "protocol", name: "promise-handler", transition: "try" }),
      ]) }) }),
      expect.objectContaining({ platform: "javascript", symbol: { module: "lib.es", export: "Promise#then" }, semantics: expect.objectContaining({ primitives: expect.arrayContaining([
        expect.objectContaining({ kind: "callback", invocationArguments: [{ kind: "runtime-value", role: "promise-fulfillment" }] }),
        expect.objectContaining({ kind: "callback", invocationArguments: [{ kind: "runtime-value", role: "promise-rejection" }] }),
      ]) }) }),
      expect.objectContaining({ platform: "javascript", symbol: { module: "lib.es", export: "ArrayConstructor#from" }, semantics: expect.objectContaining({ primitives: expect.arrayContaining([expect.objectContaining({
        kind: "callback", invocationArguments: expect.arrayContaining([expect.objectContaining({ kind: "runtime-value" })]), thisArgument: { kind: "argument", index: 2, optional: true },
      }), { kind: "result", refinement: { kind: "fresh" } }]) }) }),
      expect.objectContaining({ platform: "javascript", symbol: { module: "lib.es", export: "ArrayConstructor#of" }, semantics: expect.objectContaining({ primitives: [{ kind: "result", refinement: { kind: "fresh" } }] }) }),
      expect.objectContaining({ platform: "javascript", symbol: { module: "lib.es", export: "ObjectConstructor#fromEntries" }, semantics: expect.objectContaining({ primitives: [{ kind: "result", refinement: { kind: "fresh" } }] }) }),
      ...["Array", "Map", "Set", "WeakMap", "WeakSet"].map((exportName) => expect.objectContaining({
        platform: "javascript", symbol: { module: "global", export: exportName },
        semantics: expect.objectContaining({ primitives: [{ kind: "result", refinement: { kind: "fresh" } }] }),
      })),
      expect.objectContaining({ platform: "javascript", symbol: { module: "lib.es", export: "ArrayConstructor#fromAsync" }, semantics: expect.objectContaining({ primitives: expect.arrayContaining([
        expect.objectContaining({
          kind: "callback", timing: "deferred", queue: "microtask", cardinality: "0..n",
          invocationArguments: [
            { kind: "runtime-value", role: "array-from-async-element" },
            { kind: "runtime-value", role: "array-from-async-index" },
          ],
          thisArgument: { kind: "argument", index: 2, optional: true },
        }),
        expect.objectContaining({ kind: "protocol", name: "promise-combinator", transition: "fromAsync" }),
      ]) }) }),
      expect.objectContaining({ platform: "javascript", symbol: { module: "lib.es", export: "JSON#stringify" }, semantics: expect.objectContaining({ primitives: [expect.objectContaining({
        kind: "callback", thisArgument: { kind: "runtime-value", role: "json-holder" },
      })] }) }),
      ...["String#replace", "String#replaceAll"].map((exportName) => expect.objectContaining({
        platform: "javascript", symbol: { module: "lib.es", export: exportName }, semantics: expect.objectContaining({ primitives: [expect.objectContaining({ kind: "callback", timing: "sync" })] }),
      })),
      ...["ObjectConstructor#groupBy", "MapConstructor#groupBy"].map((exportName) => expect.objectContaining({
        platform: "javascript", symbol: { module: "lib.es", export: exportName }, semantics: expect.objectContaining({ primitives: expect.arrayContaining([
          expect.objectContaining({ kind: "callback", timing: "sync" }), expect.objectContaining({ kind: "result", refinement: { kind: "fresh" } }),
        ]) }),
      })),
      expect.objectContaining({ platform: "javascript", symbol: { module: "global", export: "Math.random" }, semantics: expect.objectContaining({ primitives: [{ kind: "effect", capability: "Random" }] }) }),
      expect.objectContaining({ platform: "dom", symbol: { module: "global", export: "structuredClone" }, semantics: expect.objectContaining({ primitives: [{ kind: "clone", target: { kind: "argument", index: 0 } }, expect.objectContaining({ kind: "transfer", optional: true }), { kind: "throw", error: "DOMException" }] }) }),
      ...["Map#forEach", "ReadonlyMap#forEach", "Set#forEach", "ReadonlySet#forEach"].map((exportName) =>
        expect.objectContaining({ platform: "javascript", symbol: { module: "lib.es", export: exportName }, semantics: expect.objectContaining({ primitives: [expect.objectContaining({ kind: "callback", timing: "sync", cardinality: "0..n" })] }) })),
      ...["WeakMap#set", "WeakMap#delete", "WeakSet#add", "WeakSet#delete"].map((exportName) =>
        expect.objectContaining({ platform: "javascript", symbol: { module: "lib.es", export: exportName }, semantics: expect.objectContaining({ primitives: [expect.objectContaining({ kind: "mutate", target: { kind: "receiver" } })] }) })),
      expect.objectContaining({ platform: "dom", symbol: { module: "lib.dom", export: "ReadableStream#getReader" }, semantics: expect.objectContaining({ primitives: expect.arrayContaining([expect.objectContaining({ kind: "acquire", resource: "stream-reader" }), expect.objectContaining({ kind: "protocol", name: "stream", transition: "lock-readable" })]) }) }),
      expect.objectContaining({ platform: "javascript", symbol: { module: "lib.es", export: "DisposableStack#defer" }, semantics: expect.objectContaining({ primitives: expect.arrayContaining([expect.objectContaining({ kind: "callback", timing: "deferred" }), expect.objectContaining({ kind: "protocol", name: "disposal-stack", transition: "register" })]) }) }),
      expect.objectContaining({ platform: "node", symbol: { module: "node:fs", export: "readFile" }, semantics: expect.objectContaining({ primitives: expect.arrayContaining([expect.objectContaining({ kind: "effect", capability: "FsRead" }), expect.objectContaining({ kind: "callback", queue: "poll" })]) }) }),
      expect.objectContaining({ platform: "node", symbol: { module: "node:fs/promises", export: "writeFile" }, semantics: expect.objectContaining({ primitives: [expect.objectContaining({ kind: "effect", capability: "FsWrite", scope: expect.objectContaining({ kind: "filesystem-path" }) })] }) }),
      expect.objectContaining({ platform: "node", symbol: { module: "node:fs", export: "copyFileSync" }, semantics: expect.objectContaining({ primitives: [expect.objectContaining({ capability: "FsRead" }), expect.objectContaining({ capability: "FsWrite" })] }) }),
      expect.objectContaining({ platform: "node", symbol: { module: "node:fs", export: "read" }, semantics: expect.objectContaining({ primitives: [expect.objectContaining({ capability: "FsRead" }), expect.objectContaining({ kind: "mutate", target: { kind: "argument", index: 1 } }), expect.anything()] }) }),
      expect.objectContaining({ platform: "node", symbol: { module: "node:os", export: "tmpdir" }, semantics: expect.objectContaining({ primitives: [{ kind: "result", refinement: { kind: "path", pattern: "$TEMP" } }] }) }),
      expect.objectContaining({ platform: "node", symbol: { module: "node:os", export: "cpus" }, semantics: expect.objectContaining({ primitives: [{ kind: "effect", capability: "Sys<cpus>" }] }) }),
      expect.objectContaining({ platform: "node", symbol: { module: "node:crypto", export: "randomBytes" }, semantics: expect.objectContaining({ primitives: expect.arrayContaining([expect.objectContaining({ kind: "effect", capability: "Random" }), expect.objectContaining({ kind: "callback", queue: "poll" })]) }) }),
      expect.objectContaining({ platform: "node", symbol: { module: "node:crypto", export: "randomUUID" }, semantics: { schema: "uneffect-semantic-primitives/v1", primitives: [{ kind: "effect", capability: "Random" }] } }),
      expect.objectContaining({ platform: "node", symbol: { module: "node:assert/strict", export: "ok" }, semantics: { schema: "uneffect-semantic-primitives/v1", primitives: [{ kind: "throw", error: "AssertionError" }] } }),
      expect.objectContaining({ platform: "node", symbol: { module: "node:assert/strict", export: "strict" }, semantics: { schema: "uneffect-semantic-primitives/v1", primitives: [{ kind: "throw", error: "AssertionError" }] } }),
      expect.objectContaining({ platform: "node", symbol: { module: "node:assert/strict", export: "strictEqual" }, semantics: { schema: "uneffect-semantic-primitives/v1", primitives: [{ kind: "throw", error: "AssertionError" }] } }),
      expect.objectContaining({ platform: "node", symbol: { module: "node:assert", export: "strictEqual" }, semantics: { schema: "uneffect-semantic-primitives/v1", primitives: [{ kind: "throw", error: "AssertionError" }] } }),
      expect.objectContaining({ platform: "node", symbol: { module: "node:assert/strict", export: "notStrictEqual" }, semantics: { schema: "uneffect-semantic-primitives/v1", primitives: [{ kind: "throw", error: "AssertionError" }] } }),
      expect.objectContaining({ platform: "node", symbol: { module: "node:assert", export: "notStrictEqual" }, semantics: { schema: "uneffect-semantic-primitives/v1", primitives: [{ kind: "throw", error: "AssertionError" }] } }),
      expect.objectContaining({ platform: "node", symbol: { module: "node:assert/strict", export: "fail" }, semantics: { schema: "uneffect-semantic-primitives/v1", primitives: [{ kind: "throw", error: "AssertionError" }] } }),
      expect.objectContaining({ platform: "node", symbol: { module: "node:assert", export: "fail" }, semantics: { schema: "uneffect-semantic-primitives/v1", primitives: [{ kind: "throw", error: "AssertionError" }] } }),
      expect.objectContaining({ platform: "node", symbol: { module: "node:assert/strict", export: "ifError" }, semantics: { schema: "uneffect-semantic-primitives/v1", primitives: [{ kind: "throw", error: "AssertionError" }] } }),
      expect.objectContaining({ platform: "node", symbol: { module: "node:assert", export: "ifError" }, semantics: { schema: "uneffect-semantic-primitives/v1", primitives: [{ kind: "throw", error: "AssertionError" }] } }),
      expect.objectContaining({ platform: "node", symbol: { module: "node:child_process", export: "execFile" }, semantics: expect.objectContaining({ primitives: expect.arrayContaining([expect.objectContaining({ kind: "effect", capability: "Run", scope: expect.objectContaining({ kind: "run-program" }) }), expect.objectContaining({ kind: "callback", queue: "poll" })]) }) }),
      expect.objectContaining({ platform: "node", symbol: { module: "node:child_process", export: "spawnSync" }, semantics: expect.objectContaining({ primitives: [expect.objectContaining({ kind: "effect", capability: "Run", scope: expect.objectContaining({ kind: "run-program" }) })] }) }),
      expect.objectContaining({ platform: "node", symbol: { module: "node:net", export: "Server#listen" }, semantics: expect.objectContaining({ primitives: expect.arrayContaining([expect.objectContaining({ kind: "effect", capability: "Net", scope: expect.objectContaining({ kind: "network", format: "connect" }) }), expect.objectContaining({ kind: "callback", queue: "next-tick" })]) }) }),
      expect.objectContaining({ platform: "node", symbol: { module: "node:https", export: "request" }, semantics: expect.objectContaining({ primitives: expect.arrayContaining([expect.objectContaining({ kind: "effect", capability: "Net", scope: expect.objectContaining({ kind: "network", format: "http-request", defaultPort: 443 }) }), expect.objectContaining({ kind: "callback", queue: "poll" })]) }) }),
      expect.objectContaining({ platform: "node", symbol: { module: "node:dns", export: "lookup" }, semantics: expect.objectContaining({ primitives: expect.arrayContaining([expect.objectContaining({ kind: "effect", capability: "Net", scope: expect.objectContaining({ kind: "network", format: "host" }) }), expect.objectContaining({ kind: "callback", queue: "poll" })]) }) }),
      expect.objectContaining({ platform: "node", symbol: { module: "lib.node", export: "Process#nextTick" }, semantics: expect.objectContaining({ schema: "uneffect-semantic-primitives/v1" }) }),
      expect.objectContaining({ platform: "node", symbol: { module: "node:timers", export: "setImmediate" }, semantics: expect.objectContaining({ schema: "uneffect-semantic-primitives/v1" }) }),
      expect.objectContaining({ platform: "dom", symbol: { module: "global", export: "fetch" }, semantics: expect.objectContaining({ primitives: expect.arrayContaining([expect.objectContaining({ kind: "effect", capability: "Fetch", scope: expect.objectContaining({ kind: "url" }) }), expect.objectContaining({ kind: "effect", capability: "Net" }), expect.objectContaining({ kind: "protocol", name: "fetch" })]) }) }),
      expect.objectContaining({ platform: "javascript", symbol: { module: "global", export: "console.error" }, semantics: expect.objectContaining({ primitives: [{ kind: "effect", capability: "Console" }] }) }),
      expect.objectContaining({ platform: "dom", symbol: { module: "global", export: "setTimeout" }, semantics: expect.objectContaining({ primitives: expect.arrayContaining([expect.objectContaining({ kind: "callback", queue: "timer" }), expect.objectContaining({ kind: "protocol", name: "timer", transition: "schedule" })]) }) }),
      expect.objectContaining({ platform: "dom", symbol: { module: "global", export: "AbortSignal.any" }, semantics: expect.objectContaining({ primitives: [expect.objectContaining({ kind: "protocol", name: "abort-signal", transition: "any" })] }) }),
      expect.objectContaining({ platform: "dom", symbol: { module: "lib.dom", export: "Scheduler#postTask" }, semantics: expect.objectContaining({ primitives: expect.arrayContaining([expect.objectContaining({ kind: "callback", queue: "scheduler-task" }), expect.objectContaining({ kind: "protocol", name: "scheduler", transition: "post-task" })]) }) }),
      expect.objectContaining({ platform: "dom", symbol: { module: "lib.dom", export: "Crypto#getRandomValues" }, semantics: expect.objectContaining({ primitives: [{ kind: "effect", capability: "Random" }] }) }),
      expect.objectContaining({ platform: "dom", symbol: { module: "lib.dom", export: "Worker#postMessage" }, semantics: expect.objectContaining({ primitives: [{ kind: "clone", target: { kind: "argument", index: 0 } }, expect.objectContaining({ kind: "transfer", optional: true })] }) }),
      expect.objectContaining({ platform: "dom", symbol: { module: "lib.dom", export: "ParentNode#querySelector" }, semantics: expect.objectContaining({ primitives: expect.arrayContaining([expect.objectContaining({ kind: "effect", scope: expect.objectContaining({ member: "NodeRead" }) }), expect.objectContaining({ kind: "result", refinement: expect.objectContaining({ kind: "css-selector" }) })]) }) }),
      expect.objectContaining({ platform: "dom", symbol: { module: "lib.dom", export: "Element#setAttribute" }, semantics: expect.objectContaining({ primitives: expect.arrayContaining([expect.objectContaining({ kind: "effect", scope: expect.objectContaining({ member: "AttributeWrite" }) }), expect.objectContaining({ kind: "mutate" }), { kind: "invoke-user-code" }]) }) }),
      expect.objectContaining({ platform: "dom", symbol: { module: "lib.dom", export: "Node#appendChild" }, semantics: expect.objectContaining({ primitives: expect.arrayContaining([expect.objectContaining({ kind: "effect", scope: expect.objectContaining({ member: "NodeWrite" }) }), expect.objectContaining({ kind: "mutate", target: { kind: "argument", index: 0 } })]) }) }),
      expect.objectContaining({ platform: "dom", symbol: { module: "lib.dom", export: "EventTarget#dispatchEvent" }, semantics: expect.objectContaining({ primitives: expect.arrayContaining([expect.objectContaining({ kind: "effect", scope: expect.objectContaining({ member: "Dispatch" }) }), { kind: "invoke-user-code" }]) }) }),
      expect.objectContaining({ platform: "dom", symbol: { module: "lib.dom", export: "DOMParser#parseFromString" }, semantics: expect.objectContaining({ primitives: [expect.objectContaining({ kind: "effect", scope: expect.objectContaining({ member: "Parse" }) })] }) }),
      expect.objectContaining({ platform: "dom", symbol: { module: "lib.dom", export: "Node#textContent" }, semantics: expect.objectContaining({ primitives: [expect.objectContaining({ kind: "property", read: expect.arrayContaining([expect.objectContaining({ kind: "effect", capability: "Dom" })]), write: expect.arrayContaining([expect.objectContaining({ kind: "mutate", target: { kind: "receiver" } })]) })] }) }),
      expect.objectContaining({ platform: "dom", symbol: { module: "lib.dom", export: "Element#innerHTML" }, semantics: expect.objectContaining({ primitives: [expect.objectContaining({ kind: "property" })] }) }),
      expect.objectContaining({ platform: "dom", symbol: { module: "lib.dom", export: "HTMLScriptElement#src" }, semantics: expect.objectContaining({ primitives: [expect.objectContaining({ kind: "property" })] }) }),
      expect.objectContaining({ platform: "dom", symbol: { module: "lib.dom", export: "Document#cookie" }, semantics: expect.objectContaining({ primitives: [expect.objectContaining({ kind: "property", read: [{ kind: "effect", capability: "CookieRead" }], write: [expect.objectContaining({ kind: "effect", capability: "CookieWrite", scope: { kind: "literal-key", target: { kind: "assigned-value" }, format: "cookie-assignment" } })] })] }) }),
      expect.objectContaining({ platform: "dom", symbol: { module: "lib.dom", export: "Storage#length" }, semantics: expect.objectContaining({ primitives: [expect.objectContaining({ kind: "property", read: [{ kind: "effect", capability: "LocalStorageRead" }], write: [] })] }) }),
      expect.objectContaining({ platform: "dom", symbol: { module: "lib.dom", export: "Navigator#sendBeacon" }, semantics: expect.objectContaining({ primitives: [expect.objectContaining({ kind: "effect", capability: "Net", scope: expect.objectContaining({ kind: "network", format: "http-request" }) })] }) }),
      expect.objectContaining({ platform: "dom", symbol: { module: "global", export: "WebSocket" }, semantics: expect.objectContaining({ primitives: expect.arrayContaining([expect.objectContaining({ kind: "effect", capability: "Net", scope: expect.objectContaining({ kind: "network", format: "websocket" }) }), expect.objectContaining({ kind: "acquire", resource: "websocket" })]) }) }),
      expect.objectContaining({ platform: "dom", symbol: { module: "lib.dom", export: "WebSocket#send" }, semantics: expect.objectContaining({ primitives: expect.arrayContaining([expect.objectContaining({ kind: "use", resource: "websocket" })]) }) }),
      expect.objectContaining({ platform: "dom", symbol: { module: "lib.dom", export: "WebSocket#close" }, semantics: expect.objectContaining({ primitives: expect.arrayContaining([expect.objectContaining({ kind: "release", resource: "websocket" })]) }) }),
    ]));
    expect(() => compileBuiltinSemanticCatalog({ ...builtinSemanticCatalog, definitions: [
      builtinSemanticCatalog.definitions[0]!, builtinSemanticCatalog.definitions[0]!,
    ] })).toThrow("duplicate builtin semantic definition");
    expect(() => compileBuiltinSemanticCatalog({ ...builtinSemanticCatalog, definitions: [{
      platform: "javascript", stability: "reviewed", symbol: { module: "global", export: "audit" },
      semantics: { schema: "uneffect-semantic-primitives/v1", primitives: [{ kind: "effect", capability: "Audit" }] },
    }] })).not.toThrow();
    expect(() => compileBuiltinSemanticCatalog({ ...builtinSemanticCatalog, definitions: [{
      platform: "javascript", stability: "reviewed", symbol: { module: "global", export: "audit" },
      semantics: { schema: "uneffect-semantic-primitives/v1", primitives: [{ kind: "mutate", target: { kind: "argument", index: -1 } }] },
    }] })).toThrow("non-negative integer");
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
    expect(builtinContractRegistry.contracts).toContainEqual(expect.objectContaining({
      symbol: { module: "node:os", export: "tmpdir" },
      semantics: expect.objectContaining({ primitives: [{ kind: "result", refinement: { kind: "path", pattern: "$TEMP" } }] }),
      evidence: "trusted",
    }));
  });

  it("classifies every initial DOM operation kind", () => {
    const members = (primitives: readonly import("../src/builtin-semantic-schema.js").SemanticPrimitive[]): string[] => primitives.flatMap((primitive) =>
      primitive.kind === "effect" && primitive.capability === "Dom" && primitive.scope?.kind === "region" ? [primitive.scope.member]
      : primitive.kind === "property" ? [...members(primitive.read), ...members(primitive.write)] : []);
    const kinds = builtinContractRegistry.contracts.flatMap((contract) => members(contract.semantics?.primitives ?? []));
    expect(new Set(kinds)).toEqual(new Set(["AttributeRead", "AttributeWrite", "NodeRead", "NodeWrite", "TextRead", "TextWrite", "PropertyRead", "PropertyWrite", "LayoutRead", "Create", "Listen", "Dispatch", "Parse"]));
    expect(builtinContractRegistry.contracts).toEqual(expect.arrayContaining([
      expect.objectContaining({ symbol: { module: "lib.dom", export: "Element#getAttribute" }, semantics: expect.objectContaining({ primitives: expect.arrayContaining([expect.objectContaining({ kind: "effect", capability: "Dom", scope: expect.objectContaining({ member: "AttributeRead" }) })]) }) }),
      expect.objectContaining({ symbol: { module: "lib.dom", export: "Element#setAttribute" }, semantics: expect.objectContaining({ primitives: expect.arrayContaining([expect.objectContaining({ kind: "effect", scope: expect.objectContaining({ member: "AttributeWrite" }) }), expect.objectContaining({ kind: "mutate", target: { kind: "receiver" } }), { kind: "invoke-user-code" }]) }) }),
      expect.objectContaining({ symbol: { module: "lib.dom", export: "ParentNode#querySelector" }, semantics: expect.objectContaining({ primitives: expect.arrayContaining([expect.objectContaining({ kind: "result", refinement: expect.objectContaining({ kind: "css-selector" }) })]) }) }),
      expect.objectContaining({ symbol: { module: "lib.dom", export: "Node#appendChild" }, semantics: expect.objectContaining({ primitives: expect.arrayContaining([expect.objectContaining({ kind: "effect", scope: expect.objectContaining({ member: "NodeWrite" }) }), expect.objectContaining({ kind: "mutate", target: { kind: "receiver" } }), expect.objectContaining({ kind: "mutate", target: { kind: "argument", index: 0 } })]) }) }),
      expect.objectContaining({ symbol: { module: "lib.dom", export: "Element#attributes" }, semantics: expect.objectContaining({ primitives: [expect.objectContaining({ kind: "property" })] }) }),
      expect.objectContaining({ symbol: { module: "lib.dom", export: "Node#parentNode" }, semantics: expect.objectContaining({ primitives: [expect.objectContaining({ kind: "property" })] }) }),
      expect.objectContaining({ symbol: { module: "lib.dom", export: "ParentNode#children" }, semantics: expect.objectContaining({ primitives: [expect.objectContaining({ kind: "property" })] }) }),
      expect.objectContaining({ symbol: { module: "lib.dom", export: "CharacterData#data" }, semantics: expect.objectContaining({ primitives: [expect.objectContaining({ kind: "property" })] }) }),
      expect.objectContaining({ symbol: { module: "lib.dom", export: "Element#innerHTML" }, semantics: expect.objectContaining({ primitives: [expect.objectContaining({ kind: "property" })] }) }),
      expect.objectContaining({ symbol: { module: "lib.dom", export: "HTMLElement#offsetWidth" }, semantics: expect.objectContaining({ primitives: [expect.objectContaining({ kind: "property" })] }) }),
      expect.objectContaining({ symbol: { module: "lib.dom", export: "Element#outerHTML" }, semantics: expect.objectContaining({ primitives: [expect.objectContaining({ kind: "property", write: expect.arrayContaining([expect.objectContaining({ kind: "mutate", target: expect.objectContaining({ kind: "region", region: "parentNode" }) })]) })] }) }),
    ]));
  });

  it("registers AbortSignal composition by builtin symbol identity", () => {
    expect(builtinContractRegistry.contracts).toEqual(expect.arrayContaining([
      expect.objectContaining({ symbol: { module: "global", export: "AbortSignal.abort" }, semantics: expect.objectContaining({ primitives: [expect.objectContaining({ kind: "protocol", name: "abort-signal", transition: "abort" })] }) }),
      expect.objectContaining({ symbol: { module: "global", export: "AbortSignal.any" }, semantics: expect.objectContaining({ primitives: [expect.objectContaining({ kind: "protocol", name: "abort-signal", transition: "any" })] }) }),
    ]));
  });

  it("registers prioritized scheduler tasks by builtin symbol identity", () => {
    expect(builtinContractRegistry.contracts).toContainEqual(expect.objectContaining({
      symbol: { module: "lib.dom", export: "Scheduler#postTask" },
      semantics: expect.objectContaining({ primitives: expect.arrayContaining([expect.objectContaining({ kind: "callback", queue: "scheduler-task" }), expect.objectContaining({ kind: "protocol", transition: "post-task" })]) }),
    }));
    expect(builtinContractRegistry.contracts).toContainEqual(expect.objectContaining({
      symbol: { module: "lib.dom", export: "Scheduler#yield" },
      semantics: expect.objectContaining({ primitives: expect.arrayContaining([expect.objectContaining({ kind: "protocol", transition: "yield" })]) }),
    }));
  });

  it("registers synchronous collection callbacks and pure host helpers", () => {
    expect(builtinContractRegistry.contracts).toEqual(expect.arrayContaining([
      expect.objectContaining({ symbol: { module: "lib.es", export: "Array#map" }, semantics: expect.objectContaining({ primitives: expect.arrayContaining([expect.objectContaining({ kind: "callback", timing: "sync" }), { kind: "result", refinement: { kind: "fresh" } }]) }) }),
      expect.objectContaining({ symbol: { module: "lib.es", export: "Array#flatMap" }, semantics: expect.objectContaining({ primitives: expect.arrayContaining([expect.objectContaining({ kind: "callback", timing: "sync" }), { kind: "result", refinement: { kind: "fresh" } }]) }) }),
      expect.objectContaining({ symbol: { module: "lib.es", export: "Array#toSorted" }, semantics: expect.objectContaining({ primitives: expect.arrayContaining([{ kind: "result", refinement: { kind: "fresh" } }, expect.objectContaining({ kind: "callback" })]) }) }),
      expect.objectContaining({ symbol: { module: "lib.es", export: "Array#slice" }, semantics: expect.objectContaining({ primitives: [{ kind: "result", refinement: { kind: "fresh" } }] }) }),
      expect.objectContaining({ symbol: { module: "lib.es", export: "Array#toReversed" }, semantics: expect.objectContaining({ primitives: [{ kind: "result", refinement: { kind: "fresh" } }] }) }),
      expect.objectContaining({ symbol: { module: "lib.es", export: "Array#toSpliced" }, semantics: expect.objectContaining({ primitives: [{ kind: "result", refinement: { kind: "fresh" } }] }) }),
      expect.objectContaining({ symbol: { module: "lib.es", export: "Array#with" }, semantics: expect.objectContaining({ primitives: [{ kind: "result", refinement: { kind: "fresh" } }] }) }),
      expect.objectContaining({ symbol: { module: "lib.es", export: "Array#join" } }),
      expect.objectContaining({ symbol: { module: "node:module", export: "createRequire" } }),
      expect.objectContaining({ symbol: { module: "node:path", export: "join" } }),
      expect.objectContaining({ symbol: { module: "lib.node", export: "Process#cwd" } }),
    ]));
    for (const [module, name] of [["lib.es", "Array#join"], ["node:module", "createRequire"], ["node:path", "join"], ["lib.node", "Process#cwd"]]) {
      expect(builtinContractRegistry.contracts.find((contract) => contract.symbol.module === module && contract.symbol.export === name)?.semantics).toBeUndefined();
    }
  });

  it("pins reviewed synchronous TypeScript traversal callback shapes", () => {
    expect(builtinContractRegistry.contracts).toEqual(expect.arrayContaining([
      expect.objectContaining({ symbol: { module: "typescript", export: "Node#forEachChild" }, runtime: { kind: "package", version: "6.0.3" }, semantics: expect.objectContaining({ primitives: expect.arrayContaining([expect.objectContaining({ kind: "callback", target: { kind: "argument", index: 0 } }), expect.objectContaining({ kind: "callback", target: { kind: "argument", index: 1 }, callable: "optional" })]) }) }),
      expect.objectContaining({ symbol: { module: "typescript", export: "forEachChild" }, runtime: { kind: "package", version: "6.0.3" }, semantics: expect.objectContaining({ primitives: expect.arrayContaining([expect.objectContaining({ kind: "callback", target: { kind: "argument", index: 1 } }), expect.objectContaining({ kind: "callback", target: { kind: "argument", index: 2 }, callable: "optional" })]) }) }),
      expect.objectContaining({ symbol: { module: "typescript", export: "visitNode" }, runtime: { kind: "package", version: "6.0.3" }, semantics: expect.objectContaining({ primitives: [expect.objectContaining({ kind: "callback", target: { kind: "argument", index: 1 } })] }) }),
      expect.objectContaining({ symbol: { module: "typescript", export: "visitEachChild" }, runtime: { kind: "package", version: "6.0.3" }, semantics: expect.objectContaining({ primitives: [expect.objectContaining({ kind: "callback", target: { kind: "argument", index: 1 } })] }) }),
      expect.objectContaining({ symbol: { module: "typescript", export: "transform" }, runtime: { kind: "package", version: "6.0.3" }, semantics: expect.objectContaining({ primitives: [expect.objectContaining({ kind: "callback", target: expect.objectContaining({ kind: "array-elements" }), returnDepth: 1 })] }) }),
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
      expect.objectContaining({ symbol: { module: "lib.node", export: "Process#nextTick" }, semantics: expect.objectContaining({ primitives: expect.arrayContaining([expect.objectContaining({ kind: "callback", queue: "next-tick" })]) }) }),
      expect.objectContaining({ symbol: { module: "global", export: "setImmediate" }, semantics: expect.objectContaining({ primitives: expect.arrayContaining([expect.objectContaining({ kind: "callback", queue: "check" })]) }) }),
    ]));
  });

  it("marks one-shot node:fs completion callbacks without changing sync or Promise APIs", () => {
    const lookup = (module: string, name: string) => builtinContractRegistry.contracts.find((contract) => contract.symbol.module === module && contract.symbol.export === name)?.semantics?.primitives ?? [];
    for (const name of ["access", "readFile", "writeFile", "copyFile", "read", "write", "rename", "rm"]) {
      expect(lookup("node:fs", name)).toContainEqual(expect.objectContaining({
        kind: "callback", target: expect.objectContaining({ kind: "argument-from-end", offset: 1 }), queue: "poll", cardinality: "0..1",
      }));
    }
    expect(lookup("node:fs", "readFileSync")).not.toContainEqual(expect.objectContaining({ kind: "callback" }));
    expect(lookup("node:fs/promises", "readFile")).not.toContainEqual(expect.objectContaining({ kind: "callback" }));
    expect(lookup("node:fs/promises", "readFileSync")).toEqual([]);
    expect(lookup("node:fs/promises", "opendir")).toContainEqual(expect.objectContaining({ kind: "effect", capability: "FsRead" }));
    expect(lookup("node:fs/promises", "mkdtemp")).toContainEqual(expect.objectContaining({ kind: "effect", capability: "FsWrite" }));
    expect(lookup("node:fs/promises", "statfs")).toContainEqual(expect.objectContaining({ kind: "effect", capability: "FsRead" }));
    for (const name of ["watch", "watchFile"]) {
      expect(lookup("node:fs", name)).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "callback", target: { kind: "argument-from-end", offset: 1, minimumArguments: 2 }, queue: "poll", cardinality: "0..n" }),
        expect.objectContaining({ kind: "result", refinement: { kind: "resource", family: "watcher" } }),
      ]));
    }
  });

  it("registers node:net Server.close as an externally completed close-phase callback", () => {
    expect(builtinContractRegistry.contracts).toContainEqual(expect.objectContaining({
      symbol: { module: "node:net", export: "Server#close" },
      semantics: expect.objectContaining({ primitives: expect.arrayContaining([
        expect.objectContaining({ kind: "callback", queue: "close" }),
        { kind: "release", resource: "server", target: { kind: "receiver" } },
        { kind: "protocol", name: "server", transition: "close" },
      ]) }),
    }));
  });

  it("registers node:fs FSWatcher.close as receiver-handle cancellation", () => {
    expect(builtinContractRegistry.contracts).toContainEqual(expect.objectContaining({
      symbol: { module: "node:fs", export: "FSWatcher#close" },
      semantics: expect.objectContaining({ primitives: expect.arrayContaining([
        expect.objectContaining({ kind: "protocol", name: "watcher", transition: "cancel" }),
      ]) }),
    }));
  });

  it("registers node:net Server.listen as scoped next-tick work", () => {
    expect(builtinContractRegistry.contracts).toContainEqual(expect.objectContaining({
        symbol: { module: "node:net", export: "Server#listen" },
        semantics: expect.objectContaining({ primitives: expect.arrayContaining([
          expect.objectContaining({ kind: "effect", capability: "Net", scope: { kind: "network", format: "connect", target: { kind: "argument", index: 0 }, hostArgument: 1 } }),
          expect.objectContaining({ kind: "callback", queue: "next-tick", callable: "optional" }),
        ]) }),
      }));
  });

  it("registers node:net connection listeners as externally completed poll callbacks", () => {
    for (const name of ["connect", "createConnection"]) {
      expect(builtinContractRegistry.contracts).toContainEqual(expect.objectContaining({
        symbol: { module: "node:net", export: name },
        semantics: expect.objectContaining({ primitives: expect.arrayContaining([
          expect.objectContaining({ kind: "effect", capability: "Net", scope: expect.objectContaining({ kind: "network", format: "connect" }) }),
          expect.objectContaining({ kind: "callback", queue: "poll" }),
        ]) }),
      }));
    }
    expect(builtinContractRegistry.contracts).toContainEqual(expect.objectContaining({
      symbol: { module: "node:net", export: "Socket#connect" },
      semantics: expect.objectContaining({ primitives: expect.arrayContaining([expect.objectContaining({ kind: "effect", capability: "Net" }), expect.objectContaining({ kind: "callback", queue: "poll" })]) }),
    }));
  });

  it("registers Node DNS callbacks as Net-capable poll work", () => {
    expect(builtinContractRegistry.contracts).toContainEqual(expect.objectContaining({
      symbol: { module: "node:dns", export: "lookup" },
      semantics: expect.objectContaining({ primitives: expect.arrayContaining([expect.objectContaining({ kind: "effect", capability: "Net" }), expect.objectContaining({ kind: "callback", queue: "poll" })]) }),
    }));
    expect(builtinContractRegistry.contracts).toContainEqual(expect.objectContaining({
      symbol: { module: "node:dns", export: "lookupService" },
      semantics: expect.objectContaining({ primitives: expect.arrayContaining([expect.objectContaining({ kind: "effect", capability: "Net" }), expect.objectContaining({ kind: "callback", queue: "poll" })]) }),
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
        semantics: expect.objectContaining({ primitives: [{ kind: "effect", capability: effect }] }),
      }));
    }
  });

  it("registers node:crypto randomBytes as Random-capable poll work when a callback is supplied", () => {
    expect(builtinContractRegistry.contracts).toContainEqual(expect.objectContaining({
      symbol: { module: "node:crypto", export: "randomBytes" },
      semantics: { schema: "uneffect-semantic-primitives/v1", primitives: [
        { kind: "effect", capability: "Random" },
        { kind: "callback", target: { kind: "argument-from-end", offset: 1, minimumArguments: 2 }, timing: "deferred", queue: "poll", cardinality: "0..1", callable: "optional" },
      ] },
    }));
  });

  it("registers Node HTTP response listeners as scoped Net poll work", () => {
    for (const module of ["node:http", "node:https"]) for (const name of ["request", "get"]) {
      expect(builtinContractRegistry.contracts).toContainEqual(expect.objectContaining({
        symbol: { module, export: name },
        semantics: expect.objectContaining({ primitives: expect.arrayContaining([
          expect.objectContaining({ kind: "effect", capability: "Net", scope: expect.objectContaining({ kind: "network", format: "http-request", defaultPort: module === "node:https" ? 443 : 80 }) }),
          expect.objectContaining({ kind: "callback", queue: "poll" }),
        ]) }),
      }));
    }
  });

  it("registers Node server connection listeners as repeating external poll work", () => {
    for (const module of ["node:net", "node:http", "node:https"]) {
      expect(builtinContractRegistry.contracts).toContainEqual(expect.objectContaining({
        symbol: { module, export: "createServer" },
        semantics: expect.objectContaining({ primitives: expect.arrayContaining([
          expect.objectContaining({ kind: "callback", queue: "poll", cardinality: "0..n" }),
          { kind: "result", refinement: { kind: "resource", family: "server" } },
          { kind: "acquire", resource: "server", target: { kind: "result" } },
        ]) }),
      }));
    }
  });

  it("registers child_process authority without confusing process lifetime with completion callbacks", () => {
    expect(builtinContractRegistry.contracts).toEqual(expect.arrayContaining([
      expect.objectContaining({ symbol: { module: "node:child_process", export: "exec" }, semantics: expect.objectContaining({ primitives: expect.arrayContaining([expect.objectContaining({ kind: "effect", capability: "Run" }), expect.objectContaining({ kind: "callback", queue: "poll" })]) }) }),
      expect.objectContaining({ symbol: { module: "node:child_process", export: "execFile" }, semantics: expect.objectContaining({ primitives: expect.arrayContaining([expect.objectContaining({ kind: "effect", capability: "Run", scope: expect.objectContaining({ kind: "run-program" }) }), expect.objectContaining({ kind: "callback", queue: "poll" })]) }) }),
      ...["execSync", "execFileSync", "spawn", "spawnSync", "fork"].map((name) => expect.objectContaining({
        symbol: { module: "node:child_process", export: name }, semantics: expect.objectContaining({ primitives: expect.arrayContaining([expect.objectContaining({ kind: "effect", capability: "Run" })]) }),
      })),
    ]));
  });
});
