import type { BuiltinContract } from "./builtin-contracts.js";
import { validateBuiltinSemantics } from "./builtin-semantic-schema.js";
import type { BuiltinSemantics, CallbackQueue, ScopeProjector, SemanticPrimitive, ValueProjector } from "./builtin-semantic-schema.js";

export type BuiltinSemanticPlatform = "javascript" | "node" | "dom" | "package";
export interface ReviewedBuiltinSemantic extends Omit<BuiltinContract, "evidence"> {
  platform: BuiltinSemanticPlatform;
  stability: "reviewed";
}
export interface BuiltinSemanticCatalog {
  schema: "uneffect-builtin-semantics/v1";
  definitions: readonly ReviewedBuiltinSemantic[];
}

type DomOperation =
  | "AttributeRead" | "AttributeWrite"
  | "NodeRead" | "NodeWrite"
  | "TextRead" | "TextWrite"
  | "PropertyRead" | "PropertyWrite"
  | "LayoutRead" | "Create" | "Listen" | "Dispatch" | "Parse";
interface DomMethodDefinition {
  operations: readonly [DomOperation, ...DomOperation[]];
  mutatesReceiver?: boolean;
  mutatesArguments?: readonly number[];
  invokesUserCode?: boolean;
  queryArgument?: number;
}

const reviewed = (platform: BuiltinSemanticPlatform, definition: Omit<ReviewedBuiltinSemantic, "platform" | "stability">): ReviewedBuiltinSemantic =>
  ({ ...definition, platform, stability: "reviewed" });

const inlineCallbackSemantics = (index: number, optional = false): BuiltinSemantics => ({
  schema: "uneffect-semantic-primitives/v1",
  primitives: [{
    kind: "callback", target: { kind: "argument", index }, timing: "sync", queue: "current",
    cardinality: "0..n", callable: optional ? "optional" : "required",
  }],
});

const timerSemantics = (queue: CallbackQueue, repeats: boolean, delayArgument?: number): BuiltinSemantics => ({
  schema: "uneffect-semantic-primitives/v1",
  primitives: [
    { kind: "effect", capability: "Timer" },
    {
      kind: "callback", target: { kind: "argument", index: 0 }, timing: "deferred", queue,
      cardinality: repeats ? "0..n" : "0..1", callable: "required",
    },
    { kind: "protocol", name: "timer", transition: "schedule", inputs: {
      callback: { kind: "argument", index: 0 },
      ...(delayArgument === undefined ? {} : { delay: { kind: "argument", index: delayArgument } as const }),
    } },
  ],
});

const effectSemantics = (
  capability: string,
  options: { callbackFromEnd?: number; minimumArguments?: number; queue?: Exclude<CallbackQueue, "current">; scope?: ScopeProjector } = {},
): BuiltinSemantics => ({
  schema: "uneffect-semantic-primitives/v1",
  primitives: [
    { kind: "effect", capability, ...(options.scope ? { scope: options.scope } : {}) },
    ...(options.callbackFromEnd === undefined ? [] : [{
      kind: "callback" as const,
      target: { kind: "argument-from-end" as const, offset: options.callbackFromEnd, ...(options.minimumArguments === undefined ? {} : { minimumArguments: options.minimumArguments }) },
      timing: "deferred" as const, queue: options.queue ?? "poll", cardinality: "0..1" as const, callable: "optional" as const,
    }]),
  ],
});

const deferredNetworkSemantics = (options: {
  effect?: boolean;
  scope?: Extract<SemanticPrimitive, { kind: "effect" }>["scope"];
  callbackMinimumArguments?: number;
  callbackCardinality?: "0..1" | "0..n";
  queue?: "next-tick" | "poll" | "close";
  resultResource?: string;
  releaseReceiver?: string;
  protocol?: { name: string; transition: string };
}): BuiltinSemantics => ({
  schema: "uneffect-semantic-primitives/v1",
  primitives: [
    ...(options.scope ? [{ kind: "effect" as const, capability: "Net", scope: options.scope }]
      : options.effect ? [{ kind: "effect" as const, capability: "Net" }] : []),
    {
      kind: "callback" as const,
      target: { kind: "argument-from-end" as const, offset: 1, ...(options.callbackMinimumArguments === undefined ? {} : { minimumArguments: options.callbackMinimumArguments }) },
      timing: "deferred" as const,
      queue: options.queue ?? "poll",
      cardinality: options.callbackCardinality ?? "0..1",
      callable: "optional" as const,
    },
    ...(options.resultResource ? [
      { kind: "result" as const, refinement: { kind: "resource" as const, family: options.resultResource } },
      { kind: "acquire" as const, resource: options.resultResource, target: { kind: "result" as const } },
    ] : []),
    ...(options.releaseReceiver ? [{ kind: "release" as const, resource: options.releaseReceiver, target: { kind: "receiver" as const } }] : []),
    ...(options.protocol ? [{ kind: "protocol" as const, name: options.protocol.name, transition: options.protocol.transition }] : []),
  ],
});

const fsReadNames = ["access", "accessSync", "exists", "existsSync", "readFile", "readFileSync", "readdir", "readdirSync", "readlink", "readlinkSync", "realpath", "realpathSync", "stat", "statSync", "lstat", "lstatSync", "open", "openSync", "watch", "watchFile", "createReadStream"] as const;
const fsWriteNames = ["appendFile", "appendFileSync", "chmod", "chmodSync", "chown", "chownSync", "link", "linkSync", "mkdir", "mkdirSync", "rename", "renameSync", "rm", "rmSync", "rmdir", "rmdirSync", "symlink", "symlinkSync", "truncate", "truncateSync", "unlink", "unlinkSync", "utimes", "utimesSync", "writeFile", "writeFileSync", "createWriteStream"] as const;

