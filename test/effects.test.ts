import { describe, expect, it } from "vitest";
import { analyzeEffects } from "../src/effects.js";
import { builtinContractRegistry, extendBuiltinContractRegistry } from "../src/builtin-contracts.js";

describe("effect checker", () => {
  it("tracks Node strict assertion failure as a typed synchronous throw", () => {
    const diagnostics = analyzeEffects("node-assert-effect.ts", `
      import { ok } from "node:assert/strict"
      /* uneffect:effect Throw<AssertionError> */
      function checked(value: number) { ok(value >= 0) }
      function missing(value: number) { ok(value >= 0) }
    `);
    expect(diagnostics.filter(({ functionName }) => functionName === "checked")).toEqual([]);
    expect(diagnostics).toContainEqual(expect.objectContaining({
      functionName: "missing", kind: "missing", effect: "Throw<AssertionError>",
    }));
  });

  it("reports an invalid effect-set annotation without crashing the checker", () => {
    const source = `/* uneffect:effect none | Console */ function invalid() {}`;
    expect(analyzeEffects("invalid-effect-set.ts", source)).toContainEqual(expect.objectContaining({
      fileName: "invalid-effect-set.ts", functionName: "invalid", kind: "invalid", severity: "error",
      message: expect.stringContaining("`none` must be the only member"),
    }));
  });

  it("rejects unknown and payload-less Uneffect directives instead of inferring around them", () => {
    const source = `
      /* uneffect: effects Console */ function misspelled() { console.log("x") }
      /* uneffect:effect */ function missingPayload() {}
    `;
    expect(analyzeEffects("invalid-directives.ts", source)).toEqual(expect.arrayContaining([
      expect.objectContaining({ functionName: "<annotation>", kind: "invalid", severity: "error", message: "unknown Uneffect dialect `effects`" }),
      expect.objectContaining({ functionName: "<annotation>", kind: "invalid", severity: "error", message: expect.stringContaining("requires a payload") }),
    ]));
  });

  it("propagates effects from implicit using disposal", () => {
    const source = `
      class Resource {
        /* uneffect:effect Console */
        [Symbol.dispose]() { console.log("disposed") }
      }
      /* uneffect:effect Console */
      function valid() { using resource = new Resource() }
      function invalid() { using resource = new Resource() }
    `;
    const diagnostics = analyzeEffects("using-effects.ts", source);
    expect(diagnostics.filter((item) => item.functionName === "valid")).toEqual([]);
    expect(diagnostics).toContainEqual(expect.objectContaining({ functionName: "invalid", kind: "missing", effect: "Console" }));
  });

  it("discharges a synchronous disposer throw caught around using", () => {
    const source = `
      class Resource {
        /* uneffect:effect Throw<RangeError> */
        [Symbol.dispose]() { throw new RangeError("dispose") }
      }
      function safe() { try { using resource = new Resource() } catch {} }
      function unsafe() { using resource = new Resource() }
    `;
    const diagnostics = analyzeEffects("using-throw.ts", source);
    expect(diagnostics).not.toContainEqual(expect.objectContaining({
      functionName: "safe", kind: "missing", effect: "Throw<RangeError>",
    }));
    expect(diagnostics).toContainEqual(expect.objectContaining({
      functionName: "unsafe", kind: "missing", effect: "Throw<RangeError>",
    }));
  });

  it("checks an in-place recursive quicksort as one reference-scoped mutation", () => {
    const source = `
      /* uneffect:effect Mutate<typeof values> */
      function partition(values: number[], lo: number, hi: number): number {
        const pivot = values[hi]!
        let p = lo
        for (let i = lo; i < hi; i++) {
          if (values[i]! <= pivot) {
            const value = values[i]!
            values[i] = values[p]!
            values[p] = value
            p++
          }
        }
        const value = values[p]!
        values[p] = values[hi]!
        values[hi] = value
        return p
      }
      /* uneffect:effect Mutate<typeof values> */
      function quicksort(values: number[], lo = 0, hi = values.length - 1): void {
        if (lo >= hi) return
        const pivot = partition(values, lo, hi)
        quicksort(values, lo, pivot - 1)
        quicksort(values, pivot + 1, hi)
      }
    `;
    expect(analyzeEffects("quicksort.ts", source)).toEqual([]);
  });

  it("infers direct and transitive effects", () => {
    const source = `
      /* uneffect:effect Console */ function log() { console.log("x") }
      /* uneffect:effect Console | Fetch | Net */ async function main() { log(); await fetch("/") }
    `;
    expect(analyzeEffects("ok.ts", source)).toEqual([]);
  });

  it("reports a missing transitive effect", () => {
    const source = `
      /* uneffect:effect Console */ function log() { console.log("x") }
      /* uneffect:effect Fetch | Net */ async function main() { log(); await fetch("/") }
    `;
    expect(analyzeEffects("bad.ts", source)).toMatchObject([
      { functionName: "main", effect: "Console", kind: "missing" },
    ]);
  });

  it("warns about an unused upper-bound effect", () => {
    const source = `/* uneffect:effect Console | Fetch */ function f() { console.log("x") }`;
    expect(analyzeEffects("ok.ts", source)).toEqual([
      expect.objectContaining({ functionName: "f", effect: "Fetch", kind: "unused", severity: "warning" }),
    ]);
  });

  it("treats timer scheduling and cancellation as the same Timer capability", () => {
    const source = `/* uneffect:effect Timer */ function f() { const h = setTimeout(() => {}, 1); clearTimeout(h); AbortSignal.timeout(10) }`;
    expect(analyzeEffects("timer.ts", source)).toEqual([]);
  });

  it("recognizes node:fs read/write APIs through aliases", () => {
    const source = `
      import { readFileSync as read, writeFileSync as write } from "node:fs";
      /* uneffect:effect FsRead | FsWrite */
      function copy() { write("b", read("a")) }
    `;
    expect(analyzeEffects("fs.ts", source)).toEqual([]);
  });

  it("uses the same scoped permission primitives for node:fs/promises", () => {
    const source = `
      import { readFile as read, writeFile as write } from "node:fs/promises";
      /* uneffect:effect FsRead<"input.txt"> | FsWrite<"output.txt"> */
      async function copy() { await write("output.txt", await read("input.txt")) }
    `;
    expect(analyzeEffects("fs-promises.ts", source)).toEqual([]);

    const dynamic = `
      import { readFile } from "node:fs/promises";
      /* uneffect:effect FsRead */
      async function load(path: string) { return readFile(path) }
    `;
    expect(analyzeEffects("fs-promises-dynamic.ts", dynamic)).toEqual([]);

    const instantiated = `
      import { readFile } from "node:fs/promises";
      /* uneffect:effect FsRead */
      async function load(path: string) { return readFile(path) }
      /* uneffect:effect FsRead<"input.txt"> */
      async function main() { return load("input.txt") }
    `;
    expect(analyzeEffects("fs-promises-instantiated.ts", instantiated)).toEqual([]);
    expect(analyzeEffects("fs-promises-instantiated.ts", instantiated.replace('FsRead<"input.txt">', 'FsRead<"other.txt">')))
      .toContainEqual(expect.objectContaining({ functionName: "main", effect: 'FsRead<"input.txt">', kind: "missing" }));

    const forwarded = `
      import { readFile } from "node:fs/promises";
      /* uneffect:effect FsRead */
      function load(path: string) { return readFile(path) }
      /* uneffect:effect FsRead */
      function wrapper(input: string) { return load(input) }
    `;
    expect(analyzeEffects("fs-promises-forwarded.ts", forwarded)).toEqual([]);

    const unresolvedExpression = dynamic.replace("readFile(path)", "readFile(path + '.json')");
    expect(analyzeEffects("fs-promises-expression.ts", unresolvedExpression)).toEqual([]);
    expect(analyzeEffects("fs-promises-expression-narrow.ts", unresolvedExpression.replace("effect FsRead", 'effect FsRead<"$CWD/**">'))).toContainEqual(expect.objectContaining({
      functionName: "load", effect: "FsRead", kind: "missing",
    }));

    const promiseSpecific = `
      import { mkdtemp, opendir, statfs } from "node:fs/promises";
      /* uneffect:effect FsRead<"input"> | FsWrite<"tmp-"> */
      async function inspect() {
        await opendir("input");
        await statfs("input");
        await mkdtemp("tmp-");
      }
    `;
    expect(analyzeEffects("fs-promises-specific.ts", promiseSpecific)).toEqual([]);
  });

  it("propagates capabilities from TypeChecker-resolved deferred callbacks", () => {
    const source = `
      import type { Server } from "node:net";
      /* uneffect:effect Console */
      function shutdown(server: Server) {
        server.close(() => console.log("closed"));
      }
    `;
    expect(analyzeEffects("node-close-effects.ts", source)).toEqual([]);
    expect(analyzeEffects("node-close-effects.ts", source.replace("effect Console", "effect Timer"))).toEqual(expect.arrayContaining([
      expect.objectContaining({ functionName: "shutdown", kind: "missing", effect: "Console" }),
      expect.objectContaining({ functionName: "shutdown", kind: "unused", effect: "Timer" }),
    ]));
    expect(analyzeEffects("node-close-named-effects.ts", `
      import type { Server } from "node:net";
      /* uneffect:effect Console */ function afterClose() { console.log("closed") }
      /* uneffect:effect Console */ function shutdown(server: Server) { server.close(afterClose) }
    `)).toEqual([]);
  });

  it("propagates deferred disposal callbacks from generic disposal-stack semantics", () => {
    const source = `
      /* uneffect:effect Console */
      function cleanup(stack: DisposableStack) { stack.defer(() => console.log("disposed")) }
      class LocalStack { defer(callback: () => void) { callback() } }
      function shadow(stack: LocalStack) { stack.defer(() => {}) }
    `;
    expect(analyzeEffects("disposal-stack.ts", source)).toEqual([]);
  });

  it("tracks Node DNS authority and callback capabilities through aliases", () => {
    const source = `
      import { lookup as resolveHost } from "node:dns";
      /* uneffect:effect Net<"example.com"> | Console */
      function resolve() { resolveHost("example.com", () => console.log("resolved")) }
      function lookup(_host: string, callback: () => void) { callback() }
      function local() { lookup("example.com", () => undefined) }
    `;
    expect(analyzeEffects("node-dns-effects.ts", source)).toEqual([]);
    expect(analyzeEffects("node-dns-effects.ts", source.replace('Net<"example.com">', 'Net<"other.example">'))).toContainEqual(
      expect.objectContaining({ functionName: "resolve", kind: "missing", effect: 'Net<"example.com">' }),
    );
  });

  it("narrows literal node:net connection options to a host-and-port authority", () => {
    const source = `
      import { createConnection as dial } from "node:net";
      /* uneffect:effect Net<"api.example.com:443"> */
      function connect() { return dial({ host: "api.example.com", port: 443 }, () => undefined) }
    `;
    expect(analyzeEffects("node-net-effects.ts", source)).toEqual([]);
    expect(analyzeEffects("node-net-effects.ts", source.replace("api.example.com:443", "other.example:443")))
      .toContainEqual(expect.objectContaining({
        functionName: "connect", kind: "missing", effect: 'Net<"api.example.com:443">',
      }));
  });

  it("tracks a TypeChecker-resolved Socket.connect listener without matching a lookalike", () => {
    const source = `
      import type { Socket } from "node:net";
      /* uneffect:effect Net<"api.example.com:443"> */
      function reconnect(socket: Socket) {
        return socket.connect({ host: "api.example.com", port: 443 }, () => undefined)
      }
      class LocalSocket { connect(_options: object, callback: () => void) { callback() } }
      function local(socket: LocalSocket) { socket.connect({}, () => undefined) }
    `;
    expect(analyzeEffects("node-socket-effects.ts", source)).toEqual([]);
  });

  it("tracks Random for synchronous and callback node:crypto randomBytes overloads", () => {
    const source = `
      import { randomBytes as secureBytes } from "node:crypto";
      /* uneffect:effect Random */
      function syncToken() { return secureBytes(32) }
      /* uneffect:effect Random | Console */
      function asyncToken() { secureBytes(32, (_error, bytes) => console.log(bytes.length)) }
      function randomBytes(_size: number, callback: () => void) { callback() }
      function local() { randomBytes(1, () => undefined) }
    `;
    expect(analyzeEffects("node-random-bytes-effects.ts", source)).toEqual([]);
  });

  it("treats common Web and Node randomness APIs as Random capability boundaries", () => {
    const source = `
      import { randomFill, randomFillSync, randomInt, randomUUID as nodeRandomUUID } from "node:crypto";
      /* uneffect:effect Random */
      function web(bytes: Uint8Array) { crypto.getRandomValues(bytes); return crypto.randomUUID() }
      /* uneffect:effect Random */
      function nodeSync(bytes: Uint8Array) { randomFillSync(bytes); randomInt(10); return nodeRandomUUID() }
      /* uneffect:effect Random | Console */
      function nodeAsync(bytes: Uint8Array) {
        randomFill(bytes, error => console.log(error))
        randomInt(1, 10, (error, value) => console.log(error, value))
      }
      const localCrypto = { getRandomValues<T>(value: T): T { return value } }
      function lookalike(bytes: Uint8Array) { localCrypto.getRandomValues(bytes) }
    `;
    expect(analyzeEffects("random-effects.ts", source)).toEqual([]);
  });

  it("narrows Node HTTP URL and options authorities without matching lookalikes", () => {
    const source = `
      import { request as httpRequest } from "node:http";
      import { get as httpsGet } from "node:https";
      /* uneffect:effect Net<"api.example.com:80"> */
      function byUrl() { return httpRequest("http://api.example.com/v1", () => undefined) }
      /* uneffect:effect Net<"secure.example.com:8443"> */
      function byOptions() { return httpsGet({ hostname: "secure.example.com", port: 8443 }, () => undefined) }
      function request(_url: string, callback: () => void) { callback() }
      function local() { request("http://api.example.com", () => undefined) }
    `;
    expect(analyzeEffects("node-http-effects.ts", source)).toEqual([]);
  });

  it("tracks Deno-compatible Run authority across child_process APIs", () => {
    const source = `
      import { exec, execFile as runFile, execSync, execFileSync, spawn, spawnSync, fork } from "node:child_process";
      /* uneffect:effect Run */ function shell() { exec("git status", () => undefined); execSync("git status") }
      /* uneffect:effect Run<"git"> */ function files() { runFile("git", ["status"], () => undefined); execFileSync("git", ["status"]); spawn("git"); spawnSync("git") }
      /* uneffect:effect Run */ function module() { fork("worker.js") }
      /* uneffect:effect Run */ function launch(program: string) { spawn(program) }
      /* uneffect:effect Run<"git"> */ function status() { launch("git") }
      function execFile(_file: string, callback: () => void) { callback() }
      function local() { execFile("git", () => undefined) }
    `;
    expect(analyzeEffects("node-child-process-effects.ts", source)).toEqual([]);
  });

  it("tracks Deno-compatible process.env authority by TypeChecker identity", () => {
    const source = `
      /* uneffect:effect Env<"HOME" | "CI"> */
      function exact(key: "HOME" | "CI") {
        process.env.CI = "1"
        const home = process.env["HOME"]
        delete process.env[key]
        return home
      }
      /* uneffect:effect Env */
      function dynamic(key: string) { return process.env[key] }
      function shadowed(process: { env: Record<string, string> }) { return process.env.HOME }
    `;
    expect(analyzeEffects("node-env-effects.ts", source)).toEqual([]);
    expect(analyzeEffects("node-env-effects.ts", source.replace('Env<"HOME" | "CI">', 'Env<"HOME">')))
      .toContainEqual(expect.objectContaining({ functionName: "exact", kind: "missing", effect: 'Env<"CI">' }));
  });

  it("tracks Deno-compatible Sys authority for TypeChecker-resolved node:os calls", () => {
    const source = `
      import { hostname as osHostname, cpus, userInfo as currentUser } from "node:os"
      /* uneffect:effect Sys<hostname | cpus | username | uid | gid | homedir> */
      function diagnostics() { return { hostname: osHostname(), cores: cpus().length, user: currentUser() } }
      function hostname() { return "shadowed" }
      function local() { return hostname() }
    `;
    expect(analyzeEffects("node-os-effects.ts", source)).toEqual([]);
    expect(analyzeEffects("node-os-effects.ts", source.replace(" | username | uid | gid | homedir", "")))
      .toContainEqual(expect.objectContaining({ functionName: "diagnostics", kind: "missing", effect: "Sys<username | uid | gid | homedir>" }));
  });

  it("tracks scoped Net authority for TypeChecker-resolved Node server listeners", () => {
    const source = `
      import { createServer } from "node:net"
      /* uneffect:effect Net<"127.0.0.1:8080"> | Console */
      function serve() { createServer().listen(8080, "127.0.0.1", () => console.log("ready")) }
      class Server { listen(_port: number, callback: () => void) { callback() } }
      function local() { new Server().listen(8080, () => undefined) }
    `;
    expect(analyzeEffects("node-net-listen.ts", source)).toEqual([]);
    expect(analyzeEffects("node-net-listen.ts", source.replace('Net<"127.0.0.1:8080">', "Console")))
      .toContainEqual(expect.objectContaining({ functionName: "serve", kind: "missing", effect: 'Net<"127.0.0.1:8080">' }));
  });

  it("propagates effects from TypeChecker-resolved Node request listeners", () => {
    const source = `
      import { createServer as createHttpServer } from "node:http"
      /* uneffect:effect Net<"127.0.0.1:8080"> | Console */
      function serve() {
        const server = createHttpServer((_request, _response) => console.log("request"))
        server.listen(8080, "127.0.0.1")
      }
      function createServer(callback: () => void) { callback(); return { listen() {} } }
      function local() { createServer(() => console.log("local")) }
    `;
    expect(analyzeEffects("node-http-server-effects.ts", source)).toEqual([]);
    expect(analyzeEffects("node-http-server-effects.ts", source.replace(" | Console", "")))
      .toContainEqual(expect.objectContaining({ functionName: "serve", kind: "missing", effect: "Console" }));
  });

  it("propagates effects from repeating node:fs watcher callbacks", () => {
    const source = `
      import { watch as watchFs } from "node:fs"
      /* uneffect:effect FsRead<"config.json"> | Console */
      function watchConfig() { watchFs("config.json", () => console.log("changed")) }
      function watch(_path: string, callback: () => void) { callback() }
      function local() { watch("config.json", () => console.log("local")) }
    `;
    expect(analyzeEffects("node-fs-watch-effects.ts", source)).toEqual([]);
    expect(analyzeEffects("node-fs-watch-effects.ts", source.replace(" | Console", "")))
      .toContainEqual(expect.objectContaining({ functionName: "watchConfig", kind: "missing", effect: "Console" }));
  });

  it("checks an inferred literal fs path against a structured declaration", () => {
    const source = `
      import { readFileSync } from "node:fs";
      /* uneffect:effect FsRead<"$WORKSPACE_ROOT/data/**"> */
      function load() { return readFileSync("$WORKSPACE_ROOT/data/users.json") }
    `;
    expect(analyzeEffects("fs.ts", source)).toEqual([]);
  });

  it("models fs.read as a filesystem read that mutates its buffer", () => {
    const source = `
      import { read } from "node:fs";
      /* uneffect:effect FsRead */
      function fill(fd: number, buffer: Buffer) { read(fd, buffer, 0, buffer.length, 0, () => {}) }
    `;
    expect(analyzeEffects("fs.ts", source)).toContainEqual(
      expect.objectContaining({ functionName: "fill", effect: "Mutate<typeof buffer>" }),
    );
  });

  it("models copyFile as both a filesystem read and write", () => {
    const source = `
      import * as fs from "node:fs";
      /* uneffect:effect FsWrite */
      function copy() { fs.copyFile("a", "b", () => {}) }
    `;
    expect(analyzeEffects("fs.ts", source)).toContainEqual(
      expect.objectContaining({ functionName: "copy", effect: 'FsRead<"a">' }),
    );
  });

  it("tracks member mutation as a reference-scoped effect", () => {
    const source = `
      /* uneffect:effect Mutate<typeof value> */
      function increment(value: { count: number }) { value.count++ }
    `;
    expect(analyzeEffects("mutate.ts", source)).toEqual([]);
  });

  it("resolves mutating builtins by symbol and ignores a user method with the same name", () => {
    const source = `
      /* uneffect:effect Mutate<typeof values> */
      function builtin(values: number[]) { values.push(1) }
      class Queue { push(_value: number) {} }
      function user(queue: Queue) { queue.push(1) }
    `;
    expect(analyzeEffects("mutation-symbol.ts", source)).toEqual([]);
  });

  it("consumes generic effect and mutation primitives without a legacy operation", () => {
    const builtinRegistry = extendBuiltinContractRegistry(builtinContractRegistry, { contracts: [{
      symbol: { module: "global", export: "console.log" }, evidence: "trusted",
      semantics: { schema: "uneffect-semantic-primitives/v1", primitives: [{ kind: "effect", capability: "Console" }, { kind: "throw", error: "TypeError" }] },
    }, {
      symbol: { module: "lib.es", export: "Array#push" }, evidence: "trusted",
      semantics: { schema: "uneffect-semantic-primitives/v1", primitives: [{ kind: "mutate", target: { kind: "receiver" } }] },
    }] });
    const source = `
      /* uneffect:effect Console | Mutate<typeof values> | Throw<TypeError> */
      function reviewed(values: number[]) { console.log(values); values.push(1) }
      class Queue { push(_value: number) {} }
      function shadows(console: { log(value: unknown): void }, queue: Queue) { console.log(queue); queue.push(1) }
    `;
    expect(analyzeEffects("generic-builtins.ts", source, { builtinRegistry })).toEqual([]);
  });

  it("does not leak mutations of freshly allocated locals into the function summary", () => {
    const source = `function localOnly() { const values: number[] = []; values.push(1); values.sort() }`;
    expect(analyzeEffects("locals.ts", source)).toEqual([]);
  });

  it("does not leak mutation of a reviewed fresh builtin result", () => {
    const source = `
      /* uneffect:effect none */
      function sortedKeys(value: object) { return Object.keys(value).sort() }
      /* uneffect:effect none */
      function sortedEntries(value: object) { return Object.entries(value).sort() }
    `;
    expect(analyzeEffects("fresh-result.ts", source)).toEqual([]);
  });

  it("treats toSorted as a non-mutating fresh copy while keeping sort destructive", () => {
    const source = `
      /* uneffect:effect none */
      function copied(values: number[]) { return values.toSorted().sort() }
      /* uneffect:effect Mutate<typeof values> */
      function inPlace(values: number[]) { return values.sort() }
    `;
    expect(analyzeEffects("to-sorted.ts", source)).toEqual([]);
  });

  it("tracks ArrayBuffer resize mutation and synchronous failure effects", () => {
    const source = `
      /* uneffect:effect Mutate<typeof buffer> | Throw<TypeError> | Throw<RangeError> */
      function resize(buffer: ArrayBuffer, size: number) { buffer.resize(size) }
    `;
    expect(analyzeEffects("resize.ts", source)).toEqual([]);
  });

  it("localizes mutation of a fresh default parameter but preserves an explicit alias", () => {
    const source = `
      function walk(value: string, seen = new Set<string>()) {
        seen.add(value)
        if (value.length > 1) walk(value.slice(1), seen)
      }
      /* uneffect:effect none */
      function local() { walk("abc") }
      /* uneffect:effect none */
      function aliased(seen: Set<string>) { walk("abc", seen) }
    `;
    const diagnostics = analyzeEffects("fresh-default.ts", source, { requireAnnotations: false });
    expect(diagnostics.filter((item) => item.functionName === "local")).toEqual([]);
    expect(diagnostics).toContainEqual(expect.objectContaining({
      functionName: "aliased", effect: "Mutate<typeof seen>", kind: "missing",
    }));
  });

  it("includes parameter and destructuring default initializers in function effects", () => {
    const source = `
      /* uneffect:effect Console */
      function report() { console.log("default") }
      /* uneffect:effect Console */
      function key() { console.log("key"); return "value" }
      /* uneffect:effect Console */
      function direct(value = report()) { return value }
      /* uneffect:effect Console */
      function destructured({ value = report() }: { value?: void } = {}) { return value }
      /* uneffect:effect Console */
      function computed({ [key()]: value }: Record<string, unknown> = {}) { return value }
      /* uneffect:effect Throw<Error> */
      function fail(): never { throw new Error("default") }
      /* uneffect:effect Throw<Error> */
      function throwing(value = fail()) { return value }
    `;
    expect(analyzeEffects("default-initializer-effects.ts", source)).toEqual([]);
    expect(analyzeEffects("missing-default-initializer-effect.ts", `
      /* uneffect:effect Console */
      function report() { console.log("default") }
      /* uneffect:effect none */
      function missed(value = report()) { return value }
    `)).toContainEqual(expect.objectContaining({ functionName: "missed", effect: "Console", kind: "missing" }));
  });

  it("supports inference-only adoption without weakening annotated boundaries", () => {
    expect(analyzeEffects("infer.ts", `function inferred() { console.log("x") }`, { requireAnnotations: false })).toEqual([]);
    expect(analyzeEffects("infer.ts", `/* uneffect:effect Timer */ function checked() { console.log("x") }`, { requireAnnotations: false }))
      .toContainEqual(expect.objectContaining({ functionName: "checked", effect: "Console", kind: "missing" }));
  });

  it("tracks standard process stdout and stderr writes as Console", () => {
    const source = `
      /* uneffect:effect Console */
      function output() { process.stdout.write("out"); process.stderr.write("err") }
      /* uneffect:effect none */
      function invalid() { process.stdout.write("out") }
    `;
    const diagnostics = analyzeEffects("process-streams.ts", source);
    expect(diagnostics.filter((item) => item.functionName === "output")).toEqual([]);
    expect(diagnostics).toContainEqual(expect.objectContaining({
      functionName: "invalid", effect: "Console", kind: "missing",
    }));
  });

  it("substitutes mutation regions through calls", () => {
    const source = `
      /* uneffect:effect Mutate<typeof value> */
      function increment(value: { count: number }) { value.count++ }
      /* uneffect:effect Mutate<typeof state> */
      function update(state: { count: number }) { increment(state) }
    `;
    expect(analyzeEffects("mutate.ts", source)).toEqual([]);
  });

  it("counts a narrower member mutation as use of a broad region", () => {
    const source = `
      /* uneffect:effect Mutate<typeof state> */
      function update(state: { nested: { count: number } }) { state.nested.count++ }
    `;
    expect(analyzeEffects("mutate.ts", source)).toEqual([]);
  });

  it("rejects mutation of a different reference", () => {
    const source = `
      /* uneffect:effect Mutate<typeof left> */
      function bad(left: { n: number }, right: { n: number }) { right.n = left.n }
    `;
    expect(analyzeEffects("mutate.ts", source)).toContainEqual(
      expect.objectContaining({ functionName: "bad", effect: "Mutate<typeof right.n>", kind: "missing" }),
    );
  });

  it("names the written property, not only the object that holds it", () => {
    const source = `
      /* uneffect:effect Mutate<typeof state.calls> */
      function bump(state: { calls: number; total: number }) { state.total += 1 }
    `;
    const [missing] = analyzeEffects("mutate.ts", source);
    expect(missing).toMatchObject({ functionName: "bump", effect: "Mutate<typeof state.total>", kind: "missing" });
    expect(missing?.notes).toContainEqual(expect.objectContaining({
      label: "out of authority",
      detail: expect.stringContaining("names a different region of state"),
    }));
  });

  it("accepts a declaration of exactly the written property", () => {
    expect(analyzeEffects("mutate.ts", `
      /* uneffect:effect Mutate<typeof state.calls> */
      function bump(state: { calls: number; total: number }) { state.calls += 1 }
    `)).toEqual([]);
  });

  it("keeps a mutating builtin at the receiver it is called on", () => {
    expect(analyzeEffects("mutate.ts", `
      /* uneffect:effect Mutate<typeof state.items> */
      function add(state: { items: number[] }, value: number) { state.items.push(value) }
    `)).toEqual([]);
  });

  it("widens a computed element write to its container and keeps a literal key a property", () => {
    const dynamic = analyzeEffects("mutate.ts", `
      function write(values: number[], index: number, value: number) { values[index] = value }
    `);
    expect(dynamic).toContainEqual(expect.objectContaining({ effect: "Mutate<typeof values>", kind: "missing" }));

    const literal = analyzeEffects("mutate.ts", `
      function write(table: Record<string, number>, value: number) { table["ready"] = value }
    `);
    expect(literal).toContainEqual(expect.objectContaining({ effect: "Mutate<typeof table.ready>", kind: "missing" }));
  });

  it("substitutes a member-path region through a call", () => {
    expect(analyzeEffects("mutate.ts", `
      /* uneffect:effect Mutate<typeof target.count> */
      function increment(target: { count: number }) { target.count++ }
      /* uneffect:effect Mutate<typeof state.inner.count> */
      function update(state: { inner: { count: number } }) { increment(state.inner) }
    `)).toEqual([]);
  });

  it("tracks the concrete Error constructed by a throw statement", () => {
    const source = `
      /* uneffect:effect Throw<RangeError> */
      function parse(value: number) { if (value < 0) throw new RangeError("negative") }
    `;
    expect(analyzeEffects("throw.ts", source)).toEqual([]);
  });

  it("propagates typed throw effects through local calls", () => {
    const source = `
      class ParseError extends Error {}
      /* uneffect:effect Throw<ParseError> */ function parse() { throw new ParseError() }
      /* uneffect:effect Throw<ParseError> */ function main() { parse() }
    `;
    expect(analyzeEffects("throw.ts", source)).toEqual([]);
  });

  it("allows Throw<Error> as an upper bound for concrete Error types", () => {
    const source = `/* uneffect:effect Throw<Error> */ function f() { throw new TypeError("bad") }`;
    expect(analyzeEffects("throw.ts", source)).toEqual([]);
  });

  it("preserves an Error-constrained type parameter", () => {
    const source = `
      /* uneffect:effect Throw<T> */
      function raise<T extends Error>(error: T): never { throw error }
    `;
    expect(analyzeEffects("throw.ts", source)).toEqual([]);
  });

  it("tracks non-Error JavaScript throws as Throw<unknown>", () => {
    const source = `/* uneffect:effect Throw<Error> */ function f() { throw "bad" }`;
    expect(analyzeEffects("throw.ts", source)).toContainEqual(
      expect.objectContaining({ functionName: "f", effect: "Throw<unknown>", kind: "missing" }),
    );
  });

  it("does not classify an async-function rejection as synchronous Throw", () => {
    const source = `
      /* uneffect:effect Throw<RangeError> */
      async function rejects() { throw new RangeError("async") }
      function starts() { rejects() }
    `;
    const diagnostics = analyzeEffects("async-rejection.ts", source);
    expect(diagnostics).toContainEqual(expect.objectContaining({
      functionName: "rejects", effect: "Throw<RangeError>", kind: "unused",
    }));
    expect(diagnostics).not.toContainEqual(expect.objectContaining({
      functionName: "starts", effect: "Throw<RangeError>", kind: "missing",
    }));
  });

  it("moves generator effects from construction to iterator consumption", () => {
    const source = `
      /* uneffect:effect Console | Throw<RangeError> */
      function* generate() { console.log("step"); throw new RangeError("step") }
      function constructOnly() { generate() }
      function buildIterator() { return generate() }
      function consumeNext() { generate().next() }
      function consumeLoop() { for (const value of generate()) void value }
      function consumeFactory() { for (const value of buildIterator()) void value }
      /* uneffect:effect Console */
      function* logOnly() { console.log("log") }
      /* uneffect:effect Throw<TypeError> */
      function* failOnly() { throw new TypeError("fail") }
      function chooseIterator(log: boolean) {
        if (log) return logOnly()
        return failOnly()
      }
      function consumeBranchingFactory(log: boolean) {
        for (const value of chooseIterator(log)) void value
      }
      /* uneffect:effect Console */
      function caughtConsumption() { try { generate().next() } catch {} }
      /* uneffect:effect Console | Throw<URIError> */
      async function* generateAsync() { console.log("async step"); throw new URIError("async step") }
      async function consumeAsync() { for await (const value of generateAsync()) void value }
    `;
    const diagnostics = analyzeEffects("generator-effects.ts", source);
    expect(diagnostics.filter((item) => item.functionName === "constructOnly")).toEqual([]);
    expect(diagnostics).toContainEqual(expect.objectContaining({
      functionName: "consumeNext", effect: "Console", kind: "missing",
    }));
    expect(diagnostics).toContainEqual(expect.objectContaining({
      functionName: "consumeNext", effect: "Throw<RangeError>", kind: "missing",
    }));
    expect(diagnostics).toContainEqual(expect.objectContaining({
      functionName: "consumeLoop", effect: "Console", kind: "missing",
    }));
    expect(diagnostics).toContainEqual(expect.objectContaining({
      functionName: "consumeFactory", effect: "Console", kind: "missing",
    }));
    expect(diagnostics).toContainEqual(expect.objectContaining({
      functionName: "consumeFactory", effect: "Throw<RangeError>", kind: "missing",
    }));
    expect(diagnostics).toContainEqual(expect.objectContaining({
      functionName: "consumeBranchingFactory", effect: "Console", kind: "missing",
    }));
    expect(diagnostics).toContainEqual(expect.objectContaining({
      functionName: "consumeBranchingFactory", effect: "Throw<TypeError>", kind: "missing",
    }));
    expect(diagnostics.filter((item) => item.functionName === "caughtConsumption")).toEqual([]);
    expect(diagnostics).toContainEqual(expect.objectContaining({
      functionName: "generateAsync", effect: "Throw<URIError>", kind: "unused",
    }));
    expect(diagnostics).toContainEqual(expect.objectContaining({
      functionName: "consumeAsync", effect: "Console", kind: "missing",
    }));
    expect(diagnostics).not.toContainEqual(expect.objectContaining({
      functionName: "consumeAsync", effect: "Throw<URIError>", kind: "missing",
    }));
  });

  it("does not admit a class that is not assignable to Error", () => {
    const source = `class NotAnError {} /* uneffect:effect Throw<Error> */ function f() { throw new NotAnError() }`;
    expect(analyzeEffects("throw.ts", source)).toContainEqual(expect.objectContaining({ functionName: "f", effect: "Throw<unknown>", kind: "missing" }));
  });

  it("discharges a direct typed throw caught by try/catch", () => {
    const source = `function f() { try { throw new RangeError("bad") } catch {} }`;
    expect(analyzeEffects("throw.ts", source)).toEqual([]);
  });

  it("discharges a transitive throw from a call in a try block", () => {
    const source = `
      /* uneffect:effect Throw<RangeError> */ function dangerous() { throw new RangeError("bad") }
      function safe() { try { dangerous() } catch {} }
    `;
    expect(analyzeEffects("throw.ts", source)).toEqual([]);
  });

  it("does not discharge a throw originating in the catch body", () => {
    const source = `
      /* uneffect:effect Throw<TypeError> */
      function translate() {
        try { throw new RangeError("bad") }
        catch { throw new TypeError("translated") }
      }
    `;
    expect(analyzeEffects("throw.ts", source)).toEqual([]);
  });

  it("preserves non-throw effects inside a caught try block", () => {
    const source = `
      /* uneffect:effect Console */
      function f() {
        try { console.log("before"); throw new Error("bad") } catch {}
      }
    `;
    expect(analyzeEffects("throw.ts", source)).toEqual([]);
  });

  it("warns when a declared throw is fully discharged", () => {
    const source = `
      /* uneffect:effect Throw<Error> */
      function f() { try { throw new Error("bad") } catch {} }
    `;
    expect(analyzeEffects("throw.ts", source)).toContainEqual(
      expect.objectContaining({ functionName: "f", effect: "Throw<Error>", kind: "unused" }),
    );
  });

  it("does not treat try/finally without catch as a discharge point", () => {
    const source = `
      /* uneffect:effect Throw<RangeError> */
      function f() { try { throw new RangeError("bad") } finally { console.log() } }
    `;
    expect(analyzeEffects("throw.ts", source)).toContainEqual(
      expect.objectContaining({ functionName: "f", effect: "Console", kind: "missing" }),
    );
    expect(analyzeEffects("throw.ts", source)).not.toContainEqual(
      expect.objectContaining({ functionName: "f", effect: "Throw<RangeError>", kind: "missing" }),
    );
  });

  it("propagates a new throw from finally after discharging the try body", () => {
    const source = `
      /* uneffect:effect Throw<TypeError> */
      function f() {
        try { throw new RangeError("caught") }
        catch {}
        finally { throw new TypeError("escapes") }
      }
    `;
    expect(analyzeEffects("throw.ts", source)).toEqual([]);
  });

  it("warns for an unknown user effect in gradual mode", () => {
    const source = `/* uneffect:effect app.Audit */ function f() {}`;
    expect(analyzeEffects("unknown.ts", source)).toContainEqual(
      expect.objectContaining({ functionName: "f", effect: "app.Audit", kind: "unknown", severity: "warning" }),
    );
  });

  it("rejects an unknown user effect in strict mode", () => {
    const source = `/* uneffect:effect app.Audit */ function f() {}`;
    expect(analyzeEffects("unknown.ts", source, { mode: "strict" })).toContainEqual(
      expect.objectContaining({ functionName: "f", effect: "app.Audit", kind: "unknown", severity: "error" }),
    );
  });

  it("infers scoped Fetch and its independent Net authority", () => {
    const source = `async function load() { await fetch("https://api.example.com/v1/users", { method: "POST" }) }`;
    expect(analyzeEffects("fetch.ts", source)).toEqual(expect.arrayContaining([
      expect.objectContaining({ effect: 'Fetch<POST, "https://api.example.com/v1/users">', kind: "missing" }),
      expect.objectContaining({ effect: 'Net<"api.example.com:443">', kind: "missing" }),
    ]));
  });

  it("degrades dynamic Fetch inputs to explicit unknown sets", () => {
    const source = `async function load(url: string, method: string) { await fetch(url, { method }) }`;
    expect(analyzeEffects("fetch.ts", source)).toEqual(expect.arrayContaining([
      expect.objectContaining({ effect: "Fetch<Unknown<dynamic-method>, Unknown<dynamic-url>>" }),
      expect.objectContaining({ effect: "Net<Unknown<dynamic-origin>>" }),
    ]));
  });

  it("infers a segment glob from a numerically constrained template substitution", () => {
    const source = "async function load(id: number) { await fetch(`https://api.example.com/users/${id as number}`) }";
    expect(analyzeEffects("fetch.ts", source)).toEqual(expect.arrayContaining([
      expect.objectContaining({ effect: 'Fetch<GET, "https://api.example.com/users/*">' }),
      expect.objectContaining({ effect: 'Net<"api.example.com:443">' }),
    ]));
  });
});
