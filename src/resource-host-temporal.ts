import type { AsyncSafetyResult, ResourceBinding } from "./async-safety.js";
import { lowerResourceDisposalsToProtocol } from "./resource-disposal-protocol.js";
import {
  createResourceDisposalTemporalProduct,
  generateResourceTemporalProductQuint,
} from "./resource-temporal-product.js";

export interface ResourceHostTemporalOptions {
  /** Negative-control hook used by tests to prove the scheduling invariant is load-bearing. */
  resumeOutsideMicrotask?: boolean;
}

export interface ResourceHostTemporalSupport {
  supported: boolean;
  reasons: string[];
}

/**
 * The executable resource/host product currently supports one root with
 * straight-line, non-repeating resources. Conditional and loop acquisitions
 * remain in the independent resource projection until their host product is
 * defined.
 */
export function resourceHostTemporalSupport(resources: ResourceBinding[]): ResourceHostTemporalSupport {
  const reasons: string[] = [];
  if (!resources.some((resource) => resource.asynchronous)) reasons.push("no await using resource requires host scheduling");
  if (resources.some((resource) => resource.conditional || resource.controlPaths.some((path) => path.length > 0))) {
    reasons.push("conditional resource acquisition is not in the bounded host product");
  }
  return { supported: reasons.length === 0, reasons };
}

/**
 * Compatibility facade. The model is built and emitted by the common
 * resource/temporal product IR so this entry point does not own a second set
 * of disposal semantics.
 */
export function generateResourceHostTemporalQuint(
  moduleName: string,
  result: AsyncSafetyResult,
  owner: string,
  options: ResourceHostTemporalOptions = {},
): string {
  const resources = result.resources.filter((resource) => resource.owner === owner);
  const support = resourceHostTemporalSupport(resources);
  if (!support.supported) throw new Error(support.reasons.join("; "));
  const disposals = result.disposals.filter((disposal) => disposal.owner === owner);
  const lifecycle = lowerResourceDisposalsToProtocol(resources, disposals, owner);
  const product = createResourceDisposalTemporalProduct(result.fileName, lifecycle, disposals);
  if (product.status === "unknown") throw new Error(product.reasons.join("; ") || "resource temporal product is not ready");
  return generateResourceTemporalProductQuint(moduleName, product.product, {
    propertyName: "resourceHostSafe",
    ...(options.resumeOutsideMicrotask ? { resumeOutsideMicrotask: true } : {}),
  });
}
