import { dashboardValues } from "./dashboard-values.js";

export async function loadImportedDashboard(network: PromiseLike<string>): Promise<string[]> {
  return Promise.all(dashboardValues(network));
}
