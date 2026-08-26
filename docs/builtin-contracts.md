# Builtin semantic contracts

Uneffect annotates existing platform APIs without requiring application wrappers. A semantic overlay maps TypeChecker-resolved builtin symbols and overloads to effect templates.

The prototype exposes a `FrontendSymbolAdapter` boundary and a TypeScript implementation. The implementation indexes registry exports through the TypeChecker and compares resolved `ts.Symbol` identities, so renamed imports and namespace access resolve to the same stable `{ module, export }` key while a shadowing local function does not. `node:os.tmpdir()` call sites now receive `Path<"$TEMP">` result refinements through this path. Corsa should provide the same `ResolvedCallSite` contract from its symbol/context mapper rather than reproducing TypeScript source spelling rules.

The standalone analyzer and CLI also construct a TypeScript Program; there is no fallback recognizer based on callee source text. Array/Map/Set mutation methods are declaration-symbol overlays, so a user-defined method named `push` is not classified as an Array mutation.

A builtin contract may carry more than one semantic projection. In the current
Node slice, reviewed one-shot completion APIs in `node:fs` still emit
`FsRead`/`FsWrite`, while their final callback argument also becomes a
poll-phase job in the Node temporal model. This includes access/stat,
file/path read and write, copy, descriptor read/write, and path mutation APIs.
`watch` and `watchFile` additionally become repeating poll jobs. Sync,
`node:fs/promises`, and stream symbols retain only their applicable
effect/Promise semantics.

The returned `FSWatcher` is an object-valued watcher handle in the temporal
overlay. `FSWatcher.close()` is a receiver-handle cancellation contract, not a
`Timer` capability. A direct definite close suppresses future modeled watcher
arrivals; dynamic lifecycle joins remain conservative.

The program-wide call graph consumes the same resolved contract to classify
these completion callbacks as deferred. Effects in a callback are therefore
composed into the registering function (for example, `FsRead | Console`), and
renamed or namespace imports do not degrade the summary to unknown timing.
The legacy `analyzeEffects(fileName, text)` convenience path remains a shallow
single-source check; proof/adoption tooling uses `analyzeProgramEffects`.

## Module initialization contracts

A static runtime import executes package initialization before application
code. Uneffect therefore does not infer an empty effect merely because an
external package's implementation is absent from the current TypeScript
Program. An unregistered external import makes the importing module summary
`unknown`, and that evidence propagates through its local importers.

The versioned registry may contain a reviewed exact package name plus exact
package version, or a trailing `*` prefix such as `node:*` plus Node runtime
major, together with its initialization may-effects, owner, reason, and
optional review expiration. Uneffect resolves the import from the containing
source, finds that package's manifest, and rejects a missing or mismatched
version as `unknown`. A match changes evidence to `trusted`, never `verified`,
and `verifyUneffectProject` records the module and reviewed version in the
`module-initialization` assumption domain. Type-only imports and exports do not
execute module initialization and are ignored. Dynamic external imports,
declaration-only resolution, conditional exports, exact ESM/TLA ordering, and
unreviewed transitive package code remain outside this contract. Exact pins are
deliberately conservative: dependency or Node-major upgrades require review
and a registry update before assurance can pass again.

Applications may extend the reviewed registry through the programmatic API.
This is intended for internal packages whose initialization behavior has an
identified reviewer and maintenance owner:

```ts
import {
  builtinContractRegistry,
  extendBuiltinContractRegistry,
  verifyUneffectProject,
} from "@mizchi/uneffect"

const builtinRegistry = extendBuiltinContractRegistry(builtinContractRegistry, {
  moduleInitializations: [{
    module: "@acme/telemetry",
    runtime: { kind: "package", version: "4.2.1" },
    effects: ['Net<"intake.example.com:443">'],
    evidence: "trusted",
    trustReason: "reviewed package initialization",
    trustOwner: "observability-platform",
    trustExpiresOn: "2027-01-01",
  }],
})

const result = await verifyUneffectProject({
  files: { "src/main.ts": source },
  builtinRegistry,
})
```

Caller entries precede the default registry. An exact module contract shadows
a wildcard contract even when its runtime version does not match; the mismatch
therefore fails closed instead of silently falling back to a broader rule.
Declared effects are reviewed may-effects, not an implementation proof. The
same registry must be supplied when creating or validating persisted evidence.
Loading these extensions from a CLI configuration file is not implemented yet.

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
| `AttributeRead` | `getAttribute`, `hasAttribute` | Reads serialized element attributes |
| `AttributeWrite` | `setAttribute`, `removeAttribute`, `toggleAttribute` | Changes serialized element attributes |
| `NodeRead` | `querySelector`, `children`, `parentNode` | Reads node identity or tree topology |
| `NodeWrite` | `appendChild`, `remove`, `replaceChildren`, `insertBefore` | Changes parent/child relationships |
| `TextRead` | `textContent`, `nodeValue`, `CharacterData.data` | Reads textual node content |
| `TextWrite` | `textContent=`, `nodeValue=`, `CharacterData.replaceData` | Changes textual node content |
| `PropertyRead` | `input.value`, `element.id` | Reads a Web IDL property rather than its attribute |
| `PropertyWrite` | `input.value=`, `element.id=` | Changes a Web IDL property rather than its attribute |
| `LayoutRead` | `getBoundingClientRect`, `offsetWidth`, `getComputedStyle` | May force style/layout work |
| `Create` | `createElement`, `createTextNode`, `createDocumentFragment` | Creates identity, usually detached |
| `Listen` | `addEventListener`, `removeEventListener` | Mutates listener state |
| `Dispatch` | `dispatchEvent`, `click`, `focus` | Can synchronously invoke user code |
| `Parse` | `innerHTML=`, `insertAdjacentHTML`, `DOMParser.parseFromString` | Parses markup and may cross security boundaries |

