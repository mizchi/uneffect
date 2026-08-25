interface RemoteAuditConnection {
  readonly endpoint: "audit";
}

/* uneffect: react acquire RemoteAuditConnection result */
declare function connectRemoteAudit(): RemoteAuditConnection;
/* uneffect: react release RemoteAuditConnection parameter 0 */
declare function disconnectRemoteAudit(connection: RemoteAuditConnection): void;

export function installRemoteAudit(): () => void {
  const connection = connectRemoteAudit();
  return () => disconnectRemoteAudit(connection);
}
