/* uneffect:trust trust dispatch-sealing telemetry-runtime-v1 */
export class ImportedTelemetryRuntime {
  sent: number;
  attempted: number;

  constructor(sent = 0, attempted = 0) {
    this.sent = sent;
    this.attempted = attempted;
  }

  record(): void {
    this.attempted += 1;
    this.sent += 1;
  }
}
