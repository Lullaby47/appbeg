const { cert, getApps, initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { Pool } = require('pg');

function argValue(name) {
  const prefix = `${name}=`;
  const index = process.argv.findIndex((arg) => arg === name || arg.startsWith(prefix));
  const hit = index >= 0 ? process.argv[index] : null;
  if (!hit) return null;
  if (hit === name) {
    const next = process.argv[index + 1];
    return next && !next.startsWith('--') ? next : 'true';
  }
  return hit.slice(prefix.length);
}

const DRY_RUN = argValue('--dry-run') !== null;
const ONLY_MISSING = argValue('--only-missing') !== null;
const LIMIT = Number(argValue('--limit') || '0') || 0;
const INCLUDE_MESSAGES = argValue('--include-messages') !== null;

function requiredEnv(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function clean(value) {
  return String(value || '').trim();
}

function initFirebase() {
  const base64 = requiredEnv('FIREBASE_SERVICE_ACCOUNT_BASE64');
  const serviceAccount = JSON.parse(Buffer.from(base64, 'base64').toString('utf8'));
  return getApps().length === 0
    ? initializeApp({ credential: cert(serviceAccount) })
    : getApps()[0];
}

function createPgPool() {
  const connectionString = clean(process.env.DATABASE_URL || process.env.POSTGRES_URL);
  if (connectionString) return new Pool({ connectionString, connectionTimeoutMillis: 10_000 });
  return new Pool({
    host: clean(process.env.APPBEG_PG_HOST || '127.0.0.1'),
    port: Number(process.env.APPBEG_PG_PORT || '5433'),
    database: clean(process.env.APPBEG_PG_DATABASE || 'appbeg'),
    user: clean(process.env.APPBEG_PG_USER || 'appbeg_user'),
    password: requiredEnv('APPBEG_PG_PASSWORD'),
    connectionTimeoutMillis: 10_000,
  });
}

function toDate(value) {
  if (!value) return null;
  if (value instanceof Date) return value;
  if (typeof value === 'string') {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  if (typeof value.toDate === 'function') return value.toDate();
  if (typeof value.toMillis === 'function') return new Date(value.toMillis());
  if (typeof value.seconds === 'number') return new Date(value.seconds * 1000);
  if (typeof value._seconds === 'number') return new Date(value._seconds * 1000);
  return null;
}

function toIso(value) {
  const date = toDate(value);
  return date ? date.toISOString() : null;
}

function normalizeJson(value) {
  if (value === undefined || value === null) return null;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(normalizeJson);
  if (typeof value === 'object') {
    const date = toDate(value);
    if (date) return date.toISOString();
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, normalizeJson(child)]));
  }
  return value;
}

function parseParticipants(data) {
  const participants = data.participants || data.participant_uids || [];
  if (!Array.isArray(participants)) return [];
  return participants.map((entry) => clean(entry)).filter(Boolean);
}

function parseUnreadCounts(data) {
  const unread = data.unreadCounts || data.unread_counts || {};
  if (!unread || typeof unread !== 'object' || Array.isArray(unread)) return {};
  const out = {};
  for (const [key, raw] of Object.entries(unread)) {
    const count = Number(raw);
    if (Number.isFinite(count)) out[key] = count;
  }
  return out;
}

async function existingConversationIds(pool) {
  const result = await pool.query(
    'SELECT firebase_id FROM public.conversations_cache WHERE deleted_at IS NULL'
  );
  return new Set(result.rows.map((row) => String(row.firebase_id)));
}

async function existingMessageIds(pool) {
  const result = await pool.query(
    'SELECT firebase_id FROM public.chat_messages_cache WHERE deleted_at IS NULL'
  );
  return new Set(result.rows.map((row) => String(row.firebase_id)));
}

