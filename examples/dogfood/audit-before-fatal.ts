declare function sendAuditEvent(message: string): Promise<void>;
const MUST_ABORT_INVALID_REQUEST = true as const;

/* uneffect:capability effect Throw<Error> */
function fatal(message: string): never {
  throw new Error(message);
}

export async function auditInvalidRequest(message: string): Promise<void> {
  let delivery: Promise<void>;
  try {
    delivery = sendAuditEvent(message);
    return MUST_ABORT_INVALID_REQUEST && fatal(`invalid request: ${message}`);
  } catch {
    await delivery;
  }
}
