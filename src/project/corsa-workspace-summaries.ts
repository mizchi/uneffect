import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Node } from "oxc-parser";
import { openCorsaCallableFrontend, type CorsaCallableFrontend } from "../frontends/corsa/corsa-callable-frontend.js";
import { oxcChildren, parseOxcSource, topLevelOxcFunctions, type OxcSource } from "../frontends/oxc/source.js";
import { inspectCorsaWorkspaceBuildOutputs } from "./corsa-workspace-build-output.js";
import { digest, errorMessage, nativeConfigArguments, openNativeCompiler } from "./native-build-output.js";
import type { ComposeCorsaWorkspaceSummariesOptions, CorsaWorkspaceSummaryBinding, CorsaWorkspaceSummaryComposition } from "./corsa-workspace-summary-contracts.js";

export type { ComposeCorsaWorkspaceSummariesOptions, CorsaWorkspaceSummary, CorsaWorkspaceSummaryCall,
  CorsaWorkspaceSummaryClaims, CorsaWorkspaceSummaryBinding, CorsaWorkspaceSummaryComposition } from "./corsa-workspace-summary-contracts.js";

function nodes(root: Node): Node[] {
  const pending = [root], result: Node[] = [];
  while (pending.length) {
    const node = pending.pop()!;
    result.push(node);
    pending.push(...oxcChildren(node));
  }
  return result;
}
function sameSpan(left: { start: number; end: number }, right: { start: number; end: number }): boolean {
  return left.start === right.start && left.end === right.end;
}

/** Authenticate a direct imported binding, rather than only its structural call signature. */
function importedCall(frontend: CorsaCallableFrontend, source: OxcSource, span: { start: number; end: number }) {
  const call = nodes(source.program).find(node => node.type === "CallExpression" && sameSpan(node, span));
  if (call?.type !== "CallExpression" || call.callee.type !== "Identifier") throw new Error("only direct imported identifier calls are supported");
  const name = call.callee.name;
  const imports = source.program.body.flatMap(statement => statement.type === "ImportDeclaration" && statement.importKind !== "type"
    ? statement.specifiers.filter(specifier => specifier.type !== "ImportNamespaceSpecifier"
      && !(specifier.type === "ImportSpecifier" && specifier.importKind === "type") && specifier.local.name === name) : []);
  if (imports.length !== 1) throw new Error("call is not a direct imported binding");
  const imported = frontend.getSymbolAtPosition(source.fileName, imports[0]!.local.start);
  const actual = frontend.getSymbolAtPosition(source.fileName, call.callee.start);
  const target = imported && frontend.getAliasedSymbol(imported);
  if (!target || actual?.id !== imported?.id) throw new Error("call does not use the authenticated import binding");
  return { call, declarations: frontend.getDeclarationSpans(target) };
}

function assertClaims(claims: unknown): void {
  if (!claims || typeof claims !== "object" || Array.isArray(claims)) throw new Error("summary claims must be an object");
  const entries = Object.entries(claims);
  if (!entries.length || entries.some(([key, value]) => !["requires", "ensures", "effects"].includes(key)
    || !Array.isArray(value) || value.some(item => typeof item !== "string" || !item.trim()))) throw new Error("summary claims must contain only requires/ensures/effects string arrays");
}

/** Conservative source-write screening in one native project snapshot. */
function assertUnwritten(frontend: CorsaCallableFrontend, target: { fileName: string; position: number }, sources: readonly OxcSource[]): void {
  const symbol = frontend.getSymbolAtPosition(target.fileName, target.position);
  if (!symbol) throw new Error("producer callable symbol is unavailable");
  for (const source of sources) for (const node of nodes(source.program)) {
    const left = node.type === "AssignmentExpression" ? node.left : node.type === "UpdateExpression" ? node.argument
      : node.type === "ForInStatement" || node.type === "ForOfStatement" ? node.left : undefined;
    if (!left) continue;
    for (const written of nodes(left)) {
      if (written.type !== "Identifier") continue;
      const local = frontend.getSymbolAtPosition(source.fileName, written.start);
      if (!local) continue;
      const alias = frontend.getAliasedSymbol(local), resolved = alias ?? local;
      const namespaceWrite = alias && frontend.getDeclarationSpans(alias).some(declaration =>
        declaration.fileName === target.fileName && declaration.span.start <= target.position && declaration.span.end > target.position);
      if (resolved.id === symbol.id || namespaceWrite) throw new Error("callable or its module namespace has a source-level write");
    }
  }
}

