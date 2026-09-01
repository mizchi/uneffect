/* uneffect:state telemetrySends: int */
/* uneffect:init telemetrySends = 0 */
/* uneffect:always sendsAtMostOnce: telemetrySends <= 1 */

/* uneffect:temporal_contract requires telemetrySends === 0 */ /* uneffect:temporal_contract ensures telemetrySends' = telemetrySends + 1 */ /* uneffect:temporal_contract modifies telemetrySends */
function sendTelemetry(): void {
  navigator.sendBeacon("https://telemetry.example/v1/events", "[]");
}

export function main(): void {
  queueMicrotask(sendTelemetry);
}
