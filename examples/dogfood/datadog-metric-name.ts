import { isDatadogMetricName } from "./datadog-validator.js";

/* uneffect:requires isDatadogMetricName(name) */
/* uneffect:ensures result === name */
export function datadogMetricKey(name: string): string {
  return name;
}
