import { NextResponse } from 'next/server';

import { apiError, requireApiUser, scopedCoadminUid } from '@/lib/firebase/apiAuth';
import { getStaffWalletForStaffInSql } from '@/lib/sql/staffWalletAuthority';

export const runtime = 'nodejs';

export const dynamic = 'force-dynamic';

function statusForError(message: string) {
  if (/not authenticated|authorization|token/i.test(message)) return 401;
  if (/forbidden|outside your scope|not linked/i.test(message)) return 403;
  if (/postgres|database|unavailable/i.test(message)) return 503;
  if (/required|not found|not a staff|staff/i.test(message)) return 400;
  return 409;
}

export async function GET(request: Request) {
  try {
    const auth = await requireApiUser(request, ['staff']);
    if ('response' in auth) {
      return auth.response;
    }

    const coadminUid = scopedCoadminUid(auth.user);
    if (!coadminUid) {
      return apiError('Your account is not linked to a coadmin scope.', 403);
    }

    const wallet = await getStaffWalletForStaffInSql({
      staffUid: auth.user.uid,
      scopeUid: coadminUid,
    });

    return NextResponse.json({
      ok: true,
      staffUid: wallet.staffUid,
      coadminUid: wallet.coadminUid,
      balanceCoin: wallet.balanceCoin,
      totalAllocatedCoin: wallet.totalAllocatedCoin,
      totalLoadedCoin: wallet.totalLoadedCoin,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to load staff wallet.';
    return NextResponse.json({ error: message }, { status: statusForError(message) });
  }
}
