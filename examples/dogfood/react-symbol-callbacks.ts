interface RemoteAuditConnection {
  readonly endpoint: "audit";
}

/* uneffect: react acquire RemoteAuditConnection result */
declare function connectRemoteAudit(notify?: () => void): RemoteAuditConnection;
/* uneffect: react release RemoteAuditConnection parameter 0 */
declare function disconnectRemoteAudit(connection: RemoteAuditConnection): void;
/* uneffect: effect RemoteAuditSnapshotRead */
declare function readRemoteAuditSnapshot(): number;

export function installRemoteAudit(): () => void {
  const connection = connectRemoteAudit();
  return () => disconnectRemoteAudit(connection);
}

export function subscribeRemoteAudit(notify: () => void): () => void {
  const connection = connectRemoteAudit(notify);
  return () => disconnectRemoteAudit(connection);
}

export function getRemoteAuditSnapshot(): number {
  return readRemoteAuditSnapshot();
}
