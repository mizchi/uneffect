export type CapabilityAtom =
  | { kind: "token"; value: string }
  | { kind: "literal"; value: string }
  | { kind: "url"; value: string }
  | { kind: "path"; value: string }
  | { kind: "host"; value: string }
  | { kind: "env"; value: string }
  | { kind: "sys"; value: string }
  | { kind: "region"; value: string };

export type CapabilitySet =
  | { kind: "all" }
  | { kind: "finite"; atoms: CapabilityAtom[] }
  | { kind: "unknown"; reason: string };

export interface CapabilityEffect {
  kind: "capability";
  name: string;
  arguments: CapabilitySet[];
}

export interface MutateEffect { kind: "mutate"; region: string }
export interface ThrowEffect { kind: "throw"; errorType: string }
export type Effect = CapabilityEffect | MutateEffect | ThrowEffect;

export type AtomDomain = "token" | "literal" | "url" | "path" | "host" | "env" | "sys" | "region";
export interface EffectSchema { name: string; version: number; arguments: readonly AtomDomain[] }

const schemas = new Map<string, EffectSchema>([
  ...[
    "Console", "Storage", "Random", "Timer", "InvokeUserCode",
    "CookieRead", "CookieWrite", "LocalStorageRead", "LocalStorageWrite",
  ].map((name): [string, EffectSchema] => [name, { name, version: 1, arguments: [] }]),
  ["ScriptLoad", { name: "ScriptLoad", version: 1, arguments: ["token", "url"] }],
  ["ExecuteExternalCode", { name: "ExecuteExternalCode", version: 1, arguments: ["url", "literal"] }],
  ["Fetch", { name: "Fetch", version: 1, arguments: ["token", "url"] }],
  ["Dom", { name: "Dom", version: 1, arguments: ["token", "region"] }],
  ["Clone", { name: "Clone", version: 1, arguments: ["region"] }],
  ["Transfer", { name: "Transfer", version: 1, arguments: ["region"] }],
  ["SharedMemory", { name: "SharedMemory", version: 1, arguments: ["region"] }],
  ["FsRead", { name: "FsRead", version: 1, arguments: ["path"] }],
  ["FsWrite", { name: "FsWrite", version: 1, arguments: ["path"] }],
  ["Ffi", { name: "Ffi", version: 1, arguments: ["path"] }],
  ["Net", { name: "Net", version: 1, arguments: ["host"] }],
  ["Env", { name: "Env", version: 1, arguments: ["env"] }],
  ["Run", { name: "Run", version: 1, arguments: ["literal"] }],
  ["Sys", { name: "Sys", version: 1, arguments: ["sys"] }],
  ["Import", { name: "Import", version: 1, arguments: ["host"] }],
]);

export function effectSchema(name: string): EffectSchema | undefined {
  return schemas.get(name);
}

export function isKnownEffect(effect: Effect): boolean {
  return effect.kind !== "capability" || schemas.has(effect.name);
}

/** Reasons why an otherwise recognized capability still has an unresolved authority set. */
export function unknownCapabilityReasons(effect: Effect): string[] {
  return effect.kind === "capability"
    ? effect.arguments.flatMap((argument) => argument.kind === "unknown" ? [argument.reason] : [])
    : [];
}

export function registerEffectSchema(schema: EffectSchema): void {
  schemas.set(schema.name, { name: schema.name, version: schema.version, arguments: [...schema.arguments] });
}

/** Internal transaction support for declarative module installation. */
export function unregisterEffectSchema(name: string): void {
  schemas.delete(name);
}

export function splitTopLevel(input: string, separator: string): string[] {
  const values: string[] = [];
  let start = 0, angleDepth = 0, parenDepth = 0, bracketDepth = 0, braceDepth = 0, quote: string | undefined;
  for (let index = 0; index < input.length; index++) {
    const char = input[index]!;
    if (quote) {
      if (char === quote && input[index - 1] !== "\\") quote = undefined;
    } else if (char === '"' || char === "`" || (char === "'" && !/[\w$]/.test(input[index - 1] ?? ""))) quote = char;
    else if (char === "<") angleDepth++;
    else if (char === ">") angleDepth--;
    else if (char === "(") parenDepth++;
    else if (char === ")") parenDepth--;
    else if (char === "[") bracketDepth++;
    else if (char === "]") bracketDepth--;
    else if (char === "{") braceDepth++;
    else if (char === "}") braceDepth--;
    else if (char === separator && angleDepth === 0 && parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
      values.push(input.slice(start, index).trim());
      start = index + 1;
    }
  }
  values.push(input.slice(start).trim());
  if (values.some((value) => value.length === 0)) throw new Error("empty member in separated expression");
  return values;
}

