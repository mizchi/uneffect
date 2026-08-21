/* uneffect: state telemetrySends: int */
/* uneffect: init telemetrySends = 0 */
/* uneffect: temporal sendsAtMostOnce: telemetrySends <= 1 */

/*
 * uneffect:
 * temporal_requires telemetrySends === 0
 * temporal_ensures telemetrySends' = telemetrySends + 1
 * temporal_modifies telemetrySends
 */
function sendTelemetry(): void {
  navigator.sendBeacon("https://telemetry.example/v1/events", "[]");
}

export function main(): void {
  queueMicrotask(sendTelemetry);
}
