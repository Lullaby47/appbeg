import 'server-only';

import { shouldBlockFirestoreFallback } from '@/lib/server/sqlRuntime';

export type FirebaseUsageRuntime = 'client' | 'server' | 'admin' | 'cold' | 'unknown';

export type FirebaseUsageAuditInput = {
  file: string;
  route?: string | null;
  feature: string;
  operation: string;
  runtime?: FirebaseUsageRuntime;
  allowed?: boolean;
  reason?: string;
  details?: Record<string, unknown>;
};

export function classifyFirebaseRuntime(file: string): FirebaseUsageRuntime {
  const normalized = String(file || '').replace(/\\/g, '/');
  if (normalized.includes('/app/api/')) return 'server';
  if (normalized.includes('/scripts/') || normalized.includes('/migrations/')) return 'cold';
  if (normalized.includes('/lib/firebase/admin')) return 'admin';
  if (
    normalized.includes('/app/') ||
    normalized.includes('/components/') ||
    normalized.includes('/features/')
  ) {
    return 'client';
  }
  if (normalized.includes('/lib/server/')) return 'server';
  return 'unknown';
}

export function isFirebaseUsageAllowedInSqlMode(input: {
  runtime?: FirebaseUsageRuntime;
  operation?: string;
  feature?: string;
}) {
  if (!shouldBlockFirestoreFallback()) {
    return { allowed: true, reason: 'legacy_firestore_mode' };
  }

  const runtime = input.runtime || 'unknown';
  const operation = String(input.operation || '').toLowerCase();
  const feature = String(input.feature || '').toLowerCase();

  if (runtime === 'client') {
    return { allowed: false, reason: 'client_firestore_blocked_sql_mode' };
  }

  if (runtime === 'cold') {
    return { allowed: true, reason: 'cold_path_backfill_or_audit' };
  }

  if (feature.includes('mirror') || feature.includes('backfill')) {
    return { allowed: false, reason: 'mirror_write_blocked_sql_authority' };
  }

  if (operation === 'read' && runtime === 'server') {
    return { allowed: false, reason: 'server_firestore_read_blocked_sql_mode' };
  }

  if (operation === 'write' || operation === 'transaction' || operation === 'batch') {
    return { allowed: false, reason: 'server_firestore_write_blocked_sql_authority' };
  }

  return { allowed: false, reason: 'firestore_blocked_sql_mode' };
}

export function logFirebaseUsageAudit(input: FirebaseUsageAuditInput) {
  const runtime = input.runtime ?? classifyFirebaseRuntime(input.file);
  const policy =
    input.allowed === undefined
      ? isFirebaseUsageAllowedInSqlMode({
          runtime,
          operation: input.operation,
          feature: input.feature,
        })
      : { allowed: input.allowed, reason: input.reason || 'explicit' };

  console.info('[FIREBASE_USAGE_AUDIT]', {
    file: input.file,
    route: input.route ?? null,
    feature: input.feature,
    operation: input.operation,
    runtime,
    allowed: policy.allowed,
    reason: input.reason ?? policy.reason,
    sql_mode_blocked: shouldBlockFirestoreFallback(),
    ...(input.details || {}),
  });

  if (shouldBlockFirestoreFallback() && !policy.allowed) {
    console.warn('[FIREBASE_USAGE_BLOCKED]', {
      file: input.file,
      route: input.route ?? null,
      feature: input.feature,
      operation: input.operation,
      reason: input.reason ?? policy.reason,
    });
  }

  return policy;
}

export function assertFirebaseUsageBlockedInSqlMode(input: FirebaseUsageAuditInput) {
  const policy = logFirebaseUsageAudit(input);
  if (shouldBlockFirestoreFallback() && !policy.allowed) {
    throw new Error(
      `firebase_usage_blocked:${input.feature}:${input.operation}:${policy.reason}`
    );
  }
  return policy;
}
