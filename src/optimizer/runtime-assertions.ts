import type { Node, Statement } from "oxc-parser";
import { extractAnnotations } from "../support/annotations.js";
import { parseOxcExpression } from "../frontends/oxc/expression.js";
import { oxcChildren, oxcParameterBinding, parseOxcSource } from "../frontends/oxc/source.js";

export interface InstrumentDiagnostic {
  fileName: string;
  line: number;
  kind: "unknown-parameter" | "invalid-schema" | "unsupported-function";
  parameter: string;
  message: string;
}

export interface InstrumentResult {
  code: string;
  diagnostics: InstrumentDiagnostic[];
}

const namedSchemas: Readonly<Record<string, string>> = {
  Int: "v.pipe(v.number(), v.safeInteger())",
  Nat: "v.pipe(v.number(), v.safeInteger(), v.minValue(0))",
  Float: "v.pipe(v.number(), v.finite())",
};
const prototypeNames = new Set(["__proto__", "prototype", "constructor"]);

/** Accept a closed schema expression and rename only references to its namespace. */
function schemaCode(input: string, namespace: string): string | undefined {
  const expanded = Object.hasOwn(namedSchemas, input) ? namedSchemas[input]! : input;
  let parsed: ReturnType<typeof parseOxcExpression>;
  try { parsed = parseOxcExpression(expanded, "Valibot schema"); }
  catch { return undefined; }
  const references: Array<{ start: number; end: number }> = [];
  const safe = (node: Node): boolean => {
    switch (node.type) {
      case "ParenthesizedExpression": return safe(node.expression);
      case "Literal": return node.value === null || ["string", "number", "boolean"].includes(typeof node.value);
      case "Identifier":
        if (node.name === "v") { references.push(node); return true; }
        return node.name === "undefined";
      case "MemberExpression":
        return !node.optional && !node.computed && node.object.type === "Identifier" && node.object.name === "v"
          && node.property.type === "Identifier" && !prototypeNames.has(node.property.name) && safe(node.object);
      case "CallExpression":
        return !node.optional && node.callee.type === "MemberExpression" && safe(node.callee) && node.arguments.every(safe);
      case "ArrayExpression": return node.elements.every(element => element !== null && safe(element));
      case "ObjectExpression": return node.properties.every(property => property.type === "Property"
        && property.kind === "init" && !property.method && !property.shorthand && !property.computed
        && (property.key.type === "Identifier" ? !prototypeNames.has(property.key.name)
          : property.key.type === "Literal" && !prototypeNames.has(String(property.key.value)))
        && safe(property.value));
      default: return false;
    }
  };
  if (!safe(parsed.expression)) return undefined;
  const offset = parsed.expression.start + 1;
  let result = expanded;
  for (const reference of references.sort((a, b) => b.start - a.start)) {
    result = result.slice(0, reference.start - offset) + namespace + result.slice(reference.end - offset);
  }
  return result;
}

function unusedNamespace(root: Node): string {
  const names = new Set<string>();
  const visit = (node: Node): void => {
    if (node.type === "Identifier") names.add(node.name);
    for (const child of oxcChildren(node)) visit(child);
  };
  visit(root);
  let candidate = "__uneffect_v", suffix = 0;
  while (names.has(candidate)) candidate = `__uneffect_v_${++suffix}`;
  return candidate;
}

function afterDirectives(statements: readonly Statement[], fallback: number): number {
  let position = fallback;
  for (const statement of statements) {
    if (statement.type !== "ExpressionStatement" || !statement.directive) break;
    position = statement.end;
  }
  return position;
}

/** Insert declared parameter checks; this source transform makes no static proof claim. */
export function instrumentRuntimeAssertions(fileName: string, text: string): InstrumentResult {
  const source = parseOxcSource(fileName, text), namespace = unusedNamespace(source.program);
  const diagnostics: InstrumentDiagnostic[] = [];
  const insertions: Array<{ position: number; text: string }> = [];
  let previousEnd = 0;
  for (const statement of source.program.body) {
    const comments = text.slice(previousEnd, statement.start);
    previousEnd = statement.end;
    const node = statement.type === "ExportNamedDeclaration" || statement.type === "ExportDefaultDeclaration" ? statement.declaration : statement;
    if (node?.type !== "FunctionDeclaration" && node?.type !== "TSDeclareFunction") continue;
    const assertions = extractAnnotations(comments, "assert").flatMap(payload => {
      const match = /^([A-Za-z_$][\w$]*)\s*:\s*([\s\S]+)$/.exec(payload);
      return match ? [match] : [];
    });
    if (assertions.length === 0) continue;
    const line = source.positionAt(statement.start).line + 1;
    if (!node.body) {
      for (const assertion of assertions) diagnostics.push({ fileName, line, kind: "unsupported-function", parameter: assertion[1]!, message: "runtime assertions require a function body" });
      continue;
    }
    const parameters = new Set(node.params.flatMap(parameter => {
      const binding = oxcParameterBinding(parameter);
      return binding ? [binding.name] : [];
    }));
    const statements: string[] = [];
    for (const assertion of assertions) {
      const parameter = assertion[1]!, schema = assertion[2]!.trim();
      if (!parameters.has(parameter)) {
        diagnostics.push({ fileName, line, kind: "unknown-parameter", parameter, message: `unknown parameter ${parameter}` });
        continue;
      }
      const compiled = schemaCode(schema, namespace);
      if (!compiled) {
        diagnostics.push({ fileName, line, kind: "invalid-schema", parameter, message: `unsupported Valibot schema: ${schema}` });
        continue;
      }
      statements.push(`\n${namespace}.parse(${compiled}, ${parameter});`);
    }
    if (statements.length > 0) insertions.push({ position: afterDirectives(node.body.body, node.body.start + 1), text: statements.join("") });
  }
  if (insertions.length === 0) return { code: text, diagnostics };
  const importPosition = afterDirectives(source.program.body, source.program.hashbang?.end ?? 0);
  insertions.push({ position: importPosition, text: `${importPosition > 0 ? "\n" : ""}import * as ${namespace} from "valibot";\n` });
  let code = text;
  for (const insertion of insertions.sort((a, b) => b.position - a.position)) code = code.slice(0, insertion.position) + insertion.text + code.slice(insertion.position);
  return { code, diagnostics };
}
