export interface BuiltinSymbolKey {
  module: string;
  export: string;
}

export interface PathResultRefinement {
  kind: "path";
  pattern: string;
}

export interface FsBuiltinOperation {
  kind: "fs";
  read: boolean;
  write: boolean;
  readPathArgument?: number;
  writePathArgument?: number;
  mutateArgument?: number;
  callbackArgumentFromEnd?: number;
  callbackMinimumArguments?: number;
  callbackMustBeCallable?: boolean;
  callbackQueue?: "poll";
  callbackRepeats?: boolean;
}

export interface StaticEffectBuiltinOperation { kind: "effect"; effect: string }
export interface ScopedEffectBuiltinOperation { kind: "scoped-effect"; effect: string; effectScopeArgument?: number; effectScopeKind?: "literal" | "run-program" }
export interface MutationBuiltinOperation { kind: "mutation" }
export interface CloneBuiltinOperation { kind: "clone"; valueArgument: number; transferArgument: number }
export interface FetchBuiltinOperation { kind: "fetch" }
export interface TimerBuiltinOperation { kind: "timer"; callbackArgument: number; delayArgument?: number; repeats: boolean; queue: "timer" | "microtask" | "animation-frame" | "next-tick" | "check" }
export interface DeferredCallbackBuiltinOperation { kind: "deferred-callback"; callbackArgumentFromEnd: number; callbackMinimumArguments?: number; callbackMustBeCallable?: boolean; queue: "next-tick" | "poll" | "close"; repeats?: boolean; resultHandleFamily?: "server"; closesReceiverFamily?: "server"; effect?: string; effectScopeArgument?: number; effectScopeKind?: "literal" | "net-connect" | "http-request" | "run-program"; effectDefaultPort?: number }
export interface TimerClearBuiltinOperation { kind: "timer-clear"; handleArgument?: number; handleReceiver?: boolean; family: "timeout" | "immediate" | "animation-frame" | "watcher"; effect?: string }
export interface AbortTimeoutBuiltinOperation { kind: "abort-timeout"; delayArgument: number }
export interface AbortStaticBuiltinOperation { kind: "abort-static"; reasonArgument: number }
export interface AbortAnyBuiltinOperation { kind: "abort-any"; signalsArgument: number }
export interface SchedulerPostTaskBuiltinOperation { kind: "scheduler-post-task"; callbackArgument: number; optionsArgument: number }
export interface SchedulerYieldBuiltinOperation { kind: "scheduler-yield" }
export type PromiseCombinator = "all" | "allSettled" | "race" | "any";
export interface PromiseCombinatorBuiltinOperation { kind: "promise-combinator"; combinator: PromiseCombinator; iterableArgument: number }
export type DomOperation =
  | "AttributeRead" | "AttributeWrite"
  | "NodeRead" | "NodeWrite"
  | "TextRead" | "TextWrite"
  | "PropertyRead" | "PropertyWrite"
  | "LayoutRead" | "Create" | "Listen" | "Dispatch" | "Parse";
export interface DomBuiltinOperation {
  kind: "dom";
  operation: DomOperation;
  mutatesReceiver?: boolean;
  mutatesArguments?: readonly number[];
  invokesUserCode?: boolean;
  queryArgument?: number;
}
export interface DomPropertyBuiltinOperation {
  kind: "dom-property";
  readOperations: readonly DomOperation[];
  writeOperations: readonly DomOperation[];
  mutatesReceiverOnWrite?: boolean;
  invokesUserCodeOnWrite?: boolean;
}

export type BuiltinOperation = FsBuiltinOperation | StaticEffectBuiltinOperation | ScopedEffectBuiltinOperation | FetchBuiltinOperation | TimerBuiltinOperation | DeferredCallbackBuiltinOperation | TimerClearBuiltinOperation | AbortTimeoutBuiltinOperation | AbortStaticBuiltinOperation | AbortAnyBuiltinOperation | SchedulerPostTaskBuiltinOperation | SchedulerYieldBuiltinOperation | PromiseCombinatorBuiltinOperation | DomBuiltinOperation | DomPropertyBuiltinOperation | MutationBuiltinOperation | CloneBuiltinOperation;

export interface BuiltinContract {
  symbol: BuiltinSymbolKey;
  evidence: "trusted";
  trustReason?: string;
  trustOwner?: string;
  trustExpiresOn?: string;
  result?: PathResultRefinement;
  operation?: BuiltinOperation;
}

