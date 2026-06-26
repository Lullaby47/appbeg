import 'server-only';

import {
  cleanText,
  getPlayerMirrorPool,
  runMirrorPoolQuery,
  toIsoString,
} from '@/lib/sql/playerMirrorCommon';
import { readUserPresenceCacheByUids } from '@/lib/sql/userPresenceCache';

export type PlayerChatPeer = {
  uid: string;
  avatarName: string;
  bio: string;
  avatarImageUrl: string | null;
  lastSeenAt: string | null;
};

function mapPeerRow(row: Record<string, unknown>): PlayerChatPeer | null {
  const uid = cleanText(row.uid);
  const avatarName = cleanText(row.avatar_name);
  if (!uid || !avatarName) {
    return null;
  }
  return {
    uid,
    avatarName,
    bio: cleanText(row.bio),
    avatarImageUrl: cleanText(row.avatar_image_url) || null,
    lastSeenAt: null,
  };
}

export async function readPlayerChatPeers(input: {
  selfUid: string;
  coadminUid: string;
  search?: string;
  limit?: number;
}): Promise<PlayerChatPeer[] | null> {
  const db = getPlayerMirrorPool();
  const selfUid = cleanText(input.selfUid);
  const coadminUid = cleanText(input.coadminUid);
  if (!db || !selfUid || !coadminUid) {
    return null;
  }

  const search = cleanText(input.search);
  const limit = Math.max(1, Math.min(200, Number(input.limit || 100)));
  const params: unknown[] = [selfUid, coadminUid, limit];
  let searchSql = '';
  if (search) {
    params.push(`%${search.toLowerCase()}%`);
    searchSql = `
          AND (
            LOWER(profile.avatar_name) LIKE $${params.length}
            OR LOWER(profile.bio) LIKE $${params.length}
          )
    `;
  }

  try {
    const { rows } = await runMirrorPoolQuery<Record<string, unknown>>(
      db,
      `
        SELECT
          player.uid,
          profile.avatar_name,
          profile.bio,
          profile.avatar_image_url,
          profile.updated_at,
          profile.activated_at
        FROM public.players_cache player
        JOIN public.player_chat_profiles profile
          ON profile.player_uid = player.uid
        WHERE player.deleted_at IS NULL
          AND player.uid <> $1
          AND player.role = 'player'
          AND LOWER(COALESCE(player.status, 'active')) = 'active'
          AND (player.coadmin_uid = $2 OR player.created_by = $2)
          AND profile.coadmin_uid = $2
          AND profile.is_active = TRUE
          AND profile.review_status = 'approved'
          AND (profile.suspended_until IS NULL OR profile.suspended_until < now())
          ${searchSql}
        ORDER BY
          COALESCE(profile.activated_at, profile.updated_at) DESC NULLS LAST,
          LOWER(profile.avatar_name) ASC
        LIMIT $3
      `,
      params,
      { context: 'player_chat_bootstrap_peers' }
    );

    const peers = rows
      .map(mapPeerRow)
      .filter((peer): peer is PlayerChatPeer => Boolean(peer));
    if (!peers.length) {
      return [];
    }

    const presence = await readUserPresenceCacheByUids(peers.map((peer) => peer.uid));
    const lastSeenByUid = new Map(
      (presence || []).map((row) => [row.uid, toIsoString(row.lastSeenAt) || row.lastSeenAt])
    );

    return peers.map((peer) => ({
      ...peer,
      lastSeenAt: lastSeenByUid.get(peer.uid) || null,
    }));
  } catch (error) {
    console.warn('[PLAYER_CHAT_BOOTSTRAP] postgres read failed', {
      selfUid,
      coadminUid,
      error,
    });
    return null;
  }
}
