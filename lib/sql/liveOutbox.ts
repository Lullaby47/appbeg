import 'server-only';

import { createHash } from 'crypto';
import type { PoolClient } from 'pg';

import {
  cleanText,
  createPlayerMirrorSqlTiming,
  getPlayerMirrorPool,
  runMirrorClientQuery,
  runMirrorPoolQuery,
  type PlayerMirrorAcquireContext,
  type PlayerMirrorSqlTiming,
  toIsoString,
} from '@/lib/sql/playerMirrorCommon';

const LIVE_OUTBOX_DEDUPE_WINDOW_MS = 5_000;

export type LiveOutboxRow = {
  outbox_id: number;
  channel: string;
  event_type: string;
  entity_type: string;
  entity_id: string;
  payload: Record<string, unknown>;
  payload_hash: string | null;
  source: string;
  mirrored_at: string | null;
  created_at: string;
};

export type PlayerRequestOutboxPayload = {
  entityId: string;
  playerUid: string;
  type: string;
  status: string;
  gameName: string;
  amount: number | null;
  baseAmount: number | null;
  pokeMessage: string | null;
  updatedAt: string | null;
  mirroredAt: string | null;
  source: string;
};

function hashPayload(payload: Record<string, unknown>) {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

export function playerRequestLiveChannel(playerUid: string) {
  return `player:${cleanText(playerUid)}:requests`;
}

export function carerTaskLiveChannel(carerUid: string) {
  return `carer:${cleanText(carerUid)}:tasks`;
}

export function coadminTaskLiveChannel(coadminUid: string) {
  return `coadmin:${cleanText(coadminUid)}:tasks`;
}

export function carerJobLiveChannel(carerUid: string) {
  return `carer:${cleanText(carerUid)}:jobs`;
}

export function coadminJobLiveChannel(coadminUid: string) {
  return `coadmin:${cleanText(coadminUid)}:jobs`;
}

export type CarerTaskOutboxPayload = {
  entityId: string;
  taskId: string;
  coadminUid: string;
  playerUid: string;
  type: string;
  status: string;
  automationStatus: string | null;
  gameName: string;
  amount: number | null;
  requestId: string | null;
  updatedAt: string | null;
  mirroredAt: string | null;
  source: string;
};

export async function insertLiveOutboxEvent(input: {
  channel: string;
  eventType: string;
  entityType: string;
  entityId: string;
  payload: Record<string, unknown>;
  source?: string;
  mirroredAt?: string | null;
}) {
  const db = getPlayerMirrorPool();
  const channel = cleanText(input.channel);
  const entityId = cleanText(input.entityId);
  if (!db || !channel || !entityId) {
    console.info('[LIVE_OUTBOX] failed', { reason: 'database_or_input_missing', channel, entityId });
    return null;
  }

  const payloadHash = hashPayload(input.payload);

  try {
    const duplicate = await db.query(
      `
        SELECT 1
        FROM public.live_outbox
        WHERE channel = $1
          AND entity_id = $2
          AND payload_hash = $3
          AND deleted_at IS NULL
          AND created_at > NOW() - INTERVAL '5 seconds'
        LIMIT 1
      `,
      [channel, entityId, payloadHash]
    );
    if (duplicate.rowCount && duplicate.rowCount > 0) {
      console.info('[LIVE_OUTBOX] skipped duplicate', {
        channel,
        entityId,
        eventType: input.eventType,
      });
      return null;
    }

    const result = await db.query(
      `
        INSERT INTO public.live_outbox (
          channel,
          event_type,
          entity_type,
          entity_id,
          payload,
          payload_hash,
          source,
          mirrored_at
        )
        VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8::timestamptz)
        RETURNING outbox_id
      `,
      [
        channel,
        cleanText(input.eventType),
        cleanText(input.entityType),
        entityId,
        JSON.stringify(input.payload),
        payloadHash,
        cleanText(input.source) || 'mirror',
        input.mirroredAt || null,
      ]
    );

    const outboxId = Number(result.rows[0]?.outbox_id || 0);
    console.info('[LIVE_OUTBOX] inserted', {
      outboxId,
      channel,
      entityId,
      eventType: input.eventType,
    });
    return outboxId;
  } catch (error) {
    console.info('[LIVE_OUTBOX] failed', {
      channel,
      entityId,
      eventType: input.eventType,
      error,
    });
    return null;
  }
}

export function buildPlayerRequestOutboxPayload(input: {
  firebaseId: string;
  playerUid: string;
  type?: unknown;
  status?: unknown;
  gameName?: unknown;
  amount?: unknown;
  baseAmount?: unknown;
  pokeMessage?: unknown;
  updatedAt?: unknown;
  mirroredAt?: unknown;
  source?: unknown;
}): PlayerRequestOutboxPayload {
  return {
    entityId: cleanText(input.firebaseId),
    playerUid: cleanText(input.playerUid),
    type: cleanText(input.type),
    status: cleanText(input.status),
    gameName: cleanText(input.gameName),
    amount: Number.isFinite(Number(input.amount)) ? Number(input.amount) : null,
    baseAmount: Number.isFinite(Number(input.baseAmount)) ? Number(input.baseAmount) : null,
    pokeMessage: cleanText(input.pokeMessage) || null,
    updatedAt: toIsoString(input.updatedAt),
    mirroredAt: toIsoString(input.mirroredAt) || new Date().toISOString(),
    source: cleanText(input.source) || 'mirror',
  };
}

export function buildCarerTaskOutboxPayload(input: {
  firebaseId: string;
  coadminUid?: unknown;
  playerUid?: unknown;
  type?: unknown;
  status?: unknown;
  automationStatus?: unknown;
  gameName?: unknown;
  amount?: unknown;
  requestId?: unknown;
  updatedAt?: unknown;
  mirroredAt?: unknown;
  source?: unknown;
}): CarerTaskOutboxPayload {
  const entityId = cleanText(input.firebaseId);
  return {
    entityId,
    taskId: entityId,
    coadminUid: cleanText(input.coadminUid),
    playerUid: cleanText(input.playerUid),
    type: cleanText(input.type),
    status: cleanText(input.status),
    automationStatus: cleanText(input.automationStatus) || null,
    gameName: cleanText(input.gameName),
    amount: Number.isFinite(Number(input.amount)) ? Number(input.amount) : null,
    requestId: cleanText(input.requestId) || null,
    updatedAt: toIsoString(input.updatedAt),
    mirroredAt: toIsoString(input.mirroredAt) || new Date().toISOString(),
    source: cleanText(input.source) || 'mirror',
  };
}

function resolveCarerTaskOutboxChannels(input: {
  coadminUid?: unknown;
  assignedCarerUid?: unknown;
  claimedByUid?: unknown;
  status?: unknown;
}) {
  const channels = new Set<string>();
  const assignedCarerUid = cleanText(input.assignedCarerUid);
  const claimedByUid = cleanText(input.claimedByUid);
  const carerUid = assignedCarerUid || claimedByUid;
  const status = cleanText(input.status).toLowerCase();
  const coadminUid = cleanText(input.coadminUid);

  if (carerUid) {
    channels.add(carerTaskLiveChannel(carerUid));
  } else if (coadminUid && (status === 'pending' || status === 'urgent')) {
    // Shadow phase: unassigned pool tasks fan out via coadmin channel only.
    channels.add(coadminTaskLiveChannel(coadminUid));
  }

  return Array.from(channels);
}

export async function emitCarerTaskOutboxEvent(input: {
  firebaseId: string;
  coadminUid?: unknown;
  assignedCarerUid?: unknown;
  claimedByUid?: unknown;
  playerUid?: unknown;
  type?: unknown;
  status?: unknown;
  automationStatus?: unknown;
  gameName?: unknown;
  amount?: unknown;
  requestId?: unknown;
  updatedAt?: unknown;
  mirroredAt?: unknown;
  source?: unknown;
  eventType: 'task.upserted' | 'task.tombstoned';
}) {
  const firebaseId = cleanText(input.firebaseId);
  if (!firebaseId) {
    console.info('[LIVE_OUTBOX] failed', {
      reason: 'missing_carer_task_entity_id',
      eventType: input.eventType,
    });
    return null;
  }

  const channels = resolveCarerTaskOutboxChannels(input);
  if (!channels.length) {
    console.info('[LIVE_OUTBOX] skipped carer task emit', {
      firebaseId,
      eventType: input.eventType,
      reason: 'no_safe_channel',
      status: cleanText(input.status),
    });
    return null;
  }

  const payload = buildCarerTaskOutboxPayload(input);
  const results = await Promise.all(
    channels.map((channel) =>
      insertLiveOutboxEvent({
        channel,
        eventType: input.eventType,
        entityType: 'carer_task',
        entityId: firebaseId,
        payload,
        source: payload.source,
        mirroredAt: payload.mirroredAt,
      })
    )
  );

  return results.find((value) => value !== null) ?? null;
}

export type AutomationJobOutboxPayload = {
  entityId: string;
  jobId: string;
  taskId: string;
  coadminUid: string;
  carerUid: string;
  agentId: string | null;
  type: string;
  status: string;
  gameName: string;
  requestId: string | null;
  updatedAt: string | null;
  mirroredAt: string | null;
  source: string;
};

function extractRequestIdFromTaskId(taskId: unknown) {
  const cleanTaskId = cleanText(taskId);
  if (cleanTaskId.startsWith('request__')) {
    return cleanText(cleanTaskId.slice('request__'.length)) || null;
  }
  return null;
}

export function buildAutomationJobOutboxPayload(input: {
  firebaseId: string;
  taskId?: unknown;
  coadminUid?: unknown;
  carerUid?: unknown;
  createdByUid?: unknown;
  agentId?: unknown;
  type?: unknown;
  status?: unknown;
  gameName?: unknown;
  requestId?: unknown;
  updatedAt?: unknown;
  mirroredAt?: unknown;
  source?: unknown;
}): AutomationJobOutboxPayload {
  const entityId = cleanText(input.firebaseId);
  const taskId = cleanText(input.taskId);
  const carerUid = cleanText(input.carerUid) || cleanText(input.createdByUid);
  return {
    entityId,
    jobId: entityId,
    taskId,
    coadminUid: cleanText(input.coadminUid),
    carerUid,
    agentId: cleanText(input.agentId) || null,
    type: cleanText(input.type),
    status: cleanText(input.status),
    gameName: cleanText(input.gameName),
    requestId: cleanText(input.requestId) || extractRequestIdFromTaskId(taskId),
    updatedAt: toIsoString(input.updatedAt),
    mirroredAt: toIsoString(input.mirroredAt) || new Date().toISOString(),
    source: cleanText(input.source) || 'mirror',
  };
}

function resolveAutomationJobOutboxChannels(input: {
  coadminUid?: unknown;
  carerUid?: unknown;
  createdByUid?: unknown;
  status?: unknown;
}) {
  const channels = new Set<string>();
  const carerUid = cleanText(input.carerUid) || cleanText(input.createdByUid);
  const status = cleanText(input.status).toLowerCase();
  const coadminUid = cleanText(input.coadminUid);

  if (carerUid) {
    channels.add(carerJobLiveChannel(carerUid));
  } else if (
    coadminUid &&
    (status === 'queued' ||
      status === 'pending' ||
      status === 'claimed' ||
      status === 'retrying')
  ) {
    channels.add(coadminJobLiveChannel(coadminUid));
  }

  return Array.from(channels);
}

export async function emitAutomationJobOutboxEvent(input: {
  firebaseId: string;
  taskId?: unknown;
  coadminUid?: unknown;
  carerUid?: unknown;
  createdByUid?: unknown;
  agentId?: unknown;
  type?: unknown;
  status?: unknown;
  gameName?: unknown;
  requestId?: unknown;
  updatedAt?: unknown;
  mirroredAt?: unknown;
  source?: unknown;
  eventType: 'job.upserted' | 'job.tombstoned';
}) {
  const firebaseId = cleanText(input.firebaseId);
  if (!firebaseId) {
    console.info('[LIVE_OUTBOX] failed', {
      reason: 'missing_automation_job_entity_id',
      eventType: input.eventType,
    });
    return null;
  }

  const channels = resolveAutomationJobOutboxChannels(input);
  if (!channels.length) {
    console.info('[LIVE_OUTBOX] skipped automation job emit', {
      firebaseId,
      eventType: input.eventType,
      reason: 'no_safe_channel',
      status: cleanText(input.status),
    });
    return null;
  }

  const payload = buildAutomationJobOutboxPayload(input);
  const results = await Promise.all(
    channels.map((channel) =>
      insertLiveOutboxEvent({
        channel,
        eventType: input.eventType,
        entityType: 'automation_job',
        entityId: firebaseId,
        payload,
        source: payload.source,
        mirroredAt: payload.mirroredAt,
      })
    )
  );

  return results.find((value) => value !== null) ?? null;
}

export async function emitPlayerRequestOutboxEvent(input: {
  firebaseId: string;
  playerUid: string;
  eventType: 'request.upserted' | 'request.tombstoned';
  type?: unknown;
  status?: unknown;
  gameName?: unknown;
  amount?: unknown;
  baseAmount?: unknown;
  pokeMessage?: unknown;
  updatedAt?: unknown;
  mirroredAt?: unknown;
  source?: unknown;
}) {
  const playerUid = cleanText(input.playerUid);
  const firebaseId = cleanText(input.firebaseId);
  if (!playerUid || !firebaseId) {
    console.info('[LIVE_OUTBOX] failed', {
      reason: 'missing_player_uid_or_entity_id',
      firebaseId,
      playerUid,
      eventType: input.eventType,
    });
    return null;
  }

  const payload = buildPlayerRequestOutboxPayload(input);
  return insertLiveOutboxEvent({
    channel: playerRequestLiveChannel(playerUid),
    eventType: input.eventType,
    entityType: 'player_game_request',
    entityId: firebaseId,
    payload,
    source: cleanText(input.source) || 'mirror',
    mirroredAt: payload.mirroredAt,
  });
}

export async function getLiveOutboxRowsAfter(
  channels: string[],
  afterOutboxId: number,
  limit = 200
): Promise<LiveOutboxRow[]> {
  const db = getPlayerMirrorPool();
  const cleanChannels = channels.map(cleanText).filter(Boolean);
  if (!db || !cleanChannels.length) {
    return [];
  }

  try {
    const result = await db.query(
      `
        SELECT
          outbox_id,
          channel,
          event_type,
          entity_type,
          entity_id,
          payload,
          payload_hash,
          source,
          mirrored_at,
          created_at
        FROM public.live_outbox
        WHERE channel = ANY($1::text[])
          AND outbox_id > $2
          AND deleted_at IS NULL
        ORDER BY outbox_id ASC
        LIMIT $3
      `,
      [cleanChannels, Math.max(0, afterOutboxId), Math.min(Math.max(limit, 1), 500)]
    );

    return result.rows.map((row) => ({
      outbox_id: Number(row.outbox_id),
      channel: cleanText(row.channel),
      event_type: cleanText(row.event_type),
      entity_type: cleanText(row.entity_type),
      entity_id: cleanText(row.entity_id),
      payload:
        row.payload && typeof row.payload === 'object' && !Array.isArray(row.payload)
          ? (row.payload as Record<string, unknown>)
          : {},
      payload_hash: cleanText(row.payload_hash) || null,
      source: cleanText(row.source) || 'mirror',
      mirrored_at: toIsoString(row.mirrored_at),
      created_at: toIsoString(row.created_at) || new Date().toISOString(),
    }));
  } catch (error) {
    console.info('[LIVE_OUTBOX] failed', { reason: 'get_rows_after', error });
    return [];
  }
}

export type LatestOutboxLookupResult = {
  latestOutboxId: number;
  timing: PlayerMirrorSqlTiming;
};

export async function getLatestOutboxIdForChannels(
  channels: string[],
  options?: { mirrorClient?: PoolClient; acquireContext?: PlayerMirrorAcquireContext }
): Promise<LatestOutboxLookupResult> {
  const db = getPlayerMirrorPool();
  const cleanChannels = channels.map(cleanText).filter(Boolean);
  const emptyTiming = createPlayerMirrorSqlTiming();
  if (!db || !cleanChannels.length) {
    return { latestOutboxId: 0, timing: emptyTiming };
  }

  const latestSql = `
    SELECT outbox_id
    FROM public.live_outbox
    WHERE channel = $1
      AND deleted_at IS NULL
    ORDER BY outbox_id DESC
    LIMIT 1
  `;

  try {
    const lookupChannel = async (channel: string) => {
      if (options?.mirrorClient) {
        return runMirrorClientQuery<{ outbox_id?: unknown }>(
          options.mirrorClient,
          latestSql,
          [channel]
        );
      }
      return runMirrorPoolQuery<{ outbox_id?: unknown }>(
        db,
        latestSql,
        [channel],
        options?.acquireContext
      );
    };

    if (cleanChannels.length === 1) {
      const { rows, timing } = await lookupChannel(cleanChannels[0]);
      console.info(
        '[LIVE_OUTBOX_LATEST_TIMING] channel=%s pool_acquire_ms=%s query_exec_ms=%s total_ms=%s shared_client=%s',
        cleanChannels[0],
        timing.pool_acquire_ms,
        timing.query_exec_ms,
        timing.total_ms,
        Boolean(options?.mirrorClient)
      );
      return {
        latestOutboxId: Number(rows[0]?.outbox_id || 0),
        timing,
      };
    }

    const results = await Promise.all(cleanChannels.map((channel) => lookupChannel(channel)));
    const timing = createPlayerMirrorSqlTiming({
      pool_acquire_ms: results.reduce((sum, item) => sum + item.timing.pool_acquire_ms, 0),
      query_exec_ms: results.reduce((sum, item) => sum + item.timing.query_exec_ms, 0),
      total_ms: results.reduce((sum, item) => sum + item.timing.total_ms, 0),
    });
    const latestOutboxId = Math.max(
      0,
      ...results.map((item) => Number(item.rows[0]?.outbox_id || 0))
    );
    console.info(
      '[LIVE_OUTBOX_LATEST_TIMING] channels=%s pool_acquire_ms=%s query_exec_ms=%s total_ms=%s shared_client=%s',
      cleanChannels.join(','),
      timing.pool_acquire_ms,
      timing.query_exec_ms,
      timing.total_ms,
      Boolean(options?.mirrorClient)
    );
    return { latestOutboxId, timing };
  } catch (error) {
    console.info('[LIVE_OUTBOX] failed', { reason: 'get_latest_outbox_id', error });
    return { latestOutboxId: 0, timing: emptyTiming };
  }
}
