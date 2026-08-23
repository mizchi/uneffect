import { dashboardFailures, dashboardSnapshotValues, dashboardValues } from "./dashboard-values.js";

export async function loadImportedDashboard(network: PromiseLike<string>): Promise<string[]> {
  return Promise.all(dashboardValues(network));
}

export async function loadImportedDashboardSnapshot(): Promise<string[]> {
  return Promise.all(dashboardSnapshotValues);
}

export async function loadImportedDashboardFallback(): Promise<never> {
  return Promise.any(dashboardFailures());
}
