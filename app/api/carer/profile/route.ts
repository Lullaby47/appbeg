import { NextResponse } from 'next/server';

import { apiError, requireCarerApiUser } from '@/lib/firebase/apiAuth';
import { loadCarerDashboardProfileFromSql } from '@/lib/server/carerProfileRead';

export async function GET(request: Request) {
  const auth = await requireCarerApiUser(request);
  if ('response' in auth) {
    return auth.response;
  }

  const sqlProfile = await loadCarerDashboardProfileFromSql(auth.user.uid);
  console.info('[CARER_PROFILE]', {
    uid: auth.user.uid,
    auth_path: auth.authPath,
    source: auth.timing.source,
    firestore_fallback: auth.timing.firestore_fallback,
    sql_profile_ms: auth.timing.sql_profile_ms,
    user_doc_ms: auth.timing.user_doc_ms,
    profile_source: sqlProfile.profile?.source || null,
    miss_reason: sqlProfile.missReason,
  });
  if (sqlProfile.profile) {
    return NextResponse.json(sqlProfile.profile);
  }

  if (auth.authPath.startsWith('app_session')) {
    return NextResponse.json({
      uid: auth.user.uid,
      username: auth.user.username || 'Carer',
      role: auth.user.role,
      coadminUid: auth.user.coadminUid,
      automationAgentId: auth.user.automationAgentId,
      paymentQrUrl: '',
      paymentQrPublicId: '',
      paymentDetails: '',
      cashBoxNpr: 0,
      source: 'postgres',
    });
  }

  return apiError('Carer profile not found.', 404);
}
