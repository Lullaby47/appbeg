import { NextResponse } from 'next/server';

import { createAutoTickBrowserToken } from '@/lib/automation/autoTickBrowserToken';
import { apiError, requireApiUser } from '@/lib/firebase/apiAuth';

function validateAutomationAgentId(agentId: string) {
  const trimmed = String(agentId || '').trim();
  if (!trimmed || trimmed.length > 64) {
    return null;
  }
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(trimmed)) {
    return null;
  }
  return trimmed;
}

export async function POST(request: Request) {
  const auth = await requireApiUser(request, ['carer']);
  if ('response' in auth) {
    return auth.response;
  }

  let body: { agentId?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return apiError('Invalid JSON body.', 400);
  }

  const linkedAgentId = validateAutomationAgentId(auth.user.automationAgentId || '');
  const bodyAgentId = validateAutomationAgentId(String(body.agentId || ''));
  if (!linkedAgentId || !bodyAgentId || linkedAgentId !== bodyAgentId) {
    return apiError('agentId does not match the linked automation agent for this carer.', 403);
  }

  const token = createAutoTickBrowserToken({
    carerUid: auth.user.uid,
    username: auth.user.username || null,
    automationAgentId: linkedAgentId,
  });

  return NextResponse.json({
    ok: true,
    token: token.token,
    expiresAt: token.expiresAt,
  });
}
