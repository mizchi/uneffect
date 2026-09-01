import { posix } from "node:path";
import ts from "typescript";
import { extractAnnotations } from "./annotations.js";
import type { RefinementBindingManifest } from "./refinement-bindings.js";
import { parseRefinementRuntimeIdentity } from "./runtime-identities.js";

export type RefinementProjection =
  | { readonly kind: "identity"; readonly path: string }
  | { readonly kind: "set-from-array"; readonly path: string }
  | { readonly kind: "map-from-entries"; readonly path: string };

export type RefinementRuntimeDescriptor =
  | { readonly kind: "global"; readonly identity: "globalThis"; readonly realm: "main" }
  | { readonly kind: "node-global"; readonly identity: `node:global@${number}#${string}`; readonly major: number; readonly realm: string };

export type RefinementCallable<Runtime, Result = unknown> = (runtime: Runtime, ...arguments_: never[]) => Result;

export interface RefinementDefinition<Runtime> {
  readonly name: string;
  readonly version: string;
  readonly runtime?: RefinementRuntimeDescriptor;
  readonly create: (initial: Runtime) => Runtime;
  readonly observe: (runtime: Runtime) => unknown;
  readonly abstractions: Readonly<Record<string, RefinementProjection>>;
  readonly actions: Readonly<Record<string, RefinementCallable<Runtime>>>;
  readonly invariants: Readonly<Record<string, RefinementCallable<Runtime, boolean>>>;
}

export interface ParsedRefinementDefinition {
  name: string;
  version: string;
  runtimeIdentity?: string;
  create: string;
  observe: string;
  abstractions: Record<string, string>;
  actions: Record<string, string>;
  invariants: Record<string, string>;
}

const dottedPath = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/;
function projection(kind: RefinementProjection["kind"], path: string): RefinementProjection {
  if (!dottedPath.test(path)) throw new Error(`refinement projection requires a stable dotted property path: ${path}`);
  return { kind, path } as RefinementProjection;
}

export function identityProjection(path: string): RefinementProjection {
  return projection("identity", path);
}

export function setFromArrayProjection(path: string): RefinementProjection {
  return projection("set-from-array", path);
}

export function mapFromEntriesProjection(path: string): RefinementProjection {
  return projection("map-from-entries", path);
}

export function globalRuntime(realm: "main" = "main"): RefinementRuntimeDescriptor {
  if (realm !== "main") throw new Error("globalThis refinement runtime currently supports only the main realm");
  return { kind: "global", identity: "globalThis", realm };
}

export function nodeGlobalRuntime(major: number, realm: string): RefinementRuntimeDescriptor {
  if (!Number.isSafeInteger(major) || major <= 0) throw new Error("Node refinement runtime major must be a positive safe integer");
  if (!/^[A-Za-z_$][\w$-]*$/.test(realm)) throw new Error(`invalid Node refinement runtime realm: ${realm}`);
  return { kind: "node-global", identity: `node:global@${major}#${realm}`, major, realm };
}

export function defineRefinement<
  const Create extends (initial: any) => any,
  const Definition extends RefinementDefinition<ReturnType<Create>> & { readonly create: Create },
>(definition: Definition): Definition {
  return definition;
}

function propertyName(node: ts.PropertyName, fileName: string): string {
  if (ts.isIdentifier(node) || ts.isStringLiteral(node)) return node.text;
  throw new Error(`${fileName}: computed refinement definition properties are unsupported`);
}

function objectEntries(node: ts.Expression | undefined, fileName: string, context: string): Array<[string, ts.Expression]> {
  if (!node || !ts.isObjectLiteralExpression(node)) throw new Error(`${fileName}: ${context} must be an object literal`);
  return node.properties.map((property) => {
    if (ts.isShorthandPropertyAssignment(property)) return [property.name.text, property.name];
    if (!ts.isPropertyAssignment(property)) throw new Error(`${fileName}: ${context} does not support spreads or methods`);
    return [propertyName(property.name, fileName), property.initializer];
  });
}

function identifier(node: ts.Expression | undefined, fileName: string, context: string): string {
  if (!node || !ts.isIdentifier(node)) throw new Error(`${fileName}: ${context} must be a callable identifier`);
  return node.text;
}

