import type { BuiltinContract, DomBuiltinOperation, DomOperation, DomPropertyBuiltinOperation } from "./builtin-contracts.js";

export type BuiltinSemanticPlatform = "javascript" | "node" | "dom";
export interface ReviewedBuiltinSemantic extends Omit<BuiltinContract, "evidence"> {
  platform: BuiltinSemanticPlatform;
  stability: "reviewed";
}
export interface BuiltinSemanticCatalog {
  schema: "uneffect-builtin-semantics/v1";
  definitions: readonly ReviewedBuiltinSemantic[];
}

const reviewed = (platform: BuiltinSemanticPlatform, definition: Omit<ReviewedBuiltinSemantic, "platform" | "stability">): ReviewedBuiltinSemantic =>
  ({ ...definition, platform, stability: "reviewed" });

const fsReadNames = ["access", "accessSync", "exists", "existsSync", "readFile", "readFileSync", "readdir", "readdirSync", "readlink", "readlinkSync", "realpath", "realpathSync", "stat", "statSync", "lstat", "lstatSync", "open", "openSync", "watch", "watchFile", "createReadStream"] as const;
const fsWriteNames = ["appendFile", "appendFileSync", "chmod", "chmodSync", "chown", "chownSync", "link", "linkSync", "mkdir", "mkdirSync", "rename", "renameSync", "rm", "rmSync", "rmdir", "rmdirSync", "symlink", "symlinkSync", "truncate", "truncateSync", "unlink", "unlinkSync", "utimes", "utimesSync", "writeFile", "writeFileSync", "createWriteStream"] as const;

function nodeFsDefinitions(module: "node:fs" | "node:fs/promises"): ReviewedBuiltinSemantic[] {
  const callbacks = new Set(["access", "exists", "readFile", "readdir", "readlink", "realpath", "stat", "lstat", "open", "appendFile", "chmod", "chown", "link", "mkdir", "rename", "rm", "rmdir", "symlink", "truncate", "unlink", "utimes", "writeFile", "copyFile", "cp", "read", "write"]);
  const callback = (name: string) => module !== "node:fs" ? {} : name === "watch" || name === "watchFile"
    ? { callbackArgumentFromEnd: 1 as const, callbackMinimumArguments: 2, callbackMustBeCallable: true, callbackQueue: "poll" as const, callbackRepeats: true }
    : callbacks.has(name) ? { callbackArgumentFromEnd: 1 as const, callbackQueue: "poll" as const } : {};
  return [
    ...fsReadNames.map((name) => reviewed("node", { symbol: { module, export: name }, operation: { kind: "fs", read: true, write: name === "open" || name === "openSync", readPathArgument: 0, writePathArgument: 0, ...callback(name) } })),
    ...fsWriteNames.map((name) => reviewed("node", { symbol: { module, export: name }, operation: { kind: "fs", read: false, write: true, writePathArgument: 0, ...callback(name) } })),
    ...["copyFile", "copyFileSync", "cp", "cpSync"].map((name) => reviewed("node", { symbol: { module, export: name }, operation: { kind: "fs", read: true, write: true, readPathArgument: 0, writePathArgument: 1, ...callback(name) } })),
    ...["read", "readSync"].map((name) => reviewed("node", { symbol: { module, export: name }, operation: { kind: "fs", read: true, write: false, mutateArgument: 1, ...callback(name) } })),
    ...["write", "writeSync"].map((name) => reviewed("node", { symbol: { module, export: name }, operation: { kind: "fs", read: false, write: true, ...callback(name) } })),
  ];
}

