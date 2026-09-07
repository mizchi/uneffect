import { posix } from "node:path";
import type { Node, ObjectExpression } from "oxc-parser";
import { parseOxcSource, type OxcSource } from "../frontends/oxc/source.js";
import { dslImports, dslObject, dslFields, dslCallback, dslExpressionText } from "../frontends/oxc/dsl.js";
import { extractAnnotations } from "../support/annotations.js";
import { parseSpec, type TemporalSpec } from "./spec-ir.js";

export interface TemporalDslLink {
  implementationFile: string;
  specificationFile: string;
  exportName: "default";
  spec: TemporalSpec;
}

export function resolveTemporalDslSourceLink(
  implementationFile: string,
  implementationSource: string,
  files: Readonly<Record<string, string>>,
): TemporalDslLink | undefined {
  const declarations = extractAnnotations(implementationSource, "temporal_from");
  if (declarations.length === 0) return undefined;
  if (declarations.length !== 1) throw new Error(`${implementationFile}: expected exactly one uneffect:temporal_from declaration`);
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

const objectLiteral = (source: OxcSource, node: Node | null | undefined, context: string) => dslObject(source, node, context, true);
const properties = (source: OxcSource, node: ObjectExpression, context: string) => [...dslFields(source, node, context)];
const callbackBody = dslCallback;
const expressionText = (source: OxcSource, node: Node, context: string) => dslExpressionText(source, dslCallback(source, node, context));

/** Parse the deliberately restricted Oxc AST of a `.uneffect.ts` module into the stable neutral IR. */
export function parseTemporalDsl(fileName: string, text: string): TemporalSpec {
  const source = parseOxcSource(fileName, text);
  for (const statement of source.program.body) {
    const declaration = statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;
    if (declaration && ["TSTypeAliasDeclaration", "TSInterfaceDeclaration"].includes(declaration.type)) continue;
    if (statement.type !== "ImportDeclaration" && statement.type !== "ExportDefaultDeclaration") {
      throw new Error(`${fileName}: unsupported top-level statement; specification modules are declarative and are not executed`);
    }
  }
  const imported = dslImports(source, ["defineTemporal", "int", "bool", "text"]);
  let root: ObjectExpression | undefined;
  for (const statement of source.program.body) {
    if (statement.type !== "ExportDefaultDeclaration") continue;
    const call = statement.declaration;
    if (call.type === "CallExpression" && !call.optional && call.callee.type === "Identifier" && imported.get(call.callee.name) === "defineTemporal") {
      if (call.arguments.length !== 1) throw new Error(`${fileName}: defineTemporal requires exactly one object literal`);
      root = objectLiteral(source, call.arguments[0], "defineTemporal argument");
    }
  }
  if (!root) throw new Error(`${fileName}: default export must call defineTemporal imported from @mizchi/uneffect/spec`);
  const sections = dslFields(source, root, "temporal definition");
  const supportedSections = new Set(["state", "init", "actions", "guards", "fairness", "invariants", "eventually", "repeatedly", "stabilizes", "responses"]);
  for (const name of sections.keys()) if (!supportedSections.has(name)) throw new Error(`${fileName}: unsupported temporal definition section ${name}`);
  for (const required of ["state", "init", "actions"]) if (!sections.has(required)) throw new Error(`${fileName}: temporal definition requires ${required}`);
  const annotationPrefix = "uneffect:";
  const lines: string[] = [];
  for (const [name, descriptor] of properties(source, objectLiteral(source, sections.get("state"), "state"), "state")) {
    if (descriptor.type !== "CallExpression" || descriptor.optional || descriptor.arguments.length !== 0 || descriptor.callee.type !== "Identifier") throw new Error(`${fileName}: unsupported temporal state descriptor for ${name}`);
    const kinds: Record<string, string> = { int: "int", bool: "bool", text: "string" };
    const kind = kinds[imported.get(descriptor.callee.name) ?? ""];
    if (!kind) throw new Error(`${fileName}: unsupported temporal state descriptor for ${name}`);
    lines.push(`/* ${annotationPrefix}state ${name}: ${kind} */`);
  }
  for (const [name, value] of properties(source, objectLiteral(source, sections.get("init"), "init"), "init")) lines.push(`/* ${annotationPrefix}init ${name} = ${dslExpressionText(source, value)} */`);
  for (const [name, value] of properties(source, objectLiteral(source, sections.get("actions"), "actions"), "action")) {
    const result = objectLiteral(source, callbackBody(source, value, `action ${name}`), `action ${name} result`);
    const assignments = properties(source, result, `action ${name}`).map(([target, expression]) => `${target}' = ${dslExpressionText(source, expression)}`);
    if (assignments.length === 0) throw new Error(`${fileName}: action ${name} must update at least one state field`);
    lines.push(`/* ${annotationPrefix}action ${name}: ${assignments.join(", ")} */`);
  }
  if (sections.has("guards")) for (const [name, guard] of properties(source, objectLiteral(source, sections.get("guards"), "guards"), "guard"))
    lines.push(`/* ${annotationPrefix}action_when ${name}: ${expressionText(source, guard, `action ${name} guard`)} */`);
  if (sections.has("fairness")) for (const [name, fairness] of properties(source, objectLiteral(source, sections.get("fairness"), "fairness"), "fairness")) {
    if (fairness.type !== "Literal" || (fairness.value !== "weak" && fairness.value !== "strong")) throw new Error(`${fileName}: fairness for ${name} must be weak or strong`);
    lines.push(`/* ${annotationPrefix}action_fair ${name}: ${fairness.value} */`);
  }
  const predicates = (["invariants", "eventually", "repeatedly", "stabilizes"] as const);
  const directives = { invariants: "always", eventually: "eventually", repeatedly: "repeatedly", stabilizes: "stabilizes" } as const;
  for (const section of predicates) if (sections.has(section)) for (const [name, predicate] of properties(source, objectLiteral(source, sections.get(section), section), section)) {
    lines.push(`/* ${annotationPrefix}${directives[section]} ${name}: ${expressionText(source, predicate, `${section} ${name}`)} */`);
  }
  if (sections.has("responses")) for (const [name, response] of properties(source, objectLiteral(source, sections.get("responses"), "responses"), "response")) {
    const pair = new Map(properties(source, objectLiteral(source, response, `response ${name}`), `response ${name}`));
    if (!pair.has("trigger") || !pair.has("response") || pair.size !== 2) throw new Error(`${fileName}: response ${name} requires exactly trigger and response`);
    lines.push(`/* ${annotationPrefix}response ${name}: ${expressionText(source, pair.get("trigger")!, `response ${name} trigger`)} => ${expressionText(source, pair.get("response")!, `response ${name} target`)} */`);
  }
  return parseSpec(fileName, lines.join("\n")).temporal;
}
