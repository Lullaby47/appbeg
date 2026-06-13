import { NextResponse } from 'next/server';

import { apiError, requireApiUser, scopedCoadminUid } from '@/lib/firebase/apiAuth';
import { readPlayerChatPeers } from '@/lib/sql/playerChatBootstrap';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ROUTE = '/api/player/chat/bootstrap';

export async function GET(request: Request) {
  const startedAt = Date.now();
  const auth = await requireApiUser(request, ['player']);
  if ('response' in auth) {
    return auth.response;
  }

  const coadminUid = scopedCoadminUid(auth.user);
  if (!coadminUid) {
    console.info('[PLAYER_CHAT_BOOTSTRAP]', {
      uid: auth.user.uid,
      coadminUid: null,
      count: 0,
      source: 'postgres',
      durationMs: Date.now() - startedAt,
    });
    return NextResponse.json({ players: [], source: 'postgres' });
  }

  const url = new URL(request.url);
  const search = String(url.searchParams.get('search') || '').trim();
  const limit = Math.max(1, Math.min(200, Number(url.searchParams.get('limit') || 100)));
  const players = await readPlayerChatPeers({
    selfUid: auth.user.uid,
    coadminUid,
    search,
    limit,
  });

  if (players === null) {
    return apiError('Player chat is unavailable right now.', 503);
  }

  console.info('[PLAYER_CHAT_BOOTSTRAP]', {
    route: ROUTE,
    uid: auth.user.uid,
    coadminUid,
    count: players.length,
    source: 'postgres',
    durationMs: Date.now() - startedAt,
  });

  return NextResponse.json({
    players,
    source: 'postgres',
    firestore_fallback: false,
  });
}
