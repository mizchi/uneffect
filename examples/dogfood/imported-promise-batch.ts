import {
  conditionalDashboardValues,
  dashboardFailures,
  dashboardSnapshotValues,
  dashboardValues,
} from "./dashboard-values.js";

export async function loadImportedDashboard(network: PromiseLike<string>): Promise<string[]> {
  const batch = dashboardValues(network);
  const forwarded = batch;
  return Promise.all(["dashboard-header", ...forwarded]);
}

export async function loadImportedDashboardSnapshot(): Promise<string[]> {
  return Promise.all(dashboardSnapshotValues);
}

export async function loadImportedDashboardFallback(): Promise<never> {
  return Promise.any([...dashboardFailures()]);
}

export async function loadConditionalDashboard(
  preferNetwork: boolean,
  network: PromiseLike<string>,
): Promise<string[]> {
  return Promise.all(["conditional-metadata", ...conditionalDashboardValues(preferNetwork, network)]);
}
