import { NextResponse } from 'next/server';

import { adminDb } from '@/lib/firebase/admin';
import { apiError, requireApiUser } from '@/lib/firebase/apiAuth';
import {
  mirrorReferralRewardClaimSnapshot,
  tombstoneReferralRewardClaimCache,
} from '@/lib/sql/referralRewardClaimsCache';

type MirrorBody = {
  claimId?: unknown;
  claimIds?: unknown;
  referralRewardClaimId?: unknown;
  referralRewardClaimIds?: unknown;
  action?: unknown;
};

function cleanText(value: unknown) {
  return String(value || '').trim();
}

function readClaimIds(body: MirrorBody) {
  const ids = Array.isArray(body.claimIds)
    ? body.claimIds
    : Array.isArray(body.referralRewardClaimIds)
      ? body.referralRewardClaimIds
      : [body.claimId || body.referralRewardClaimId];
  return ids.map(cleanText).filter(Boolean).slice(0, 500);
}

export async function POST(request: Request) {
  const auth = await requireApiUser(request, ['admin', 'coadmin', 'staff', 'carer', 'player']);
  if ('response' in auth) return auth.response;

  const body = (await request.json().catch(() => ({}))) as MirrorBody;
  const action = cleanText(body.action) || 'upsert';
  const claimIds = readClaimIds(body);
  if (!claimIds.length) {
    return apiError('claimId is required.', 400);
  }

  if (action === 'tombstone') {
    await Promise.all(
      claimIds.map((claimId) =>
        tombstoneReferralRewardClaimCache(claimId, 'appbeg_browser_delete')
      )
    );
    return NextResponse.json({ success: true, mirrored: claimIds.length });
  }

  if (action !== 'upsert') {
    return apiError('Invalid mirror action.', 400);
  }

  const snaps = await Promise.all(
    claimIds.map((claimId) => adminDb.collection('referralRewardClaims').doc(claimId).get())
  );
  await Promise.all(
    snaps.map((snap) => mirrorReferralRewardClaimSnapshot(snap, 'appbeg_browser_write'))
  );

  return NextResponse.json({ success: true, mirrored: snaps.filter((snap) => snap.exists).length });
}
