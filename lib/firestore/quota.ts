export function firestoreErrorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object') {
    return null;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

export function isFirestoreQuotaExhausted(error: unknown): boolean {
  const code = firestoreErrorCode(error);
  if (code === 'resource-exhausted') {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error || '');
  const lower = message.toLowerCase();
  return (
    lower.includes('resource_exhausted') ||
    lower.includes('resource-exhausted') ||
    lower.includes('quota exceeded') ||
    (lower.includes('quota') && lower.includes('exceeded'))
  );
}

export function logCarerStartupFirestore(input: {
  collection: string;
  path: string;
  reason: string;
  durationMs: number;
  ok: boolean;
  error_code?: string | null;
}) {
  console.info('[CARER_STARTUP_FIRESTORE]', {
    collection: input.collection,
    path: input.path,
    reason: input.reason,
    durationMs: input.durationMs,
    ok: input.ok,
    error_code: input.error_code ?? null,
  });
}
