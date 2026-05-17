import { NextResponse } from 'next/server';

import { createAutoTickBrowserToken } from '@/lib/automation/autoTickBrowserToken';

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
  let stage = 'route_start';
  console.info('[AUTO_TICK_TOKEN] route called');
  console.info('[AUTO_TICK_TOKEN] method=%s', request.method);
  console.info('[AUTO_TICK_TOKEN] hasAuthHeader=%s', Boolean(request.headers.get('Authorization')));
  console.info('[AUTO_TICK_TOKEN] hasCookie=%s', Boolean(request.headers.get('Cookie')));

  try {
    stage = 'load_api_auth';
    const { apiError, requireApiUser } = await import('@/lib/firebase/apiAuth');
    console.info('[AUTO_TICK_TOKEN] firebaseAdminReady=%s', true);

    stage = 'verify_user';
    const auth = await requireApiUser(request, ['carer']);
    if ('response' in auth) {
      console.info('[AUTO_TICK_TOKEN] carerDocExists=%s', false);
      return auth.response;
    }
    console.info('[AUTO_TICK_TOKEN] userVerified uid=%s', auth.user.uid);
    console.info('[AUTO_TICK_TOKEN] carerDocExists=%s', true);

    let body: { agentId?: unknown };
    stage = 'parse_body';
    try {
      body = (await request.json()) as typeof body;
      console.info('[AUTO_TICK_TOKEN] bodyParsed=%s', true);
    } catch {
      console.info('[AUTO_TICK_TOKEN] bodyParsed=%s', false);
      return apiError('Invalid JSON body.', 400);
    }

    stage = 'validate_agent';
    const linkedAgentId = validateAutomationAgentId(auth.user.automationAgentId || '');
    const bodyAgentId = validateAutomationAgentId(String(body.agentId || ''));
    if (!linkedAgentId || !bodyAgentId || linkedAgentId !== bodyAgentId) {
      return apiError('agentId does not match the linked automation agent for this carer.', 403);
    }

    stage = 'sign_token';
    console.info(
      '[AUTO_TICK_TOKEN] env hasSecret=%s',
      Boolean(
        String(process.env.CARER_AUTOMATION_BROWSER_TICK_TOKEN_SECRET || '').trim() ||
          String(process.env.CARER_AUTOMATION_TICK_SECRET || '').trim()
      )
    );
    console.info('[AUTO_TICK_TOKEN] signing token');
    const token = createAutoTickBrowserToken({
      carerUid: auth.user.uid,
      username: auth.user.username || null,
      automationAgentId: linkedAgentId,
    });

    console.info('[AUTO_TICK_TOKEN] success');
    return NextResponse.json({
      ok: true,
      token: token.token,
      expiresAt: token.expiresAt,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack : undefined;
    console.error('[AUTO_TICK_TOKEN_FATAL] stage=%s error=%s stack=%s', stage, message, stack || null);
    if (stage === 'load_api_auth') {
      console.info('[AUTO_TICK_TOKEN] firebaseAdminReady=%s', false);
    }
    return NextResponse.json(
      {
        ok: false,
        error: message,
        stage,
      },
      { status: 500 }
    );
  }
}