function nodeFsDefinitions(module: "node:fs" | "node:fs/promises"): ReviewedBuiltinSemantic[] {
  const callbacks = new Set(["access", "exists", "readFile", "readdir", "readlink", "realpath", "stat", "lstat", "open", "appendFile", "chmod", "chown", "link", "mkdir", "rename", "rm", "rmdir", "symlink", "truncate", "unlink", "utimes", "writeFile", "copyFile", "cp", "read", "write"]);
  const semantics = (name: string, options: {
    read?: boolean; write?: boolean; readPathArgument?: number; writePathArgument?: number; mutateArgument?: number;
  }): BuiltinSemantics => {
    const primitives: SemanticPrimitive[] = [];
    if (options.read) primitives.push({
      kind: "effect", capability: "FsRead",
      ...(options.readPathArgument === undefined ? {} : { scope: { kind: "filesystem-path", target: { kind: "argument", index: options.readPathArgument } } }),
    });
    if (options.write) primitives.push({
      kind: "effect", capability: "FsWrite",
      ...(options.writePathArgument === undefined ? {} : { scope: { kind: "filesystem-path", target: { kind: "argument", index: options.writePathArgument } } }),
    });
    if (options.mutateArgument !== undefined) primitives.push({ kind: "mutate", target: { kind: "argument", index: options.mutateArgument } });
    if (module === "node:fs" && (callbacks.has(name) || name === "watch" || name === "watchFile")) {
      const repeats = name === "watch" || name === "watchFile";
      primitives.push({
        kind: "callback",
        target: { kind: "argument-from-end", offset: 1, ...(repeats ? { minimumArguments: 2 } : {}) },
        timing: "deferred", queue: "poll", cardinality: repeats ? "0..n" : "0..1", callable: "required",
      });
      if (repeats) {
        primitives.push({ kind: "result", refinement: { kind: "resource", family: "watcher" } });
        primitives.push({ kind: "acquire", resource: "watcher", target: { kind: "result" } });
      }
    }
    return { schema: "uneffect-semantic-primitives/v1", primitives };
  };
  const reads = module === "node:fs"
    ? fsReadNames
    : ["access", "readFile", "readdir", "readlink", "realpath", "stat", "statfs", "lstat", "open", "opendir", "watch", "glob"] as const;
  const writes = module === "node:fs"
    ? fsWriteNames
    : ["appendFile", "chmod", "chown", "lchmod", "lchown", "lutimes", "link", "mkdir", "mkdtemp", "mkdtempDisposable", "rename", "rm", "rmdir", "symlink", "truncate", "unlink", "utimes", "writeFile"] as const;
  const copies = module === "node:fs" ? ["copyFile", "copyFileSync", "cp", "cpSync"] : ["copyFile", "cp"];
  const descriptorReads = module === "node:fs" ? ["read", "readSync"] : [];
  const descriptorWrites = module === "node:fs" ? ["write", "writeSync"] : [];
  return [
    ...reads.map((name) => reviewed("node", { symbol: { module, export: name }, semantics: semantics(name, { read: true, write: name === "open", readPathArgument: 0, writePathArgument: 0 }) })),
    ...writes.map((name) => reviewed("node", { symbol: { module, export: name }, semantics: semantics(name, { write: true, writePathArgument: name === "symlink" ? 1 : 0 }) })),
    ...copies.map((name) => reviewed("node", { symbol: { module, export: name }, semantics: semantics(name, { read: true, write: true, readPathArgument: 0, writePathArgument: 1 }) })),
    ...descriptorReads.map((name) => reviewed("node", { symbol: { module, export: name }, semantics: semantics(name, { read: true, mutateArgument: 1 }) })),
    ...descriptorWrites.map((name) => reviewed("node", { symbol: { module, export: name }, semantics: semantics(name, { write: true }) })),
  ];
}

