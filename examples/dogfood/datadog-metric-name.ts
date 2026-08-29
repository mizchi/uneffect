/** Application-owned validator. Uneffect does not add this check to production. */
export function isDatadogMetricName(value: string): boolean {
  return /^[a-z][a-z0-9_.]{0,31}$/.test(value);
}

/* uneffect: requires isDatadogMetricName(name) */
/* uneffect: ensures result === name */
export function datadogMetricKey(name: string): string {
  return name;
}
