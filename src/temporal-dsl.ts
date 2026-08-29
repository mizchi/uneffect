import ts from "typescript";
import { posix } from "node:path";
import { extractAnnotations } from "./annotations.js";
import { parseSpec, type TemporalSpec } from "./spec-ir.js";

declare const temporalDescriptor: unique symbol;
export interface TemporalType<Value> { readonly [temporalDescriptor]: Value; readonly kind: "int" | "bool" | "string" }
export const int = (): TemporalType<number> => ({ kind: "int" }) as TemporalType<number>;
export const bool = (): TemporalType<boolean> => ({ kind: "bool" }) as TemporalType<boolean>;
export const text = (): TemporalType<string> => ({ kind: "string" }) as TemporalType<string>;

type StateShape = Readonly<Record<string, TemporalType<unknown>>>;
type StateOf<Shape extends StateShape> = { -readonly [Key in keyof Shape]: Shape[Key] extends TemporalType<infer Value> ? Value : never };
type Predicate<State> = (state: Readonly<State>) => boolean;
type Update<State> = (state: Readonly<State>) => Partial<State>;
export interface TemporalDefinition<Shape extends StateShape, Actions extends Readonly<Record<string, Update<StateOf<Shape>>>>> {
  readonly state: Shape;
  readonly init: StateOf<Shape>;
  readonly actions: Actions;
  readonly guards?: Partial<{ readonly [Name in keyof Actions]: Predicate<StateOf<Shape>> }>;
  readonly fairness?: Partial<{ readonly [Name in keyof Actions]: "weak" | "strong" }>;
  readonly invariants?: Readonly<Record<string, Predicate<StateOf<Shape>>>>;
  readonly eventually?: Readonly<Record<string, Predicate<StateOf<Shape>>>>;
  readonly repeatedly?: Readonly<Record<string, Predicate<StateOf<Shape>>>>;
  readonly stabilizes?: Readonly<Record<string, Predicate<StateOf<Shape>>>>;
  readonly responses?: Readonly<Record<string, { readonly trigger: Predicate<StateOf<Shape>>; readonly response: Predicate<StateOf<Shape>> }>>;
}

/** Type-level authoring helper. Uneffect reads its AST and never executes the module. */
export const defineTemporal = <const Shape extends StateShape, const Actions extends Readonly<Record<string, Update<StateOf<Shape>>>>>(definition: TemporalDefinition<Shape, Actions>): TemporalDefinition<Shape, Actions> => definition;

export interface TemporalDslLink {
  implementationFile: string;
  specificationFile: string;
  exportName: "default";
  spec: TemporalSpec;
}

export function resolveTemporalDslLink(
  implementationFile: string,
  implementationSource: string,
  files: Readonly<Record<string, string>>,
): TemporalDslLink | undefined {
  const declarations = extractAnnotations(implementationSource, "temporal_from");
  if (declarations.length === 0) return undefined;
  if (declarations.length !== 1) throw new Error(`${implementationFile}: expected exactly one uneffect:temporal from declaration`);
  const match = /^(?:"([^"]+)"|'([^']+)')$/.exec(declarations[0]!);
  if (!match) throw new Error(`${implementationFile}: temporal from requires a quoted relative .uneffect.ts path with #default`);
  const reference = match[1] ?? match[2]!;
  const hash = reference.lastIndexOf("#");
  if (hash < 0) throw new Error(`${implementationFile}: temporal from reference requires #default`);
  const requestedFile = reference.slice(0, hash), exportName = reference.slice(hash + 1);
  if (exportName !== "default") throw new Error(`${implementationFile}: temporal from currently supports only #default`);
  if (!requestedFile.startsWith("./") && !requestedFile.startsWith("../")) throw new Error(`${implementationFile}: temporal from path must be relative`);
  if (!requestedFile.endsWith(".uneffect.ts")) throw new Error(`${implementationFile}: temporal from path must end in .uneffect.ts`);
  const specificationFile = posix.normalize(posix.join(posix.dirname(implementationFile), requestedFile));
  const specificationSource = files[specificationFile];
  if (specificationSource === undefined) throw new Error(`${implementationFile}: temporal specification ${specificationFile} does not exist in the selected project`);
  return { implementationFile, specificationFile, exportName: "default", spec: parseTemporalDsl(specificationFile, specificationSource) };
}