function trusted(contract: Omit<BuiltinContract, "evidence">): BuiltinContract {
  return { ...contract, evidence: "trusted" };
}

export interface BuiltinContractRegistry {
  version: 1;
  contracts: readonly BuiltinContract[];
  declarations: readonly DeclarationFingerprint[];
}

export interface DeclarationFingerprint { library: string; compilerVersion: string; sha256: string }

export function builtinSymbolId(symbol: BuiltinSymbolKey): string {
  return `${symbol.module}#${symbol.export}`;
}

export function findBuiltinContract(registry: BuiltinContractRegistry, symbol: BuiltinSymbolKey): BuiltinContract | undefined {
  const id = builtinSymbolId(symbol);
  return registry.contracts.find((contract) => builtinSymbolId(contract.symbol) === id);
}

const fsReadNames = [
  "access", "accessSync", "exists", "existsSync", "readFile", "readFileSync", "readdir", "readdirSync",
  "readlink", "readlinkSync", "realpath", "realpathSync", "stat", "statSync", "lstat", "lstatSync",
  "open", "openSync", "watch", "watchFile", "createReadStream",
] as const;
const fsWriteNames = [
  "appendFile", "appendFileSync", "chmod", "chmodSync", "chown", "chownSync", "link", "linkSync",
  "mkdir", "mkdirSync", "rename", "renameSync", "rm", "rmSync", "rmdir", "rmdirSync", "symlink",
  "symlinkSync", "truncate", "truncateSync", "unlink", "unlinkSync", "utimes", "utimesSync", "writeFile",
  "writeFileSync", "createWriteStream",
] as const;

function fsBuiltinContracts(module: string): BuiltinContract[] {
  const contracts: BuiltinContract[] = [];
  const completionCallbacks = new Set([
    "access", "exists", "readFile", "readdir", "readlink", "realpath", "stat", "lstat", "open",
    "appendFile", "chmod", "chown", "link", "mkdir", "rename", "rm", "rmdir", "symlink", "truncate", "unlink", "utimes", "writeFile",
    "copyFile", "cp", "read", "write",
  ]);
  const callbackOperation = (name: string): Pick<FsBuiltinOperation, "callbackArgumentFromEnd" | "callbackMinimumArguments" | "callbackMustBeCallable" | "callbackQueue" | "callbackRepeats"> => {
    if (module !== "node:fs") return {};
    if (name === "watch" || name === "watchFile") return {
      callbackArgumentFromEnd: 1, callbackMinimumArguments: 2,
      callbackMustBeCallable: true, callbackQueue: "poll", callbackRepeats: true,
    };
    return completionCallbacks.has(name) ? { callbackArgumentFromEnd: 1, callbackQueue: "poll" } : {};
  };
  for (const name of fsReadNames) contracts.push(trusted({
    symbol: { module, export: name },
    operation: { kind: "fs", read: true, write: name === "open" || name === "openSync", readPathArgument: 0, writePathArgument: 0, ...callbackOperation(name) },
  }));
  for (const name of fsWriteNames) contracts.push(trusted({
    symbol: { module, export: name }, operation: { kind: "fs", read: false, write: true, writePathArgument: 0, ...callbackOperation(name) },
  }));
  for (const name of ["copyFile", "copyFileSync", "cp", "cpSync"]) contracts.push(trusted({
    symbol: { module, export: name }, operation: { kind: "fs", read: true, write: true, readPathArgument: 0, writePathArgument: 1, ...callbackOperation(name) },
  }));
  for (const name of ["read", "readSync"]) contracts.push(trusted({
    symbol: { module, export: name }, operation: { kind: "fs", read: true, write: false, mutateArgument: 1, ...callbackOperation(name) },
  }));
  for (const name of ["write", "writeSync"]) contracts.push(trusted({
    symbol: { module, export: name }, operation: { kind: "fs", read: false, write: true, ...callbackOperation(name) },
  }));
  return contracts;
}

/**
 * Semantic overlays are applied after TypeChecker symbol resolution. They do
 * not modify or wrap the runtime builtin.
 */
