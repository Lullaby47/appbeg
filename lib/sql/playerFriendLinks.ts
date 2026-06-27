import 'server-only';

import type { PoolClient } from 'pg';

import {
  cleanText,
  getPlayerMirrorPool,
  runMirrorPoolQuery,
  toIsoString,
} from '@/lib/sql/playerMirrorCommon';
import { emitPlayerFriendLinkOutboxEvent } from '@/lib/sql/liveOutbox';

export type PlayerFriendLinkStatus = 'pending' | 'accepted' | 'blocked' | 'declined';

export type PlayerFriendLink = {
  id: string;
  participants: string[];
  status: PlayerFriendLinkStatus;
  requestedByUid: string;
  acceptedByUid: string;
  source: string;
  createdAt: string | null;
  updatedAt: string | null;
  acceptedAt: string | null;
  peer?: {
    uid: string;
    avatarEmoji: string;
    avatarName: string;
    bio: string;
    avatarImageUrl: string | null;
  };
};

type PlayerScopeRow = {
  uid?: unknown;
  username?: unknown;
  role?: unknown;
  status?: unknown;
  coadmin_uid?: unknown;
  created_by?: unknown;
  raw_firestore_data?: unknown;
};

function canonicalPlayerCoadminUid(player: PlayerScopeRow) {
  const raw = (player.raw_firestore_data as Record<string, unknown>) || {};
  return (
    cleanText(player.coadmin_uid) ||
    cleanText(player.created_by) ||
    cleanText(raw.coadminUid) ||
    cleanText(raw.createdBy) ||
    null
  );
}

export function normalizeFriendPair(uidA: string, uidB: string) {
  const a = cleanText(uidA);
  const b = cleanText(uidB);
  if (!a || !b) {
    throw new Error('targetUid is required.');
  }
  if (a === b) {
    throw new Error('You cannot add yourself.');
  }
  const [participantAUid, participantBUid] = [a, b].sort();
  return {
    linkId: `${participantAUid}__${participantBUid}`,
    participantAUid,
    participantBUid,
    participants: [participantAUid, participantBUid],
  };
}

function mapFriendLinkRow(row: Record<string, unknown>): PlayerFriendLink {
  const participants = Array.isArray(row.participants)
    ? row.participants.map((uid) => cleanText(uid)).filter(Boolean)
    : [cleanText(row.participant_a_uid), cleanText(row.participant_b_uid)].filter(Boolean);
  const peerUid = cleanText(row.other_uid);
  const link: PlayerFriendLink = {
    id: cleanText(row.link_id),
    participants,
    status: (cleanText(row.status) || 'pending') as PlayerFriendLinkStatus,
    requestedByUid: cleanText(row.requested_by_uid),
    acceptedByUid: cleanText(row.accepted_by_uid),
    source: cleanText(row.source),
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
    acceptedAt: toIsoString(row.accepted_at),
  };
  if (peerUid) {
    link.peer = {
      uid: peerUid,
      avatarEmoji: cleanText(row.other_avatar_emoji),
      avatarName: cleanText(row.other_avatar_name) || cleanText(row.other_username) || 'Player',
      bio: cleanText(row.other_bio),
      avatarImageUrl: cleanText(row.other_avatar_image_url) || null,
    };
  }
  return link;
}

async function readActivePlayerForFriend(client: PoolClient, uid: string, lock: boolean) {
  const result = await client.query(
    `
      SELECT uid, username, role, status, coadmin_uid, created_by, raw_firestore_data
      FROM public.players_cache
      WHERE uid = $1
        AND deleted_at IS NULL
      LIMIT 1
      ${lock ? 'FOR UPDATE' : ''}
    `,
    [uid]
  );
  const row = result.rows[0] as PlayerScopeRow | undefined;
  if (!row) {
    return null;
  }
  if (cleanText(row.role).toLowerCase() !== 'player') {
    return null;
  }
  if (cleanText(row.status).toLowerCase() !== 'active') {
    return null;
  }
  return row;
}

