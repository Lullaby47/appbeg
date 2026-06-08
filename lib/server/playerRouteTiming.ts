import 'server-only';

export type PlayerRouteFirestoreRead = {
  collection: string;
  path: string;
  kind: 'get' | 'query' | 'transaction';
  durationMs: number;
  docCount?: number;
  source: 'firestore';
};

export type PlayerRouteSqlRead = {
  table: string;
  operation: string;
  durationMs: number;
  rowCount?: number;
  source: 'postgres';
};

export type PlayerRouteReadTrace = {
  firestoreReads: PlayerRouteFirestoreRead[];
  sqlReads: PlayerRouteSqlRead[];
  sqlMs: number;
  firestoreMs: number;
};

export function createPlayerRouteReadTrace(): PlayerRouteReadTrace {
  return {
    firestoreReads: [],
    sqlReads: [],
    sqlMs: 0,
    firestoreMs: 0,
  };
}

export function recordSqlRead(
  trace: PlayerRouteReadTrace,
  input: Omit<PlayerRouteSqlRead, 'source' | 'durationMs'> & { durationMs: number }
) {
  trace.sqlReads.push({ ...input, source: 'postgres' });
  trace.sqlMs += input.durationMs;
}

export function recordFirestoreRead(
  trace: PlayerRouteReadTrace,
  input: Omit<PlayerRouteFirestoreRead, 'source' | 'durationMs'> & { durationMs: number }
) {
  trace.firestoreReads.push({ ...input, source: 'firestore' });
  trace.firestoreMs += input.durationMs;
}

export function logPlayerRouteTiming(tag: string, input: Record<string, unknown>) {
  const trace = input.trace as PlayerRouteReadTrace | undefined;
  const dataMs = (trace?.sqlMs || 0) + (trace?.firestoreMs || 0);
  console.info(tag, {
    ...input,
    data_sql_ms: trace?.sqlMs || 0,
    data_firestore_ms: trace?.firestoreMs || 0,
    data_ms: dataMs,
    firestore_reads:
      trace?.firestoreReads || (input.firestore_reads as PlayerRouteFirestoreRead[] | undefined) || [],
    sql_reads: trace?.sqlReads || (input.sql_reads as PlayerRouteSqlRead[] | undefined) || [],
  });
}
