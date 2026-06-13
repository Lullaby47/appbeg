import { NextResponse } from 'next/server';

import { apiError, requireApiUser } from '@/lib/firebase/apiAuth';
import { cleanText, getPlayerMirrorPool } from '@/lib/sql/playerMirrorCommon';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ROUTE = '/api/player/chat/friend-by-referral-code';

function canonicalCoadminUid(row: Record<string, unknown>) {
  return cleanText(row.coadmin_uid) || cleanText(row.created_by) || null;
}

async function tableExists(tableName: string) {
  const db = getPlayerMirrorPool();
  const cleanName = cleanText(tableName);
  if (!db || !cleanName) {
    return false;
  }
  const result = await db.query(
    `
      SELECT 1
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name = $1
      LIMIT 1
    `,
    [cleanName]
  );
  return result.rows.length > 0;
}

async function readPlayerByReferralCode(referralCode: string) {
  const db = getPlayerMirrorPool();
  const code = cleanText(referralCode).toUpperCase();
  if (!db) {
    throw new Error('Postgres is unavailable.');
  }
  if (!code) {
    return null;
  }

  const result = await db.query(
    `
      SELECT uid, username, role, status, coadmin_uid, created_by
      FROM public.players_cache
      WHERE deleted_at IS NULL
        AND role = 'player'
        AND LOWER(COALESCE(status, '')) = 'active'
        AND referral_code = $1
      LIMIT 1
    `,
    [code]
  );
  if (result.rows.length) {
    return result.rows[0] as Record<string, unknown>;
  }

  const indexResult = await db.query(
    `
      SELECT p.uid, p.username, p.role, p.status, p.coadmin_uid, p.created_by
      FROM public.referral_codes_cache r
      JOIN public.players_cache p
        ON p.uid = r.player_uid
       AND p.deleted_at IS NULL
       AND p.role = 'player'
       AND LOWER(COALESCE(p.status, '')) = 'active'
      WHERE r.code = $1
        AND r.deleted_at IS NULL
      LIMIT 1
    `,
    [code]
  );
  return (indexResult.rows[0] as Record<string, unknown> | undefined) || null;
}

async function readPlayerScope(uid: string) {
  const db = getPlayerMirrorPool();
  const cleanUid = cleanText(uid);
  if (!db || !cleanUid) {
    return null;
  }
  const result = await db.query(
    `
      SELECT uid, username, role, status, coadmin_uid, created_by
      FROM public.players_cache
      WHERE uid = $1
        AND deleted_at IS NULL
      LIMIT 1
    `,
    [cleanUid]
  );
  return (result.rows[0] as Record<string, unknown> | undefined) || null;
}

export async function POST(request: Request) {
  try {
    const auth = await requireApiUser(request, ['player']);
    if ('response' in auth) {
      return auth.response;
    }

    const body = (await request.json().catch(() => ({}))) as { referralCode?: unknown };
    const referralCode = cleanText(body.referralCode).toUpperCase();
    if (!referralCode) {
      return apiError('Referral code is required.', 400);
    }

    const [self, target] = await Promise.all([
      readPlayerScope(auth.user.uid),
      readPlayerByReferralCode(referralCode),
    ]);

    if (!self || cleanText(self.role).toLowerCase() !== 'player') {
      return apiError('Player session required.', 401);
    }
    if (cleanText(self.status).toLowerCase() !== 'active') {
      return apiError('Player is inactive.', 403);
    }
    if (!target) {
      return apiError('No active player found with this referral code.', 404);
    }

    const targetUid = cleanText(target.uid);
    if (!targetUid) {
      return apiError('No active player found with this referral code.', 404);
    }
    if (targetUid === auth.user.uid) {
      return apiError('You cannot add yourself.', 400);
    }

    const selfCoadminUid = canonicalCoadminUid(self);
    const targetCoadminUid = canonicalCoadminUid(target);
    if (!selfCoadminUid || !targetCoadminUid || selfCoadminUid !== targetCoadminUid) {
      return apiError('Forbidden: players must be in the same coadmin scope.', 403);
    }

    const hasFriendLinksTable =
      (await tableExists('player_friend_links_cache')) ||
      (await tableExists('player_friend_links'));
    if (!hasFriendLinksTable) {
      console.info('[PLAYER_CHAT_FRIEND_BY_REFERRAL_SCHEMA_MISSING]', {
        route: ROUTE,
        uid: auth.user.uid,
        targetUid,
      });
      return NextResponse.json(
        {
          error:
            'Friend requests are not available in SQL mode until a player friend-links table is migrated.',
          code: 'player_friend_links_sql_table_missing',
          target: {
            uid: targetUid,
            username: cleanText(target.username) || 'Player',
          },
        },
        { status: 501 }
      );
    }

    return NextResponse.json(
      {
        error:
          'Friend requests are not available in SQL mode until the friend-links SQL writer is implemented.',
        code: 'player_friend_links_sql_writer_missing',
        target: {
          uid: targetUid,
          username: cleanText(target.username) || 'Player',
        },
      },
      { status: 501 }
    );
  } catch (error) {
    console.error(
      '[PLAYER_CHAT_FRIEND_BY_REFERRAL_ERROR]',
      error instanceof Error ? error.stack ?? error.message : error
    );
    return apiError(
      error instanceof Error ? error.message : 'Failed to add friend by referral code.',
      500
    );
  }
}
