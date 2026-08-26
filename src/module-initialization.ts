import ts from "typescript";
import { dirname } from "node:path";

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

export type ModuleInitializationEventKind = "start" | "suspend" | "resume" | "reject" | "throw" | "complete";
export type ModuleInitializationUnknownKind =
  | "entry-not-found"
  | "cycle"
  | "external-static-import"
  | "dynamic-import"
  | "conditional-top-level-await"
  | "conditional-top-level-throw"
  | "class-initialization-order"
  | "typescript-error";

export interface ModuleInitializationEvent {
  id: string;
  kind: ModuleInitializationEventKind;
  span: { start: number; end: number };
}

export interface ModuleInitializationConstraint {
  before: string;
  after: string;
  reason: "module-sequencing" | "static-dependency-completes";
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
  /** The extracted partial-order claim is proof-grade only when no unsupported boundary was encountered. */
  evidence: "verified" | "unknown";
  modules: ModuleInitializationModule[];
  constraints: ModuleInitializationConstraint[];
  unknowns: ModuleInitializationUnknown[];
  claims: readonly [
    "represented module events follow source order on the normal-completion path",
    "an importer body starts only after every normally completed static dependency",
    "top-level await may resume or reject",
    "an unconditional top-level throw prevents normal completion",
  ];
  exclusions: readonly [
    "host scheduling time is not modeled",
    "cyclic evaluation order is not proof-grade",
    "dynamic and external module bodies are not modeled",
  ];
}

interface ModuleRecord {
  source: ts.SourceFile;
  dependencies: string[];
  awaits: ts.AwaitExpression[];
  directThrow?: ts.ThrowStatement;
}

function collectTopLevelNodes(source: ts.SourceFile): Array<{ node: ts.Node; statement: ts.Statement }> {
  const nodes: Array<{ node: ts.Node; statement: ts.Statement }> = [];
  const walk = (node: ts.Node, statement: ts.Statement): void => {
    if (node !== statement && (ts.isFunctionLike(node) || ts.isClassDeclaration(node) || ts.isClassExpression(node))) return;
    nodes.push({ node, statement });
    ts.forEachChild(node, (child) => walk(child, statement));
  };
  for (const statement of source.statements) walk(statement, statement);
  return nodes;
}

function conditionalAwait(node: ts.AwaitExpression, statement: ts.Statement): boolean {
  for (let current: ts.Node | undefined = node.parent; current && current !== statement; current = current.parent) {
    if (ts.isIfStatement(current) || ts.isConditionalExpression(current) || ts.isSwitchStatement(current)
      || ts.isForStatement(current) || ts.isForInStatement(current) || ts.isForOfStatement(current)
      || ts.isWhileStatement(current) || ts.isDoStatement(current) || ts.isTryStatement(current)
      || ts.isCatchClause(current)) return true;
    if (ts.isBinaryExpression(current)
      && (current.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
        || current.operatorToken.kind === ts.SyntaxKind.BarBarToken
        || current.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)) return true;
  }
  return ts.isIfStatement(statement) || ts.isSwitchStatement(statement) || ts.isForStatement(statement)
    || ts.isForInStatement(statement) || ts.isForOfStatement(statement) || ts.isWhileStatement(statement)
    || ts.isDoStatement(statement) || ts.isTryStatement(statement);
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
  const inspect = (source: ts.SourceFile): ModuleRecord => {
    const existing = records.get(source.fileName);
    if (existing) return existing;
    const record: ModuleRecord = { source, dependencies: [], awaits: [] };
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
        } else {
          addUnknown({
            fileName: source.fileName, kind: "external-static-import",
            span: { start: statement.moduleSpecifier.getStart(source), end: statement.moduleSpecifier.getEnd() },
            detail: `module body is outside the Program: ${statement.moduleSpecifier.text}`,
          });
        }
      }
      if (ts.isThrowStatement(statement) && !record.directThrow) record.directThrow = statement;
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
    return record;
  };
  const stack: string[] = [];
  const visit = (source: ts.SourceFile): void => {
    if (visiting.has(source.fileName)) {
      const start = stack.indexOf(source.fileName);
      for (const fileName of stack.slice(start)) cycleFiles.add(fileName);
      cycleFiles.add(source.fileName);
      return;
    }
    if (visited.has(source.fileName)) return;
    visiting.add(source.fileName);
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
  for (const fileName of cycleFiles) addUnknown({ fileName, kind: "cycle", detail: "cyclic ESM evaluation order is not proof-grade" });

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
      constraints.push({ before: predecessor, after: suspend, reason: "module-sequencing" });
      choices.push({ after: suspend, alternatives: [resume, reject], reason: "await-settlement" });
      predecessor = resume;
    }
    if (record.directThrow) {
      const id = `${fileName}#throw`;
      events.push({ id, kind: "throw", span: { start: record.directThrow.getStart(source), end: record.directThrow.getEnd() } });
      constraints.push({ before: predecessor, after: id, reason: "module-sequencing" });
    } else {
      const id = `${fileName}#complete`;
      events.push({ id, kind: "complete", span: { start: source.getEnd(), end: source.getEnd() } });
      constraints.push({ before: predecessor, after: id, reason: "module-sequencing" });
    }
    return { fileName, dependencies: [...record.dependencies], blockedBy: [], events, choices };
  });
  const moduleByFile = new Map(modules.map((item) => [item.fileName, item]));
  for (const module of modules) for (const dependency of module.dependencies) {
    if (cycleFiles.has(module.fileName) || cycleFiles.has(dependency)) continue;
    const dependencyModule = moduleByFile.get(dependency);
    if (dependencyModule?.events.some((event) => event.kind === "complete")) constraints.push({
      before: `${dependency}#complete`, after: `${module.fileName}#start`, reason: "static-dependency-completes",
    });
    else module.blockedBy.push(dependency);
  }
  return {
    schema: "uneffect-module-order/v1",
    schemaVersion: 1, entryFile, evidence: unknowns.length === 0 ? "verified" : "unknown", modules, constraints, unknowns,
    claims: [
      "represented module events follow source order on the normal-completion path",
      "an importer body starts only after every normally completed static dependency",
      "top-level await may resume or reject",
      "an unconditional top-level throw prevents normal completion",
    ],
    exclusions: [
      "host scheduling time is not modeled",
      "cyclic evaluation order is not proof-grade",
      "dynamic and external module bodies are not modeled",
    ],
  };
}
