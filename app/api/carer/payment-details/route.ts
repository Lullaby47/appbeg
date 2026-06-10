import { NextResponse } from 'next/server';

import { apiError, requireCarerApiUser, scopedCoadminUid } from '@/lib/firebase/apiAuth';
import { upsertCarerPaymentDetailsInSql } from '@/lib/sql/carerPaymentDetails';
import { cleanText } from '@/lib/sql/playerMirrorCommon';

const ROUTE = '/api/carer/payment-details';

export async function POST(request: Request) {
  const auth = await requireCarerApiUser(request);
  if ('response' in auth) {
    return auth.response;
  }

  const body = (await request.json().catch(() => ({}))) as {
    paymentQrUrl?: unknown;
    paymentQrPublicId?: unknown;
    paymentDetails?: unknown;
    cashappTag?: unknown;
    notes?: unknown;
  };

  const paymentQrUrl = cleanText(body.paymentQrUrl);
  const paymentQrPublicId = cleanText(body.paymentQrPublicId);
  const paymentDetails =
    cleanText(body.paymentDetails) ||
    cleanText(body.notes) ||
    cleanText(body.cashappTag);
  const coadminUid = scopedCoadminUid(auth.user);

  const ok = await upsertCarerPaymentDetailsInSql(auth.user.uid, coadminUid, {
    paymentQrUrl,
    paymentQrPublicId,
    paymentDetails,
    cashappTag: cleanText(body.cashappTag),
    notes: cleanText(body.notes),
  });

  if (!ok) {
    return apiError('Failed to save payment details.', 500);
  }

  console.info('[CARER_PAYMENT_DETAILS_SQL_WRITE]', {
    route: ROUTE,
    carerUid: auth.user.uid,
    coadminUid,
    hasQrUrl: Boolean(paymentQrUrl),
    source: 'sql',
    firestoreAttempted: false,
    ok: true,
  });

  return NextResponse.json({
    ok: true,
    paymentQrUrl,
    paymentQrPublicId,
    paymentDetails,
    source: 'sql',
    firestoreAttempted: false,
  });
}
