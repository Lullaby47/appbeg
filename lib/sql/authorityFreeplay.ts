import 'server-only';

import { randomUUID } from 'crypto';
import type { PoolClient } from 'pg';

import { cleanText, getPlayerMirrorPool } from '@/lib/sql/playerMirrorCommon';
import {
  claimAuthorityOperation,
  insertAuthorityLedgerEvent,
  readAuthorityOperationPayload,
} from '@/lib/sql/authorityLedger';
import {
  insertLiveOutboxEventWithClient,
  playerFreeplayLiveChannel,
} from '@/lib/sql/liveOutbox';

export type FreeplayPlayerCandidate = {
  uid: string;
  username: string;
};

export type AuthorityFreeplayGiveResult = {
  success: true;
  duplicate: boolean;
  playerUid: string;
  playerUsername: string;
  giftId: string;
};

export type AuthorityFreeplayClaimResult = {
  success: true;
  duplicate: boolean;
  alreadyClaimed: boolean;
  amount: number;
  giftId: string;
  playerUid: string;
  message: string;
};

function isEligiblePlayerRow(row: Record<string, unknown>) {
  const role = cleanText(row.role).toLowerCase();
  const status = cleanText(row.status).toLowerCase() || 'active';
  return role === 'player' && status !== 'disabled';
}

function belongsToCoadmin(row: Record<string, unknown>, coadminUid: string) {
  const scopeUid = cleanText(coadminUid);
  if (!scopeUid) return false;
  return (
    cleanText(row.coadmin_uid) === scopeUid || cleanText(row.created_by) === scopeUid
  );
}

function rollFreeplayAmount() {
  return Math.random() < 0.5 ? 2 : 3;
}

function readPendingGiftType(marker: Record<string, unknown>) {
  const direct = cleanText(marker.type);
  if (direct) return direct.toLowerCase();
  const raw = marker.raw_firestore_data;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return cleanText((raw as Record<string, unknown>).type).toLowerCase();
  }
  return '';
}

function buildGiftRaw(input: {
  giftId: string;
  playerUid: string;
  coadminUid: string;
  status: string;
  amount?: number | null;
  createdAt: string;
  claimedAt?: string | null;
}) {
  return {
    type: 'freeplay',
    status: input.status,
    coadminUid: input.coadminUid,
    playerUid: input.playerUid,
    giftId: input.giftId,
    createdAt: input.createdAt,
    claimedAt: input.claimedAt ?? null,
    amount: input.amount ?? null,
  };
}

async function upsertFreeplayGiftCache(
  client: PoolClient,
  input: {
    giftId: string;
    playerUid: string;
    coadminUid: string;
    status: string;
    amount?: number | null;
    createdAt: string;
    updatedAt: string;
    claimedAt?: string | null;
    source: string;
  }
) {
  const raw = buildGiftRaw(input);
  await client.query(
    `
      INSERT INTO public.freeplay_gifts_cache (
        firebase_id, player_uid, coadmin_uid, type, status, amount,
        created_at, updated_at, claimed_at, source, mirrored_at, deleted_at,
        raw_firestore_data
      )
      VALUES (
        $1, $2, NULLIF($3, ''), 'freeplay', $4, $5,
        $6::timestamptz, $7::timestamptz, $8::timestamptz, $9, now(), NULL,
        $10::jsonb
      )
      ON CONFLICT (firebase_id) DO UPDATE SET
        player_uid = EXCLUDED.player_uid,
        coadmin_uid = EXCLUDED.coadmin_uid,
        status = EXCLUDED.status,
        amount = EXCLUDED.amount,
        updated_at = EXCLUDED.updated_at,
        claimed_at = EXCLUDED.claimed_at,
        source = EXCLUDED.source,
        mirrored_at = now(),
        deleted_at = NULL,
        raw_firestore_data = EXCLUDED.raw_firestore_data
    `,
    [
      input.giftId,
      input.playerUid,
      input.coadminUid,
      input.status,
      input.amount ?? null,
      input.createdAt,
      input.updatedAt,
      input.claimedAt ?? null,
      input.source,
      JSON.stringify(raw),
    ]
  );
}

