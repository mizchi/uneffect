# Deno-compatible permission capabilities

Uneffect aligns operating-system and runtime authority categories with Deno's permission model. The goal is semantic compatibility: a verified Uneffect requirement should be projectable to a Deno permission policy without changing what resource is authorized.

This does not mean every Uneffect effect is a Deno permission. `Fetch`, DOM operations, mutation regions, synchronous throws, and transfer ownership remain higher-level semantic effects.

## Capability vocabulary

| Uneffect capability | Deno permission | Scope domain |
|---|---|---|
| `FsRead<...>` | `read` / `--allow-read` | files and directory subtrees |
| `FsWrite<...>` | `write` / `--allow-write` | files and directory subtrees |
| `Net<...>` | `net` / `--allow-net` | host or IP, optionally with port |
| `Env<...>` | `env` / `--allow-env` | environment-variable names and supported suffix wildcards |
| `Run<...>` | `run` / `--allow-run` | executable names or unscoped execution |
| `Sys<...>` | `sys` / `--allow-sys` | Deno system-information API names |
| `Ffi<...>` | `ffi` / `--allow-ffi` | dynamic-library files and directories |
| `Import<...>` | `import` / `--allow-import` | HTTPS module hosts |

An unparameterized capability means unscoped access to the entire category:

```ts
/* uneffect:capability effect FsRead | Net | Env */
```

Uneffect does not encode this as a magic `"*"` scope because Deno's scope languages differ by category and a wildcard can have category-specific meaning.

## Uniform set representation

Every permission uses the same outer representation even though its atoms have different semantics:

```text
Capability(name, [All | Finite(atoms) | Unknown])
```

Examples:

```ts
/* uneffect:capability effect FsRead<"./data" | "./config.json"> */
/* uneffect:capability effect Net<"api.example.com:443" | "*.example.net"> */
/* uneffect:capability effect Env<"HOME" | "AWS_*"> */
/* uneffect:capability effect Run<"git" | "curl"> */
/* uneffect:capability effect Sys<hostname | cpus> */
```

The same generic code performs set union, subset checks, unknown propagation, and unused-authority diagnostics. A versioned schema selects the atom domain. Both the TypeScript prototype and Rust core now use registries for parsing and containment; builtin and user-defined effects take the same path:

| Capability | Argument domain | Atom containment |
|---|---|---|
| `FsRead`, `FsWrite`, `Ffi` | `PathSet` | normalized file/directory containment |
| `Net`, `Import` | `HostSet` | host/IP/port and subdomain rules |
| `Env` | `EnvNameSet` | exact name or supported suffix wildcard |
| `Run` | `ProgramSet` | normalized executable identity |
| `Sys` | `EnumSet<SysApi>` | finite membership |

For Node targets, the effect checker connects this domain to the declaration
identity of `process.env`. Property access and literal element access infer an
exact name, and a finite string-literal union key infers the corresponding
finite set. A general string key or direct access to the environment object
requires broad `Env`. Reads, assignments, and `delete` use the same Deno
authority; environment writes do not additionally require a `Mutate` region.
A locally shadowed object named `process` is not classified as environment
authority.

The Rust and TypeScript domains implement host/IP/optional-port scopes, `*.example.com` subdomain containment, final-`*` environment prefixes, target-aware Windows case folding, and validation of the finite `Sys` vocabulary.

`projectDenoPermissions` converts verified positive requirements plus a separate deployment deny policy into deterministic `--allow-*` and `--deny-*` arguments. Unknown sets fail projection. Symbolic path anchors require explicit bindings, except `$TEMP`, which may be derived from an explicit Node/Deno target profile. Projection never reads the analyzer process environment implicitly.

The projection artifact includes a SHA-256 digest of sorted resolved anchor bindings, target runtime/OS identity, and path platform. Changing `$WORKSPACE_ROOT`, `$CWD`, `$TEMP`, or another binding therefore invalidates downstream verification evidence. TypeScript path parsing normalizes separators and dot segments and rejects parent traversal, unknown `$NAME` anchors, and wildcards other than a final `/**`.

A bare capability is the common `All` form:

```text
FsRead == FsRead<All>
Net    == Net<All>
```

`All` is an IR value, not a quoted pattern atom. This avoids confusing an unrestricted category with category-specific wildcard syntax.

## Filesystem permissions

```ts
/* uneffect:capability effect FsRead<"./data"> | FsWrite<"./cache"> */
```

Path atoms may start with a reserved symbolic anchor:

```ts
/* uneffect:capability effect FsRead<"$WORKSPACE_ROOT/**"> */
/* uneffect:capability effect FsWrite<"$CWD/.cache/**"> */
/* uneffect:capability effect FsRead<"$PACKAGE_ROOT/assets/**"> */
/* uneffect:capability effect FsRead<"$SOURCE_DIR/fixtures/**"> */
```

