import { datadogRum } from "@datadog/browser-rum";

/* uneffect:validate DatadogOnce */
export function reportCriticalFailure(enabled: boolean, message: string): void {
  if (enabled) datadogRum.addAction("critical_failure", { message });
}
