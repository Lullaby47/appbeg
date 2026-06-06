import { NextResponse } from 'next/server';

import { requireApiUser } from '@/lib/firebase/apiAuth';
import { mirrorAutomationJobById } from '@/lib/sql/automationJobsCache';

type Body = {
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

    const mirrored = await mirrorAutomationJobById(jobId, 'appbeg_browser');
    return NextResponse.json({ success: true, mirrored });
  } catch (error) {
    console.error('[AUTOMATION_JOBS_CACHE] mirror failed', { error });
    return NextResponse.json({ error: 'Failed to mirror automation job.' }, { status: 500 });
  }
}
