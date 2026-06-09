import { NextResponse } from 'next/server';

import { requireApiUser } from '@/lib/firebase/apiAuth';
import { isCacheSqlAuthoritative, mirrorSqlSkipResponse } from '@/lib/server/cacheSqlRead';
import {
  mirrorAutomationJobById,
  tombstoneAutomationJobCache,
} from '@/lib/sql/automationJobsCache';

type Body = {
  action?: unknown;
  jobId?: unknown;
};

export async function POST(request: Request) {
  try {
    const auth = await requireApiUser(request, ['admin', 'coadmin', 'staff', 'carer']);
    if ('response' in auth) return auth.response;
    const body = (await request.json().catch(() => ({}))) as Body;
    const jobId = String(body.jobId || '').trim();
    if (!jobId) {
      return NextResponse.json({ error: 'jobId is required.' }, { status: 400 });
    }

    const action = String(body.action || 'upsert').trim().toLowerCase();
    if (action !== 'upsert' && action !== 'tombstone') {
      return NextResponse.json({ error: 'action must be upsert or tombstone.' }, { status: 400 });
    }

    if (action === 'upsert' && isCacheSqlAuthoritative()) {
      return mirrorSqlSkipResponse('/api/automation-jobs/cache/mirror', 'automation_jobs', {
        jobId,
      });
    }

    const mirrored = action === 'tombstone'
      ? await tombstoneAutomationJobCache(jobId, 'appbeg_browser')
      : await mirrorAutomationJobById(jobId, 'appbeg_browser');
    return NextResponse.json({ success: true, mirrored });
  } catch (error) {
    console.error('[AUTOMATION_JOBS_CACHE] mirror failed', { error });
    return NextResponse.json({ error: 'Failed to mirror automation job.' }, { status: 500 });
  }
}
