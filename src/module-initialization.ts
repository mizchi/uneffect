import ts from "@typescript/typescript6";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import { classifyLexicalExecution } from "./lexical-execution.js";

/** Whether an import/export declaration can execute module initialization. */
export function isRuntimeModuleDependency(
  statement: ts.ImportDeclaration | ts.ExportDeclaration,
): boolean {
  if (ts.isImportDeclaration(statement)) {
    const clause = statement.importClause;
    if (!clause) return true;
    if (clause.isTypeOnly) return false;
    return !!clause.name || !clause.namedBindings || ts.isNamespaceImport(clause.namedBindings)
      || clause.namedBindings.elements.some((element) => !element.isTypeOnly);
  }
  if (statement.isTypeOnly) return false;
  return !statement.exportClause || !ts.isNamedExports(statement.exportClause)
    || statement.exportClause.elements.some((element) => !element.isTypeOnly);
}

export type ModuleInitializationEventKind =
  | "start"
  | "promise-launch"
  | "rejection-handler-attach"
  | "suspend"
  | "resume"
  | "reject"
  | "throw"
  | "complete";
export type ModuleInitializationUnknownKind =
  | "entry-not-found"
  | "cycle"
  | "external-static-import"
  | "dynamic-import"
  | "unhandled-top-level-promise-launch"
  | "unsupported-top-level-promise-handler"
  | "unsupported-mixed-top-level-async-shape"
  | "conditional-top-level-await"
  | "conditional-top-level-throw"
  | "class-initialization-order"
  | "typescript-error";

export interface ModuleInitializationEvent {
  id: string;
  kind: ModuleInitializationEventKind;
  span: { start: number; end: number };
}

export interface ModuleInitializationSourceEvidence {
  kind: "program-source";
  sourceDigest: string;
}

export interface ModuleInitializationConstraint {
  before: string;
  after: string;
  reason: "module-sequencing" | "static-dependency-completes" | "synchronous-cycle-dfs-execution";
  sourceFile: string;
  sourceSpan: { start: number; end: number };
  semanticRule: "source-order" | "ecma262-inner-module-evaluation-request" | "ecma262-inner-module-evaluation-execute";
  evidence: ModuleInitializationSourceEvidence;
}

export interface ModuleInitializationChoice {
  after: string;
  alternatives: [string, string];
  reason: "await-settlement";
}

export interface ModuleInitializationModule {
  fileName: string;
  dependencies: string[];
  /** Dependencies with no normal-completion event; this module body is unreachable on that modeled path. */
  blockedBy: string[];
  events: ModuleInitializationEvent[];
  choices: ModuleInitializationChoice[];
}

export interface ModuleInitializationCycleRequest {
  from: string;
  to: string;
  sourceSpan: { start: number; end: number };
  semanticRule: "ecma262-inner-module-evaluation-request" | "ecma262-inner-module-evaluation-revisit";
  evidence: ModuleInitializationSourceEvidence;
}

export interface ModuleInitializationCycleComponent {
  id: string;
  kind: "synchronous-side-effect-import-ring";
  root: string;
  modules: string[];
  executionOrder: string[];
  requests: ModuleInitializationCycleRequest[];
}

export interface ModuleInitializationUnknown {
  fileName: string;
  kind: ModuleInitializationUnknownKind;
  span?: { start: number; end: number };
  detail: string;
}

export interface ModuleInitializationOrder {
  schema: "uneffect-module-order/v1";
  schemaVersion: 1;
  entryFile: string;
  compiler: { typescriptVersion: string; compilerOptionsDigest: string };
  /** The extracted partial-order claim is proof-grade only when no unsupported boundary was encountered. */
  evidence: "verified" | "unknown";
  modules: ModuleInitializationModule[];
  constraints: ModuleInitializationConstraint[];
  cycleComponents: ModuleInitializationCycleComponent[];
  unknowns: ModuleInitializationUnknown[];
  claims: readonly [
    "represented module events follow source order on the normal-completion path",
    "an importer body starts only after every normally completed static dependency",
    "top-level await may resume or reject",
    "an unconditional top-level throw prevents normal completion",
    "a synchronous side-effect-import simple ring executes in specification DFS postorder",
    "a supported top-level Promise rejection handler is attached synchronously before module completion",
  ];
  exclusions: readonly [
    "host scheduling time is not modeled",
    "only synchronous side-effect-import simple rings have proof-grade cyclic order",
    "dynamic and external module bodies are not modeled",
    "Promise execution after a top-level launch is not modeled",
  ];
}

