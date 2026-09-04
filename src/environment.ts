/* uneffect:module_effect none */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import { executeZ3 } from "./z3.js";
import { readPackageManifest, type PackageManifest } from "./package-manifest.js";

export type { PackageManifest } from "./package-manifest.js";
export { readPackageManifest } from "./package-manifest.js";

export type EnvironmentStatus = "ok" | "warning" | "error";

export interface EnvironmentCheck {
  name: string;
  status: EnvironmentStatus;
  /** What was actually found, so the reader can tell a wrong version from a missing one. */
  detail: string;
  /** Which commands stop working, or work less, without it. */
  requiredBy: string;
  /** The concrete way to satisfy the requirement; omitted when nothing is wrong. */
  remedy?: string;
}

const require_ = createRequire(import.meta.url);

/** Shorten a resolved path to something a reader can place: relative inside the project, absolute outside. */
function displayPath(path: string): string {
  const inside = relative(process.cwd(), path);
  return inside.startsWith("..") ? path : inside;
}

const projectRequire = createRequire(join(process.cwd(), "package.json"));

/**
 * Resolve a package from the project being checked first, then from this installation.
 * A peer dependency belongs to the project, and only the project's copy is the one a run uses.
 */
/* uneffect:effect FsRead */
function resolvePackage(request: string): { version?: string; path?: string } {
  for (const resolver of [projectRequire, require_]) {
    try {
      const manifestPath = resolver.resolve(`${request}/package.json`);
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { version?: string };
      return { path: displayPath(dirname(manifestPath)), version: manifest.version };
    } catch {
      continue;
    }
  }
  return {};
}

/** First meaningful line of a `--version` banner, past launcher noise such as `Picked up JAVA_TOOL_OPTIONS`. */
/* uneffect:effect Run */
function commandVersion(command: string, args: readonly string[]): string | undefined {
  try {
    const execution = spawnSync(command, [...args], { encoding: "utf8", timeout: 10_000 });
    if (execution.error || execution.status !== 0) return undefined;
    const line = `${execution.stdout ?? ""}\n${execution.stderr ?? ""}`.split(/\r?\n/u)
      .map((item) => item.trim())
      .find((item) => item.length > 0 && !item.startsWith("Picked up "));
    if (!line) return undefined;
    return line.length > 80 ? `${line.slice(0, 77)}...` : line;
  } catch {
    return undefined;
  }
}

/* uneffect:effect none */
function minimumMajor(range: string | undefined): number | undefined {
  const match = range ? /(\d+)/u.exec(range) : null;
  return match ? Number(match[1]) : undefined;
}

/* uneffect:effect none */
function nodeCheck(manifest: PackageManifest): EnvironmentCheck {
  const required = manifest.engines?.node, minimum = minimumMajor(required);
  const major = Number(process.versions.node.split(".")[0]);
  const satisfied = minimum === undefined || major >= minimum;
  return {
    name: "node",
    status: satisfied ? "ok" : "error",
    detail: `v${process.versions.node}${required ? ` (engines: ${required})` : ""}`,
    requiredBy: "every command",
    remedy: satisfied ? undefined : `install Node.js ${minimum} or newer; the analyzer uses language and stdlib features below that version's baseline`,
  };
}

function typescript7NativePackage(): string {
  const platform = process.platform === "win32" ? "win32" : process.platform;
  return `@typescript/typescript-${platform}-${process.arch}`;
}

function typescriptCheck(manifest: PackageManifest): EnvironmentCheck {
  const pkg = typescript7NativePackage();
  const native = resolvePackage(pkg);
  const required = manifest.peerDependencies?.typescript;
  if (native.version) {
    return {
      name: "typescript",
      status: "ok",
      detail: `${native.version} native ${pkg}${native.path ? ` at ${native.path}` : ""}`,
      requiredBy: "default `check` via Corsa",
    };
  }
  const js = resolvePackage("typescript");
  if (js.version) {
    return {
      name: "typescript",
      status: "warning",
      detail: `${js.version}${js.path ? ` at ${js.path}` : ""}${required ? ` (peer: ${required})` : ""}; default check wants ${pkg}`,
      requiredBy: "default `check` via Corsa",
      remedy: `install ${pkg} for the Corsa TypeScript 7 worker`,
    };
  }
  return {
    name: "typescript",
    status: "error",
    detail: `${pkg} is not installed`,
    requiredBy: "default `check` via Corsa",
    remedy: `install ${pkg} or typescript ${required ?? ">=7"}`,
  };
}

function nodeTypesCheck(): EnvironmentCheck {
  const types = resolvePackage("@types/node");
  return {
    name: "@types/node",
    status: types.version ? "ok" : "warning",
    detail: types.version ? `${types.version}${types.path ? ` at ${types.path}` : ""}` : "not resolvable",
    requiredBy: "Node builtin contracts: FsRead, FsWrite, Env, and the Node event-loop models",
    remedy: types.version ? undefined : "install @types/node; without it the Node builtins resolve to no symbol and their effects are silently not inferred",
  };
}

