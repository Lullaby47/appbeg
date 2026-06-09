import 'server-only';

/**
 * Firestore touch classification for migration tracking.
 *
 * authority_write_keep_for_now — task/money/session claim authority still on Firestore
 * mirror_write_can_disable     — SQL cache mirror / compatibility write; safe to drop in SQL mode
 * legacy_read_remove_now       — page-load/auth/live read fallback; remove when SQL authoritative
 */
export type FirestoreTouchType =
  | 'authority_write_keep_for_now'
  | 'mirror_write_can_disable'
  | 'legacy_read_remove_now';

export function routeFromRequest(request: Request) {
  try {
    return new URL(request.url).pathname;
  } catch {
    return 'unknown';
  }
}

export function logFirestoreTouch(input: {
  firestore_touch_type: FirestoreTouchType;
  route: string;
  operation: 'read' | 'write' | 'transaction' | 'batch';
  collection?: string | null;
  document_id?: string | null;
  sql_read_mode?: boolean;
  skipped?: boolean;
  details?: Record<string, unknown>;
}) {
  console.info('[FIRESTORE_TOUCH]', {
    firestore_touch_type: input.firestore_touch_type,
    route: input.route,
    operation: input.operation,
    collection: input.collection ?? null,
    document_id: input.document_id ?? null,
    sql_read_mode: input.sql_read_mode ?? null,
    skipped: input.skipped ?? false,
    ...(input.details || {}),
  });
}
