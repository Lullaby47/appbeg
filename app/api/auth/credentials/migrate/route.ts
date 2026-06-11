import { NextResponse } from 'next/server';

import { hashPassword } from '@/lib/auth/passwordHash';
import { apiError } from '@/lib/firebase/apiAuth';
import { verifyLiveCarerApiToken } from '@/lib/firebase/liveAuthTokenCache';
import {
  authSqlEnvErrorResponse,
  authSqlProfileErrorResponse,
  logAuthSqlRouteStart,
} from '@/lib/server/authSqlReadErrors';
import {
  authSqlReadEnvLogFields,
  isAuthSqlReadEnabled,
} from '@/lib/server/authSqlRead';
import { lookupApiUserProfileFromSqlCache } from '@/lib/sql/playersCache';
import { cleanText } from '@/lib/sql/playerMirrorCommon';
import { upsertUserCredentials } from '@/lib/sql/userCredentials';

export const runtime = 'nodejs';

export const dynamic = 'force-dynamic';

type MigrateBody = {
  password?: unknown;
};

function bearerToken(request: Request) {
  return (request.headers.get('Authorization') || '').match(/^Bearer\s+(\S+)$/i)?.[1] || '';
}

function isLoginAllowedStatus(status: string | null, role: string) {
  const normalizedStatus = cleanText(status).toLowerCase();
  const normalizedRole = cleanText(role).toLowerCase();
  const isActive = normalizedStatus === 'active';
  const isBlockedPlayer = normalizedStatus === 'disabled' && normalizedRole === 'player';
  return isActive || isBlockedPlayer;
}

export async function POST(request: Request) {
  const totalStartedAt = Date.now();
  logAuthSqlRouteStart('credentials_migrate', authSqlReadEnvLogFields());

  if (isAuthSqlReadEnabled() && !authSqlReadEnvLogFields().database_url_configured) {
    console.info(
      '[SQL_CREDENTIALS_MIGRATE] uid=null role=null ok=false reason=missing_database_url total_ms=%s env=%j',
      Date.now() - totalStartedAt,
      authSqlReadEnvLogFields()
    );
    return authSqlEnvErrorResponse({ route: 'credentials_migrate' });
  }

  const token = bearerToken(request);
  if (!token) {
    console.info(
      '[SQL_CREDENTIALS_MIGRATE] uid=null role=null ok=false reason=missing_token total_ms=%s',
      Date.now() - totalStartedAt
    );
    return apiError('Missing or invalid authorization.', 401);
  }

  let body: MigrateBody = {};
  try {
    body = (await request.json()) as MigrateBody;
  } catch {
    console.info(
      '[SQL_CREDENTIALS_MIGRATE] uid=null role=null ok=false reason=invalid_json total_ms=%s',
      Date.now() - totalStartedAt
    );
    return apiError('Invalid JSON body.', 400);
  }

  const password = String(body.password || '');
  if (password.length < 6) {
    console.info(
      '[SQL_CREDENTIALS_MIGRATE] uid=null role=null ok=false reason=password_too_short total_ms=%s',
      Date.now() - totalStartedAt
    );
    return apiError('Password must be at least 6 characters.', 400);
  }

  const verifyStartedAt = Date.now();
  let identityUid = '';
  try {
    const verified = await verifyLiveCarerApiToken(token);
    identityUid = verified.uid;
  } catch {
    console.info(
      '[SQL_CREDENTIALS_MIGRATE] uid=null role=null ok=false reason=invalid_token verify_ms=%s total_ms=%s',
      Date.now() - verifyStartedAt,
      Date.now() - totalStartedAt
    );
    return apiError('Invalid or expired authorization token.', 401);
  }

  const sqlProfileStartedAt = Date.now();
  const sqlProfileLookup = await lookupApiUserProfileFromSqlCache(identityUid);
  const sqlProfileMs = Date.now() - sqlProfileStartedAt;

  if (!sqlProfileLookup.profile) {
    console.info(
      '[SQL_CREDENTIALS_MIGRATE] uid=%s role=null ok=false reason=%s sql_profile_ms=%s total_ms=%s env=%j',
      identityUid,
      sqlProfileLookup.missReason || 'profile_missing',
      sqlProfileMs,
      Date.now() - totalStartedAt,
      authSqlReadEnvLogFields()
    );
    if (isAuthSqlReadEnabled()) {
      return authSqlProfileErrorResponse(sqlProfileLookup, {
        route: 'credentials_migrate',
      });
    }
    return apiError('User profile not found.', 401);
  }

  const profile = sqlProfileLookup.profile;
  if (!isLoginAllowedStatus(profile.status, profile.role)) {
    console.info(
      '[SQL_CREDENTIALS_MIGRATE] uid=%s role=%s ok=false reason=account_not_active sql_profile_ms=%s total_ms=%s',
      profile.uid,
      profile.role,
      sqlProfileMs,
      Date.now() - totalStartedAt
    );
    return apiError('Account is not active.', 403);
  }

  const hashStartedAt = Date.now();
  let hashed: Awaited<ReturnType<typeof hashPassword>>;
  try {
    hashed = await hashPassword(password);
  } catch (error) {
    console.info(
      '[SQL_CREDENTIALS_MIGRATE] uid=%s role=%s ok=false reason=hash_failed hash_ms=%s total_ms=%s error=%s',
      profile.uid,
      profile.role,
      Date.now() - hashStartedAt,
      Date.now() - totalStartedAt,
      error instanceof Error ? error.message : String(error)
    );
    return apiError('Failed to store credentials.', 500);
  }
  const hashMs = Date.now() - hashStartedAt;

  try {
    await upsertUserCredentials({
      uid: profile.uid,
      passwordHash: hashed.hash,
      passwordAlgo: hashed.algo,
      migratedFromFirebase: true,
      mustReset: false,
    });
  } catch (error) {
    console.info(
      '[SQL_CREDENTIALS_MIGRATE] uid=%s role=%s ok=false reason=upsert_failed hash_ms=%s total_ms=%s error=%s',
      profile.uid,
      profile.role,
      hashMs,
      Date.now() - totalStartedAt,
      error instanceof Error ? error.message : String(error)
    );
    return apiError('Failed to store credentials.', 500);
  }

  console.info(
    '[SQL_CREDENTIALS_MIGRATE] uid=%s role=%s ok=true reason=stored hash_ms=%s sql_profile_ms=%s total_ms=%s',
    profile.uid,
    profile.role,
    hashMs,
    sqlProfileMs,
    Date.now() - totalStartedAt
  );

  return NextResponse.json({
    ok: true,
    uid: profile.uid,
    migrated: true,
  });
}
