import {
  addDoc,
  collection,
  doc,
  getDoc,
  limit,
  onSnapshot,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  where,
} from 'firebase/firestore';

import { auth, db } from '@/lib/firebase/client';
import type { CarerTaskStatus } from '@/features/games/carerTasks';

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

type QueuedAutomationType =
  | 'CREATE_USERNAME'
  | 'RECREATE_USERNAME'
  | 'RECHARGE'
  | 'REDEEM'
  | 'RESET_PASSWORD'
  | 'LOGIN'
  | 'COMPLETE_TASK';

type AutomationPayload = {
  player: string;
  game: string;
  username: string | null;
  currentUsername: string | null;
  amount: number | null;
  originalTask: Record<string, unknown>;
};

type AutomationPayloadInput = {
  taskId: string;
  freshTask: Record<string, unknown>;
  currentUserUid: string;
  currentCarerName: string;
  currentUsername?: string | null;
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

function sanitizeStatus(value: unknown): CarerTaskStatus {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'pending') return 'pending';
  if (normalized === 'in_progress') return 'in_progress';
  if (normalized === 'completed') return 'completed';
  if (normalized === 'urgent') return 'urgent';
  return 'pending';
}

export function mapTaskType(taskType: string): QueuedAutomationType {
  const normalized = taskType.trim().toUpperCase().replace(/\s+/g, ' ');
  if (
    normalized === 'CREATE USERNAME' ||
    normalized === 'CREATE_USERNAME' ||
    normalized === 'CREATE GAME USERNAME'
  ) {
    return 'CREATE_USERNAME';
  }
  if (normalized === 'RECREATE USERNAME' || normalized === 'RECREATE_USERNAME') {
    return 'RECREATE_USERNAME';
  }
  if (normalized === 'RECHARGE') return 'RECHARGE';
  if (normalized === 'REDEEM') return 'REDEEM';
  if (normalized === 'RESET PASSWORD' || normalized === 'RESET_PASSWORD') {
    return 'RESET_PASSWORD';
  }
  if (normalized === 'LOGIN') return 'LOGIN';
  return 'COMPLETE_TASK';
}

function resolveTaskTypeLabel(task: Record<string, unknown>) {
  const fromTaskType = String(task.type || '').trim();
  if (!fromTaskType) {
    return 'COMPLETE_TASK';
  }

  if (fromTaskType.includes('_')) {
    return fromTaskType.replace(/_/g, ' ');
  }
  return fromTaskType;
}

export function buildAutomationPayload(input: AutomationPayloadInput): AutomationPayload {
  const mergedTask = {
    id: input.taskId,
    ...input.freshTask,
    status: 'in_progress',
    assignedCarerUid: input.currentUserUid,
    assignedCarer: input.currentCarerName,
    assignedCarerUsername: input.currentCarerName,
    currentUsername: input.currentUsername ?? input.freshTask.currentUsername ?? null,
  } as Record<string, unknown>;
  const mappedType = mapTaskType(resolveTaskTypeLabel(mergedTask));
  const base = {
    player: String(mergedTask.playerUsername || mergedTask.player || 'Player'),
    game: String(mergedTask.gameName || mergedTask.game || 'Unknown Game'),
    currentUsername: (mergedTask.currentUsername as string | null | undefined) ?? null,
  };

  if (mappedType === 'CREATE_USERNAME') {
    return {
      ...base,
      username: null,
      amount: null,
      originalTask: {
        id: input.taskId,
        status: 'in_progress',
        assignedCarerUid: input.currentUserUid,
        assignedCarer: input.currentCarerName,
      },
    };
  }

  if (mappedType === 'RECREATE_USERNAME') {
    return {
      ...base,
      username: base.currentUsername || null,
      amount: null,
      originalTask: {
        id: input.taskId,
        status: 'in_progress',
        assignedCarerUid: input.currentUserUid,
        assignedCarer: input.currentCarerName,
      },
    };
  }

  if (mappedType === 'RECHARGE' || mappedType === 'REDEEM') {
    const amountValue = Number(mergedTask.amount);
    return {
      ...base,
      username: base.currentUsername || null,
      amount: Number.isFinite(amountValue) ? amountValue : null,
      originalTask: {
        id: input.taskId,
        status: 'in_progress',
        assignedCarerUid: input.currentUserUid,
        assignedCarer: input.currentCarerName,
      },
    };
  }

  if (mappedType === 'RESET_PASSWORD') {
    return {
      ...base,
      username: base.currentUsername || null,
      amount: null,
      originalTask: {
        id: input.taskId,
        status: 'in_progress',
        assignedCarerUid: input.currentUserUid,
        assignedCarer: input.currentCarerName,
      },
    };
  }

  return {
    ...base,
    username: base.currentUsername || null,
    amount: null,
    originalTask: {
      id: input.taskId,
      status: 'in_progress',
      assignedCarerUid: input.currentUserUid,
      assignedCarer: input.currentCarerName,
    },
  };
}

export async function claimTaskAndCreateJob(input: {
  taskId: string;
  agentId: string;
  currentUsername?: string | null;
  carerName?: string | null;
}) {
  const currentUser = auth.currentUser;
  if (!currentUser) {
    throw new Error('Not authenticated.');
  }
  const taskRef = doc(db, 'carerTasks', input.taskId);
  const userRef = doc(db, 'users', currentUser.uid);

  const userSnap = await getDoc(userRef);
  if (!userSnap.exists()) {
    throw new Error('Current user profile not found.');
  }
  const userData = userSnap.data() as { username?: string };
  const createdByName =
    input.carerName?.trim() || userData.username?.trim() || 'Carer';

  return runTransaction(db, async (transaction) => {
    const taskSnap = await transaction.get(taskRef);
    if (!taskSnap.exists()) {
      throw new Error('Task not found');
    }

    const freshTask = taskSnap.data() as Record<string, unknown>;
    const currentStatus = sanitizeStatus(freshTask.status);
    if (currentStatus !== 'pending') {
      throw new Error('Task already claimed');
    }

    const claimedTaskData = {
      ...freshTask,
      status: 'in_progress',
      assignedCarerUid: currentUser.uid,
      assignedCarerUsername: createdByName,
      assignedCarer: createdByName,
      currentUsername: input.currentUsername ?? freshTask.currentUsername ?? null,
    } as Record<string, unknown>;
    const mappedType = mapTaskType(resolveTaskTypeLabel(claimedTaskData));
    const payload = buildAutomationPayload({
      taskId: taskSnap.id,
      freshTask: claimedTaskData,
      currentUserUid: currentUser.uid,
      currentCarerName: createdByName,
      currentUsername: input.currentUsername ?? null,
    });
    const jobRef = doc(collection(db, 'automation_jobs'));

    transaction.update(taskRef, {
      ...claimedTaskData,
      claimedAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });

    transaction.set(jobRef, {
      agentId: input.agentId.trim(),
      taskId: taskSnap.id,
      type: mappedType,
      status: 'queued',
      payload,
      createdByUid: currentUser.uid,
      createdByName,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      startedAt: null,
      completedAt: null,
      error: null,
      attempts: 0,
    });

    return { jobId: jobRef.id, taskId: taskSnap.id, status: 'queued' as const };
  });
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
