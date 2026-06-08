import 'server-only';

import { randomUUID } from 'crypto';

import type { DocumentSnapshot } from 'firebase-admin/firestore';

import { adminDb } from '@/lib/firebase/admin';
import {
  cleanText,
  getPlayerMirrorPool,
  normalizeJson,
  toIsoString,
} from '@/lib/sql/playerMirrorCommon';

export type CarerCreationRequestStatus = 'pending' | 'approved' | 'rejected';

export type CarerCreationRequestRecord = {
  id: string;
  coadminUid: string;
  coadminUsername: string;
  requestedUsername: string;
  status: CarerCreationRequestStatus;
  requestedAt?: string | null;
  reviewedAt?: string | null;
  reviewedByUid?: string | null;
  reviewedByUsername?: string | null;
  createdCarerUid?: string | null;
  note?: string | null;
};

export type CreateCarerCreationRequestSqlInput = {
  requestId?: string;
  coadminUid: string;
  coadminUsername: string;
  username: string;
  source?: string;
  rawData?: Record<string, unknown>;
};

export type UpdateCarerCreationRequestStatusSqlInput = {
  requestId: string;
  status: Exclude<CarerCreationRequestStatus, 'pending'>;
  reviewedByUid: string;
  reviewedByUsername: string;
  createdCarerUid?: string | null;
  rejectionReason?: string | null;
};

function mapRowToRecord(row: Record<string, unknown>): CarerCreationRequestRecord | null {
  const requestId = cleanText(row.request_id);
  if (!requestId) {
    return null;
  }

  const raw = parseRaw(row.raw_firestore_data);
  const status = (cleanText(row.status) || 'pending') as CarerCreationRequestStatus;

  return {
    id: requestId,
    coadminUid: cleanText(row.coadmin_uid) || cleanText(raw.coadminUid),
    coadminUsername:
      cleanText(row.coadmin_username) || cleanText(raw.coadminUsername) || 'Coadmin',
    requestedUsername:
      cleanText(row.username) || cleanText(raw.requestedUsername) || cleanText(raw.username),
    status,
    requestedAt: toIsoString(row.created_at) || toIsoString(raw.requestedAt),
    reviewedAt: toIsoString(row.reviewed_at) || toIsoString(raw.reviewedAt),
    reviewedByUid: cleanText(row.reviewed_by_uid) || cleanText(raw.reviewedByUid) || null,
    reviewedByUsername:
      cleanText(row.reviewed_by_username) || cleanText(raw.reviewedByUsername) || null,
    createdCarerUid:
      cleanText(row.created_carer_uid) || cleanText(raw.createdCarerUid) || null,
    note: cleanText(row.rejection_reason) || cleanText(raw.note) || null,
  };
}

function parseRaw(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  if (typeof value === 'object') {
    return value as Record<string, unknown>;
  }
  return {};
}

function buildRawFirestoreData(
  input: CreateCarerCreationRequestSqlInput,
  requestId: string,
  nowIso: string
) {
  return normalizeJson({
    coadminUid: input.coadminUid,
    coadminUsername: input.coadminUsername,
    requestedUsername: input.username,
    status: 'pending',
    requestedAt: nowIso,
    reviewedAt: null,
    reviewedByUid: null,
    reviewedByUsername: null,
    createdCarerUid: null,
    note: null,
    ...(input.rawData || {}),
  }) as Record<string, unknown>;
}