/**
 * Bind explicit contract/effect claims at requested cross-project calls using
 * exact native source declarations. Does not infer summaries or prove bodies.
 * Persisted claims remain trusted, including claims labelled verified upstream.
 * Native build inputs and outputs must remain quiescent throughout the call.
 */
export async function composeCorsaWorkspaceSummaries(input: ComposeCorsaWorkspaceSummariesOptions): Promise<CorsaWorkspaceSummaryComposition> {
  // Caller mutation while native frontends open must not alter admitted claims.
  const options = structuredClone(input);
  const absolute = (file: string) => resolve(options.cwd ?? process.cwd(), file);
  options.configFile = absolute(options.configFile);
  const build = inspectCorsaWorkspaceBuildOutputs(options);
  const bindings: CorsaWorkspaceSummaryBinding[] = [];
  const blockers: Array<{ call?: typeof options.calls[number]; message: string }> = [];
  const result = (status: CorsaWorkspaceSummaryComposition["status"]): CorsaWorkspaceSummaryComposition => ({
    schema: "uneffect-corsa-workspace-summary-composition/v1", status, build, bindings, blockers,
  });
  if (build.status !== "verified") {
    blockers.push({ message: `workspace build outputs are not verified: ${build.message ?? build.status}` });
    return result("unknown");
  }
  if (!options.calls.length) return result("not-applicable");
  const frontends = new Map<string, CorsaCallableFrontend>();
  try {
    const native = openNativeCompiler(options);
    const projects = new Map(build.projects.map(project => [project.configFile, project]));
    const files = new Map<string, Set<string>>();
    for (const project of build.projects) if (project.kind === "project") {
      const selected = native.run([...nativeConfigArguments(project.configFile), "--listFilesOnly"]);
      files.set(project.configFile, new Set(selected.trim().split(/\r?\n/u).filter(Boolean).map(absolute)));
    }
    const dependsOn = (consumer: string, producer: string): boolean =>
      projects.get(consumer)?.references.some(reference => reference === producer || dependsOn(reference, producer)) ?? false;
    const frontend = async (projectFile: string): Promise<CorsaCallableFrontend> => {
      const known = frontends.get(projectFile);
      if (known) return known;
      const opened = await openCorsaCallableFrontend({ ...options, configFile: projectFile });
      frontends.set(projectFile, opened);
      if (digest(readFileSync(opened.compilerExecutable)) !== build.compiler.digest) throw new Error("native compiler changed during summary binding");
      const errors = opened.getProjectDiagnostics().filter(item => item.category === "error");
      if (errors.length) throw new Error(errors.map(item => `TS${item.code}: ${item.message}`).join("\n"));
      return opened;
    };
    const sources = new Map<string, OxcSource>();
    const source = (file: string, native: CorsaCallableFrontend): OxcSource => {
      const parsed = sources.get(file) ?? parseOxcSource(file, readFileSync(file, "utf8"));
      native.assertSource(file, parsed.text);
      sources.set(file, parsed);
      return parsed;
    };
    const ids = new Set<string>();
    for (const summary of options.summaries) {
      if (!summary.id || ids.has(summary.id)) throw new Error("workspace summary IDs must be nonempty and unique");
      ids.add(summary.id);
    }
    for (const requested of options.calls) {
      const call = { ...requested, projectFile: absolute(requested.projectFile), fileName: absolute(requested.fileName) };
      try {
        if (!files.get(call.projectFile)?.has(call.fileName)) throw new Error("call source is not a compiler-selected input of the consumer project");
        const consumer = await frontend(call.projectFile), caller = source(call.fileName, consumer);
        const imported = importedCall(consumer, caller, call.span), callNode = imported.call;
        const signature = consumer.getResolvedSignature(call.fileName, call.span, caller.text);
        if (!signature) throw new Error("native resolved signature has no source declaration");
        const declaration = signature.declaration;
        if (!imported.declarations.some(item => item.fileName === declaration.fileName && sameSpan(item.span, declaration.span))) throw new Error("import symbol declaration differs from its structural call signature");
        if (/\.d\.[cm]?ts$/u.test(declaration.fileName)) throw new Error("declaration-output targets are unsupported; native source-reference identity is required");
        const owners = [...files].filter(([project, selected]) => selected.has(declaration.fileName) && dependsOn(call.projectFile, project));
        if (owners.length !== 1) throw new Error("native declaration does not have one referenced producer project");
        const projectFile = owners[0]![0], project = projects.get(projectFile)!;
        const producer = await frontend(projectFile), implementation = source(declaration.fileName, producer);
        const functions = topLevelOxcFunctions(implementation).filter(fn => sameSpan(fn, declaration.span));
        if (functions.length !== 1) throw new Error("only exact top-level function implementations are supported; no name or overload fallback");
        const fn = functions[0]!;
        const ownSignature = producer.getSignatureFromDeclaration(declaration.fileName, fn, implementation.text);
        if (!ownSignature || !sameSpan(ownSignature.declaration.span, declaration.span) || ownSignature.declaration.fileName !== declaration.fileName) throw new Error("producer and consumer disagree on the source declaration");
        if (fn.node.params.length !== ownSignature.parameters.length
          || fn.node.params.some((parameter, index) => parameter.type !== "Identifier" || parameter.name === "this" || parameter.name !== ownSignature.parameters[index]?.name)
          || callNode.arguments.some(argument => argument.type === "SpreadElement")
          || callNode.arguments.length !== ownSignature.parameters.length) throw new Error("summary binding requires explicit arguments for simple named parameters");
        const matches = options.summaries.filter(summary => absolute(summary.projectFile) === projectFile
          && absolute(summary.source.fileName) === declaration.fileName && sameSpan(summary.source.span, declaration.span));
        if (matches.length !== 1) throw new Error("native declaration does not have one exact summary");
        const summary = matches[0]!;
        if (summary.compiler.version !== build.compiler.version || summary.compiler.digest !== build.compiler.digest) throw new Error("summary compiler identity does not match the native build");
        if (summary.inputDigest !== project.inputDigest) throw new Error("summary project input digest is stale");
        if (summary.source.digest !== digest(implementation.text)) throw new Error("summary source digest is stale");
        if (summary.evidence !== "verified" && summary.evidence !== "trusted") throw new Error(`summary has ${summary.evidence} producer evidence`);
        assertClaims(summary.claims);
        const producerSources = [...files.get(projectFile)!].filter(file => /(?<!\.d)\.[cm]?ts$/u.test(file)).map(file => source(file, producer));
        assertUnwritten(producer, { fileName: declaration.fileName, position: fn.node.id.start }, producerSources);
        source(declaration.fileName, consumer);
        const consumerSources = [...files.get(call.projectFile)!].filter(file => /(?<!\.d)\.[cm]?ts$/u.test(file)).map(file => source(file, consumer));
        assertUnwritten(consumer, { fileName: declaration.fileName, position: fn.node.id.start }, consumerSources);
        bindings.push({ summaryId: summary.id, call, producer: { projectFile, inputDigest: project.inputDigest!,
          source: { fileName: declaration.fileName, span: declaration.span, digest: summary.source.digest } },
          arguments: ownSignature.parameters.map((parameter, index) => ({ parameter: parameter.name,
            span: { start: callNode.arguments[index]!.start, end: callNode.arguments[index]!.end } })),
          claims: summary.claims, linkage: "verified", evidence: "trusted", producerEvidence: summary.evidence });
      } catch (error) { blockers.push({ call, message: errorMessage(error) }); }
    }
    // Native snapshots and emission probes are separate observations. Recheck
    // the full graph before retaining any cross-project binding.
    const after = inspectCorsaWorkspaceBuildOutputs(options);
    if (JSON.stringify(after) !== JSON.stringify(build)) throw new Error("workspace compiler, inputs or outputs changed during summary composition");
    for (const [file, parsed] of sources) if (readFileSync(file, "utf8") !== parsed.text) throw new Error(`source changed during summary composition: ${file}`);
    return result(blockers.length ? "unknown" : "bound");
  } catch (error) {
    bindings.length = 0;
    blockers.push({ message: errorMessage(error) });
    return result("unknown");
  } finally {
    let failure: unknown;
    for (const native of frontends.values()) {
      try { native.close(); } catch (error) { failure ??= error; }
    }
    if (failure) throw failure;
  }
}
