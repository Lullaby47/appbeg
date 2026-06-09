import { FieldValue } from 'firebase-admin/firestore';
import { NextResponse } from 'next/server';

import { adminDb } from '@/lib/firebase/admin';
import { apiError, requireApiUser } from '@/lib/firebase/apiAuth';
import {
  isAuthoritySqlWriteEnabled,
  logAuthoritySqlWrite,
} from '@/lib/server/authoritySqlWrite';
import {
  linkAutomationAgentInSql,
  unlinkAutomationAgentInSql,
} from '@/lib/sql/authorityAutomationAgent';

const AGENT_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

function validateAutomationAgentId(agentId: string): {
  valid: boolean;
  error?: string;
  normalized?: string;
} {
  const trimmed = String(agentId || '').trim();
  if (!trimmed) {
    return { valid: false, error: 'Agent ID cannot be empty.' };
  }
  if (trimmed.length > 64) {
    return { valid: false, error: 'Agent ID must be at most 64 characters.' };
  }
  if (!AGENT_ID_PATTERN.test(trimmed)) {
    return {
      valid: false,
      error: 'Agent ID may only contain letters, numbers, underscores, and hyphens.',
    };
  }
  return { valid: true, normalized: trimmed };
}

export async function POST(request: Request) {
  try {
    const auth = await requireApiUser(request, ['carer']);
    if ('response' in auth) return auth.response;

    const body = (await request.json().catch(() => ({}))) as {
      action?: unknown;
      carerUid?: unknown;
      agentId?: unknown;
    };
    const action = String(body.action || 'link').trim().toLowerCase();
    const carerUid = String(body.carerUid || auth.user.uid).trim();
    if (carerUid !== auth.user.uid) {
      return apiError('You can only update your own automation agent.', 403);
    }

    const existingAgentId = String(auth.user.automationAgentId || '').trim();

    if (action === 'disconnect' || action === 'unlink') {
      if (isAuthoritySqlWriteEnabled()) {
        const result = await unlinkAutomationAgentInSql(auth.user.uid);
        logAuthoritySqlWrite('/api/carer/automation-agent', { action: 'unlink', ...result });
        return NextResponse.json({ authority: 'sql', ...result });
      }

      await adminDb.collection('users').doc(auth.user.uid).update({
        automationAgentId: null,
        automationAgentLinkedAt: null,
        automationAgentUpdatedAt: FieldValue.serverTimestamp(),
      });
      return NextResponse.json({ success: true, automationAgentId: null });
    }

    if (action !== 'link') {
      return apiError('Invalid automation agent action.', 400);
    }

    const agentCheck = validateAutomationAgentId(String(body.agentId || ''));
    if (!agentCheck.valid || !agentCheck.normalized) {
      return apiError(agentCheck.error || 'Invalid agent ID.', 400);
    }

    if (isAuthoritySqlWriteEnabled()) {
      const result = await linkAutomationAgentInSql({
        carerUid: auth.user.uid,
        agentId: agentCheck.normalized,
        existingAgentId,
      });
      logAuthoritySqlWrite('/api/carer/automation-agent', {
        action: 'link',
        agentId: agentCheck.normalized,
      });
      return NextResponse.json({ authority: 'sql', ...result });
    }

    await adminDb.collection('users').doc(auth.user.uid).update({
      automationAgentId: agentCheck.normalized,
      automationAgentUpdatedAt: FieldValue.serverTimestamp(),
      ...(!existingAgentId ? { automationAgentLinkedAt: FieldValue.serverTimestamp() } : {}),
    });

    return NextResponse.json({
      success: true,
      automationAgentId: agentCheck.normalized,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to update automation agent.';
    const status = /not authenticated|authorization|token/i.test(message)
      ? 401
      : /forbidden|own automation agent/i.test(message)
        ? 403
        : /invalid|required|empty|characters|length/i.test(message)
          ? 400
          : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
