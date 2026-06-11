import { NextResponse } from 'next/server';

import { claimCarerTaskAsAdmin } from '@/lib/automation/carerClaimTaskAdmin';
import type { GameLoginDetailsInput } from '@/lib/automation/automationClaimPayload';
import { apiError, requireCarerApiUser, scopedCoadminUid } from '@/lib/firebase/apiAuth';
import { isAuthoritySqlWriteEnabled } from '@/lib/server/authoritySqlWrite';

const ROUTE = '/api/carer/tasks/claim';

type Body = {
  taskId?: unknown;
  currentUsername?: unknown;
  carerName?: unknown;
  gameLoginDetails?: GameLoginDetailsInput | null;
};

export async function POST(request: Request) {
  const auth = await requireCarerApiUser(request);
  if ('response' in auth) {
    return auth.response;
  }

  const body = (await request.json().catch(() => ({}))) as Body;
  const taskId = String(body.taskId || '').trim();
  if (!taskId) {
    return apiError('taskId is required.', 400);
  }

  const carerCoadminUid = scopedCoadminUid(auth.user);
  if (!carerCoadminUid) {
    return apiError('Coadmin scope is required.', 400);
  }

  try {
    const result = await claimCarerTaskAsAdmin({
      carerUid: auth.user.uid,
      carerCoadminUid,
      taskId,
      currentUsername: String(body.currentUsername || '').trim() || null,
      carerName: String(body.carerName || auth.user.username || '').trim() || null,
      gameLoginDetails: body.gameLoginDetails ?? null,
      trustedUser: {
        username: auth.user.username,
        automationAgentId: auth.user.automationAgentId ?? null,
      },
      skipLocked: isAuthoritySqlWriteEnabled(),
      allowRetryPendingClaim: true,
    });

    console.info('[CARER_START_TASK_SQL_ONLY]', {
      route: ROUTE,
      taskId: result.taskId,
      carerUid: auth.user.uid,
      coadminUid: carerCoadminUid,
      jobId: result.jobId,
      firestoreAttempted: false,
    });

    return NextResponse.json({
      jobId: result.jobId,
      taskId: result.taskId,
      status: result.status,
      reusedExistingJob: result.reusedExistingJob,
      source: 'sql',
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to claim task.';
    return apiError(message, 409);
  }
}