export const builtinContractRegistry: BuiltinContractRegistry = {
  version: 1,
  declarations: [{ library: "lib.dom.d.ts", compilerVersion: "6.0.3", sha256: "d6b1eba8496bdd0eed6fc8a685768fe01b2da4a0388b5fe7df558290bffcf32f" }],
  contracts: [
    trusted({
      symbol: { module: "node:os", export: "tmpdir" },
      result: { kind: "path", pattern: "$TEMP" },
    }),
    ...([
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
    ] as const).map(([name, effect]): BuiltinContract => trusted({
      symbol: { module: "node:os", export: name },
      operation: { kind: "effect", effect },
    })),
    ...fsBuiltinContracts("node:fs"),
    ...fsBuiltinContracts("node:fs/promises"),
    trusted({ symbol: { module: "node:fs", export: "FSWatcher#close" }, operation: { kind: "timer-clear", handleReceiver: true, family: "watcher" } }),
    trusted({ symbol: { module: "node:net", export: "Server#close" }, operation: { kind: "deferred-callback", callbackArgumentFromEnd: 1, queue: "close", closesReceiverFamily: "server" } }),
    trusted({
      symbol: { module: "node:net", export: "Server#listen" },
      operation: {
        kind: "deferred-callback", callbackArgumentFromEnd: 1, callbackMinimumArguments: 2,
        callbackMustBeCallable: true, queue: "next-tick", effect: "Net",
        effectScopeArgument: 0, effectScopeKind: "net-connect",
      },
    }),
    ...["connect", "createConnection"].map((name): BuiltinContract => trusted({
      symbol: { module: "node:net", export: name },
      operation: { kind: "deferred-callback", callbackArgumentFromEnd: 1, queue: "poll", effect: "Net", effectScopeArgument: 0, effectScopeKind: "net-connect" },
    })),
    trusted({
      symbol: { module: "node:net", export: "Socket#connect" },
      operation: { kind: "deferred-callback", callbackArgumentFromEnd: 1, queue: "poll", effect: "Net", effectScopeArgument: 0, effectScopeKind: "net-connect" },
    }),
    trusted({ symbol: { module: "node:dns", export: "lookup" }, operation: { kind: "deferred-callback", callbackArgumentFromEnd: 1, queue: "poll", effect: "Net", effectScopeArgument: 0 } }),
    trusted({ symbol: { module: "node:dns", export: "lookupService" }, operation: { kind: "deferred-callback", callbackArgumentFromEnd: 1, queue: "poll", effect: "Net" } }),
    trusted({ symbol: { module: "node:crypto", export: "randomBytes" }, operation: { kind: "deferred-callback", callbackArgumentFromEnd: 1, callbackMinimumArguments: 2, queue: "poll", effect: "Random" } }),
    ...(["node:net", "node:http", "node:https"] as const).map((module): BuiltinContract => trusted({
      symbol: { module, export: "createServer" },
      operation: {
        kind: "deferred-callback", callbackArgumentFromEnd: 1, callbackMinimumArguments: 1,
        callbackMustBeCallable: true, queue: "poll", repeats: true, resultHandleFamily: "server",
      },
    })),
    ...(["node:http", "node:https"] as const).flatMap((module) => ["request", "get"].map((name): BuiltinContract => trusted({
      symbol: { module, export: name },
      operation: {
        kind: "deferred-callback", callbackArgumentFromEnd: 1, callbackMinimumArguments: 2,
        callbackMustBeCallable: true, queue: "poll", effect: "Net", effectScopeArgument: 0,
        effectScopeKind: "http-request", effectDefaultPort: module === "node:https" ? 443 : 80,
      },
    }))),
    trusted({ symbol: { module: "node:child_process", export: "exec" }, operation: {
      kind: "deferred-callback", callbackArgumentFromEnd: 1, callbackMinimumArguments: 2,
      callbackMustBeCallable: true, queue: "poll", effect: "Run",
    } }),
    trusted({ symbol: { module: "node:child_process", export: "execFile" }, operation: {
      kind: "deferred-callback", callbackArgumentFromEnd: 1, callbackMinimumArguments: 2,
      callbackMustBeCallable: true, queue: "poll", effect: "Run", effectScopeArgument: 0,
      effectScopeKind: "run-program",
    } }),
    ...["execFileSync", "spawn", "spawnSync"].map((name): BuiltinContract => trusted({
      symbol: { module: "node:child_process", export: name },
      operation: { kind: "scoped-effect", effect: "Run", effectScopeArgument: 0, effectScopeKind: "run-program" },
    })),
    ...["execSync", "fork"].map((name): BuiltinContract => trusted({
      symbol: { module: "node:child_process", export: name }, operation: { kind: "scoped-effect", effect: "Run" },
    })),
    trusted({ symbol: { module: "global", export: "fetch" }, operation: { kind: "fetch" } }),
    ...["log", "info", "warn", "error", "debug", "trace", "dir", "table"].map((name): BuiltinContract => ({
      ...trusted({ symbol: { module: "global", export: `console.${name}` }, operation: { kind: "effect", effect: "Console" } }),
    })),
    trusted({ symbol: { module: "global", export: "setTimeout" }, operation: { kind: "timer", callbackArgument: 0, delayArgument: 1, repeats: false, queue: "timer" } }),
    trusted({ symbol: { module: "global", export: "setInterval" }, operation: { kind: "timer", callbackArgument: 0, delayArgument: 1, repeats: true, queue: "timer" } }),
    trusted({ symbol: { module: "global", export: "queueMicrotask" }, operation: { kind: "timer", callbackArgument: 0, repeats: false, queue: "microtask" } }),
    trusted({ symbol: { module: "lib.node", export: "Process#nextTick" }, operation: { kind: "timer", callbackArgument: 0, repeats: false, queue: "next-tick" } }),
    trusted({ symbol: { module: "global", export: "setImmediate" }, operation: { kind: "timer", callbackArgument: 0, repeats: false, queue: "check" } }),
    trusted({ symbol: { module: "node:timers", export: "setImmediate" }, operation: { kind: "timer", callbackArgument: 0, repeats: false, queue: "check" } }),
    trusted({ symbol: { module: "global", export: "requestAnimationFrame" }, operation: { kind: "timer", callbackArgument: 0, repeats: false, queue: "animation-frame" } }),
    trusted({ symbol: { module: "global", export: "cancelAnimationFrame" }, operation: { kind: "timer-clear", handleArgument: 0, family: "animation-frame", effect: "Timer" } }),
    trusted({ symbol: { module: "global", export: "clearTimeout" }, operation: { kind: "timer-clear", handleArgument: 0, family: "timeout", effect: "Timer" } }),
    trusted({ symbol: { module: "global", export: "clearInterval" }, operation: { kind: "timer-clear", handleArgument: 0, family: "timeout", effect: "Timer" } }),
    trusted({ symbol: { module: "global", export: "clearImmediate" }, operation: { kind: "timer-clear", handleArgument: 0, family: "immediate", effect: "Timer" } }),
    trusted({ symbol: { module: "node:timers", export: "clearImmediate" }, operation: { kind: "timer-clear", handleArgument: 0, family: "immediate", effect: "Timer" } }),
    trusted({ symbol: { module: "global", export: "AbortSignal.timeout" }, operation: { kind: "abort-timeout", delayArgument: 0 } }),
    trusted({ symbol: { module: "global", export: "AbortSignal.abort" }, operation: { kind: "abort-static", reasonArgument: 0 } }),
    trusted({ symbol: { module: "global", export: "AbortSignal.any" }, operation: { kind: "abort-any", signalsArgument: 0 } }),
    trusted({ symbol: { module: "lib.dom", export: "Scheduler#postTask" }, operation: { kind: "scheduler-post-task", callbackArgument: 0, optionsArgument: 1 } }),
    trusted({ symbol: { module: "lib.dom", export: "Scheduler#yield" }, operation: { kind: "scheduler-yield" } }),
    ...(["all", "allSettled", "race", "any"] as const).map((combinator): BuiltinContract => trusted({
      symbol: { module: "lib.es", export: `PromiseConstructor#${combinator}` },
      operation: { kind: "promise-combinator", combinator, iterableArgument: 0 },
    })),
    trusted({ symbol: { module: "global", export: "Math.random" }, operation: { kind: "effect", effect: "Random" } }),
    trusted({ symbol: { module: "global", export: "crypto.randomUUID" }, operation: { kind: "effect", effect: "Random" } }),
    trusted({ symbol: { module: "global", export: "structuredClone" }, operation: { kind: "clone", valueArgument: 0, transferArgument: 1 } }),
    ...["Worker#postMessage", "MessagePort#postMessage"].map((name): BuiltinContract => trusted({ symbol: { module: "lib.dom", export: name }, operation: { kind: "clone", valueArgument: 0, transferArgument: 1 } })),
    ...["Array#copyWithin", "Array#fill", "Array#pop", "Array#push", "Array#reverse", "Array#shift", "Array#sort", "Array#splice", "Array#unshift", "Map#clear", "Map#delete", "Map#set", "Set#add", "Set#clear", "Set#delete"].map((name): BuiltinContract => ({
      ...trusted({ symbol: { module: "lib.es", export: name }, operation: { kind: "mutation" } }),
    })),
    ...domBuiltinContracts(),
    ...domPropertyBuiltinContracts(),
  ],
};

