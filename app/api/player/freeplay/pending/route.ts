import { NextResponse } from 'next/server';

import { adminDb } from '@/lib/firebase/admin';
import { requireApiUser } from '@/lib/firebase/apiAuth';

export async function GET(request: Request) {
  try {
    const auth = await requireApiUser(request, ['player']);
    if ('response' in auth) return auth.response;

    const markerSnap = await adminDb
      .collection('freeplayPendingGifts')
      .doc(auth.user.uid)
      .get();
    const marker = markerSnap.data() as
      | { type?: string; status?: string; giftId?: string }
      | undefined;
    const hasPendingGift =
      markerSnap.exists &&
      String(marker?.type || '').toLowerCase() === 'freeplay' &&
      String(marker?.status || '').toLowerCase() === 'pending';

    return NextResponse.json({
      success: true,
      hasPendingGift,
      giftId: hasPendingGift ? String(marker?.giftId || '').trim() : null,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to load FreePlay gift.';
    return NextResponse.json(
      { error: message },
      { status: /authorization|token|logged out/i.test(message) ? 401 : 400 }
    );
  }
}