function literal(node: ts.Expression | undefined, fileName: string, context: string): string {
  if (!node || !ts.isStringLiteral(node)) throw new Error(`${fileName}: ${context} must be a string literal`);
  return node.text;
}

/** Parses the deliberately small refinement DSL without importing or executing it. */
export function parseRefinementDsl(fileName: string, text: string): ParsedRefinementDefinition {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const helpers = new Map<string, string>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)
      || statement.moduleSpecifier.text !== "@mizchi/uneffect/spec") continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) throw new Error(`${fileName}: refinement DSL helpers require named imports`);
    for (const element of bindings.elements) helpers.set(element.name.text, element.propertyName?.text ?? element.name.text);
  }
  const defineNames = new Set([...helpers].filter(([, exported]) => exported === "defineRefinement").map(([local]) => local));
  const assignment = source.statements.find(ts.isExportAssignment);
  if (!assignment || !ts.isCallExpression(assignment.expression) || !ts.isIdentifier(assignment.expression.expression)
    || !defineNames.has(assignment.expression.expression.text) || assignment.expression.arguments.length !== 1) {
    throw new Error(`${fileName}: default export must call defineRefinement imported from @mizchi/uneffect/spec`);
  }
  const entries = objectEntries(assignment.expression.arguments[0], fileName, "defineRefinement argument");
  const fields = new Map(entries);
  if (fields.size !== entries.length) throw new Error(`${fileName}: duplicate refinement definition property`);
  const supported = new Set(["name", "version", "runtime", "create", "observe", "abstractions", "actions", "invariants"]);
  for (const name of fields.keys()) if (!supported.has(name)) throw new Error(`${fileName}: unsupported refinement definition property ${name}`);
  for (const name of ["name", "version", "create", "observe", "abstractions", "actions", "invariants"])
    if (!fields.has(name)) throw new Error(`${fileName}: refinement definition requires ${name}`);

  const callHelper = (node: ts.Expression | undefined, context: string): { helper: string; arguments: readonly ts.Expression[] } => {
    if (!node || !ts.isCallExpression(node) || !ts.isIdentifier(node.expression)) throw new Error(`${fileName}: ${context} must call a refinement DSL helper`);
    const helper = helpers.get(node.expression.text);
    if (!helper) throw new Error(`${fileName}: unsupported refinement DSL helper ${node.expression.text}; helpers must be imported from @mizchi/uneffect/spec`);
    return { helper, arguments: node.arguments };
  };
  const abstractions = Object.fromEntries(objectEntries(fields.get("abstractions"), fileName, "abstractions").map(([name, value]) => {
    const call = callHelper(value, `abstraction ${name}`);
    const kinds: Record<string, "identity" | "set-from-array" | "map-from-entries"> = {
      identityProjection: "identity", setFromArrayProjection: "set-from-array", mapFromEntriesProjection: "map-from-entries",
    };
    const kind = kinds[call.helper];
    if (!kind) throw new Error(`${fileName}: unsupported refinement projection helper ${call.helper}`);
    if (call.arguments.length !== 1) throw new Error(`${fileName}: abstraction ${name} requires one string literal path`);
    const path = literal(call.arguments[0], fileName, `abstraction ${name} path`);
    projection(kind, path);
    return [name, kind === "identity" ? path : `${kind === "set-from-array" ? "Set" : "Map"}(${path})`];
  }));
  const callableMap = (name: "actions" | "invariants"): Record<string, string> =>
    Object.fromEntries(objectEntries(fields.get(name), fileName, name).map(([modelName, value]) => [modelName, identifier(value, fileName, `${name}.${modelName}`)]));

  let runtimeIdentity: string | undefined;
  if (fields.has("runtime")) {
    const call = callHelper(fields.get("runtime"), "runtime");
    if (call.helper === "globalRuntime" && call.arguments.length === 0) runtimeIdentity = "globalThis";
    else if (call.helper === "nodeGlobalRuntime" && call.arguments.length === 2 && ts.isNumericLiteral(call.arguments[0]!) && ts.isStringLiteral(call.arguments[1]!)) {
      const major = Number(call.arguments[0]!.text), realm = call.arguments[1]!.text;
      runtimeIdentity = nodeGlobalRuntime(major, realm).identity;
    } else throw new Error(`${fileName}: unsupported refinement runtime descriptor`);
  }
  return {
    name: literal(fields.get("name"), fileName, "name"), version: literal(fields.get("version"), fileName, "version"),
    ...(runtimeIdentity ? { runtimeIdentity } : {}),
    create: identifier(fields.get("create"), fileName, "create"), observe: identifier(fields.get("observe"), fileName, "observe"),
    abstractions, actions: callableMap("actions"), invariants: callableMap("invariants"),
  };
}

