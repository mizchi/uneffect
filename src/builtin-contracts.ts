import { builtinSemanticCatalog, materializeBuiltinSemanticDefinitions } from "./builtin-semantic-catalog.js";

export interface BuiltinSymbolKey {
  module: string;
  export: string;
}

export interface PathResultRefinement {
  kind: "path";
  pattern: string;
}

/** The reviewed call returns a newly owned object with no aliases in caller-visible state. */
export interface FreshResultRefinement { kind: "fresh" }
export type BuiltinResultRefinement = PathResultRefinement | FreshResultRefinement;

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
export interface InlineCallbackBuiltinOperation {
  kind: "inline-callback";
  /** Arguments that are themselves invoked synchronously. */
  callbackArguments: readonly number[];
  /** Callback positions that may be omitted by the selected overload. */
  optionalCallbackArguments?: readonly number[];
  /** Array-literal arguments whose function elements are invoked synchronously. */
  callbackArrayArguments?: readonly number[];
  /** Number of callable-return layers synchronously invoked for each callback-array element. */
  callbackArrayReturnDepth?: number;
}
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
  operations: readonly [DomOperation, ...DomOperation[]];
  mutatesReceiver?: boolean;
  mutatesArguments?: readonly number[];
  invokesUserCode?: boolean;
  queryArgument?: number;
}
export interface DomPropertyBuiltinOperation {
  kind: "dom-property";
  readOperations: readonly DomOperation[];
  writeOperations: readonly DomOperation[];
  resultRegion?: "receiver";
  writeRegion?: "parentNode";
  mutatesReceiverOnWrite?: boolean;
  mutatesWriteRegionOnWrite?: boolean;
  invokesUserCodeOnWrite?: boolean;
}
export interface EffectPropertyBuiltinOperation {
  kind: "effect-property";
  readEffect?: string;
  writeEffect?: string;
}

export type BuiltinOperation = FsBuiltinOperation | StaticEffectBuiltinOperation | ScopedEffectBuiltinOperation | FetchBuiltinOperation | TimerBuiltinOperation | DeferredCallbackBuiltinOperation | TimerClearBuiltinOperation | AbortTimeoutBuiltinOperation | AbortStaticBuiltinOperation | AbortAnyBuiltinOperation | SchedulerPostTaskBuiltinOperation | SchedulerYieldBuiltinOperation | InlineCallbackBuiltinOperation | PromiseCombinatorBuiltinOperation | DomBuiltinOperation | DomPropertyBuiltinOperation | EffectPropertyBuiltinOperation | MutationBuiltinOperation | CloneBuiltinOperation;

export interface CallableResultContract {
  /** Operation performed when the returned function is called. Omission means zero reviewed authority. */
  operation?: BuiltinOperation;
  /** Factory argument positions captured and synchronously invoked by the returned function. */
  capturedCallbackArguments?: readonly number[];
}

export interface BuiltinContract {
  symbol: BuiltinSymbolKey;
  /** Exact host/package artifact against which this function contract was reviewed. */
  runtime?: { kind: "package"; version: string } | { kind: "node"; major: number };
  evidence: "trusted";
  trustReason?: string;
  trustOwner?: string;
  trustExpiresOn?: string;
  result?: BuiltinResultRefinement;
  /** Orthogonal projection: the call mutates its receiver in addition to its primary operation. */
  receiverMutation?: boolean;
  operation?: BuiltinOperation;
  callableResult?: CallableResultContract;
}

export interface ModuleInitializationContract {
  /** Exact package specifier, or a trailing `*` prefix pattern such as `node:*`. */
  module: string;
  effects: readonly string[];
  evidence: "trusted";
  trustReason: string;
  trustOwner: string;
  trustExpiresOn?: string;
  /** The runtime artifact against which initialization was reviewed. */
  runtime:
    | { kind: "package"; version: string }
    | { kind: "node"; major: number };
}

export interface ModuleInitializationEnvironment {
  packageVersion?: string;
  nodeMajor?: number;
}

function trusted(contract: Omit<BuiltinContract, "evidence">): BuiltinContract {
  return { ...contract, evidence: "trusted" };
}

export interface BuiltinContractRegistry {
  version: 2;
  contracts: readonly BuiltinContract[];
  moduleInitializations: readonly ModuleInitializationContract[];
  declarations: readonly DeclarationFingerprint[];
  /** Declarative semantic modules that contributed trusted analyzer inputs. */
  modules?: readonly SemanticModuleLedgerEntry[];
}