function domMethodDefinitions(): ReviewedBuiltinSemantic[] {
  const dom = (
    operations: DomOperation | readonly [DomOperation, ...DomOperation[]],
    options: Omit<DomMethodDefinition, "operations"> = {},
  ): DomMethodDefinition => ({ operations: typeof operations === "string" ? [operations] : operations, ...options });
  const entries: Array<[string, DomMethodDefinition]> = [
    ["ParentNode#querySelector", dom("NodeRead", { queryArgument: 0 })],
    ["ParentNode#querySelectorAll", dom("NodeRead", { queryArgument: 0 })],
    ["Document#getElementById", dom("NodeRead")],
    ["Element#getAttribute", dom("AttributeRead")],
    ...["Element#getAttributeNS", "Element#getAttributeNames", "Element#getAttributeNode", "Element#getAttributeNodeNS", "Element#hasAttribute", "Element#hasAttributeNS", "Element#hasAttributes"]
      .map((key): [string, DomMethodDefinition] => [key, dom("AttributeRead")]),
    ...["Node#compareDocumentPosition", "Node#contains", "Node#getRootNode", "Node#hasChildNodes", "Node#isEqualNode", "Node#isSameNode"]
      .map((key): [string, DomMethodDefinition] => [key, dom("NodeRead")]),
    ["CharacterData#substringData", dom("TextRead")],
    ["Element#matches", dom("NodeRead", { invokesUserCode: true, queryArgument: 0 })],
    ["Element#closest", dom("NodeRead", { invokesUserCode: true, queryArgument: 0 })],
    ["Element#getBoundingClientRect", dom("LayoutRead")],
    ["Document#createElement", dom("Create")],
    ["Document#createTextNode", dom("Create")],
    ["Element#setAttribute", dom("AttributeWrite", { mutatesReceiver: true, invokesUserCode: true })],
    ...["Element#removeAttribute", "Element#removeAttributeNS", "Element#setAttributeNS", "Element#toggleAttribute"]
      .map((key): [string, DomMethodDefinition] => [key, dom("AttributeWrite", { mutatesReceiver: true, invokesUserCode: true })]),
    ...["Element#removeAttributeNode", "Element#setAttributeNode", "Element#setAttributeNodeNS"]
      .map((key): [string, DomMethodDefinition] => [key, dom("AttributeWrite", { mutatesReceiver: true, mutatesArguments: [0], invokesUserCode: true })]),
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
      .map((key): [string, DomMethodDefinition] => [key, dom("TextWrite", { mutatesReceiver: true })]),
    ["Element#insertAdjacentHTML", dom(["Parse", "NodeWrite"], { mutatesReceiver: true, invokesUserCode: true })],
    ["Element#insertAdjacentText", dom(["TextWrite", "NodeWrite"], { mutatesReceiver: true })],
    ...["NamedNodeMap#getNamedItem", "NamedNodeMap#getNamedItemNS", "NamedNodeMap#item"]
      .map((key): [string, DomMethodDefinition] => [key, dom("AttributeRead")]),
    ...["NamedNodeMap#removeNamedItem", "NamedNodeMap#removeNamedItemNS"]
      .map((key): [string, DomMethodDefinition] => [key, dom("AttributeWrite", { mutatesReceiver: true, invokesUserCode: true })]),
    ...["NamedNodeMap#setNamedItem", "NamedNodeMap#setNamedItemNS"]
      .map((key): [string, DomMethodDefinition] => [key, dom("AttributeWrite", { mutatesReceiver: true, mutatesArguments: [0], invokesUserCode: true })]),
    ["EventTarget#addEventListener", dom("Listen", { mutatesReceiver: true, invokesUserCode: true })],
    ["EventTarget#removeEventListener", dom("Listen", { mutatesReceiver: true })],
    ["EventTarget#dispatchEvent", dom("Dispatch", { invokesUserCode: true })],
    ["DOMParser#parseFromString", dom("Parse")],
  ];
  return entries.map(([key, operation]) => {
    const receiver: ValueProjector = { kind: "receiver" };
    const primitives: SemanticPrimitive[] = operation.operations.map((member) => ({
      kind: "effect", capability: "Dom", scope: { kind: "region", member, target: receiver },
    }));
    if (operation.mutatesReceiver) primitives.push({ kind: "mutate", target: receiver });
    for (const index of operation.mutatesArguments ?? []) primitives.push({ kind: "mutate", target: { kind: "argument", index } });
    if (operation.invokesUserCode) primitives.push({ kind: "invoke-user-code" });
    if (operation.queryArgument !== undefined) primitives.push({ kind: "result", refinement: { kind: "css-selector", target: { kind: "argument", index: operation.queryArgument } } });
    return reviewed("dom", {
      symbol: { module: "lib.dom", export: key },
      semantics: { schema: "uneffect-semantic-primitives/v1", primitives },
    });
  });
}

function domPropertyDefinitions(): ReviewedBuiltinSemantic[] {
  const receiver: ValueProjector = { kind: "receiver" };
  const parent: ValueProjector = { kind: "region", target: receiver, region: "parentNode" };
  const dom = (member: DomOperation, target: ValueProjector = receiver): SemanticPrimitive => ({
    kind: "effect", capability: "Dom", scope: { kind: "region", member, target },
  });
  const property = (key: string, read: SemanticPrimitive[], write: SemanticPrimitive[] = []): ReviewedBuiltinSemantic => reviewed("dom", {
    symbol: { module: "lib.dom", export: key },
    semantics: { schema: "uneffect-semantic-primitives/v1", primitives: [{ kind: "property", read, write }] },
  });
  return [
    property("Element#attributes", [dom("AttributeRead"), { kind: "result", refinement: { kind: "alias", target: receiver } }]),
    ...[
      "Node#parentNode", "Node#parentElement", "Node#childNodes", "Node#firstChild", "Node#lastChild",
      "Node#nextSibling", "Node#previousSibling", "Node#ownerDocument", "Node#isConnected",
      "ParentNode#children", "ParentNode#firstElementChild", "ParentNode#lastElementChild",
      "ParentNode#childElementCount", "NonDocumentTypeChildNode#nextElementSibling",
      "NonDocumentTypeChildNode#previousElementSibling",
    ].map((key) => property(key, [dom("NodeRead")])),
    property("Node#textContent", [dom("TextRead")], [dom("TextWrite"), dom("NodeWrite"), { kind: "mutate", target: receiver }, { kind: "invoke-user-code" }]),
    property("Node#nodeValue", [dom("TextRead")], [dom("TextWrite"), { kind: "mutate", target: receiver }]),
    property("CharacterData#data", [dom("TextRead")], [dom("TextWrite"), { kind: "mutate", target: receiver }]),
    ...["Element#innerHTML", "ShadowRoot#innerHTML"].map((key) => property(key,
      [dom("NodeRead"), dom("AttributeRead"), dom("TextRead")],
      [dom("Parse"), dom("NodeWrite"), { kind: "mutate", target: receiver }, { kind: "invoke-user-code" }],
    )),
    property("Element#outerHTML",
      [dom("NodeRead"), dom("AttributeRead"), dom("TextRead")],
      [dom("Parse", parent), dom("NodeWrite", parent), { kind: "mutate", target: receiver }, { kind: "mutate", target: parent }, { kind: "invoke-user-code" }],
    ),
    ...[
      "Element#clientHeight", "Element#clientLeft", "Element#clientTop", "Element#clientWidth",
      "Element#scrollHeight", "Element#scrollWidth", "HTMLElement#offsetHeight", "HTMLElement#offsetWidth",
    ].map((key) => property(key, [dom("LayoutRead")])),
    property("HTMLInputElement#value", [dom("PropertyRead")], [dom("PropertyWrite"), { kind: "mutate", target: receiver }]),
    ...["src", "integrity", "crossOrigin", "type", "async", "defer", "referrerPolicy", "nonce"]
      .map((name) => property(`HTMLScriptElement#${name}`, [dom("PropertyRead")], [dom("PropertyWrite"), { kind: "mutate", target: receiver }])),
  ];
}

