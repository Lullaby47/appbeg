import 'server-only';

import type { DocumentSnapshot } from 'firebase-admin/firestore';

import { logBonusEventsListSqlFilter } from '@/lib/server/bonusEventsAudit';
import { isBonusVerboseLogs, SQL_QUERY_SLOW_MS } from '@/lib/server/verboseLogs';
import {
  cleanText,
  getPlayerMirrorPool,
  isSqlMissingRelationError,
  logSqlMissingRelation,
  normalizeJson,
  numberOrNull,
  runMirrorPoolQuery,
  toDate,
  toIsoString,
} from '@/lib/sql/playerMirrorCommon';

export type CachedBonusEvent = {
  id: string;
  coadminUid: string;
  bonusName: string;
  gameName: string;
  amountNpr: number;
  amount?: number;
  description: string;
  bonusPercentage: number;
  bonus_percentage?: number;
  createdByUid: string;
  created_by?: string;
  createdByUsername: string;
  createdByRole: string;
  creator_role?: string;
  status: string;
  startDate: string | null;
  endDate: string | null;
  start_date?: string | null;
  end_date?: string | null;
  createdAt: string | null;
  created_at?: string | null;
  updatedAt: string | null;
  updated_at?: string | null;
  eventId?: string;
  event_id?: string;
};

const BONUS_EVENTS_SELECT_COLUMNS = `
  firebase_id,
  coadmin_uid,
  bonus_name,
  game_name,
  amount_npr,
  bonus_percentage,
  description,
  created_by_uid,
  created_by_username,
  created_by_role,
  status,
  start_date,
  end_date,
  created_at,
  updated_at,
  raw_firestore_data
`;

function fieldFromRaw(raw: unknown, field: string) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }
  return (raw as Record<string, unknown>)[field];
}

function timestampMsFromRaw(value: unknown): number {
  if (!value) return 0;
  const date = toDate(value);
  if (date) return date.getTime();
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  if (typeof value === 'object') {
    const maybe = value as { toMillis?: () => number; seconds?: number; _seconds?: number };
    if (typeof maybe.toMillis === 'function') return maybe.toMillis();
    if (typeof maybe.seconds === 'number') return maybe.seconds * 1000;
    if (typeof maybe._seconds === 'number') return maybe._seconds * 1000;
  }
  return 0;
}

export function isBonusEventActive(event: CachedBonusEvent, nowMs: number = Date.now()): boolean {
  const status = String(event.status || 'active').toLowerCase();
  if (status !== 'active') return false;
  const startMs = timestampMsFromRaw(event.startDate || event.start_date);
  const endMs = timestampMsFromRaw(event.endDate || event.end_date);
  if (startMs > 0 && nowMs < startMs) return false;
  if (endMs > 0 && nowMs > endMs) return false;
  return true;
}

