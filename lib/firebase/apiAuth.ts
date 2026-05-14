import { NextResponse } from 'next/server';

import { adminAuth, adminDb } from '@/lib/firebase/admin';

export type ApiRole = 'admin' | 'coadmin' | 'staff' | 'carer' | 'player';

export type ApiUser = {
  uid: string;
  role: ApiRole;
  username: string;
  coadminUid: string | null;
  createdBy: string | null;
  automationAgentId?: string | null;
};

function bearerToken(request: Request) {
  return (request.headers.get('Authorization') || '').match(/^Bearer\s+(\S+)$/i)?.[1] || '';
}

export function apiError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

export async function requireApiUser(
  request: Request,
  allowedRoles: ApiRole[]
): Promise<{ user: ApiUser } | { response: NextResponse }> {
  const token = bearerToken(request);
  if (!token) {
    return { response: apiError('Missing or invalid authorization.', 401) };
  }

  let decoded: { uid: string };
  try {
    decoded = await adminAuth.verifyIdToken(token);
  } catch {
    return { response: apiError('Invalid or expired authorization token.', 401) };
  }
  const snap = await adminDb.collection('users').doc(decoded.uid).get();
  if (!snap.exists) {
    return { response: apiError('User profile not found.', 401) };
  }

  const data = snap.data() || {};
  const role = String(data.role || '').toLowerCase() as ApiRole;
  if (!allowedRoles.includes(role)) {
    return { response: apiError('Forbidden.', 403) };
  }

  return {
    user: {
      uid: decoded.uid,
      role,
      username: String(data.username || ''),
      coadminUid: String(data.coadminUid || data.createdBy || '').trim() || null,
      createdBy: String(data.createdBy || '').trim() || null,
      automationAgentId: String(data.automationAgentId || '').trim() || null,
    },
  };
}

export function scopedCoadminUid(user: ApiUser) {
  if (user.role === 'coadmin') {
    return user.uid;
  }
  return user.coadminUid || user.createdBy || null;
}

export function belongsToScope(
  target: { coadminUid?: unknown; createdBy?: unknown },
  coadminUid: string
) {
  return (
    String(target.coadminUid || '').trim() === coadminUid ||
    String(target.createdBy || '').trim() === coadminUid
  );
}