async function upsertFreeplayPendingCache(
  client: PoolClient,
  input: {
    playerUid: string;
    coadminUid: string;
    giftId: string;
    status: string;
    amount?: number | null;
    createdAt: string;
    updatedAt: string;
    claimedAt?: string | null;
    source: string;
  }
) {
  const hasPendingGift =
    input.status.toLowerCase() === 'pending' && Boolean(cleanText(input.giftId));
  const raw = buildGiftRaw({
    giftId: input.giftId,
    playerUid: input.playerUid,
    coadminUid: input.coadminUid,
    status: input.status,
    amount: input.amount ?? null,
    createdAt: input.createdAt,
    claimedAt: input.claimedAt ?? null,
  });

  await client.query(
    `
      INSERT INTO public.freeplay_pending_gifts_cache (
        player_uid, coadmin_uid, gift_id, has_pending_gift, status, amount,
        created_at, updated_at, claimed_at, source, mirrored_at, deleted_at,
        raw_firestore_data
      )
      VALUES (
        $1, NULLIF($2, ''), NULLIF($3, ''), $4, $5, $6,
        $7::timestamptz, $8::timestamptz, $9::timestamptz, $10, now(), NULL,
        $11::jsonb
      )
      ON CONFLICT (player_uid) DO UPDATE SET
        coadmin_uid = EXCLUDED.coadmin_uid,
        gift_id = EXCLUDED.gift_id,
        has_pending_gift = EXCLUDED.has_pending_gift,
        status = EXCLUDED.status,
        amount = EXCLUDED.amount,
        created_at = COALESCE(EXCLUDED.created_at, public.freeplay_pending_gifts_cache.created_at),
        updated_at = EXCLUDED.updated_at,
        claimed_at = EXCLUDED.claimed_at,
        source = EXCLUDED.source,
        mirrored_at = now(),
        deleted_at = NULL,
        raw_firestore_data = EXCLUDED.raw_firestore_data
    `,
    [
      input.playerUid,
      input.coadminUid,
      input.giftId,
      hasPendingGift,
      input.status,
      input.amount ?? null,
      input.createdAt,
      input.updatedAt,
      input.claimedAt ?? null,
      input.source,
      JSON.stringify(raw),
    ]
  );
}

async function writeFreeplayOutbox(
  client: PoolClient,
  input: {
    playerUid: string;
    giftId: string;
    status: string;
    amount?: number | null;
    updatedAt: string;
    eventType: string;
  }
) {
  await insertLiveOutboxEventWithClient(client, {
    channel: playerFreeplayLiveChannel(input.playerUid),
    eventType: input.eventType,
    entityType: 'freeplay_gift',
    entityId: input.giftId,
    source: 'authority_freeplay',
    mirroredAt: input.updatedAt,
    payload: {
      entityId: input.giftId,
      playerUid: input.playerUid,
      giftId: input.giftId,
      status: input.status,
      amount: input.amount ?? null,
      updatedAt: input.updatedAt,
      source: 'authority',
    },
  });
}

async function loadFreeplayPlayersForCoadmin(coadminUid: string): Promise<FreeplayPlayerCandidate[]> {
  const scopeUid = cleanText(coadminUid);
  const db = getPlayerMirrorPool();
  if (!scopeUid || !db) {
    return [];
  }

  const playersResult = await db.query(
    `
      SELECT uid, username, role, status, coadmin_uid, created_by
      FROM public.players_cache
      WHERE deleted_at IS NULL
        AND role = 'player'
        AND COALESCE(LOWER(status), 'active') <> 'disabled'
        AND (coadmin_uid = $1 OR created_by = $1)
    `,
    [scopeUid]
  );

  return playersResult.rows
    .filter((row) => isEligiblePlayerRow(row as Record<string, unknown>))
    .map((row) => ({
      uid: cleanText((row as Record<string, unknown>).uid),
      username: cleanText((row as Record<string, unknown>).username) || 'Player',
    }))
    .filter((row) => row.uid);
}

export async function loadEligibleFreeplayPlayersForCoadmin(
  coadminUid: string
): Promise<FreeplayPlayerCandidate[]> {
  const players = await loadFreeplayPlayersForCoadmin(coadminUid);
  if (!players.length) {
    return [];
  }

  const db = getPlayerMirrorPool();
  if (!db) {
    return [];
  }

  const pendingResult = await db.query(
    `
      SELECT player_uid
      FROM public.freeplay_pending_gifts_cache
      WHERE deleted_at IS NULL
        AND has_pending_gift = TRUE
        AND player_uid = ANY($1::text[])
    `,
    [players.map((player) => player.uid)]
  );

  const pendingUids = new Set(
    pendingResult.rows.map((row) => cleanText((row as Record<string, unknown>).player_uid))
  );
  return players.filter((player) => !pendingUids.has(player.uid));
}

