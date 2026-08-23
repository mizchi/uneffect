import {
  conditionalDashboardValues,
  dashboardFailures,
  dashboardReplicaValues,
  dashboardSnapshotValues,
  dashboardValues,
  delegatedDashboardValues,
} from "./dashboard-values.js";

export async function loadDashboardReplicas(network: PromiseLike<string>): Promise<string[]> {
  return Promise.all(dashboardReplicaValues(network));
}

export async function loadImportedDashboard(network: PromiseLike<string>): Promise<string[]> {
  const batch = dashboardValues(network);
  const forwarded = batch;
  return Promise.all(["dashboard-header", ...forwarded]);
}

export async function loadImportedDashboardSnapshot(): Promise<string[]> {
  return Promise.all(dashboardSnapshotValues);
}

export async function loadImportedDashboardFallback(): Promise<never> {
  return Promise.any([...dashboardFailures({
    useCache: true,
    useNetwork: true,
    cache: { reason: "cache-miss" },
    network: { services: ["network"] },
  } as const)]);
}

export async function loadConditionalDashboard(
  preferNetwork: boolean,
  network: PromiseLike<string>,
): Promise<string[]> {
  return Promise.all(["conditional-metadata", ...conditionalDashboardValues(preferNetwork, network)]);
}

/** Compare two snapshots, but stop constructing the batch if either source iterator fails. */
export async function compareConditionalDashboards(
  preferPrimaryNetwork: boolean,
  preferSecondaryNetwork: boolean,
  primaryNetwork: PromiseLike<string>,
  secondaryNetwork: PromiseLike<string>,
): Promise<string[]> {
  return Promise.all([
    "comparison-header",
    ...conditionalDashboardValues(preferPrimaryNetwork, primaryNetwork),
    "comparison-separator",
    ...conditionalDashboardValues(preferSecondaryNetwork, secondaryNetwork),
  ]);
}

export async function loadDelegatedDashboard(
  preferNetwork: boolean,
  network: PromiseLike<string>,
): Promise<string[]> {
  return Promise.all(delegatedDashboardValues(preferNetwork, network));
}
