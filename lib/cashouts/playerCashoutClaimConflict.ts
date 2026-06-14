export const CASHOUT_CLAIM_CONFLICT_CODE = 'already_claimed_or_not_pending';

export type CashoutClaimConflictSnapshot = {
  taskId: string;
  status: string;
  claimedByUid: string | null;
  claimedAt: string | null;
};

export class CashoutClaimConflictError extends Error {
  readonly code = CASHOUT_CLAIM_CONFLICT_CODE;
  readonly snapshot: CashoutClaimConflictSnapshot;

  constructor(snapshot: CashoutClaimConflictSnapshot) {
    super(CASHOUT_CLAIM_CONFLICT_CODE);
    this.name = 'CashoutClaimConflictError';
    this.snapshot = snapshot;
  }

  static is(error: unknown): error is CashoutClaimConflictError {
    return error instanceof CashoutClaimConflictError;
  }
}

export function isCashoutClaimConflictResponse(payload: {
  error?: string;
  conflict?: boolean;
}): boolean {
  return (
    payload.conflict === true ||
    String(payload.error || '').trim() === CASHOUT_CLAIM_CONFLICT_CODE
  );
}

export function parseCashoutClaimConflictSnapshot(
  taskId: string,
  payload: {
    task?: Partial<CashoutClaimConflictSnapshot> | null;
  }
): CashoutClaimConflictSnapshot {
  const task = payload.task || {};
  return {
    taskId: String(task.taskId || taskId),
    status: String(task.status || 'unknown'),
    claimedByUid: task.claimedByUid ? String(task.claimedByUid) : null,
    claimedAt: task.claimedAt ? String(task.claimedAt) : null,
  };
}
