import { NextResponse } from 'next/server';

import { adminDb } from '@/lib/firebase/admin';
import { apiError, requireApiUser } from '@/lib/firebase/apiAuth';
import { isCacheSqlAuthoritative, mirrorSqlSkipResponse } from '@/lib/server/cacheSqlRead';
import {

  mirrorRewardCutSnapshot,
  tombstoneRewardCutCache,
} from '@/lib/sql/rewardCutsCache';

export const runtime = 'nodejs';

type MirrorBody = {
  rewardCutId?: unknown;
  rewardCutIds?: unknown;
  action?: unknown;
};

function cleanText(value: unknown) {
  return String(value || '').trim();
}

function readRewardCutIds(body: MirrorBody) {
  const ids = Array.isArray(body.rewardCutIds) ? body.rewardCutIds : [body.rewardCutId];
  return ids.map(cleanText).filter(Boolean).slice(0, 500);
}

export async function POST(request: Request) {
  const auth = await requireApiUser(request, ['admin', 'coadmin', 'staff', 'carer']);
  if ('response' in auth) return auth.response;

  const body = (await request.json().catch(() => ({}))) as MirrorBody;
  const action = cleanText(body.action) || 'upsert';
  const rewardCutIds = readRewardCutIds(body);
  if (!rewardCutIds.length) {
    return apiError('rewardCutId is required.', 400);
  }

  if (action === 'tombstone') {
    await Promise.all(
      rewardCutIds.map((rewardCutId) =>
        tombstoneRewardCutCache(rewardCutId, 'appbeg_browser_delete')
      )
    );
    return NextResponse.json({ success: true, mirrored: rewardCutIds.length });
  }

  if (action !== 'upsert') {
    return apiError('Invalid mirror action.', 400);
  }

  if (isCacheSqlAuthoritative()) {
    return mirrorSqlSkipResponse('/api/reward-cuts/cache/mirror', 'rewardCuts', {
      count: rewardCutIds.length,
    });
  }

  const snaps = await Promise.all(
    rewardCutIds.map((rewardCutId) => adminDb.collection('rewardCuts').doc(rewardCutId).get())
  );
  await Promise.all(snaps.map((snap) => mirrorRewardCutSnapshot(snap, 'appbeg_browser_write')));

  return NextResponse.json({ success: true, mirrored: snaps.filter((snap) => snap.exists).length });
}