function domMethodDefinitions(): ReviewedBuiltinSemantic[] {
  const dom = (
    operations: DomOperation | readonly [DomOperation, ...DomOperation[]],
    options: Omit<DomBuiltinOperation, "kind" | "operations"> = {},
  ): DomBuiltinOperation => ({ kind: "dom", operations: typeof operations === "string" ? [operations] : operations, ...options });
  const entries: Array<[string, DomBuiltinOperation]> = [
    ["ParentNode#querySelector", dom("NodeRead", { queryArgument: 0 })],
    ["ParentNode#querySelectorAll", dom("NodeRead", { queryArgument: 0 })],
    ["Document#getElementById", dom("NodeRead")],
    ["Element#getAttribute", dom("AttributeRead")],
    ...["Element#getAttributeNS", "Element#getAttributeNames", "Element#getAttributeNode", "Element#getAttributeNodeNS", "Element#hasAttribute", "Element#hasAttributeNS", "Element#hasAttributes"]
      .map((key): [string, DomBuiltinOperation] => [key, dom("AttributeRead")]),
    ...["Node#compareDocumentPosition", "Node#contains", "Node#getRootNode", "Node#hasChildNodes", "Node#isEqualNode", "Node#isSameNode"]
      .map((key): [string, DomBuiltinOperation] => [key, dom("NodeRead")]),
    ["CharacterData#substringData", dom("TextRead")],
    ["Element#matches", dom("NodeRead", { invokesUserCode: true, queryArgument: 0 })],
    ["Element#closest", dom("NodeRead", { invokesUserCode: true, queryArgument: 0 })],
    ["Element#getBoundingClientRect", dom("LayoutRead")],
    ["Document#createElement", dom("Create")],
    ["Document#createTextNode", dom("Create")],
    ["Element#setAttribute", dom("AttributeWrite", { mutatesReceiver: true, invokesUserCode: true })],
    ...["Element#removeAttribute", "Element#removeAttributeNS", "Element#setAttributeNS", "Element#toggleAttribute"]
      .map((key): [string, DomBuiltinOperation] => [key, dom("AttributeWrite", { mutatesReceiver: true, invokesUserCode: true })]),
    ...["Element#removeAttributeNode", "Element#setAttributeNode", "Element#setAttributeNodeNS"]
      .map((key): [string, DomBuiltinOperation] => [key, dom("AttributeWrite", { mutatesReceiver: true, mutatesArguments: [0], invokesUserCode: true })]),
    ["Node#appendChild", dom("NodeWrite", { mutatesReceiver: true, mutatesArguments: [0], invokesUserCode: true })],
    ["Node#removeChild", dom("NodeWrite", { mutatesReceiver: true, mutatesArguments: [0], invokesUserCode: true })],
    ["Node#insertBefore", dom("NodeWrite", { mutatesReceiver: true, mutatesArguments: [0, 1], invokesUserCode: true })],
    ["Node#replaceChild", dom("NodeWrite", { mutatesReceiver: true, mutatesArguments: [0, 1], invokesUserCode: true })],
    ["Node#cloneNode", dom(["NodeRead", "Create"])],
    ["Node#normalize", dom(["NodeWrite", "TextWrite"], { mutatesReceiver: true })],
    ["ParentNode#replaceChildren", dom("NodeWrite", { mutatesReceiver: true, invokesUserCode: true })],
    ["ParentNode#append", dom("NodeWrite", { mutatesReceiver: true, invokesUserCode: true })],
    ["ParentNode#prepend", dom("NodeWrite", { mutatesReceiver: true, invokesUserCode: true })],
    ["ChildNode#remove", dom("NodeWrite", { mutatesReceiver: true, invokesUserCode: true })],
    ...["CharacterData#appendData", "CharacterData#deleteData", "CharacterData#insertData", "CharacterData#replaceData"]
      .map((key): [string, DomBuiltinOperation] => [key, dom("TextWrite", { mutatesReceiver: true })]),
    ["Element#insertAdjacentHTML", dom(["Parse", "NodeWrite"], { mutatesReceiver: true, invokesUserCode: true })],
    ["Element#insertAdjacentText", dom(["TextWrite", "NodeWrite"], { mutatesReceiver: true })],
    ...["NamedNodeMap#getNamedItem", "NamedNodeMap#getNamedItemNS", "NamedNodeMap#item"]
      .map((key): [string, DomBuiltinOperation] => [key, dom("AttributeRead")]),
    ...["NamedNodeMap#removeNamedItem", "NamedNodeMap#removeNamedItemNS"]
      .map((key): [string, DomBuiltinOperation] => [key, dom("AttributeWrite", { mutatesReceiver: true, invokesUserCode: true })]),
    ...["NamedNodeMap#setNamedItem", "NamedNodeMap#setNamedItemNS"]
      .map((key): [string, DomBuiltinOperation] => [key, dom("AttributeWrite", { mutatesReceiver: true, mutatesArguments: [0], invokesUserCode: true })]),
    ["EventTarget#addEventListener", dom("Listen", { mutatesReceiver: true, invokesUserCode: true })],
    ["EventTarget#removeEventListener", dom("Listen", { mutatesReceiver: true })],
    ["EventTarget#dispatchEvent", dom("Dispatch", { invokesUserCode: true })],
    ["DOMParser#parseFromString", dom("Parse")],
  ];
  return entries.map(([key, operation]) => reviewed("dom", { symbol: { module: "lib.dom", export: key }, operation }));
}