export async function giveFreeplayGiftInSql(input: {
  coadminUid: string;
  idempotencyKey?: string | null;
}): Promise<AuthorityFreeplayGiveResult> {
  const coadminUid = cleanText(input.coadminUid);
  if (!coadminUid) {
    throw new Error('coadminUid is required.');
  }

  const allPlayers = await loadFreeplayPlayersForCoadmin(coadminUid);
  if (!allPlayers.length) {
    throw new Error('No active players are assigned to your account.');
  }
  const eligiblePlayers = await loadEligibleFreeplayPlayersForCoadmin(coadminUid);
  if (!eligiblePlayers.length) {
    throw new Error('Every eligible player already has a pending FreePlay gift.');
  }

  const selectedPlayer =
    eligiblePlayers[Math.floor(Math.random() * eligiblePlayers.length)];
  const giftId = randomUUID();
  const nowIso = new Date().toISOString();
  const idempotencyKey = cleanText(input.idempotencyKey);
  const operationKey = idempotencyKey
    ? `freeplay_give:${coadminUid}:${idempotencyKey}`
    : null;

  if (operationKey) {
    const existing = await readAuthorityOperationPayload(operationKey);
    if (existing?.playerUid && existing?.giftId) {
      return {
        success: true,
        duplicate: true,
        playerUid: cleanText(existing.playerUid),
        playerUsername: cleanText(existing.playerUsername) || 'Player',
        giftId: cleanText(existing.giftId),
      };
    }
  }

  const db = getPlayerMirrorPool();
  if (!db) {
    throw new Error('Postgres is unavailable.');
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    if (operationKey) {
      const claim = await claimAuthorityOperation(client, {
        operationKey,
        operationType: 'freeplay_give',
        userUid: selectedPlayer.uid,
        sourceId: giftId,
        actorUid: coadminUid,
        actorRole: 'coadmin',
        payload: {
          playerUid: selectedPlayer.uid,
          playerUsername: selectedPlayer.username,
          giftId,
        },
      });
      if (claim.duplicate) {
        await client.query('ROLLBACK');
        const payload = await readAuthorityOperationPayload(operationKey);
        if (payload?.playerUid && payload?.giftId) {
          return {
            success: true,
            duplicate: true,
            playerUid: cleanText(payload.playerUid),
            playerUsername: cleanText(payload.playerUsername) || 'Player',
            giftId: cleanText(payload.giftId),
          };
        }
        throw new Error('FreePlay give idempotency conflict without stored result.');
      }
    }

    const playerLock = await client.query(
      `
        SELECT uid, username, role, status, coadmin_uid, created_by
        FROM public.players_cache
        WHERE uid = $1
          AND deleted_at IS NULL
        FOR UPDATE
      `,
      [selectedPlayer.uid]
    );
    if (!playerLock.rows.length) {
      throw new Error('Selected player no longer exists.');
    }
    const playerRow = playerLock.rows[0] as Record<string, unknown>;
    if (!belongsToCoadmin(playerRow, coadminUid) || !isEligiblePlayerRow(playerRow)) {
      throw new Error('Selected player is no longer eligible.');
    }

    const pendingLock = await client.query(
      `
        SELECT player_uid, gift_id, status, has_pending_gift
        FROM public.freeplay_pending_gifts_cache
        WHERE player_uid = $1
          AND deleted_at IS NULL
        FOR UPDATE
      `,
      [selectedPlayer.uid]
    );
    if (pendingLock.rows.length) {
      const pending = pendingLock.rows[0] as Record<string, unknown>;
      const pendingStatus = cleanText(pending.status).toLowerCase();
      if (pending.has_pending_gift === true || pendingStatus === 'pending') {
        throw new Error('This player already has a pending FreePlay gift.');
      }
    }

    await upsertFreeplayGiftCache(client, {
      giftId,
      playerUid: selectedPlayer.uid,
      coadminUid,
      status: 'pending',
      amount: null,
      createdAt: nowIso,
      updatedAt: nowIso,
      source: 'authority_freeplay_give',
    });

    await upsertFreeplayPendingCache(client, {
      playerUid: selectedPlayer.uid,
      coadminUid,
      giftId,
      status: 'pending',
      amount: null,
      createdAt: nowIso,
      updatedAt: nowIso,
      source: 'authority_freeplay_give',
    });

    await writeFreeplayOutbox(client, {
      playerUid: selectedPlayer.uid,
      giftId,
      status: 'pending',
      amount: null,
      updatedAt: nowIso,
      eventType: 'freeplay_give',
    });

    await client.query('COMMIT');
    return {
      success: true,
      duplicate: false,
      playerUid: selectedPlayer.uid,
      playerUsername: selectedPlayer.username,
      giftId,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function claimFreeplayGiftInSql(input: {
  playerUid: string;
  giftId: string;
  idempotencyKey?: string | null;
}): Promise<AuthorityFreeplayClaimResult> {
  const playerUid = cleanText(input.playerUid);
  const requestedGiftId = cleanText(input.giftId);
  if (!playerUid || !requestedGiftId) {
    throw new Error('FreePlay gift id is required.');
  }

  const db = getPlayerMirrorPool();
  if (!db) {
    throw new Error('Postgres is unavailable.');
  }

  const operationKey = cleanText(input.idempotencyKey)
    ? `freeplay_claim:${playerUid}:${cleanText(input.idempotencyKey)}`
    : `freeplay_claim:${playerUid}:${requestedGiftId}`;

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const pendingLock = await client.query(
      `
        SELECT *
        FROM public.freeplay_pending_gifts_cache
        WHERE player_uid = $1
          AND deleted_at IS NULL
        FOR UPDATE
      `,
      [playerUid]
    );
    if (!pendingLock.rows.length) {
      throw new Error('No pending FreePlay gift found.');
    }
    const marker = pendingLock.rows[0] as Record<string, unknown>;
    const markerType = readPendingGiftType(marker);
    const markerStatus = cleanText(marker.status).toLowerCase();
    const markerGiftId = cleanText(marker.gift_id);

    if (markerType !== 'freeplay') {
      throw new Error('No pending FreePlay gift found.');
    }
    if (markerGiftId !== requestedGiftId) {
      throw new Error('This FreePlay gift is no longer pending.');
    }
    if (markerStatus === 'claimed') {
      const amount = Math.max(0, Math.floor(Number(marker.amount || 0)));
      await client.query('COMMIT');
      return {
        success: true,
        duplicate: true,
        alreadyClaimed: true,
        amount,
        giftId: requestedGiftId,
        playerUid,
        message: `You got ${amount} FreePlay coins!`,
      };
    }
    if (markerStatus !== 'pending' || !markerGiftId) {
      throw new Error('No pending FreePlay gift found.');
    }

    const giftLock = await client.query(
      `
        SELECT *
        FROM public.freeplay_gifts_cache
        WHERE firebase_id = $1
          AND deleted_at IS NULL
        FOR UPDATE
      `,
      [requestedGiftId]
    );
    if (!giftLock.rows.length) {
      throw new Error('FreePlay gift or player profile not found.');
    }
    const gift = giftLock.rows[0] as Record<string, unknown>;
    const giftPlayerUid = cleanText(gift.player_uid);
    const giftType = cleanText(gift.type).toLowerCase();
    const giftStatus = cleanText(gift.status).toLowerCase();
    if (giftPlayerUid !== playerUid || giftType !== 'freeplay' || giftStatus !== 'pending') {
      throw new Error('No pending FreePlay gift found.');
    }

    const playerLock = await client.query(
      `
        SELECT uid, username, role, coin, cash
        FROM public.players_cache
        WHERE uid = $1
          AND deleted_at IS NULL
        FOR UPDATE
      `,
      [playerUid]
    );
    if (!playerLock.rows.length) {
      throw new Error('FreePlay gift or player profile not found.');
    }
    const player = playerLock.rows[0] as Record<string, unknown>;
    if (cleanText(player.role).toLowerCase() !== 'player') {
      throw new Error('Only players can claim FreePlay gifts.');
    }

    const claim = await claimAuthorityOperation(client, {
      operationKey,
      operationType: 'freeplay_claim',
      userUid: playerUid,
      sourceId: requestedGiftId,
      actorUid: playerUid,
      actorRole: 'player',
      payload: {},
    });
    if (claim.duplicate) {
      await client.query('ROLLBACK');
      const payload = await readAuthorityOperationPayload(operationKey);
      const amount = Math.max(0, Math.floor(Number(payload?.amount || marker.amount || 0)));
      return {
        success: true,
        duplicate: true,
        alreadyClaimed: true,
        amount,
        giftId: requestedGiftId,
        playerUid,
        message: `You got ${amount} FreePlay coins!`,
      };
    }

    const amount = rollFreeplayAmount();
    const nowIso = new Date().toISOString();
    const coadminUid =
      cleanText(gift.coadmin_uid) || cleanText(marker.coadmin_uid) || null;
    const currentCoin = Math.max(0, Math.floor(Number(player.coin || 0)));
    const nextCoin = currentCoin + amount;
    const eventId = randomUUID();

    await client.query(
      `
        UPDATE public.players_cache
        SET
          coin = $2,
          updated_at = $3::timestamptz,
          raw_firestore_data = COALESCE(raw_firestore_data, '{}'::jsonb) || jsonb_build_object('coin', $2)
        WHERE uid = $1
          AND deleted_at IS NULL
      `,
      [playerUid, nextCoin, nowIso]
    );

    await client.query(
      `
        UPDATE public.user_balance_snapshots_cache
        SET
          coin = $2,
          updated_at = $3::timestamptz,
          mirrored_at = now(),
          raw_firestore_data = COALESCE(raw_firestore_data, '{}'::jsonb) || jsonb_build_object('coin', $2)
        WHERE firebase_id = $1
          AND deleted_at IS NULL
      `,
      [playerUid, nextCoin, nowIso]
    );

    await upsertFreeplayGiftCache(client, {
      giftId: requestedGiftId,
      playerUid,
      coadminUid: coadminUid || '',
      status: 'claimed',
      amount,
      createdAt: toIsoOrNow(gift.created_at, nowIso),
      updatedAt: nowIso,
      claimedAt: nowIso,
      source: 'authority_freeplay_claim',
    });

    await upsertFreeplayPendingCache(client, {
      playerUid,
      coadminUid: coadminUid || '',
      giftId: requestedGiftId,
      status: 'claimed',
      amount,
      createdAt: toIsoOrNow(marker.created_at, nowIso),
      updatedAt: nowIso,
      claimedAt: nowIso,
      source: 'authority_freeplay_claim',
    });

    const rawEvent = {
      type: 'freeplay',
      playerUid,
      coadminUid,
      amountNpr: amount,
      giftId: requestedGiftId,
      createdAt: nowIso,
    };

    await client.query(
      `
        INSERT INTO public.financial_events_cache (
          firebase_id, player_uid, coadmin_uid, type, amount_npr, gift_id,
          before_coin, after_coin, actor_uid, actor_role,
          created_at, updated_at, source, mirrored_at, deleted_at, raw_firestore_data
        )
        VALUES (
          $1, $2, NULLIF($3, ''), 'freeplay', $4, $5,
          $6, $7, $2, 'player',
          $8::timestamptz, $8::timestamptz, 'authority_freeplay_claim', now(), NULL, $9::jsonb
        )
        ON CONFLICT (firebase_id) DO NOTHING
      `,
      [
        eventId,
        playerUid,
        coadminUid,
        amount,
        requestedGiftId,
        currentCoin,
        nextCoin,
        nowIso,
        JSON.stringify(rawEvent),
      ]
    );

    await insertAuthorityLedgerEvent(client, {
      eventKey: `authority:freeplay_claim:${eventId}`,
      userUid: playerUid,
      username: cleanText(player.username) || null,
      role: 'player',
      coadminUid,
      balanceType: 'coin',
      direction: 'credit',
      delta: amount,
      absoluteAfter: nextCoin,
      eventType: 'freeplay',
      sourceCollection: 'financialEvents',
      sourceId: eventId,
      actorUid: playerUid,
      actorRole: 'player',
      confidence: 'high',
      sourceCreatedAt: nowIso,
      rawSourceData: rawEvent,
      sourceFields: {
        giftId: requestedGiftId,
        amountNpr: amount,
        beforeCoin: currentCoin,
        afterCoin: nextCoin,
      },
    });

    await writeFreeplayOutbox(client, {
      playerUid,
      giftId: requestedGiftId,
      status: 'claimed',
      amount,
      updatedAt: nowIso,
      eventType: 'freeplay_claim',
    });

    await client.query(
      `
        UPDATE public.authority_operations
        SET payload = $2::jsonb
        WHERE operation_key = $1
      `,
      [
        operationKey,
        JSON.stringify({
          playerUid,
          giftId: requestedGiftId,
          amount,
          alreadyClaimed: false,
        }),
      ]
    );

    await client.query('COMMIT');
    return {
      success: true,
      duplicate: false,
      alreadyClaimed: false,
      amount,
      giftId: requestedGiftId,
      playerUid,
      message: `You got ${amount} FreePlay coins!`,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

function toIsoOrNow(value: unknown, fallback: string) {
  if (!value) return fallback;
  if (value instanceof Date) return value.toISOString();
  const text = cleanText(value);
  if (!text) return fallback;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? fallback : date.toISOString();
}