export interface SemanticModuleLedgerEntry {
  name: string;
  version: string;
  namespace: string;
  evidence: "trusted";
  trustOwner: string;
  trustReason: string;
  digest: string;
}

export interface BuiltinContractRegistryExtension {
  contracts?: readonly BuiltinContract[];
  moduleInitializations?: readonly ModuleInitializationContract[];
  declarations?: readonly DeclarationFingerprint[];
}

/**
 * Add caller-owned contracts ahead of defaults. Exact module contracts still
 * outrank wildcard contracts, so a narrow review can refine `node:*` safely.
 */
export function extendBuiltinContractRegistry(
  base: BuiltinContractRegistry,
  extension: BuiltinContractRegistryExtension,
): BuiltinContractRegistry {
  const contractIds = new Set(extension.contracts?.map((item) => builtinSymbolId(item.symbol)) ?? []);
  const moduleIds = new Set(extension.moduleInitializations?.map((item) => item.module) ?? []);
  const declarationIds = new Set(extension.declarations?.map((item) => item.library) ?? []);
  return {
    version: 2,
    contracts: extension.contracts
      ? [...extension.contracts, ...base.contracts.filter((item) => !contractIds.has(builtinSymbolId(item.symbol)))]
      : base.contracts,
    moduleInitializations: extension.moduleInitializations
      ? [...extension.moduleInitializations, ...base.moduleInitializations.filter((item) => !moduleIds.has(item.module))]
      : base.moduleInitializations,
    declarations: extension.declarations
      ? [...extension.declarations, ...base.declarations.filter((item) => !declarationIds.has(item.library))]
      : base.declarations,
    ...(base.modules ? { modules: base.modules } : {}),
  };
}

export interface DeclarationFingerprint { library: string; compilerVersion: string; sha256: string }

export function builtinSymbolId(symbol: BuiltinSymbolKey): string {
  return `${symbol.module}#${symbol.export}`;
}

export function findBuiltinContract(registry: BuiltinContractRegistry, symbol: BuiltinSymbolKey): BuiltinContract | undefined {
  const id = builtinSymbolId(symbol);
  return registry.contracts.find((contract) => builtinSymbolId(contract.symbol) === id);
}

export function findModuleInitializationContract(
  registry: BuiltinContractRegistry,
  moduleName: string,
  environment: ModuleInitializationEnvironment,
): ModuleInitializationContract | undefined {
  const nameMatches = registry.moduleInitializations.filter((contract) => contract.module.endsWith("*")
      ? moduleName.startsWith(contract.module.slice(0, -1))
      : contract.module === moduleName);
  const exactMatches = nameMatches.filter((contract) => !contract.module.endsWith("*"));
  const candidates = exactMatches.length > 0 ? exactMatches : nameMatches;
  const nodeRuntime = moduleName.startsWith("node:");
  return candidates.find((contract) => nodeRuntime
    ? contract.runtime.kind === "node" && contract.runtime.major === environment.nodeMajor
    : contract.runtime.kind === "package" && contract.runtime.version === environment.packageVersion);
}

function packageName(moduleName: string): string {
  if (!moduleName.startsWith("@")) return moduleName.split("/")[0]!;
  return moduleName.split("/").slice(0, 2).join("/");
}

