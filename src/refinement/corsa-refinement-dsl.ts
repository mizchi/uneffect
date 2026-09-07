import { resolve } from "node:path";
import type { CorsaApiFrontendOptions } from "../frontends/corsa/corsa-api-frontend.js";
import { openCorsaCallableFrontend } from "../frontends/corsa/corsa-callable-frontend.js";
import { parseNativeNodeHandle } from "../frontends/corsa/native-source-index.js";
import { validateCorsaDslHelperIdentities } from "../spec/corsa-dsl-identities.js";
import { refinementCallableReferences, validateRefinementCallableTypes } from "./refinement-link.js";
import { refinementDslSpecificationFile, resolveRefinementDslSourceLinks } from "./refinement-dsl-source.js";
import type { RefinementBindingManifest } from "./binding-contracts.js";

export interface ResolveCorsaRefinementDslOptions extends CorsaApiFrontendOptions {
  implementationFile: string;
  /** Sources present in the native project. The manifest retains the supplied implementation path. */
  files: Readonly<Record<string, string>>;
}

/** Authenticate callable types/origins and native diagnostics. Action and invariant bodies are not proved here. */
export async function resolveCorsaRefinementDslLink(options: ResolveCorsaRefinementDslOptions): Promise<RefinementBindingManifest> {
  const { implementationFile, files, ...frontendOptions } = options;
  const text = files[implementationFile];
  if (text === undefined) throw new Error(`${implementationFile}: implementation source is not in the selected project`);
  const manifest = resolveRefinementDslSourceLinks(implementationFile, text, files);
  const specificationFile = refinementDslSpecificationFile(implementationFile, text), spec = files[specificationFile]!;
  const absolute = (file: string): string => resolve(options.cwd ?? process.cwd(), file);
  const frontend = await openCorsaCallableFrontend(frontendOptions);
  try {
    const implementation = absolute(implementationFile), specification = absolute(specificationFile);
    frontend.assertSource(implementation, text);
    frontend.assertSource(specification, spec);
    validateCorsaDslHelperIdentities(frontend, specification, spec, "refinement");
    const references = refinementCallableReferences(specification, spec);
    validateRefinementCallableTypes(specification, references, reference => {
      const signatures = frontend.getSignaturesOfTypeAtPosition(specification, reference.identifier.start);
      if (signatures.length !== 1) throw new Error(`${specification}: ${reference.context} must resolve to exactly one callable signature by Corsa identity`);
      const signature = signatures[0]!;
      return { parameters: signature.parameters.map(parameter => parameter.type), result: signature.returnType };
    }, (left, right) => frontend.isTypeAssignableTo(left, right) && frontend.isTypeAssignableTo(right, left),
    type => frontend.getPrimitiveTypeKind(type) === "boolean");
    const canonical = (file: string): string => process.platform === "darwin" || process.platform === "win32" ? file.toLowerCase().replaceAll("\\", "/") : file;
    for (const reference of references) {
      const symbol = reference.shorthand
        ? frontend.getShorthandAssignmentValueSymbol(specification, reference.shorthand, spec)
        : frontend.getSymbolAtPosition(specification, reference.identifier.start);
      const target = symbol && (frontend.getAliasedSymbol(symbol) ?? symbol);
      if (!target?.declarations?.some(handle => canonical(parseNativeNodeHandle(handle).path) === canonical(implementation))) {
        throw new Error(`${specification}: ${reference.context} does not resolve to an export declared by attached implementation ${implementationFile}`);
      }
    }
    const errors = frontend.getProjectDiagnostics().filter(diagnostic => diagnostic.category === "error");
    if (errors.length) throw new Error(errors.map(error => `${error.fileName ?? options.configFile}: TS${error.code}: ${error.message}`).join("\n"));
    return manifest;
  } finally { frontend.close(); }
}
