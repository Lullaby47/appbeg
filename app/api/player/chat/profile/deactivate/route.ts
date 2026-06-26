import { NextResponse } from 'next/server';

import { apiError, requireApiUser } from '@/lib/firebase/apiAuth';
import { deactivateMyPlayerChatProfileInSql } from '@/lib/sql/playerChatProfileAuthority';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function statusForProfileError(message: string) {
  if (/authorization|token|session|authenticated/i.test(message)) return 401;
  if (/only players|forbidden/i.test(message)) return 403;
  if (/required|profile not found|scope/i.test(message)) return 400;
  if (/Postgres|unavailable/i.test(message)) return 503;
  return 500;
}

export async function POST(request: Request) {
  try {
    const auth = await requireApiUser(request, ['player']);
    if ('response' in auth) {
      return auth.response;
    }

    const profile = await deactivateMyPlayerChatProfileInSql({ playerUid: auth.user.uid });
    return NextResponse.json({ ok: true, profile, source: 'postgres' });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to deactivate Player Chat profile.';
    return apiError(message, statusForProfileError(message));
  }
}