function unalias(checker: ts.TypeChecker, symbol: ts.Symbol): ts.Symbol {
  return symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
}

/** Validates helper provenance and callable compatibility against the exact Program. */
export function validateRefinementDslIdentities(program: ts.Program, fileName: string): void {
  const source = program.getSourceFile(fileName);
  if (!source) throw new Error(`${fileName}: refinement specification is not part of the TypeScript Program`);
  const checker = program.getTypeChecker();
  const helperNames = new Set(["defineRefinement", "globalRuntime", "nodeGlobalRuntime", "identityProjection", "setFromArrayProjection", "mapFromEntriesProjection"]);
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)
      || statement.moduleSpecifier.text !== "@mizchi/uneffect/spec") continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      const exported = element.propertyName?.text ?? element.name.text;
      if (!helperNames.has(exported)) continue;
      const symbol = checker.getSymbolAtLocation(element.name), target = symbol && unalias(checker, symbol);
      const valid = target?.name === exported && target.declarations?.some((declaration) =>
        /(?:^|\/)refinement-dsl\.(?:d\.)?ts$/.test(declaration.getSourceFile().fileName.replaceAll("\\", "/")));
      if (!valid) throw new Error(`${fileName}: ${element.name.text} does not resolve to @mizchi/uneffect/spec#${exported} by TypeChecker symbol identity`);
    }
  }

  const assignment = source.statements.find(ts.isExportAssignment);
  const call = assignment && ts.isCallExpression(assignment.expression) ? assignment.expression : undefined;
  const root = call?.arguments[0];
  const fields = new Map(objectEntries(root, fileName, "defineRefinement argument"));
  const callable = (node: ts.Expression | undefined, context: string): ts.Signature => {
    if (!node || !ts.isIdentifier(node)) throw new Error(`${fileName}: ${context} must be a callable identifier`);
    const signatures = checker.getSignaturesOfType(checker.getTypeAtLocation(node), ts.SignatureKind.Call);
    if (signatures.length !== 1) throw new Error(`${fileName}: ${context} must resolve to exactly one callable signature by TypeChecker identity`);
    const signature = signatures[0]!;
    if (signature.getParameters().length < 1) throw new Error(`${fileName}: ${context} must accept a runtime parameter`);
    return signature;
  };
  const create = callable(fields.get("create"), "create"), observe = callable(fields.get("observe"), "observe");
  const parameterType = (signature: ts.Signature): ts.Type => checker.getTypeOfSymbolAtLocation(signature.getParameters()[0]!, signature.getDeclaration());
  const runtime = checker.getReturnTypeOfSignature(create), createInput = parameterType(create), observeInput = parameterType(observe);
  const same = (left: ts.Type, right: ts.Type): boolean => checker.isTypeAssignableTo(left, right) && checker.isTypeAssignableTo(right, left);
  if (!same(runtime, createInput)) throw new Error(`${fileName}: create input and result must have the same Runtime type`);
  if (!same(runtime, observeInput)) throw new Error(`${fileName}: observe must accept the create Runtime type`);
  for (const section of ["actions", "invariants"] as const) for (const [name, node] of objectEntries(fields.get(section), fileName, section)) {
    const signature = callable(node, `${section}.${name}`);
    if (!same(runtime, parameterType(signature))) throw new Error(`${fileName}: ${section}.${name} must accept the create Runtime type`);
    if (section === "invariants" && !(checker.getReturnTypeOfSignature(signature).flags & ts.TypeFlags.BooleanLike)) {
      throw new Error(`${fileName}: invariants.${name} must return boolean`);
    }
  }
}

