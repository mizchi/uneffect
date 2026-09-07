import { posix } from "node:path";
import type { Node, Expression } from "oxc-parser";
import { parseOxcSource } from "../frontends/oxc/source.js";
import { dslImports, dslObject, dslFields, dslCallback, dslExpressionText } from "../frontends/oxc/dsl.js";
import { extractAnnotations } from "../support/annotations.js";
import type { NumericDomain } from "./logic-contracts.js";
import type { ParsedContractDsl, ContractClauseProvenance, PreparedContractDslLinks } from "./contract-dsl-contracts.js";
export type { ParsedContractDsl, ContractClauseProvenance, PreparedContractDslLinks } from "./contract-dsl-contracts.js";

function readContractDsl(fileName: string, text: string, exportName: string): { contract: ParsedContractDsl; clauses: ContractClauseProvenance[] } {
  const source = parseOxcSource(fileName, text);
  const imported = dslImports(source, ["defineContract", "int", "nat", "float", "bool"]);
  let definition: Extract<Expression, { type: "CallExpression" }> | undefined;
  for (const statement of source.program.body) {
    if (statement.type !== "ExportNamedDeclaration" || statement.declaration?.type !== "VariableDeclaration") continue;
    for (const declaration of statement.declaration.declarations) {
      if (declaration.id.type !== "Identifier") throw new Error(`${fileName}: contract DSL requires static names`);
      const call = declaration.init;
      if (declaration.id.name === exportName && call?.type === "CallExpression" && !call.optional
        && call.callee.type === "Identifier" && imported.get(call.callee.name) === "defineContract") definition = call;
    }
  }
  if (!definition) throw new Error(`${fileName}: does not export contract ${exportName}`);
  if (definition.arguments.length !== 1) throw new Error(`${fileName}: defineContract requires exactly one object literal`);
  const fields = (node: Node | null | undefined, context: string) => dslFields(source, dslObject(source, node, context), context);
  const root = fields(definition.arguments[0], "contract definition");
  if (!root.has("parameters") || !root.has("returns") || !root.has("ensures")
    || [...root.keys()].some(key => !["parameters", "returns", "requires", "ensures"].includes(key))) {
    throw new Error(`${fileName}: contract requires parameters, returns, ensures, and optional requires`);
  }
  const descriptor = (node: Expression | undefined, context: string): NumericDomain => {
    if (!node || node.type !== "CallExpression" || node.optional || node.arguments.length !== 0 || node.callee.type !== "Identifier") throw new Error(`${fileName}: ${context} requires a scalar descriptor`);
    const helper = imported.get(node.callee.name);
    if (helper !== "int" && helper !== "nat" && helper !== "float" && helper !== "bool") throw new Error(`${fileName}: unsupported contract type descriptor`);
    return helper;
  };
  const parameters = [...fields(root.get("parameters"), "contract parameters")].map(([name, value]) => ({ name, domain: descriptor(value, `parameter ${name}`) }));
  const clauses: ContractClauseProvenance[] = [];
  const predicates = (kind: "requires" | "ensures"): string[] => {
    const node = root.get(kind);
    if (kind === "requires" && !node) return [];
    const list = node?.type === "ArrayExpression" ? node.elements : [node];
    if (!list.length) throw new Error(`${fileName}: ${kind} must not be empty`);
    return list.map((item, index) => {
      const body = dslCallback(source, item, node?.type === "ArrayExpression" ? `${kind} ${index + 1}` : kind, true);
      const expression = dslExpressionText(source, body), position = source.positionAt(body.start);
      clauses.push({ kind, expression, fileName, line: position.line + 1, column: position.character + 1, span: { start: body.start, end: body.end } });
      return expression;
    });
  };
  const contract = { parameters, resultDomain: descriptor(root.get("returns"), "contract return"), requires: predicates("requires"), ensures: predicates("ensures") };
  // Provenance follows property order, independent of the normalized contract's clause order.
  const order = [...root.keys()];
  clauses.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
  return { contract, clauses };
}

/** Pure source interpretation. Does not authenticate imported helpers or check implementation signatures. */
export function parseContractDsl(fileName: string, text: string, exportName: string): ParsedContractDsl {
  return readContractDsl(fileName, text, exportName).contract;
}

/** Prepare trusted source declarations without checker authentication. */
export function prepareContractDslSources(files: Readonly<Record<string, string>>): PreparedContractDslLinks {
  return prepareContractDslSourceLinks(files);
}

export function prepareContractDslSourceLinks(files: Readonly<Record<string, string>>, validate?: (implementationFile: string, specificationFile: string, contract: ParsedContractDsl) => void): PreparedContractDslLinks {
  const output = { ...files }, annotationPrefix = ["uneffect", ""].join(":");
  const provenance: Record<string, ContractClauseProvenance[]> = {};
  for (const [fileName, source] of Object.entries(files)) {
    const links = extractAnnotations(source, "contract_from");
    if (links.length === 0) continue;
    if (links.length !== 1) throw new Error(`${fileName}: expected exactly one uneffect:contract_from declaration`);
    const quoted = /^(?:"([^"]+)"|'([^']+)')$/.exec(links[0]!);
    if (!quoted) throw new Error(`${fileName}: contract from requires a quoted relative .uneffect.ts path and export`);
    const reference = quoted[1] ?? quoted[2]!, hash = reference.lastIndexOf("#"), requested = reference.slice(0, hash), exportName = reference.slice(hash + 1);
    if (hash < 0 || (!requested.startsWith("./") && !requested.startsWith("../")) || !requested.endsWith(".uneffect.ts") || !/^[A-Za-z_$][\w$]*$/.test(exportName)) throw new Error(`${fileName}: invalid contract specification reference`);
    const specificationFile = posix.normalize(posix.join(posix.dirname(fileName), requested)), specification = files[specificationFile];
    if (specification === undefined) throw new Error(`${fileName}: contract specification ${specificationFile} does not exist in the selected project`);
    const { contract, clauses } = readContractDsl(specificationFile, specification, exportName);
    provenance[fileName] = clauses;
    validate?.(fileName, specificationFile, contract);
    const body = [
      ...contract.parameters.filter((item) => item.domain === "nat" || item.domain === "float").map((item) => `assert ${item.name}: ${item.domain === "nat" ? "Nat" : "Float"}`),
      ...(contract.resultDomain === "nat" || contract.resultDomain === "float" ? [`returns ${contract.resultDomain === "nat" ? "Nat" : "Float"}`] : []),
      ...contract.requires.map((value) => `requires ${value}`),
      ...contract.ensures.map((value) => `ensures ${value}`),
    ].join("\n * ");
    output[fileName] = source.replace(/\/\*\s*uneffect\s*:\s*contract_from\s+(?:"[^"]+"|'[^']+')\s*\*\//, `/* ${annotationPrefix}\n * ${body}\n */`);
  }
  return { files: output, provenance };
}

