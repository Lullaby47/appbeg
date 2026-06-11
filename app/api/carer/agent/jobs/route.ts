import { NextResponse } from 'next/server';

import { isAuthoritySqlWriteEnabled } from '@/lib/server/authoritySqlWrite';
import {
  getAutomationAutoStateForAgent,
  getAutomationJobFromSql,
  getCarerTaskFromSql,
  getGameLoginDetailsForAgent,
  listQueuedAutomationJobsForAgent,
  runAgentJobAction,
  verifyAgentLinkedToCarerInSql,
} from '@/lib/sql/authorityAgentJobs';
import { apiError } from '@/lib/firebase/apiAuth';

function verifyAgentSecret(request: Request) {
  const expected = String(process.env.CARER_AUTOMATION_TICK_SECRET || '').trim();
  const provided = String(request.headers.get('x-carer-automation-tick-secret') || '').trim();
  return Boolean(expected && provided && provided === expected);
}

export async function GET(request: Request) {
  if (!isAuthoritySqlWriteEnabled()) {
    return apiError('SQL authority writes are disabled.', 503);
  }
  if (!verifyAgentSecret(request)) {
    return apiError('Unauthorized.', 401);
  }

  const url = new URL(request.url);
  const carerUid = String(url.searchParams.get('carerUid') || '').trim();
  const agentId = String(url.searchParams.get('agentId') || '').trim();
  const resource = String(url.searchParams.get('resource') || 'queued_jobs').trim().toLowerCase();
  const limit = Number(url.searchParams.get('limit') || 100);
  const jobId = String(url.searchParams.get('jobId') || '').trim();
  const taskId = String(url.searchParams.get('taskId') || '').trim();
  const coadminUid = String(url.searchParams.get('coadminUid') || '').trim();
  const gameName = String(url.searchParams.get('gameName') || '').trim();

  if (!carerUid || !agentId) {
    return apiError('carerUid and agentId are required.', 400);
  }

  try {
    if (resource === 'queued_jobs') {
      const jobs = await listQueuedAutomationJobsForAgent({ carerUid, agentId, limit });
      return NextResponse.json({ ok: true, jobs });
    }
    if (resource === 'job' && jobId) {
      const job = await getAutomationJobFromSql(jobId);
      return NextResponse.json({ ok: true, job });
    }
    if (resource === 'task' && taskId) {
      const task = await getCarerTaskFromSql(taskId);
      return NextResponse.json({ ok: true, task });
    }
    if (resource === 'auto_state') {
      const state = await getAutomationAutoStateForAgent(carerUid);
      return NextResponse.json({ ok: true, ...state });
    }
    if (resource === 'game_login' && coadminUid && gameName) {
      const details = await getGameLoginDetailsForAgent(coadminUid, gameName);
      return NextResponse.json({ ok: true, details });
    }
    if (resource === 'verify_link') {
      await verifyAgentLinkedToCarerInSql(carerUid, agentId);
      return NextResponse.json({ ok: true, linked: true });
    }
    return apiError('Unsupported resource.', 400);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return apiError(message, 500);
  }
}

export async function POST(request: Request) {
  if (!isAuthoritySqlWriteEnabled()) {
    return apiError('SQL authority writes are disabled.', 503);
  }
  if (!verifyAgentSecret(request)) {
    return apiError('Unauthorized.', 401);
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return apiError('Invalid JSON body.', 400);
  }

  const carerUid = String(body.carerUid || '').trim();
  const agentId = String(body.agentId || '').trim();
  const action = String(body.action || '').trim();
  if (!carerUid || !agentId || !action) {
    return apiError('carerUid, agentId, and action are required.', 400);
  }

  try {
    await verifyAgentLinkedToCarerInSql(carerUid, agentId);
    const result = await runAgentJobAction({
      action,
      carerUid,
      agentId,
      jobId: String(body.jobId || '').trim() || undefined,
      taskId: String(body.taskId || '').trim() || undefined,
      reason: String(body.reason || '').trim() || undefined,
      details: body.details && typeof body.details === 'object' ? (body.details as Record<string, unknown>) : undefined,
      evidence: body.evidence && typeof body.evidence === 'object' ? (body.evidence as Record<string, unknown>) : undefined,
      status: String(body.status || '').trim() || undefined,
      result: body.result && typeof body.result === 'object' ? (body.result as Record<string, unknown>) : undefined,
      errorMessage: String(body.errorMessage || '').trim() || undefined,
      amount: body.amount === undefined ? undefined : Number(body.amount),
      scopeUid: String(body.scopeUid || '').trim() || undefined,
      actorUsername: String(body.actorUsername || '').trim() || undefined,
      carerName: String(body.carerName || '').trim() || undefined,
      limit: body.limit === undefined ? undefined : Number(body.limit),
    });
    return NextResponse.json({ ok: true, result });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[AGENT_JOBS_API] action=%s carerUid=%s error=%s', action, carerUid, message);
    return apiError(message, 500);
  }
}
