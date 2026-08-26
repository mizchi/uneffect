import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { createRequire } from "node:module";
import { init } from "z3-solver";

export type Z3BackendPreference = "auto" | "native" | "wasm";
export type Z3Backend = Exclude<Z3BackendPreference, "auto">;
export type Z3FailureKind = "unavailable" | "timeout" | "oom" | "crash" | "invalid-input";

export interface Z3ExecutionResult {
  backend: Z3Backend;
  version: string;
  status: "sat" | "unsat" | "unknown" | "error";
  model?: string;
  values?: Readonly<Record<string, string>>;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  failureKind?: Z3FailureKind;
  executable?: string;
}

export interface Z3Execution extends Z3ExecutionResult {
  /** Every attempt is retained so a successful fallback cannot hide an infrastructure failure. */
  attempts: readonly Z3ExecutionResult[];
}

export interface Z3ExecutionOptions {
  preference?: Z3BackendPreference;
  fallbackOnTimeout?: boolean;
  produceModel?: boolean;
  timeoutMs?: number;
  maxOutputBytes?: number;
  nativeExecutable?: string;
  /** Scalar model observations; expressions currently use declared Int/Bool symbols. */
  values?: readonly Z3ValueRequest[];
  /** Use Optimize so top-level minimize/maximize objectives are honored. */
  optimize?: boolean;
}

export interface Z3ValueRequest {
  name: string;
  expression: string;
  sort: "Int" | "Bool" | "String";
}

export interface Z3BackendDriver {
  backend: Z3Backend;
  probe(): Promise<boolean>;
  execute(program: string, options: Z3ExecutionOptions): Promise<Z3ExecutionResult>;
}

export function parseZ3BackendPreference(value: string | undefined): Z3BackendPreference {
  if (value === undefined || value === "") return "auto";
  if (value === "auto" || value === "native" || value === "wasm") return value;
  throw new Error(`UNEFFECT_Z3_BACKEND must be auto, native, or wasm; received ${JSON.stringify(value)}`);
}

/** One initialization of the bundled Z3 WASM build per process. */
let runtime: Promise<{ Context: unknown; Z3: { get_full_version(): string } }> | undefined;
let contexts = 0;

async function z3Runtime(): Promise<{ Context: any; Z3: { get_full_version(): string } }> {
  runtime ??= init() as never;
  return await (runtime as Promise<any>);
}

/** A fresh WASM solver context. Retained for model decoders not yet moved to SMT-LIB output. */
export async function createZ3Context(purpose: string): Promise<any> {
  const { Context } = await z3Runtime();
  contexts += 1;
  return new Context(`uneffect_${purpose}_${process.pid}_${contexts}`);
}

async function wasmVersion(): Promise<string> {
  try {
    return (await z3Runtime()).Z3.get_full_version();
  } catch {
    try {
      const packageVersion = (createRequire(import.meta.url)("z3-solver/package.json") as { version?: string }).version;
      return packageVersion ? `z3-solver ${packageVersion}` : "unknown";
    } catch {
      return "unknown";
    }
  }
}

function errorText(execution: SpawnSyncReturns<string>): string {
  return `${execution.stdout ?? ""}\n${execution.stderr ?? ""}\n${execution.error?.message ?? ""}`;
}