function unquote(input: string): string | undefined {
  if (input.length < 2 || input[0] !== input.at(-1) || (input[0] !== '"' && input[0] !== "'")) return undefined;
  return input.slice(1, -1);
}

function atom(input: string, domain: AtomDomain): CapabilityAtom {
  const quoted = unquote(input);
  const value = quoted ?? input;
  if (domain === "region") {
    if (quoted !== undefined || !value.startsWith("typeof ")) throw new Error("region atoms require `typeof <reference>`");
    return { kind: "region", value: value.slice("typeof ".length).trim() };
  }
  if (domain === "token" && quoted === undefined) return { kind: "token", value };
  if (domain === "sys") {
    const descriptors = new Set(["hostname", "osRelease", "osUptime", "loadavg", "networkInterfaces", "systemMemoryInfo", "uid", "gid", "username", "cpus", "homedir"]);
    if (quoted !== undefined || !descriptors.has(value)) throw new Error(`unknown Deno Sys descriptor \`${value}\``);
    return { kind: "sys", value };
  }
  if ((domain === "host" || domain === "env" || domain === "url" || domain === "path") && quoted === undefined) throw new Error(`${domain} atoms must be string literals`);
  const normalized = domain === "url" ? normalizeUrlScope(value)
    : domain === "host" ? normalizeHostScope(value)
    : domain === "env" ? normalizeEnvScope(value)
    : domain === "path" ? normalizePathScope(value)
    : value;
  return { kind: domain === "token" ? "literal" : domain, value: normalized } as CapabilityAtom;
}

