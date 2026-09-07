import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";

it("executes spec authoring helpers without loading a compiler or parser", () => {
  const script = `
    import { registerHooks } from 'node:module';
    import assert from 'node:assert/strict';
    registerHooks({ resolve(specifier, context, next) {
      if (/^(?:typescript(?:\\/|$)|@typescript\\/typescript6(?:\\/|$)|oxc-parser(?:\\/|$)|@corsa-bind\\/)/.test(specifier)) throw new Error('Unexpected compiler dependency: ' + specifier);
      return next(specifier, context);
    } });
    const spec = await import('./src/spec/index.ts');
    assert.equal(spec.uneffectSpecVersion, 'uneffect-spec/v1');
    assert.deepEqual(spec.int(), { kind: 'int' });
    assert.deepEqual(spec.nat(), { kind: 'nat' });
    assert.deepEqual(spec.float(), { kind: 'float' });
    const temporal = { state: { ready: spec.bool() }, init: { ready: false }, actions: {} };
    assert.equal(spec.defineTemporal(temporal), temporal);
    const capability = { effects: [spec.Console(), spec.Fetch({ methods: ['GET'], urls: ['https://example.com'] })] };
    assert.equal(spec.defineCapability(capability), capability);
    const contract = { parameters: { x: spec.int() }, returns: spec.int(), ensures: () => true };
    assert.equal(spec.defineContract(contract), contract);
    assert.deepEqual(spec.nodeGlobalRuntime(24, 'main'), { kind: 'node-global', identity: 'node:global@24#main', major: 24, realm: 'main' });
    assert.throws(() => spec.identityProjection('x()'));
    assert.throws(() => spec.nodeGlobalRuntime(0, 'main'));
    assert.deepEqual(spec.mapFromEntriesProjection('state.entries'), { kind: 'map-from-entries', path: 'state.entries' });
  `;
  expect(() => execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { timeout: 30_000, stdio: "pipe" })).not.toThrow();
});
