import { posix, win32 } from "node:path";
import { createHash } from "node:crypto";
import type { CapabilityAtom, CapabilityEffect, Effect } from "./capabilities.js";

export interface TargetProfile {
  runtime: "node" | "deno";
  os: "windows" | "linux" | "darwin";
  environment: Readonly<Record<string, string | undefined>>;
  windowsDirectory?: string;
}

export interface PermissionProjectionOptions {
  anchors: Readonly<Record<string, string | undefined>>;
  platform: "posix" | "windows";
  target?: TargetProfile;
}

export interface DenoPermissionPolicy { allow: Effect[]; deny: Effect[] }
export interface SandboxEscape { capability: "Ffi" | "Run"; reason: string }
export interface DenoPermissionProjection { args: string[]; scopes: Record<string, string[]>; bindingDigest: string; sandboxEscapes: SandboxEscape[] }

export function resolveTargetTemp(target: TargetProfile): string {
  const env = target.environment;
  if (target.os === "windows") return env.TEMP ?? env.TMP ?? `${target.windowsDirectory ?? "C:\\Windows"}\\Temp`;
  return env.TMPDIR ?? env.TMP ?? env.TEMP ?? "/tmp";
}

function resolvePath(value: string, options: PermissionProjectionOptions): string {
  const match = /^\$([A-Z_]+)(?:\/(.*))?$/.exec(value);
  if (!match) return value.replace(/\/\*\*$/, "");
  const name = match[1]!;
  const binding = options.anchors[name] ?? (name === "TEMP" && options.target ? resolveTargetTemp(options.target) : undefined);
  if (!binding) throw new Error(`missing path anchor binding: ${name}`);
  const path = options.platform === "windows" ? win32 : posix;
  const remainder = (match[2] ?? "").replace(/\/\*\*$/, "");
  return remainder ? path.resolve(binding, ...remainder.split("/")) : path.resolve(binding);
}

const flags: Record<string, string> = {
  FsRead: "read", FsWrite: "write", Net: "net", Env: "env", Run: "run",
  Sys: "sys", Ffi: "ffi", Import: "import",
};

function atomScope(capability: string, atom: CapabilityAtom, options: PermissionProjectionOptions): string {
  if ((capability === "FsRead" || capability === "FsWrite" || capability === "Ffi") && atom.kind === "path") return resolvePath(atom.value, options);
  if ((capability === "Net" || capability === "Import") && atom.kind === "host") return atom.value;
  if (capability === "Env" && atom.kind === "env") return atom.value;
  if (capability === "Sys" && atom.kind === "sys") return atom.value;
  if (capability === "Run" && atom.kind === "literal") return atom.value;
  throw new Error(`cannot project ${capability} atom ${atom.kind}`);
}

function collect(target: Map<string, Set<string> | null>, effect: Effect, options: PermissionProjectionOptions): void {
  if (effect.kind !== "capability" || !(effect.name in flags)) return;
  const argument = effect.arguments[0];
  if (!argument || argument.kind === "all") { target.set(effect.name, null); return; }
  if (argument.kind === "unknown") throw new Error(`cannot project unknown ${effect.name} permission: ${argument.reason}`);
  if (target.get(effect.name) === null) return;
  const scopes = target.get(effect.name) ?? new Set<string>();
  for (const atom of argument.atoms) scopes.add(atomScope(effect.name, atom, options));
  target.set(effect.name, scopes);
}

function emit(prefix: "allow" | "deny", values: Map<string, Set<string> | null>): string[] {
  const args: string[] = [];
  for (const name of Object.keys(flags)) {
    if (!values.has(name)) continue;
    const scopes = values.get(name);
    args.push(scopes === null ? `--${prefix}-${flags[name]}` : `--${prefix}-${flags[name]}=${[...scopes!].sort().join(",")}`);
  }
  return args;
}

export function projectDenoPermissions(policy: DenoPermissionPolicy, options: PermissionProjectionOptions): DenoPermissionProjection {
  const allow = new Map<string, Set<string> | null>(), deny = new Map<string, Set<string> | null>();
  for (const effect of policy.allow) collect(allow, effect, options);
  for (const effect of policy.deny) collect(deny, effect, options);
  const loaderNames = options.platform === "windows" ? ["PATH"] : ["LD_PRELOAD", "DYLD_INSERT_LIBRARIES", "DYLD_LIBRARY_PATH"];
  const envScopes = allow.get("Env");
  const loaderAccess = envScopes === null || (envScopes !== undefined && [...envScopes].some((pattern) => loaderNames.some((name) => pattern.endsWith("*") ? name.startsWith(pattern.slice(0, -1)) : (options.platform === "windows" ? pattern.toUpperCase() === name : pattern === name))));
  // Deno documents loader-variable access as defeating command-scoped Run.
  if (allow.has("Run") && loaderAccess) allow.set("Run", null);
  const scopes: Record<string, string[]> = {};
  for (const [name, values] of allow) scopes[name] = values === null ? ["<all>"] : [...values].sort();
  const resolvedBindings = { ...options.anchors };
  if (options.target && resolvedBindings.TEMP === undefined) resolvedBindings.TEMP = resolveTargetTemp(options.target);
  const bindingDigest = createHash("sha256").update(JSON.stringify({
    platform: options.platform,
    target: options.target ? { runtime: options.target.runtime, os: options.target.os } : undefined,
    anchors: Object.fromEntries(Object.entries(resolvedBindings).sort(([a], [b]) => a.localeCompare(b))),
  })).digest("hex");
  const sandboxEscapes: SandboxEscape[] = [];
  if (allow.has("Ffi")) sandboxEscapes.push({ capability: "Ffi", reason: "native code executes outside the JavaScript permission sandbox" });
  if (allow.has("Run") && loaderAccess) sandboxEscapes.push({ capability: "Run", reason: "dynamic-loader environment access can inject code into an allowed subprocess" });
  return { args: [...emit("allow", allow), ...emit("deny", deny)], scopes, bindingDigest, sandboxEscapes };
}
