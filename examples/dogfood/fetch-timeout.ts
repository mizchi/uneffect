/* uneffect:effect Timer | Net<"api.example.com:443"> | Fetch<Fetch.GET, "https://api.example.com/dashboard"> */
export async function fetchDashboard(externalSignal: AbortSignal, shutdownSignal: AbortSignal): Promise<Response> {
  const timeout = AbortSignal.timeout(5_000);
  const deadline = AbortSignal.any([externalSignal, timeout]);
  const signal = AbortSignal.any([deadline, shutdownSignal]);
  return fetch("https://api.example.com/dashboard", { signal });
}
