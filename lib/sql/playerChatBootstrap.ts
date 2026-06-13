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
  username: string;
  lastSeenAt: string | null;
};

function mapPeerRow(row: Record<string, unknown>): PlayerChatPeer | null {
  const uid = cleanText(row.uid);
  const username = cleanText(row.username);
  if (!uid || !username) {
    return null;
  }
  return {
    uid,
    username,
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
    searchSql = `AND LOWER(username) LIKE $${params.length}`;
  }

  try {
    const { rows } = await runMirrorPoolQuery<Record<string, unknown>>(
      db,
      `
        SELECT uid, username, updated_at, created_at, mirrored_at
        FROM public.players_cache
        WHERE deleted_at IS NULL
          AND uid <> $1
          AND role = 'player'
          AND LOWER(COALESCE(status, 'active')) = 'active'
          AND (coadmin_uid = $2 OR created_by = $2)
          ${searchSql}
        ORDER BY
          COALESCE(updated_at, created_at, mirrored_at) DESC NULLS LAST,
          username ASC
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
