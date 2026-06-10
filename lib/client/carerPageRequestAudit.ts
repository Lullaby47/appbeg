'use client';

export function logCarerPageRequestAudit(input: {
  route: string;
  method: string;
  status: number;
  carerUid?: string | null;
  coadminUid?: string | null;
  role?: string | null;
  authPath?: string | null;
  reason: string;
}) {
  console.info('[CARER_PAGE_REQUEST_AUDIT]', input);
}

export function logCarerFirestoreBlockedSuppressed(input: {
  feature: string;
  file: string;
  operation: string;
  route?: string;
}) {
  console.info('[CARER_FIRESTORE_BLOCKED_SUPPRESSED]', {
    feature: input.feature,
    file: input.file,
    operation: input.operation,
    route:
      input.route ??
      (typeof window !== 'undefined' ? window.location.pathname || '/carer' : '/carer'),
    sqlMode: true,
    userVisible: false,
  });
}