function domPropertyDefinitions(): ReviewedBuiltinSemantic[] {
  const readOnly = (operation: DomOperation): DomPropertyBuiltinOperation => ({
    kind: "dom-property", readOperations: [operation], writeOperations: [],
  });
  const entries: Array<[string, DomPropertyBuiltinOperation]> = [
    ["Element#attributes", { kind: "dom-property", readOperations: ["AttributeRead"], writeOperations: [], resultRegion: "receiver" }],
    ...[
      "Node#parentNode", "Node#parentElement", "Node#childNodes", "Node#firstChild", "Node#lastChild",
      "Node#nextSibling", "Node#previousSibling", "Node#ownerDocument", "Node#isConnected",
      "ParentNode#children", "ParentNode#firstElementChild", "ParentNode#lastElementChild",
      "ParentNode#childElementCount", "NonDocumentTypeChildNode#nextElementSibling",
      "NonDocumentTypeChildNode#previousElementSibling",
    ].map((key): [string, DomPropertyBuiltinOperation] => [key, readOnly("NodeRead")]),
    ["Node#textContent", {
      kind: "dom-property", readOperations: ["TextRead"], writeOperations: ["TextWrite", "NodeWrite"],
      mutatesReceiverOnWrite: true, invokesUserCodeOnWrite: true,
    }],
    ["Node#nodeValue", { kind: "dom-property", readOperations: ["TextRead"], writeOperations: ["TextWrite"], mutatesReceiverOnWrite: true }],
    ["CharacterData#data", { kind: "dom-property", readOperations: ["TextRead"], writeOperations: ["TextWrite"], mutatesReceiverOnWrite: true }],
    ...["Element#innerHTML", "ShadowRoot#innerHTML"].map((key): [string, DomPropertyBuiltinOperation] => [key, {
      kind: "dom-property", readOperations: ["NodeRead", "AttributeRead", "TextRead"], writeOperations: ["Parse", "NodeWrite"],
      mutatesReceiverOnWrite: true, invokesUserCodeOnWrite: true,
    }]),
    ["Element#outerHTML", {
      kind: "dom-property", readOperations: ["NodeRead", "AttributeRead", "TextRead"], writeOperations: ["Parse", "NodeWrite"],
      writeRegion: "parentNode", mutatesReceiverOnWrite: true, mutatesWriteRegionOnWrite: true, invokesUserCodeOnWrite: true,
    }],
    ...[
      "Element#clientHeight", "Element#clientLeft", "Element#clientTop", "Element#clientWidth",
      "Element#scrollHeight", "Element#scrollWidth", "HTMLElement#offsetHeight", "HTMLElement#offsetWidth",
    ].map((key): [string, DomPropertyBuiltinOperation] => [key, readOnly("LayoutRead")]),
    ["HTMLInputElement#value", { kind: "dom-property", readOperations: ["PropertyRead"], writeOperations: ["PropertyWrite"], mutatesReceiverOnWrite: true }],
    ...["src", "integrity", "crossOrigin", "type", "async", "defer", "referrerPolicy", "nonce"]
      .map((name): [string, DomPropertyBuiltinOperation] => [`HTMLScriptElement#${name}`, {
        kind: "dom-property", readOperations: ["PropertyRead"], writeOperations: ["PropertyWrite"], mutatesReceiverOnWrite: true,
      }]),
  ];
  return entries.map(([key, operation]) => reviewed("dom", { symbol: { module: "lib.dom", export: key }, operation }));
}

