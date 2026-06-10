import 'server-only';

import { cleanText, getPlayerMirrorPool } from '@/lib/sql/playerMirrorCommon';

export type CarerPaymentDetailsInput = {
  paymentQrUrl?: string | null;
  paymentQrPublicId?: string | null;
  paymentDetails?: string | null;
  cashappTag?: string | null;
  notes?: string | null;
};

export async function upsertCarerPaymentDetailsInSql(
  carerUid: string,
  coadminUid: string | null,
  input: CarerPaymentDetailsInput
) {
  const db = getPlayerMirrorPool();
  const cleanCarerUid = cleanText(carerUid);
  if (!db || !cleanCarerUid) {
    return false;
  }

  const paymentQrUrl = cleanText(input.paymentQrUrl);
  const paymentQrPublicId = cleanText(input.paymentQrPublicId);
  const paymentDetails =
    cleanText(input.paymentDetails) ||
    cleanText(input.notes) ||
    cleanText(input.cashappTag);
  const nowIso = new Date().toISOString();

  const patch = {
    paymentQrUrl: paymentQrUrl || null,
    paymentQrPublicId: paymentQrPublicId || null,
    paymentDetails: paymentDetails || null,
    updatedAt: nowIso,
  };

  try {
    await db.query(
      `
        UPDATE public.players_cache
        SET
          coadmin_uid = COALESCE(NULLIF($2, ''), coadmin_uid),
          updated_at = $3::timestamptz,
          raw_firestore_data = COALESCE(raw_firestore_data, '{}'::jsonb) || $4::jsonb,
          source = 'carer_payment_details_sql',
          mirrored_at = now()
        WHERE uid = $1
          AND deleted_at IS NULL
      `,
      [cleanCarerUid, cleanText(coadminUid), nowIso, JSON.stringify(patch)]
    );

    await db.query(
      `
        UPDATE public.user_balance_snapshots_cache
        SET
          updated_at = $2::timestamptz,
          mirrored_at = now(),
          raw_firestore_data = COALESCE(raw_firestore_data, '{}'::jsonb) || $3::jsonb,
          source = 'carer_payment_details_sql'
        WHERE firebase_id = $1
          AND deleted_at IS NULL
      `,
      [cleanCarerUid, nowIso, JSON.stringify(patch)]
    );

    return true;
  } catch (error) {
    console.error('[CARER_PAYMENT_DETAILS_SQL] upsert failed', {
      carerUid: cleanCarerUid,
      error,
    });
    return false;
  }
}
