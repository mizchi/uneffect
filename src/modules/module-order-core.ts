import { createHash } from "node:crypto";
import type {
  ModuleInitializationEvent, ModuleInitializationSourceEvidence, ModuleInitializationConstraint,
  ModuleInitializationChoice, ModuleInitializationModule, ModuleInitializationCycleRequest,
  ModuleInitializationCycleComponent, ModuleInitializationUnknown, ModuleInitializationOrder,
} from "./contracts.js";

export interface ModuleSource { readonly fileName: string; readonly text: string }
export interface ModuleSpan { readonly start: number; readonly end: number }
export interface ModuleSourceFacts {
  readonly source: ModuleSource;
  readonly dependencies: string[];
  readonly dependencyRequests: Array<{ dependency: string; span: ModuleSpan; sideEffectOnly: boolean }>;
  readonly awaits: ModuleSpan[];
  readonly handledPromiseLaunch?: { launchSpan: ModuleSpan; handlerSpan: ModuleSpan };
  readonly directThrow?: ModuleSpan;
  readonly unknowns: ModuleInitializationUnknown[];
}
export interface ModuleOrderFrontend {
  readonly compiler: ModuleInitializationOrder["compiler"];
  getModule(fileName: string): ModuleSourceFacts | undefined;
  readonly diagnostics: readonly ModuleInitializationUnknown[];
}