function domBuiltinContracts(): BuiltinContract[] {
  const entries: Array<[string, DomBuiltinOperation]> = [
    ["ParentNode#querySelector", { kind: "dom", operation: "NodeRead", queryArgument: 0 }],
    ["ParentNode#querySelectorAll", { kind: "dom", operation: "NodeRead", queryArgument: 0 }],
    ["Document#getElementById", { kind: "dom", operation: "NodeRead" }],
    ["Element#getAttribute", { kind: "dom", operation: "AttributeRead" }],
    ["Element#matches", { kind: "dom", operation: "NodeRead", invokesUserCode: true, queryArgument: 0 }],
    ["Element#closest", { kind: "dom", operation: "NodeRead", invokesUserCode: true, queryArgument: 0 }],
    ["Element#getBoundingClientRect", { kind: "dom", operation: "LayoutRead" }],
    ["Document#createElement", { kind: "dom", operation: "Create" }],
    ["Document#createTextNode", { kind: "dom", operation: "Create" }],
    ["Element#setAttribute", { kind: "dom", operation: "AttributeWrite", mutatesReceiver: true, invokesUserCode: true }],
    ["Node#appendChild", { kind: "dom", operation: "NodeWrite", mutatesReceiver: true, mutatesArguments: [0], invokesUserCode: true }],
    ["Node#removeChild", { kind: "dom", operation: "NodeWrite", mutatesReceiver: true, mutatesArguments: [0], invokesUserCode: true }],
    ["ParentNode#replaceChildren", { kind: "dom", operation: "NodeWrite", mutatesReceiver: true, invokesUserCode: true }],
    ["ParentNode#append", { kind: "dom", operation: "NodeWrite", mutatesReceiver: true, invokesUserCode: true }],
    ["ParentNode#prepend", { kind: "dom", operation: "NodeWrite", mutatesReceiver: true, invokesUserCode: true }],
    ["ChildNode#remove", { kind: "dom", operation: "NodeWrite", mutatesReceiver: true, invokesUserCode: true }],
    ["EventTarget#addEventListener", { kind: "dom", operation: "Listen", mutatesReceiver: true, invokesUserCode: true }],
    ["EventTarget#removeEventListener", { kind: "dom", operation: "Listen", mutatesReceiver: true }],
    ["EventTarget#dispatchEvent", { kind: "dom", operation: "Dispatch", invokesUserCode: true }],
    ["DOMParser#parseFromString", { kind: "dom", operation: "Parse" }],
  ];
  return entries.map(([key, operation]) => trusted({ symbol: { module: "lib.dom", export: key }, operation }));
}

function domPropertyBuiltinContracts(): BuiltinContract[] {
  const readOnly = (operation: DomOperation): DomPropertyBuiltinOperation => ({
    kind: "dom-property", readOperations: [operation], writeOperations: [],
  });
  const entries: Array<[string, DomPropertyBuiltinOperation]> = [
    ["Element#attributes", readOnly("AttributeRead")],
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
    ["Node#nodeValue", {
      kind: "dom-property", readOperations: ["TextRead"], writeOperations: ["TextWrite"],
      mutatesReceiverOnWrite: true,
    }],
    ["CharacterData#data", {
      kind: "dom-property", readOperations: ["TextRead"], writeOperations: ["TextWrite"],
      mutatesReceiverOnWrite: true,
    }],
    ["HTMLInputElement#value", {
      kind: "dom-property", readOperations: ["PropertyRead"], writeOperations: ["PropertyWrite"],
      mutatesReceiverOnWrite: true,
    }],
  ];
  return entries.map(([key, operation]) => trusted({ symbol: { module: "lib.dom", export: key }, operation }));
}
