import { useEffect, useMemo, useState } from "react";

declare namespace JSX {
  interface IntrinsicElements {
    button: { onClick?: () => void; children?: unknown };
    output: { children?: unknown };
  }
}

interface TelemetryRow {
  service: string;
  failures: number;
}

interface TelemetrySubscription {
  readonly service: string;
}

/* uneffect: react acquire TelemetrySubscription result */
declare function subscribeToTelemetry(service: string): TelemetrySubscription;
/* uneffect: react release TelemetrySubscription parameter 0 */
declare function unsubscribeFromTelemetry(subscription: TelemetrySubscription): void;

/* uneffect: react hook */
function useTelemetrySubscription(service: string): void {
  useEffect(() => {
    const subscription = subscribeToTelemetry(service);
    return () => unsubscribeFromTelemetry(subscription);
  }, [service]);
}

/* uneffect: react component */
export function TelemetryDashboard(props: { service: string; rows: TelemetryRow[] }) {
  const [showFailures, setShowFailures] = useState(false);
  useTelemetrySubscription(props.service);
  const visibleRows = useMemo(
    () => showFailures ? props.rows.filter((row) => row.failures > 0) : props.rows,
    [props.rows, showFailures],
  );
  return <output>
    {visibleRows.length}
    <button onClick={() => {
      setShowFailures(!showFailures);
      fetch(`/telemetry/${props.service}/refresh`, { method: "POST" });
    }}>refresh</button>
  </output>;
}