Examples:

```ts
/* uneffect: effect Dom<NodeRead, typeof root> */
function find(root: Element) {
  return root.querySelector(".item")
}

/* uneffect: effect Dom<PropertyWrite, typeof input> | Mutate<typeof input> */
function clear(input: HTMLInputElement) {
  input.value = ""
}

/* uneffect: effect Dom<NodeWrite, typeof root> */
function mount(root: Element, child: Node) {
  root.appendChild(child)
}
```

The executable overlay currently resolves `Element.attributes`, reviewed
`Node`/`ParentNode` tree-topology properties, `Node.textContent`,
`Node.nodeValue`, `CharacterData.data`, and `HTMLInputElement.value` by
TypeScript symbol identity. Read-only topology properties produce `NodeRead`;
the live attribute collection produces `AttributeRead`; and character data
preserves `TextRead`/`TextWrite`. Dot access and a literal bracket key have the
same effect. Unknown or union computed keys on a DOM `Node` conservatively
require `Dom<All, typeof receiver>`. A
`textContent` write also has `NodeWrite` because it replaces child nodes, and
can invoke user code through host or proxy behavior. A same-named property on
a user-defined interface does not acquire a DOM effect.

### Scope policy

Proof-grade DOM scopes are symbol/identity regions such as `typeof root` or builtin regions such as `document`. CSS selectors are query refinements, not authority boundaries:

```text
Dom<Query<".item">, typeof root>
```

The TypeChecker adapter recognizes selected DOM calls by their declaring
`lib.dom.d.ts` interface symbol (including mixins such as `ParentNode` and
`ChildNode`). The reviewed set includes Element attribute inspection and
mutation, Node topology inspection and insertion/replacement, and
CharacterData range reads and writes. Calls produce
`Dom<Operation, typeof receiver>`. `NodeWrite` operations additionally mutate
the receiver and transferred or detached child regions. Attribute writes and
tree writes may synchronously run custom-element reactions, so their contracts
also emit `InvokeUserCode`. CharacterData writes mutate their receiver but do
not claim synchronous callback invocation. Literal selector arguments are
retained as `{ kind: "css-selector" }` query refinements but never used to
authorize a different receiver.

A call contract stores a non-empty `operations` array. This is also the
canonical representation for one-operation calls; there is no legacy scalar
field. Compound calls therefore retain every relevant category. `cloneNode`
is `NodeRead + Create`, `normalize` is `NodeWrite + TextWrite`,
`insertAdjacentText` is `TextWrite + NodeWrite`, and `insertAdjacentHTML` is
`Parse + NodeWrite`. The latter also carries `InvokeUserCode` because parsing
and insertion may synchronously run custom-element reactions.

The executable property overlay covers the reviewed attribute collection,
tree-topology properties, `textContent`, `nodeValue`, `CharacterData.data`, and
`HTMLInputElement.value`. `Element.innerHTML` and `ShadowRoot.innerHTML` reads
serialize node, attribute, and text state; writes parse markup, replace child
topology, mutate the receiver, and retain the custom-element invocation
boundary. Reviewed client/scroll/offset metric properties produce
`LayoutRead`. Other Web IDL properties remain unclassified; a dynamic key on a
DOM receiver falls back to `Dom<All, Scope>`.

`Element.outerHTML` separates its regions. Serialization reads node,
attribute, and text state from the Element subtree. Replacement parses in and
writes the `element.parentNode` topology region, mutates both that parent region
and the replaced Element identity, and retains `InvokeUserCode`. A detached
Element still receives this may-effect upper bound; the current frontend does
not prove parent presence to erase an impossible write path.

`Element.attributes` is a reviewed live-view result. Calls on its
`NamedNodeMap`, such as `getNamedItem`, `setNamedItem`, and `removeNamedItem`,
are projected back to the originating Element region for direct access and
cycle-safe immutable const aliases. Writes then emit `AttributeWrite`, mutate
the Element (and an inserted `Attr` where applicable), and retain the custom
element `InvokeUserCode` boundary. A reassigned `let`, a returned/passed live
view, computed method access, or an unknown collection origin is not projected;
its effects remain scoped to the collection expression.

The registry pins the consumed `lib.dom.d.ts` SHA-256 and TypeScript version. `auditBuiltinDeclarationDrift` reports a missing or changed declaration library so new platform APIs cannot silently inherit purity or an old classification.

Selector results depend on mutable DOM state, and general selector-language inclusion is not the desired proof obligation. A selector records how a region is searched; it does not prove that future reads or writes are confined to a stable set of matching nodes.

Attribute or property qualifiers may use the restricted string-glob lattice:

```text
Dom<PropertyWrite<"value">, typeof input>
Dom<AttributeWrite<"aria-*">, typeof element>
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
  => Dom<NodeWrite, receiver>
   + Mutate(child.parent relation)
   + Throw<DOMException>
   + possibly InvokeUserCode(CustomElementReaction)
```

User-code reentrancy must be explicit. Getters, proxies, event dispatch, custom element reactions, and conversions are not safely summarized as plain reads or writes.

The frontend conservatively emits `InvokeUserCode` for declared accessors, `any`/`unknown` receivers, direct `new Proxy` receivers, computed keys that may coerce, and coercive operators with non-primitive operands. A union whose every key constituent is string- or number-like does not add a coercion effect; for finite literal unions, every candidate property is still checked and any declared accessor retains `InvokeUserCode`. A Proxy can inhabit its target's static type, so absence of this effect is not a general proof that an escaped object is non-proxied; that stronger conclusion requires later escape and evidence analysis.

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
