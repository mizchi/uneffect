export async function loadDashboard(remote: PromiseLike<string>): Promise<(string | undefined)[]> {
  return Promise.all(["cached-profile", , remote]);
}

export async function loadUniqueDashboard(remote: PromiseLike<string>): Promise<string[]> {
  return Promise.all(new Set([remote, remote, "cached-profile"]));
}
