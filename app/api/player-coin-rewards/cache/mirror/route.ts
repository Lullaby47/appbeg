import { NextResponse } from 'next/server';

import { adminDb } from '@/lib/firebase/admin';
import { apiError, requireApiUser } from '@/lib/firebase/apiAuth';
import { isCacheSqlAuthoritative, mirrorSqlSkipResponse } from '@/lib/server/cacheSqlRead';
import {
  mirrorPlayerCoinRewardSnapshot,
  tombstonePlayerCoinRewardCache,
} from '@/lib/sql/playerCoinRewardsCache';

type MirrorBody = {
  rewardId?: unknown;
  rewardIds?: unknown;
  playerCoinRewardId?: unknown;
  playerCoinRewardIds?: unknown;
  action?: unknown;
};

function cleanText(value: unknown) {
  return String(value || '').trim();
}

function readRewardIds(body: MirrorBody) {
  const ids = Array.isArray(body.rewardIds)
    ? body.rewardIds
    : Array.isArray(body.playerCoinRewardIds)
      ? body.playerCoinRewardIds
      : [body.rewardId || body.playerCoinRewardId];
  return ids.map(cleanText).filter(Boolean).slice(0, 500);
}

export async function POST(request: Request) {
  const auth = await requireApiUser(request, ['admin', 'coadmin', 'staff', 'carer', 'player']);
  if ('response' in auth) return auth.response;

  const body = (await request.json().catch(() => ({}))) as MirrorBody;
  const action = cleanText(body.action) || 'upsert';
  const rewardIds = readRewardIds(body);
  if (!rewardIds.length) {
    return apiError('rewardId is required.', 400);
  }

  if (action === 'tombstone') {
    await Promise.all(
      rewardIds.map((rewardId) =>
        tombstonePlayerCoinRewardCache(rewardId, 'appbeg_browser_delete')
      )
    );
    return NextResponse.json({ success: true, mirrored: rewardIds.length });
  }

  if (action !== 'upsert') {
    return apiError('Invalid mirror action.', 400);
  }

  if (isCacheSqlAuthoritative()) {
    return mirrorSqlSkipResponse('/api/player-coin-rewards/cache/mirror', 'playerCoinRewards', {
      count: rewardIds.length,
    });
  }

  const snaps = await Promise.all(
    rewardIds.map((rewardId) => adminDb.collection('playerCoinRewards').doc(rewardId).get())
  );
  await Promise.all(
    snaps.map((snap) => mirrorPlayerCoinRewardSnapshot(snap, 'appbeg_browser_write'))
  );

  return NextResponse.json({ success: true, mirrored: snaps.filter((snap) => snap.exists).length });
}
