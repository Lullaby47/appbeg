import { doc, getDoc, serverTimestamp, updateDoc } from 'firebase/firestore';

import { auth, db } from '@/lib/firebase/client';

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
  const userRef = doc(db, 'users', carerUid);
  const snap = await getDoc(userRef);
  if (!snap.exists()) {
    throw new Error('Profile not found.');
  }
  const role = String((snap.data() as { role?: string }).role || '').toLowerCase();
  if (role !== 'carer') {
    throw new Error('Only carers can link an automation agent.');
  }
  const hadAgent = Boolean(
    String((snap.data() as { automationAgentId?: string }).automationAgentId || '').trim()
  );
  const payload: Record<string, unknown> = {
    automationAgentId: v.normalized,
    automationAgentUpdatedAt: serverTimestamp(),
  };
  if (!hadAgent) {
    payload.automationAgentLinkedAt = serverTimestamp();
  }
  await updateDoc(userRef, payload);
}

export async function disconnectCarerAutomationAgent(carerUid: string): Promise<void> {
  const current = auth.currentUser;
  if (!current || current.uid !== carerUid) {
    throw new Error('You can only disconnect your own automation agent.');
  }
  const userRef = doc(db, 'users', carerUid);
  const snap = await getDoc(userRef);
  if (!snap.exists()) {
    throw new Error('Profile not found.');
  }
  const role = String((snap.data() as { role?: string }).role || '').toLowerCase();
  if (role !== 'carer') {
    throw new Error('Only carers can disconnect an automation agent.');
  }
  await updateDoc(userRef, {
    automationAgentId: null,
    automationAgentLinkedAt: null,
    automationAgentUpdatedAt: serverTimestamp(),
  });
}
