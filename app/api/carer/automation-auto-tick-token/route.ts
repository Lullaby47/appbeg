import { NextResponse } from 'next/server';

import { createAutoTickBrowserToken } from '@/lib/automation/autoTickBrowserToken';

export const runtime = 'nodejs';

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
    const { apiError, requireCarerApiUser } = await import('@/lib/firebase/apiAuth');
    console.info('[AUTO_TICK_TOKEN] firebaseAdminReady=%s', true);

    stage = 'verify_user';
    const auth = await requireCarerApiUser(request);
    if ('response' in auth) {
      console.info('[AUTO_TICK_TOKEN] auth_failed=true authPath=unknown');
      return auth.response;
    }
    console.info('[AUTO_TICK_TOKEN] userVerified uid=%s authPath=%s source=%s firestore_fallback=%s sql_profile_ms=%s user_doc_ms=%s', auth.user.uid, auth.authPath, auth.timing.source, auth.timing.firestore_fallback, auth.timing.sql_profile_ms, auth.timing.user_doc_ms);

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