function validateRefinementDslCallableOrigins(program: ts.Program, specificationFile: string, implementationFile: string): void {
  const source = program.getSourceFile(specificationFile);
  if (!source) throw new Error(`${specificationFile}: refinement specification is not part of the TypeScript Program`);
  const checker = program.getTypeChecker(), assignment = source.statements.find(ts.isExportAssignment);
  const call = assignment && ts.isCallExpression(assignment.expression) ? assignment.expression : undefined;
  const fields = new Map(objectEntries(call?.arguments[0], specificationFile, "defineRefinement argument"));
  const selected: Array<[string, ts.Expression | undefined]> = [["create", fields.get("create")], ["observe", fields.get("observe")]];
  for (const section of ["actions", "invariants"] as const) {
    for (const [name, node] of objectEntries(fields.get(section), specificationFile, section)) selected.push([`${section}.${name}`, node]);
  }
  const expected = implementationFile.replaceAll("\\", "/");
  for (const [name, node] of selected) {
    if (!node || !ts.isIdentifier(node)) throw new Error(`${specificationFile}: ${name} must be a callable identifier`);
    const shorthand = ts.isShorthandPropertyAssignment(node.parent) ? checker.getShorthandAssignmentValueSymbol(node.parent) : undefined;
    const symbol = shorthand ?? checker.getSymbolAtLocation(node), target = symbol && unalias(checker, symbol);
    const declarations = target?.declarations ?? [];
    if (!declarations.some((declaration) => declaration.getSourceFile().fileName.replaceAll("\\", "/") === expected)) {
      throw new Error(`${specificationFile}: ${name} does not resolve to an export declared by attached implementation ${implementationFile}`);
    }
  }
}

/** Resolves one implementation attachment and lowers its typed DSL to the stable v1 manifest. */
export function resolveRefinementDslLink(
  implementationFile: string,
  implementationSource: string,
  files: Readonly<Record<string, string>>,
  program?: ts.Program,
): RefinementBindingManifest {
  const links = extractAnnotations(implementationSource, "refinement_from");
  if (links.length !== 1) throw new Error(`${implementationFile}: expected exactly one uneffect:refinement_from declaration`);
  const quoted = /^(?:"([^"]+)"|'([^']+)')$/.exec(links[0]!);
  if (!quoted) throw new Error(`${implementationFile}: refinement_from requires a quoted relative .uneffect.ts path and #default export`);
  const reference = quoted[1] ?? quoted[2]!, hash = reference.lastIndexOf("#");
  const requested = reference.slice(0, hash), exportName = reference.slice(hash + 1);
  if (hash < 0 || exportName !== "default" || (!requested.startsWith("./") && !requested.startsWith("../")) || !requested.endsWith(".uneffect.ts")) {
    throw new Error(`${implementationFile}: invalid refinement specification reference`);
  }
  const specificationFile = posix.normalize(posix.join(posix.dirname(implementationFile), requested));
  const specification = files[specificationFile];
  if (specification === undefined) throw new Error(`${implementationFile}: refinement specification ${specificationFile} does not exist in the selected project`);
  const parsed = parseRefinementDsl(specificationFile, specification);
  if (program) {
    validateRefinementDslIdentities(program, specificationFile);
    validateRefinementDslCallableOrigins(program, specificationFile, implementationFile);
  }
  const runtimeIdentity = parsed.runtimeIdentity ? parseRefinementRuntimeIdentity(parsed.runtimeIdentity) : undefined;
  if (parsed.runtimeIdentity && !runtimeIdentity) throw new Error(`${specificationFile}: unsupported refinement runtime identity ${parsed.runtimeIdentity}`);
  return {
    schema: "uneffect-refinement-bindings/v1", fileName: implementationFile,
    adapterName: parsed.name, version: parsed.version,
    ...(runtimeIdentity ? { runtimeIdentity } : {}),
    create: parsed.create, observe: parsed.observe,
    abstractions: parsed.abstractions, actions: parsed.actions, invariants: parsed.invariants,
  };
}
