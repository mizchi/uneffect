/* uneffect:temporal state telemetrySends: int */
/* uneffect:temporal init telemetrySends = 0 */
/* uneffect:temporal invariant sendsAtMostOnce: telemetrySends <= 1 */

/* uneffect:temporal-summary requires telemetrySends === 0 */ /* uneffect:temporal-summary ensures telemetrySends' = telemetrySends + 1 */ /* uneffect:temporal-summary modifies telemetrySends */
function sendTelemetry(): void {
  navigator.sendBeacon("https://telemetry.example/v1/events", "[]");
}

export function main(): void {
  queueMicrotask(sendTelemetry);
}
