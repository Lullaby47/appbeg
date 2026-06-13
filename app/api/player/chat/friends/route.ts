import { NextResponse } from 'next/server';

import { apiError, requireApiUser } from '@/lib/firebase/apiAuth';
import {
  createPendingPlayerFriendLink,
  listPlayerFriendLinks,
} from '@/lib/sql/playerFriendLinks';
import { cleanText } from '@/lib/sql/playerMirrorCommon';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ROUTE = '/api/player/chat/friends';

export async function GET(request: Request) {
  try {
    const auth = await requireApiUser(request, ['player']);
    if ('response' in auth) {
      return auth.response;
    }

    const links = await listPlayerFriendLinks(auth.user.uid);
    return NextResponse.json({
      links,
      source: 'postgres',
      firestore_fallback: false,
    });
  } catch (error) {
    console.error(
      '[PLAYER_CHAT_FRIENDS_LIST_ERROR]',
      error instanceof Error ? error.stack ?? error.message : error
    );
    return apiError(
      error instanceof Error ? error.message : 'Failed to load friend links.',
      500
    );
  }
}

export async function POST(request: Request) {
  try {
    const auth = await requireApiUser(request, ['player']);
    if ('response' in auth) {
      return auth.response;
    }

    const body = (await request.json().catch(() => ({}))) as { targetUid?: unknown };
    const targetUid = cleanText(body.targetUid);
    if (!targetUid) {
      return apiError('targetUid is required.', 400);
    }

    const result = await createPendingPlayerFriendLink({
      actorUid: auth.user.uid,
      targetUid,
      source: 'manual',
    });

    console.info('[PLAYER_CHAT_FRIEND_CREATE_OK]', {
      route: ROUTE,
      uid: auth.user.uid,
      targetUid,
      status: result.link.status,
      duplicate: result.duplicate,
    });

    return NextResponse.json({
      link: result.link,
      target: result.target,
      duplicate: result.duplicate,
      source: 'postgres',
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to send friend request.';
    const status =
      /yourself|required/i.test(message) ? 400 :
      /inactive|unavailable|not found/i.test(message) ? 404 :
      /forbidden|scope/i.test(message) ? 403 :
      500;
    console.error('[PLAYER_CHAT_FRIEND_CREATE_ERROR]', message);
    return apiError(message, status);
  }
}
