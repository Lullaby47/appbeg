import {
  addDoc,
  collection,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  where,
} from 'firebase/firestore';

import { auth, db } from '@/lib/firebase/client';

export type AutomationJobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
export type AutomationUiStatus = 'waiting' | 'running' | 'completed' | 'failed';

export type AutomationJob = {
  id: string;
  agentId: string;
  taskId: string;
  type: string;
  status: AutomationJobStatus;
  payload: Record<string, unknown>;
  createdByUid: string;
};

function sanitizeForFirestore(value: unknown): unknown {
  if (value === undefined) {
    return null;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeForFirestore(entry));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, sanitizeForFirestore(entry)])
    );
  }
  return value;
}

function mapJobType(taskLabel: string) {
  const normalized = taskLabel.trim().toUpperCase().replace(/\s+/g, ' ');

  if (normalized === 'CREATE USERNAME' || normalized === 'RECREATE USERNAME') {
    return 'CREATE_USERNAME';
  }
  if (normalized === 'RECHARGE') return 'RECHARGE';
  if (normalized === 'REDEEM') return 'REDEEM';
  if (normalized === 'LOGIN') return 'LOGIN';
  return 'COMPLETE_TASK';
}

export async function startAutomationForTask(input: {
  agentId: string;
  taskId: string;
  taskLabel: string;
  player: string;
  game: string;
  currentUsername?: string | null;
  amount?: number | null;
  originalTask: Record<string, unknown>;
}) {
  const currentUser = auth.currentUser;
  if (!currentUser) {
    throw new Error('Not authenticated.');
  }
  if (!input.agentId.trim()) {
    throw new Error('Agent ID is missing for this task.');
  }

  const jobRef = await addDoc(collection(db, 'automation_jobs'), {
    agentId: input.agentId.trim(),
    taskId: input.taskId,
    type: mapJobType(input.taskLabel),
    status: 'queued',
    payload: {
      player: input.player,
      game: input.game,
      currentUsername: input.currentUsername ?? null,
      amount: input.amount ?? null,
      originalTask: sanitizeForFirestore(input.originalTask) as Record<string, unknown>,
    },
    createdByUid: currentUser.uid,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    startedAt: null,
    completedAt: null,
    error: null,
  });

  return {
    success: true,
    job: {
      id: jobRef.id,
      status: 'queued' as AutomationJobStatus,
    },
  };
}

function mapJobStatusToUiStatus(status: AutomationJobStatus): AutomationUiStatus {
  if (status === 'queued') return 'waiting';
  if (status === 'running') return 'running';
  if (status === 'completed') return 'completed';
  return 'failed';
}

export function listenAutomationUiStatusByTask(
  createdByUid: string,
  onChange: (statusByTaskId: Record<string, AutomationUiStatus>) => void,
  onError?: (error: Error) => void
) {
  const jobsQuery = query(
    collection(db, 'automation_jobs'),
    where('createdByUid', '==', createdByUid),
    orderBy('createdAt', 'desc'),
    limit(200)
  );

  return onSnapshot(
    jobsQuery,
    (snapshot) => {
      const statusByTaskId: Record<string, AutomationUiStatus> = {};
      const seenTaskIds = new Set<string>();

      for (const docSnap of snapshot.docs) {
        const data = docSnap.data() as Omit<AutomationJob, 'id'>;
        const taskId = String(data.taskId || '').trim();
        if (!taskId || seenTaskIds.has(taskId)) {
          continue;
        }
        seenTaskIds.add(taskId);
        statusByTaskId[taskId] = mapJobStatusToUiStatus(data.status);
      }

      onChange(statusByTaskId);
    },
    (error) => {
      onError?.(error as Error);
    }
  );
}
