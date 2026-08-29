import type { AsyncSafetyResult, ResourceBinding } from "./async-safety.js";

export interface ResourceHostTemporalOptions {
  /** Negative-control hook used by tests to prove the scheduling invariant is load-bearing. */
  resumeOutsideMicrotask?: boolean;
}

export interface ResourceHostTemporalSupport {
  supported: boolean;
  reasons: string[];
}

function safe(name: string): string {
  return name.replace(/[^A-Za-z0-9_]/gu, "_");
}

/**
 * The first deliberately bounded resource/host product supports one root with
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
  const disposalOrder = disposals.map((disposal) => resources.findIndex((resource) =>
    resource.binding === disposal.binding && resource.scopeId === disposal.scopeId));
  if (disposalOrder.some((index) => index < 0) || disposalOrder.length !== resources.length) {
    throw new Error("resource disposal order is incomplete for the selected root");
  }

  const lines = [
    `module ${safe(moduleName)} {`,
    "  var pc: int",
    "  // 0 = task/continuation, 1 = microtask checkpoint",
    "  var host_phase: int",
    "  var pending_disposal: int",
    "  var host_order_broken: bool",
  ];
  resources.forEach((_, index) => lines.push(`  var acquired_${index}: bool`, `  var disposed_${index}: bool`));
  lines.push("", "  action init = all {", "    pc' = 0,", "    host_phase' = 0,", "    pending_disposal' = -1,", "    host_order_broken' = false,");
  resources.forEach((_, index) => lines.push(`    acquired_${index}' = false,`, `    disposed_${index}' = false,`));
  lines.push("  }");

  const actions: string[] = [];
  const emit = (name: string, guards: string[], updates: ReadonlyMap<string, string>): void => {
    actions.push(name);
    lines.push("", `  action ${name} = all {`, ...guards.map((guard) => `    ${guard},`));
    lines.push(
      `    pc' = ${updates.get("pc") ?? "pc"},`,
      `    host_phase' = ${updates.get("host_phase") ?? "host_phase"},`,
      `    pending_disposal' = ${updates.get("pending_disposal") ?? "pending_disposal"},`,
      `    host_order_broken' = ${updates.get("host_order_broken") ?? "host_order_broken"},`,
    );
    resources.forEach((_, index) => lines.push(
      `    acquired_${index}' = ${updates.get(`acquired_${index}`) ?? `acquired_${index}`},`,
      `    disposed_${index}' = ${updates.get(`disposed_${index}`) ?? `disposed_${index}`},`,
    ));
    lines.push("  }");
  };

  resources.forEach((_, index) => emit(`acquire_${index}`, [
    `pc == ${index}`,
    "host_phase == 0",
  ], new Map([["pc", String(index + 1)], [`acquired_${index}`, "true"]])));

  disposalOrder.forEach((resourceIndex, order) => {
    const resource = resources[resourceIndex]!;
    const current = resources.length + order;
    const next = current + 1;
    emit(`skip_unacquired_${resourceIndex}`, [`pc == ${current}`, `not(acquired_${resourceIndex})`], new Map([["pc", String(next)]]));
    if (resource.asynchronous) {
      emit(`dispose_start_${resourceIndex}`, [
        `pc == ${current}`,
        `acquired_${resourceIndex}`,
        `not(disposed_${resourceIndex})`,
        "pending_disposal == -1",
      ], new Map([["host_phase", "1"], ["pending_disposal", String(resourceIndex)]]));
      emit(`drain_dispose_microtask_${resourceIndex}`, [
        `pc == ${current}`,
        "host_phase == 1",
        `pending_disposal == ${resourceIndex}`,
      ], new Map([["pc", String(next)], ["pending_disposal", "-1"], [`disposed_${resourceIndex}`, "true"]]));
      if (options.resumeOutsideMicrotask) emit(`resume_dispose_outside_microtask_${resourceIndex}`, [
        `pc == ${current}`,
        `pending_disposal == ${resourceIndex}`,
      ], new Map([["pc", String(next)], ["host_phase", "0"], ["pending_disposal", "-1"], ["host_order_broken", "true"], [`disposed_${resourceIndex}`, "true"]]));
    } else {
      emit(`dispose_${resourceIndex}`, [
        `pc == ${current}`,
        `acquired_${resourceIndex}`,
        `not(disposed_${resourceIndex})`,
      ], new Map([["pc", String(next)], [`disposed_${resourceIndex}`, "true"]]));
    }
  });

  const complete = resources.length + disposalOrder.length;
  emit("finish_cleanup_checkpoint", [`pc == ${complete}`, "pending_disposal == -1", "host_phase == 1"], new Map([["host_phase", "0"]]));
  lines.push("", "  action step = any {", ...actions.map((action) => `    ${action},`), "  }");
  const disposed = resources.map((_, index) => `(not(acquired_${index}) or disposed_${index})`).join(" and ");
  lines.push("", `  val resourceHostSafe = not(host_order_broken) and (pending_disposal == -1 or host_phase == 1) and (pc != ${complete} or (${disposed}))`, "}", "");
  return lines.join("\n");
}
