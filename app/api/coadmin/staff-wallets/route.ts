import { NextResponse } from 'next/server';

import { apiError, requireApiUser, scopedCoadminUid } from '@/lib/firebase/apiAuth';
import { listStaffWalletsForCoadminInSql } from '@/lib/sql/staffWalletAuthority';

export const runtime = 'nodejs';

export const dynamic = 'force-dynamic';

function cleanText(value: unknown) {
  return String(value || '').trim();
}

function statusForError(message: string) {
  if (/not authenticated|authorization|token/i.test(message)) return 401;
  if (/forbidden|outside your scope|not linked/i.test(message)) return 403;
  if (/postgres|database|unavailable/i.test(message)) return 503;
  return 409;
}

export async function GET(request: Request) {
  try {
    const auth = await requireApiUser(request, ['coadmin', 'admin']);
    if ('response' in auth) {
      return auth.response;
    }

    const requestedCoadminUid = cleanText(new URL(request.url).searchParams.get('coadminUid'));
    const scoped = scopedCoadminUid(auth.user);
    const coadminUid = auth.user.role === 'admin' ? requestedCoadminUid || null : scoped;

    if (auth.user.role !== 'admin' && !coadminUid) {
      return apiError('Your account is not linked to a coadmin scope.', 403);
    }

    const staff = await listStaffWalletsForCoadminInSql({
      coadminUid,
      isAdmin: auth.user.role === 'admin',
    });

    return NextResponse.json({
      ok: true,
      staff,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to list staff wallets.';
    return NextResponse.json({ error: message }, { status: statusForError(message) });
  }
}