export async function hasPendingCarerCreationRequestSql(
  coadminUid: string,
  username: string
): Promise<boolean> {
  const db = getPlayerMirrorPool();
  const cleanCoadminUid = cleanText(coadminUid);
  const cleanUsername = cleanText(username).toLowerCase();
  if (!db || !cleanCoadminUid || !cleanUsername) {
    return false;
  }

  try {
    const result = await db.query(
      `
        SELECT request_id
        FROM public.carer_creation_requests_cache
        WHERE deleted_at IS NULL
          AND status = 'pending'
          AND coadmin_uid = $1
          AND LOWER(username) = LOWER($2)
        LIMIT 1
      `,
      [cleanCoadminUid, cleanUsername]
    );
    return (result.rowCount || 0) > 0;
  } catch (error) {
    console.warn('[CARER_CREATION_REQUEST_SQL] pending lookup failed', {
      coadminUid: cleanCoadminUid,
      username: cleanUsername,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

export async function createCarerCreationRequestSql(
  input: CreateCarerCreationRequestSqlInput
): Promise<{ requestId: string }> {
  const db = getPlayerMirrorPool();
  const cleanCoadminUid = cleanText(input.coadminUid);
  const cleanUsername = cleanText(input.username).toLowerCase();
  const cleanCoadminUsername = cleanText(input.coadminUsername) || 'Coadmin';
  if (!db || !cleanCoadminUid || !cleanUsername) {
    throw new Error('Postgres unavailable for carer creation request.');
  }

  const requestId = cleanText(input.requestId) || randomUUID();
  const nowIso = new Date().toISOString();
  const rawFirestoreData = buildRawFirestoreData(input, requestId, nowIso);

  await db.query(
    `
      INSERT INTO public.carer_creation_requests_cache (
        request_id,
        coadmin_uid,
        coadmin_username,
        username,
        status,
        requested_role,
        created_at,
        updated_at,
        reviewed_at,
        reviewed_by_uid,
        reviewed_by_username,
        rejection_reason,
        created_carer_uid,
        raw_firestore_data,
        source,
        mirrored_at,
        deleted_at
      )
      VALUES (
        $1, $2, NULLIF($3, ''), $4, 'pending', 'carer',
        $5::timestamptz, $5::timestamptz, NULL, NULL, NULL, NULL, NULL,
        $6::jsonb, $7, now(), NULL
      )
    `,
    [
      requestId,
      cleanCoadminUid,
      cleanCoadminUsername,
      cleanUsername,
      nowIso,
      JSON.stringify(rawFirestoreData),
      cleanText(input.source) || 'sql',
    ]
  );

  return { requestId };
}

const PENDING_CARER_CREATION_REQUESTS_SELECT = `
  SELECT
    request_id,
    coadmin_uid,
    coadmin_username,
    username,
    status,
    created_at,
    updated_at,
    reviewed_at,
    reviewed_by_uid,
    reviewed_by_username,
    rejection_reason,
    created_carer_uid,
    raw_firestore_data
  FROM public.carer_creation_requests_cache
  WHERE deleted_at IS NULL
    AND status = 'pending'
`;

function mapPendingCarerCreationRequestRows(rows: Record<string, unknown>[]) {
  return rows
    .map((row) => mapRowToRecord(row))
    .filter((row): row is CarerCreationRequestRecord => Boolean(row));
}

export async function listPendingCarerCreationRequestsSql(): Promise<
  CarerCreationRequestRecord[] | null
> {
  const db = getPlayerMirrorPool();
  if (!db) {
    return null;
  }

  try {
    const result = await db.query(
      `
        ${PENDING_CARER_CREATION_REQUESTS_SELECT}
        ORDER BY created_at DESC
      `
    );
    return mapPendingCarerCreationRequestRows(result.rows as Record<string, unknown>[]);
  } catch (error) {
    console.warn('[CARER_CREATION_REQUEST_SQL] list pending failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export async function listPendingCarerCreationRequestsForCoadminSql(
  coadminUid: string
): Promise<CarerCreationRequestRecord[] | null> {
  const db = getPlayerMirrorPool();
  const cleanCoadminUid = cleanText(coadminUid);
  if (!db || !cleanCoadminUid) {
    return null;
  }

  try {
    const result = await db.query(
      `
        ${PENDING_CARER_CREATION_REQUESTS_SELECT}
          AND coadmin_uid = $1
        ORDER BY created_at DESC
      `,
      [cleanCoadminUid]
    );
    return mapPendingCarerCreationRequestRows(result.rows as Record<string, unknown>[]);
  } catch (error) {
    console.warn('[CARER_CREATION_REQUEST_SQL] list mine failed', {
      coadminUid: cleanCoadminUid,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export async function listFirestorePendingCarerCreationRequestsForCoadmin(
  coadminUid: string
): Promise<CarerCreationRequestRecord[]> {
  const cleanCoadminUid = cleanText(coadminUid);
  if (!cleanCoadminUid) {
    return [];
  }

  const snapshot = await adminDb
    .collection('carerCreationRequests')
    .where('coadminUid', '==', cleanCoadminUid)
    .where('status', '==', 'pending')
    .get();

  return snapshot.docs
    .map((docSnap) =>
      mapFirestoreCarerCreationRequest(docSnap.id, (docSnap.data() || {}) as Record<string, unknown>)
    )
    .sort((a, b) => {
      const aMs = a.requestedAt ? new Date(a.requestedAt).getTime() : 0;
      const bMs = b.requestedAt ? new Date(b.requestedAt).getTime() : 0;
      return bMs - aMs;
    });
}

export async function getCarerCreationRequestSql(
  requestId: string
): Promise<CarerCreationRequestRecord | null> {
  const db = getPlayerMirrorPool();
  const cleanRequestId = cleanText(requestId);
  if (!db || !cleanRequestId) {
    return null;
  }

  try {
    const result = await db.query(
      `
        SELECT
          request_id,
          coadmin_uid,
          coadmin_username,
          username,
          status,
          created_at,
          updated_at,
          reviewed_at,
          reviewed_by_uid,
          reviewed_by_username,
          rejection_reason,
          created_carer_uid,
          raw_firestore_data
        FROM public.carer_creation_requests_cache
        WHERE deleted_at IS NULL
          AND request_id = $1
        LIMIT 1
      `,
      [cleanRequestId]
    );
    if ((result.rowCount || 0) === 0) {
      return null;
    }
    return mapRowToRecord(result.rows[0] as Record<string, unknown>);
  } catch (error) {
    console.warn('[CARER_CREATION_REQUEST_SQL] get failed', {
      requestId: cleanRequestId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export async function updateCarerCreationRequestStatusSql(
  input: UpdateCarerCreationRequestStatusSqlInput
): Promise<boolean> {
  const db = getPlayerMirrorPool();
  const cleanRequestId = cleanText(input.requestId);
  if (!db || !cleanRequestId) {
    return false;
  }

  const nowIso = new Date().toISOString();

  try {
    const result = await db.query(
      `
        UPDATE public.carer_creation_requests_cache
        SET
          status = $2,
          updated_at = $3::timestamptz,
          reviewed_at = $3::timestamptz,
          reviewed_by_uid = NULLIF($4, ''),
          reviewed_by_username = NULLIF($5, ''),
          rejection_reason = NULLIF($6, ''),
          created_carer_uid = NULLIF($7, ''),
          raw_firestore_data = COALESCE(raw_firestore_data, '{}'::jsonb)
            || jsonb_build_object(
              'status', $2::text,
              'reviewedAt', $3::text,
              'reviewedByUid', NULLIF($4, ''),
              'reviewedByUsername', NULLIF($5, ''),
              'note', NULLIF($6, ''),
              'createdCarerUid', NULLIF($7, '')
            ),
          mirrored_at = now()
        WHERE deleted_at IS NULL
          AND request_id = $1
          AND status = 'pending'
      `,
      [
        cleanRequestId,
        input.status,
        nowIso,
        cleanText(input.reviewedByUid),
        cleanText(input.reviewedByUsername),
        cleanText(input.rejectionReason),
        cleanText(input.createdCarerUid),
      ]
    );
    return (result.rowCount || 0) > 0;
  } catch (error) {
    console.warn('[CARER_CREATION_REQUEST_SQL] status update failed', {
      requestId: cleanRequestId,
      status: input.status,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

function firestoreDataToCacheInput(
  requestId: string,
  data: Record<string, unknown>,
  source: string
): CreateCarerCreationRequestSqlInput & { status?: string; reviewedAt?: string | null; createdCarerUid?: string | null; rejectionReason?: string | null } {
  return {
    requestId,
    coadminUid: cleanText(data.coadminUid),
    coadminUsername: cleanText(data.coadminUsername) || 'Coadmin',
    username: cleanText(data.requestedUsername || data.username).toLowerCase(),
    source,
    rawData: data,
    status: cleanText(data.status) || 'pending',
    reviewedAt: toIsoString(data.reviewedAt),
    createdCarerUid: cleanText(data.createdCarerUid) || null,
    rejectionReason: cleanText(data.note) || null,
  };
}

export async function upsertCarerCreationRequestCacheFromFirestore(
  requestId: string,
  data: Record<string, unknown>,
  source = 'firestore'
): Promise<boolean> {
  const db = getPlayerMirrorPool();
  const cleanRequestId = cleanText(requestId);
  const mapped = firestoreDataToCacheInput(cleanRequestId, data, source);
  if (!db || !cleanRequestId || !mapped.coadminUid || !mapped.username) {
    return false;
  }

  const createdAt = toIsoString(data.requestedAt) || new Date().toISOString();
  const reviewedAt = mapped.reviewedAt;
  const status = (mapped.status || 'pending') as CarerCreationRequestStatus;

  try {
    await db.query(
      `
        INSERT INTO public.carer_creation_requests_cache (
          request_id,
          coadmin_uid,
          coadmin_username,
          username,
          status,
          requested_role,
          created_at,
          updated_at,
          reviewed_at,
          reviewed_by_uid,
          reviewed_by_username,
          rejection_reason,
          created_carer_uid,
          raw_firestore_data,
          source,
          mirrored_at,
          deleted_at
        )
        VALUES (
          $1, $2, NULLIF($3, ''), $4, $5, 'carer',
          $6::timestamptz, now(), $7::timestamptz,
          NULLIF($8, ''), NULLIF($9, ''), NULLIF($10, ''), NULLIF($11, ''),
          $12::jsonb, $13, now(), NULL
        )
        ON CONFLICT (request_id) DO UPDATE SET
          coadmin_uid = EXCLUDED.coadmin_uid,
          coadmin_username = EXCLUDED.coadmin_username,
          username = EXCLUDED.username,
          status = EXCLUDED.status,
          updated_at = now(),
          reviewed_at = EXCLUDED.reviewed_at,
          reviewed_by_uid = EXCLUDED.reviewed_by_uid,
          reviewed_by_username = EXCLUDED.reviewed_by_username,
          rejection_reason = EXCLUDED.rejection_reason,
          created_carer_uid = EXCLUDED.created_carer_uid,
          raw_firestore_data = EXCLUDED.raw_firestore_data,
          source = EXCLUDED.source,
          mirrored_at = now(),
          deleted_at = NULL
      `,
      [
        cleanRequestId,
        mapped.coadminUid,
        mapped.coadminUsername,
        mapped.username,
        status,
        createdAt,
        reviewedAt,
        cleanText(data.reviewedByUid),
        cleanText(data.reviewedByUsername),
        mapped.rejectionReason,
        mapped.createdCarerUid,
        JSON.stringify(normalizeJson(data) || {}),
        source,
      ]
    );
    return true;
  } catch (error) {
    console.error('[CARER_CREATION_REQUEST_SQL] mirror upsert failed', {
      requestId: cleanRequestId,
      error,
    });
    return false;
  }
}

export async function mirrorCarerCreationRequestSnapshot(
  snap: DocumentSnapshot,
  source = 'firestore'
) {
  if (!snap.exists) return false;
  return upsertCarerCreationRequestCacheFromFirestore(
    snap.id,
    (snap.data() || {}) as Record<string, unknown>,
    source
  );
}

export async function mirrorCarerCreationRequestById(requestId: string, source = 'firestore') {
  const cleanRequestId = cleanText(requestId);
  if (!cleanRequestId) return false;
  try {
    const snap = await adminDb.collection('carerCreationRequests').doc(cleanRequestId).get();
    return mirrorCarerCreationRequestSnapshot(snap, source);
  } catch (error) {
    console.error('[CARER_CREATION_REQUEST_SQL] mirror by id failed', {
      requestId: cleanRequestId,
      error,
    });
    return false;
  }
}

export function mapFirestoreCarerCreationRequest(
  requestId: string,
  data: Record<string, unknown>
): CarerCreationRequestRecord {
  return {
    id: requestId,
    coadminUid: cleanText(data.coadminUid),
    coadminUsername: cleanText(data.coadminUsername) || 'Coadmin',
    requestedUsername: cleanText(data.requestedUsername || data.username).toLowerCase(),
    status: (cleanText(data.status) || 'pending') as CarerCreationRequestStatus,
    requestedAt: toIsoString(data.requestedAt),
    reviewedAt: toIsoString(data.reviewedAt),
    reviewedByUid: cleanText(data.reviewedByUid) || null,
    reviewedByUsername: cleanText(data.reviewedByUsername) || null,
    createdCarerUid: cleanText(data.createdCarerUid) || null,
    note: cleanText(data.note) || null,
  };
}
