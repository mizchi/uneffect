/* uneffect:trust trust dispatch-sealing application owns the complete class graph */
/* uneffect:trust trust_owner telemetry-platform */
/* uneffect:trust trust_expires 2027-08-31 */
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
