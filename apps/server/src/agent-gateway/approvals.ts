import type { ApprovalDecision, ApprovalRequestDetails } from './types.js';

export interface PendingApprovalHandle {
  approval: ApprovalRequestDetails;
  decision: Promise<ApprovalDecision>;
}

interface ApprovalEntry {
  approval: ApprovalRequestDetails;
  resolve: (decision: ApprovalDecision) => void;
  timer: NodeJS.Timeout;
  settled: boolean;
}

export class ApprovalManager {
  private readonly entries = new Map<string, ApprovalEntry>();

  constructor(
    private readonly timeoutMs: number | (() => number),
    private readonly onTimeout: (approval: ApprovalRequestDetails) => void,
  ) {}

  request(sessionId: string, tool: string, args: Record<string, unknown>, reason: string): PendingApprovalHandle {
    const timeout = typeof this.timeoutMs === 'function' ? this.timeoutMs() : this.timeoutMs;
    const approvalId = `apr_${sessionId}_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
    const approval: ApprovalRequestDetails = { approvalId, sessionId, tool, args, reason, expiresAt: Date.now() + timeout };
    let resolve!: (decision: ApprovalDecision) => void;
    const decision = new Promise<ApprovalDecision>((innerResolve) => { resolve = innerResolve; });
    const timer = setTimeout(() => {
      const entry = this.entries.get(approvalId);
      if (!entry || entry.settled) return;
      entry.settled = true;
      this.entries.delete(approvalId);
      resolve('timeout');
      this.onTimeout(approval);
    }, timeout);
    this.entries.set(approvalId, { approval, resolve, timer, settled: false });
    return { approval, decision };
  }

  respond(approvalId: string, decision: 'approved' | 'rejected'): boolean {
    const entry = this.entries.get(approvalId);
    if (!entry || entry.settled) return false;
    entry.settled = true;
    clearTimeout(entry.timer);
    this.entries.delete(approvalId);
    entry.resolve(decision);
    return true;
  }

  rejectSession(sessionId: string): void {
    for (const [approvalId, entry] of this.entries) {
      if (entry.approval.sessionId !== sessionId || entry.settled) continue;
      entry.settled = true;
      clearTimeout(entry.timer);
      this.entries.delete(approvalId);
      entry.resolve('rejected');
    }
  }

  close(): void {
    for (const [approvalId, entry] of this.entries) {
      entry.settled = true;
      clearTimeout(entry.timer);
      entry.resolve('rejected');
      this.entries.delete(approvalId);
    }
  }
}