function propertyName(source: ts.SourceFile, node: ts.PropertyName | undefined, kind: string): string {
  if (node && (ts.isIdentifier(node) || ts.isStringLiteral(node))) return node.text;
  throw new Error(`${source.fileName}: ${kind} requires a static identifier or string key`);
}

function objectLiteral(source: ts.SourceFile, node: ts.Expression | undefined, kind: string): ts.ObjectLiteralExpression {
  while (node && ts.isParenthesizedExpression(node)) node = node.expression;
  if (node && ts.isObjectLiteralExpression(node)) return node;
  throw new Error(`${source.fileName}: ${kind} must be an object literal`);
}

function properties(source: ts.SourceFile, node: ts.ObjectLiteralExpression, kind: string): Array<[string, ts.Expression]> {
  return node.properties.map((item) => {
    if (!ts.isPropertyAssignment(item)) throw new Error(`${source.fileName}: ${kind} only supports static property assignments`);
    return [propertyName(source, item.name, kind), item.initializer];
  });
}

function callbackBody(source: ts.SourceFile, node: ts.Expression, kind: string): ts.Expression {
  if ((!ts.isArrowFunction(node) && !ts.isFunctionExpression(node)) || node.parameters.length !== 1 || ts.isBlock(node.body)) {
    throw new Error(`${source.fileName}: ${kind} must be a single-expression function with one destructured state parameter`);
  }
  const parameter = node.parameters[0]!.name;
  if (!ts.isObjectBindingPattern(parameter)) throw new Error(`${source.fileName}: ${kind} parameter must destructure temporal state`);
  for (const element of parameter.elements) {
    if (element.dotDotDotToken || element.propertyName || !ts.isIdentifier(element.name)) throw new Error(`${source.fileName}: ${kind} only supports direct state destructuring`);
  }
  return node.body;
}

function expressionText(source: ts.SourceFile, node: ts.Expression, kind: string): string {
  return callbackBody(source, node, kind).getText(source);
}

