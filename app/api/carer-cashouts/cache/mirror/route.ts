import { NextResponse } from 'next/server';

import { adminDb } from '@/lib/firebase/admin';
import { apiError, requireApiUser } from '@/lib/firebase/apiAuth';
import {
  mirrorCarerCashoutSnapshot,
  tombstoneCarerCashoutCache,
} from '@/lib/sql/carerCashoutsCache';

type MirrorBody = {
  cashoutId?: unknown;
  cashoutIds?: unknown;
  carerCashoutId?: unknown;
  carerCashoutIds?: unknown;
  action?: unknown;
};

function cleanText(value: unknown) {
  return String(value || '').trim();
}

function readCashoutIds(body: MirrorBody) {
  const ids = Array.isArray(body.carerCashoutIds)
    ? body.carerCashoutIds
    : Array.isArray(body.cashoutIds)
      ? body.cashoutIds
      : [body.carerCashoutId || body.cashoutId];
  return ids.map(cleanText).filter(Boolean).slice(0, 500);
}

export async function POST(request: Request) {
  const auth = await requireApiUser(request, ['admin', 'coadmin', 'staff', 'carer']);
  if ('response' in auth) return auth.response;

  const body = (await request.json().catch(() => ({}))) as MirrorBody;
  const action = cleanText(body.action) || 'upsert';
  const cashoutIds = readCashoutIds(body);
  if (!cashoutIds.length) {
    return apiError('cashoutId is required.', 400);
  }

  if (action === 'tombstone') {
    await Promise.all(
      cashoutIds.map((cashoutId) =>
        tombstoneCarerCashoutCache(cashoutId, 'appbeg_browser_delete')
      )
    );
    return NextResponse.json({ success: true, mirrored: cashoutIds.length });
  }

  if (action !== 'upsert') {
    return apiError('Invalid mirror action.', 400);
  }

  const snaps = await Promise.all(
    cashoutIds.map((cashoutId) => adminDb.collection('carerCashouts').doc(cashoutId).get())
  );
  await Promise.all(
    snaps.map((snap) => mirrorCarerCashoutSnapshot(snap, 'appbeg_browser_write'))
  );

  return NextResponse.json({ success: true, mirrored: snaps.filter((snap) => snap.exists).length });
}