async function upsertConversation(pool, doc) {
  const data = doc.data() || {};
  await pool.query(
    `
      INSERT INTO public.conversations_cache (
        firebase_id, participant_uids, last_message, last_message_sender_uid,
        unread_counts, updated_at, raw_firestore_data, source, mirrored_at, deleted_at
      )
      VALUES (
        $1, $2::jsonb, NULLIF($3, ''), NULLIF($4, ''), $5::jsonb, $6::timestamptz,
        $7::jsonb, 'firebase_backfill', now(), NULL
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
      doc.id,
      JSON.stringify(parseParticipants(data)),
      clean(data.lastMessage),
      clean(data.lastMessageSenderUid),
      JSON.stringify(parseUnreadCounts(data)),
      toIso(data.updatedAt),
      JSON.stringify(normalizeJson(data) || {}),
    ]
  );
}

async function upsertMessage(pool, conversationId, doc) {
  const data = doc.data() || {};
  const type = clean(data.type).toLowerCase() === 'image' ? 'image' : 'text';
  await pool.query(
    `
      INSERT INTO public.chat_messages_cache (
        firebase_id, conversation_id, sender_uid, receiver_uid, type, text,
        image_url, image_public_id, created_at, raw_firestore_data, source, mirrored_at, deleted_at
      )
      VALUES (
        $1, $2, NULLIF($3, ''), NULLIF($4, ''), NULLIF($5, ''), NULLIF($6, ''),
        NULLIF($7, ''), NULLIF($8, ''), $9::timestamptz, $10::jsonb, 'firebase_backfill', now(), NULL
      )
      ON CONFLICT (firebase_id) DO UPDATE SET
        conversation_id = EXCLUDED.conversation_id,
        sender_uid = EXCLUDED.sender_uid,
        receiver_uid = EXCLUDED.receiver_uid,
        type = EXCLUDED.type,
        text = EXCLUDED.text,
        image_url = EXCLUDED.image_url,
        image_public_id = EXCLUDED.image_public_id,
        created_at = COALESCE(public.chat_messages_cache.created_at, EXCLUDED.created_at),
        raw_firestore_data = EXCLUDED.raw_firestore_data,
        source = EXCLUDED.source,
        mirrored_at = now(),
        deleted_at = NULL
    `,
    [
      doc.id,
      conversationId,
      clean(data.senderUid),
      clean(data.receiverUid),
      type,
      clean(data.text),
      clean(data.imageUrl),
      clean(data.imagePublicId),
      toIso(data.createdAt),
      JSON.stringify(normalizeJson(data) || {}),
    ]
  );
}

async function main() {
  initFirebase();
  const db = getFirestore();
  const pool = createPgPool();
  const conversationIds = ONLY_MISSING ? await existingConversationIds(pool) : new Set();
  const messageIds = ONLY_MISSING ? await existingMessageIds(pool) : new Set();
  let query = db.collection('conversations');
  if (LIMIT > 0) query = query.limit(LIMIT);
  const snapshot = await query.get();
  let wouldUpsertConversations = 0;
  let upsertedConversations = 0;
  let wouldUpsertMessages = 0;
  let upsertedMessages = 0;
  let errors = 0;

  for (const doc of snapshot.docs) {
    if (!ONLY_MISSING || !conversationIds.has(doc.id)) {
      wouldUpsertConversations += 1;
      if (!DRY_RUN) {
        try {
          await upsertConversation(pool, doc);
          upsertedConversations += 1;
        } catch (error) {
          errors += 1;
          console.error('[BACKFILL_CONVERSATIONS_CACHE] conversation failed', {
            firebaseId: doc.id,
            error,
          });
        }
      }
    }

    if (!INCLUDE_MESSAGES) continue;

    const messagesSnap = await doc.ref.collection('messages').get();
    for (const messageDoc of messagesSnap.docs) {
      if (ONLY_MISSING && messageIds.has(messageDoc.id)) continue;
      wouldUpsertMessages += 1;
      if (DRY_RUN) continue;
      try {
        await upsertMessage(pool, doc.id, messageDoc);
        upsertedMessages += 1;
      } catch (error) {
        errors += 1;
        console.error('[BACKFILL_CONVERSATIONS_CACHE] message failed', {
          conversationId: doc.id,
          messageId: messageDoc.id,
          error,
        });
      }
    }
  }

  await pool.end();
  console.log(
    JSON.stringify(
      {
        collection: 'conversations',
        firebase_count_seen: snapshot.size,
        include_messages: INCLUDE_MESSAGES,
        would_upsert_conversations: wouldUpsertConversations,
        upserted_conversations: upsertedConversations,
        would_upsert_messages: wouldUpsertMessages,
        upserted_messages: upsertedMessages,
        errors,
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error('[BACKFILL_CONVERSATIONS_CACHE] fatal', error);
  process.exitCode = 1;
});