/** Parse the deliberately restricted TypeScript AST of a `.uneffect.ts` module into the stable neutral IR. */
export function parseTemporalDsl(fileName: string, text: string): TemporalSpec {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const diagnostics = (source as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? [];
  if (diagnostics[0]) throw new Error(`${fileName}: invalid TypeScript syntax: ${ts.flattenDiagnosticMessageText(diagnostics[0].messageText, "\n")}`);
  for (const statement of source.statements) if (!ts.isImportDeclaration(statement) && !ts.isExportAssignment(statement)
    && !ts.isTypeAliasDeclaration(statement) && !ts.isInterfaceDeclaration(statement)) {
    throw new Error(`${fileName}: unsupported top-level statement; specification modules are declarative and are not executed`);
  }

  const imported = new Map<string, string>();
  for (const statement of source.statements) if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
    const clause = statement.importClause?.namedBindings;
    if (clause && ts.isNamedImports(clause)) for (const element of clause.elements) {
      const exported = element.propertyName?.text ?? element.name.text;
      if (["defineTemporal", "int", "bool", "text"].includes(exported)) {
        if (statement.moduleSpecifier.text !== "@mizchi/uneffect/spec") throw new Error(`${exported} must be imported from @mizchi/uneffect/spec`);
        imported.set(element.name.text, exported);
      }
    }
  }
  const defineNames = new Set([...imported].filter(([, exported]) => exported === "defineTemporal").map(([local]) => local));
  let root: ts.ObjectLiteralExpression | undefined;
  for (const statement of source.statements) if (ts.isExportAssignment(statement) && ts.isCallExpression(statement.expression)
    && ts.isIdentifier(statement.expression.expression) && defineNames.has(statement.expression.expression.text)) {
    if (statement.expression.arguments.length !== 1) throw new Error(`${fileName}: defineTemporal requires exactly one object literal`);
    root = objectLiteral(source, statement.expression.arguments[0], "defineTemporal argument");
  }
  if (!root) throw new Error(`${fileName}: default export must call defineTemporal imported from @mizchi/uneffect/spec`);
  const sectionEntries = properties(source, root, "temporal definition");
  const sections = new Map(sectionEntries);
  if (sections.size !== sectionEntries.length) throw new Error(`${fileName}: duplicate temporal definition section`);
  const supportedSections = new Set(["state", "init", "actions", "guards", "fairness", "invariants", "eventually", "repeatedly", "stabilizes", "responses"]);
  for (const name of sections.keys()) if (!supportedSections.has(name)) throw new Error(`${fileName}: unsupported temporal definition section ${name}`);
  for (const required of ["state", "init", "actions"]) if (!sections.has(required)) throw new Error(`${fileName}: temporal definition requires ${required}`);
  const annotationPrefix = ["uneffect", "temporal"].join(":");
  const lines: string[] = [];
  for (const [name, descriptor] of properties(source, objectLiteral(source, sections.get("state"), "state"), "state")) {
    if (!ts.isCallExpression(descriptor) || descriptor.arguments.length !== 0 || !ts.isIdentifier(descriptor.expression)) throw new Error(`${fileName}: unsupported temporal state descriptor for ${name}`);
    const kinds: Record<string, string> = { int: "int", bool: "bool", text: "string" };
    const kind = kinds[imported.get(descriptor.expression.text) ?? ""];
    if (!kind) throw new Error(`${fileName}: unsupported temporal state descriptor for ${name}`);
    lines.push(`/* ${annotationPrefix} state ${name}: ${kind} */`);
  }
  for (const [name, value] of properties(source, objectLiteral(source, sections.get("init"), "init"), "init")) lines.push(`/* ${annotationPrefix} init ${name} = ${value.getText(source)} */`);
  for (const [name, value] of properties(source, objectLiteral(source, sections.get("actions"), "actions"), "action")) {
    const result = objectLiteral(source, callbackBody(source, value, `action ${name}`), `action ${name} result`);
    const assignments = properties(source, result, `action ${name}`).map(([target, expression]) => `${target}' = ${expression.getText(source)}`);
    if (assignments.length === 0) throw new Error(`${fileName}: action ${name} must update at least one state field`);
    lines.push(`/* ${annotationPrefix} action ${name}: ${assignments.join(", ")} */`);
  }
  if (sections.has("guards")) for (const [name, guard] of properties(source, objectLiteral(source, sections.get("guards"), "guards"), "guard"))
    lines.push(`/* ${annotationPrefix} action_when ${name}: ${expressionText(source, guard, `action ${name} guard`)} */`);
  if (sections.has("fairness")) for (const [name, fairness] of properties(source, objectLiteral(source, sections.get("fairness"), "fairness"), "fairness")) {
    if (!ts.isStringLiteral(fairness) || (fairness.text !== "weak" && fairness.text !== "strong")) throw new Error(`${fileName}: fairness for ${name} must be weak or strong`);
    lines.push(`/* ${annotationPrefix} action_fair ${name}: ${fairness.text} */`);
  }
  const predicates = (["invariants", "eventually", "repeatedly", "stabilizes"] as const);
  const directives = { invariants: "invariant", eventually: "eventually", repeatedly: "repeatedly", stabilizes: "stabilizes" } as const;
  for (const section of predicates) if (sections.has(section)) for (const [name, predicate] of properties(source, objectLiteral(source, sections.get(section), section), section)) {
    lines.push(`/* ${annotationPrefix} ${directives[section]} ${name}: ${expressionText(source, predicate, `${section} ${name}`)} */`);
  }
  if (sections.has("responses")) for (const [name, response] of properties(source, objectLiteral(source, sections.get("responses"), "responses"), "response")) {
    const pair = new Map(properties(source, objectLiteral(source, response, `response ${name}`), `response ${name}`));
    if (!pair.has("trigger") || !pair.has("response") || pair.size !== 2) throw new Error(`${fileName}: response ${name} requires exactly trigger and response`);
    lines.push(`/* ${annotationPrefix} response ${name}: ${expressionText(source, pair.get("trigger")!, `response ${name} trigger`)} => ${expressionText(source, pair.get("response")!, `response ${name} target`)} */`);
  }
  return parseSpec(fileName, lines.join("\n")).temporal;
}
