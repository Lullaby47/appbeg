import { NextResponse } from 'next/server';

import { requireApiUser } from '@/lib/firebase/apiAuth';
import { getOrCreateCoadminPlayerSignupCode, rotateCoadminPlayerSignupCode } from '@/lib/sql/coadminPlayerSignupCodes';

export const runtime = 'nodejs';

export async function GET(request: Request) {
  const auth = await requireApiUser(request, ['coadmin']);
  if ('response' in auth) return auth.response;
  try {
    return NextResponse.json({ code: await getOrCreateCoadminPlayerSignupCode(auth.user.uid) });
  } catch (error) {
    console.error('[COADMIN_PLAYER_SIGNUP_CODE] load failed', {
      coadminUid: auth.user.uid,
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ error: 'Player signup code is temporarily unavailable. Please try again later.' }, { status: 503 });
  }
}

export async function POST(request: Request) {
  const auth = await requireApiUser(request, ['coadmin']);
  if ('response' in auth) return auth.response;
  try {
    return NextResponse.json({ code: await rotateCoadminPlayerSignupCode(auth.user.uid) });
  } catch (error) {
    console.error('[COADMIN_PLAYER_SIGNUP_CODE] rotation failed', {
      coadminUid: auth.user.uid,
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ error: 'Unable to generate a new player signup code. Please try again later.' }, { status: 503 });
  }
}
