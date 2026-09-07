import type { Node, ObjectExpression } from "oxc-parser";
import { parseOxcSource } from "../frontends/oxc/source.js";
import { dslFields, dslObject } from "../frontends/oxc/dsl.js";

export interface RefinementCallableReference {
  context: string;
  identifier: Extract<Node, { type: "Identifier" }>;
  shorthand?: { start: number; end: number };
}

/** Syntax-only callable locations shared by checker adapters. */
export function refinementCallableReferences(fileName: string, text: string): RefinementCallableReference[] {
  const source = parseOxcSource(fileName, text);
  const assignment = source.program.body.find(node => node.type === "ExportDefaultDeclaration");
  const call = assignment?.declaration.type === "CallExpression" ? assignment.declaration : undefined;
  const root = dslObject(source, call?.arguments[0], "defineRefinement argument");
  const fields = dslFields(source, root, "defineRefinement argument", true);
  const reference = (object: ObjectExpression, name: string, context: string): RefinementCallableReference => {
    const value = dslFields(source, object, context, true).get(name);
    if (value?.type !== "Identifier") throw new Error(`${fileName}: ${context} must be a callable identifier`);
    const property = object.properties.find(item => item.type === "Property" && item.value === value);
    return { context, identifier: value, ...(property?.type === "Property" && property.shorthand ? { shorthand: { start: property.start, end: property.end } } : {}) };
  };
  const references = [reference(root, "create", "create"), reference(root, "observe", "observe")];
  for (const section of ["actions", "invariants"] as const) {
    const object = dslObject(source, fields.get(section), section);
    for (const name of dslFields(source, object, section, true).keys()) references.push(reference(object, name, `${section}.${name}`));
  }
  return references;
}

export interface RefinementCallableTypes<T> {
  parameters: readonly T[];
  result: T;
}

/** Runtime compatibility is bidirectional assignability, not display-name equality. */
export function validateRefinementCallableTypes<T>(fileName: string, references: readonly RefinementCallableReference[],
  signature: (reference: RefinementCallableReference) => RefinementCallableTypes<T>,
  same: (left: T, right: T) => boolean, isBoolean: (type: T) => boolean): void {
  const facts = references.map(reference => {
    const value = signature(reference);
    if (value.parameters.length < 1) throw new Error(`${fileName}: ${reference.context} must accept a runtime parameter`);
    return { reference, value };
  });
  const create = facts.find(item => item.reference.context === "create")!.value;
  const runtime = create.result;
  if (!same(runtime, create.parameters[0]!)) throw new Error(`${fileName}: create input and result must have the same Runtime type`);
  for (const { reference, value } of facts) {
    if (reference.context === "create") continue;
    if (!same(runtime, value.parameters[0]!)) throw new Error(`${fileName}: ${reference.context} must accept the create Runtime type`);
    if (reference.context.startsWith("invariants.") && !isBoolean(value.result)) throw new Error(`${fileName}: ${reference.context} must return boolean`);
  }
}
