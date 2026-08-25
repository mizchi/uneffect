import { memo, startTransition, useActionState, useEffect, useEffectEvent, useImperativeHandle, useInsertionEffect, useMemo, useOptimistic, useState, useSyncExternalStore } from "react";

declare namespace JSX {
  interface IntrinsicElements {
    button: { onClick?: () => void; children?: unknown };
    form: { action?: unknown; children?: unknown };
    output: { children?: unknown; ref?: unknown };
  }
}

interface TelemetryRow {
  service: string;
  failures: number;
}

interface TelemetrySubscription {
  readonly service: string;
}

interface TelemetryViewport {
  readonly node: Element | null;
}

interface TelemetryStatusSubscription {
  readonly service: string;
}

export interface TelemetryDashboardHandle {
  refresh(): void;
}

/* uneffect: react acquire TelemetrySubscription result */
declare function subscribeToTelemetry(service: string): TelemetrySubscription;
/* uneffect: react release TelemetrySubscription parameter 0 */
declare function unsubscribeFromTelemetry(subscription: TelemetrySubscription): void;
/* uneffect: react acquire TelemetryViewport result */
declare function attachTelemetryViewport(node: Element | null): TelemetryViewport;
/* uneffect: react release TelemetryViewport parameter 0 */
declare function detachTelemetryViewport(viewport: TelemetryViewport): void;
/* uneffect: react acquire TelemetryStatusSubscription result */
declare function openTelemetryStatus(notify: () => void): TelemetryStatusSubscription;
/* uneffect: react release TelemetryStatusSubscription parameter 0 */
declare function closeTelemetryStatus(subscription: TelemetryStatusSubscription): void;
/* uneffect: effect TelemetryStatusRead */
declare function readTelemetryStatus(): boolean;
/* uneffect: effect StyleWrite */
declare function insertTelemetryStyles(): void;
/* uneffect: effect StyleWrite */
declare function removeTelemetryStyles(): void;
/* uneffect: effect TelemetryFilterSave */
declare function saveTelemetryFilter(service: string): Promise<void>;

/* uneffect: react hook */
function useTelemetryStyles(): void {
  useInsertionEffect(() => {
    insertTelemetryStyles();
    return () => removeTelemetryStyles();
  }, []);
}

function subscribeToTelemetryStatus(notify: () => void): () => void {
  const subscription = openTelemetryStatus(notify);
  return () => closeTelemetryStatus(subscription);
}

function getTelemetryStatusSnapshot(): boolean {
  return readTelemetryStatus();
}

/* uneffect: react hook */
function useTelemetryOnlineStatus(): boolean {
  return useSyncExternalStore(subscribeToTelemetryStatus, getTelemetryStatusSnapshot);
}

/* uneffect: react hook */
function useTelemetrySubscription(service: string): void {
  const reportConnected = useEffectEvent(() => console.log("telemetry connected", service));
  useEffect(() => {
    reportConnected();
    const subscription = subscribeToTelemetry(service);
    return () => unsubscribeFromTelemetry(subscription);
  }, [service]);
}

/* uneffect: react component */
export const TelemetryDashboard = memo(function TelemetryDashboard(props: { service: string; rows: TelemetryRow[]; handleRef: unknown }) {
  const [showFailures, setShowFailures] = useState(false);
  const online = useTelemetryOnlineStatus();
  const [savedService, saveService, saving] = useActionState(async (previous: string) => {
    await saveTelemetryFilter(props.service);
    return previous === props.service ? previous : props.service;
  }, props.service);
  const [optimisticService] = useOptimistic(savedService, (_previous, next: string) => next);
  useTelemetryStyles();
  useTelemetrySubscription(props.service);
  useImperativeHandle(props.handleRef, () => ({
    refresh() {
      fetch(`/telemetry/${props.service}/refresh`, { method: "POST" });
    },
  }), [props.service]);
  const visibleRows = useMemo(
    () => showFailures ? props.rows.filter((row) => row.failures > 0) : props.rows,
    [props.rows, showFailures],
  );
  const requestRefresh = () => {
    fetch(`/telemetry/${props.service}/refresh`, { method: "POST" });
  };
  const refresh = () => {
    setShowFailures(!showFailures);
    startTransition(requestRefresh);
  };
  const attachViewport = (node: Element | null) => {
    const viewport = attachTelemetryViewport(node);
    return () => detachTelemetryViewport(viewport);
  };
  const viewportRef = attachViewport;
  return <form action={saveService}><output ref={viewportRef}>
    {online ? visibleRows.length : 0}{optimisticService}{saving}
    <button onClick={refresh}>refresh</button>
  </output></form>;
});
