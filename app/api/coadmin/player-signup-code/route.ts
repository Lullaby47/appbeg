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
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Unable to load player signup code.' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const auth = await requireApiUser(request, ['coadmin']);
  if ('response' in auth) return auth.response;
  try {
    return NextResponse.json({ code: await rotateCoadminPlayerSignupCode(auth.user.uid) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Unable to rotate player signup code.' }, { status: 500 });
  }
}
