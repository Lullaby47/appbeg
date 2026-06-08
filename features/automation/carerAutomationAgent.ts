import { doc, getDoc } from 'firebase/firestore';

import { auth, db } from '@/lib/firebase/client';
import { getFirebaseApiHeaders } from '@/lib/firebase/apiClient';

const AGENT_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

export type CarerAutomationAgentSettings = {
  automationAgentId: string | null;
  automationAgentLinkedAt: unknown;
  automationAgentUpdatedAt: unknown;
};

export function validateAutomationAgentId(agentId: string): {
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

async function postAutomationAgentUpdate(body: Record<string, unknown>) {
  const current = auth.currentUser;
  if (!current) {
    throw new Error('Not authenticated.');
  }
  const response = await fetch('/api/carer/automation-agent', {
    method: 'POST',
    headers: await getFirebaseApiHeaders(),
    body: JSON.stringify(body),
  });
  const payload = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) {
    throw new Error(payload.error || 'Failed to update automation agent.');
  }
}

export async function getCarerAutomationAgent(
  carerUid: string
): Promise<CarerAutomationAgentSettings> {
  const snap = await getDoc(doc(db, 'users', carerUid));
  if (!snap.exists()) {
    return {
      automationAgentId: null,
      automationAgentLinkedAt: null,
      automationAgentUpdatedAt: null,
    };
  }
  const data = snap.data() as {
    automationAgentId?: string | null;
    automationAgentLinkedAt?: unknown;
    automationAgentUpdatedAt?: unknown;
  };
  const id = String(data.automationAgentId || '').trim();
  return {
    automationAgentId: id || null,
    automationAgentLinkedAt: data.automationAgentLinkedAt ?? null,
    automationAgentUpdatedAt: data.automationAgentUpdatedAt ?? null,
  };
}

/**
 * Deterministic `automation_jobs` document id: `{carerUid}--{taskId}`.
 * Uses `--` because carer task ids commonly contain single `_`.
 */
export function automationJobDocId(carerUid: string, taskId: string): string {
  const uid = String(carerUid || '').trim();
  const tid = String(taskId || '').trim().replace(/\//g, '_');
  if (!uid || !tid) {
    throw new Error('carerUid and taskId are required for automation job id.');
  }
  return `${uid}--${tid}`;
}

export async function setCarerAutomationAgent(
  carerUid: string,
  agentId: string
): Promise<void> {
  const current = auth.currentUser;
  if (!current || current.uid !== carerUid) {
    throw new Error('You can only update your own automation agent.');
  }
  const v = validateAutomationAgentId(agentId);
  if (!v.valid || !v.normalized) {
    throw new Error(v.error || 'Invalid agent ID.');
  }
  await postAutomationAgentUpdate({
    action: 'link',
    carerUid,
    agentId: v.normalized,
  });
}

export async function disconnectCarerAutomationAgent(carerUid: string): Promise<void> {
  const current = auth.currentUser;
  if (!current || current.uid !== carerUid) {
    throw new Error('You can only disconnect your own automation agent.');
  }
  await postAutomationAgentUpdate({
    action: 'disconnect',
    carerUid,
  });
}
