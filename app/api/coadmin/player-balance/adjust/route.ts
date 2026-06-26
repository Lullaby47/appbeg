import { FieldValue } from 'firebase-admin/firestore';
import { NextResponse } from 'next/server';

import { adminDb } from '@/lib/firebase/admin';
import { apiError, requireApiUser, scopedCoadminUid } from '@/lib/firebase/apiAuth';
import {
  authoritySqlWriteEnvLogFields,
  isAuthoritySqlWriteEnabled,
  logAuthoritySqlWrite,
} from '@/lib/server/authoritySqlWrite';
import { adjustPlayerBalanceInSql } from '@/lib/sql/authorityBalanceAdjust';
import { mirrorFinancialEventById } from '@/lib/sql/financialEventsCache';
import { mirrorUserBalanceSnapshotById } from '@/lib/sql/userBalanceSnapshotsCache';

export const runtime = 'nodejs';

type Body = {
  playerUid?: unknown;
  delta?: unknown;
  balanceType?: unknown;
  idempotencyKey?: unknown;
};

export async function POST(request: Request) {
  const route = '/api/coadmin/player-balance/adjust';
  try {
    const auth = await requireApiUser(request, ['coadmin', 'admin']);
    if ('response' in auth) {
      const appSessionId = String(request.headers.get('X-App-Session-Id') || '').trim();
      const hasAuthorization = Boolean(String(request.headers.get('Authorization') || '').trim());
      console.warn('[PLAYER_BALANCE_ADJUST_AUTH_FAIL]', {
        route,
        reason: `auth_response_${auth.response.status}`,
        status: auth.response.status,
        authSource: appSessionId ? 'app_session_sql' : hasAuthorization ? 'bearer_token' : 'missing',
        uid: null,
        role: null,
        sqlUserCacheHit: false,
        hasAppSessionId: Boolean(appSessionId),
        appSessionIdPrefix: appSessionId ? appSessionId.slice(0, 8) : null,
        hasAuthorization,
        authPath: auth.timing.auth_path,
        sessionSource: auth.timing.session_source,
        tokenCacheHit: auth.timing.token_cache_hit,
        sqlProfileMs: auth.timing.sql_profile_ms,
        sqlSessionMs: auth.timing.sql_session_ms,
        userDocMs: auth.timing.user_doc_ms,
        sessionDocMs: auth.timing.session_doc_ms,
        authMs: auth.timing.auth_ms,
      });
      return auth.response;
    }
    console.info('[PLAYER_BALANCE_ADJUST_AUTH_OK]', {
      route,
      uid: auth.user.uid,
      role: auth.user.role,
      authSource: auth.authPath.startsWith('app_session') ? 'app_session_sql' : 'bearer_token',
      authPath: auth.authPath,
      sqlUserCacheHit: auth.authPath.includes('_sql') || auth.authPath.startsWith('app_session'),
    });
    const body = (await request.json()) as Body;
    const playerUid = String(body.playerUid || '').trim();
    const delta = Number(body.delta);
    const balanceType = String(body.balanceType || '').trim().toLowerCase();
    const idempotencyKey =
      String(body.idempotencyKey || request.headers.get('Idempotency-Key') || '').trim() || null;
    if (!playerUid) return apiError('playerUid is required.', 400);
    if (!Number.isFinite(delta) || delta === 0 || !Number.isInteger(delta)) {
      return apiError('Amount must be a non-zero whole number.', 400);
    }
    if (balanceType !== 'coin' && balanceType !== 'cash') {
      return apiError("balanceType must be 'coin' or 'cash'.", 400);
    }

    const scope = scopedCoadminUid(auth.user);
    const isAdmin = auth.user.role === 'admin';

    if (isAuthoritySqlWriteEnabled()) {
      const result = await adjustPlayerBalanceInSql({
        playerUid,
        delta,
        balanceType,
        actorUid: auth.user.uid,
        actorRole: auth.user.role,
        scopeUid: scope,
        isAdmin,
        idempotencyKey,
      });
      logAuthoritySqlWrite(route, {
        ...authoritySqlWriteEnvLogFields(),
        playerUid,
        balanceType,
        delta,
        duplicate: result.duplicate,
        eventId: result.eventId,
      });
      return NextResponse.json({
        success: true,
        duplicate: result.duplicate,
        authority: 'sql',
        before: result.before,
        after: result.after,
      });
    }

    const playerRef = adminDb.collection('users').doc(playerUid);
    const eventRef = adminDb.collection('financialEvents').doc();
    await adminDb.runTransaction(async (transaction) => {
      const playerSnap = await transaction.get(playerRef);
      if (!playerSnap.exists) throw new Error('Player not found.');
      const player = playerSnap.data() as {
        role?: string;
        coin?: number;
        cash?: number;
        coadminUid?: string | null;
        createdBy?: string | null;
      };
      if (String(player.role || '').toLowerCase() !== 'player') {
        throw new Error('This account is not a player.');
      }
      const playerScope =
        String(player.coadminUid || '').trim() || String(player.createdBy || '').trim();
      if (!isAdmin && playerScope !== scope) {
        throw new Error('Forbidden: this player is outside your scope.');
      }

      const current =
        balanceType === 'coin'
          ? Math.max(0, Math.floor(Number(player.coin || 0)))
          : Math.max(0, Math.floor(Number(player.cash || 0)));
      const next = current + delta;
      if (next < 0) {
        throw new Error(
          balanceType === 'coin'
            ? 'Not enough coin to deduct that amount.'
            : 'Not enough cash to deduct that amount.'
        );
      }

      transaction.update(playerRef, { [balanceType]: next });
      transaction.set(eventRef, {
        playerUid,
        coadminUid: playerScope,
        amountNpr: Math.abs(delta),
        type:
          balanceType === 'coin'
            ? delta > 0
              ? 'coadmin_coin_add'
              : 'coadmin_coin_deduct'
            : delta > 0
              ? 'coadmin_cash_add'
              : 'coadmin_cash_deduct',
        createdAt: FieldValue.serverTimestamp(),
      });
    });

    void mirrorFinancialEventById(eventRef.id, 'appbeg_player_balance_adjust');
    void mirrorUserBalanceSnapshotById(playerUid, 'appbeg_player_balance_adjust');
    return NextResponse.json({ success: true, authority: 'firestore' });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to adjust player balance.';
    if (/not authenticated|authorization|token/i.test(message)) {
      const appSessionId = String(request.headers.get('X-App-Session-Id') || '').trim();
      const hasAuthorization = Boolean(String(request.headers.get('Authorization') || '').trim());
      console.warn('[PLAYER_BALANCE_ADJUST_AUTH_FAIL]', {
        route,
        reason: message,
        authSource: appSessionId ? 'app_session_sql' : hasAuthorization ? 'bearer_token' : 'missing',
        uid: null,
        role: null,
        sqlUserCacheHit: false,
        hasAppSessionId: Boolean(appSessionId),
        appSessionIdPrefix: appSessionId ? appSessionId.slice(0, 8) : null,
        hasAuthorization,
      });
    }
    const status = /not authenticated|authorization|token/i.test(message)
      ? 401
      : /forbidden|scope/i.test(message)
        ? 403
        : /required|not found|not enough|whole|player/i.test(message)
          ? 400
          : 409;
    return NextResponse.json({ error: message }, { status });
  }
}
