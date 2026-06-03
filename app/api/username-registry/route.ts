import { NextResponse } from 'next/server';

import { requireApiUser } from '@/lib/firebase/apiAuth';
import { GAME_USERNAME_RULE_MESSAGE, isValidGameUsername } from '@/lib/games/gameUsernameRule';
import {
  deleteUsername,
  insertUsername,
  recordGameUsername,
  usernameExists,
} from '@/lib/sql/usernameRegistry';

type RegistryAction = 'check' | 'record_after_firebase' | 'insert_after_firebase' | 'delete_after_firebase';

export async function POST(request: Request) {
  const auth = await requireApiUser(request, ['admin', 'coadmin', 'staff', 'carer']);
  if ('response' in auth) return auth.response;

  const body = (await request.json()) as {
    action?: unknown;
    username?: unknown;
    game?: unknown;
    playerUid?: unknown;
    coadminUid?: unknown;
    source?: unknown;
  };
  const action = String(body.action || '') as RegistryAction;
  const username = String(body.username || '').trim();
  if (!username) {
    return NextResponse.json({ error: 'Username is required.' }, { status: 400 });
  }
  if (!isValidGameUsername(username)) {
    return NextResponse.json({ error: GAME_USERNAME_RULE_MESSAGE }, { status: 400 });
  }

  try {
    if (action === 'check') {
      const exists = await usernameExists(username);
      return NextResponse.json({ exists, available: !exists });
    }
    if (action === 'record_after_firebase') {
      await recordGameUsername({
        username,
        game: String(body.game || '').trim(),
        playerUid: String(body.playerUid || '').trim() || null,
        coadminUid: String(body.coadminUid || '').trim() || null,
        source: String(body.source || '').trim() || 'appbeg_api',
      });
      return NextResponse.json({ success: true, recorded: true });
    }
    if (action === 'insert_after_firebase') {
      await insertUsername(username);
      return NextResponse.json({ success: true });
    }
    if (action === 'delete_after_firebase') {
      await deleteUsername(username);
      return NextResponse.json({ success: true });
    }
    return NextResponse.json({ error: 'Invalid registry action.' }, { status: 400 });
  } catch (error) {
    if (action === 'record_after_firebase' || action === 'insert_after_firebase') {
      console.warn('[USERNAME_REGISTRY] VPS API record failed after Firebase save', {
        username,
        game: String(body.game || '').trim(),
        playerUid: String(body.playerUid || '').trim() || null,
        coadminUid: String(body.coadminUid || '').trim() || null,
        source: String(body.source || '').trim() || null,
        error,
      });
      return NextResponse.json({
        success: true,
        recorded: false,
        warning: 'Firebase save succeeded, but VPS username registry recording failed.',
      });
    }
    if (action === 'delete_after_firebase') {
      console.warn(`[USERNAME_REGISTRY] registry delete unavailable after Firebase delete username=${username}`);
      return NextResponse.json({ success: true, recorded: false });
    }
    return NextResponse.json({ error: 'Username registry SQL is unavailable.' }, { status: 503 });
  }
}
