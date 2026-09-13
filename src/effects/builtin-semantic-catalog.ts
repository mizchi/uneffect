import type { BuiltinContract } from "./builtin-contracts.js";
import { validateBuiltinSemantics } from "./builtin-semantic-schema.js";
import type { BuiltinSemantics, CallbackCardinality, CallbackQueue, ScopeProjector, SemanticPrimitive, ValueProjector } from "./builtin-semantic-schema.js";

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
  callback?: { index: number; timing: "sync" | "deferred"; queue: CallbackQueue; cardinality: CallbackCardinality };
}

const reviewed = (platform: BuiltinSemanticPlatform, definition: Omit<ReviewedBuiltinSemantic, "platform" | "stability">): ReviewedBuiltinSemantic =>
  ({ ...definition, platform, stability: "reviewed" });

const inlineCallbackSemantics = (
  index: number,
  optional = false,
  invocationArguments: readonly ValueProjector[] = [],
  thisArgument?: ValueProjector,
): BuiltinSemantics => ({
  schema: "uneffect-semantic-primitives/v1",
  primitives: [{
    kind: "callback", target: { kind: "argument", index }, timing: "sync", queue: "current",
    cardinality: "0..n", callable: optional ? "optional" : "required",
    ...(invocationArguments.length > 0 ? { invocationArguments } : {}),
    ...(thisArgument ? { thisArgument } : {}),
  }],
});

const runtimeValue = (role: string): ValueProjector => ({ kind: "runtime-value", role });
const receiverValue: ValueProjector = { kind: "receiver" };
const optionalArgument = (index: number): ValueProjector => ({ kind: "argument", index, optional: true });
const typedArrayOwners = [
  "Int8Array", "Uint8Array", "Uint8ClampedArray", "Int16Array", "Uint16Array", "Int32Array", "Uint32Array",
  "Float32Array", "Float64Array", "BigInt64Array", "BigUint64Array",
] as const;