export function normalizeHostScope(value: string): string {
  const match = /^(\*\.)?(\[[^\]]+\]|[^:/*@\s]+)(?::(\d+))?$/.exec(value);
  if (!match) throw new Error(`invalid host scope: ${value}`);
  const port = match[3] === undefined ? "" : String(Number(match[3]));
  if (port && (Number(port) < 1 || Number(port) > 65535)) throw new Error(`invalid host port: ${value}`);
  return `${match[1] ?? ""}${match[2]!.toLowerCase()}${port ? `:${port}` : ""}`;
}

export function normalizeEnvScope(value: string): string {
  if (!/^[A-Za-z0-9_]+\*?$/.test(value)) throw new Error("environment scope supports only a final `*` wildcard");
  return value;
}

export function normalizePathScope(value: string): string {
  const normalized = value.replaceAll("\\", "/").replace(/\/+/g, "/");
  const anchor = /^\$([A-Z_]+)/.exec(normalized)?.[1];
  if (anchor && !["WORKSPACE_ROOT", "PACKAGE_ROOT", "SOURCE_DIR", "CWD", "TEMP"].includes(anchor)) {
    throw new Error(`unknown symbolic path anchor: ${anchor}`);
  }
  const segments = normalized.split("/");
  if (segments.includes("..")) throw new Error("path scope cannot contain parent traversal");
  if (segments.some((segment, index) => segment.includes("*") && !(segment === "**" && index === segments.length - 1))) {
    throw new Error("path scope supports only a final `/**` recursive selector");
  }
  return segments.filter((segment, index) => segment !== "." || index === 0).join("/");
}

export function normalizeUrlScope(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(`URL scope requires an absolute URL: ${value}`); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`unsupported URL scope scheme: ${url.protocol}`);
  if (url.username || url.password || url.hostname.includes("*")) throw new Error("URL scope forbids credentials and wildcard authorities");
  if (url.hash) throw new Error("URL scope fragments are not supported");
  if (url.search.includes("*")) throw new Error("URL scope query constraints must be exact");
  return url.toString().replace(/\/$/, url.pathname === "/" && !url.search ? "/" : "");
}

function set(input: string, domain?: AtomDomain): CapabilitySet {
  if (input === "All") return { kind: "all" };
  if (input.startsWith("Unknown<") && input.endsWith(">")) return { kind: "unknown", reason: input.slice(8, -1) };
  return {
    kind: "finite",
    atoms: splitTopLevel(input, "|").map((item) => atom(item, domain ?? (unquote(item) === undefined ? "token" : "literal"))),
  };
}

export function parseEffectExpression(input: string, localSchemas?: ReadonlyMap<string, EffectSchema>): Effect {
  const text = input.trim();
  if (text === "none") throw new Error("`none` denotes an empty effect set, not an effect");
  const mutate = /^Mutate<\s*typeof\s+(.+)>$/.exec(text);
  if (mutate) return { kind: "mutate", region: mutate[1]!.trim() };
  const thrown = /^Throw<(.+)>$/.exec(text);
  if (thrown) return { kind: "throw", errorType: thrown[1]!.trim() };
  const parameterized = /^([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)<([\s\S]+)>$/.exec(text);
  if (parameterized) {
    const name = parameterized[1]!, inputs = splitTopLevel(parameterized[2]!, ",");
    const schema = localSchemas?.get(name) ?? effectSchema(name);
    const arguments_ = inputs.map((value, index) => set(value, schema?.arguments[index]));
    if (name === "Fetch" && arguments_[0]?.kind === "finite") arguments_[0].atoms = arguments_[0].atoms.map((item) => item.kind === "token" && item.value.startsWith("Fetch.") ? { ...item, value: item.value.slice("Fetch.".length) } : item);
    return {
      kind: "capability", name,
      arguments: arguments_,
    };
  }
  if (!/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(text)) throw new Error(`invalid effect: ${text}`);
  const schema = localSchemas?.get(text) ?? effectSchema(text);
  return { kind: "capability", name: text, arguments: schema?.arguments.map(() => ({ kind: "all" })) ?? [] };
}

/** Parse an effect upper-bound set. `none` is the reserved spelling of the empty set. */
export function parseEffectSet(input: string, localSchemas?: ReadonlyMap<string, EffectSchema>): Effect[] {
  const terms = splitTopLevel(input, "|");
  const none = terms.filter((term) => term === "none");
  if (none.length > 0) {
    if (terms.length !== 1) throw new Error("`none` must be the only member of an effect set");
    return [];
  }
  return terms.map((term) => parseEffectExpression(term, localSchemas));
}

export function formatEffect(effect: Effect): string {
  if (effect.kind === "mutate") return `Mutate<typeof ${effect.region}>`;
  if (effect.kind === "throw") return `Throw<${effect.errorType}>`;
  if (effect.arguments.length === 0) return effect.name;
  if (effect.arguments.every((argument) => argument.kind === "all")) return effect.name;
  const formatted = effect.arguments.map((argument) => {
    if (argument.kind === "all") return "All";
    if (argument.kind === "unknown") return `Unknown<${argument.reason}>`;
    return argument.atoms.map((item) => item.kind === "token" || item.kind === "sys" ? item.value
      : item.kind === "region" ? `typeof ${item.value}` : JSON.stringify(item.value)).join(" | ");
  });
  return `${effect.name}<${formatted.join(", ")}>`;
}

function globCovers(allowed: string, actual: string): boolean {
  if (allowed === actual) return true;
  if (allowed.endsWith("/**")) return actual.startsWith(allowed.slice(0, -2));
  const escaped = allowed.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", "[^/]*");
  return new RegExp(`^${escaped}$`).test(actual);
}

function urlCovers(allowed: string, actual: string): boolean {
  const allowedUrl = new URL(allowed), actualUrl = new URL(actual);
  if (allowedUrl.origin !== actualUrl.origin) return false;
  if (allowedUrl.search && allowedUrl.search !== actualUrl.search) return false;
  return globCovers(allowedUrl.pathname, actualUrl.pathname);
}

function hostCovers(allowed: string, actual: string): boolean {
  const parse = (value: string) => {
    const match = /^(\*\.)?(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(value)!;
    return { wildcard: !!match[1], host: match[2]!, port: match[3] };
  };
  const a = parse(allowed), b = parse(actual);
  const host = a.wildcard ? !b.wildcard && b.host !== a.host && b.host.endsWith(`.${a.host}`) : !b.wildcard && a.host === b.host;
  return host && (a.port === undefined || a.port === b.port);
}

export interface CapabilityComparisonOptions {
  platform: "posix" | "windows";
  anchors: Readonly<Record<string, string | undefined>>;
}

function resolvedPath(value: string, options: CapabilityComparisonOptions): string | undefined {
  const withoutRecursive = value.replace(/\/\*\*$/, "");
  const match = /^\$([A-Z_]+)(?:\/(.*))?$/.exec(withoutRecursive);
  const path = options.platform === "windows" ? win32 : posix;
  let resolved: string;
  if (match) {
    const binding = options.anchors[match[1]!];
    if (!binding) return undefined;
    resolved = path.resolve(binding, ...(match[2] ?? "").split("/").filter(Boolean));
  } else resolved = path.resolve(withoutRecursive);
  const normalized = resolved.replaceAll("\\", "/");
  return options.platform === "windows" ? normalized.toLowerCase() : normalized;
}

function pathCovers(allowed: string, actual: string, options?: CapabilityComparisonOptions): boolean {
  if (!options) return globCovers(allowed, actual);
  const allowedResolved = resolvedPath(allowed, options), actualResolved = resolvedPath(actual, options);
  if (!allowedResolved || !actualResolved) return false;
  return allowed.endsWith("/**") ? actualResolved === allowedResolved || actualResolved.startsWith(`${allowedResolved}/`) : allowedResolved === actualResolved && !actual.endsWith("/**");
}

function atomCovers(allowed: CapabilityAtom, actual: CapabilityAtom, options?: CapabilityComparisonOptions): boolean {
  if (allowed.kind !== actual.kind) return false;
  if (allowed.kind === "url") return urlCovers(allowed.value, actual.value);
  if (allowed.kind === "path") return pathCovers(allowed.value, actual.value, options);
  if (allowed.kind === "host") return hostCovers(allowed.value, actual.value);
  if (allowed.kind === "env") {
    const fold = (value: string) => options?.platform === "windows" ? value.toUpperCase() : value;
    const a = fold(allowed.value), b = fold(actual.value);
    return a.endsWith("*") ? !b.endsWith("*") && b.startsWith(a.slice(0, -1)) : a === b;
  }
  if (allowed.kind === "region") return actual.value === allowed.value || actual.value.startsWith(`${allowed.value}.`) || actual.value.startsWith(`${allowed.value}[`);
  return allowed.value === actual.value;
}

function setPermits(allowed: CapabilitySet, actual: CapabilitySet, options?: CapabilityComparisonOptions): boolean {
  if (allowed.kind === "all") return true;
  if (allowed.kind === "unknown" || actual.kind !== "finite") return allowed.kind === "unknown" && actual.kind === "unknown" && allowed.reason === actual.reason;
  return actual.atoms.every((item) => allowed.atoms.some((candidate) => atomCovers(candidate, item, options)));
}

export function capabilityPermits(allowed: CapabilityEffect, actual: CapabilityEffect, options?: CapabilityComparisonOptions): boolean {
  return allowed.name === actual.name && allowed.arguments.length === actual.arguments.length
    && actual.arguments.every((argument, index) => setPermits(allowed.arguments[index]!, argument, options));
}

export function effectPermits(allowed: Effect, actual: Effect): boolean {
  if (allowed.kind === "capability" && actual.kind === "capability") return capabilityPermits(allowed, actual);
  if (allowed.kind === "throw" && actual.kind === "throw") return allowed.errorType === actual.errorType || (allowed.errorType === "Error" && actual.errorType !== "unknown");
  if (allowed.kind === "mutate" && actual.kind === "mutate") return atomCovers({ kind: "region", value: allowed.region }, { kind: "region", value: actual.region });
  return false;
}
import { posix, win32 } from "node:path";