async function validateFriendParticipants(
  client: PoolClient,
  actorUid: string,
  otherUid: string,
  lock: boolean
) {
  const pair = normalizeFriendPair(actorUid, otherUid);
  const actor = await readActivePlayerForFriend(client, actorUid, lock);
  const other = await readActivePlayerForFriend(client, otherUid, lock);
  if (!actor) {
    throw new Error('Player session required.');
  }
  if (!other) {
    throw new Error('Target player is inactive or unavailable.');
  }

  const actorCoadminUid = canonicalPlayerCoadminUid(actor);
  const otherCoadminUid = canonicalPlayerCoadminUid(other);
  if (!actorCoadminUid || !otherCoadminUid || actorCoadminUid !== otherCoadminUid) {
    throw new Error('Forbidden: players must be in the same coadmin scope.');
  }

  return { pair, actor, other, coadminUid: actorCoadminUid };
}

async function readFriendLinkForUpdate(client: PoolClient, linkId: string) {
  const result = await client.query(
    `
      SELECT *
      FROM public.player_friend_links_cache
      WHERE link_id = $1
      FOR UPDATE
    `,
    [linkId]
  );
  return (result.rows[0] as Record<string, unknown> | undefined) || null;
}

async function readFriendLink(client: PoolClient, linkId: string) {
  const result = await client.query(
    `
      SELECT *
      FROM public.player_friend_links_cache
      WHERE link_id = $1
        AND deleted_at IS NULL
      LIMIT 1
    `,
    [linkId]
  );
  const row = result.rows[0] as Record<string, unknown> | undefined;
  return row ? mapFriendLinkRow(row) : null;
}

