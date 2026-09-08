import { buildModuleInitializationOrder, type ModuleSourceFacts } from "./module-order-core.js";
import ts from "../support/typescript-compiler.js";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import { classifyLexicalExecution } from "../frontends/typescript/lexical-execution.js";
import type { ModuleInitializationUnknown, ModuleInitializationOrder } from "./contracts.js";

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

export type {
  ModuleInitializationEventKind,
  ModuleInitializationUnknownKind,
  ModuleInitializationEvent,
  ModuleInitializationSourceEvidence,
  ModuleInitializationConstraint,
  ModuleInitializationChoice,
  ModuleInitializationModule,
  ModuleInitializationCycleRequest,
  ModuleInitializationCycleComponent,
  ModuleInitializationUnknown,
  ModuleInitializationOrder,
} from "./contracts.js";

interface ModuleRecord {
  unknowns: ModuleInitializationUnknown[];
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
  if (typeof entryFile !== "string" || entryFile.trim().length === 0) throw new TypeError("entryFile must be a nonempty string");
  const records = new Map<string, ModuleRecord>();
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
    const unknowns: ModuleInitializationUnknown[] = [];
    const addUnknown = (item: ModuleInitializationUnknown): void => { unknowns.push(item); };
    const record: ModuleRecord = { source, dependencies: [], dependencyRequests: [], awaits: [], unknowns };
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
  const diagnostics: ModuleInitializationUnknown[] = [
    ...program.getConfigFileParsingDiagnostics(), ...program.getOptionsDiagnostics(), ...program.getGlobalDiagnostics(),
    ...program.getSyntacticDiagnostics(), ...program.getSemanticDiagnostics(),
  ].filter(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error).map(diagnostic => {
    const start = diagnostic.start ?? 0;
    return { fileName: diagnostic.file?.fileName ?? entryFile, kind: "typescript-error",
      ...(diagnostic.file ? { span: { start, end: start + (diagnostic.length ?? 0) } } : {}),
      detail: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n") };
  });
  const facts = new Map<string, ModuleSourceFacts>();
  return buildModuleInitializationOrder({
    compiler: { typescriptVersion: ts.version, compilerOptionsDigest: digest(JSON.stringify(Object.fromEntries(
      Object.entries(program.getCompilerOptions()).sort(([left], [right]) => left.localeCompare(right)),
    ))) }, diagnostics,
    getModule(fileName) {
      const existing = facts.get(fileName);
      if (existing) return existing;
      const source = program.getSourceFile(fileName);
      if (!source || source.isDeclarationFile) return undefined;
      const record = inspect(source);
      const span = (node: ts.Node) => ({ start: node.getStart(source), end: node.getEnd() });
      const value: ModuleSourceFacts = { ...record, source: { fileName: source.fileName, text: source.text },
        awaits: record.awaits.map(span), directThrow: record.directThrow && span(record.directThrow) };
      facts.set(fileName, value);
      return value;
    },
  }, entryFile);
}