export const builtinSemanticCatalog: BuiltinSemanticCatalog = {
  schema: "uneffect-builtin-semantics/v1",
  definitions: [
    ...(["map", "flatMap", "filter", "forEach", "every", "some", "find", "findIndex", "findLast", "findLastIndex", "reduce", "reduceRight"] as const)
      .flatMap((name) => ["Array", "ReadonlyArray"].map((owner) => reviewed("javascript", {
        symbol: { module: "lib.es", export: `${owner}#${name}` },
        semantics: inlineCallbackSemantics(0),
        trustReason: `ECMAScript ${owner}.${name} invokes its callback synchronously`, trustOwner: "@mizchi/uneffect",
      }))),
    ...(["slice", "join"] as const).flatMap((name) => ["Array", "ReadonlyArray"].map((owner) => reviewed("javascript", {
      symbol: { module: "lib.es", export: `${owner}#${name}` },
      trustReason: `ECMAScript ${owner}.${name} has no callback or host authority`, trustOwner: "@mizchi/uneffect",
    }))),
    ...(["Array", "ReadonlyArray"] as const).map((owner) => reviewed("javascript", {
      symbol: { module: "lib.es", export: `${owner}#toSorted` },
      semantics: { schema: "uneffect-semantic-primitives/v1", primitives: [...inlineCallbackSemantics(0, true).primitives, { kind: "result", refinement: { kind: "fresh" } }] },
      trustReason: `ECMAScript ${owner}.toSorted returns a fresh Array and invokes its optional comparator synchronously`, trustOwner: "@mizchi/uneffect",
    })),
    reviewed("javascript", {
      symbol: { module: "lib.es", export: "Array#sort" },
      semantics: { schema: "uneffect-semantic-primitives/v1", primitives: [
        ...inlineCallbackSemantics(0, true).primitives,
        { kind: "mutate", target: { kind: "receiver" } },
      ] },
      trustReason: "ECMAScript Array.sort mutates its receiver and invokes its optional comparator synchronously", trustOwner: "@mizchi/uneffect",
    }),
    ...(["keys", "entries"] as const).map((name) => reviewed("javascript", {
      symbol: { module: "lib.es", export: `ObjectConstructor#${name}` }, semantics: { schema: "uneffect-semantic-primitives/v1", primitives: [{ kind: "result", refinement: { kind: "fresh" } }] },
      trustReason: `ECMAScript Object.${name} returns a newly allocated Array`, trustOwner: "@mizchi/uneffect",
    })),
    reviewed("javascript", {
      symbol: { module: "lib.es", export: "ArrayConstructor#from" },
      semantics: inlineCallbackSemantics(1, true),
      trustReason: "ECMAScript Array.from invokes its optional mapping callback synchronously", trustOwner: "@mizchi/uneffect",
    }),
    reviewed("javascript", {
      symbol: { module: "lib.es", export: "JSON#stringify" },
      semantics: inlineCallbackSemantics(1, true),
      trustReason: "ECMAScript JSON.stringify invokes a callable replacer synchronously", trustOwner: "@mizchi/uneffect",
    }),
    ...(["then", "catch", "finally"] as const).map((name) => reviewed("javascript", {
      symbol: { module: "lib.es", export: `Promise#${name}` },
      semantics: { schema: "uneffect-semantic-primitives/v1", primitives: [
        ...(name === "then" ? [0, 1] : [0]).map((index) => ({
          kind: "callback" as const, target: { kind: "argument" as const, index }, timing: "deferred" as const,
          queue: "microtask" as const, cardinality: "0..1" as const, callable: "optional" as const,
        })),
        { kind: "protocol" as const, name: "promise-handler", transition: name },
      ] },
      trustReason: `ECMAScript Promise.${name} schedules callable handlers as microtasks`, trustOwner: "@mizchi/uneffect",
    })),
    ...(["all", "allSettled", "race", "any"] as const).map((combinator) => reviewed("javascript", {
      symbol: { module: "lib.es", export: `PromiseConstructor#${combinator}` },
      semantics: { schema: "uneffect-semantic-primitives/v1", primitives: [{
        kind: "protocol", name: "promise-combinator", transition: combinator,
        inputs: { iterable: { kind: "argument", index: 0 } },
      }] },
    })),
    reviewed("javascript", { symbol: { module: "global", export: "Math.random" }, semantics: effectSemantics("Random") }),
    reviewed("node", { symbol: { module: "node:module", export: "createRequire" }, trustReason: "Node createRequire constructs a resolver without loading a target", trustOwner: "@mizchi/uneffect" }),
    reviewed("node", { symbol: { module: "node:path", export: "join" }, trustReason: "Node path.join is a deterministic lexical path operation", trustOwner: "@mizchi/uneffect" }),
    reviewed("node", { symbol: { module: "lib.node", export: "Process#cwd" }, trustReason: "Node process.cwd reads launch configuration without a Deno-style permission", trustOwner: "@mizchi/uneffect" }),
    ...nodeFsDefinitions("node:fs"),
    ...nodeFsDefinitions("node:fs/promises"),
    reviewed("node", { symbol: { module: "node:os", export: "tmpdir" }, semantics: { schema: "uneffect-semantic-primitives/v1", primitives: [{ kind: "result", refinement: { kind: "path", pattern: "$TEMP" } }] } }),
    ...([ ["hostname", "Sys<hostname>"], ["release", "Sys<osRelease>"], ["uptime", "Sys<osUptime>"], ["loadavg", "Sys<loadavg>"], ["networkInterfaces", "Sys<networkInterfaces>"], ["totalmem", "Sys<systemMemoryInfo>"], ["freemem", "Sys<systemMemoryInfo>"], ["cpus", "Sys<cpus>"], ["availableParallelism", "Sys<cpus>"], ["homedir", "Sys<homedir>"], ["userInfo", "Sys<username | uid | gid | homedir>"] ] as const)
      .map(([name, effect]) => reviewed("node", { symbol: { module: "node:os", export: name }, semantics: effectSemantics(effect) })),
    ...["randomBytes", "randomFill", "randomInt"].map((name) => reviewed("node", {
      symbol: { module: "node:crypto", export: name },
      semantics: effectSemantics("Random", { callbackFromEnd: 1, minimumArguments: 2, queue: "poll" }),
    })),
    ...["randomFillSync", "randomUUID"].map((name) => reviewed("node", {
      symbol: { module: "node:crypto", export: name }, semantics: effectSemantics("Random"),
    })),
    reviewed("node", {
      symbol: { module: "node:child_process", export: "exec" },
      semantics: effectSemantics("Run", { callbackFromEnd: 1, minimumArguments: 2, queue: "poll" }),
    }),
    reviewed("node", {
      symbol: { module: "node:child_process", export: "execFile" },
      semantics: effectSemantics("Run", {
        callbackFromEnd: 1, minimumArguments: 2, queue: "poll",
        scope: { kind: "run-program", target: { kind: "argument", index: 0 } },
      }),
    }),
    ...["execFileSync", "spawn", "spawnSync"].map((name) => reviewed("node", {
      symbol: { module: "node:child_process", export: name },
      semantics: effectSemantics("Run", { scope: { kind: "run-program", target: { kind: "argument", index: 0 } } }),
    })),
    ...["execSync", "fork"].map((name) => reviewed("node", {
      symbol: { module: "node:child_process", export: name }, semantics: effectSemantics("Run"),
    })),
    reviewed("node", { symbol: { module: "node:fs", export: "FSWatcher#close" }, semantics: { schema: "uneffect-semantic-primitives/v1", primitives: [
      { kind: "release", resource: "watcher", target: { kind: "receiver" } },
      { kind: "protocol", name: "watcher", transition: "cancel", inputs: { handle: { kind: "receiver" } } },
    ] } }),
    reviewed("node", { symbol: { module: "node:net", export: "Server#close" }, semantics: deferredNetworkSemantics({ callbackMinimumArguments: 1, queue: "close", releaseReceiver: "server", protocol: { name: "server", transition: "close" } }) }),
    reviewed("node", { symbol: { module: "node:net", export: "Server#listen" }, semantics: deferredNetworkSemantics({ callbackMinimumArguments: 2, queue: "next-tick", scope: { kind: "network", format: "connect", target: { kind: "argument", index: 0 }, hostArgument: 1 }, protocol: { name: "server", transition: "listen" } }) }),
    ...["connect", "createConnection"].map((name) => reviewed("node", { symbol: { module: "node:net", export: name }, semantics: deferredNetworkSemantics({ callbackMinimumArguments: 2, scope: { kind: "network", format: "connect", target: { kind: "argument", index: 0 }, hostArgument: 1 } }) })),
    reviewed("node", { symbol: { module: "node:net", export: "Socket#connect" }, semantics: deferredNetworkSemantics({ callbackMinimumArguments: 2, scope: { kind: "network", format: "connect", target: { kind: "argument", index: 0 }, hostArgument: 1 } }) }),
    reviewed("node", { symbol: { module: "node:dns", export: "lookup" }, semantics: deferredNetworkSemantics({ callbackMinimumArguments: 2, scope: { kind: "network", format: "host", target: { kind: "argument", index: 0 } } }) }),
    reviewed("node", { symbol: { module: "node:dns", export: "lookupService" }, semantics: deferredNetworkSemantics({ effect: true, callbackMinimumArguments: 3 }) }),
    ...(["node:net", "node:http", "node:https"] as const).map((module) => reviewed("node", { symbol: { module, export: "createServer" }, semantics: deferredNetworkSemantics({ callbackMinimumArguments: 1, callbackCardinality: "0..n", resultResource: "server", protocol: { name: "server", transition: "create" } }) })),
    ...(["node:http", "node:https"] as const).flatMap((module) => ["request", "get"].map((name) => reviewed("node", { symbol: { module, export: name }, semantics: deferredNetworkSemantics({ callbackMinimumArguments: 2, scope: { kind: "network", format: "http-request", target: { kind: "argument", index: 0 }, defaultPort: module === "node:https" ? 443 : 80 } }) }))),
    reviewed("node", { symbol: { module: "lib.node", export: "Process#nextTick" }, semantics: timerSemantics("next-tick", false) }),
    reviewed("node", { symbol: { module: "node:tty", export: "WriteStream#write" }, semantics: effectSemantics("Console") }),
    reviewed("node", { symbol: { module: "node:timers", export: "setImmediate" }, semantics: timerSemantics("check", false) }),
    reviewed("node", { symbol: { module: "node:timers", export: "clearImmediate" }, semantics: { schema: "uneffect-semantic-primitives/v1", primitives: [
      { kind: "effect", capability: "Timer" }, { kind: "protocol", name: "immediate", transition: "cancel", inputs: { handle: { kind: "argument", index: 0 } } },
    ] } }),
    reviewed("dom", { symbol: { module: "global", export: "fetch" }, semantics: { schema: "uneffect-semantic-primitives/v1", primitives: [
      { kind: "effect", capability: "Fetch", scope: { kind: "url", target: { kind: "argument", index: 0 }, methodArgument: 1, methodFrom: "request-init" } },
      { kind: "effect", capability: "Net", scope: { kind: "network", format: "http-request", target: { kind: "argument", index: 0 } } },
      { kind: "protocol", name: "fetch", transition: "start", inputs: {
        input: { kind: "argument", index: 0 }, options: { kind: "argument", index: 1, optional: true },
      } },
    ] } }),
    ...["log", "info", "warn", "error", "debug", "trace", "dir", "table"].map((name) => reviewed("javascript", {
      symbol: { module: "global", export: `console.${name}` },
      semantics: { schema: "uneffect-semantic-primitives/v1", primitives: [{ kind: "effect", capability: "Console" }] },
      trustReason: `reviewed Console ${name} semantic overlay`, trustOwner: "@mizchi/uneffect",
    })),
    reviewed("dom", { symbol: { module: "global", export: "setTimeout" }, semantics: timerSemantics("timer", false, 1) }),
    reviewed("dom", { symbol: { module: "global", export: "setInterval" }, semantics: timerSemantics("timer", true, 1) }),
    reviewed("dom", { symbol: { module: "global", export: "queueMicrotask" }, semantics: timerSemantics("microtask", false) }),
    reviewed("node", { symbol: { module: "global", export: "setImmediate" }, semantics: timerSemantics("check", false) }),
    reviewed("dom", { symbol: { module: "global", export: "requestAnimationFrame" }, semantics: timerSemantics("animation-frame", false) }),
    reviewed("dom", { symbol: { module: "global", export: "cancelAnimationFrame" }, semantics: { schema: "uneffect-semantic-primitives/v1", primitives: [
      { kind: "effect", capability: "Timer" }, { kind: "protocol", name: "animation-frame", transition: "cancel", inputs: { handle: { kind: "argument", index: 0 } } },
    ] } }),
    ...(["clearTimeout", "clearInterval"] as const).map((name) => reviewed("dom", { symbol: { module: "global", export: name }, semantics: { schema: "uneffect-semantic-primitives/v1", primitives: [
      { kind: "effect", capability: "Timer" }, { kind: "protocol", name: "timeout", transition: "cancel", inputs: { handle: { kind: "argument", index: 0 } } },
    ] } })),
    reviewed("node", { symbol: { module: "global", export: "clearImmediate" }, semantics: { schema: "uneffect-semantic-primitives/v1", primitives: [
      { kind: "effect", capability: "Timer" }, { kind: "protocol", name: "immediate", transition: "cancel", inputs: { handle: { kind: "argument", index: 0 } } },
    ] } }),
    reviewed("dom", { symbol: { module: "global", export: "AbortSignal.timeout" }, semantics: { schema: "uneffect-semantic-primitives/v1", primitives: [
      { kind: "effect", capability: "Timer" },
      { kind: "protocol", name: "abort-signal", transition: "timeout", inputs: { delay: { kind: "argument", index: 0 } } },
    ] } }),
    reviewed("dom", { symbol: { module: "global", export: "AbortSignal.abort" }, semantics: { schema: "uneffect-semantic-primitives/v1", primitives: [
      { kind: "protocol", name: "abort-signal", transition: "abort", inputs: { reason: { kind: "argument", index: 0, optional: true } } },
    ] } }),
    reviewed("dom", { symbol: { module: "global", export: "AbortSignal.any" }, semantics: { schema: "uneffect-semantic-primitives/v1", primitives: [
      { kind: "protocol", name: "abort-signal", transition: "any", inputs: { signals: { kind: "argument", index: 0 } } },
    ] } }),
    reviewed("dom", { symbol: { module: "lib.dom", export: "AbortController#abort" }, semantics: { schema: "uneffect-semantic-primitives/v1", primitives: [
      { kind: "protocol", name: "abort-controller", transition: "abort", inputs: {
        controller: { kind: "receiver" }, reason: { kind: "argument", index: 0, optional: true },
      } },
    ] } }),
    reviewed("dom", { symbol: { module: "lib.dom", export: "Scheduler#postTask" }, semantics: { schema: "uneffect-semantic-primitives/v1", primitives: [
      { kind: "effect", capability: "Timer" },
      { kind: "callback", target: { kind: "argument", index: 0 }, timing: "deferred", queue: "scheduler-task", cardinality: "0..1", callable: "required" },
      { kind: "protocol", name: "scheduler", transition: "post-task", inputs: { options: { kind: "argument", index: 1, optional: true } } },
    ] } }),
    reviewed("dom", { symbol: { module: "lib.dom", export: "Scheduler#yield" }, semantics: { schema: "uneffect-semantic-primitives/v1", primitives: [
      { kind: "effect", capability: "Timer" }, { kind: "protocol", name: "scheduler", transition: "yield" },
    ] } }),
    reviewed("dom", { symbol: { module: "global", export: "crypto.randomUUID" }, semantics: effectSemantics("Random") }),
    ...["getRandomValues", "randomUUID"].map((name) => reviewed("dom", { symbol: { module: "lib.dom", export: `Crypto#${name}` }, semantics: effectSemantics("Random") })),
    ...["Worker#postMessage", "MessagePort#postMessage"].map((name) => reviewed("dom", { symbol: { module: "lib.dom", export: name }, semantics: { schema: "uneffect-semantic-primitives/v1", primitives: [
      { kind: "clone", target: { kind: "argument", index: 0 } },
      { kind: "transfer", target: { kind: "argument", index: 1 }, optional: true },
    ] } })),
    ...domMethodDefinitions(),
    ...domPropertyDefinitions(),
    reviewed("dom", { symbol: { module: "lib.dom", export: "Document#cookie" }, semantics: { schema: "uneffect-semantic-primitives/v1", primitives: [{ kind: "property", read: [{ kind: "effect", capability: "CookieRead" }], write: [{ kind: "effect", capability: "CookieWrite" }] }] } }),
    reviewed("dom", { symbol: { module: "lib.dom", export: "Storage#length" }, semantics: { schema: "uneffect-semantic-primitives/v1", primitives: [{ kind: "property", read: [{ kind: "effect", capability: "LocalStorageRead" }], write: [] }] } }),
    ...["getItem", "key"].map((name) => reviewed("dom", { symbol: { module: "lib.dom", export: `Storage#${name}` }, semantics: effectSemantics("LocalStorageRead") })),
    ...["setItem", "removeItem", "clear"].map((name) => reviewed("dom", { symbol: { module: "lib.dom", export: `Storage#${name}` }, semantics: effectSemantics("LocalStorageWrite") })),
    reviewed("dom", { symbol: { module: "global", export: "structuredClone" }, semantics: { schema: "uneffect-semantic-primitives/v1", primitives: [
      { kind: "clone", target: { kind: "argument", index: 0 } },
      { kind: "transfer", target: { kind: "property", target: { kind: "argument", index: 1 }, key: "transfer" }, optional: true },
    ] } }),
    ...(["ReadableStreamDefaultReader", "ReadableStreamBYOBReader"] as const).map((owner) => reviewed("dom", {
      symbol: { module: "lib.dom", export: `${owner}#releaseLock` }, semantics: { schema: "uneffect-semantic-primitives/v1", primitives: [
        { kind: "release", resource: "stream-reader", target: { kind: "receiver" } },
        { kind: "protocol", name: "stream", transition: "release-readable", inputs: { reader: { kind: "receiver" } } },
      ] },
    })),
    reviewed("dom", { symbol: { module: "lib.dom", export: "ReadableStream#getReader" }, semantics: { schema: "uneffect-semantic-primitives/v1", primitives: [
      { kind: "result", refinement: { kind: "resource", family: "stream-reader" } },
      { kind: "acquire", resource: "stream-reader", target: { kind: "result" } },
      { kind: "protocol", name: "stream", transition: "lock-readable", inputs: { stream: { kind: "receiver" } } },
    ] } }),
    reviewed("dom", { symbol: { module: "lib.dom", export: "WritableStream#getWriter" }, semantics: { schema: "uneffect-semantic-primitives/v1", primitives: [
      { kind: "result", refinement: { kind: "resource", family: "stream-writer" } },
      { kind: "acquire", resource: "stream-writer", target: { kind: "result" } },
      { kind: "protocol", name: "stream", transition: "lock-writable", inputs: { stream: { kind: "receiver" } } },
    ] } }),
    reviewed("dom", { symbol: { module: "lib.dom", export: "WritableStreamDefaultWriter#releaseLock" }, semantics: { schema: "uneffect-semantic-primitives/v1", primitives: [
      { kind: "release", resource: "stream-writer", target: { kind: "receiver" } },
      { kind: "protocol", name: "stream", transition: "release-writable", inputs: { writer: { kind: "receiver" } } },
    ] } }),
    ...(["cancel", "pipeTo", "pipeThrough", "tee"] as const).map((name) => reviewed("dom", {
      symbol: { module: "lib.dom", export: `ReadableStream#${name}` }, semantics: { schema: "uneffect-semantic-primitives/v1", primitives: [
        { kind: "protocol", name: "stream", transition: name, inputs: {
          stream: { kind: "receiver" },
          ...(name === "pipeTo" || name === "pipeThrough" ? { destination: { kind: "argument", index: 0 } as const } : {}),
        } },
        ...(name === "pipeTo" || name === "pipeThrough" ? [{ kind: "invoke-user-code" as const }] : []),
      ] },
    })),
    ...(["abort", "close"] as const).map((name) => reviewed("dom", {
      symbol: { module: "lib.dom", export: `WritableStream#${name}` }, semantics: { schema: "uneffect-semantic-primitives/v1", primitives: [
        { kind: "protocol", name: "stream", transition: name, inputs: { stream: { kind: "receiver" } } },
      ] },
    })),
    ...(["DisposableStack", "AsyncDisposableStack"] as const).flatMap((owner) => [
      reviewed("javascript", { symbol: { module: "lib.es", export: `${owner}#use` }, semantics: { schema: "uneffect-semantic-primitives/v1", primitives: [
        { kind: "result", refinement: { kind: "alias", target: { kind: "argument", index: 0 } } },
        { kind: "protocol", name: "disposal-stack", transition: "register", inputs: { stack: { kind: "receiver" }, resource: { kind: "argument", index: 0 } } },
      ] } }),
      reviewed("javascript", { symbol: { module: "lib.es", export: `${owner}#adopt` }, semantics: { schema: "uneffect-semantic-primitives/v1", primitives: [
        { kind: "callback", target: { kind: "argument", index: 1 }, timing: "deferred", queue: owner === "AsyncDisposableStack" ? "microtask" : "current", cardinality: "0..1", callable: "required" },
        { kind: "result", refinement: { kind: "alias", target: { kind: "argument", index: 0 } } },
        { kind: "protocol", name: "disposal-stack", transition: "register", inputs: { stack: { kind: "receiver" }, resource: { kind: "argument", index: 0 } } },
      ] } }),
      reviewed("javascript", { symbol: { module: "lib.es", export: `${owner}#defer` }, semantics: { schema: "uneffect-semantic-primitives/v1", primitives: [
        { kind: "callback", target: { kind: "argument", index: 0 }, timing: "deferred", queue: owner === "AsyncDisposableStack" ? "microtask" : "current", cardinality: "0..1", callable: "required" },
        { kind: "protocol", name: "disposal-stack", transition: "register", inputs: { stack: { kind: "receiver" } } },
      ] } }),
      reviewed("javascript", { symbol: { module: "lib.es", export: `${owner}#move` }, semantics: { schema: "uneffect-semantic-primitives/v1", primitives: [
        { kind: "result", refinement: { kind: "resource", family: "disposal-stack" } },
        { kind: "release", resource: "disposal-stack", target: { kind: "receiver" } },
        { kind: "acquire", resource: "disposal-stack", target: { kind: "result" } },
        { kind: "protocol", name: "disposal-stack", transition: "move", inputs: { stack: { kind: "receiver" } } },
      ] } }),
      reviewed("javascript", { symbol: { module: "lib.es", export: `${owner}#${owner === "AsyncDisposableStack" ? "disposeAsync" : "dispose"}` }, semantics: { schema: "uneffect-semantic-primitives/v1", primitives: [
        { kind: "release", resource: "disposal-stack", target: { kind: "receiver" } }, { kind: "invoke-user-code" },
        { kind: "protocol", name: "disposal-stack", transition: "dispose", inputs: { stack: { kind: "receiver" } } },
      ] } }),
    ]),
    ...["Array#copyWithin", "Array#fill", "Array#pop", "Array#push", "Array#reverse", "Array#shift", "Array#splice", "Array#unshift", "Map#clear", "Map#delete", "Map#set", "Set#add", "Set#clear", "Set#delete"].map((name) => reviewed("javascript", {
      symbol: { module: "lib.es", export: name },
      semantics: { schema: "uneffect-semantic-primitives/v1", primitives: [{ kind: "mutate", target: { kind: "receiver" } }] },
    })),
    reviewed("package", {
      symbol: { module: "corsa-oxlint", export: "OxlintUtils#RuleCreator" },
      runtime: { kind: "package", version: "1.12.4" },
      callableResult: { capturedCallbackArguments: [0] },
      trustReason: "Corsa 1.12.4 RuleCreator returns a synchronous decorator that invokes its captured URL creator",
      trustOwner: "@mizchi/uneffect",
    }),
    reviewed("package", {
      symbol: { module: "corsa-oxlint", export: "definePlugin" },
      runtime: { kind: "package", version: "1.12.4" },
      trustReason: "Corsa 1.12.4 definePlugin constructs plugin metadata without executing rule code",
      trustOwner: "@mizchi/uneffect",
    }),
    reviewed("package", {
      symbol: { module: "effect", export: "Effect#catchAll" }, runtime: { kind: "package", version: "3.22.1" },
      semantics: { schema: "uneffect-semantic-primitives/v1", primitives: [{
        kind: "callback", target: { kind: "argument-from-end", offset: 1 }, timing: "deferred", queue: "current", cardinality: "0..1", callable: "required",
      }] },
      trustReason: "Effect 3.22.1 catchAll defers its handler until the Effect is executed", trustOwner: "@mizchi/uneffect",
    }),
    ...(["pipe", "number", "safeInteger", "brand", "minValue", "maxValue", "finite"] as const).map((name) => reviewed("package", {
      symbol: { module: "valibot", export: name }, runtime: { kind: "package", version: "1.4.2" },
      trustReason: `Valibot 1.4.2 ${name} constructs schema metadata without executing validation`, trustOwner: "@mizchi/uneffect",
    })),
    reviewed("package", {
      symbol: { module: "typescript", export: "Program#emit" }, runtime: { kind: "package", version: "6.0.3" },
      semantics: { schema: "uneffect-semantic-primitives/v1", primitives: [{ kind: "callback", target: { kind: "argument", index: 1 }, timing: "sync", queue: "current", cardinality: "0..1", callable: "optional" }] },
      trustReason: "TypeScript Program.emit invokes writeFile during the synchronous emit operation", trustOwner: "@mizchi/uneffect",
    }),
    ...([
      ["Node#forEachChild", [0, 1], [1]], ["forEachChild", [1, 2], [2]],
      ["visitNode", [1]], ["visitEachChild", [1]],
    ] as const).map(([name, callbackArguments, optionalCallbackArguments]) => reviewed("package", {
      symbol: { module: "typescript", export: name }, runtime: { kind: "package", version: "6.0.3" },
      semantics: { schema: "uneffect-semantic-primitives/v1", primitives: callbackArguments.map((index) => ({
        kind: "callback" as const, target: { kind: "argument" as const, index }, timing: "sync" as const, queue: "current" as const, cardinality: "0..n" as const,
        ...((optionalCallbackArguments as readonly number[] | undefined)?.includes(index) ? { callable: "optional" as const } : { callable: "required" as const }),
      })) },
      trustReason: `TypeScript 6.0.3 ${name} invokes its visitor callbacks synchronously`, trustOwner: "@mizchi/uneffect",
    })),
    reviewed("package", {
      symbol: { module: "typescript", export: "transform" }, runtime: { kind: "package", version: "6.0.3" },
      semantics: { schema: "uneffect-semantic-primitives/v1", primitives: [{
        kind: "callback", target: { kind: "array-elements", target: { kind: "argument", index: 1 } },
        timing: "sync", queue: "current", cardinality: "0..n", callable: "required", returnDepth: 1,
      }] },
      trustReason: "TypeScript 6.0.3 transform synchronously invokes each array-literal TransformerFactory and its returned Transformer", trustOwner: "@mizchi/uneffect",
    }),
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
  return definitions.map(({ platform: _platform, stability: _stability, ...definition }) => {
    if (definition.semantics !== undefined) validateBuiltinSemantics(definition.semantics);
    return { ...definition, evidence: "trusted" };
  });
}
