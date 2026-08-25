import { useEffect, useLayoutEffect, useSyncExternalStore } from "react";
import { getRemoteAuditSnapshot, installRemoteAudit, subscribeRemoteAudit } from "./react-symbol-callbacks.js";

interface RemoteViewport {
  readonly node: Element | null;
}

/* uneffect: react acquire RemoteViewport result */
declare function attachRemoteViewport(node: Element | null): RemoteViewport;
/* uneffect: react release RemoteViewport parameter 0 */
declare function detachRemoteViewport(viewport: RemoteViewport): void;

export function refreshRemoteTelemetry(): void {
  fetch("/telemetry/remote/refresh");
}

export function attachRemoteTelemetry(node: Element | null): () => void {
  const viewport = attachRemoteViewport(node);
  return () => detachRemoteViewport(viewport);
}

/* uneffect: react hook */
export function useDocumentTitle(title: string): void {
  useLayoutEffect(() => {
    document.title = title;
  }, [title]);
}

/* uneffect: react hook */
export default function useRefreshAudit(endpoint: string): void {
  useEffect(installRemoteAudit, []);
  useSyncExternalStore(subscribeRemoteAudit, getRemoteAuditSnapshot);
  useEffect(() => {
    console.log("refresh audit", endpoint);
  }, [endpoint]);
}
