import { extractAnnotations } from "../support/annotations.js";
import { oxcParameterBinding, parseOxcSource, topLevelOxcFunctions, type OxcFunctionSource } from "../frontends/oxc/source.js";
import type { ParsedContractDsl } from "./contract-dsl-contracts.js";
import type { NumericDomain } from "./logic-contracts.js";

/** Syntax and attachment contract shared by the native and Program type adapters. */
export function inspectContractImplementation(fileName: string, text: string, contract: ParsedContractDsl): OxcFunctionSource {
  const source = parseOxcSource(fileName, text);
  const linked = topLevelOxcFunctions(source).filter(item => extractAnnotations(item.comments, "contract_from").length > 0);
  if (extractAnnotations(text, "contract_from").length !== 1 || linked.length !== 1) throw new Error(`${fileName}: contract from must directly precede exactly one function declaration`);
  const declaration = linked[0]!, node = declaration.node;
  if (node.params.length !== contract.parameters.length) throw new Error(`${fileName}: linked contract parameter count does not match ${node.id.name}`);
  node.params.forEach((parameter, index) => {
    const binding = oxcParameterBinding(parameter), expected = contract.parameters[index]!;
    if (!binding || parameter.type === "RestElement" || binding.optional || binding.name !== expected.name) throw new Error(`${fileName}: linked contract parameter ${index + 1} must be required identifier ${expected.name}`);
  });
  return declaration;
}

/** The frontend supplies authenticated domains; this comparison has no checker dependency. */
export function validateContractSignatureDomains(fileName: string, contract: ParsedContractDsl,
  parameters: readonly (NumericDomain | undefined)[], result: NumericDomain | undefined): void {
  if (parameters.length !== contract.parameters.length) throw new Error(`${fileName}: missing contract signature parameters`);
  contract.parameters.forEach((expected, index) => {
    const actual = parameters[index];
    if (actual !== expected.domain) throw new Error(`${fileName}: linked contract parameter ${expected.name} expects ${expected.domain}, implementation is ${actual ?? "unsupported"}`);
  });
  if (result !== contract.resultDomain) throw new Error(`${fileName}: linked contract result expects ${contract.resultDomain}, implementation is ${result ?? "unsupported"}`);
}
