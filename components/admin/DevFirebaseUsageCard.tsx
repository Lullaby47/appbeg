'use client';

import { useEffect, useState } from 'react';
import { doc, onSnapshot } from 'firebase/firestore';
import { onAuthStateChanged } from 'firebase/auth';

import { auth, db } from '@/lib/firebase/client';
import {
  devUsageTodayDocId,
  isDevUsageEstimatesEnabled,
  summarizeDevUsageForCard,
  readQuotaForUi,
  writeQuotaForUi,
  type DevUsageEstimateDoc,
} from '@/features/dev/devUsageEstimates';

export default function DevFirebaseUsageCard() {
  const [data, setData] = useState<DevUsageEstimateDoc | null>(null);

  useEffect(() => {
    if (!isDevUsageEstimatesEnabled()) {
      return;
    }
    let snapUnsub: (() => void) | null = null;
    const authUnsub = onAuthStateChanged(auth, (user) => {
      snapUnsub?.();
      snapUnsub = null;
      if (!user) {
        setData(null);
        return;
      }
      const ref = doc(db, 'devUsageEstimates', devUsageTodayDocId());
      snapUnsub = onSnapshot(
        ref,
        (snap) => {
          setData(snap.exists() ? (snap.data() as DevUsageEstimateDoc) : null);
        },
        () => {
          setData(null);
        }
      );
    });
    return () => {
      snapUnsub?.();
      authUnsub();
    };
  }, []);

  if (!isDevUsageEstimatesEnabled()) {
    return null;
  }

  const summary = summarizeDevUsageForCard(data);
  const readQ = readQuotaForUi();
  const writeQ = writeQuotaForUi();
  const projected =
    summary.projectedMaxUsersPerDay === null
      ? '—'
      : String(summary.projectedMaxUsersPerDay);

  return (
    <div className="rounded-2xl border border-amber-500/30 bg-amber-950/25 p-6">
      <p className="text-xs font-bold uppercase tracking-wider text-amber-200/90">
        Dev · Firebase usage (estimated)
      </p>
      <p className="mt-2 text-xs text-amber-100/60">
        Counters from app actions only; not exact billing. Quotas default to {readQ.toLocaleString()} reads /
        {writeQ.toLocaleString()} writes/day (override via env).
      </p>
      <div className="mt-4 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
        <div>
          <p className="text-neutral-400">Reads (est.)</p>
          <p className="text-xl font-bold text-white">{summary.reads.toLocaleString()}</p>
        </div>
        <div>
          <p className="text-neutral-400">Writes (est.)</p>
          <p className="text-xl font-bold text-white">{summary.writes.toLocaleString()}</p>
        </div>
        <div>
          <p className="text-neutral-400">Free quota used</p>
          <p className="text-xl font-bold text-white">{summary.quotaPercent.toFixed(1)}%</p>
        </div>
        <div>
          <p className="text-neutral-400">Proj. max active users/day</p>
          <p className="text-xl font-bold text-white">{projected}</p>
        </div>
      </div>
      <p className="mt-3 text-xs text-neutral-500">
        Today (UTC): {devUsageTodayDocId()} · Active player/carer sessions (est.):{' '}
        {summary.activeSessions}
        {data?.tasksCreated != null && data.tasksCreated > 0
          ? ` · Tasks created: ${Number(data.tasksCreated).toLocaleString()}`
          : ''}
        {data?.automationJobsCreated != null && data.automationJobsCreated > 0
          ? ` · Automation jobs: ${Number(data.automationJobsCreated).toLocaleString()}`
          : ''}
        {data?.financialEventsCreated != null && data.financialEventsCreated > 0
          ? ` · Financial events: ${Number(data.financialEventsCreated).toLocaleString()}`
          : ''}
        {data?.bonusEventsLoaded != null && data.bonusEventsLoaded > 0
          ? ` · Bonus event docs (listener est.): ${Number(data.bonusEventsLoaded).toLocaleString()}`
          : ''}
      </p>
    </div>
  );
}