export async function createPendingPlayerFriendLink(input: {
  actorUid: string;
  targetUid: string;
  source?: string;
}) {
  const actorUid = cleanText(input.actorUid);
  const targetUid = cleanText(input.targetUid);
  const source = cleanText(input.source) || null;
  const db = getPlayerMirrorPool();
  if (!db) {
    throw new Error('Postgres is unavailable.');
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { pair, other } = await validateFriendParticipants(client, actorUid, targetUid, true);
    const existing = await readFriendLinkForUpdate(client, pair.linkId);
    if (existing && !existing.deleted_at) {
      const status = cleanText(existing.status).toLowerCase();
      if (status === 'pending' || status === 'accepted') {
        await client.query('COMMIT');
        return {
          link: mapFriendLinkRow(existing),
          target: {
            uid: targetUid,
            username: cleanText(other.username) || 'Player',
          },
          duplicate: true,
        };
      }
      if (status === 'blocked') {
        throw new Error('Friend request is blocked.');
      }
    }

    const result = await client.query(
      `
        INSERT INTO public.player_friend_links_cache (
          link_id, participant_a_uid, participant_b_uid, participants,
          status, requested_by_uid, accepted_by_uid, source,
          created_at, updated_at, accepted_at, raw_firestore_data,
          source_system, mirrored_at, deleted_at
        )
        VALUES (
          $1, $2, $3, $4::text[],
          'pending', $5, NULL, $6,
          now(), now(), NULL, $7::jsonb,
          'sql', now(), NULL
        )
        ON CONFLICT (link_id) DO UPDATE SET
          participant_a_uid = EXCLUDED.participant_a_uid,
          participant_b_uid = EXCLUDED.participant_b_uid,
          participants = EXCLUDED.participants,
          status = 'pending',
          requested_by_uid = EXCLUDED.requested_by_uid,
          accepted_by_uid = NULL,
          source = COALESCE(EXCLUDED.source, public.player_friend_links_cache.source),
          updated_at = now(),
          accepted_at = NULL,
          raw_firestore_data = EXCLUDED.raw_firestore_data,
          source_system = 'sql',
          mirrored_at = now(),
          deleted_at = NULL
        RETURNING *
      `,
      [
        pair.linkId,
        pair.participantAUid,
        pair.participantBUid,
        pair.participants,
        actorUid,
        source,
        JSON.stringify({
          participants: pair.participants,
          status: 'pending',
          requestedByUid: actorUid,
          source,
          createdAt: new Date().toISOString(),
        }),
      ]
    );
    const link = mapFriendLinkRow(result.rows[0] as Record<string, unknown>);
    await emitPlayerFriendLinkOutboxEvent(client, {
      linkId: pair.linkId,
      participantUids: pair.participants,
      requestedByUid: actorUid,
      actorUid,
      status: 'pending',
      eventType: 'player_friend_request_created',
    });
    await client.query('COMMIT');
    return {
      link,
      target: {
        uid: targetUid,
        username: cleanText(other.username) || 'Player',
      },
      duplicate: false,
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function acceptPlayerFriendLink(input: { actorUid: string; otherUid: string }) {
  const actorUid = cleanText(input.actorUid);
  const otherUid = cleanText(input.otherUid);
  const db = getPlayerMirrorPool();
  if (!db) {
    throw new Error('Postgres is unavailable.');
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { pair, other } = await validateFriendParticipants(client, actorUid, otherUid, true);
    const existing = await readFriendLinkForUpdate(client, pair.linkId);
    if (!existing || existing.deleted_at) {
      throw new Error('Friend request not found.');
    }
    const status = cleanText(existing.status).toLowerCase();
    if (status === 'accepted') {
      await client.query('COMMIT');
      return {
        link: mapFriendLinkRow(existing),
        target: {
          uid: otherUid,
          username: cleanText(other.username) || 'Player',
        },
        duplicate: true,
      };
    }
    if (status !== 'pending') {
      throw new Error('Friend request cannot be accepted.');
    }
    const requestedByUid = cleanText(existing.requested_by_uid);
    if (requestedByUid === actorUid) {
      throw new Error('Only the recipient can accept this friend request.');
    }
    if (requestedByUid !== otherUid) {
      throw new Error('Friend request is invalid.');
    }

    const result = await client.query(
      `
        UPDATE public.player_friend_links_cache
        SET status = 'accepted',
            accepted_by_uid = $2,
            updated_at = now(),
            accepted_at = COALESCE(accepted_at, now()),
            mirrored_at = now(),
            raw_firestore_data = jsonb_set(
              jsonb_set(
                COALESCE(raw_firestore_data, '{}'::jsonb),
                '{status}',
                to_jsonb('accepted'::text),
                true
              ),
              '{acceptedByUid}',
              to_jsonb($2::text),
              true
            )
        WHERE link_id = $1
          AND deleted_at IS NULL
        RETURNING *
      `,
      [pair.linkId, actorUid]
    );
    const link = mapFriendLinkRow(result.rows[0] as Record<string, unknown>);
    await emitPlayerFriendLinkOutboxEvent(client, {
      linkId: pair.linkId,
      participantUids: pair.participants,
      requestedByUid,
      actorUid,
      status: 'accepted',
      eventType: 'player_friend_request_accepted',
    });
    await client.query('COMMIT');
    return {
      link,
      target: {
        uid: otherUid,
        username: cleanText(other.username) || 'Player',
      },
      duplicate: false,
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function declinePlayerFriendLink(input: { actorUid: string; otherUid: string }) {
  const actorUid = cleanText(input.actorUid);
  const otherUid = cleanText(input.otherUid);
  const db = getPlayerMirrorPool();
  if (!db) {
    throw new Error('Postgres is unavailable.');
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { pair, other } = await validateFriendParticipants(client, actorUid, otherUid, true);
    const existing = await readFriendLinkForUpdate(client, pair.linkId);
    if (!existing || existing.deleted_at) {
      throw new Error('Friend request not found.');
    }
    const status = cleanText(existing.status).toLowerCase();
    if (status === 'declined') {
      await client.query('COMMIT');
      return {
        link: mapFriendLinkRow(existing),
        target: {
          uid: otherUid,
          username: cleanText(other.username) || 'Player',
        },
        duplicate: true,
      };
    }
    if (status !== 'pending') {
      throw new Error('Friend request cannot be declined.');
    }
    const requestedByUid = cleanText(existing.requested_by_uid);
    if (requestedByUid === actorUid) {
      throw new Error('Only the recipient can decline this friend request.');
    }
    if (requestedByUid !== otherUid) {
      throw new Error('Friend request is invalid.');
    }

    const result = await client.query(
      `
        UPDATE public.player_friend_links_cache
        SET status = 'declined',
            accepted_by_uid = NULL,
            updated_at = now(),
            accepted_at = NULL,
            mirrored_at = now(),
            raw_firestore_data = jsonb_set(
              COALESCE(raw_firestore_data, '{}'::jsonb),
              '{status}',
              to_jsonb('declined'::text),
              true
            )
        WHERE link_id = $1
          AND deleted_at IS NULL
        RETURNING *
      `,
      [pair.linkId]
    );
    const link = mapFriendLinkRow(result.rows[0] as Record<string, unknown>);
    await emitPlayerFriendLinkOutboxEvent(client, {
      linkId: pair.linkId,
      participantUids: pair.participants,
      requestedByUid,
      actorUid,
      status: 'declined',
      eventType: 'player_friend_request_declined',
    });
    await client.query('COMMIT');
    return {
      link,
      target: {
        uid: otherUid,
        username: cleanText(other.username) || 'Player',
      },
      duplicate: false,
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function cancelPlayerFriendLink(input: { actorUid: string; otherUid: string }) {
  const actorUid = cleanText(input.actorUid);
  const otherUid = cleanText(input.otherUid);
  const db = getPlayerMirrorPool();
  if (!db) {
    throw new Error('Postgres is unavailable.');
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { pair, other } = await validateFriendParticipants(client, actorUid, otherUid, true);
    const existing = await readFriendLinkForUpdate(client, pair.linkId);
    if (!existing || existing.deleted_at) {
      throw new Error('Friend request not found.');
    }
    const requestedByUid = cleanText(existing.requested_by_uid);
    if (requestedByUid !== actorUid) {
      throw new Error('Only the sender can cancel this friend request.');
    }
    const status = cleanText(existing.status).toLowerCase();
    if (status === 'declined') {
      await client.query('COMMIT');
      return {
        link: mapFriendLinkRow(existing),
        target: {
          uid: otherUid,
          username: cleanText(other.username) || 'Player',
        },
        duplicate: true,
      };
    }
    if (status !== 'pending') {
      throw new Error('Friend request cannot be cancelled.');
    }

    const result = await client.query(
      `
        UPDATE public.player_friend_links_cache
        SET status = 'declined',
            accepted_by_uid = NULL,
            updated_at = now(),
            accepted_at = NULL,
            mirrored_at = now(),
            raw_firestore_data = COALESCE(raw_firestore_data, '{}'::jsonb)
              || jsonb_build_object(
                'status', 'declined',
                'resolution', 'cancelled',
                'cancelledByUid', $2::text
              )
        WHERE link_id = $1
          AND deleted_at IS NULL
        RETURNING *
      `,
      [pair.linkId, actorUid]
    );
    const link = mapFriendLinkRow(result.rows[0] as Record<string, unknown>);
    await emitPlayerFriendLinkOutboxEvent(client, {
      linkId: pair.linkId,
      participantUids: pair.participants,
      requestedByUid,
      actorUid,
      status: 'cancelled',
      eventType: 'player_friend_request_cancelled',
    });
    await client.query('COMMIT');
    return {
      link,
      target: {
        uid: otherUid,
        username: cleanText(other.username) || 'Player',
      },
      duplicate: false,
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function listPlayerFriendLinks(actorUid: string) {
  const db = getPlayerMirrorPool();
  const uid = cleanText(actorUid);
  if (!db) {
    throw new Error('Postgres is unavailable.');
  }
  if (!uid) {
    throw new Error('Player session required.');
  }

  const { rows } = await runMirrorPoolQuery<Record<string, unknown>>(
    db,
    `
      SELECT
        f.*,
        other.uid AS other_uid,
        other.username AS other_username,
        profile.avatar_emoji AS other_avatar_emoji,
        profile.avatar_name AS other_avatar_name,
        profile.bio AS other_bio,
        profile.avatar_image_url AS other_avatar_image_url
      FROM public.player_friend_links_cache f
      JOIN public.players_cache other
        ON other.uid = CASE
          WHEN f.participant_a_uid = $1 THEN f.participant_b_uid
          ELSE f.participant_a_uid
        END
       AND other.deleted_at IS NULL
       AND other.role = 'player'
       AND LOWER(COALESCE(other.status, '')) = 'active'
      LEFT JOIN public.player_chat_profiles profile
        ON profile.player_uid = other.uid
      WHERE f.deleted_at IS NULL
        AND (f.participant_a_uid = $1 OR f.participant_b_uid = $1)
        AND f.status IN ('pending', 'accepted')
      ORDER BY f.updated_at DESC NULLS LAST, f.created_at DESC NULLS LAST
      LIMIT 500
    `,
    [uid],
    { context: 'player_friend_links_list' }
  );

  return rows.map(mapFriendLinkRow);
}

export async function readPlayerFriendLinkForPair(uidA: string, uidB: string) {
  const db = getPlayerMirrorPool();
  if (!db) {
    throw new Error('Postgres is unavailable.');
  }
  const pair = normalizeFriendPair(uidA, uidB);
  const client = await db.connect();
  try {
    return await readFriendLink(client, pair.linkId);
  } finally {
    client.release();
  }
}