function nativeFailure(execution: SpawnSyncReturns<string>): Z3FailureKind | undefined {
  const code = (execution.error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ENOENT" || code === "EACCES") return "unavailable";
  if (code === "ETIMEDOUT") return "timeout";
  const output = errorText(execution);
  if (/^\(error\s/mu.test(output)) return "invalid-input";
  if (/out of memory|cannot allocate|std::bad_alloc|ENOMEM|killed: 9/iu.test(output)) return "oom";
  if (execution.error || execution.signal || execution.status !== 0) return "crash";
  return undefined;
}

function semanticStatus(output: string): Z3ExecutionResult["status"] | undefined {
  const match = /^(unsat|sat|unknown)\s*$/mu.exec(output);
  return match?.[1] as Z3ExecutionResult["status"] | undefined;
}

function withCheckSat(program: string): string {
  return /\(check-sat\)/u.test(program) ? program : `${program.replace(/\s*$/u, "")}\n(check-sat)\n`;
}

type SExpression = string | SExpression[];

function parseSExpression(input: string): SExpression {
  const tokens = input.match(/\(|\)|\|(?:\\.|[^|])*\||"(?:""|[^"])*"|[^\s()]+/gu) ?? [];
  let index = 0;
  const parse = (): SExpression => {
    const token = tokens[index++];
    if (token === undefined) throw new Error("missing S-expression value");
    if (token !== "(") {
      if (token === ")") throw new Error("unexpected closing S-expression parenthesis");
      return token;
    }
    const values: SExpression[] = [];
    while (tokens[index] !== ")") {
      if (tokens[index] === undefined) throw new Error("unterminated S-expression list");
      values.push(parse());
    }
    index++;
    return values;
  };
  const value = parse();
  if (index !== tokens.length) throw new Error("multiple S-expression values in solver output");
  return value;
}

function renderSExpression(value: SExpression): string {
  return typeof value === "string" ? value : `(${value.map(renderSExpression).join(" ")})`;
}

function parseNativeValues(stdout: string, requests: readonly Z3ValueRequest[]): Readonly<Record<string, string>> {
  const body = stdout.replace(/^.*?(?:unsat|sat|unknown)\s*\r?\n/su, "").trim();
  const root = parseSExpression(body);
  if (!Array.isArray(root) || root.length !== requests.length) throw new Error(`native Z3 returned ${Array.isArray(root) ? root.length : 0} values for ${requests.length} observations`);
  return Object.fromEntries(root.map((pair, index) => {
    if (!Array.isArray(pair) || pair.length !== 2) throw new Error(`native Z3 returned an invalid value pair at index ${index}`);
    return [requests[index]!.name, renderSExpression(pair[1]!)];
  }));
}

const smtCommands = new Set([
  "assert", "check-sat", "check-sat-assuming", "declare-const", "declare-datatype", "declare-datatypes",
  "declare-fun", "declare-sort", "define-fun", "define-fun-rec", "define-funs-rec", "echo", "exit",
  "get-model", "get-value", "maximize", "minimize", "pop", "push", "reset", "reset-assertions",
  "set-info", "set-logic", "set-option",
]);

/** Cheap fail-closed guard for the canonical SMT-LIB scripts Uneffect emits. */
function validateSmtLibCommands(program: string): string | undefined {
  let depth = 0, quoted = false, string = false, comment = false;
  for (let index = 0; index < program.length; index++) {
    const character = program[index]!;
    if (comment) { if (character === "\n") comment = false; continue; }
    if (string) {
      if (character === '"' && program[index + 1] === '"') { index++; continue; }
      if (character === '"') string = false;
      continue;
    }
    if (quoted) { if (character === "|") quoted = false; continue; }
    if (character === ";") { comment = true; continue; }
    if (character === '"') { string = true; continue; }
    if (character === "|") { quoted = true; continue; }
    if (character === "(") {
      if (depth === 0) {
        const match = /^\s*([^\s()]+)/u.exec(program.slice(index + 1));
        const command = match?.[1];
        if (!command || !smtCommands.has(command)) return `unsupported top-level SMT-LIB command ${JSON.stringify(command ?? "")}`;
      }
      depth++;
    } else if (character === ")") {
      depth--;
      if (depth < 0) return "unmatched closing parenthesis in SMT-LIB input";
    } else if (depth === 0 && !/\s/u.test(character)) {
      return `unexpected top-level SMT-LIB text at offset ${index}`;
    }
  }
  if (string || quoted || depth !== 0) return "unterminated SMT-LIB string, quoted symbol, or list";
  return undefined;
}

function createNativeDriver(executable: string): Z3BackendDriver {
  let version: string | undefined;
  let probeResult: boolean | undefined;
  return {
    backend: "native",
    async probe() {
      if (probeResult !== undefined) return probeResult;
      const execution = spawnSync(executable, ["-version"], { encoding: "utf8", timeout: 10_000 });
      if (nativeFailure(execution)) return probeResult = false;
      version = `${execution.stdout}${execution.stderr}`.trim().split(/\r?\n/u)[0] || "unknown";
      return probeResult = true;
    },
    async execute(program, options) {
      const invalid = validateSmtLibCommands(program);
      if (invalid) return { backend: "native", version: version ?? "unknown", executable, status: "error", failureKind: "invalid-input", stdout: "", stderr: invalid, exitCode: 1 };
      const input = withCheckSat(program);
      const execution = spawnSync(executable, ["-in", "-smt2"], { input, encoding: "utf8", timeout: options.timeoutMs ?? 30_000, maxBuffer: options.maxOutputBytes ?? 16 * 1024 * 1024 });
      const failureKind = nativeFailure(execution);
      const base = { backend: "native" as const, version: version ?? "unknown", executable, stdout: execution.stdout ?? "", stderr: execution.stderr ?? "", exitCode: execution.status };
      if (failureKind) return { ...base, status: "error", failureKind };
      const status = semanticStatus(execution.stdout);
      if (!status) return { ...base, status: "error", failureKind: "crash", stderr: `${base.stderr}${base.stderr ? "\n" : ""}native Z3 produced no semantic verdict` };
      if (status === "sat" && options.values?.length) {
        const valuesInput = `${input.replace(/\s*$/u, "")}\n(get-value (${options.values.map((request) => request.expression).join(" ")}))\n`;
        const valuesExecution = spawnSync(executable, ["-in", "-smt2"], { input: valuesInput, encoding: "utf8", timeout: options.timeoutMs ?? 30_000, maxBuffer: options.maxOutputBytes ?? 16 * 1024 * 1024 });
        const valuesFailure = nativeFailure(valuesExecution);
        if (valuesFailure) return { backend: "native", version: base.version, executable, status: "error", failureKind: valuesFailure, stdout: valuesExecution.stdout ?? "", stderr: valuesExecution.stderr ?? "", exitCode: valuesExecution.status };
        try { return { ...base, status, values: parseNativeValues(valuesExecution.stdout ?? "", options.values) }; }
        catch (cause) { return { ...base, status: "error", failureKind: "crash", stderr: cause instanceof Error ? cause.message : String(cause) }; }
      }
      if (status !== "sat" || !options.produceModel) return { ...base, status };
      const modelExecution = spawnSync(executable, ["-in", "-smt2"], { input: `${input.replace(/\s*$/u, "")}\n(get-model)\n`, encoding: "utf8", timeout: options.timeoutMs ?? 30_000, maxBuffer: options.maxOutputBytes ?? 16 * 1024 * 1024 });
      const modelFailure = nativeFailure(modelExecution);
      if (modelFailure) return { backend: "native", version: base.version, executable, status: "error", failureKind: modelFailure, stdout: modelExecution.stdout ?? "", stderr: modelExecution.stderr ?? "", exitCode: modelExecution.status };
      const model = (modelExecution.stdout ?? "").replace(/^(?:unsat|sat|unknown)\s*\r?\n/mu, "").trim();
      return { ...base, status, model };
    },
  };
}

const wasmDriver: Z3BackendDriver = {
  backend: "wasm",
  async probe() {
    try { await z3Runtime(); return true; } catch { return false; }
  },
  async execute(program, options) {
    const version = await wasmVersion();
    const invalid = validateSmtLibCommands(program);
    if (invalid) return { backend: "wasm", version, status: "error", failureKind: "invalid-input", stdout: "", stderr: invalid, exitCode: 1 };
    try {
      const context = await createZ3Context("smt");
      const solver = options.optimize ? new context.Optimize() : new context.Solver();
      solver.fromString(program.replace(/\(check-sat\)\s*/gu, ""));
      const status = String(await solver.check()) as Z3ExecutionResult["status"];
      const model = status === "sat" && options.produceModel ? solver.model().toString() : undefined;
      const values = status === "sat" && options.values?.length ? Object.fromEntries(options.values.map((request) => {
        const expression = request.sort === "Int" ? context.Int.const(request.expression)
          : request.sort === "Bool" ? context.Bool.const(request.expression) : context.String.const(request.expression);
        return [request.name, solver.model().eval(expression, true).toString()];
      })) : undefined;
      return { backend: "wasm", version, status, model, values, stdout: `${status}\n`, stderr: "", exitCode: 0 };
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      const failureKind: Z3FailureKind = /^\(error\s/mu.test(message) ? "invalid-input"
        : /out of memory|Cannot enlarge memory|memory access out of bounds|corrupted its heap/iu.test(message) ? "oom" : "crash";
      return { backend: "wasm", version, status: "error", failureKind, stdout: "", stderr: message, exitCode: 1 };
    }
  },
};

const nativeDrivers = new Map<string, Z3BackendDriver>();
function nativeDriver(executable: string): Z3BackendDriver {
  let driver = nativeDrivers.get(executable);
  if (!driver) { driver = createNativeDriver(executable); nativeDrivers.set(executable, driver); }
  return driver;
}

function unavailable(backend: Z3Backend, executable?: string): Z3ExecutionResult {
  return { backend, version: "unknown", executable, status: "error", failureKind: "unavailable", stdout: "", stderr: `${backend} Z3 backend is unavailable`, exitCode: null };
}

function mayFallback(result: Z3ExecutionResult, fallbackOnTimeout: boolean): boolean {
  return result.status === "error" && (
    result.failureKind === "unavailable"
    || result.failureKind === "oom"
    || result.failureKind === "crash"
    || (result.failureKind === "timeout" && fallbackOnTimeout)
  );
}

export async function executeZ3WithBackends(
  program: string,
  options: Z3ExecutionOptions,
  drivers: { native: Z3BackendDriver; wasm: Z3BackendDriver },
): Promise<Z3Execution> {
  const preference = options.preference ?? "auto";
  const attempts: Z3ExecutionResult[] = [];
  const attempt = async (driver: Z3BackendDriver): Promise<Z3ExecutionResult> => {
    const result = await driver.probe() ? await driver.execute(program, options) : unavailable(driver.backend, options.nativeExecutable);
    attempts.push(result);
    return result;
  };
  if (preference === "native" || preference === "wasm") {
    const result = await attempt(drivers[preference]);
    return { ...result, attempts };
  }
  const native = await attempt(drivers.native);
  if (!mayFallback(native, options.fallbackOnTimeout ?? false)) return { ...native, attempts };
  const wasm = await attempt(drivers.wasm);
  return { ...wasm, attempts };
}

/** Execute canonical SMT-LIB using the configured backend policy. */
export async function executeZ3(program: string, options: Z3ExecutionOptions = {}): Promise<Z3Execution> {
  const preference = options.preference ?? parseZ3BackendPreference(process.env.UNEFFECT_Z3_BACKEND);
  const nativeExecutable = options.nativeExecutable ?? process.env.UNEFFECT_Z3_PATH ?? "z3";
  return executeZ3WithBackends(program, { ...options, preference, nativeExecutable }, { native: nativeDriver(nativeExecutable), wasm: wasmDriver });
}

/** Version of the backend selected for a trivial query, retained for compatibility. */
export async function z3Version(): Promise<string> {
  return (await executeZ3("(set-logic QF_UF)\n", { timeoutMs: 10_000 })).version;
}
