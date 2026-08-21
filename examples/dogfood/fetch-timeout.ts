/* uneffect: effect Timer | Net<"api.example.com:443"> | Fetch<Fetch.GET, "https://api.example.com/dashboard"> */
export async function fetchDashboard(externalSignal: AbortSignal): Promise<Response> {
  const timeout = AbortSignal.timeout(5_000);
  const signal = AbortSignal.any([externalSignal, timeout]);
  return fetch("https://api.example.com/dashboard", { signal });
}
