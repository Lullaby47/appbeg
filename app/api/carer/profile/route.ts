import { NextResponse } from 'next/server';

import { apiError, requireApiUser } from '@/lib/firebase/apiAuth';
import { loadCarerDashboardProfileFromSql } from '@/lib/server/carerProfileRead';

export async function GET(request: Request) {
  const auth = await requireApiUser(request, ['carer']);
  if ('response' in auth) {
    return auth.response;
  }

  const sqlProfile = await loadCarerDashboardProfileFromSql(auth.user.uid);
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
