/**
 * Dev-only Firestore aggregates (`devUsageEstimates/{YYYY-MM-DD}`).
 * Allow authenticated `setDoc`+merge on that path in security rules, or writes will no-op.
 */
import { doc, increment, serverTimestamp, setDoc } from 'firebase/firestore';

import { db } from '@/lib/firebase/client';

const COLLECTION = 'devUsageEstimates';

/** Spark-style defaults; override with NEXT_PUBLIC_DEV_USAGE_QUOTA_READS / WRITES */
export const DEFAULT_DEV_READ_QUOTA = 50_000;
export const DEFAULT_DEV_WRITE_QUOTA = 20_000;

export type DevUsageDelta = {
  activePlayers?: number;
  activeCarers?: number;
  tasksCreated?: number;
  automationJobsCreated?: number;
  bonusEventsLoaded?: number;
  financialEventsCreated?: number;
  estReads?: number;
  estWrites?: number;
};

let pending: Record<string, number> = {};
/** Timer id (DOM `number`); avoid `ReturnType<typeof setTimeout>` conflicting with Node typings. */
let flushTimer: number | null = null;
const FLUSH_MS = 45_000;

export function isDevUsageEstimatesEnabled(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }
  return (
    process.env.NODE_ENV === 'development' ||
    process.env.NEXT_PUBLIC_ENABLE_DEV_USAGE_ESTIMATES === 'true'
  );
}

export function devUsageTodayDocId(): string {
  return new Date().toISOString().slice(0, 10);
}

function mergePending(delta: DevUsageDelta) {
  for (const [key, raw] of Object.entries(delta) as [keyof DevUsageDelta, number | undefined][]) {
    if (typeof raw === 'number' && raw > 0) {
      const k = key as string;
      pending[k] = (pending[k] || 0) + raw;
    }
  }
}

function scheduleFlush() {
  if (flushTimer !== null) {
    return;
  }
  flushTimer = window.setTimeout(() => {
    flushTimer = null;
    void flushDevUsageEstimatesNow();
  }, FLUSH_MS) as unknown as number;
}

/**
 * Batches counter increments and flushes periodically (and on tab hide) to avoid
 * one extra write per user action.
 */
export function recordDevUsageEstimate(delta: DevUsageDelta): void {
  if (!isDevUsageEstimatesEnabled()) {
    return;
  }
  mergePending(delta);
  scheduleFlush();
}

export async function flushDevUsageEstimatesNow(): Promise<void> {
  if (!isDevUsageEstimatesEnabled()) {
    return;
  }
  if (!Object.keys(pending).length) {
    return;
  }
  const copy = { ...pending };
  pending = {};
  const dateKey = devUsageTodayDocId();
  const ref = doc(db, COLLECTION, dateKey);
  const increments: Record<string, ReturnType<typeof increment>> = {};
  for (const [k, v] of Object.entries(copy)) {
    if (v > 0) {
      increments[k] = increment(v);
    }
  }
  try {
    await setDoc(
      ref,
      {
        dateKey,
        updatedAt: serverTimestamp(),
        ...increments,
      },
      { merge: true }
    );
  } catch {
    Object.assign(pending, copy);
  }
}

function sessionKey(suffix: string): string {
  return `devUsage:${suffix}:${devUsageTodayDocId()}`;
}

/** Once per tab per day per role+uid — does not add Firestore reads. */
export function recordDevActiveSession(role: 'player' | 'carer', uid: string): void {
  if (!isDevUsageEstimatesEnabled() || !uid.trim()) {
    return;
  }
  try {
    const key = sessionKey(`active:${role}:${uid}`);
    if (sessionStorage.getItem(key)) {
      return;
    }
    sessionStorage.setItem(key, '1');
  } catch {
    return;
  }
  if (role === 'player') {
    recordDevUsageEstimate({ activePlayers: 1, estReads: 1 });
  } else {
    recordDevUsageEstimate({ activeCarers: 1, estReads: 1 });
  }
}

/** Call once per listener subscription (first snapshot). */
export function recordBonusEventsListenerFirstSnapshot(docCount: number): void {
  if (!isDevUsageEstimatesEnabled()) {
    return;
  }
  const reads = 1 + Math.max(0, docCount);
  recordDevUsageEstimate({
    bonusEventsLoaded: Math.max(0, docCount),
    estReads: reads,
  });
}

if (typeof window !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      void flushDevUsageEstimatesNow();
    }
  });
}

export function readQuotaForUi(): number {
  const raw = process.env.NEXT_PUBLIC_DEV_USAGE_QUOTA_READS;
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_DEV_READ_QUOTA;
}

export function writeQuotaForUi(): number {
  const raw = process.env.NEXT_PUBLIC_DEV_USAGE_QUOTA_WRITES;
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_DEV_WRITE_QUOTA;
}

export type DevUsageEstimateDoc = {
  dateKey?: string;
  activePlayers?: number;
  activeCarers?: number;
  tasksCreated?: number;
  automationJobsCreated?: number;
  bonusEventsLoaded?: number;
  financialEventsCreated?: number;
  estReads?: number;
  estWrites?: number;
};

export function summarizeDevUsageForCard(data: DevUsageEstimateDoc | null): {
  reads: number;
  writes: number;
  quotaPercent: number;
  projectedMaxUsersPerDay: number | null;
  activeSessions: number;
} {
  const reads = Math.round(Number(data?.estReads || 0));
  const writes = Math.round(Number(data?.estWrites || 0));
  const activePlayers = Math.round(Number(data?.activePlayers || 0));
  const activeCarers = Math.round(Number(data?.activeCarers || 0));
  const activeSessions = activePlayers + activeCarers;
  const readQ = readQuotaForUi();
  const writeQ = writeQuotaForUi();
  const quotaPercent = Math.min(100, Math.max(0, Math.max(reads / readQ, writes / writeQ) * 100));

  const u = Math.max(1, activeSessions);
  const readsPer = reads / u;
  const writesPer = writes / u;
  let projected: number | null = null;
  if (reads >= 20 && writes >= 5) {
    const byReads = readsPer > 0 ? readQ / readsPer : Number.POSITIVE_INFINITY;
    const byWrites = writesPer > 0 ? writeQ / writesPer : Number.POSITIVE_INFINITY;
    projected = Math.floor(Math.min(byReads, byWrites));
    if (!Number.isFinite(projected) || projected < 1) {
      projected = null;
    } else if (projected > 99_999) {
      projected = 99_999;
    }
  }

  return { reads, writes, quotaPercent, projectedMaxUsersPerDay: projected, activeSessions };
}