export const builtinSemanticCatalog: BuiltinSemanticCatalog = {
  schema: "uneffect-builtin-semantics/v1",
  definitions: [
    ...(["map", "flatMap", "filter", "forEach", "every", "some", "find", "findIndex", "findLast", "findLastIndex", "reduce", "reduceRight"] as const)
      .flatMap((name) => ["Array", "ReadonlyArray"].map((owner) => reviewed("javascript", {
        symbol: { module: "lib.es", export: `${owner}#${name}` }, operation: { kind: "inline-callback", callbackArguments: [0] },
        trustReason: `ECMAScript ${owner}.${name} invokes its callback synchronously`, trustOwner: "@mizchi/uneffect",
      }))),
    ...(["slice", "join"] as const).flatMap((name) => ["Array", "ReadonlyArray"].map((owner) => reviewed("javascript", {
      symbol: { module: "lib.es", export: `${owner}#${name}` },
      trustReason: `ECMAScript ${owner}.${name} has no callback or host authority`, trustOwner: "@mizchi/uneffect",
    }))),
    ...(["Array", "ReadonlyArray"] as const).map((owner) => reviewed("javascript", {
      symbol: { module: "lib.es", export: `${owner}#toSorted` },
      operation: { kind: "inline-callback", callbackArguments: [0], optionalCallbackArguments: [0] }, result: { kind: "fresh" },
      trustReason: `ECMAScript ${owner}.toSorted returns a fresh Array and invokes its optional comparator synchronously`, trustOwner: "@mizchi/uneffect",
    })),
    reviewed("javascript", {
      symbol: { module: "lib.es", export: "Array#sort" },
      operation: { kind: "inline-callback", callbackArguments: [0], optionalCallbackArguments: [0] }, receiverMutation: true,
      trustReason: "ECMAScript Array.sort mutates its receiver and invokes its optional comparator synchronously", trustOwner: "@mizchi/uneffect",
    }),
    ...(["keys", "entries"] as const).map((name) => reviewed("javascript", {
      symbol: { module: "lib.es", export: `ObjectConstructor#${name}` }, result: { kind: "fresh" },
      trustReason: `ECMAScript Object.${name} returns a newly allocated Array`, trustOwner: "@mizchi/uneffect",
    })),
    ...(["all", "allSettled", "race", "any"] as const).map((combinator) => reviewed("javascript", {
      symbol: { module: "lib.es", export: `PromiseConstructor#${combinator}` },
      operation: { kind: "promise-combinator", combinator, iterableArgument: 0 },
    })),
    reviewed("javascript", { symbol: { module: "global", export: "Math.random" }, operation: { kind: "effect", effect: "Random" } }),
    reviewed("node", { symbol: { module: "node:module", export: "createRequire" }, trustReason: "Node createRequire constructs a resolver without loading a target", trustOwner: "@mizchi/uneffect" }),
    reviewed("node", { symbol: { module: "node:path", export: "join" }, trustReason: "Node path.join is a deterministic lexical path operation", trustOwner: "@mizchi/uneffect" }),
    reviewed("node", { symbol: { module: "lib.node", export: "Process#cwd" }, trustReason: "Node process.cwd reads launch configuration without a Deno-style permission", trustOwner: "@mizchi/uneffect" }),
    ...nodeFsDefinitions("node:fs"),
    ...nodeFsDefinitions("node:fs/promises"),
    reviewed("node", { symbol: { module: "node:os", export: "tmpdir" }, result: { kind: "path", pattern: "$TEMP" } }),
    ...([ ["hostname", "Sys<hostname>"], ["release", "Sys<osRelease>"], ["uptime", "Sys<osUptime>"], ["loadavg", "Sys<loadavg>"], ["networkInterfaces", "Sys<networkInterfaces>"], ["totalmem", "Sys<systemMemoryInfo>"], ["freemem", "Sys<systemMemoryInfo>"], ["cpus", "Sys<cpus>"], ["availableParallelism", "Sys<cpus>"], ["homedir", "Sys<homedir>"], ["userInfo", "Sys<username | uid | gid | homedir>"] ] as const)
      .map(([name, effect]) => reviewed("node", { symbol: { module: "node:os", export: name }, operation: { kind: "effect", effect } })),
    ...["randomBytes", "randomFill", "randomInt"].map((name) => reviewed("node", { symbol: { module: "node:crypto", export: name }, operation: { kind: "deferred-callback", callbackArgumentFromEnd: 1, callbackMinimumArguments: 2, ...(name === "randomBytes" ? {} : { callbackMustBeCallable: true }), queue: "poll", effect: "Random" } })),
    ...["randomFillSync", "randomUUID"].map((name) => reviewed("node", { symbol: { module: "node:crypto", export: name }, operation: { kind: "effect", effect: "Random" } })),
    reviewed("node", { symbol: { module: "node:child_process", export: "exec" }, operation: { kind: "deferred-callback", callbackArgumentFromEnd: 1, callbackMinimumArguments: 2, callbackMustBeCallable: true, queue: "poll", effect: "Run" } }),
    reviewed("node", { symbol: { module: "node:child_process", export: "execFile" }, operation: { kind: "deferred-callback", callbackArgumentFromEnd: 1, callbackMinimumArguments: 2, callbackMustBeCallable: true, queue: "poll", effect: "Run", effectScopeArgument: 0, effectScopeKind: "run-program" } }),
    ...["execFileSync", "spawn", "spawnSync"].map((name) => reviewed("node", { symbol: { module: "node:child_process", export: name }, operation: { kind: "scoped-effect", effect: "Run", effectScopeArgument: 0, effectScopeKind: "run-program" } })),
    ...["execSync", "fork"].map((name) => reviewed("node", { symbol: { module: "node:child_process", export: name }, operation: { kind: "scoped-effect", effect: "Run" } })),
    reviewed("node", { symbol: { module: "node:fs", export: "FSWatcher#close" }, operation: { kind: "timer-clear", handleReceiver: true, family: "watcher" } }),
    reviewed("node", { symbol: { module: "node:net", export: "Server#close" }, operation: { kind: "deferred-callback", callbackArgumentFromEnd: 1, queue: "close", closesReceiverFamily: "server" } }),
    reviewed("node", { symbol: { module: "node:net", export: "Server#listen" }, operation: { kind: "deferred-callback", callbackArgumentFromEnd: 1, callbackMinimumArguments: 2, callbackMustBeCallable: true, queue: "next-tick", effect: "Net", effectScopeArgument: 0, effectScopeKind: "net-connect" } }),
    ...["connect", "createConnection"].map((name) => reviewed("node", { symbol: { module: "node:net", export: name }, operation: { kind: "deferred-callback", callbackArgumentFromEnd: 1, queue: "poll", effect: "Net", effectScopeArgument: 0, effectScopeKind: "net-connect" } })),
    reviewed("node", { symbol: { module: "node:net", export: "Socket#connect" }, operation: { kind: "deferred-callback", callbackArgumentFromEnd: 1, queue: "poll", effect: "Net", effectScopeArgument: 0, effectScopeKind: "net-connect" } }),
    reviewed("node", { symbol: { module: "node:dns", export: "lookup" }, operation: { kind: "deferred-callback", callbackArgumentFromEnd: 1, queue: "poll", effect: "Net", effectScopeArgument: 0 } }),
    reviewed("node", { symbol: { module: "node:dns", export: "lookupService" }, operation: { kind: "deferred-callback", callbackArgumentFromEnd: 1, queue: "poll", effect: "Net" } }),
    ...(["node:net", "node:http", "node:https"] as const).map((module) => reviewed("node", { symbol: { module, export: "createServer" }, operation: { kind: "deferred-callback", callbackArgumentFromEnd: 1, callbackMinimumArguments: 1, callbackMustBeCallable: true, queue: "poll", repeats: true, resultHandleFamily: "server" } })),
    ...(["node:http", "node:https"] as const).flatMap((module) => ["request", "get"].map((name) => reviewed("node", { symbol: { module, export: name }, operation: { kind: "deferred-callback", callbackArgumentFromEnd: 1, callbackMinimumArguments: 2, callbackMustBeCallable: true, queue: "poll", effect: "Net", effectScopeArgument: 0, effectScopeKind: "http-request", effectDefaultPort: module === "node:https" ? 443 : 80 } }))),
    reviewed("node", { symbol: { module: "lib.node", export: "Process#nextTick" }, operation: { kind: "timer", callbackArgument: 0, repeats: false, queue: "next-tick" } }),
    reviewed("node", { symbol: { module: "node:timers", export: "setImmediate" }, operation: { kind: "timer", callbackArgument: 0, repeats: false, queue: "check" } }),
    reviewed("node", { symbol: { module: "node:timers", export: "clearImmediate" }, operation: { kind: "timer-clear", handleArgument: 0, family: "immediate", effect: "Timer" } }),
    reviewed("dom", { symbol: { module: "global", export: "fetch" }, operation: { kind: "fetch" } }),
    ...["log", "info", "warn", "error", "debug", "trace", "dir", "table"].map((name) => reviewed("javascript", {
      symbol: { module: "global", export: `console.${name}` }, operation: { kind: "effect", effect: "Console" },
      trustReason: `reviewed Console ${name} semantic overlay`, trustOwner: "@mizchi/uneffect",
    })),
    reviewed("dom", { symbol: { module: "global", export: "setTimeout" }, operation: { kind: "timer", callbackArgument: 0, delayArgument: 1, repeats: false, queue: "timer" } }),
    reviewed("dom", { symbol: { module: "global", export: "setInterval" }, operation: { kind: "timer", callbackArgument: 0, delayArgument: 1, repeats: true, queue: "timer" } }),
    reviewed("dom", { symbol: { module: "global", export: "queueMicrotask" }, operation: { kind: "timer", callbackArgument: 0, repeats: false, queue: "microtask" } }),
    reviewed("node", { symbol: { module: "global", export: "setImmediate" }, operation: { kind: "timer", callbackArgument: 0, repeats: false, queue: "check" } }),
    reviewed("dom", { symbol: { module: "global", export: "requestAnimationFrame" }, operation: { kind: "timer", callbackArgument: 0, repeats: false, queue: "animation-frame" } }),
    reviewed("dom", { symbol: { module: "global", export: "cancelAnimationFrame" }, operation: { kind: "timer-clear", handleArgument: 0, family: "animation-frame", effect: "Timer" } }),
    ...(["clearTimeout", "clearInterval"] as const).map((name) => reviewed("dom", { symbol: { module: "global", export: name }, operation: { kind: "timer-clear", handleArgument: 0, family: "timeout", effect: "Timer" } })),
    reviewed("node", { symbol: { module: "global", export: "clearImmediate" }, operation: { kind: "timer-clear", handleArgument: 0, family: "immediate", effect: "Timer" } }),
    reviewed("dom", { symbol: { module: "global", export: "AbortSignal.timeout" }, operation: { kind: "abort-timeout", delayArgument: 0 } }),
    reviewed("dom", { symbol: { module: "global", export: "AbortSignal.abort" }, operation: { kind: "abort-static", reasonArgument: 0 } }),
    reviewed("dom", { symbol: { module: "global", export: "AbortSignal.any" }, operation: { kind: "abort-any", signalsArgument: 0 } }),
    reviewed("dom", { symbol: { module: "lib.dom", export: "Scheduler#postTask" }, operation: { kind: "scheduler-post-task", callbackArgument: 0, optionsArgument: 1 } }),
    reviewed("dom", { symbol: { module: "lib.dom", export: "Scheduler#yield" }, operation: { kind: "scheduler-yield" } }),
    reviewed("dom", { symbol: { module: "global", export: "crypto.randomUUID" }, operation: { kind: "effect", effect: "Random" } }),
    ...["getRandomValues", "randomUUID"].map((name) => reviewed("dom", { symbol: { module: "lib.dom", export: `Crypto#${name}` }, operation: { kind: "effect", effect: "Random" } })),
    ...["Worker#postMessage", "MessagePort#postMessage"].map((name) => reviewed("dom", { symbol: { module: "lib.dom", export: name }, operation: { kind: "clone", valueArgument: 0, transferArgument: 1 } })),
    ...domMethodDefinitions(),
    ...domPropertyDefinitions(),
    reviewed("dom", { symbol: { module: "lib.dom", export: "Document#cookie" }, operation: { kind: "effect-property", readEffect: "CookieRead", writeEffect: "CookieWrite" } }),
    reviewed("dom", { symbol: { module: "lib.dom", export: "Storage#length" }, operation: { kind: "effect-property", readEffect: "LocalStorageRead" } }),
    ...["getItem", "key"].map((name) => reviewed("dom", { symbol: { module: "lib.dom", export: `Storage#${name}` }, operation: { kind: "effect", effect: "LocalStorageRead" } })),
    ...["setItem", "removeItem", "clear"].map((name) => reviewed("dom", { symbol: { module: "lib.dom", export: `Storage#${name}` }, operation: { kind: "effect", effect: "LocalStorageWrite" } })),
    reviewed("dom", { symbol: { module: "global", export: "structuredClone" }, operation: { kind: "clone", valueArgument: 0, transferArgument: 1 } }),
  ],
};

export function compileBuiltinSemanticCatalog(catalog: BuiltinSemanticCatalog): BuiltinContract[] {
  if (catalog.schema !== "uneffect-builtin-semantics/v1") throw new Error(`unsupported builtin semantic catalog schema: ${catalog.schema}`);
  const seen = new Set<string>();
  for (const definition of catalog.definitions) {
    const id = `${definition.symbol.module}#${definition.symbol.export}`;
    if (seen.has(id)) throw new Error(`duplicate builtin semantic definition: ${id}`);
    seen.add(id);
  }
  return materializeBuiltinSemanticDefinitions(catalog.definitions);
}

/** Materialize the repository-owned catalog after its duplicate validation test. */
export function materializeBuiltinSemanticDefinitions(definitions: readonly ReviewedBuiltinSemantic[]): BuiltinContract[] {
  return definitions.map(({ platform: _platform, stability: _stability, ...definition }) => ({ ...definition, evidence: "trusted" }));
}