/** Shared ordering and cycle analysis over authenticated frontend facts. */
export function buildModuleInitializationOrder(frontend: ModuleOrderFrontend, entryFile: string): ModuleInitializationOrder {
  const constraints: ModuleInitializationConstraint[] = [], unknowns: ModuleInitializationUnknown[] = [];
  const records = new Map<string, ModuleSourceFacts>(), visiting = new Set<string>(), visited = new Set<string>(), cycleFiles = new Set<string>();
  const ordered: string[] = [];
  const entry = frontend.getModule(entryFile)?.source;
  const addUnknown = (item: ModuleInitializationUnknown): void => {
    if (!unknowns.some(existing => existing.fileName === item.fileName && existing.kind === item.kind
      && existing.span?.start === item.span?.start && (item.kind !== "typescript-error" || existing.detail === item.detail))) unknowns.push(item);
  };
  const inspect = (source: ModuleSource): ModuleSourceFacts => {
    const record = frontend.getModule(source.fileName)!;
    records.set(source.fileName, record);
    record.unknowns.forEach(addUnknown);
    return record;
  };
  const sourceEvidence = (fileName: string): ModuleInitializationSourceEvidence => ({
    kind: "program-source", sourceDigest: createHash("sha256").update(records.get(fileName)?.source.text ?? "").digest("hex"),
  });
  const stack: string[] = [];
  const discoveryOrder = new Map<string, number>();
  const visit = (source: ModuleSource): void => {
    if (visiting.has(source.fileName)) {
      const start = stack.indexOf(source.fileName);
      for (const fileName of stack.slice(start)) cycleFiles.add(fileName);
      cycleFiles.add(source.fileName);
      return;
    }
    if (visited.has(source.fileName)) return;
    visiting.add(source.fileName);
    if (!discoveryOrder.has(source.fileName)) discoveryOrder.set(source.fileName, discoveryOrder.size);
    stack.push(source.fileName);
    const record = inspect(source);
    for (const dependencyName of record.dependencies) {
      const dependency = frontend.getModule(dependencyName)?.source;
      if (dependency) visit(dependency);
    }
    stack.pop();
    visiting.delete(source.fileName);
    visited.add(source.fileName);
    ordered.push(source.fileName);
  };
  if (!entry) addUnknown({ fileName: entryFile, kind: "entry-not-found", detail: "entry source is absent from the Program" });
  else visit(entry);
  const reachable = new Set(ordered);
  for (const diagnostic of frontend.diagnostics) {
    if (!diagnostic.span || reachable.has(diagnostic.fileName)) addUnknown(diagnostic);
  }
  const tarjanIndex = new Map<string, number>(), tarjanLow = new Map<string, number>();
  const tarjanStack: string[] = [], tarjanOnStack = new Set<string>();
  const stronglyConnected: string[][] = [];
  let nextTarjanIndex = 0;
  const connect = (fileName: string): void => {
    tarjanIndex.set(fileName, nextTarjanIndex);
    tarjanLow.set(fileName, nextTarjanIndex++);
    tarjanStack.push(fileName);
    tarjanOnStack.add(fileName);
    for (const dependency of records.get(fileName)?.dependencies ?? []) {
      if (!reachable.has(dependency)) continue;
      if (!tarjanIndex.has(dependency)) {
        connect(dependency);
        tarjanLow.set(fileName, Math.min(tarjanLow.get(fileName)!, tarjanLow.get(dependency)!));
      } else if (tarjanOnStack.has(dependency)) {
        tarjanLow.set(fileName, Math.min(tarjanLow.get(fileName)!, tarjanIndex.get(dependency)!));
      }
    }
    if (tarjanLow.get(fileName) !== tarjanIndex.get(fileName)) return;
    const component: string[] = [];
    while (tarjanStack.length > 0) {
      const current = tarjanStack.pop()!;
      tarjanOnStack.delete(current);
      component.push(current);
      if (current === fileName) break;
    }
    stronglyConnected.push(component);
  };
  if (entry) connect(entry.fileName);
  const cycleComponents: ModuleInitializationCycleComponent[] = [];
  const admittedCycleFiles = new Set<string>();
  for (const rawComponent of stronglyConnected) {
    if (rawComponent.length < 2) continue;
    const members = new Set(rawComponent);
    const modules = [...rawComponent].sort((left, right) => discoveryOrder.get(left)! - discoveryOrder.get(right)!);
    const root = modules[0]!;
    const unsafeUnknown = unknowns.find((unknown) => members.has(unknown.fileName));
    const recordsInComponent = modules.map((fileName) => records.get(fileName)!);
    const internalRequests = recordsInComponent.map((record) =>
      record.dependencyRequests.filter((request) => members.has(request.dependency)));
    const hasAwait = recordsInComponent.some((record) => record.awaits.length > 0);
    const simpleSideEffectRing = !unsafeUnknown && !hasAwait
      && recordsInComponent.every((record) => record.directThrow === undefined && record.dependencies.length === 1)
      && internalRequests.every((requests) => requests.length === 1 && requests[0]!.sideEffectOnly);
    if (!simpleSideEffectRing) {
      const detail = hasAwait
        ? "cyclic ESM with top-level await is outside the synchronous ring fragment"
        : internalRequests.some((requests) => requests.some((request) => !request.sideEffectOnly))
          ? "cyclic ESM runtime bindings may observe TDZ state and are outside the side-effect-import ring fragment"
          : "cyclic ESM graph is outside the supported synchronous side-effect-import simple ring fragment";
      for (const fileName of rawComponent) addUnknown({ fileName, kind: "cycle", detail });
      continue;
    }
    const executionOrder = ordered.filter((fileName) => members.has(fileName));
    const requests: ModuleInitializationCycleRequest[] = [];
    for (const [index, fileName] of modules.entries()) {
      const request = internalRequests[index]![0]!;
      requests.push({
        from: fileName, to: request.dependency, sourceSpan: request.span,
        semanticRule: request.dependency === root
          ? "ecma262-inner-module-evaluation-revisit"
          : "ecma262-inner-module-evaluation-request",
        evidence: sourceEvidence(fileName),
      });
      admittedCycleFiles.add(fileName);
    }
    cycleComponents.push({
      id: `cycle:${root}`, kind: "synchronous-side-effect-import-ring", root,
      modules, executionOrder, requests,
    });
  }
  for (const fileName of cycleFiles) if (!admittedCycleFiles.has(fileName)
    && !unknowns.some((unknown) => unknown.fileName === fileName && unknown.kind === "cycle")) {
    addUnknown({ fileName, kind: "cycle", detail: "cyclic ESM graph is outside the supported synchronous side-effect-import simple ring fragment" });
  }

  const modules: ModuleInitializationModule[] = ordered.map((fileName) => {
    const record = records.get(fileName)!, source = record.source;
    const events: ModuleInitializationEvent[] = [{ id: `${fileName}#start`, kind: "start", span: { start: 0, end: 0 } }];
    const choices: ModuleInitializationChoice[] = [];
    let predecessor = events[0]!.id;
    const throwStart = record.directThrow?.start ?? Number.POSITIVE_INFINITY;
    for (const [index, awaitNode] of record.awaits.entries()) {
      if (awaitNode.start > throwStart) break;
      const span = { start: awaitNode.start, end: awaitNode.end };
      const suspend = `${fileName}#suspend:${index}`, resume = `${fileName}#resume:${index}`, reject = `${fileName}#reject:${index}`;
      events.push({ id: suspend, kind: "suspend", span }, { id: resume, kind: "resume", span }, { id: reject, kind: "reject", span });
      constraints.push({
        before: predecessor, after: suspend, reason: "module-sequencing",
        sourceFile: fileName, sourceSpan: span, semanticRule: "source-order", evidence: sourceEvidence(fileName),
      });
      choices.push({ after: suspend, alternatives: [resume, reject], reason: "await-settlement" });
      predecessor = resume;
    }
    if (record.handledPromiseLaunch && record.handledPromiseLaunch.launchSpan.start < throwStart) {
      const launch = `${fileName}#promise-launch:0`;
      const attach = `${fileName}#rejection-handler-attach:0`;
      events.push(
        { id: launch, kind: "promise-launch", span: record.handledPromiseLaunch.launchSpan },
        { id: attach, kind: "rejection-handler-attach", span: record.handledPromiseLaunch.handlerSpan },
      );
      constraints.push({
        before: predecessor, after: launch, reason: "module-sequencing",
        sourceFile: fileName, sourceSpan: record.handledPromiseLaunch.launchSpan,
        semanticRule: "source-order", evidence: sourceEvidence(fileName),
      }, {
        before: launch, after: attach, reason: "module-sequencing",
        sourceFile: fileName, sourceSpan: record.handledPromiseLaunch.handlerSpan,
        semanticRule: "source-order", evidence: sourceEvidence(fileName),
      });
      predecessor = attach;
    }
    if (record.directThrow) {
      const id = `${fileName}#throw`;
      events.push({ id, kind: "throw", span: { start: record.directThrow.start, end: record.directThrow.end } });
      constraints.push({
        before: predecessor, after: id, reason: "module-sequencing", sourceFile: fileName,
        sourceSpan: { start: record.directThrow.start, end: record.directThrow.end },
        semanticRule: "source-order", evidence: sourceEvidence(fileName),
      });
    } else {
      const id = `${fileName}#complete`;
      events.push({ id, kind: "complete", span: { start: source.text.length, end: source.text.length } });
      constraints.push({
        before: predecessor, after: id, reason: "module-sequencing", sourceFile: fileName,
        sourceSpan: { start: source.text.length, end: source.text.length }, semanticRule: "source-order", evidence: sourceEvidence(fileName),
      });
    }
    return { fileName, dependencies: [...record.dependencies], blockedBy: [], events, choices };
  });
  const moduleByFile = new Map(modules.map((item) => [item.fileName, item]));
  for (const module of modules) for (const dependency of module.dependencies) {
    if (admittedCycleFiles.has(module.fileName) && admittedCycleFiles.has(dependency)) continue;
    if (cycleFiles.has(module.fileName) || cycleFiles.has(dependency)) continue;
    const dependencyModule = moduleByFile.get(dependency);
    const request = records.get(module.fileName)?.dependencyRequests.find((item) => item.dependency === dependency);
    if (dependencyModule?.events.some((event) => event.kind === "complete")) constraints.push({
      before: `${dependency}#complete`, after: `${module.fileName}#start`, reason: "static-dependency-completes",
      sourceFile: module.fileName, sourceSpan: request?.span ?? { start: 0, end: 0 },
      semanticRule: "ecma262-inner-module-evaluation-request", evidence: sourceEvidence(module.fileName),
    });
    else module.blockedBy.push(dependency);
  }
  for (const component of cycleComponents) for (let index = 1; index < component.executionOrder.length; index++) {
    const beforeModule = component.executionOrder[index - 1]!;
    const afterModule = component.executionOrder[index]!;
    const request = records.get(afterModule)?.dependencyRequests.find((item) => item.dependency === beforeModule);
    constraints.push({
      before: `${beforeModule}#complete`, after: `${afterModule}#start`, reason: "synchronous-cycle-dfs-execution",
      sourceFile: afterModule, sourceSpan: request?.span ?? { start: 0, end: 0 },
      semanticRule: "ecma262-inner-module-evaluation-execute", evidence: sourceEvidence(afterModule),
    });
  }
  return {
    schema: "uneffect-module-order/v1",
    schemaVersion: 1, entryFile,
    compiler: frontend.compiler,
    evidence: unknowns.length === 0 ? "verified" : "unknown",
    modules, constraints, cycleComponents, unknowns,
    claims: [
      "represented module events follow source order on the normal-completion path",
      "an importer body starts only after every normally completed static dependency",
      "top-level await may resume or reject",
      "an unconditional top-level throw prevents normal completion",
      "a synchronous side-effect-import simple ring executes in specification DFS postorder",
      "a supported top-level Promise rejection handler is attached synchronously before module completion",
    ],
    exclusions: [
      "host scheduling time is not modeled",
      "only synchronous side-effect-import simple rings have proof-grade cyclic order",
      "dynamic and external module bodies are not modeled",
      "Promise execution after a top-level launch is not modeled",
    ],
  };
}
