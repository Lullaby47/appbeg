import { FieldValue } from 'firebase-admin/firestore';
import { NextResponse } from 'next/server';

import { adminAuth, adminDb } from '@/lib/firebase/admin';
import { requireApiUser } from '@/lib/firebase/apiAuth';
import { isAuthoritySqlWriteEnabled } from '@/lib/server/authoritySqlWrite';
import { createImpersonationSession } from '@/lib/sql/appSessions';
import { insertImpersonationLogInSql } from '@/lib/sql/impersonationLogs';
import { cleanText } from '@/lib/sql/playerMirrorCommon';
import { lookupApiUserProfileFromSqlCache } from '@/lib/sql/playersCache';

export const runtime = 'nodejs';

const IMPERSONATION_TTL_SECONDS = 60 * 60;

function appSessionIdFromRequest(request: Request) {
  return cleanText(request.headers.get('X-App-Session-Id'));
}

function staffBelongsToCoadmin(
  profile: { coadminUid: string | null; createdBy?: string | null },
  coadminUid: string
) {
  const scopeUid = cleanText(profile.coadminUid) || cleanText(profile.createdBy);
  return scopeUid === coadminUid;
}

function isStaffImpersonationAllowed(status: string | null) {
  return cleanText(status).toLowerCase() === 'active';
}

async function mirrorImpersonationLog(input: {
  coadminUid: string;
  coadminUsername: string;
  staffUid: string;
  staffUsername: string;
}) {
  if (isAuthoritySqlWriteEnabled()) {
    return insertImpersonationLogInSql({
      coadminUid: input.coadminUid,
      coadminUsername: input.coadminUsername,
      staffUid: input.staffUid,
      staffUsername: input.staffUsername,
    });
  }

  try {
    await adminDb.collection('impersonationLogs').add({
      coadminUid: input.coadminUid,
      coadminUsername: input.coadminUsername,
      staffUid: input.staffUid,
      staffUsername: input.staffUsername,
      createdAt: FieldValue.serverTimestamp(),
      source: 'coadmin_behaviours',
    });
    return true;
  } catch (error) {
    console.warn('[USER_IMPERSONATION_SQL] firestore log mirror failed', {
      coadminUid: input.coadminUid,
      staffUid: input.staffUid,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

async function createFirebaseCustomTokenFallback(staffUid: string, coadminUid: string) {
  try {
    return await adminAuth.createCustomToken(staffUid, {
      impersonatedByUid: coadminUid,
      impersonatedByRole: 'coadmin',
      impersonation: true,
    });
  } catch (error) {
    console.warn('[USER_IMPERSONATION_SQL] firebase custom token fallback failed', {
      staffUid,
      coadminUid,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export async function POST(request: Request) {
  const startedAt = Date.now();
  const authoritySql = isAuthoritySqlWriteEnabled();
  try {
    const auth = await requireApiUser(request, ['coadmin']);
    if ('response' in auth) {
      return auth.response;
    }
    const callerUid = auth.user.uid;
    const coadminUsername = auth.user.username || 'Coadmin';
    console.info('[COADMIN_IMPERSONATE_STAFF_AUTH]', {
      auth_path: auth.authPath,
      uid: callerUid,
      app_session_used: auth.authPath.startsWith('app_session'),
    });

    const body = (await request.json()) as { staffUid?: string };
    const staffUid = String(body.staffUid || '').trim();
    if (!staffUid) {
      return NextResponse.json({ error: 'staffUid is required.' }, { status: 400 });
    }

    const staffLookup = await lookupApiUserProfileFromSqlCache(staffUid);
    const staffProfile = staffLookup.profile;
    if (!staffProfile) {
      return NextResponse.json({ error: 'Staff account not found.' }, { status: 404 });
    }
    if (staffProfile.role !== 'staff') {
      return NextResponse.json({ error: 'Target account must be staff.' }, { status: 403 });
    }
    if (!staffBelongsToCoadmin(staffProfile, callerUid)) {
      return NextResponse.json({ error: 'Staff is outside your coadmin scope.' }, { status: 403 });
    }
    if (!isStaffImpersonationAllowed(staffProfile.status)) {
      return NextResponse.json(
        { error: 'Staff account is not active and cannot be impersonated.' },
        { status: 403 }
      );
    }

    const originalSessionId = appSessionIdFromRequest(request);

    try {
      const session = await createImpersonationSession({
        staffUid: staffProfile.uid,
        staffUsername: staffProfile.username || 'Staff',
        staffCoadminUid: staffProfile.coadminUid || callerUid,
        coadminUid: callerUid,
        coadminUsername,
        originalSessionId,
        ttlSeconds: IMPERSONATION_TTL_SECONDS,
      });

      const auditOk = await mirrorImpersonationLog({
        coadminUid: callerUid,
        coadminUsername,
        staffUid: staffProfile.uid,
        staffUsername: staffProfile.username || 'Staff',
      });

      console.info('[USER_IMPERSONATION_SQL]', {
        coadminUid: callerUid,
        staffUid: staffProfile.uid,
        sessionId: session.sessionId,
        ttlSeconds: IMPERSONATION_TTL_SECONDS,
        sql_ok: true,
        firebase_fallback_used: false,
        audit_log_ok: auditOk,
        authority: authoritySql ? 'sql' : 'legacy',
        durationMs: Date.now() - startedAt,
      });

      return NextResponse.json({
        ok: true,
        success: true,
        mode: 'sql_session',
        authority: authoritySql ? 'sql' : 'legacy',
        sessionId: session.sessionId,
        expiresAt: session.expiresAt,
        staffUid: staffProfile.uid,
        staffUsername: staffProfile.username || 'Staff',
        redirectTo: '/staff',
        firebaseCustomToken: null,
        auditLogOk: auditOk,
      });
    } catch (error) {
      if (authoritySql) {
        console.info('[USER_IMPERSONATION_SQL]', {
          coadminUid: callerUid,
          staffUid: staffProfile.uid,
          sessionId: null,
          sql_ok: false,
          authority: 'sql',
          durationMs: Date.now() - startedAt,
          error: error instanceof Error ? error.message : String(error),
        });
        return NextResponse.json(
          { error: error instanceof Error ? error.message : 'Failed to impersonate staff.' },
          { status: 500 }
        );
      }

      console.warn('[USER_IMPERSONATION_SQL] sql session create failed, trying firebase fallback', {
        coadminUid: callerUid,
        staffUid: staffProfile.uid,
        error: error instanceof Error ? error.message : String(error),
      });

      const customToken = await createFirebaseCustomTokenFallback(staffProfile.uid, callerUid);
      if (!customToken) {
        return NextResponse.json(
          { error: error instanceof Error ? error.message : 'Failed to impersonate staff.' },
          { status: 500 }
        );
      }

      const auditOk = await mirrorImpersonationLog({
        coadminUid: callerUid,
        coadminUsername,
        staffUid: staffProfile.uid,
        staffUsername: staffProfile.username || 'Staff',
      });

      return NextResponse.json({
        ok: true,
        success: true,
        mode: 'firebase_custom_token',
        customToken,
        firebaseCustomToken: customToken,
        redirectTo: '/staff',
        staffUid: staffProfile.uid,
        staffUsername: staffProfile.username || 'Staff',
        auditLogOk: auditOk,
      });
    }
  } catch (error: unknown) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to impersonate staff.' },
      { status: 500 }
    );
  }
}