These are Uneffect symbols, not shell environment-variable expansion. The initial reserved set is:

| Anchor | Meaning |
|---|---|
| `$WORKSPACE_ROOT` | Explicit analysis workspace root |
| `$PACKAGE_ROOT` | Root of the package owning the source file |
| `$SOURCE_DIR` | Directory containing the annotated source file |
| `$CWD` | Working directory bound by the analysis invocation |
| `$TEMP` | Default temporary-directory root for the selected runtime/OS profile |

Arbitrary names such as `$HOME` or `$SECRET_PATH` are rejected unless a future configuration schema explicitly declares them as trusted path anchors. This prevents the same annotation from silently changing authority when the process environment changes.

`$WORKSPACE_ROOT` is preferred for repository policies. `$CWD` is supported for Deno CLI compatibility, but it is invocation-dependent. A verified artifact records both the symbolic atom and its resolved absolute binding; changing the binding invalidates the artifact.

```text
PathAtom {
  anchor: WorkspaceRoot | PackageRoot | SourceDir | Cwd | Absolute
  segments: [...]
  recursive: bool
}
```

The Rust core implements this symbolic form, exact path equality, final `/**` recursive containment, rejection of unknown anchors and traversal, explicit binding-based cross-anchor containment, and target case policy. TypeScript projection resolves the selected target bindings and records their digest. Symlink identity remains outside lexical path authority and must be handled by deployment policy or a filesystem-aware trust boundary.

Anchor resolution precedes path normalization and containment. If the relationship between two anchors is unknown, Uneffect does not guess containment. For example, `$PACKAGE_ROOT/** <= $WORKSPACE_ROOT/**` is proved only when the current analysis configuration records that package root as a descendant of workspace root.

The `/**` suffix is accepted as an explicit recursive selector. For Deno projection, a recursive directory atom can be emitted as the directory itself because Deno path permissions include descendants:

```text
FsRead<"$WORKSPACE_ROOT/data/**">
  -> --allow-read=<resolved-workspace>/data
```

### Temporary-directory root

`$TEMP` represents the root returned by the target runtime's temporary-directory lookup:

```ts
import { tmpdir } from "node:os"

const root = tmpdir()
// Uneffect refinement: Path<"$TEMP">
```

The builtin overlay contains the equivalent declaration:

```ts
/* uneffect:runtime returns Path<"$TEMP"> */
declare function tmpdir(): string
```

The TypeChecker frontend resolves both named aliases and namespace calls to the stable `node:os#tmpdir` builtin key and attaches this result refinement at the call-expression span. A shadowed local `tmpdir` symbol is not refined.

On Node, Windows checks `TEMP` before `TMP`, then falls back to the system Windows directory. Non-Windows platforms check `TMPDIR`, `TMP`, and `TEMP` in that order, then fall back to `/tmp`. Uneffect records this as a target-profile anchor resolver rather than expanding those environment variables directly in source annotations.

Cross-target analysis must not bind `$TEMP` from the analyzer host. A verified artifact includes the selected runtime/OS profile and the resolved anchor when resolution is concrete. If only the symbolic profile is known, path containment remains symbolic.

`$TEMP` denotes a shared system location, not a confidentiality guarantee. Files created beneath it still require safe creation semantics and may need ownership, mode, and symlink checks.

A directory permission includes its descendants. This is path containment, not the URL glob language used by scoped Fetch. Paths are resolved and normalized relative to an explicit analysis working directory before comparison.

To match Deno semantics, the model must account for these special cases:

- permission is checked against the symlink location, with Deno's protected-system-path restrictions;
- symlink creation requires unscoped read and write authority;
- statically analyzable module graph reads and selected runtime-managed storage do not map mechanically to ordinary file calls;
- platform path case and separator behavior are part of the analysis target.

Node `node:fs` and Deno filesystem APIs instantiate the same `FsRead`/`FsWrite` capability contracts after symbol resolution.

## Network and Fetch

Deno `net` authority is host-oriented:

```ts
/* uneffect:capability effect Net<"api.example.com:443"> */
```

It does not include HTTP method or URL path. Uneffect therefore keeps `Net` and `Fetch` separate:

```ts
/* uneffect:capability effect Net<"api.example.com:443"> */ /* uneffect:temporal  */
```

A Fetch call can instantiate both effects. `Net` answers whether the runtime connection is authorized; `Fetch` answers whether the application-level HTTP operation and path are authorized.

