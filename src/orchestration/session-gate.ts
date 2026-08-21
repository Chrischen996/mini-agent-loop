import { randomUUID } from "node:crypto";

export type SessionExecutionLease = Readonly<{
  sessionId: string;
  owner: string;
  token: string;
}>;

/** Serializes foreground and background execution that mutates one session. */
export class SessionExecutionGate {
  private readonly leases = new Map<string, SessionExecutionLease>();

  tryAcquire(sessionId: string, owner: string): SessionExecutionLease | undefined {
    if (this.leases.has(sessionId)) return undefined;
    const lease: SessionExecutionLease = {
      sessionId,
      owner,
      token: randomUUID(),
    };
    this.leases.set(sessionId, lease);
    return lease;
  }

  isBusy(sessionId: string): boolean {
    return this.leases.has(sessionId);
  }

  release(lease: SessionExecutionLease): boolean {
    if (this.leases.get(lease.sessionId) !== lease) return false;
    this.leases.delete(lease.sessionId);
    return true;
  }
}
