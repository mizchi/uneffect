import { resolve } from "node:path";
import type { TSType } from "oxc-parser";
import { openCorsaCallableFrontend, type CorsaCallableFrontend } from "../frontends/corsa/corsa-callable-frontend.js";
import type { CorsaApiFrontendOptions, CorsaApiSymbolFact, CorsaApiTypeFact } from "../frontends/corsa/corsa-api-frontend.js";
import { parseNativeNodeHandle } from "../frontends/corsa/native-source-index.js";
import { oxcParameterBinding, oxcParameterType } from "../frontends/oxc/source.js";
import { validateCorsaDslHelperIdentities } from "../spec/corsa-dsl-identities.js";
import { inspectContractImplementation, validateContractSignatureDomains } from "./contract-link.js";
import { prepareContractDslSourceLinks } from "./contract-dsl-source.js";
import type { ParsedContractDsl, PreparedContractDslLinks } from "./contract-dsl-contracts.js";
import type { NumericDomain } from "./logic-contracts.js";
import { numericContractDomain } from "./numeric-contract-identity.js";

export interface PrepareCorsaContractDslOptions extends CorsaApiFrontendOptions {
  /** Original source text, also present in the configured native project. Keys are retained in output. */
  files: Readonly<Record<string, string>>;
}

function numericDomain(symbol: CorsaApiSymbolFact | null): "nat" | "float" | undefined {
  return numericContractDomain(symbol?.name, symbol?.declarations?.map(handle => parseNativeNodeHandle(handle).path) ?? []);
}

function validateLink(frontend: CorsaCallableFrontend, implementationFile: string, specificationFile: string,
  implementationText: string, specificationText: string, contract: ParsedContractDsl): void {
  frontend.assertSource(implementationFile, implementationText);
  frontend.assertSource(specificationFile, specificationText);
  validateCorsaDslHelperIdentities(frontend, specificationFile, specificationText, "contract");
  const declaration = inspectContractImplementation(implementationFile, implementationText, contract), node = declaration.node;
  const signature = frontend.getSignatureFromDeclaration(implementationFile, declaration, implementationText);
  if (!signature || signature.parameters.length !== node.params.length) throw new Error(`${implementationFile}: missing native contract signature`);
  const domain = (type: CorsaApiTypeFact, annotation?: TSType): NumericDomain | undefined => {
    if (annotation?.type === "TSTypeReference" && annotation.typeName.type === "Identifier") {
      const local = frontend.getSymbolAtPosition(implementationFile, annotation.typeName.start);
      const identity = local && (frontend.getAliasedSymbol(local) ?? local);
      const branded = numericDomain(identity);
      if (branded) return branded;
    }
    const branded = numericDomain(frontend.getTypeAliasSymbol(type));
    if (branded) return branded;
    const primitive = frontend.getPrimitiveTypeKind(type);
    return primitive === "number" ? "int" : primitive === "boolean" ? "bool" : undefined;
  };
  const parameters = node.params.map((parameter, index) => {
    const binding = oxcParameterBinding(parameter)!;
    if (signature.parameters[index]!.name !== binding.name) throw new Error(`${implementationFile}: native parameter identity does not match ${binding.name}`);
    return domain(signature.parameters[index]!.type, oxcParameterType(parameter));
  });
  const result = domain(signature.returnType, node.returnType?.typeAnnotation);
  validateContractSignatureDomains(implementationFile, contract, parameters, result);
}

/** Authenticate helpers and implementation signatures, check native diagnostics, then prepare trusted contract clauses. Does not prove bodies. */
export async function prepareCorsaContractDslLinks(options: PrepareCorsaContractDslOptions): Promise<PreparedContractDslLinks> {
  const { files, ...frontendOptions } = options;
  // Parse all links before opening native resources or producing transformed output.
  const links: Array<{ implementationFile: string; specificationFile: string; contract: ParsedContractDsl }> = [];
  const prepared = prepareContractDslSourceLinks(files, (implementationFile, specificationFile, contract) => {
    links.push({ implementationFile, specificationFile, contract });
  });
  if (links.length === 0) return prepared;
  const frontend = await openCorsaCallableFrontend(frontendOptions);
  try {
    const absolute = (file: string): string => resolve(options.cwd ?? process.cwd(), file);
    for (const link of links) validateLink(frontend, absolute(link.implementationFile), absolute(link.specificationFile), files[link.implementationFile]!, files[link.specificationFile]!, link.contract);
    const errors = frontend.getProjectDiagnostics().filter(diagnostic => diagnostic.category === "error");
    if (errors.length) throw new Error(errors.map(error => `${error.fileName ?? options.configFile}: TS${error.code}: ${error.message}`).join("\n"));
    return prepared;
  } finally { frontend.close(); }
}
