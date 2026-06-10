import 'server-only';

import type { DocumentSnapshot } from 'firebase-admin/firestore';

import {
  cleanText,
  getPlayerMirrorPool,
  normalizeJson,
  runMirrorPoolQuery,
  toIsoString,
} from '@/lib/sql/playerMirrorCommon';

export type CachedConversation = {
  id: string;
  participantUids: string[];
  lastMessage: string | null;
  lastMessageSenderUid: string | null;
  unreadCounts: Record<string, number>;
  updatedAt: string | null;
};

function parseParticipantUids(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((entry) => cleanText(entry)).filter(Boolean);
}

function parseUnreadCounts(value: unknown): Record<string, number> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  const out: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const count = Number(raw);
    if (Number.isFinite(count) && count > 0) {
      out[key] = count;
    }
  }
  return out;
}

function mapConversationRow(row: Record<string, unknown>): CachedConversation | null {
  const id = cleanText(row.firebase_id);
  if (!id) {
    return null;
  }
  return {
    id,
    participantUids: parseParticipantUids(row.participant_uids),
    lastMessage: cleanText(row.last_message) || null,
    lastMessageSenderUid: cleanText(row.last_message_sender_uid) || null,
    unreadCounts: parseUnreadCounts(row.unread_counts),
    updatedAt: toIsoString(row.updated_at),
  };
}

function participantsFromRaw(raw: Record<string, unknown>) {
  const participants = raw.participants ?? raw.participant_uids ?? raw.participantUids;
  return parseParticipantUids(participants);
}

function unreadCountsFromRaw(raw: Record<string, unknown>) {
  return parseUnreadCounts(raw.unreadCounts ?? raw.unread_counts);
}

export async function upsertConversationCache(input: {
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
  const participantUids = participantsFromRaw(raw);
  const unreadCounts = unreadCountsFromRaw(raw);

  try {
    await db.query(
      `
        INSERT INTO public.conversations_cache (
          firebase_id,
          participant_uids,
          last_message,
          last_message_sender_uid,
          unread_counts,
          updated_at,
          raw_firestore_data,
          source,
          mirrored_at,
          deleted_at
        )
        VALUES (
          $1,
          $2::jsonb,
          NULLIF($3, ''),
          NULLIF($4, ''),
          $5::jsonb,
          $6::timestamptz,
          $7::jsonb,
          $8,
          now(),
          NULL
        )
        ON CONFLICT (firebase_id) DO UPDATE SET
          participant_uids = EXCLUDED.participant_uids,
          last_message = EXCLUDED.last_message,
          last_message_sender_uid = EXCLUDED.last_message_sender_uid,
          unread_counts = EXCLUDED.unread_counts,
          updated_at = EXCLUDED.updated_at,
          raw_firestore_data = EXCLUDED.raw_firestore_data,
          source = EXCLUDED.source,
          mirrored_at = now(),
          deleted_at = NULL
      `,
      [
        firebaseId,
        JSON.stringify(participantUids),
        cleanText(raw.lastMessage ?? raw.last_message),
        cleanText(raw.lastMessageSenderUid ?? raw.last_message_sender_uid),
        JSON.stringify(unreadCounts),
        toIsoString(raw.updatedAt ?? raw.updated_at),
        JSON.stringify(normalizedRaw),
        cleanText(input.source) || 'mirror',
      ]
    );
    return true;
  } catch (error) {
    console.warn('[CONVERSATIONS_CACHE] upsert failed', { firebaseId, error });
    return false;
  }
}

export async function mergeConversationUnreadCounts(input: {
  firebaseId: string;
  unreadCounts: Record<string, number>;
  source?: string;
}) {
  const db = getPlayerMirrorPool();
  const firebaseId = cleanText(input.firebaseId);
  if (!db || !firebaseId) {
    return false;
  }

  const unreadCounts = parseUnreadCounts(input.unreadCounts);
  if (!Object.keys(unreadCounts).length) {
    return true;
  }

  try {
    await db.query(
      `
        UPDATE public.conversations_cache
        SET unread_counts = coalesce(unread_counts, '{}'::jsonb) || $2::jsonb,
            source = $3,
            mirrored_at = now(),
            deleted_at = NULL
        WHERE firebase_id = $1
      `,
      [firebaseId, JSON.stringify(unreadCounts), cleanText(input.source) || 'api']
    );
    return true;
  } catch (error) {
    console.warn('[CONVERSATIONS_CACHE] unread merge failed', { firebaseId, error });
    return false;
  }
}

export async function mirrorConversationSnapshot(snap: DocumentSnapshot) {
  if (!snap.exists) {
    return false;
  }
  return upsertConversationCache({
    firebaseId: snap.id,
    raw: snap.data() as Record<string, unknown>,
    source: 'mirror',
  });
}

export async function tombstoneConversationCache(firebaseId: string, source = 'mirror') {
  const db = getPlayerMirrorPool();
  const cleanId = cleanText(firebaseId);
  if (!db || !cleanId) {
    return false;
  }

  try {
    await db.query(
      `
        UPDATE public.conversations_cache
        SET deleted_at = now(), source = $2, mirrored_at = now()
        WHERE firebase_id = $1
      `,
      [cleanId, cleanText(source) || 'mirror']
    );
    return true;
  } catch (error) {
    console.warn('[CONVERSATIONS_CACHE] tombstone failed', { firebaseId: cleanId, error });
    return false;
  }
}

export async function readConversationsCacheForUser(
  uid: string
): Promise<CachedConversation[] | null> {
  const cleanUid = cleanText(uid);
  const db = getPlayerMirrorPool();
  if (!db || !cleanUid) {
    return [];
  }

  try {
    const { rows } = await runMirrorPoolQuery<Record<string, unknown>>(
      db,
      `
        SELECT firebase_id, participant_uids, last_message, last_message_sender_uid, unread_counts, updated_at
        FROM public.conversations_cache
        WHERE deleted_at IS NULL
          AND participant_uids ? $1
        ORDER BY updated_at DESC NULLS LAST
        LIMIT 200
      `,
      [cleanUid],
      { context: 'conversations_cache_read' }
    );
    return rows.map(mapConversationRow).filter((row): row is CachedConversation => Boolean(row));
  } catch (error) {
    console.warn('[CONVERSATIONS_CACHE] read failed', { uid: cleanUid, error });
    return null;
  }
}
