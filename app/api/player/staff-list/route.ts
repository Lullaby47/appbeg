import { NextResponse } from 'next/server';

import { requireApiUser, scopedCoadminUid } from '@/lib/firebase/apiAuth';
import { resolvePlayerStaffList } from '@/lib/server/playerStaffList';

export const runtime = 'nodejs';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const startedAt = Date.now();
  const auth = await requireApiUser(request, ['player']);
  if ('response' in auth) {
    return auth.response;
  }

  const coadminUid = scopedCoadminUid(auth.user);
  if (!coadminUid) {
    console.info('[PLAYER_STAFF_LIST]', {
      uid: auth.user.uid,
      coadminUid: '',
      count: 0,
      source: 'postgres',
      durationMs: Date.now() - startedAt,
    });
    return NextResponse.json({ staff: [], source: 'postgres' });
  }

  const { staff, source } = await resolvePlayerStaffList(coadminUid);
  console.info('[PLAYER_STAFF_LIST]', {
    uid: auth.user.uid,
    coadminUid,
    count: staff.length,
    source,
    durationMs: Date.now() - startedAt,
  });
  return NextResponse.json({ staff, source });
}
