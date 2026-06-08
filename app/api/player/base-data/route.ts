import { NextResponse } from 'next/server';

import { requireApiUser, scopedCoadminUid } from '@/lib/firebase/apiAuth';
import { loadPlayerBaseData } from '@/lib/server/playerBaseDataRead';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const startedAt = Date.now();
  const auth = await requireApiUser(request, ['player']);
  if ('response' in auth) {
    return auth.response;
  }

  const authMs = Date.now() - startedAt;
  const coadminUid = scopedCoadminUid(auth.user);
  const playerUid = auth.user.uid;

  if (!coadminUid) {
    const timing = {
      auth_ms: authMs,
      shared_client: false,
      parallel: true,
      client_acquire_ms: 0,
      staff_ms: 0,
      game_logins_ms: 0,
      freeplay_ms: 0,
      referral_rewards_ms: 0,
      total_sql_ms: 0,
      pool_waiting_max: 0,
      total_ms: Date.now() - startedAt,
    };
    console.info('[PLAYER_BASE_DATA]', {
      ...timing,
      counts: { staff: 0, gameLogins: 0, referralGroups: 0 },
      pendingGift: false,
      source: 'postgres',
    });
    return NextResponse.json({
      staff: [],
      gameLogins: [],
      pendingGift: { hasPendingGift: false, giftId: null, source: 'postgres' },
      referralRewards: { groups: [], source: 'postgres' },
      source: 'postgres',
      snapshotAt: new Date().toISOString(),
    });
  }

  const { payload, timing } = await loadPlayerBaseData({
    playerUid,
    coadminUid,
    authMs,
  });

  console.info('[PLAYER_BASE_DATA]', {
    auth_ms: timing.auth_ms,
    shared_client: timing.shared_client,
    parallel: timing.parallel,
    client_acquire_ms: timing.client_acquire_ms,
    staff_ms: timing.staff_ms,
    game_logins_ms: timing.game_logins_ms,
    freeplay_ms: timing.freeplay_ms,
    referral_rewards_ms: timing.referral_rewards_ms,
    total_sql_ms: timing.total_sql_ms,
    pool_waiting_max: timing.pool_waiting_max,
    total_ms: timing.total_ms,
    counts: {
      staff: payload.staff.length,
      gameLogins: payload.gameLogins.length,
      referralGroups: payload.referralRewards.groups.length,
    },
    pendingGift: payload.pendingGift.hasPendingGift,
    source: payload.source,
  });

  return NextResponse.json(payload);
}
