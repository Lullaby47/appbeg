import { NextResponse } from 'next/server';

import { apiError, requireApiUser } from '@/lib/firebase/apiAuth';
import { cancelPlayerFriendLink } from '@/lib/sql/playerFriendLinks';
import { cleanText } from '@/lib/sql/playerMirrorCommon';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ROUTE = '/api/player/chat/friends/cancel';

export async function POST(request: Request) {
  try {
    const auth = await requireApiUser(request, ['player']);
    if ('response' in auth) {
      return auth.response;
    }

    const body = (await request.json().catch(() => ({}))) as { otherUid?: unknown };
    const otherUid = cleanText(body.otherUid);
    if (!otherUid) {
      return apiError('otherUid is required.', 400);
    }

    const result = await cancelPlayerFriendLink({
      actorUid: auth.user.uid,
      otherUid,
    });

    console.info('[PLAYER_CHAT_FRIEND_CANCEL_OK]', {
      route: ROUTE,
      uid: auth.user.uid,
      otherUid,
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
      error instanceof Error ? error.message : 'Failed to cancel friend request.';
    const status =
      /sender|yourself|required|invalid/i.test(message) ? 400 :
      /inactive|unavailable|not found/i.test(message) ? 404 :
      /forbidden|scope/i.test(message) ? 403 :
      500;
    console.error('[PLAYER_CHAT_FRIEND_CANCEL_ERROR]', message);
    return apiError(message, status);
  }
}