async function solverCheck(): Promise<EnvironmentCheck> {
  const started = process.hrtime.bigint();
  try {
    const execution = await executeZ3("(set-logic ALL)\n(declare-const probe Int)\n(assert (> probe 0))\n");
    const milliseconds = Number((process.hrtime.bigint() - started) / 1_000_000n);
    if (execution.status !== "sat") {
      return { name: "z3 backend", status: "error", detail: `${execution.backend} ${execution.version}, probe query answered ${execution.status}${execution.failureKind ? ` (${execution.failureKind})` : ""}`, requiredBy: "contract/temporal verification in `check` and ownership evidence in `instrument --verify-ownership`", remedy: "set UNEFFECT_Z3_BACKEND=wasm to use the bundled solver, or install/configure a working native executable with UNEFFECT_Z3_PATH" };
    }
    const fallback = execution.attempts.length > 1 ? ` after ${execution.attempts.length - 1} failed attempt(s)` : "";
    return { name: "z3 backend", status: "ok", detail: `${execution.backend} ${execution.version}, probe query answered in ${milliseconds} ms${fallback}`, requiredBy: "contract/temporal verification in `check` and ownership evidence in `instrument --verify-ownership`" };
  } catch (cause) {
    return {
      name: "z3 backend",
      status: "error",
      detail: cause instanceof Error ? cause.message : String(cause),
      requiredBy: "contract/temporal verification in `check` and ownership evidence in `instrument --verify-ownership`",
      remedy: "use UNEFFECT_Z3_BACKEND=auto or wasm, reinstall z3-solver, or point UNEFFECT_Z3_PATH at a working native Z3 executable",
    };
  }
}

function quintCheck(manifest: PackageManifest): EnvironmentCheck {
  const quint = resolvePackage("@informalsystems/quint");
  const required = manifest.peerDependencies?.["@informalsystems/quint"];
  return {
    name: "@informalsystems/quint",
    status: quint.version ? "ok" : "warning",
    detail: quint.version ? `${quint.version}${quint.path ? ` at ${quint.path}` : ""}${required ? ` (optional peer: ${required})` : ""}` : "not installed",
    requiredBy: "running the models `spec quint`, `resource-model`, and `async-model` generate",
    remedy: quint.version ? undefined : "npm install --save-dev @informalsystems/quint, an optional peer; it brings its own `quint` binary, and generating the models needs nothing",
  };
}

/* uneffect:effect Run */
function javaCheck(): EnvironmentCheck {
  const version = commandVersion("java", ["-version"]);
  return {
    name: "java (command)",
    status: version ? "ok" : "warning",
    detail: version ?? "not found on PATH",
    requiredBy: "exhaustive Quint verification through Apalache/TLC",
    remedy: version ? undefined : "install a JDK 21 or newer only if you run `quint verify`; simulation and every uneffect command work without it",
  };
}

export interface EnvironmentCheckOptions {
  /** Skip the selected native/WASM solver probe. */
  skipSolverProbe?: boolean;
}

/** Everything the toolchain expects, checked in the order a first run depends on it. */
export async function runEnvironmentChecks(options: EnvironmentCheckOptions = {}): Promise<EnvironmentCheck[]> {
  const manifest = await readPackageManifest();
  const checks = [nodeCheck(manifest), typescriptCheck(manifest), nodeTypesCheck()];
  if (!options.skipSolverProbe) checks.push(await solverCheck());
  checks.push(quintCheck(manifest), javaCheck());
  return checks;
}

/* uneffect:effect none */
export function environmentSummary(checks: readonly EnvironmentCheck[]): { errors: number; warnings: number } {
  return {
    errors: checks.filter((check) => check.status === "error").length,
    warnings: checks.filter((check) => check.status === "warning").length,
  };
}

const label: Readonly<Record<EnvironmentStatus, string>> = { ok: "ok", warning: "warn", error: "missing" };

/** Render the report: one aligned line per check, then the reason and remedy for anything unmet. */
/* uneffect:effect none */
export function formatEnvironmentReport(checks: readonly EnvironmentCheck[]): string {
  const statusWidth = Math.max(...checks.map((check) => label[check.status].length));
  const nameWidth = Math.max(...checks.map((check) => check.name.length));
  const lines: string[] = [];
  for (const check of checks) {
    lines.push(`${label[check.status].padEnd(statusWidth)}  ${check.name.padEnd(nameWidth)}  ${check.detail}`);
    if (check.status !== "ok") {
      lines.push(`${" ".repeat(statusWidth + 2)}  needed by: ${check.requiredBy}`);
      if (check.remedy) lines.push(`${" ".repeat(statusWidth + 2)}  fix: ${check.remedy}`);
    }
  }
  const { errors, warnings } = environmentSummary(checks);
  lines.push("");
  lines.push(errors === 0 && warnings === 0
    ? `${checks.length} check(s) passed`
    : `${checks.length} check(s): ${errors} unmet requirement(s), ${warnings} optional tool(s) missing`);
  return `${lines.join("\n")}\n`;
}