const timerSemantics = (
  queue: CallbackQueue,
  repeats: boolean,
  delayArgument?: number,
  invocationArguments?: readonly ValueProjector[],
  invocationRestFrom?: number,
): BuiltinSemantics => ({
  schema: "uneffect-semantic-primitives/v1",
  primitives: [
    { kind: "effect", capability: "Timer" },
    {
      kind: "callback", target: { kind: "argument", index: 0 }, timing: "deferred", queue,
      cardinality: repeats ? "0..n" : "0..1", callable: "required",
      ...(invocationArguments ? { invocationArguments } : {}),
      ...(invocationRestFrom === undefined ? {} : { invocationRestArguments: { from: invocationRestFrom } }),
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
  useReceiver?: string;
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
    ...(options.useReceiver ? [{ kind: "use" as const, resource: options.useReceiver, target: { kind: "receiver" as const } }] : []),
    ...(options.releaseReceiver ? [{ kind: "release" as const, resource: options.releaseReceiver, target: { kind: "receiver" as const } }] : []),
    ...(options.protocol ? [{ kind: "protocol" as const, name: options.protocol.name, transition: options.protocol.transition }] : []),
  ],
});

const fsReadNames = ["access", "accessSync", "exists", "existsSync", "readFile", "readFileSync", "readdir", "readdirSync", "readlink", "readlinkSync", "realpath", "realpathSync", "stat", "statSync", "lstat", "lstatSync", "open", "openSync", "watch", "watchFile", "createReadStream"] as const;
const fsWriteNames = ["appendFile", "appendFileSync", "chmod", "chmodSync", "chown", "chownSync", "link", "linkSync", "mkdir", "mkdirSync", "rename", "renameSync", "rm", "rmSync", "rmdir", "rmdirSync", "symlink", "symlinkSync", "truncate", "truncateSync", "unlink", "unlinkSync", "utimes", "utimesSync", "writeFile", "writeFileSync", "createWriteStream"] as const;
const openReadFlags = ["r", "rs", "sr", "r+", "rs+", "sr+", "w+", "wx+", "xw+", "a+", "ax+", "xa+", "as+"] as const;
const openWriteFlags = ["r+", "rs+", "sr+", "w", "wx", "xw", "w+", "wx+", "xw+", "a", "ax", "xa", "a+", "ax+", "xa+", "as", "as+"] as const;

function nodeFsDefinitions(module: "node:fs" | "node:fs/promises"): ReviewedBuiltinSemantic[] {
  const callbacks = new Set(["access", "exists", "readFile", "readdir", "readlink", "realpath", "stat", "lstat", "open", "appendFile", "chmod", "chown", "link", "mkdir", "rename", "rm", "rmdir", "symlink", "truncate", "unlink", "utimes", "writeFile", "copyFile", "cp", "read", "write"]);
  const semantics = (name: string, options: {
    read?: boolean; write?: boolean; readPathArgument?: number; writePathArgument?: number; mutateArgument?: number;
  }): BuiltinSemantics => {
    const primitives: SemanticPrimitive[] = [];
    const openLike = name === "open" || name === "openSync";
    if (options.read) primitives.push({
      kind: "effect", capability: "FsRead",
      ...(options.readPathArgument === undefined ? {} : { scope: { kind: "filesystem-path", target: { kind: "argument", index: options.readPathArgument } } }),
      ...(openLike ? { when: { kind: "argument-literal-in", index: 1, values: openReadFlags } as const } : {}),
    });
    if (options.write) primitives.push({
      kind: "effect", capability: "FsWrite",
      ...(options.writePathArgument === undefined ? {} : { scope: { kind: "filesystem-path", target: { kind: "argument", index: options.writePathArgument } } }),
      ...(openLike ? { when: { kind: "argument-literal-in", index: 1, values: openWriteFlags } as const } : {}),
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
    if (module === "node:fs/promises" && name === "open") {
      primitives.push({ kind: "result", refinement: { kind: "resource", family: "file-handle" } });
      primitives.push({ kind: "acquire", resource: "file-handle", target: { kind: "result" }, completion: "fulfillment" });
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
    ...reads.map((name) => reviewed("node", { symbol: { module, export: name }, semantics: semantics(name, { read: true, write: name === "open" || name === "openSync", readPathArgument: 0, writePathArgument: 0 }) })),
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
    // `Document#createElement` is published by `browserPlatformDefinitions` with the custom-element constructor
    // it runs and the names it rejects; `createTextNode` validates nothing and reaches no user code.
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
    ["EventTarget#addEventListener", dom("Listen", { mutatesReceiver: true, invokesUserCode: true,
      callback: { index: 1, timing: "deferred", queue: "external", cardinality: "0..n" } })],
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
    if (operation.callback) primitives.push({ kind: "callback", target: { kind: "argument", index: operation.callback.index },
      timing: operation.callback.timing, queue: operation.callback.queue, cardinality: operation.callback.cardinality, callable: "required",
      ...(key === "EventTarget#addEventListener" ? {
        once: { kind: "property", target: { kind: "argument", index: 2, optional: true }, key: "once" } as const,
        abortSignal: { kind: "property", target: { kind: "argument", index: 2, optional: true }, key: "signal" } as const,
        invocationArguments: [runtimeValue("event")],
        thisArgument: receiver,
      } : {}) });
    if (key === "EventTarget#addEventListener" || key === "EventTarget#removeEventListener") primitives.push({
      kind: "protocol", name: "event-listener", transition: key.endsWith("#addEventListener") ? "register" : "unregister",
      inputs: {
        target: receiver,
        type: { kind: "argument", index: 0 },
        callback: { kind: "argument", index: 1 },
        options: { kind: "argument", index: 2, optional: true },
      },
    });
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

/**
 * Browser platform surfaces whose members the analysis meets constantly in page code. Each entry states what
 * the relevant specification requires of the member, not what an implementation happens to do.
 */
function browserPlatformDefinitions(): ReviewedBuiltinSemantic[] {
  const receiver: ValueProjector = { kind: "receiver" };
  const dom = (member: DomOperation, target: ValueProjector = receiver): SemanticPrimitive => ({
    kind: "effect", capability: "Dom", scope: { kind: "region", member, target },
  });
  const throws = (error: string): SemanticPrimitive => ({ kind: "throw", error });
  const entry = (key: string, primitives: readonly SemanticPrimitive[], reason: string): ReviewedBuiltinSemantic => reviewed("dom", {
    symbol: { module: "lib.dom", export: key },
    semantics: { schema: "uneffect-semantic-primitives/v1", primitives: [...primitives] },
    trustReason: reason, trustOwner: "@mizchi/uneffect",
  });
  const property = (
    key: string,
    read: readonly SemanticPrimitive[],
    write: readonly SemanticPrimitive[],
    reason: string,
  ): ReviewedBuiltinSemantic => entry(key, [{ kind: "property", read: [...read], write: [...write] }], reason);
  /**
   * A surface every member of which reads or writes the same region, where enumerating members is not possible
   * because the interface's named properties are open-ended. Reading is a plain region read; writing runs the
   * element's custom-element reactions and validates its input, and a call may do either, so a call carries the
   * write side. The claim must stay an upper bound for members a later library revision adds.
   */
  const wholeSurface = (owner: string, read: DomOperation, write: DomOperation, reason: string): ReviewedBuiltinSemantic => entry(
    `${owner}#*`,
    [
      // A call may read or write, so it carries the write side's capability but claims no mutation: a pure
      // query such as `contains` or `getPropertyValue` writes through nothing.
      dom(write), { kind: "invoke-user-code" }, throws("DOMException"),
      { kind: "property", read: [dom(read)], write: [dom(write), { kind: "mutate", target: receiver }, { kind: "invoke-user-code" }, throws("DOMException")] },
    ],
    reason,
  );
  const handlerProperties = [
    ["XMLHttpRequest", "onreadystatechange"],
    ...["onabort", "onerror", "onload", "onloadend", "onloadstart", "onprogress", "ontimeout"]
      .map((name) => ["XMLHttpRequestEventTarget", name] as const),
  ] as const;
  return [
    // --- XMLHttpRequest (XHR Living Standard) --------------------------------------------------------------
    entry("XMLHttpRequest#open", [
      { kind: "effect", capability: "Net" }, { kind: "invoke-user-code" },
      { kind: "mutate", target: receiver }, throws("DOMException"),
    ],
      "XHR open() terminates the fetch controller of a reused request, resets it, and fires readystatechange at the end, which runs registered handlers before it returns; it throws SyntaxError, SecurityError, InvalidStateError or InvalidAccessError"),
    entry("XMLHttpRequest#send", [
      { kind: "effect", capability: "Net" }, { kind: "invoke-user-code" },
      { kind: "mutate", target: receiver }, throws("DOMException"),
    ],
      "XHR send() runs the fetch the request describes and fires loadstart before returning; it throws InvalidStateError before open(), and in synchronous mode it throws TimeoutError, AbortError or NetworkError for an ordinary request failure"),
    entry("XMLHttpRequest#abort", [
      { kind: "effect", capability: "Net" }, { kind: "invoke-user-code" }, { kind: "mutate", target: receiver },
    ],
      "XHR abort() terminates the fetch controller, which is a no-op with none in flight, and fires abort and loadend events"),
    entry("XMLHttpRequest#setRequestHeader", [{ kind: "mutate", target: receiver }, throws("DOMException"), throws("TypeError")],
      "XHR setRequestHeader() throws InvalidStateError outside the opened state, SyntaxError on a name or value the standard rejects, and TypeError when either argument leaves the ByteString range Web IDL requires"),
    entry("XMLHttpRequest#overrideMimeType", [{ kind: "mutate", target: receiver }, throws("DOMException")],
      "XHR overrideMimeType() throws InvalidStateError in the loading or done state; an unparsable type is replaced with application/octet-stream rather than rejected"),
    entry("XMLHttpRequest#getResponseHeader", [throws("TypeError")],
      "XHR getResponseHeader() reads headers already received; Web IDL throws TypeError when the name leaves the ByteString range"),
    entry("XMLHttpRequest#getAllResponseHeaders", [],
      "XHR getAllResponseHeaders() takes no argument and reads headers already received"),
    property("XMLHttpRequest#responseText", [throws("DOMException")], [throws("TypeError")],
      "XHR responseText throws InvalidStateError unless the response type selects it; the attribute is readonly, so an assignment throws"),
    property("XMLHttpRequest#responseXML", [dom("Parse"), dom("Create"), throws("DOMException")], [throws("TypeError")],
      "XHR responseXML parses the received bytes into a new Document with scripting disabled, and throws InvalidStateError unless the response type selects it"),
    property("XMLHttpRequest#response", [dom("Parse"), dom("Create")], [throws("TypeError")],
      "XHR response deserialises the received bytes into a fresh ArrayBuffer, Blob, Document or JSON value; a failure is reported as the failure state rather than thrown"),
    ...["status", "statusText", "readyState", "responseURL"].map((name) => property(`XMLHttpRequest#${name}`, [], [throws("TypeError")],
      `XHR ${name} reports request state already held in the process; the attribute is readonly, so an assignment throws`)),
    property("XMLHttpRequest#upload", [{ kind: "result", refinement: { kind: "alias", target: receiver } }], [throws("TypeError")],
      "XHR upload is a SameObject attribute returning the request's own upload target; the attribute is readonly, so an assignment throws"),
    property("XMLHttpRequest#withCredentials", [], [throws("DOMException"), { kind: "mutate", target: receiver }],
      "XHR withCredentials throws InvalidStateError when set outside the unsent and opened states or after send()"),
    property("XMLHttpRequest#timeout", [], [throws("DOMException"), { kind: "mutate", target: receiver }],
      "XHR timeout throws InvalidAccessError when set on a synchronous request in a Window"),
    property("XMLHttpRequest#responseType", [], [throws("DOMException"), { kind: "mutate", target: receiver }],
      "XHR responseType throws InvalidStateError in the loading or done state and InvalidAccessError on a synchronous request in a Window"),
    ...handlerProperties.map(([owner, name]) => property(`${owner}#${name}`, [],
      [dom("Listen"), { kind: "mutate", target: receiver }, {
        kind: "callback", target: { kind: "assigned-value" }, timing: "deferred", queue: "external",
        cardinality: "0..n", callable: "optional", invocationArguments: [runtimeValue("event")], thisArgument: receiver,
      }],
      `Assigning ${name} registers the event handler the target runs later, so the assigned function's own effects are the assignment's`)),
    // --- style, dataset and class list ---------------------------------------------------------------------
    property("ElementCSSInlineStyle#style", [dom("PropertyRead")], [],
      "The style attribute exposes the element's inline declaration block; the reference itself is a read"),
    property("HTMLElement#dataset", [dom("AttributeRead")], [],
      "dataset exposes the element's data-* attributes; the reference itself is a read"),
    property("Element#classList", [dom("AttributeRead")], [],
      "classList exposes the element's class attribute; the reference itself is a read"),
    // Keyed on the base the shipped library actually declares: `CSSStyleDeclaration` extends `CSSStyleProperties`
    // extends `CSSStyleDeclarationBase` there, and the descriptor blocks extend the same base.
    wholeSurface("CSSStyleDeclarationBase", "PropertyRead", "PropertyWrite",
      "Every member of a CSS declaration block reads or writes that block. Writing through cssText, setProperty, removeProperty or any named property is [CEReactions] and throws NoModificationAllowedError when the block is read-only, which is how getComputedStyle returns it"),
    wholeSurface("DOMStringMap", "AttributeRead", "AttributeWrite",
      "Every member of a DOMStringMap is a data-* attribute of the owning element; the setter is [CEReactions] and throws SyntaxError or InvalidCharacterError on a name the standard rejects"),
    wholeSurface("DOMTokenList", "AttributeRead", "AttributeWrite",
      "Every member of a DOMTokenList reads or writes the reflected attribute it is bound to; add, remove, toggle and replace are [CEReactions] and throw SyntaxError on an empty token and InvalidCharacterError on whitespace"),
    // The iteration member the standard's `iterable<DOMString>` declaration generates runs its callback once per
    // token, synchronously; a member contract is selected before the whole-surface one.
    entry("DOMTokenList#forEach", [dom("AttributeRead"), ...inlineCallbackSemantics(0, false,
      [runtimeValue("token"), runtimeValue("token-index"), receiverValue], optionalArgument(1)).primitives],
      "DOMTokenList.forEach invokes its callback synchronously for each token"),
    entry("CSSStyleDeclarationBase#parentRule", [dom("PropertyRead")],
      "parentRule returns the owning CSS rule, a read that reaches the stylesheet the rule belongs to rather than this block"),
    // --- Document -------------------------------------------------------------------------------------------
    ...["head", "documentElement", "currentScript", "activeElement", "forms", "images", "scripts", "links"]
      .map((name) => property(`Document#${name}`, [dom("NodeRead")], [],
        `document.${name} reads the tree the document holds; a collection it returns is live, and its own members are not contracted here`)),
    property("Document#body", [dom("NodeRead")],
      [dom("NodeWrite"), { kind: "mutate", target: receiver }, { kind: "invoke-user-code" }, throws("DOMException")],
      "Assigning document.body replaces the existing body element or appends to the document element, runs custom element reactions before returning, and throws HierarchyRequestError for a value that is not a body or frameset"),
    // `scrollingElement` depends on the body's computed overflow in quirks mode, which is a layout question.
    property("Document#scrollingElement", [dom("LayoutRead")], [],
      "document.scrollingElement resolves against the body's box and computed overflow in quirks mode"),
    ...["readyState", "referrer", "URL", "characterSet", "contentType", "compatMode", "visibilityState", "hidden"]
      .map((name) => property(`Document#${name}`, [dom("PropertyRead")], [],
        `document.${name} reads document state the host maintains`)),
    property("Document#title", [dom("TextRead")],
      [dom("TextWrite"), dom("Create"), dom("NodeWrite"), { kind: "mutate", target: receiver }, { kind: "invoke-user-code" }],
      "Assigning document.title creates and inserts a title element when the document has none, and runs custom element reactions before returning"),
    ...["getElementsByTagName", "getElementsByTagNameNS", "getElementsByClassName", "getElementsByName"]
      .map((name) => entry(`Document#${name}`, [dom("NodeRead")],
        `document.${name}() returns a live collection over the tree the document holds; the collection's own members are not contracted here`)),
    ...["createDocumentFragment", "createComment", "createRange"]
      .map((name) => entry(`Document#${name}`, [dom("Create")],
        `document.${name}() creates a node the document owns, with no name to validate and no constructor to run`)),
    ...["createElement", "createElementNS"].map((name) => entry(`Document#${name}`,
      [dom("Create"), { kind: "invoke-user-code" }, throws("DOMException")],
      `document.${name}() constructs a registered custom element synchronously and throws InvalidCharacterError, NotSupportedError or NamespaceError for a name the standard rejects`)),
    ...["createEvent", "createAttribute"].map((name) => entry(`Document#${name}`, [dom("Create"), throws("DOMException")],
      `document.${name}() creates the object and throws for an argument the standard rejects`)),
    entry("Document#importNode", [dom("Create"), dom("NodeRead"), { kind: "invoke-user-code" }, throws("DOMException")],
      "document.importNode() reads the source tree, creates a copy the document owns, runs the copy's upgrade reactions before returning, and throws NotSupportedError for a document or shadow root"),
    ...["write", "writeln"].map((name) => entry(`Document#${name}`,
      [dom("Parse"), dom("NodeWrite"), { kind: "mutate", target: receiver }, { kind: "invoke-user-code" }, throws("DOMException"), throws("TypeError")],
      `document.${name}() parses its argument into the document and executes the scripts it inserts; with no insertion point it first reopens the document, destroying the tree and its listeners. It throws InvalidStateError on an XML document or during custom element construction, and TypeError when a Trusted Types policy rejects the string`)),
    ...["elementFromPoint", "elementsFromPoint"].map((name) => entry(`Document#${name}`, [dom("LayoutRead")],
      `document.${name}() resolves a hit test, which requires up-to-date layout`)),
    entry("Document#hasFocus", [dom("PropertyRead")], "document.hasFocus() reads focus state the host maintains"),
    // --- Window and its mixins --------------------------------------------------------------------------------
    // A `Window` reference may be a cross-origin window proxy. Only the names the standard safelists are
    // readable there; every other one throws SecurityError before the getter is entered.
    ...["parent", "top", "self", "window", "frames", "frameElement"]
      .map((name) => property(`Window#${name}`, [dom("PropertyRead")], [],
        `window.${name} is safelisted for a cross-origin window proxy and reads a host object the browsing context holds`)),
    ...["document", "navigator", "screen", "history", "customElements"]
      .map((name) => property(`Window#${name}`, [dom("PropertyRead"), throws("DOMException")], [],
        `window.${name} reads a host object the browsing context holds and throws SecurityError on a cross-origin window proxy`)),
    property("Window#opener", [dom("PropertyRead")],
      [dom("PropertyWrite"), { kind: "mutate", target: receiver }],
      "window.opener is safelisted cross-origin; assigning null severs the opener permanently and any other value replaces the accessor with an own data property"),
    property("Window#visualViewport", [dom("PropertyRead"), throws("DOMException")], [],
      "window.visualViewport returns the document's viewport object without computing geometry, and throws SecurityError on a cross-origin window proxy"),
    ...["innerWidth", "innerHeight", "outerWidth", "outerHeight", "scrollX", "scrollY", "pageXOffset", "pageYOffset", "devicePixelRatio", "screenX", "screenY"]
      .map((name) => property(`Window#${name}`, [dom("LayoutRead"), throws("DOMException")], [],
        `window.${name} reads viewport geometry, which requires up-to-date layout, and throws SecurityError on a cross-origin window proxy`)),
    entry("Window#getComputedStyle", [dom("LayoutRead"), throws("DOMException")],
      "window.getComputedStyle() resolves used values against current layout and throws SecurityError on a cross-origin window proxy"),
    // --- navigator and measured geometry -----------------------------------------------------------------
    // Keyed by the mixin each member is declared on, which is what a receiver's interface chain reaches.
    ...([
      ["NavigatorID", "userAgent"], ["NavigatorID", "platform"], ["NavigatorID", "vendor"],
      ["NavigatorLanguage", "language"], ["NavigatorLanguage", "languages"],
      ["NavigatorCookies", "cookieEnabled"], ["NavigatorConcurrentHardware", "hardwareConcurrency"],
      ["NavigatorOnLine", "onLine"], ["NavigatorAutomationInformation", "webdriver"],
      ["Navigator", "maxTouchPoints"], ["Navigator", "doNotTrack"],
    ] as const).map(([owner, name]) => property(`${owner}#${name}`, [dom("PropertyRead")], [throws("TypeError")],
      `navigator.${name} reads host-environment state the user agent maintains, not the document tree; the attribute is readonly, so an assignment throws`)),
    ...["x", "y", "width", "height", "top", "right", "bottom", "left"]
      .map((name) => property(`DOMRectReadOnly#${name}`, [], [throws("TypeError")],
        `A rectangle is the snapshot the measuring call already produced, so reading ${name} performs no further layout; on the read-only interface the attribute has no setter and an assignment throws`)),
    // `DOMRect` redeclares the four geometry members as writable, and `getBoundingClientRect` returns one.
    ...["x", "y", "width", "height"].map((name) => property(`DOMRect#${name}`, [], [{ kind: "mutate", target: receiver }],
      `DOMRect redeclares ${name} as a writable attribute, so an assignment mutates the rectangle rather than throwing`)),
    property("WindowLocalStorage#localStorage", [{ kind: "throw", error: "DOMException" }], [],
      "Reading localStorage throws SecurityError when the origin is denied storage access"),
    property("WindowSessionStorage#sessionStorage", [{ kind: "throw", error: "DOMException" }], [],
      "Reading sessionStorage throws SecurityError when the origin is denied storage access"),
  ];
}

export const builtinSemanticCatalog: BuiltinSemanticCatalog = {
  schema: "uneffect-builtin-semantics/v1",
  definitions: [
    ...(["map", "flatMap", "filter", "forEach", "every", "some", "find", "findIndex", "findLast", "findLastIndex"] as const)
      .flatMap((name) => ["Array", "ReadonlyArray"].map((owner) => reviewed("javascript", {
        symbol: { module: "lib.es", export: `${owner}#${name}` },
        semantics: { schema: "uneffect-semantic-primitives/v1", primitives: [
          ...inlineCallbackSemantics(0, false,
            [runtimeValue("array-element"), runtimeValue("array-index"), receiverValue], optionalArgument(1)).primitives,
          ...((name === "map" || name === "flatMap" || name === "filter")
            ? [{ kind: "result" as const, refinement: { kind: "fresh" as const } }] : []),
        ] },
        trustReason: `ECMAScript ${owner}.${name} invokes its callback synchronously`, trustOwner: "@mizchi/uneffect",
      }))),
    ...(["reduce", "reduceRight"] as const).flatMap((name) => ["Array", "ReadonlyArray"].map((owner) => reviewed("javascript", {
      symbol: { module: "lib.es", export: `${owner}#${name}` },
      semantics: inlineCallbackSemantics(0, false,
        [runtimeValue("array-accumulator"), runtimeValue("array-element"), runtimeValue("array-index"), receiverValue]),
      trustReason: `ECMAScript ${owner}.${name} invokes its callback synchronously`, trustOwner: "@mizchi/uneffect",
    }))),
    ...(["Map", "ReadonlyMap", "Set", "ReadonlySet"] as const).map((owner) => reviewed("javascript", {
      symbol: { module: "lib.es", export: `${owner}#forEach` },
      semantics: inlineCallbackSemantics(0, false,
        [runtimeValue(`${owner}-value`), runtimeValue(`${owner}-key`), receiverValue], optionalArgument(1)),
      trustReason: `ECMAScript ${owner}.forEach invokes its callback synchronously`, trustOwner: "@mizchi/uneffect",
    })),
    ...(["Array", "ReadonlyArray"] as const).flatMap((owner) => [
      reviewed("javascript", {
        symbol: { module: "lib.es", export: `${owner}#concat` },
        semantics: { schema: "uneffect-semantic-primitives/v1", primitives: [{ kind: "result", refinement: { kind: "fresh" } }] },
        trustReason: `ECMAScript ${owner}.concat returns a fresh Array; explicit spreadability and indexed accessors are inspected separately`,
        trustOwner: "@mizchi/uneffect",
      }),
      reviewed("javascript", {
        symbol: { module: "lib.es", export: `${owner}#slice` },
        semantics: { schema: "uneffect-semantic-primitives/v1", primitives: [{ kind: "result", refinement: { kind: "fresh" } }] },
        trustReason: `ECMAScript ${owner}.slice returns a fresh Array`, trustOwner: "@mizchi/uneffect",
      }),
      reviewed("javascript", {
        symbol: { module: "lib.es", export: `${owner}#join` },
        trustReason: `ECMAScript ${owner}.join has no callback or host authority`, trustOwner: "@mizchi/uneffect",
      }),
      ...(["flat", "toReversed", "toSpliced", "with"] as const).map((name) => reviewed("javascript", {
        symbol: { module: "lib.es", export: `${owner}#${name}` },
        semantics: { schema: "uneffect-semantic-primitives/v1", primitives: [{ kind: "result", refinement: { kind: "fresh" } }] },
        trustReason: `ECMAScript ${owner}.${name} returns a fresh Array`, trustOwner: "@mizchi/uneffect",
      })),
    ]),
    ...(["Array", "ReadonlyArray"] as const).map((owner) => reviewed("javascript", {
      symbol: { module: "lib.es", export: `${owner}#toSorted` },
      semantics: { schema: "uneffect-semantic-primitives/v1", primitives: [...inlineCallbackSemantics(0, true,
        [runtimeValue("sort-left"), runtimeValue("sort-right")]).primitives, { kind: "result", refinement: { kind: "fresh" } }] },
      trustReason: `ECMAScript ${owner}.toSorted returns a fresh Array and invokes its optional comparator synchronously`, trustOwner: "@mizchi/uneffect",
    })),
    reviewed("javascript", {
      symbol: { module: "lib.es", export: "Array#sort" },
      semantics: { schema: "uneffect-semantic-primitives/v1", primitives: [
        ...inlineCallbackSemantics(0, true, [runtimeValue("sort-left"), runtimeValue("sort-right")]).primitives,
        { kind: "mutate", target: { kind: "receiver" } },
      ] },
      trustReason: "ECMAScript Array.sort mutates its receiver and invokes its optional comparator synchronously", trustOwner: "@mizchi/uneffect",
    }),
    reviewed("javascript", {
      symbol: { module: "lib.es", export: "ArrayBuffer#resize" },
      semantics: { schema: "uneffect-semantic-primitives/v1", primitives: [
        { kind: "mutate", target: { kind: "receiver" } },
        { kind: "throw", error: "TypeError" },
        { kind: "throw", error: "RangeError" },
      ] },
      trustReason: "ECMAScript ArrayBuffer.resize mutates a resizable receiver and may throw for detached, fixed-length, or over-limit buffers",
      trustOwner: "@mizchi/uneffect",
    }),
    ...typedArrayOwners.flatMap((owner) =>
      (["every", "filter", "find", "findIndex", "findLast", "findLastIndex", "forEach", "map", "some"] as const).map((name) => reviewed("javascript", {
        symbol: { module: "lib.es", export: `${owner}#${name}` },
        semantics: { schema: "uneffect-semantic-primitives/v1", primitives: [
          ...inlineCallbackSemantics(0, false,
            [runtimeValue("typed-array-element"), runtimeValue("typed-array-index"), receiverValue], optionalArgument(1)).primitives,
          ...((name === "filter" || name === "map") ? [{ kind: "result" as const, refinement: { kind: "fresh" as const } }] : []),
        ] },
        trustReason: `ECMAScript ${owner}.${name} invokes its callback synchronously`, trustOwner: "@mizchi/uneffect",
      }))),
    ...typedArrayOwners.flatMap((owner) => (["reduce", "reduceRight"] as const).map((name) => reviewed("javascript", {
      symbol: { module: "lib.es", export: `${owner}#${name}` },
      semantics: inlineCallbackSemantics(0, false, [
        runtimeValue("typed-array-accumulator"), runtimeValue("typed-array-element"),
        runtimeValue("typed-array-index"), receiverValue,
      ]),
      trustReason: `ECMAScript ${owner}.${name} invokes its callback synchronously`, trustOwner: "@mizchi/uneffect",
    }))),
    ...typedArrayOwners.map((owner) => reviewed("javascript", {
      symbol: { module: "lib.es", export: `${owner}#sort` },
      semantics: { schema: "uneffect-semantic-primitives/v1", primitives: [
        ...inlineCallbackSemantics(0, true, [runtimeValue("sort-left"), runtimeValue("sort-right")]).primitives,
        { kind: "mutate", target: receiverValue },
      ] },
      trustReason: `ECMAScript ${owner}.sort mutates its receiver and invokes its optional comparator synchronously`, trustOwner: "@mizchi/uneffect",
    })),
    ...typedArrayOwners.map((owner) => reviewed("javascript", {
      symbol: { module: "lib.es", export: `${owner}#toSorted` },
      semantics: { schema: "uneffect-semantic-primitives/v1", primitives: [
        ...inlineCallbackSemantics(0, true, [runtimeValue("sort-left"), runtimeValue("sort-right")]).primitives,
        { kind: "result", refinement: { kind: "fresh" } },
      ] },
      trustReason: `ECMAScript ${owner}.toSorted returns a fresh typed array and invokes its optional comparator synchronously`, trustOwner: "@mizchi/uneffect",
    })),
    ...typedArrayOwners.flatMap((owner) => ["copyWithin", "fill", "reverse", "set"].map((name) => reviewed("javascript", {
      symbol: { module: "lib.es", export: `${owner}#${name}` },
      semantics: { schema: "uneffect-semantic-primitives/v1", primitives: [{ kind: "mutate", target: receiverValue }] },
      trustReason: `ECMAScript ${owner}.${name} mutates its receiver`, trustOwner: "@mizchi/uneffect",
    }))),
    ...typedArrayOwners.flatMap((owner) => ["slice", "toReversed", "with"].map((name) => reviewed("javascript", {
      symbol: { module: "lib.es", export: `${owner}#${name}` },
      semantics: { schema: "uneffect-semantic-primitives/v1", primitives: [{ kind: "result", refinement: { kind: "fresh" } }] },
      trustReason: `ECMAScript ${owner}.${name} returns a fresh typed array`, trustOwner: "@mizchi/uneffect",
    }))),
    ...(["keys", "values", "entries"] as const).map((name) => reviewed("javascript", {
      symbol: { module: "lib.es", export: `ObjectConstructor#${name}` }, semantics: { schema: "uneffect-semantic-primitives/v1", primitives: [{ kind: "result", refinement: { kind: "fresh" } }] },
      trustReason: `ECMAScript Object.${name} returns a newly allocated Array`, trustOwner: "@mizchi/uneffect",
    })),
    reviewed("javascript", {
      symbol: { module: "lib.es", export: "ObjectConstructor#create" },
      semantics: { schema: "uneffect-semantic-primitives/v1", primitives: [
        { kind: "result", refinement: { kind: "fresh" } },
      ] },
      trustReason: "ECMAScript Object.create allocates a fresh object with the requested prototype and descriptors",
      trustOwner: "@mizchi/uneffect",
    }),
    reviewed("javascript", {
      symbol: { module: "lib.es", export: "ObjectConstructor#assign" },
      semantics: { schema: "uneffect-semantic-primitives/v1", primitives: [
        { kind: "mutate", target: { kind: "argument", index: 0 } },
        { kind: "result", refinement: { kind: "alias", target: { kind: "argument", index: 0 } } },
      ] },
      trustReason: "ECMAScript Object.assign writes enumerable source properties into and returns its target",
      trustOwner: "@mizchi/uneffect",
    }),
    ...(["defineProperty", "defineProperties", "freeze", "seal", "preventExtensions", "setPrototypeOf"] as const).map((name) => reviewed("javascript", {
      symbol: { module: "lib.es", export: `ObjectConstructor#${name}` },
      semantics: { schema: "uneffect-semantic-primitives/v1", primitives: [
        { kind: "mutate" as const, target: { kind: "argument" as const, index: 0 } },
        { kind: "result" as const, refinement: { kind: "alias" as const, target: { kind: "argument" as const, index: 0 } } },
      ] },
      trustReason: `ECMAScript Object.${name} changes and returns its target object`, trustOwner: "@mizchi/uneffect",
    })),
    ...(["defineProperty", "setPrototypeOf"] as const).map((name) => reviewed("javascript", {
      symbol: { module: "lib.es", export: `Reflect#${name}` },
      semantics: { schema: "uneffect-semantic-primitives/v1", primitives: [
        { kind: "mutate" as const, target: { kind: "argument" as const, index: 0 } },
      ] },
      trustReason: `ECMAScript Reflect.${name} changes its target object`, trustOwner: "@mizchi/uneffect",
    })),
    reviewed("javascript", {
      symbol: { module: "lib.es", export: "Reflect#set" },
      semantics: { schema: "uneffect-semantic-primitives/v1", primitives: [
        { kind: "mutate", target: { kind: "argument", index: 0 } },
        { kind: "mutate", target: { kind: "argument", index: 3, optional: true } },
      ] },
      trustReason: "ECMAScript Reflect.set writes through the target descriptor and optional receiver",
      trustOwner: "@mizchi/uneffect",
    }),
    reviewed("javascript", {
      symbol: { module: "lib.es", export: "Reflect#deleteProperty" },
      semantics: { schema: "uneffect-semantic-primitives/v1", primitives: [
        { kind: "mutate", target: { kind: "argument", index: 0 } },
      ] },
      trustReason: "ECMAScript Reflect.deleteProperty removes an own property from its target",
      trustOwner: "@mizchi/uneffect",
    }),
    reviewed("javascript", {
      symbol: { module: "lib.es", export: "ArrayConstructor#from" },
      semantics: { schema: "uneffect-semantic-primitives/v1", primitives: [
        ...inlineCallbackSemantics(1, true,
          [runtimeValue("array-from-element"), runtimeValue("array-from-index")], optionalArgument(2)).primitives,
        { kind: "result", refinement: { kind: "fresh" } },
      ] },
      trustReason: "ECMAScript Array.from invokes its optional mapping callback synchronously and creates a new Array",
      trustOwner: "@mizchi/uneffect",
    }),
    reviewed("javascript", {
      symbol: { module: "lib.es", export: "ArrayConstructor#of" },
      semantics: { schema: "uneffect-semantic-primitives/v1", primitives: [
        { kind: "result", refinement: { kind: "fresh" } },
      ] },
      trustReason: "ECMAScript Array.of creates a new Array",
      trustOwner: "@mizchi/uneffect",
    }),
    reviewed("javascript", {
      symbol: { module: "lib.es", export: "ObjectConstructor#fromEntries" },
      semantics: { schema: "uneffect-semantic-primitives/v1", primitives: [
        { kind: "result", refinement: { kind: "fresh" } },
      ] },
      trustReason: "ECMAScript Object.fromEntries creates a new ordinary object while consuming its iterable input",
      trustOwner: "@mizchi/uneffect",
    }),
    ...(["Array", "Map", "Set", "WeakMap", "WeakSet"] as const).map((name) => reviewed("javascript", {
      symbol: { module: "global", export: name },
      semantics: { schema: "uneffect-semantic-primitives/v1", primitives: [
        { kind: "result" as const, refinement: { kind: "fresh" as const } },
      ] },
      trustReason: `ECMAScript ${name} construction creates a fresh collection object`,
      trustOwner: "@mizchi/uneffect",
    })),
    reviewed("javascript", {
      symbol: { module: "lib.es", export: "ArrayConstructor#fromAsync" },
      semantics: { schema: "uneffect-semantic-primitives/v1", primitives: [
        {
          kind: "callback", target: { kind: "argument", index: 1 }, timing: "deferred", queue: "microtask",
          cardinality: "0..n", callable: "optional",
          invocationArguments: [runtimeValue("array-from-async-element"), runtimeValue("array-from-async-index")],
          thisArgument: optionalArgument(2),
        },
        { kind: "protocol", name: "promise-combinator", transition: "fromAsync", inputs: {
          iterable: { kind: "argument", index: 0 },
        } },
      ] },
      trustReason: "ECMAScript Array.fromAsync awaits iterator values and mapping results while constructing its Promise result",
      trustOwner: "@mizchi/uneffect",
    }),
    // Members reviewed against the ECMAScript specification as completing without any user-observable side
    // effect and without reaching user code, for every argument a checked program can pass. Their receiver is a
    // primitive string or the standard constructor object, so no override or subclass can intercept them.
    // `split` and `localeCompare` are deliberately absent: `split` delegates to a `Symbol.split` method a
    // well-typed splitter object may define, and the locale-sensitive members canonicalize a locale list they
    // may read through user accessors. Members whose receiver is an instance interface a user class can extend
    // (`Map`, `Set`, and their weak and readonly forms) are absent for the same reason: the declared type does
    // not establish which body runs. `RegExp` matching updates `lastIndex` and is absent as an observable write.
    ...([
      ["String", ["trim", "trimStart", "trimEnd", "toLowerCase", "toUpperCase", "charAt", "charCodeAt",
        "codePointAt", "at", "startsWith", "endsWith", "includes", "indexOf", "lastIndexOf", "slice", "substring"]],
      ["NumberConstructor", ["isFinite", "isInteger", "isNaN", "isSafeInteger"]],
    ] as const).flatMap(([owner, names]) => names.map((name) => reviewed("javascript", {
      symbol: { module: "lib.es", export: `${owner}#${name}` },
      semantics: { schema: "uneffect-semantic-primitives/v1", primitives: [] },
      trustReason: `ECMAScript ${owner}.${name} completes without a user-observable side effect and reaches no user code for the arguments a checked program can pass`,
      trustOwner: "@mizchi/uneffect",
    }))),
    // These build a new string and throw when the result would exceed the implementation's string limit, or
    // when the argument is outside the range the specification admits.
    ...(["normalize", "repeat", "padStart", "padEnd", "concat"] as const).map((name) => reviewed("javascript", {
      symbol: { module: "lib.es", export: `String#${name}` },
      semantics: { schema: "uneffect-semantic-primitives/v1", primitives: [{ kind: "throw", error: "RangeError" }] },
      trustReason: `ECMAScript String.${name} reaches no user code but throws RangeError for an out-of-range argument or an over-long result`,
      trustOwner: "@mizchi/uneffect",
    })),
    reviewed("javascript", {
      symbol: { module: "lib.es", export: "ArrayConstructor#isArray" },
      semantics: { schema: "uneffect-semantic-primitives/v1", primitives: [{ kind: "throw", error: "TypeError" }] },
      trustReason: "ECMAScript Array.isArray reaches no user code but throws TypeError for a revoked Proxy argument",
      trustOwner: "@mizchi/uneffect",
    }),
    reviewed("javascript", {
      symbol: { module: "lib.es", export: "JSON#parse" },
      semantics: { schema: "uneffect-semantic-primitives/v1", primitives: [
        ...inlineCallbackSemantics(1, true,
          [runtimeValue("json-property-key"), runtimeValue("json-property-value")], runtimeValue("json-holder")).primitives,
        { kind: "throw", error: "SyntaxError" },
      ] },
      trustReason: "ECMAScript JSON.parse may throw SyntaxError and invokes a callable reviver synchronously for parsed properties and the root value",
      trustOwner: "@mizchi/uneffect",
    }),
    reviewed("javascript", {
      symbol: { module: "lib.es", export: "JSON#stringify" },
      semantics: inlineCallbackSemantics(1, true,
        [runtimeValue("json-property-key"), runtimeValue("json-property-value")], runtimeValue("json-holder")),
      trustReason: "ECMAScript JSON.stringify invokes a callable replacer synchronously", trustOwner: "@mizchi/uneffect",
    }),
    ...(["replace", "replaceAll"] as const).map((name) => reviewed("javascript", {
      symbol: { module: "lib.es", export: `String#${name}` },
      semantics: { schema: "uneffect-semantic-primitives/v1", primitives: [{
        kind: "callback", target: { kind: "argument", index: 1 }, timing: "sync", queue: "current",
        cardinality: name === "replace" ? "0..1" : "0..n", callable: "optional",
        invocationArguments: [runtimeValue("replacement-match"), runtimeValue("replacement-offset"), runtimeValue("replacement-input")],
      }] },
      trustReason: `ECMAScript String.${name} invokes a callable replacement synchronously`, trustOwner: "@mizchi/uneffect",
    })),
    ...(["ObjectConstructor", "MapConstructor"] as const).map((owner) => reviewed("javascript", {
      symbol: { module: "lib.es", export: `${owner}#groupBy` },
      semantics: { schema: "uneffect-semantic-primitives/v1", primitives: [
        { kind: "callback", target: { kind: "argument", index: 1 }, timing: "sync", queue: "current", cardinality: "0..n", callable: "required",
          invocationArguments: [runtimeValue("group-element"), runtimeValue("group-index")] },
        { kind: "result", refinement: { kind: "fresh" } },
      ] },
      trustReason: `ECMAScript ${owner}.groupBy consumes its iterable and invokes its classifier synchronously`, trustOwner: "@mizchi/uneffect",
    })),
    /**
     * `PromiseLike` is a structural interface, not a specification object: any value with a `then` method is
     * assignable to it, and calling that method is an ordinary call into code the caller supplied. None of the
     * deferral, the at-most-once settlement, or the absence of a synchronous throw that `Promise.prototype.then`
     * guarantees applies, because every one of those comes from the promise machinery the value need not be.
     */
    reviewed("javascript", {
      symbol: { module: "lib.es", export: "PromiseLike#then" },
      semantics: { schema: "uneffect-semantic-primitives/v1", primitives: [
        { kind: "invoke-user-code" },
        { kind: "throw", error: "unknown" },
        ...([0, 1] as const).map((index) => ({
          kind: "callback" as const, target: { kind: "argument" as const, index }, timing: "sync" as const,
          queue: "current" as const, cardinality: "0..n" as const, callable: "optional" as const,
          invocationArguments: [runtimeValue(index === 0 ? "promise-fulfillment" : "promise-rejection")],
        })),
      ] },
      trustReason: "A PromiseLike value's own `then` is user code: ECMAScript constrains a thenable's `then` only inside PromiseResolveThenableJob, which a direct call does not reach",
      trustOwner: "@mizchi/uneffect",
    }),
    ...(["Promise#then", "Promise#catch", "Promise#finally"] as const).map((key) => reviewed("javascript", {
      symbol: { module: "lib.es", export: key },
      semantics: { schema: "uneffect-semantic-primitives/v1", primitives: [
        ...(key.endsWith("#then") ? [0, 1] : [0]).map((index) => ({
          kind: "callback" as const, target: { kind: "argument" as const, index }, timing: "deferred" as const,
          queue: "microtask" as const, cardinality: "0..1" as const, callable: "optional" as const,
          invocationArguments: key.endsWith("#finally") ? [] : [runtimeValue(
            key.endsWith("#then") && index === 0 ? "promise-fulfillment" : "promise-rejection",
          )],
        })),
        { kind: "protocol" as const, name: "promise-handler", transition: key.slice(key.indexOf("#") + 1) },
      ] },
      // The entry already rests on the builtin promise machinery running — a subclass may override `then`
      // itself — so the species constructor that same subclass would have to install, and the TypeError a
      // receiver that is not a promise raises, are outside this claim rather than modelled halfway.
      trustReason: `ECMAScript ${key.replace("#", ".")} schedules callable handlers as microtasks; a receiver that is not a builtin promise, including a subclass with its own Symbol.species, is outside this claim`,
      trustOwner: "@mizchi/uneffect",
    })),
    ...(["all", "allSettled", "race", "any"] as const).map((combinator) => reviewed("javascript", {
      symbol: { module: "lib.es", export: `PromiseConstructor#${combinator}` },
      semantics: { schema: "uneffect-semantic-primitives/v1", primitives: [{
        kind: "protocol", name: "promise-combinator", transition: combinator,
        inputs: { iterable: { kind: "argument", index: 0 } },
      }] },
    })),
    reviewed("javascript", {
      symbol: { module: "lib.es", export: "PromiseConstructor#withResolvers" },
      semantics: { schema: "uneffect-semantic-primitives/v1", primitives: [
        { kind: "result", refinement: { kind: "fresh" } },
        { kind: "protocol", name: "promise-capability", transition: "create" },
      ] },
      trustReason: "ECMAScript Promise.withResolvers creates a fresh Promise capability without invoking user code",
      trustOwner: "@mizchi/uneffect",
    }),
    reviewed("javascript", {
      symbol: { module: "lib.es", export: "PromiseConstructor#try" },
      semantics: { schema: "uneffect-semantic-primitives/v1", primitives: [
        {
          kind: "callback", target: { kind: "argument", index: 0 }, timing: "sync", queue: "current",
          cardinality: "1", callable: "required", completion: "convert-throw-to-rejection",
          invocationRestArguments: { from: 1 },
        },
        { kind: "protocol", name: "promise-handler", transition: "try" },
      ] },
      trustReason: "ECMAScript Promise.try invokes its callback synchronously and converts abrupt completion to Promise rejection",
      trustOwner: "@mizchi/uneffect",
    }),
    reviewed("javascript", { symbol: { module: "global", export: "Math.random" }, semantics: effectSemantics("Random") }),
    reviewed("node", { symbol: { module: "node:module", export: "createRequire" }, trustReason: "Node createRequire constructs a resolver without loading a target", trustOwner: "@mizchi/uneffect" }),
    reviewed("node", { symbol: { module: "node:path", export: "join" }, trustReason: "Node path.join is a deterministic lexical path operation", trustOwner: "@mizchi/uneffect" }),
    reviewed("node", {
      symbol: { module: "node:assert/strict", export: "ok" },
      semantics: { schema: "uneffect-semantic-primitives/v1", primitives: [{ kind: "throw", error: "AssertionError" }] },
      trustReason: "Node strict assert.ok returns normally only when its condition is truthy and otherwise throws AssertionError",
      trustOwner: "@mizchi/uneffect",
    }),
    reviewed("node", {
      symbol: { module: "node:assert/strict", export: "strict" },
      semantics: { schema: "uneffect-semantic-primitives/v1", primitives: [{ kind: "throw", error: "AssertionError" }] },
      trustReason: "Node strict assert callable returns normally only when its condition is truthy and otherwise throws AssertionError",
      trustOwner: "@mizchi/uneffect",
    }),
    reviewed("node", {
      symbol: { module: "node:assert/strict", export: "strictEqual" },
      semantics: { schema: "uneffect-semantic-primitives/v1", primitives: [{ kind: "throw", error: "AssertionError" }] },
      trustReason: "Node strict assert.strictEqual returns normally only when actual and expected are strictly equal and otherwise throws AssertionError",
      trustOwner: "@mizchi/uneffect",
    }),
    reviewed("node", {
      symbol: { module: "node:assert/strict", export: "notStrictEqual" },
      semantics: { schema: "uneffect-semantic-primitives/v1", primitives: [{ kind: "throw", error: "AssertionError" }] },
      trustReason: "Node strict assert.notStrictEqual returns normally only when actual and expected are not strictly equal and otherwise throws AssertionError",
      trustOwner: "@mizchi/uneffect",
    }),
    reviewed("node", {
      symbol: { module: "node:assert/strict", export: "fail" },
      semantics: { schema: "uneffect-semantic-primitives/v1", primitives: [{ kind: "throw", error: "AssertionError" }] },
      trustReason: "Node strict assert.fail always throws AssertionError",
      trustOwner: "@mizchi/uneffect",
    }),
    reviewed("node", {
      symbol: { module: "node:assert/strict", export: "ifError" },
      semantics: { schema: "uneffect-semantic-primitives/v1", primitives: [{ kind: "throw", error: "AssertionError" }] },
      trustReason: "Node strict assert.ifError returns normally only for null or undefined and otherwise throws AssertionError",
      trustOwner: "@mizchi/uneffect",
    }),
    reviewed("node", {
      symbol: { module: "node:assert", export: "ok" },
      semantics: { schema: "uneffect-semantic-primitives/v1", primitives: [{ kind: "throw", error: "AssertionError" }] },
      trustReason: "Node assert.ok returns normally only when its condition is truthy and otherwise throws AssertionError",
      trustOwner: "@mizchi/uneffect",
    }),
    reviewed("node", {
      symbol: { module: "node:assert", export: "default" },
      semantics: { schema: "uneffect-semantic-primitives/v1", primitives: [{ kind: "throw", error: "AssertionError" }] },
      trustReason: "Node assert callable returns normally only when its condition is truthy and otherwise throws AssertionError",
      trustOwner: "@mizchi/uneffect",
    }),
    reviewed("node", {
      symbol: { module: "node:assert", export: "strictEqual" },
      semantics: { schema: "uneffect-semantic-primitives/v1", primitives: [{ kind: "throw", error: "AssertionError" }] },
      trustReason: "Node assert.strictEqual returns normally only when actual and expected are strictly equal and otherwise throws AssertionError",
      trustOwner: "@mizchi/uneffect",
    }),
    reviewed("node", {
      symbol: { module: "node:assert", export: "notStrictEqual" },
      semantics: { schema: "uneffect-semantic-primitives/v1", primitives: [{ kind: "throw", error: "AssertionError" }] },
      trustReason: "Node assert.notStrictEqual returns normally only when actual and expected are not strictly equal and otherwise throws AssertionError",
      trustOwner: "@mizchi/uneffect",
    }),
    reviewed("node", {
      symbol: { module: "node:assert", export: "fail" },
      semantics: { schema: "uneffect-semantic-primitives/v1", primitives: [{ kind: "throw", error: "AssertionError" }] },
      trustReason: "Node assert.fail always throws AssertionError",
      trustOwner: "@mizchi/uneffect",
    }),
    reviewed("node", {
      symbol: { module: "node:assert", export: "ifError" },
      semantics: { schema: "uneffect-semantic-primitives/v1", primitives: [{ kind: "throw", error: "AssertionError" }] },
      trustReason: "Node assert.ifError returns normally only for null or undefined and otherwise throws AssertionError",
      trustOwner: "@mizchi/uneffect",
    }),
    reviewed("node", { symbol: { module: "lib.node", export: "Process#cwd" }, trustReason: "Node process.cwd reads launch configuration without a Deno-style permission", trustOwner: "@mizchi/uneffect" }),
    ...nodeFsDefinitions("node:fs"),
    ...nodeFsDefinitions("node:fs/promises"),
    reviewed("node", { symbol: { module: "node:fs/promises", export: "FileHandle#close" }, semantics: { schema: "uneffect-semantic-primitives/v1", primitives: [
      { kind: "release", resource: "file-handle", target: { kind: "receiver" } },
      { kind: "protocol", name: "file-handle", transition: "close", inputs: { handle: { kind: "receiver" } } },
    ] } }),
    ...(["read", "readFile", "readLines", "readv", "stat"] as const).map((name) => reviewed("node", {
      symbol: { module: "node:fs/promises", export: `FileHandle#${name}` }, semantics: { schema: "uneffect-semantic-primitives/v1", primitives: [
        { kind: "effect", capability: "FsRead" },
        { kind: "use", resource: "file-handle", target: { kind: "receiver" } },
      ] },
    })),
    ...(["appendFile", "chmod", "chown", "datasync", "sync", "truncate", "utimes", "write", "writeFile", "writev"] as const).map((name) => reviewed("node", {
      symbol: { module: "node:fs/promises", export: `FileHandle#${name}` }, semantics: { schema: "uneffect-semantic-primitives/v1", primitives: [
        { kind: "effect", capability: "FsWrite" },
        { kind: "use", resource: "file-handle", target: { kind: "receiver" } },
      ] },
    })),
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
    ...(["ref", "unref"] as const).map((name) => reviewed("node", {
      symbol: { module: "node:fs", export: `FSWatcher#${name}` }, semantics: { schema: "uneffect-semantic-primitives/v1", primitives: [
        { kind: "use", resource: "watcher", target: { kind: "receiver" } },
        { kind: "protocol", name: "watcher", transition: name, inputs: { handle: { kind: "receiver" } } },
      ] },
    })),
    reviewed("node", { symbol: { module: "node:net", export: "Server#close" }, semantics: deferredNetworkSemantics({ callbackMinimumArguments: 1, queue: "close", releaseReceiver: "server", protocol: { name: "server", transition: "close" } }) }),
    reviewed("node", { symbol: { module: "node:net", export: "Server#listen" }, semantics: deferredNetworkSemantics({ callbackMinimumArguments: 2, queue: "next-tick", scope: { kind: "network", format: "connect", target: { kind: "argument", index: 0 }, hostArgument: 1 }, useReceiver: "server", protocol: { name: "server", transition: "listen" } }) }),
    ...["connect", "createConnection"].map((name) => reviewed("node", { symbol: { module: "node:net", export: name }, semantics: deferredNetworkSemantics({ callbackMinimumArguments: 2, scope: { kind: "network", format: "connect", target: { kind: "argument", index: 0 }, hostArgument: 1 } }) })),
    reviewed("node", { symbol: { module: "node:net", export: "Socket#connect" }, semantics: deferredNetworkSemantics({ callbackMinimumArguments: 2, scope: { kind: "network", format: "connect", target: { kind: "argument", index: 0 }, hostArgument: 1 } }) }),
    reviewed("node", { symbol: { module: "node:dns", export: "lookup" }, semantics: deferredNetworkSemantics({ callbackMinimumArguments: 2, scope: { kind: "network", format: "host", target: { kind: "argument", index: 0 } } }) }),
    reviewed("node", { symbol: { module: "node:dns", export: "lookupService" }, semantics: deferredNetworkSemantics({ effect: true, callbackMinimumArguments: 3 }) }),
    ...(["node:net", "node:http", "node:https"] as const).map((module) => reviewed("node", { symbol: { module, export: "createServer" }, semantics: deferredNetworkSemantics({ callbackMinimumArguments: 1, callbackCardinality: "0..n", resultResource: "server", protocol: { name: "server", transition: "create" } }) })),
    ...(["node:http", "node:https"] as const).flatMap((module) => ["request", "get"].map((name) => reviewed("node", { symbol: { module, export: name }, semantics: deferredNetworkSemantics({ callbackMinimumArguments: 2, scope: { kind: "network", format: "http-request", target: { kind: "argument", index: 0 }, defaultPort: module === "node:https" ? 443 : 80 } }) }))),
    reviewed("node", { symbol: { module: "lib.node", export: "Process#nextTick" }, semantics: timerSemantics("next-tick", false, undefined, [], 1) }),
    reviewed("node", { symbol: { module: "node:tty", export: "WriteStream#write" }, semantics: effectSemantics("Console") }),
    reviewed("node", { symbol: { module: "node:timers", export: "setImmediate" }, semantics: timerSemantics("check", false, undefined, [], 1) }),
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
    reviewed("dom", { symbol: { module: "global", export: "setTimeout" }, semantics: timerSemantics("timer", false, 1, [], 2) }),
    // The same operations reached as members of the global object: `window.setTimeout` resolves to the mixin
    // that declares them, so the reviewed semantics are published under that interface as well.
    reviewed("dom", { symbol: { module: "lib.dom", export: "WindowOrWorkerGlobalScope#setTimeout" }, semantics: timerSemantics("timer", false, 1, [], 2) }),
    reviewed("dom", { symbol: { module: "lib.dom", export: "WindowOrWorkerGlobalScope#setInterval" }, semantics: timerSemantics("timer", true, 1, [], 2) }),
    reviewed("dom", { symbol: { module: "lib.dom", export: "WindowOrWorkerGlobalScope#queueMicrotask" }, semantics: timerSemantics("microtask", false, undefined, []) }),
    reviewed("dom", { symbol: { module: "lib.dom", export: "AnimationFrameProvider#requestAnimationFrame" },
      semantics: timerSemantics("animation-frame", false, undefined, [runtimeValue("animation-frame-timestamp")]) }),
    reviewed("dom", { symbol: { module: "global", export: "setInterval" }, semantics: timerSemantics("timer", true, 1, [], 2) }),
    reviewed("dom", { symbol: { module: "global", export: "queueMicrotask" }, semantics: timerSemantics("microtask", false, undefined, []) }),
    reviewed("node", { symbol: { module: "global", export: "setImmediate" }, semantics: timerSemantics("check", false, undefined, [], 1) }),
    reviewed("dom", { symbol: { module: "global", export: "requestAnimationFrame" }, semantics: timerSemantics("animation-frame", false, undefined, [runtimeValue("animation-frame-timestamp")]) }),
    reviewed("dom", { symbol: { module: "global", export: "cancelAnimationFrame" }, semantics: { schema: "uneffect-semantic-primitives/v1", primitives: [
      { kind: "effect", capability: "Timer" }, { kind: "protocol", name: "animation-frame", transition: "cancel", inputs: { handle: { kind: "argument", index: 0 } } },
    ] } }),
    ...(["WindowOrWorkerGlobalScope#clearTimeout", "WindowOrWorkerGlobalScope#clearInterval", "AnimationFrameProvider#cancelAnimationFrame"] as const)
      .map((name) => reviewed("dom", { symbol: { module: "lib.dom", export: name }, semantics: { schema: "uneffect-semantic-primitives/v1", primitives: [
        { kind: "effect", capability: "Timer" },
        { kind: "protocol", name: "timer", transition: "cancel", inputs: { handle: { kind: "argument", index: 0 } } },
      ] } })),
    /**
     * Standard global constructors and conversions. The dividing line is what the TypeScript signature admits:
     * a parameter the checker constrains to a primitive is coerced without reaching user code, while one typed
     * `any` or `unknown` reaches the value's own `toString`, `valueOf` or `Symbol.toPrimitive`.
     */
    ...(["Error", "EvalError", "RangeError", "ReferenceError", "SyntaxError", "TypeError", "URIError"] as const).map((name) => reviewed("javascript", {
      symbol: { module: "global", export: name },
      semantics: { schema: "uneffect-semantic-primitives/v1", primitives: [
        { kind: "result", refinement: { kind: "fresh" } },
      ] },
      trustReason: `ECMAScript ${name} declares a string message, so its ToString step is total, and it installs message and cause without any other observable step; an options object whose \`cause\` is an accessor rather than a data property is outside this claim`,
      trustOwner: "@mizchi/uneffect",
    })),
    ...(["String", "Number"] as const).map((name) => reviewed("javascript", {
      symbol: { module: "global", export: name },
      semantics: { schema: "uneffect-semantic-primitives/v1", primitives: [
        { kind: "invoke-user-code" }, { kind: "throw", error: "TypeError" },
        { kind: "result", refinement: { kind: "fresh" } },
      ] },
      trustReason: `ECMAScript ${name} accepts an unconstrained value, so its coercion runs the value's own Symbol.toPrimitive, valueOf or toString and throws TypeError when that yields no primitive; the construct form allocates a wrapper object`,
      trustOwner: "@mizchi/uneffect",
    })),
    reviewed("javascript", {
      symbol: { module: "global", export: "Boolean" },
      semantics: { schema: "uneffect-semantic-primitives/v1", primitives: [] },
      trustReason: "ECMAScript ToBoolean reads no property of its argument and has no abrupt completion",
      trustOwner: "@mizchi/uneffect",
    }),
    ...(["parseInt", "parseFloat"] as const).map((name) => reviewed("javascript", {
      symbol: { module: "global", export: name },
      semantics: { schema: "uneffect-semantic-primitives/v1", primitives: [] },
      trustReason: `ECMAScript ${name} declares a string parameter, and parseInt's radix a number, so both of its coercion steps are total and reach no user method; an argument the type system did not constrain is outside this claim`,
      trustOwner: "@mizchi/uneffect",
    })),
    ...(["isNaN", "isFinite"] as const).map((name) => reviewed("javascript", {
      symbol: { module: "global", export: name },
      semantics: { schema: "uneffect-semantic-primitives/v1", primitives: [] },
      trustReason: `ECMAScript ${name} declares a number parameter, so its ToNumber step is total and reaches no user method; an argument the type system did not constrain is outside this claim, because ToNumber runs the value's own coercion and throws TypeError for a Symbol or a BigInt`,
      trustOwner: "@mizchi/uneffect",
    })),
    // Every one of these takes a number and returns a number; ToNumber of a number is the identity.
    ...(["abs", "ceil", "floor", "round", "trunc", "sign", "sqrt", "cbrt", "exp", "log", "log2", "log10",
      "sin", "cos", "tan", "asin", "acos", "atan", "atan2", "pow", "max", "min", "hypot", "fround"] as const)
      .map((name) => reviewed("javascript", {
        symbol: { module: "global", export: `Math.${name}` },
        semantics: { schema: "uneffect-semantic-primitives/v1", primitives: [] },
        trustReason: `ECMAScript Math.${name} declares number parameters, so its ToNumber steps are total and the arithmetic that follows has no abrupt completion; an argument the type system did not constrain is outside this claim, because ToNumber runs the value's own coercion and throws TypeError for a Symbol or a BigInt`,
        trustOwner: "@mizchi/uneffect",
      })),
    reviewed("javascript", {
      symbol: { module: "global", export: "Promise" },
      semantics: { schema: "uneffect-semantic-primitives/v1", primitives: [
        {
          kind: "callback", target: { kind: "argument", index: 0 }, timing: "sync", queue: "current",
          cardinality: "1", callable: "required",
          invocationArguments: [runtimeValue("promise-resolve"), runtimeValue("promise-reject")],
        },
        { kind: "result", refinement: { kind: "fresh" } },
      ] },
      trustReason: "ECMAScript new Promise calls its executor once, synchronously, before the constructor returns; the executor is declared callable and construction is the only call form, so neither TypeError of 27.5.3.1 is reachable, and an executor that throws is routed to the rejection rather than rethrown",
      trustOwner: "@mizchi/uneffect",
    }),
    reviewed("dom", {
      symbol: { module: "global", export: "XMLHttpRequest" },
      semantics: { schema: "uneffect-semantic-primitives/v1", primitives: [{ kind: "result", refinement: { kind: "fresh" } }] },
      trustReason: "The XHR constructor sets the object's initial state and starts no fetch",
      trustOwner: "@mizchi/uneffect",
    }),
    reviewed("dom", {
      symbol: { module: "global", export: "URL" },
      semantics: { schema: "uneffect-semantic-primitives/v1", primitives: [
        { kind: "invoke-user-code" }, { kind: "throw", error: "TypeError" },
        { kind: "result", refinement: { kind: "fresh" } },
      ] },
      trustReason: "The URL constructor accepts a URL object as well as a string at both positions, so Web IDL's USVString conversion runs the argument's own toString before parsing, and it throws TypeError when the result does not parse",
      trustOwner: "@mizchi/uneffect",
    }),
    ...(["Event", "CustomEvent"] as const).map((name) => reviewed("dom", {
      symbol: { module: "global", export: name },
      semantics: { schema: "uneffect-semantic-primitives/v1", primitives: [{ kind: "result", refinement: { kind: "fresh" } }] },
      trustReason: `The ${name} constructor has no step of its own that throws, and its init dictionary is optional: omitted, Web IDL performs no Get at all, and every member it declares is a boolean or an untyped detail that no conversion rejects. An init object whose members are accessors rather than data properties, or one that is neither an object nor nullish, is outside this claim`,
      trustOwner: "@mizchi/uneffect",
    })),
    reviewed("dom", {
      symbol: { module: "global", export: "MessageEvent" },
      semantics: { schema: "uneffect-semantic-primitives/v1", primitives: [
        { kind: "invoke-user-code" }, { kind: "result", refinement: { kind: "fresh" } },
      ] },
      trustReason: "The MessageEvent init dictionary declares a `ports` sequence, whose Web IDL conversion runs the argument's own iterator protocol",
      trustOwner: "@mizchi/uneffect",
    }),
    // ECMAScript URI handling: each function throws URIError on a malformed sequence and performs nothing else.
    ...(["encodeURI", "encodeURIComponent", "decodeURI", "decodeURIComponent"] as const).map((name) => reviewed("javascript", {
      symbol: { module: "global", export: name },
      semantics: { schema: "uneffect-semantic-primitives/v1", primitives: [{ kind: "throw", error: "URIError" }] },
      trustReason: `ECMAScript ${name} throws URIError on a malformed URI sequence, and performs nothing else for the string, number and boolean arguments a checked program can pass; its ToString step reaches user code only for a value the type system did not constrain`,
      trustOwner: "@mizchi/uneffect",
    })),
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
      { kind: "callback", target: { kind: "argument", index: 0 }, timing: "deferred", queue: "scheduler-task", cardinality: "0..1", callable: "required", invocationArguments: [] },
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
    ...browserPlatformDefinitions(),
    ...domPropertyDefinitions(),
    reviewed("dom", { symbol: { module: "lib.dom", export: "Document#cookie" }, semantics: { schema: "uneffect-semantic-primitives/v1", primitives: [{ kind: "property", read: [{ kind: "effect", capability: "CookieRead" }], write: [{ kind: "effect", capability: "CookieWrite", scope: { kind: "literal-key", target: { kind: "assigned-value" }, format: "cookie-assignment" } }] }] } }),
    reviewed("dom", { symbol: { module: "lib.dom", export: "Storage#length" }, semantics: { schema: "uneffect-semantic-primitives/v1", primitives: [{ kind: "property", read: [{ kind: "effect", capability: "LocalStorageRead" }], write: [] }] } }),
    reviewed("dom", { symbol: { module: "lib.dom", export: "Storage#getItem" }, semantics: effectSemantics("LocalStorageRead", { scope: { kind: "literal-key", target: { kind: "argument", index: 0 } } }) }),
    reviewed("dom", { symbol: { module: "lib.dom", export: "Storage#key" }, semantics: effectSemantics("LocalStorageRead") }),
    ...["setItem", "removeItem"].map((name) => reviewed("dom", { symbol: { module: "lib.dom", export: `Storage#${name}` }, semantics: effectSemantics("LocalStorageWrite", { scope: { kind: "literal-key", target: { kind: "argument", index: 0 } } }) })),
    reviewed("dom", { symbol: { module: "lib.dom", export: "Storage#clear" }, semantics: effectSemantics("LocalStorageWrite") }),
    reviewed("dom", { symbol: { module: "lib.dom", export: "Navigator#sendBeacon" }, semantics: effectSemantics("Net", {
      scope: { kind: "network", format: "http-request", target: { kind: "argument", index: 0 } },
    }) }),
    reviewed("dom", { symbol: { module: "global", export: "WebSocket" }, semantics: { schema: "uneffect-semantic-primitives/v1", primitives: [
      { kind: "effect", capability: "Net", scope: { kind: "network", format: "websocket", target: { kind: "argument", index: 0 } } },
      { kind: "result", refinement: { kind: "resource", family: "websocket" } },
      { kind: "acquire", resource: "websocket", target: { kind: "result" } },
      { kind: "protocol", name: "websocket", transition: "connect", inputs: { url: { kind: "argument", index: 0 } } },
    ] } }),
    reviewed("dom", { symbol: { module: "lib.dom", export: "WebSocket#send" }, semantics: { schema: "uneffect-semantic-primitives/v1", primitives: [
      { kind: "use", resource: "websocket", target: { kind: "receiver" } },
      { kind: "protocol", name: "websocket", transition: "send", inputs: { socket: { kind: "receiver" }, data: { kind: "argument", index: 0 } } },
    ] } }),
    reviewed("dom", { symbol: { module: "lib.dom", export: "WebSocket#close" }, semantics: { schema: "uneffect-semantic-primitives/v1", primitives: [
      { kind: "release", resource: "websocket", target: { kind: "receiver" } },
      { kind: "protocol", name: "websocket", transition: "close", inputs: { socket: { kind: "receiver" } } },
    ] } }),
    reviewed("dom", { symbol: { module: "global", export: "structuredClone" }, semantics: { schema: "uneffect-semantic-primitives/v1", primitives: [
      { kind: "clone", target: { kind: "argument", index: 0 } },
      { kind: "transfer", target: { kind: "property", target: { kind: "argument", index: 1 }, key: "transfer" }, optional: true },
      { kind: "throw", error: "DOMException" },
    ] } }),
    ...(["ReadableStreamDefaultReader", "ReadableStreamBYOBReader"] as const).map((owner) => reviewed("dom", {
      symbol: { module: "lib.dom", export: `${owner}#releaseLock` }, semantics: { schema: "uneffect-semantic-primitives/v1", primitives: [
        { kind: "release", resource: "stream-reader", target: { kind: "receiver" } },
        { kind: "protocol", name: "stream", transition: "release-readable", inputs: { reader: { kind: "receiver" } } },
      ] },
    })),
    ...(["ReadableStreamDefaultReader", "ReadableStreamBYOBReader"] as const).map((owner) => reviewed("dom", {
      symbol: { module: "lib.dom", export: `${owner}#read` }, semantics: { schema: "uneffect-semantic-primitives/v1", primitives: [
        { kind: "use", resource: "stream-reader", target: { kind: "receiver" } },
        { kind: "protocol", name: "stream", transition: "read", inputs: { reader: { kind: "receiver" } } },
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
    ...(["write", "abort", "close"] as const).map((name) => reviewed("dom", {
      symbol: { module: "lib.dom", export: `WritableStreamDefaultWriter#${name}` }, semantics: { schema: "uneffect-semantic-primitives/v1", primitives: [
        { kind: "use", resource: "stream-writer", target: { kind: "receiver" } },
        { kind: "protocol", name: "stream", transition: name, inputs: { writer: { kind: "receiver" } } },
      ] },
    })),
    reviewed("dom", { symbol: { module: "lib.dom", export: "ReadableStreamGenericReader#cancel" }, semantics: { schema: "uneffect-semantic-primitives/v1", primitives: [
      { kind: "use", resource: "stream-reader", target: { kind: "receiver" } },
      { kind: "protocol", name: "stream", transition: "cancel-readable", inputs: { reader: { kind: "receiver" } } },
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
        { kind: "callback", target: { kind: "argument", index: 1 }, timing: "deferred", queue: owner === "AsyncDisposableStack" ? "microtask" : "current", cardinality: "0..1", callable: "required", invocationArguments: [{ kind: "argument", index: 0 }] },
        { kind: "result", refinement: { kind: "alias", target: { kind: "argument", index: 0 } } },
        { kind: "protocol", name: "disposal-stack", transition: "register", inputs: { stack: { kind: "receiver" }, resource: { kind: "argument", index: 0 } } },
      ] } }),
      reviewed("javascript", { symbol: { module: "lib.es", export: `${owner}#defer` }, semantics: { schema: "uneffect-semantic-primitives/v1", primitives: [
        { kind: "callback", target: { kind: "argument", index: 0 }, timing: "deferred", queue: owner === "AsyncDisposableStack" ? "microtask" : "current", cardinality: "0..1", callable: "required", invocationArguments: [] },
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
    ...["Array#copyWithin", "Array#fill", "Array#pop", "Array#push", "Array#reverse", "Array#shift", "Array#splice", "Array#unshift", "Map#clear", "Map#delete", "Map#set", "Set#add", "Set#clear", "Set#delete", "WeakMap#delete", "WeakMap#set", "WeakSet#add", "WeakSet#delete"].map((name) => reviewed("javascript", {
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
      symbol: { module: "oxc-parser", export: "parseSync" },
      runtime: { kind: "package", version: "0.148.0" },
      trustReason: "Oxc 0.148.0 parseSync parses source text into an ESTree AST without executing the parsed program",
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
    ...([
      { module: "typescript", version: "6.0.3" },
      { module: "@typescript/typescript6", version: "6.0.2" },
    ] as const).flatMap(({ module, version }) => [
      reviewed("package", {
        symbol: { module, export: "Program#emit" }, runtime: { kind: "package", version },
        semantics: { schema: "uneffect-semantic-primitives/v1", primitives: [{ kind: "callback", target: { kind: "argument", index: 1 }, timing: "sync", queue: "current", cardinality: "0..1", callable: "optional" }] },
        trustReason: `TypeScript Compiler API ${version} Program.emit invokes writeFile during the synchronous emit operation`, trustOwner: "@mizchi/uneffect",
      }),
      ...([
        ["Node#forEachChild", [0, 1], [1]], ["forEachChild", [1, 2], [2]],
        ["visitNode", [1]], ["visitEachChild", [1]],
      ] as const).map(([name, callbackArguments, optionalCallbackArguments]) => reviewed("package", {
        symbol: { module, export: name }, runtime: { kind: "package", version },
        semantics: { schema: "uneffect-semantic-primitives/v1", primitives: callbackArguments.map((index) => ({
          kind: "callback" as const, target: { kind: "argument" as const, index }, timing: "sync" as const, queue: "current" as const, cardinality: "0..n" as const,
          ...((optionalCallbackArguments as readonly number[] | undefined)?.includes(index) ? { callable: "optional" as const } : { callable: "required" as const }),
        })) },
        trustReason: `TypeScript Compiler API ${version} ${name} invokes its visitor callbacks synchronously`, trustOwner: "@mizchi/uneffect",
      })),
      reviewed("package", {
        symbol: { module, export: "transform" }, runtime: { kind: "package", version },
        semantics: { schema: "uneffect-semantic-primitives/v1", primitives: [{
          kind: "callback", target: { kind: "array-elements", target: { kind: "argument", index: 1 } },
          timing: "sync", queue: "current", cardinality: "0..n", callable: "required", returnDepth: 1,
        }] },
        trustReason: `TypeScript Compiler API ${version} transform synchronously invokes each array-literal TransformerFactory and its returned Transformer`, trustOwner: "@mizchi/uneffect",
      }),
    ]),
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
