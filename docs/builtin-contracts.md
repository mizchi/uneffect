# Builtin semantic contracts

Uneffect annotates existing platform APIs without requiring application wrappers. A semantic overlay maps TypeChecker-resolved builtin symbols and overloads to effect templates.

The prototype exposes a `FrontendSymbolAdapter` boundary and a TypeScript implementation. The implementation indexes registry exports through the TypeChecker and compares resolved `ts.Symbol` identities, so renamed imports and namespace access resolve to the same stable `{ module, export }` key while a shadowing local function does not. `node:os.tmpdir()` call sites now receive `Path<"$TEMP">` result refinements through this path. Corsa should provide the same `ResolvedCallSite` contract from its symbol/context mapper rather than reproducing TypeScript source spelling rules.

The standalone analyzer and CLI also construct a TypeScript Program; there is no fallback recognizer based on callee source text. Array/Map/Set mutation methods are declaration-symbol overlays, so a user-defined method named `push` is not classified as an Array mutation.

A builtin contract may carry more than one semantic projection. In the current
Node slice, reviewed one-shot completion APIs in `node:fs` still emit
`FsRead`/`FsWrite`, while their final callback argument also becomes a
poll-phase job in the Node temporal model. This includes access/stat,
file/path read and write, copy, descriptor read/write, and path mutation APIs.
Sync, `node:fs/promises`, watcher, and stream symbols retain only their
applicable effect/Promise semantics.

The program-wide call graph consumes the same resolved contract to classify
these completion callbacks as deferred. Effects in a callback are therefore
composed into the registering function (for example, `FsRead | Console`), and
renamed or namespace imports do not degrade the summary to unknown timing.
The legacy `analyzeEffects(fileName, text)` convenience path remains a shallow
single-source check; proof/adoption tooling uses `analyzeProgramEffects`.

## Contract lookup

String matching such as `callee.getText() === "document.createElement"` is insufficient because of shadowing, aliases, inheritance, and overloads. The native frontend must resolve a call to a stable symbol key:

```ts
type SymbolKey = {
  library: "es" | "dom" | "html" | "node"
  interface?: string
  member: string
  overload?: string
}
```

Contracts are curated overlays, generated into Rust data where practical:

```text
builtins/
  es.json
  dom.json
  html.json
  node-fs.json
  worker.json
```

Web IDL or `lib.dom.d.ts` can generate the symbol inventory, but signatures alone cannot determine effects. CI should fingerprint the source library and report newly added or changed APIs that lack a reviewed semantic classification.

## DOM operation lattice

DOM effects use operation and identity scope dimensions:

```text
Dom<Operations, Scope>
```

The initial operation set is:

| Operation | Representative APIs | Notes |
|---|---|---|
| `Read` | `querySelector`, `children`, `getAttribute` | Reads logical DOM state |
| `LayoutRead` | `getBoundingClientRect`, `offsetWidth`, `getComputedStyle` | May force style/layout work |
| `ValueWrite` | `value=`, `textContent=`, `setAttribute`, `classList.add` | Changes values without classifying tree ownership |
| `TreeWrite` | `appendChild`, `remove`, `replaceChildren`, `insertBefore` | Changes parent/child relationships |
| `Create` | `createElement`, `createTextNode`, `createDocumentFragment` | Creates identity, usually detached |
| `Listen` | `addEventListener`, `removeEventListener` | Mutates listener state |
| `Dispatch` | `dispatchEvent`, `click`, `focus` | Can synchronously invoke user code |
| `Parse` | `innerHTML=`, `insertAdjacentHTML`, `DOMParser.parseFromString` | Parses markup and may cross security boundaries |

Examples:

```ts
/* uneffect: effect Dom<Read, typeof root> */
function find(root: Element) {
  return root.querySelector(".item")
}

/* uneffect: effect Dom<ValueWrite, typeof input> */
function clear(input: HTMLInputElement) {
  input.value = ""
}

/* uneffect: effect Dom<TreeWrite, typeof root> */
function mount(root: Element, child: Node) {
  root.appendChild(child)
}
```

### Scope policy

Proof-grade DOM scopes are symbol/identity regions such as `typeof root` or builtin regions such as `document`. CSS selectors are query refinements, not authority boundaries:

```text
Dom<Query<".item">, typeof root>
```

The TypeChecker adapter now recognizes DOM members by their declaring `lib.dom.d.ts` interface symbol (including mixins such as `ParentNode` and `ChildNode`). Calls produce `Dom<Operation, typeof receiver>`. Tree operations additionally mutate the receiver and transferred child regions; contracts that may synchronously invoke callbacks or custom-element reactions emit `InvokeUserCode`. Literal selector arguments are retained as `{ kind: "css-selector" }` query refinements but never used to authorize a different receiver.

