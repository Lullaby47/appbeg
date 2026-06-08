import 'server-only';

import { firestoreErrorCode, isFirestoreQuotaExhausted } from '@/lib/firestore/quota';

export type RechargeFirestoreReadInput = {
  stage: string;
  collection: string;
  document: string;
};

export function logRechargeFirestoreRead(
  input: RechargeFirestoreReadInput & {
    duration_ms: number;
    ok: boolean;
    error_code?: string | null;
  }
) {
  const payload = {
    stage: input.stage,
    collection: input.collection,
    document: input.document,
    duration_ms: input.duration_ms,
    ok: input.ok,
    error_code: input.error_code ?? null,
  };
  console.info(`[RECHARGE_FIRESTORE_READ] ${JSON.stringify(payload)}`);
}

export async function timedRechargeFirestoreRead<T>(
  input: RechargeFirestoreReadInput,
  read: () => Promise<T>
): Promise<T> {
  const startedAt = Date.now();
  try {
    const value = await read();
    logRechargeFirestoreRead({
      ...input,
      duration_ms: Date.now() - startedAt,
      ok: true,
    });
    return value;
  } catch (error) {
    logRechargeFirestoreRead({
      ...input,
      duration_ms: Date.now() - startedAt,
      ok: false,
      error_code: firestoreErrorCode(error) || (error instanceof Error ? error.message : 'read_failed'),
    });
    throw error;
  }
}

export function isRechargeFirestoreQuotaError(error: unknown) {
  return isFirestoreQuotaExhausted(error);
}

export type RechargeSqlSourceLog = {
  playerGameLoginsSource: string;
  gameLoginsSource: string;
  firstRechargeSource: string;
  authoritySource: string;
  maintenanceSource: string;
  playerSessionSource?: string;
};

export function logRechargeSqlSource(input: RechargeSqlSourceLog) {
  console.info(`[RECHARGE_SQL_SOURCE] ${JSON.stringify(input)}`);
}
