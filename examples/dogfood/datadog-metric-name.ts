import { isDatadogMetricName } from "./datadog-validator.js";

/* uneffect:contract requires isDatadogMetricName(name) */
/* uneffect:contract ensures result === name */
export function datadogMetricKey(name: string): string {
  return name;
}
