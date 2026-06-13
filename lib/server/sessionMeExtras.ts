import 'server-only';

import {
  cleanText,
  numberOrNull,
  runMirrorClientQuery,
  withPlayerMirrorClient,
} from '@/lib/sql/playerMirrorCommon';

export type SessionMePlayerExtras = {
  coin: number;
  cash: number;
  referralCode: string | null;
  referredByUid: string | null;
  referredByUsername: string | null;
  dismissedPaymentDetailsNoticeVersion: number;
  referralBonusNotice: string | null;
  referralBonusNoticeAt: string | null;
  coadminPaymentDetailsNoticeVersion: number;
};

function readRawField(raw: unknown, field: string) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }
  return (raw as Record<string, unknown>)[field];
}

export async function readSessionMePlayerExtras(input: {
  uid: string;
  coadminUid: string | null;
}): Promise<SessionMePlayerExtras | null> {
  const uid = cleanText(input.uid);
  if (!uid) {
    return null;
  }

  try {
    const { result } = await withPlayerMirrorClient(
      { route: '/api/auth/session/me', context: 'session_me_extras' },
      async (client, trackQuery) => {
        trackQuery();
        const { rows } = await runMirrorClientQuery<Record<string, unknown>>(
          client,
          `
            SELECT
              p.coin,
              p.cash,
              p.referral_code,
              p.referred_by_uid,
              p.raw_firestore_data,
              r.username AS referred_by_username
            FROM public.players_cache p
            LEFT JOIN public.players_cache r
              ON r.uid = p.referred_by_uid
             AND r.deleted_at IS NULL
             AND r.role = 'player'
             AND LOWER(COALESCE(r.status, '')) = 'active'
            WHERE p.uid = $1
              AND p.deleted_at IS NULL
            LIMIT 1
          `,
          [uid]
        );

        if (!rows.length) {
          return null;
        }

        const row = rows[0];
        const raw = row.raw_firestore_data;
        const coadminUid = cleanText(input.coadminUid);
        let coadminPaymentDetailsNoticeVersion = 0;

        if (coadminUid) {
          trackQuery();
          const coadminResult = await runMirrorClientQuery<Record<string, unknown>>(
            client,
            `
              SELECT raw_firestore_data
              FROM public.players_cache
              WHERE uid = $1
                AND deleted_at IS NULL
              LIMIT 1
            `,
            [coadminUid]
          );
          if (coadminResult.rows.length) {
            const coadminRaw = coadminResult.rows[0].raw_firestore_data;
            coadminPaymentDetailsNoticeVersion = Number(
              readRawField(coadminRaw, 'paymentDetailsNoticeVersion') || 0
            );
          }
        }

        return {
          coin: Number(row.coin ?? readRawField(raw, 'coin') ?? 0),
          cash: Number(row.cash ?? readRawField(raw, 'cash') ?? 0),
          referralCode:
            cleanText(row.referral_code) || cleanText(readRawField(raw, 'referralCode')) || null,
          referredByUid:
            cleanText(row.referred_by_uid) || cleanText(readRawField(raw, 'referredByUid')) || null,
          referredByUsername:
            cleanText(row.referred_by_username) ||
            cleanText(readRawField(raw, 'referredByUsername')) ||
            null,
          dismissedPaymentDetailsNoticeVersion: Number(
            readRawField(raw, 'dismissedPaymentDetailsNoticeVersion') || 0
          ),
          referralBonusNotice: cleanText(readRawField(raw, 'referralBonusNotice')) || null,
          referralBonusNoticeAt: cleanText(readRawField(raw, 'referralBonusNoticeAt')) || null,
          coadminPaymentDetailsNoticeVersion,
        };
      }
    );

    return result;
  } catch (error) {
    console.warn('[SESSION_ME_EXTRAS] read failed', {
      uid,
      error,
    });
    return null;
  }
}

export function numberFromSessionExtras(value: number | null | undefined) {
  return numberOrNull(value) ?? 0;
}