function resolvedPackageVersion(program: ts.Program, containingFile: string, moduleName: string): string | undefined {
  const resolved = ts.resolveModuleName(moduleName, containingFile, program.getCompilerOptions(), ts.sys).resolvedModule;
  if (!resolved) return undefined;
  const expectedName = packageName(moduleName);
  let directory = dirname(resolved.resolvedFileName);
  while (true) {
    const manifest = join(directory, "package.json");
    const text = ts.sys.readFile(manifest);
    if (text !== undefined) {
      try {
        const value = JSON.parse(text) as { name?: unknown; version?: unknown };
        if (value.name === expectedName && typeof value.version === "string") return value.version;
      } catch { return undefined; }
    }
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

/** Fail-closed runtime binding for reviewed function contracts. */
export function builtinContractApplies(
  program: ts.Program,
  containingFile: string,
  contract: BuiltinContract,
): boolean {
  if (contract.runtime === undefined) return true;
  return contract.runtime.kind === "node"
    ? contract.symbol.module.startsWith("node:")
      && contract.runtime.major === Number.parseInt(process.versions.node.split(".")[0]!, 10)
    : !contract.symbol.module.startsWith("node:")
      && contract.runtime.version === resolvedPackageVersion(program, containingFile, contract.symbol.module);
}

/** Resolve a reviewed contract against the runtime/package actually analyzed. */
export function resolveModuleInitializationContract(
  program: ts.Program,
  containingFile: string,
  moduleName: string,
  registry: BuiltinContractRegistry = builtinContractRegistry,
): ModuleInitializationContract | undefined {
  const environment: ModuleInitializationEnvironment = moduleName.startsWith("node:")
    ? { nodeMajor: Number.parseInt(process.versions.node.split(".")[0]!, 10) }
    : { packageVersion: resolvedPackageVersion(program, containingFile, moduleName) };
  return findModuleInitializationContract(registry, moduleName, environment);
}

/**
 * Semantic overlays are applied after TypeChecker symbol resolution. They do
 * not modify or wrap the runtime builtin.
 */
export const builtinContractRegistry: BuiltinContractRegistry = {
  version: 2,
  declarations: [{ library: "lib.dom.d.ts", compilerVersion: "6.0.3", sha256: "d6b1eba8496bdd0eed6fc8a685768fe01b2da4a0388b5fe7df558290bffcf32f" }],
  moduleInitializations: [
    {
      module: "node:*", effects: [], evidence: "trusted",
      runtime: { kind: "node", major: 24 },
      trustReason: "reviewed Node builtin module initialization boundary", trustOwner: "@mizchi/uneffect",
    },
    ...([
      ["@oxlint/plugins", "1.80.0"], ["corsa-oxlint", "1.12.4"], ["effect", "3.22.1"],
      ["typescript", "6.0.3"], ["valibot", "1.4.2"], ["z3-solver", "4.16.0"],
    ] as const).map(([module, packageVersion]): ModuleInitializationContract => ({
      module, runtime: { kind: "package", version: packageVersion }, effects: [], evidence: "trusted",
      trustReason: "reviewed package module initialization boundary", trustOwner: "@mizchi/uneffect",
    })),
  ],
  contracts: [
    trusted({
      symbol: { module: "corsa-oxlint", export: "OxlintUtils#RuleCreator" },
      runtime: { kind: "package", version: "1.12.4" },
      callableResult: { capturedCallbackArguments: [0] },
      trustReason: "Corsa 1.12.4 RuleCreator returns a synchronous decorator that invokes its captured URL creator",
      trustOwner: "@mizchi/uneffect",
    }),
    trusted({
      symbol: { module: "corsa-oxlint", export: "definePlugin" },
      runtime: { kind: "package", version: "1.12.4" },
      trustReason: "Corsa 1.12.4 definePlugin constructs plugin metadata without executing rule code",
      trustOwner: "@mizchi/uneffect",
    }),
    ...(["pipe", "number", "safeInteger", "brand", "minValue", "maxValue", "finite"] as const).map((name): BuiltinContract => trusted({
      symbol: { module: "valibot", export: name },
      runtime: { kind: "package", version: "1.4.2" },
      trustReason: `Valibot 1.4.2 ${name} constructs schema metadata without executing validation`,
      trustOwner: "@mizchi/uneffect",
    })),
    ...materializeBuiltinSemanticDefinitions(builtinSemanticCatalog.definitions),
    trusted({
      symbol: { module: "typescript", export: "Program#emit" },
      runtime: { kind: "package", version: "6.0.3" },
      operation: { kind: "inline-callback", callbackArguments: [1] },
      trustReason: "TypeScript Program.emit invokes writeFile during the synchronous emit operation",
      trustOwner: "@mizchi/uneffect",
    }),
    ...([
      ["Node#forEachChild", [0, 1], [1]],
      ["forEachChild", [1, 2], [2]],
      ["visitNode", [1]],
      ["visitEachChild", [1]],
    ] as const).map(([name, callbackArguments, optionalCallbackArguments]): BuiltinContract => trusted({
      symbol: { module: "typescript", export: name },
      runtime: { kind: "package", version: "6.0.3" },
      operation: { kind: "inline-callback", callbackArguments, ...(optionalCallbackArguments ? { optionalCallbackArguments } : {}) },
      trustReason: `TypeScript 6.0.3 ${name} invokes its visitor callbacks synchronously`,
      trustOwner: "@mizchi/uneffect",
    })),
    trusted({
      symbol: { module: "typescript", export: "transform" },
      runtime: { kind: "package", version: "6.0.3" },
      operation: { kind: "inline-callback", callbackArguments: [], callbackArrayArguments: [1], callbackArrayReturnDepth: 1 },
      trustReason: "TypeScript 6.0.3 transform synchronously invokes each array-literal TransformerFactory and its returned Transformer",
      trustOwner: "@mizchi/uneffect",
    }),
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
    trusted({ symbol: { module: "node:crypto", export: "randomFill" }, operation: { kind: "deferred-callback", callbackArgumentFromEnd: 1, callbackMinimumArguments: 2, callbackMustBeCallable: true, queue: "poll", effect: "Random" } }),
    trusted({ symbol: { module: "node:crypto", export: "randomInt" }, operation: { kind: "deferred-callback", callbackArgumentFromEnd: 1, callbackMinimumArguments: 2, callbackMustBeCallable: true, queue: "poll", effect: "Random" } }),
    ...["randomFillSync", "randomUUID"].map((name): BuiltinContract => trusted({
      symbol: { module: "node:crypto", export: name }, operation: { kind: "effect", effect: "Random" },
    })),
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
      ...trusted({
        symbol: { module: "global", export: `console.${name}` }, operation: { kind: "effect", effect: "Console" },
        trustReason: `reviewed Console ${name} semantic overlay`, trustOwner: "@mizchi/uneffect",
      }),
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
    trusted({ symbol: { module: "global", export: "crypto.randomUUID" }, operation: { kind: "effect", effect: "Random" } }),
    ...["getRandomValues", "randomUUID"].map((name): BuiltinContract => trusted({
      symbol: { module: "lib.dom", export: `Crypto#${name}` }, operation: { kind: "effect", effect: "Random" },
    })),
    ...["Worker#postMessage", "MessagePort#postMessage"].map((name): BuiltinContract => trusted({ symbol: { module: "lib.dom", export: name }, operation: { kind: "clone", valueArgument: 0, transferArgument: 1 } })),
    ...["Array#copyWithin", "Array#fill", "Array#pop", "Array#push", "Array#reverse", "Array#shift", "Array#splice", "Array#unshift", "Map#clear", "Map#delete", "Map#set", "Set#add", "Set#clear", "Set#delete"].map((name): BuiltinContract => ({
      ...trusted({ symbol: { module: "lib.es", export: name }, operation: { kind: "mutation" } }),
    })),
    ...domBuiltinContracts(),
    ...domPropertyBuiltinContracts(),
    trusted({ symbol: { module: "lib.dom", export: "Document#cookie" }, operation: {
      kind: "effect-property", readEffect: "CookieRead", writeEffect: "CookieWrite",
    } }),
    trusted({ symbol: { module: "lib.dom", export: "Storage#length" }, operation: {
      kind: "effect-property", readEffect: "LocalStorageRead",
    } }),
  ],
};

function domBuiltinContracts(): BuiltinContract[] {
  const dom = (
    operations: DomOperation | readonly [DomOperation, ...DomOperation[]],
    options: Omit<DomBuiltinOperation, "kind" | "operations"> = {},
  ): DomBuiltinOperation => ({
    kind: "dom", operations: typeof operations === "string" ? [operations] : operations, ...options,
  });
  const entries: Array<[string, DomBuiltinOperation]> = [
    ["ParentNode#querySelector", dom("NodeRead", { queryArgument: 0 })],
    ["ParentNode#querySelectorAll", dom("NodeRead", { queryArgument: 0 })],
    ["Document#getElementById", dom("NodeRead")],
    ["Element#getAttribute", dom("AttributeRead")],
    ...[
      "Element#getAttributeNS", "Element#getAttributeNames", "Element#getAttributeNode",
      "Element#getAttributeNodeNS", "Element#hasAttribute", "Element#hasAttributeNS", "Element#hasAttributes",
    ].map((key): [string, DomBuiltinOperation] => [key, dom("AttributeRead")]),
    ...[
      "Node#compareDocumentPosition", "Node#contains", "Node#getRootNode", "Node#hasChildNodes",
      "Node#isEqualNode", "Node#isSameNode",
    ].map((key): [string, DomBuiltinOperation] => [key, dom("NodeRead")]),
    ["CharacterData#substringData", dom("TextRead")],
    ["Element#matches", dom("NodeRead", { invokesUserCode: true, queryArgument: 0 })],
    ["Element#closest", dom("NodeRead", { invokesUserCode: true, queryArgument: 0 })],
    ["Element#getBoundingClientRect", dom("LayoutRead")],
    ["Document#createElement", dom("Create")],
    ["Document#createTextNode", dom("Create")],
    ["Element#setAttribute", dom("AttributeWrite", { mutatesReceiver: true, invokesUserCode: true })],
    ...[
      "Element#removeAttribute", "Element#removeAttributeNS", "Element#setAttributeNS", "Element#toggleAttribute",
    ].map((key): [string, DomBuiltinOperation] => [key, dom("AttributeWrite", {
      mutatesReceiver: true, invokesUserCode: true,
    })]),
    ...["Element#removeAttributeNode", "Element#setAttributeNode", "Element#setAttributeNodeNS"]
      .map((key): [string, DomBuiltinOperation] => [key, dom("AttributeWrite", {
        mutatesReceiver: true, mutatesArguments: [0], invokesUserCode: true,
      })]),
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
      .map((key): [string, DomBuiltinOperation] => [key, dom("AttributeWrite", {
        mutatesReceiver: true, invokesUserCode: true,
      })]),
    ...["NamedNodeMap#setNamedItem", "NamedNodeMap#setNamedItemNS"]
      .map((key): [string, DomBuiltinOperation] => [key, dom("AttributeWrite", {
        mutatesReceiver: true, mutatesArguments: [0], invokesUserCode: true,
      })]),
    ["EventTarget#addEventListener", dom("Listen", { mutatesReceiver: true, invokesUserCode: true })],
    ["EventTarget#removeEventListener", dom("Listen", { mutatesReceiver: true })],
    ["EventTarget#dispatchEvent", dom("Dispatch", { invokesUserCode: true })],
    ["DOMParser#parseFromString", dom("Parse")],
  ];
  return entries.map(([key, operation]) => trusted({ symbol: { module: "lib.dom", export: key }, operation }));
}

function domPropertyBuiltinContracts(): BuiltinContract[] {
  const readOnly = (operation: DomOperation): DomPropertyBuiltinOperation => ({
    kind: "dom-property", readOperations: [operation], writeOperations: [],
  });
  const entries: Array<[string, DomPropertyBuiltinOperation]> = [
    ["Element#attributes", {
      kind: "dom-property", readOperations: ["AttributeRead"], writeOperations: [], resultRegion: "receiver",
    }],
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
    ...["Element#innerHTML", "ShadowRoot#innerHTML"].map((key): [string, DomPropertyBuiltinOperation] => [key, {
      kind: "dom-property",
      readOperations: ["NodeRead", "AttributeRead", "TextRead"],
      writeOperations: ["Parse", "NodeWrite"],
      mutatesReceiverOnWrite: true,
      invokesUserCodeOnWrite: true,
    }]),
    ["Element#outerHTML", {
      kind: "dom-property",
      readOperations: ["NodeRead", "AttributeRead", "TextRead"],
      writeOperations: ["Parse", "NodeWrite"],
      writeRegion: "parentNode",
      mutatesReceiverOnWrite: true,
      mutatesWriteRegionOnWrite: true,
      invokesUserCodeOnWrite: true,
    }],
    ...[
      "Element#clientHeight", "Element#clientLeft", "Element#clientTop", "Element#clientWidth",
      "Element#scrollHeight", "Element#scrollWidth", "HTMLElement#offsetHeight", "HTMLElement#offsetWidth",
    ].map((key): [string, DomPropertyBuiltinOperation] => [key, readOnly("LayoutRead")]),
    ["HTMLInputElement#value", {
      kind: "dom-property", readOperations: ["PropertyRead"], writeOperations: ["PropertyWrite"],
      mutatesReceiverOnWrite: true,
    }],
    ...["src", "integrity", "crossOrigin", "type", "async", "defer", "referrerPolicy", "nonce"]
      .map((name): [string, DomPropertyBuiltinOperation] => [`HTMLScriptElement#${name}`, {
        kind: "dom-property", readOperations: ["PropertyRead"], writeOperations: ["PropertyWrite"],
        mutatesReceiverOnWrite: true,
      }]),
  ];
  return entries.map(([key, operation]) => trusted({ symbol: { module: "lib.dom", export: key }, operation }));
}
import { dirname, join } from "node:path";
import ts from "typescript";
