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

  mergeConversationUnreadCounts,
  mirrorConversationSnapshot,
  tombstoneConversationCache,
  upsertConversationCache,
} from '@/lib/sql/conversationsCache';

export const runtime = 'nodejs';

type MirrorBody = {
  conversationId?: unknown;
  conversationIds?: unknown;
  action?: unknown;
  raw?: unknown;
  unreadCounts?: unknown;
};

function cleanText(value: unknown) {
  return String(value || '').trim();
}

function readConversationIds(body: MirrorBody) {
  const ids = Array.isArray(body.conversationIds)
    ? body.conversationIds
    : [body.conversationId];
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
  const conversationIds = readConversationIds(body);
  const raw = readRawRecord(body.raw);

  if (action === 'mark_read') {
    if (!conversationIds.length) {
      return apiError('conversationId is required.', 400);
    }
    const unreadCounts = readRawRecord(body.unreadCounts) || {
      [auth.user.uid]: 0,
    };
    const mirrored = await Promise.all(
      conversationIds.map((conversationId) =>
        mergeConversationUnreadCounts({
          firebaseId: conversationId,
          unreadCounts: unreadCounts as Record<string, number>,
          source: 'appbeg_browser_write',
        })
      )
    );
    logCacheSqlRead(route, {
      action: 'mark_read',
      count: mirrored.filter(Boolean).length,
      durationMs: Date.now() - startedAt,
    });
    return NextResponse.json({
      success: true,
      mirrored: mirrored.filter(Boolean).length,
    });
  }

  if (action === 'tombstone') {
    if (!conversationIds.length) {
      return apiError('conversationId is required.', 400);
    }
    await Promise.all(
      conversationIds.map((conversationId) =>
        tombstoneConversationCache(conversationId, 'appbeg_browser_delete')
      )
    );
    return NextResponse.json({ success: true, mirrored: conversationIds.length });
  }

  if (action !== 'upsert') {
    return apiError('Invalid mirror action.', 400);
  }

  if (raw && conversationIds.length === 1) {
    const mirrored = await upsertConversationCache({
      firebaseId: conversationIds[0],
      raw,
      source: 'appbeg_browser_write',
    });
    logCacheSqlRead(route, {
      action: 'upsert_raw',
      conversationId: conversationIds[0],
      mirrored,
      durationMs: Date.now() - startedAt,
    });
    return NextResponse.json({ success: mirrored, mirroredCount: mirrored ? 1 : 0 });
  }

  if (!conversationIds.length) {
    return apiError('conversationId is required.', 400);
  }

  if (isCacheSqlAuthoritative()) {
    return mirrorSqlSkipResponse(route, 'conversations', { count: conversationIds.length });
  }

  logFirestoreTouch({
    firestore_touch_type: 'mirror_write_can_disable',
    route,
    operation: 'read',
    collection: 'conversations',
    details: { action: 'upsert', count: conversationIds.length },
  });

  const snaps = await Promise.all(
    conversationIds.map((conversationId) =>
      adminDb.collection('conversations').doc(conversationId).get()
    )
  );
  const mirrored = await Promise.all(snaps.map((snap) => mirrorConversationSnapshot(snap)));

  return NextResponse.json({
    success: true,
    mirrored: mirrored.filter(Boolean).length,
  });
}