The TypeScript prototype now infers `GET` when `RequestInit.method` is absent, preserves literal methods and absolute literal URLs, and emits `Net<"host:port">` independently. Dynamic methods, URLs, object spreads, and relative URLs without a known base become explicit `Unknown<reason>` argument sets; they are never treated as empty authority.

Deno network scopes support exact hostnames/IP addresses, optional ports, IPv6 literals, and wildcard subdomains such as `*.example.com`. They do not use the Fetch URL-path glob semantics. DNS resolution, listeners, TCP/UDP, and HTTP requests all consume `Net` authority.

## Environment

```ts
/* uneffect:capability effect Env<"HOME" | "AWS_*"> */
```

Deno's environment permission gates both reads and writes. Uneffect may retain `Read(Env)` and `Write(Env)` semantic footprints for optimization, while the domain capability remains `Env`.

Environment-name matching is case-insensitive on Windows and case-sensitive on other targets. `--ignore-env` is a deployment behavior that returns `undefined`; it is not evidence that an environment read is absent.

## Subprocesses

```ts
/* uneffect:capability effect Run<"git" | "curl"> */
```

Child processes are outside the parent Deno sandbox. `Run` is therefore an authority boundary that also invalidates closed-world assumptions about external state. A command carrying `LD_*` or `DYLD_*` dynamic-loader variables requires unscoped `Run`, matching Deno's escalation rule.

Program arguments are not part of Deno's permission scope. Uneffect may later add an application-specific command contract, but it must not be confused with Deno-compatible `Run` authority.

## System information

```ts
/* uneffect:capability effect Sys<hostname | cpus | networkInterfaces> */
```

`Sys` uses Deno's finite descriptor vocabulary, including operations such as `hostname`, `osRelease`, `osUptime`, `loadavg`, `networkInterfaces`, `systemMemoryInfo`, `uid`, `gid`, `username`, `cpus`, and `homedir`. Node compatibility APIs map to the same capability names when they expose equivalent host information.

The builtin overlay currently maps `node:os` `hostname`, `release`, `uptime`,
`loadavg`, `networkInterfaces`, `totalmem`, `freemem`, `cpus`,
`availableParallelism`, `homedir`, and `userInfo` to those descriptors by
TypeChecker declaration identity. For example, `userInfo()` requires the
finite union `Sys<username | uid | gid | homedir>`. Same-named application
functions are not classified as system authority.

## FFI

```ts
/* uneffect:capability effect Ffi<"./native/libexample.so"> */
```

FFI scopes use filesystem path containment, but FFI is not equivalent to file reading. Loaded native code runs with the operating-system authority of the process and can bypass the Deno sandbox. Any verified summary reaching FFI must record an explicit sandbox-escape footprint and stop optimizer assumptions that depend on closed-world state.

## Remote imports

```ts
/* uneffect:capability effect Import<"example.com"> */
```

`Import` is distinct from `Net`. It authorizes loading executable module code from HTTPS hosts. Static graph loading, analyzable literal dynamic imports, Deno's default trusted registries, and computed dynamic imports have different runtime permission behavior. Uneffect records the import authority at the relevant module or dynamic-import boundary and applies the selected Deno policy profile when projecting deployment permissions.

## Allow and deny policy

Function summaries contain positive requirements only. Deno allow, deny, and ignore rules belong to a deployment policy:

```text
required(program) <= effectiveAllow(policy)
effectiveAllow = allow minus deny
deny takes precedence
```

Deployment policies reuse the same capability sets:

```ts
type PermissionPolicy = {
  allow: CapabilitySetByName
  deny: CapabilitySetByName
  ignore?: CapabilitySetByName
}
```

Policy checking therefore shares normalization and containment with function-effect checking rather than translating through an unrelated permission representation.

Comparison always receives a target policy. Windows folds filesystem and environment-variable case; POSIX remains case-sensitive. Symbolic anchors are resolved before containment, allowing cross-anchor proofs only when the supplied bindings resolve to overlapping target paths.

Generated permission artifacts include `sandboxEscapes`. `Ffi` always records a native-code escape. If scoped `Run` is combined with a platform dynamic-loader environment variable, projection escalates it to unscoped `--allow-run` and records why; retaining the narrower command list would be misleading.

This separation prevents a library function from claiming that an application-level deny rule has been installed. The projection backend emits Deno CLI allow/deny flags from verified requirements and retains the normalized scopes and binding digest in its artifact. A `deno.json` serializer can consume the same projection later.

## Source of truth and versioning

The compatibility target is the versioned Deno permission reference and permission descriptor APIs. Uneffect's builtin contract digest records the targeted Deno version because permission categories, default exemptions, and scope rules can evolve.

Primary reference: [Deno permissions](https://docs.deno.com/runtime/reference/permissions/).
