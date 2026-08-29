/*
 * This fixture proves only the host application's fixed loading boundary.
 * It does not prove the downloaded script's implementation safe.
 */
/* uneffect: effect Dom<Create, typeof document> | Dom<PropertyWrite, typeof script> | Dom<NodeWrite, typeof document.head> | Mutate<typeof document.head> | InvokeUserCode | ScriptLoad<Classic, "https://cdn.example.com/analytics.js"> | ExecuteExternalCode<"https://cdn.example.com/analytics.js", "sha384-YWJj"> | Net<"cdn.example.com:443"> */
export function loadAnalyticsScript(): void {
  const script = document.createElement("script");
  script.src = "https://cdn.example.com/analytics.js";
  script.integrity = "sha384-YWJj";
  script.crossOrigin = "anonymous";
  document.head.appendChild(script);
}
