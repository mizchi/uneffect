import ts from "typescript";
import { describe, expect, it } from "vitest";
import { overlayCorsaBuiltinCatalog } from "../src/corsa-builtin-catalog.js";
import type { CorsaApiFrontend, CorsaBuiltinCallResolution } from "../src/corsa-api-frontend.js";
import type { FrontendSymbolAdapter } from "../src/frontend-adapter.js";

const fileName = "/workspace/index.ts";
const sourceText = [
  `export const load = () => {`,
  `  fetch("https://example.com");`,
  `  console.log("x");`,
  `  localFetch("no");`,
  `};`,
  `declare function localFetch(url: string): void;`,
].join("\n");

function unusedAdapter(): FrontendSymbolAdapter {
  return {
    resolveCall: () => undefined,
    resolveConstruct: () => undefined,
    resolveProperty: () => undefined,
    resolveDomReceiverRegion: () => undefined,
    isDomReceiver: () => false,
    mayInvokeUserCode: () => false,
    ownershipKind: () => "shared",
    thrownErrorType: () => "Error",
    resolveConstInitializer: () => undefined,
    resolveStaticString: () => undefined,
    isSameReference: () => false,
  };
}

function frontend(classify: CorsaApiFrontend["classifyBuiltinCalls"]): Pick<CorsaApiFrontend, "rootFiles" | "classifyBuiltinCalls"> {
  return { rootFiles: [fileName], classifyBuiltinCalls: classify };
}

function callNamed(source: ts.SourceFile, name: string): ts.CallExpression {
  let found: ts.CallExpression | undefined;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isCallExpression(node)) {
      const expression = node.expression;
      const callee = ts.isPropertyAccessExpression(expression) ? expression.name.text : ts.isIdentifier(expression) ? expression.text : undefined;
      if (callee === name) found = node;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (!found) throw new Error(`missing call ${name}`);
  return found;
}

describe("Corsa builtin catalog overlay", () => {
  it("resolves admitted Fetch and Console from Corsa without the TypeScript adapter", () => {
    const source = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.ES2024, true, ts.ScriptKind.TS);
    const fetchCall = callNamed(source, "fetch");
    const logCall = callNamed(source, "log");
    const localCall = callNamed(source, "localFetch");
    const overlay = overlayCorsaBuiltinCatalog(unusedAdapter(), frontend((_file, queries) => queries.map((query): CorsaBuiltinCallResolution | null => {
      const slice = sourceText.slice(query.calleePosition);
      if (slice.startsWith("fetch")) {
        return { operation: "Fetch", compilerRevision: "corsa-api@test", symbol: { id: "1", name: "fetch" } };
      }
      if (slice.startsWith("log")) {
        return {
          operation: "Console", compilerRevision: "corsa-api@test",
          symbol: { id: "2", name: "log" }, receiver: { id: "3", name: "console" },
        };
      }
      return null;
    })) as CorsaApiFrontend);

    expect(overlay.resolveCall(fetchCall)).toMatchObject({
      symbol: { module: "global", export: "fetch" }, evidence: "trusted",
    });
    expect(overlay.resolveCall(logCall)).toMatchObject({
      symbol: { module: "global", export: "console.log" }, evidence: "trusted",
    });
    expect(overlay.resolveCall(localCall)).toBeUndefined();
  });

  it("does not treat a Corsa miss as proof and keeps the TypeScript adapter as fallback", () => {
    const source = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.ES2024, true, ts.ScriptKind.TS);
    const fetchCall = callNamed(source, "fetch");
    const typescript: FrontendSymbolAdapter = {
      ...unusedAdapter(),
      resolveCall: (call) => call === fetchCall
        ? { symbol: { module: "global", export: "fetch" }, span: { start: call.getStart(), end: call.getEnd() }, evidence: "trusted" }
        : undefined,
    };
    const overlay = overlayCorsaBuiltinCatalog(typescript, frontend(() => [null, null, null]) as CorsaApiFrontend);
    expect(overlay.resolveCall(fetchCall)).toMatchObject({ symbol: { export: "fetch" } });
  });
});