interface ModuleRecord {
  source: ts.SourceFile;
  dependencies: string[];
  dependencyRequests: Array<{
    dependency: string;
    span: { start: number; end: number };
    sideEffectOnly: boolean;
  }>;
  awaits: ts.AwaitExpression[];
  handledPromiseLaunch?: {
    launchSpan: { start: number; end: number };
    handlerSpan: { start: number; end: number };
  };
  directThrow?: ts.ThrowStatement;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function collectTopLevelNodes(source: ts.SourceFile): Array<{ node: ts.Node; statement: ts.Statement }> {
  const nodes: Array<{ node: ts.Node; statement: ts.Statement }> = [];
  const walk = (node: ts.Node, statement: ts.Statement): void => {
    if (ts.isFunctionLike(node) || ts.isClassDeclaration(node) || ts.isClassExpression(node)) return;
    nodes.push({ node, statement });
    ts.forEachChild(node, (child) => walk(child, statement));
  };
  for (const statement of source.statements) walk(statement, statement);
  return nodes;
}

function conditionalAwait(node: ts.AwaitExpression, statement: ts.Statement): boolean {
  void statement;
  return classifyLexicalExecution(node, node.getSourceFile()) !== "exactly-once";
}

/**
 * Extract a source-mapped, conservative ESM initialization partial order.
 * This is an ordering artifact, not an effect summary and not a liveness proof.
 */
export function analyzeModuleInitializationOrder(program: ts.Program, entryFile: string): ModuleInitializationOrder {
  const constraints: ModuleInitializationConstraint[] = [], unknowns: ModuleInitializationUnknown[] = [];
  const records = new Map<string, ModuleRecord>(), visiting = new Set<string>(), visited = new Set<string>(), cycleFiles = new Set<string>();
  const ordered: string[] = [];
  const sourceDirectories = new Set(program.getSourceFiles().flatMap((source) => {
    const directories: string[] = [];
    for (let current = dirname(source.fileName); current !== dirname(current); current = dirname(current)) directories.push(current);
    return directories;
  }));
  const moduleHost: ts.ModuleResolutionHost = {
    fileExists: (fileName) => program.getSourceFile(fileName) !== undefined || ts.sys.fileExists(fileName),
    readFile: (fileName) => program.getSourceFile(fileName)?.text ?? ts.sys.readFile(fileName),
    directoryExists: (directory) => sourceDirectories.has(directory) || ts.sys.directoryExists(directory),
    getCurrentDirectory: ts.sys.getCurrentDirectory,
    realpath: ts.sys.realpath,
  };
  const entry = program.getSourceFile(entryFile);
  const addUnknown = (item: ModuleInitializationUnknown): void => {
    if (!unknowns.some((existing) => existing.fileName === item.fileName && existing.kind === item.kind
      && existing.span?.start === item.span?.start)) unknowns.push(item);
  };
  const sourceEvidence = (fileName: string): ModuleInitializationSourceEvidence => ({
    kind: "program-source",
    sourceDigest: digest(program.getSourceFile(fileName)?.text ?? ""),
  });
  const checker = program.getTypeChecker();
  const sourceLocalTopLevelAsyncFunction = (
    call: ts.CallExpression,
    source: ts.SourceFile,
  ): ts.FunctionDeclaration | undefined => {
    if (call.arguments.length !== 0 || !ts.isIdentifier(call.expression)) return undefined;
    const symbol = checker.getSymbolAtLocation(call.expression);
    const declaration = symbol?.valueDeclaration;
    if (!declaration || !ts.isFunctionDeclaration(declaration)
      || declaration.getSourceFile() !== source || declaration.parent !== source
      || !declaration.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)) return undefined;
    return declaration;
  };
  const isStandardPromiseCatch = (access: ts.PropertyAccessExpression): boolean => {
    const symbol = checker.getSymbolAtLocation(access.name);
    return symbol?.declarations?.some((declaration) => {
      const owner = declaration.parent;
      return declaration.getSourceFile().isDeclarationFile
        && /^lib\..*\.d\.ts$/u.test(declaration.getSourceFile().fileName.split(/[\\/]/u).at(-1) ?? "")
        && ts.isInterfaceDeclaration(owner)
        && owner.name.text === "Promise";
    }) === true;
  };
  const inspect = (source: ts.SourceFile): ModuleRecord => {
    const existing = records.get(source.fileName);
    if (existing) return existing;
    const record: ModuleRecord = { source, dependencies: [], dependencyRequests: [], awaits: [] };
    records.set(source.fileName, record);
    for (const statement of source.statements) {
      if ((ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement))
        && statement.moduleSpecifier && ts.isStringLiteralLike(statement.moduleSpecifier)
        && isRuntimeModuleDependency(statement)) {
        const resolved = ts.resolveModuleName(statement.moduleSpecifier.text, source.fileName, program.getCompilerOptions(), moduleHost)
          .resolvedModule?.resolvedFileName;
        const dependency = resolved ? program.getSourceFile(resolved) : undefined;
        if (dependency && !dependency.isDeclarationFile) {
          if (!record.dependencies.includes(dependency.fileName)) record.dependencies.push(dependency.fileName);
          record.dependencyRequests.push({
            dependency: dependency.fileName,
            span: { start: statement.moduleSpecifier.getStart(source), end: statement.moduleSpecifier.getEnd() },
            sideEffectOnly: ts.isImportDeclaration(statement) && statement.importClause === undefined,
          });
        } else {
          addUnknown({
            fileName: source.fileName, kind: "external-static-import",
            span: { start: statement.moduleSpecifier.getStart(source), end: statement.moduleSpecifier.getEnd() },
            detail: `module body is outside the Program: ${statement.moduleSpecifier.text}`,
          });
        }
      }
      if (ts.isThrowStatement(statement) && !record.directThrow) record.directThrow = statement;
      if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) continue;
      const expression = statement.expression;
      if (ts.isPropertyAccessExpression(expression.expression) && expression.expression.name.text === "catch") {
        const access = expression.expression;
        const launch = access.expression;
        const handler = expression.arguments[0];
        const supported = ts.isCallExpression(launch)
          && sourceLocalTopLevelAsyncFunction(launch, source) !== undefined
          && expression.arguments.length === 1
          && handler !== undefined
          && (ts.isArrowFunction(handler) || ts.isFunctionExpression(handler))
          && isStandardPromiseCatch(access);
        if (!supported) {
          addUnknown({
            fileName: source.fileName,
            kind: "unsupported-top-level-promise-handler",
            span: { start: expression.getStart(source), end: expression.getEnd() },
            detail: "top-level catch is outside the source-local async main().catch(handler) fragment",
          });
        } else if (record.handledPromiseLaunch) {
          addUnknown({
            fileName: source.fileName,
            kind: "unsupported-top-level-promise-handler",
            span: { start: expression.getStart(source), end: expression.getEnd() },
            detail: "multiple top-level Promise launches are outside the supported fragment",
          });
          record.handledPromiseLaunch = undefined;
        } else {
          record.handledPromiseLaunch = {
            launchSpan: { start: launch.getStart(source), end: launch.getEnd() },
            handlerSpan: { start: access.name.getStart(source), end: expression.getEnd() },
          };
        }
      } else if (sourceLocalTopLevelAsyncFunction(expression, source)) {
        addUnknown({
          fileName: source.fileName,
          kind: "unhandled-top-level-promise-launch",
          span: { start: expression.getStart(source), end: expression.getEnd() },
          detail: "a top-level source-local async function launch has no supported rejection handler",
        });
      }
    }
    for (const { node, statement } of collectTopLevelNodes(source)) {
      if (ts.isAwaitExpression(node)) {
        record.awaits.push(node);
        if (conditionalAwait(node, statement)) addUnknown({
          fileName: source.fileName, kind: "conditional-top-level-await",
          span: { start: node.getStart(source), end: node.getEnd() },
          detail: "control-dependent await settlement order is not yet represented",
        });
      }
      if (ts.isThrowStatement(node) && node !== statement) addUnknown({
        fileName: source.fileName, kind: "conditional-top-level-throw",
        span: { start: node.getStart(source), end: node.getEnd() },
        detail: "control-dependent synchronous termination is not yet represented",
      });
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) addUnknown({
        fileName: source.fileName, kind: "dynamic-import",
        span: { start: node.getStart(source), end: node.getEnd() },
        detail: "dynamic import evaluation is conditional and not part of the static dependency order",
      });
    }
    for (const statement of source.statements) if (ts.isClassDeclaration(statement)) {
      const hasDecorators = ts.canHaveDecorators(statement) && (ts.getDecorators(statement)?.length ?? 0) > 0;
      const hasInitialization = hasDecorators || statement.heritageClauses !== undefined || statement.members.some((member) =>
        ts.isClassStaticBlockDeclaration(member)
        || (ts.isPropertyDeclaration(member) && member.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword))
        || (ts.canHaveDecorators(member) && (ts.getDecorators(member)?.length ?? 0) > 0)
        || (member.name !== undefined && ts.isComputedPropertyName(member.name)));
      if (hasInitialization) addUnknown({
        fileName: source.fileName, kind: "class-initialization-order",
        span: { start: statement.getStart(source), end: statement.getEnd() },
        detail: "class heritage, decorator, computed-name, or static initialization order is not yet represented",
      });
    }
    record.awaits.sort((left, right) => left.getStart(source) - right.getStart(source));
    if (record.handledPromiseLaunch && record.awaits.length > 0) addUnknown({
      fileName: source.fileName,
      kind: "unsupported-mixed-top-level-async-shape",
      span: record.handledPromiseLaunch.launchSpan,
      detail: "top-level await mixed with a top-level Promise launch is outside the supported fragment",
    });
    return record;
  };
  const stack: string[] = [];
  const discoveryOrder = new Map<string, number>();
  const visit = (source: ts.SourceFile): void => {
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
      const dependency = program.getSourceFile(dependencyName);
      if (dependency) visit(dependency);
    }
    stack.pop();
    visiting.delete(source.fileName);
    visited.add(source.fileName);
    ordered.push(source.fileName);
  };
  if (!entry || entry.isDeclarationFile) addUnknown({ fileName: entryFile, kind: "entry-not-found", detail: "entry source is absent from the Program" });
  else visit(entry);
  const reachable = new Set(ordered);
  for (const diagnostic of [...program.getSyntacticDiagnostics(), ...program.getSemanticDiagnostics()]) {
    if (diagnostic.category !== ts.DiagnosticCategory.Error || !diagnostic.file || !reachable.has(diagnostic.file.fileName)) continue;
    const start = diagnostic.start ?? 0;
    addUnknown({
      fileName: diagnostic.file.fileName, kind: "typescript-error",
      span: { start, end: start + (diagnostic.length ?? 0) },
      detail: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
    });
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
  if (entry && !entry.isDeclarationFile) connect(entry.fileName);
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
    const throwStart = record.directThrow?.getStart(source) ?? Number.POSITIVE_INFINITY;
    for (const [index, awaitNode] of record.awaits.entries()) {
      if (awaitNode.getStart(source) > throwStart) break;
      const span = { start: awaitNode.getStart(source), end: awaitNode.getEnd() };
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
      events.push({ id, kind: "throw", span: { start: record.directThrow.getStart(source), end: record.directThrow.getEnd() } });
      constraints.push({
        before: predecessor, after: id, reason: "module-sequencing", sourceFile: fileName,
        sourceSpan: { start: record.directThrow.getStart(source), end: record.directThrow.getEnd() },
        semanticRule: "source-order", evidence: sourceEvidence(fileName),
      });
    } else {
      const id = `${fileName}#complete`;
      events.push({ id, kind: "complete", span: { start: source.getEnd(), end: source.getEnd() } });
      constraints.push({
        before: predecessor, after: id, reason: "module-sequencing", sourceFile: fileName,
        sourceSpan: { start: source.getEnd(), end: source.getEnd() }, semanticRule: "source-order", evidence: sourceEvidence(fileName),
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
    compiler: {
      typescriptVersion: ts.version,
      compilerOptionsDigest: digest(JSON.stringify(Object.fromEntries(
        Object.entries(program.getCompilerOptions()).sort(([left], [right]) => left.localeCompare(right)),
      ))),
    },
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