function parseNumericColumn(value: unknown, ...fallbacks: unknown[]) {
  for (const candidate of [value, ...fallbacks]) {
    const parsed = Number(candidate);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return 0;
}

export function mapBonusEventRow(row: Record<string, unknown>): CachedBonusEvent {
  const raw = row.raw_firestore_data;
  const id = cleanText(row.firebase_id);
  const bonusPercentage = parseNumericColumn(
    row.bonus_percentage,
    fieldFromRaw(raw, 'bonusPercentage'),
    fieldFromRaw(raw, 'bonus_percentage')
  );
  const amountNpr = parseNumericColumn(
    row.amount_npr,
    fieldFromRaw(raw, 'amountNpr'),
    fieldFromRaw(raw, 'amount')
  );
  const createdAt = toIsoString(row.created_at) || toIsoString(fieldFromRaw(raw, 'createdAt'));
  const startDate =
    toIsoString(row.start_date) ||
    toIsoString(fieldFromRaw(raw, 'startDate')) ||
    toIsoString(fieldFromRaw(raw, 'start_date'));
  const endDate =
    toIsoString(row.end_date) ||
    toIsoString(fieldFromRaw(raw, 'endDate')) ||
    toIsoString(fieldFromRaw(raw, 'end_date'));
  const createdByUid =
    cleanText(row.created_by_uid) ||
    cleanText(fieldFromRaw(raw, 'createdByUid')) ||
    cleanText(fieldFromRaw(raw, 'created_by')) ||
    '';
  const createdByRole =
    cleanText(row.created_by_role) ||
    cleanText(fieldFromRaw(raw, 'createdByRole')) ||
    cleanText(fieldFromRaw(raw, 'creator_role')) ||
    '';
  const createdByUsername =
    cleanText(row.created_by_username) ||
    cleanText(fieldFromRaw(raw, 'createdByUsername')) ||
    'User';

  return {
    id,
    eventId: id,
    event_id: id,
    coadminUid:
      cleanText(row.coadmin_uid) ||
      cleanText(fieldFromRaw(raw, 'coadminUid')) ||
      '',
    bonusName:
      cleanText(row.bonus_name) || cleanText(fieldFromRaw(raw, 'bonusName')) || '',
    gameName: cleanText(row.game_name) || cleanText(fieldFromRaw(raw, 'gameName')) || '',
    amountNpr,
    amount: amountNpr,
    description:
      cleanText(row.description) || cleanText(fieldFromRaw(raw, 'description')) || '',
    bonusPercentage,
    bonus_percentage: bonusPercentage,
    createdByUid,
    created_by: createdByUid,
    createdByUsername,
    createdByRole,
    creator_role: createdByRole,
    status: cleanText(row.status) || cleanText(fieldFromRaw(raw, 'status')) || 'active',
    startDate,
    endDate,
    start_date: startDate,
    end_date: endDate,
    createdAt,
    created_at: createdAt,
    updatedAt: toIsoString(row.updated_at) || toIsoString(fieldFromRaw(raw, 'updatedAt')),
    updated_at: toIsoString(row.updated_at) || toIsoString(fieldFromRaw(raw, 'updatedAt')),
  };
}

function sampleBonusEventRow(row: Record<string, unknown>) {
  return {
    firebase_id: cleanText(row.firebase_id),
    coadmin_uid: cleanText(row.coadmin_uid),
    status: cleanText(row.status) || 'active',
    start_date: toIsoString(row.start_date),
    end_date: toIsoString(row.end_date),
    amount_npr: numberOrNull(row.amount_npr),
    bonus_percentage: numberOrNull(row.bonus_percentage),
  };
}

function rowMatchesActiveWindow(row: Record<string, unknown>, nowMs: number) {
  const status = cleanText(row.status).toLowerCase() || 'active';
  if (status !== 'active') return false;
  const startMs = timestampMsFromRaw(row.start_date);
  const endMs = timestampMsFromRaw(row.end_date);
  if (startMs > 0 && nowMs < startMs) return false;
  if (endMs > 0 && nowMs > endMs) return false;
  return true;
}

export type ReadBonusEventsByCoadminOptions = {
  includeInactive?: boolean;
  maxResults?: number;
  route?: string;
};

export async function readActiveBonusEventsByCoadmin(
  coadminUid: string,
  options?: ReadBonusEventsByCoadminOptions
): Promise<CachedBonusEvent[] | null> {
  const cleanCoadminUid = cleanText(coadminUid);
  const db = getPlayerMirrorPool();
  if (!db || !cleanCoadminUid) {
    return null;
  }

  const maxResults = Math.max(1, Math.min(100, Number(options?.maxResults || 50)));
  const route = cleanText(options?.route) || '/api/bonus-events/list';
  const includeInactive = Boolean(options?.includeInactive);
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();

  try {
    const startedAt = Date.now();

    const totalResult = await runMirrorPoolQuery<Record<string, unknown>>(
      db,
      `
        SELECT ${BONUS_EVENTS_SELECT_COLUMNS}
        FROM public.bonus_events_cache
        WHERE trim(coalesce(coadmin_uid, '')) = $1
          AND deleted_at IS NULL
        ORDER BY created_at DESC NULLS LAST
        LIMIT 100
      `,
      [cleanCoadminUid]
    );

    const totalRows = totalResult.rows;
    const statusesSeen = Array.from(
      new Set(totalRows.map((row) => cleanText(row.status).toLowerCase() || 'active'))
    );
    const activeRows = totalRows.filter((row) => rowMatchesActiveWindow(row, nowMs));

    const { rows: filteredRows } = await runMirrorPoolQuery<Record<string, unknown>>(
      db,
      `
        SELECT ${BONUS_EVENTS_SELECT_COLUMNS}
        FROM public.bonus_events_cache
        WHERE trim(coalesce(coadmin_uid, '')) = $1
          AND deleted_at IS NULL
          AND (
            $2::boolean
            OR (
              lower(trim(coalesce(status, 'active'))) = 'active'
              AND (start_date IS NULL OR start_date <= now())
              AND (end_date IS NULL OR end_date >= now())
            )
          )
        ORDER BY created_at DESC NULLS LAST
        LIMIT $3
      `,
      [cleanCoadminUid, includeInactive, maxResults]
    );

    const events = filteredRows.map(mapBonusEventRow);

    logBonusEventsListSqlFilter({
      route,
      coadminUid: cleanCoadminUid,
      totalRowsForCoadmin: totalRows.length,
      activeRowsForCoadmin: activeRows.length,
      returnedCount: events.length,
      statusesSeen,
      now: nowIso,
      sampleRows: totalRows.slice(0, 5).map(sampleBonusEventRow),
      reason: includeInactive
        ? 'bonus_events_cache_read_include_inactive'
        : events.length > 0
          ? 'bonus_events_cache_read_active'
          : totalRows.length > 0
            ? 'bonus_events_cache_active_filter_empty'
            : 'bonus_events_cache_no_rows_for_coadmin',
    });

    const durationMs = Date.now() - startedAt;
    if (isBonusVerboseLogs() || durationMs >= SQL_QUERY_SLOW_MS) {
      console.info('[BONUS_EVENTS_CACHE] read ok', {
        coadminUid: cleanCoadminUid,
        totalRows: totalRows.length,
        activeRows: activeRows.length,
        returnedCount: events.length,
        includeInactive,
        durationMs,
      });
    }

    return events;
  } catch (error) {
    if (isSqlMissingRelationError(error, 'bonus_events_cache')) {
      logSqlMissingRelation('bonus_events_cache', 'bonus_events_cache_read');
      return [];
    }
    console.warn('[BONUS_EVENTS_CACHE] read failed', {
      coadminUid: cleanCoadminUid,
      error,
    });
    return null;
  }
}

export async function readCoadminAutoBonusPercentRangeFromSql(coadminUid: string) {
  const cleanCoadminUid = cleanText(coadminUid);
  const db = getPlayerMirrorPool();
  if (!db || !cleanCoadminUid) {
    return null;
  }

  try {
    const { rows } = await runMirrorPoolQuery<Record<string, unknown>>(
      db,
      `
        SELECT raw_firestore_data
        FROM public.players_cache
        WHERE uid = $1
          AND deleted_at IS NULL
        LIMIT 1
      `,
      [cleanCoadminUid]
    );
    if (!rows.length) {
      const settingsRows = await runMirrorPoolQuery<Record<string, unknown>>(
        db,
        `
          SELECT raw_json
          FROM public.coadmin_bonus_settings_cache
          WHERE coadmin_uid = $1
            AND deleted_at IS NULL
          LIMIT 1
        `,
        [cleanCoadminUid]
      );
      if (!settingsRows.rows.length) {
        return null;
      }
      const raw = settingsRows.rows[0].raw_json;
      return {
        minPercent: numberOrNull(fieldFromRaw(raw, 'autoBonusEventMinPercent')),
        maxPercent: numberOrNull(fieldFromRaw(raw, 'autoBonusEventMaxPercent')),
      };
    }

    const raw = rows[0].raw_firestore_data;
    return {
      minPercent: numberOrNull(fieldFromRaw(raw, 'autoBonusEventMinPercent')),
      maxPercent: numberOrNull(fieldFromRaw(raw, 'autoBonusEventMaxPercent')),
    };
  } catch (error) {
    console.warn('[BONUS_EVENTS_CACHE] auto_percent_range read failed', {
      coadminUid: cleanCoadminUid,
      error,
    });
    return null;
  }
}

export async function upsertBonusEventCache(input: {
  firebaseId: string;
  raw: Record<string, unknown>;
  source?: string;
}) {
  const db = getPlayerMirrorPool();
  const firebaseId = cleanText(input.firebaseId);
  if (!db || !firebaseId) {
    return false;
  }

  const raw = input.raw;
  const normalizedRaw = (normalizeJson(raw) || {}) as Record<string, unknown>;

  try {
    await db.query(
      `
        INSERT INTO public.bonus_events_cache (
          firebase_id,
          coadmin_uid,
          bonus_name,
          game_name,
          amount_npr,
          bonus_percentage,
          description,
          created_by_uid,
          created_by_username,
          created_by_role,
          status,
          start_date,
          end_date,
          created_at,
          updated_at,
          raw_firestore_data,
          source,
          mirrored_at,
          deleted_at
        )
        VALUES (
          $1,
          NULLIF($2, ''),
          NULLIF($3, ''),
          NULLIF($4, ''),
          $5,
          $6,
          NULLIF($7, ''),
          NULLIF($8, ''),
          NULLIF($9, ''),
          NULLIF($10, ''),
          NULLIF($11, ''),
          $12::timestamptz,
          $13::timestamptz,
          $14::timestamptz,
          $15::timestamptz,
          $16::jsonb,
          $17,
          now(),
          NULL
        )
        ON CONFLICT (firebase_id) DO UPDATE SET
          coadmin_uid = EXCLUDED.coadmin_uid,
          bonus_name = EXCLUDED.bonus_name,
          game_name = EXCLUDED.game_name,
          amount_npr = EXCLUDED.amount_npr,
          bonus_percentage = EXCLUDED.bonus_percentage,
          description = EXCLUDED.description,
          created_by_uid = EXCLUDED.created_by_uid,
          created_by_username = EXCLUDED.created_by_username,
          created_by_role = EXCLUDED.created_by_role,
          status = EXCLUDED.status,
          start_date = EXCLUDED.start_date,
          end_date = EXCLUDED.end_date,
          created_at = COALESCE(public.bonus_events_cache.created_at, EXCLUDED.created_at),
          updated_at = EXCLUDED.updated_at,
          raw_firestore_data = EXCLUDED.raw_firestore_data,
          source = EXCLUDED.source,
          mirrored_at = now(),
          deleted_at = NULL
      `,
      [
        firebaseId,
        cleanText(raw.coadminUid),
        cleanText(raw.bonusName),
        cleanText(raw.gameName),
        numberOrNull(raw.amountNpr ?? raw.amount),
        numberOrNull(raw.bonusPercentage ?? raw.bonus_percentage),
        cleanText(raw.description),
        cleanText(raw.createdByUid ?? raw.created_by),
        cleanText(raw.createdByUsername),
        cleanText(raw.createdByRole ?? raw.creator_role),
        cleanText(raw.status) || 'active',
        toIsoString(raw.startDate ?? raw.start_date),
        toIsoString(raw.endDate ?? raw.end_date),
        toIsoString(raw.createdAt ?? raw.created_at),
        toIsoString(raw.updatedAt ?? raw.updated_at),
        JSON.stringify(normalizedRaw),
        cleanText(input.source) || 'mirror',
      ]
    );
    return true;
  } catch (error) {
    console.warn('[BONUS_EVENTS_CACHE] upsert failed', { firebaseId, error });
    return false;
  }
}

export async function mirrorBonusEventSnapshot(snap: DocumentSnapshot) {
  if (!snap.exists) {
    return false;
  }
  const data = snap.data() as Record<string, unknown>;
  return upsertBonusEventCache({
    firebaseId: snap.id,
    raw: data,
    source: 'mirror',
  });
}