The registry pins the consumed `lib.dom.d.ts` SHA-256 and TypeScript version. `auditBuiltinDeclarationDrift` reports a missing or changed declaration library so new platform APIs cannot silently inherit purity or an old classification.

Selector results depend on mutable DOM state, and general selector-language inclusion is not the desired proof obligation. A selector records how a region is searched; it does not prove that future reads or writes are confined to a stable set of matching nodes.

Attribute or property qualifiers may use the restricted string-glob lattice:

```text
Dom<ValueWrite<"value">, typeof input>
Dom<ValueWrite<"aria-*">, typeof element>
```

### Compound contracts

A builtin frequently expands to multiple facts:

```text
Document.createElement(tag)
  => Dom<Create<tag>, receiver>
   + Allocate(result)
   + Throw<DOMException>
   + possibly InvokeUserCode(CustomElementReaction)

Node.appendChild(child)
  => Dom<TreeWrite, receiver>
   + Mutate(child.parent relation)
   + Throw<DOMException>
   + possibly InvokeUserCode(CustomElementReaction)
```

User-code reentrancy must be explicit. Getters, proxies, event dispatch, custom element reactions, and conversions are not safely summarized as plain reads or writes.

The frontend conservatively emits `InvokeUserCode` for declared accessors, `any`/`unknown` receivers, direct `new Proxy` receivers, computed keys that may coerce, and coercive operators with non-primitive operands. A Proxy can inhabit its target's static type, so absence of this effect is not a general proof that an escaped object is non-proxied; that stronger conclusion requires later escape and evidence analysis.

## Fetch authority

```ts
/* uneffect: effect Fetch<GET | POST, "https://api.example.com/v1/**"> */
```

The first parameter is a finite method set. The second is a set of normalized URL patterns. Literal requests infer exact scopes; analyzable template literals infer restricted glob scopes; fully dynamic URLs become unknown.

```text
Fetch<GET, "https://api.example.com/v1/users/1">
  <= Fetch<GET | POST, "https://api.example.com/v1/**">
```

Patterns initially support literal text, `*` within a path segment, and `**` across path segments. Scheme and host are required. Comparison occurs after WHATWG URL normalization. Redirect targets, DNS resolution, and runtime URL rewriting require separate authority facts.

## Structured clone and transfer

Worker messaging is a compound builtin contract:

```ts
worker.postMessage(message, [buffer])
```

```text
Worker<Post, typeof worker>
Clone<typeof message>
Transfer<typeof buffer>
Invalidate<typeof buffer>
Throw<DataCloneError>
```

`Clone` reads an object graph and may invoke accessors during serialization. `Transfer` is an ownership transition, not merely a mutation. The source reference enters a type-specific unavailable state:

```text
Available(ArrayBuffer) -> Detached
Available(MessagePort) -> Transferred
Available(OffscreenCanvas) -> Transferred
Available(Stream) -> TransferredOrLocked
```

The checker must reject a use after a transfer when the transfer definitely occurred, and conservatively invalidate facts when control flow makes the state uncertain. The same transfer template applies to `structuredClone(value, { transfer })`, `Worker.postMessage`, `MessagePort.postMessage`, and relevant service/window messaging APIs.

`SharedArrayBuffer` is shared rather than transferred and therefore requires a shared-memory/concurrency footprint instead of `Transfer`.

## User-defined builtins and effects

Projects may extend the registry without wrappers. A future configuration API should declare effect parameter domains and bind resolved symbols to templates:

```ts
export default defineUneffect({
  effects: {
    "app.Database": {
      parameters: [enumSet(["SELECT", "INSERT", "UPDATE", "DELETE"]), globSet()],
    },
  },
  builtins: [
    contract("app/db", "query", ({ args }) =>
      scoped("app.Database", methodFrom(args[0]), scopeFrom(args[1]))),
  ],
})
```

Configuration is compiled to the same neutral contract IR as platform builtins. Unknown effect names are warnings during gradual adoption and errors in strict mode.

## Versioning and trust

Every builtin contract records its source version and review status. A verified optimizer artifact must include the builtin-contract digest. Updating TypeScript, Node, DOM declarations, or a user overlay invalidates summaries derived from the previous digest.

## Normative references

- [WHATWG DOM Standard](https://dom.spec.whatwg.org/)
- [WHATWG HTML: Safe passing of structured data](https://html.spec.whatwg.org/multipage/structured-data.html)
- [WHATWG HTML: Web workers](https://html.spec.whatwg.org/multipage/workers.html)
- [WHATWG HTML: Channel messaging](https://html.spec.whatwg.org/multipage/web-messaging.html)
- TypeScript's versioned `lib.dom.d.ts`, used as the compiler-facing symbol inventory
