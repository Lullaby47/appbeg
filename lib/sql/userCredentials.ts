import 'server-only';

import { cleanText, getPlayerMirrorPool, toIsoString } from '@/lib/sql/playerMirrorCommon';

export type UserCredentialRow = {
  uid: string;
  passwordHash: string;
  passwordAlgo: string;
  passwordUpdatedAt: string;
  migratedFromFirebase: boolean;
  mustReset: boolean;
  createdAt: string;
  updatedAt: string;
};

function mapUserCredentialRow(row: Record<string, unknown>): UserCredentialRow {
  return {
    uid: cleanText(row.uid),
    passwordHash: cleanText(row.password_hash),
    passwordAlgo: cleanText(row.password_algo),
    passwordUpdatedAt: toIsoString(row.password_updated_at) || new Date(0).toISOString(),
    migratedFromFirebase: row.migrated_from_firebase === true,
    mustReset: row.must_reset === true,
    createdAt: toIsoString(row.created_at) || new Date(0).toISOString(),
    updatedAt: toIsoString(row.updated_at) || new Date(0).toISOString(),
  };
}

export async function upsertUserCredentials(input: {
  uid: string;
  passwordHash: string;
  passwordAlgo: string;
  migratedFromFirebase?: boolean;
  mustReset?: boolean;
}) {
  const db = getPlayerMirrorPool();
  const uid = cleanText(input.uid);
  const passwordHash = cleanText(input.passwordHash);
  const passwordAlgo = cleanText(input.passwordAlgo);
  if (!db || !uid || !passwordHash || !passwordAlgo) {
    throw new Error('uid, passwordHash, and passwordAlgo are required.');
  }

  const now = new Date().toISOString();
  const migratedFromFirebase = input.migratedFromFirebase ?? true;
  const mustReset = input.mustReset ?? false;

  const result = await db.query(
    `
      INSERT INTO public.user_credentials (
        uid,
        password_hash,
        password_algo,
        password_updated_at,
        migrated_from_firebase,
        must_reset,
        created_at,
        updated_at
      )
      VALUES ($1, $2, $3, $4::timestamptz, $5, $6, $4::timestamptz, $4::timestamptz)
      ON CONFLICT (uid) DO UPDATE SET
        password_hash = EXCLUDED.password_hash,
        password_algo = EXCLUDED.password_algo,
        password_updated_at = EXCLUDED.password_updated_at,
        migrated_from_firebase = EXCLUDED.migrated_from_firebase,
        must_reset = EXCLUDED.must_reset,
        updated_at = EXCLUDED.updated_at
      RETURNING *
    `,
    [uid, passwordHash, passwordAlgo, now, migratedFromFirebase, mustReset]
  );

  return mapUserCredentialRow(result.rows[0] as Record<string, unknown>);
}

export async function lookupUserCredentials(uid: string) {
  const db = getPlayerMirrorPool();
  const cleanUid = cleanText(uid);
  if (!db || !cleanUid) {
    return null;
  }

  try {
    const result = await db.query(
      `
        SELECT *
        FROM public.user_credentials
        WHERE uid = $1
        LIMIT 1
      `,
      [cleanUid]
    );
    const row = result.rows[0] as Record<string, unknown> | undefined;
    if (!row) {
      return null;
    }
    return mapUserCredentialRow(row);
  } catch (error) {
    console.error('[USER_CREDENTIALS] lookup failed', { uid: cleanUid, error });
    return null;
  }
}
