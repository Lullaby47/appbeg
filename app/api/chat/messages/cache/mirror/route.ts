import { NextResponse } from 'next/server';

import { adminDb } from '@/lib/firebase/admin';
import { apiError, requireApiUser } from '@/lib/firebase/apiAuth';
import {
  isCacheSqlAuthoritative,
  logCacheSqlRead,
  mirrorSqlSkipResponse,
} from '@/lib/server/cacheSqlRead';
import { logFirestoreTouch, routeFromRequest } from '@/lib/server/firestoreTouchAudit';
import {
  mirrorChatMessageSnapshot,
  upsertChatMessageCache,
} from '@/lib/sql/chatMessagesCache';

type MirrorBody = {
  conversationId?: unknown;
  messageId?: unknown;
  messageIds?: unknown;
  action?: unknown;
  raw?: unknown;
};

function cleanText(value: unknown) {
  return String(value || '').trim();
}

function readMessageIds(body: MirrorBody) {
  const ids = Array.isArray(body.messageIds) ? body.messageIds : [body.messageId];
  return ids.map(cleanText).filter(Boolean).slice(0, 200);
}

function readRawRecord(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

export async function POST(request: Request) {
  const startedAt = Date.now();
  const route = routeFromRequest(request);
  const auth = await requireApiUser(request, [
    'admin',
    'coadmin',
    'staff',
    'carer',
    'player',
  ]);
  if ('response' in auth) {
    return auth.response;
  }

  const body = (await request.json().catch(() => ({}))) as MirrorBody;
  const action = cleanText(body.action) || 'upsert';
  const conversationId = cleanText(body.conversationId);
  const messageIds = readMessageIds(body);
  const raw = readRawRecord(body.raw);

  if (action !== 'upsert') {
    return apiError('Invalid mirror action.', 400);
  }

  if (raw && conversationId && messageIds.length === 1) {
    const mirrored = await upsertChatMessageCache({
      firebaseId: messageIds[0],
      conversationId,
      raw,
      source: 'appbeg_browser_write',
    });
    logCacheSqlRead(route, {
      action: 'upsert_raw',
      conversationId,
      messageId: messageIds[0],
      mirrored,
      durationMs: Date.now() - startedAt,
    });
    return NextResponse.json({ success: mirrored, mirroredCount: mirrored ? 1 : 0 });
  }

  if (!conversationId || !messageIds.length) {
    return apiError('conversationId and messageId are required.', 400);
  }

  if (isCacheSqlAuthoritative()) {
    return mirrorSqlSkipResponse(route, 'conversations/messages', {
      count: messageIds.length,
    });
  }

  logFirestoreTouch({
    firestore_touch_type: 'mirror_write_can_disable',
    route,
    operation: 'read',
    collection: 'conversations/messages',
    details: { action: 'upsert', conversationId, count: messageIds.length },
  });

  const snaps = await Promise.all(
    messageIds.map((messageId) =>
      adminDb
        .collection('conversations')
        .doc(conversationId)
        .collection('messages')
        .doc(messageId)
        .get()
    )
  );
  const mirrored = await Promise.all(
    snaps.map((snap) => mirrorChatMessageSnapshot(conversationId, snap))
  );

  return NextResponse.json({
    success: true,
    mirrored: mirrored.filter(Boolean).length,
  });
}
