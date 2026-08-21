/* uneffect: effect Timer | Net<"api.example.com:443"> | Fetch<Fetch.GET, "https://api.example.com/dashboard"> */
export async function fetchDashboard(): Promise<Response> {
  const signal = AbortSignal.timeout(5_000);
  return fetch("https://api.example.com/dashboard", { signal });
}
