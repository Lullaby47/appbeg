import { NextResponse } from 'next/server';

import { getLatestOutboxIdForChannels } from '@/lib/sql/liveOutbox';

export type SnapshotClientCursor = {
  clientLatestOutboxId: number | null;
  forceFull: boolean;
};

export function parseSnapshotClientCursor(request: Request): SnapshotClientCursor {
  const url = new URL(request.url);
  const forceFull =
    url.searchParams.get('forceFull') === '1' || url.searchParams.get('bootstrap') === '1';

  let clientLatestOutboxId: number | null = null;
  const queryParam = url.searchParams.get('latestOutboxId');
  if (queryParam !== null && queryParam !== '') {
    const parsed = Number.parseInt(queryParam, 10);
    if (Number.isFinite(parsed) && parsed >= 0) {
      clientLatestOutboxId = parsed;
    }
  }

  if (clientLatestOutboxId === null) {
    const ifNoneMatch = request.headers.get('If-None-Match');
    if (ifNoneMatch) {
      const normalized = ifNoneMatch.replace(/"/g, '').trim();
      const parsed = Number.parseInt(normalized, 10);
      if (Number.isFinite(parsed) && parsed >= 0) {
        clientLatestOutboxId = parsed;
      }
    }
  }

  return { clientLatestOutboxId, forceFull };
}

export function logSnapshotNoChangeCheck(details: Record<string, unknown>) {
  console.info('[SNAPSHOT_NO_CHANGE_CHECK]', details);
}

export function logSnapshotNoChangeHit(details: Record<string, unknown>) {
  console.info('[SNAPSHOT_NO_CHANGE_HIT]', details);
}

export function logSnapshotNoChangeMiss(details: Record<string, unknown>) {
  console.info('[SNAPSHOT_NO_CHANGE_MISS]', details);
}

export function logSnapshotFullQuerySkipped(details: Record<string, unknown>) {
  console.info('[SNAPSHOT_FULL_QUERY_SKIPPED]', details);
}

export function logSnapshotFullQueryRun(details: Record<string, unknown>) {
  console.info('[SNAPSHOT_FULL_QUERY_RUN]', details);
}

export function logSnapshotPayloadSize(details: Record<string, unknown>) {
  console.info('[SNAPSHOT_PAYLOAD_SIZE]', details);
}

export function logSnapshotColumnPruned(details: Record<string, unknown>) {
  console.info('[SNAPSHOT_COLUMN_PRUNED]', details);
}

export type SnapshotNoChangeResult =
  | { kind: 'unchanged'; latestOutboxId: number; outboxQueryMs: number }
  | { kind: 'full'; latestOutboxId: number | null };

export async function trySnapshotNoChangeResponse(input: {
  request: Request;
  route: string;
  channels: string[];
  playerUid?: string;
  carerUid?: string;
}): Promise<SnapshotNoChangeResult | Response> {
  const cursor = parseSnapshotClientCursor(input.request);

  logSnapshotNoChangeCheck({
    route: input.route,
    playerUid: input.playerUid || null,
    carerUid: input.carerUid || null,
    clientLatestOutboxId: cursor.clientLatestOutboxId,
    forceFull: cursor.forceFull,
  });

  if (cursor.forceFull || cursor.clientLatestOutboxId === null) {
    logSnapshotFullQueryRun({
      route: input.route,
      reason: cursor.forceFull ? 'force_full' : 'missing_client_cursor',
    });
    return { kind: 'full', latestOutboxId: null };
  }

  const outboxStartedAt = Date.now();
  const outboxPack = await getLatestOutboxIdForChannels(input.channels);
  const outboxQueryMs = Date.now() - outboxStartedAt;
  const serverLatestOutboxId = outboxPack.latestOutboxId;

  if (serverLatestOutboxId === cursor.clientLatestOutboxId) {
    logSnapshotNoChangeHit({
      route: input.route,
      playerUid: input.playerUid || null,
      carerUid: input.carerUid || null,
      latestOutboxId: serverLatestOutboxId,
      outboxQueryMs,
    });
    logSnapshotFullQuerySkipped({
      route: input.route,
      latestOutboxId: serverLatestOutboxId,
      outboxQueryMs,
    });

    const body = {
      ok: true,
      unchanged: true,
      latestOutboxId: serverLatestOutboxId,
      snapshotAt: new Date().toISOString(),
      source: 'postgres_snapshot_unchanged',
    };
    const etag = `"${serverLatestOutboxId}"`;
    const ifNoneMatch = input.request.headers.get('If-None-Match');
    if (ifNoneMatch === etag || ifNoneMatch === String(serverLatestOutboxId)) {
      return new NextResponse(null, {
        status: 304,
        headers: {
          ETag: etag,
          'Cache-Control': 'no-cache, no-transform',
        },
      });
    }

    return NextResponse.json(body, {
      headers: {
        ETag: etag,
        'Cache-Control': 'no-cache, no-transform',
      },
    });
  }

  logSnapshotNoChangeMiss({
    route: input.route,
    playerUid: input.playerUid || null,
    carerUid: input.carerUid || null,
    clientLatestOutboxId: cursor.clientLatestOutboxId,
    serverLatestOutboxId,
    outboxQueryMs,
  });
  logSnapshotFullQueryRun({
    route: input.route,
    reason: 'outbox_cursor_advanced',
    clientLatestOutboxId: cursor.clientLatestOutboxId,
    serverLatestOutboxId,
  });

  return { kind: 'full', latestOutboxId: serverLatestOutboxId };
}
