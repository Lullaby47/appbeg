import {
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  onSnapshot,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  where,
  writeBatch,
} from 'firebase/firestore';

import { auth, db, getClientDb } from '@/lib/firebase/client';
import type { CarerTaskStatus } from '@/features/games/carerTasks';
import {
  automationJobDocId,
  validateAutomationAgentId,
} from '@/features/automation/carerAutomationAgent';
import { recordDevUsageEstimate } from '@/features/dev/devUsageEstimates';
import { automationJobTtl } from '@/lib/firestore/ttl';
import type { GameLoginDetailsInput, QueuedAutomationType } from '@/lib/automation/automationClaimPayload';
import {
  buildAutomationPayload,
  getTimestampMs,
  mapTaskType,
  resolveAutomationAccessFields,
  resolveTaskTypeLabel,
  sanitizeForFirestore,
} from '@/lib/automation/automationClaimPayload';

export type AutomationJobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
export type AutomationUiStatus =
  | 'waiting'
  | 'running'
  | 'completed'
  | 'failed'
  | 'pending_review';

export type AutomationJob = {
  id: string;
  /** Carer who owns this job; agent must match (omitted on legacy documents). */
  carerUid?: string;
  coadminUid?: string;
  /** Linked automation agent string from `users/{carerUid}.automationAgentId`. */
  agentId?: string | null;
  taskId: string;
  type: string;
  status: AutomationJobStatus;
  payload: Record<string, unknown>;
  createdByUid: string;
};

export { buildAutomationPayload, mapTaskType } from '@/lib/automation/automationClaimPayload';
export type { GameLoginDetailsInput, QueuedAutomationType } from '@/lib/automation/automationClaimPayload';

const STALE_TASK_CLAIM_TIMEOUT_MS = 5 * 60 * 1000;

function isActiveAutomationJobStatus(value: unknown) {
  const normalized = String(value || '').trim().toLowerCase();
  return (
    normalized === 'queued' ||
    normalized === 'running' ||
    normalized === 'waiting' ||
    normalized === 'in_progress' ||
    normalized === 'cancelled_requested'
  );
}

function normalizeAutomationStatus(value: unknown) {
  return String(value || '').trim().toLowerCase();
}

function isFreshAutomationJobSignal(job: {
  status?: string | null;
  heartbeatMs?: number;
  data?: Record<string, unknown> | null;
}) {
  const status = normalizeAutomationStatus(job.status);
  const signalMs = Math.max(
    Number(job.heartbeatMs || 0),
    getTimestampMs(job.data?.updatedAt),
    getTimestampMs(job.data?.createdAt)
  );
  if (!signalMs) {
    return false;
  }
  if (Date.now() - signalMs >= STALE_TASK_CLAIM_TIMEOUT_MS) {
    return false;
  }
  if (status === 'queued') {
    return true;
  }
  if (status === 'running') {
    return Boolean(job.heartbeatMs);
  }
  return false;
}

function normalizeClaimedStatus(value: unknown) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === 'unclaimed') return 'unclaimed';
  if (normalized === 'running') return 'running';
  return normalized;
}

function buildTaskClaimReleaseFields(
  automationError: string | null,
  status: 'pending' | 'failed' = 'pending',
  automationStatus: 'waiting' | 'failed' | 'pending_review' | null = 'waiting'
) {
  return {
    status,
    assignedCarerUid: null,
    assignedCarer: null,
    assignedCarerUsername: null,
    claimedStatus: null,
    claimedAt: null,
    claimedByUid: null,
    claimedByUsername: null,
    startedAt: null,
    lastHeartbeatAt: null,
    automationStatus,
    automationJobId: null,
    automationError,
    automationUpdatedAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };
}

function isAgentSupportedAutomationType(value: QueuedAutomationType) {
  return (
    value === 'CREATE_USERNAME' ||
    value === 'RESET_PASSWORD' ||
    value === 'RECHARGE' ||
    value === 'REDEEM'
  );
}

function sanitizeStatus(value: unknown): CarerTaskStatus {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'pending') return 'pending';
  if (normalized === 'in_progress') return 'in_progress';
  if (normalized === 'completed') return 'completed';
  if (normalized === 'failed') return 'failed';
  if (normalized === 'urgent') return 'urgent';
  return 'pending';
}

export async function claimTaskAndCreateJob(input: {
  taskId: string;
  currentUsername?: string | null;
  carerName?: string | null;
  gameLoginDetails?: GameLoginDetailsInput;
}) {
  const currentUser = auth.currentUser;
  if (!currentUser) {
    throw new Error('Not authenticated.');
  }
  const firestoreDb = getClientDb('claimTaskAndCreateJob');
  const taskRef = doc(firestoreDb, 'carerTasks', input.taskId);
  const userRef = doc(firestoreDb, 'users', currentUser.uid);

  const isRetryableConcurrencyError = (error: unknown) => {
    const code = String(
      (error as { code?: string } | null | undefined)?.code || ''
    ).toLowerCase();
    const message = String(
      (error as { message?: string } | null | undefined)?.message || ''
    ).toLowerCase();
    return (
      code.includes('failed-precondition') ||
      code.includes('aborted') ||
      message.includes('failed-precondition') ||
      message.includes('too much contention') ||
      message.includes('transaction')
    );
  };

  const loadSameTaskJobRefs = async () => {
    const sameTaskJobsSnap = await getDocs(
      query(collection(firestoreDb, 'automation_jobs'), where('taskId', '==', input.taskId), limit(20))
    );
    return sameTaskJobsSnap.docs.map((jobSnap) => jobSnap.ref);
  };

  const runClaimTransaction = async () => {
    const sameTaskJobRefs = await loadSameTaskJobRefs();
    return (
    runTransaction(firestoreDb, async (transaction) => {
      const [userSnap, taskSnap] = await Promise.all([
        transaction.get(userRef),
        transaction.get(taskRef),
      ]);
      if (!userSnap.exists()) {
        throw new Error('Current user profile not found.');
      }
      const userData = userSnap.data() as {
        username?: string;
        automationAgentId?: string | null;
      };
      const linkedAgentRaw = String(userData.automationAgentId || '').trim();
      const agentCheck = validateAutomationAgentId(linkedAgentRaw);
      if (!agentCheck.valid || !agentCheck.normalized) {
        throw new Error(
          'No automation agent connected. Use “Connect Automation Agent” on the carer panel, set the same ID as in your agent .env, then try again.'
        );
      }
      const resolvedAgentId = agentCheck.normalized;

      if (!taskSnap.exists()) {
        throw new Error('Task not found');
      }

      const freshTask = taskSnap.data() as Record<string, unknown>;
      const createdByName =
        input.carerName?.trim() || userData.username?.trim() || 'Carer';
      const currentStatus = sanitizeStatus(freshTask.status);
      const rawTaskStatus = String(freshTask.status || '').trim().toLowerCase() || 'pending';
      const automationStatus = normalizeAutomationStatus(freshTask.automationStatus);
      const claimedStatus = normalizeClaimedStatus(freshTask.claimedStatus);
      const claimedByUid = String(freshTask.claimedByUid || '').trim();
      const automationError = String(freshTask.automationError || '').trim() || null;
      const assignedCarerUid = String(freshTask.assignedCarerUid || '').trim();
      const assignedCarerName = String(
        freshTask.assignedCarerUsername || freshTask.assignedCarer || ''
      ).trim();
      const claimedByCurrentCarer =
        (assignedCarerUid === currentUser.uid ||
          claimedByUid === currentUser.uid ||
          (currentStatus === 'in_progress' &&
            (assignedCarerUid === currentUser.uid ||
              (assignedCarerName &&
                createdByName &&
                assignedCarerName.toLowerCase() === createdByName.toLowerCase()))) ||
          (assignedCarerName &&
            createdByName &&
            assignedCarerName.toLowerCase() === createdByName.toLowerCase()));
      const linkedJobId = String(freshTask.automationJobId || '').trim();
      const legacyJobId = automationJobDocId(currentUser.uid, taskSnap.id);
      const candidateJobIds = Array.from(
        new Set([linkedJobId, legacyJobId].filter((value) => Boolean(value)))
      );
      const candidateJobRefs = candidateJobIds.map((jobId) => doc(firestoreDb, 'automation_jobs', jobId));
      const candidateJobSnaps = await Promise.all(
        candidateJobRefs.map((jobRef) => transaction.get(jobRef))
      );
      const sameTaskJobSnaps = await Promise.all(
        sameTaskJobRefs
          .filter((jobRef) => !candidateJobIds.includes(jobRef.id))
          .map((jobRef) => transaction.get(jobRef))
      );
      const legacyCandidateJobs = candidateJobRefs.map((jobRef, index) => {
        const jobSnap = candidateJobSnaps[index];
        const jobData = jobSnap.exists() ? (jobSnap.data() as Record<string, unknown>) : null;
        const heartbeatMs = Math.max(
          getTimestampMs(jobData?.lastHeartbeatAt),
          getTimestampMs(jobData?.updatedAt),
          getTimestampMs(jobData?.createdAt)
        );
        return {
          ref: jobRef,
          snap: jobSnap,
          data: jobData,
          status: normalizeAutomationStatus(jobData?.status),
          heartbeatMs,
        };
      });
      const sameTaskJobs = sameTaskJobSnaps
        .filter((jobSnap) => jobSnap.exists())
        .map((jobSnap) => {
        const jobData = jobSnap.data() as Record<string, unknown>;
        const heartbeatMs = Math.max(
          getTimestampMs(jobData.lastHeartbeatAt),
          getTimestampMs(jobData.updatedAt),
          getTimestampMs(jobData.createdAt)
        );
        return {
          ref: jobSnap.ref,
          snap: jobSnap,
          data: jobData,
          status: normalizeAutomationStatus(jobData.status),
          heartbeatMs,
        };
      });
      const candidateJobs = Array.from(
        new Map(
          [...legacyCandidateJobs, ...sameTaskJobs].map((job) => [
            job.ref.id,
            job,
          ])
        ).values()
      );
      const activeSameTaskJobs = candidateJobs.filter((job) =>
        isActiveAutomationJobStatus(job.status)
      );
      const oldSameTaskJobs = candidateJobs.filter((job) =>
        job.snap.exists() && !isActiveAutomationJobStatus(job.status)
      );
      oldSameTaskJobs.forEach((job) => {
        console.info('START_TASK_IGNORED_OLD_COMPLETED_JOB', {
          taskId: taskSnap.id,
          jobId: job.ref.id,
          status: job.status || null,
        });
      });
      const freshActiveSameTaskJobs = activeSameTaskJobs.filter((job) =>
        isFreshAutomationJobSignal(job)
      );
      const activeExistingJob = [...activeSameTaskJobs].sort(
        (left, right) => right.heartbeatMs - left.heartbeatMs
      )[0];
      if (activeExistingJob) {
        console.info('START_TASK_BLOCKED_ACTIVE_JOB', {
          taskId: taskSnap.id,
          jobId: activeExistingJob.ref.id,
          status: activeExistingJob.status || null,
          isFresh: isFreshAutomationJobSignal(activeExistingJob),
        });
      }
      const reusableActiveJob = [...freshActiveSameTaskJobs].sort(
        (left, right) => right.heartbeatMs - left.heartbeatMs
      )[0];
      const latestLockActivityMs = Math.max(
        getTimestampMs(freshTask.lastHeartbeatAt),
        getTimestampMs(freshTask.claimedAt),
        reusableActiveJob?.heartbeatMs || 0
      );
      const hasFreshLock =
        Boolean(latestLockActivityMs) &&
        Date.now() - latestLockActivityMs < STALE_TASK_CLAIM_TIMEOUT_MS;
      const linkedAutomationJob = linkedJobId
        ? candidateJobs.find((job) => job.ref.id === linkedJobId) || null
        : null;
      const hasLinkedAutomationJob = Boolean(
        linkedAutomationJob && isActiveAutomationJobStatus(linkedAutomationJob.status)
      );
      const orphanedClaimFields =
        rawTaskStatus === 'pending' &&
        !claimedByUid &&
        !assignedCarerUid &&
        !hasLinkedAutomationJob &&
        freshActiveSameTaskJobs.length === 0 &&
        Boolean(claimedStatus || automationStatus === 'running');
      const restartableTask =
        rawTaskStatus === 'pending' ||
        rawTaskStatus === 'waiting' ||
        automationStatus === 'waiting' ||
        automationStatus === 'failed' ||
        automationStatus === 'pending_review' ||
        automationStatus === 'returned_to_pending' ||
        automationStatus === 'cancelled' ||
        Boolean(
          automationError &&
            (automationStatus === 'waiting' ||
              automationStatus === 'failed' ||
              automationStatus === 'pending_review')
        );
      const staleClaim =
        claimedStatus === 'running' &&
        (
          orphanedClaimFields ||
          !hasFreshLock ||
          (activeExistingJob?.status === 'running' && !activeExistingJob.heartbeatMs)
        );
      const hasFreshActiveClaim =
        claimedStatus === 'running' &&
        hasFreshLock &&
        !orphanedClaimFields;

      const canStartTask =
        rawTaskStatus === 'pending' &&
        !claimedByUid &&
        (!claimedStatus || orphanedClaimFields) &&
        !hasLinkedAutomationJob &&
        freshActiveSameTaskJobs.length === 0;
      console.info('[CARER_UI] claim transaction state', {
        taskId: taskSnap.id,
        canStart: canStartTask,
        disabledReason: canStartTask
          ? null
          : freshActiveSameTaskJobs.length > 0
            ? 'fresh_active_job_exists_for_same_task'
            : rawTaskStatus !== 'pending'
              ? `status_${rawTaskStatus}`
              : claimedByUid
                ? 'claimed_by_uid_present'
                : claimedStatus
                  ? `claimed_status_${claimedStatus}`
                  : hasLinkedAutomationJob
                    ? 'automation_job_id_present'
                    : 'task_not_startable',
        status: rawTaskStatus,
        automationStatus: automationStatus || null,
        claimedStatus: claimedStatus || null,
        claimedByUid: claimedByUid || null,
        assignedCarerUid: assignedCarerUid || null,
        automationJobId: linkedJobId || null,
        orphanedClaimFields,
        activeJobsForSameTask: activeSameTaskJobs.map((job) => ({
          jobId: job.ref.id,
          status: job.status || null,
          heartbeatMs: job.heartbeatMs || 0,
          isFresh: isFreshAutomationJobSignal(job),
        })),
        lastHeartbeatAt: freshTask.lastHeartbeatAt || freshTask.claimedAt || null,
        automationError,
      });

      if (orphanedClaimFields) {
        console.info('[automation] start-task:decision', {
          taskId: taskSnap.id,
          decision: 'orphaned claim fields ignored for restart',
          status: rawTaskStatus,
          claimedStatus: claimedStatus || null,
          automationStatus: automationStatus || null,
          automationJobId: linkedJobId || null,
          activeJobsForSameTask: activeSameTaskJobs.length,
        });
      }

      if (
        activeSameTaskJobs.length > 0 &&
        (!reusableActiveJob || !claimedByCurrentCarer)
      ) {
        throw new Error('Automation job already exists for this task.');
      }

      if (
        hasFreshActiveClaim &&
        !claimedByCurrentCarer &&
        (!reusableActiveJob || reusableActiveJob.status === 'running')
      ) {
        console.info('[automation] start-task:decision', {
          taskId: taskSnap.id,
          decision: 'rejected because fresh active claim',
        });
        throw new Error('Task already claimed');
      }

      const resolvedAccess = resolveAutomationAccessFields(freshTask, input.gameLoginDetails);
      const claimedTaskData = {
        ...freshTask,
        status: 'in_progress',
        assignedCarerUid: currentUser.uid,
        assignedCarerUsername: createdByName,
        assignedCarer: createdByName,
        currentUsername: input.currentUsername ?? freshTask.currentUsername ?? null,
        gameCredentialUsername: resolvedAccess.gameCredentialUsername,
        gameCredentialPassword: resolvedAccess.gameCredentialPassword,
        loginUrl: resolvedAccess.loginUrl,
        gameLoginUrl: resolvedAccess.gameLoginUrl,
        baseUrl: resolvedAccess.baseUrl,
        siteUrl: resolvedAccess.siteUrl,
        lobbyUrl: resolvedAccess.lobbyUrl,
      } as Record<string, unknown>;
      const mappedType = mapTaskType(resolveTaskTypeLabel(claimedTaskData));
      if (!isAgentSupportedAutomationType(mappedType)) {
        console.info('[automation] unsupported-job-type-blocked', {
          taskId: taskSnap.id,
          mappedType,
        });
        throw new Error(
          `Automation is currently supported only for CREATE_USERNAME, RESET_PASSWORD, RECHARGE, and REDEEM. ${mappedType} must be handled manually.`
        );
      }
      const payload = buildAutomationPayload({
        taskId: taskSnap.id,
        freshTask: claimedTaskData,
        currentUserUid: currentUser.uid,
        currentCarerName: createdByName,
        currentUsername: input.currentUsername ?? null,
      });
      const coadminUid = String(freshTask.coadminUid || '').trim();
      const staleOrFailedJob =
        activeExistingJob &&
        (staleClaim || Boolean(automationError) || !isFreshAutomationJobSignal(activeExistingJob))
          ? activeExistingJob
          : null;
      if (staleOrFailedJob) {
        transaction.update(staleOrFailedJob.ref, {
          status: automationError ? 'failed' : 'cancelled',
          completedAt: serverTimestamp(),
          ttlExpiresAt: automationJobTtl(),
          updatedAt: serverTimestamp(),
          lastHeartbeatAt: serverTimestamp(),
          error: automationError || 'Task claim expired and was cleared before restart.',
          cancelledReason: automationError ? 'failed_automation_claim_released' : 'stale_claim_cleared',
        });
        console.info('[automation] start-task:decision', {
          taskId: taskSnap.id,
          decision: automationError
            ? 'failed automation claim released'
            : 'stale claim cleared',
          previousJobId: staleOrFailedJob.ref.id,
        });
      }

      if (
        reusableActiveJob &&
        isActiveAutomationJobStatus(reusableActiveJob.status) &&
        isFreshAutomationJobSignal(reusableActiveJob) &&
        !staleOrFailedJob &&
        hasFreshLock
      ) {
        console.info('[automation] task claimed', {
          taskId: taskSnap.id,
          carerUid: currentUser.uid,
          reusedExistingJob: true,
          jobId: reusableActiveJob.ref.id,
        });
        transaction.update(taskRef, {
          ...claimedTaskData,
          claimedStatus: 'running',
          claimedByUid: currentUser.uid,
          claimedByUsername: createdByName,
          claimedAt: serverTimestamp(),
          startedAt: serverTimestamp(),
          lastHeartbeatAt: serverTimestamp(),
          automationStatus: reusableActiveJob.status === 'running' ? 'running' : 'waiting',
          automationJobId: reusableActiveJob.ref.id,
          automationError: null,
          automationUpdatedAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
        console.info('[automation] task moved to in_progress', {
          taskId: taskSnap.id,
          assignedCarerUid: currentUser.uid,
          jobId: reusableActiveJob.ref.id,
        });
        console.info('[automation] start-task:decision', {
          taskId: taskSnap.id,
          decision: 'claim allowed',
          reusedExistingJob: true,
          jobId: reusableActiveJob.ref.id,
        });

        return {
          jobId: reusableActiveJob.ref.id,
          taskId: taskSnap.id,
          status: reusableActiveJob.status || 'queued',
          reusedExistingJob: true as const,
        };
      }

      if (!claimedByCurrentCarer && !restartableTask && !staleClaim && rawTaskStatus !== 'pending') {
        console.info('[automation] start-task:decision', {
          taskId: taskSnap.id,
          decision: 'rejected because task is not reclaimable',
        });
        throw new Error('Task already claimed');
      }

      const jobRef = doc(collection(firestoreDb, 'automation_jobs'));

      console.info('[automation] task claimed', {
        taskId: taskSnap.id,
        carerUid: currentUser.uid,
        reusedExistingJob: false,
        jobId: jobRef.id,
      });
      transaction.update(taskRef, {
        ...claimedTaskData,
        claimedStatus: 'running',
        claimedByUid: currentUser.uid,
        claimedByUsername: createdByName,
        claimedAt: serverTimestamp(),
        startedAt: serverTimestamp(),
        lastHeartbeatAt: serverTimestamp(),
        automationStatus: 'waiting',
        automationJobId: jobRef.id,
        automationError: null,
        automationUpdatedAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      console.info('[automation] task moved to in_progress', {
        taskId: taskSnap.id,
        assignedCarerUid: currentUser.uid,
        jobId: jobRef.id,
      });

      const jobData = {
        carerUid: currentUser.uid,
        coadminUid,
        agentId: resolvedAgentId,
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
        ttlExpiresAt: null,
        error: null,
        attempts: 0,
        lastHeartbeatAt: null,
      };
      transaction.set(jobRef, jobData);
      console.info('[automation] start-task:decision', {
        taskId: taskSnap.id,
        decision: 'new automation job created',
        jobId: jobRef.id,
      });
      console.info('[automation] automation job created', {
        taskId: taskSnap.id,
        jobId: jobRef.id,
        carerUid: currentUser.uid,
      });
      console.info('[CARER_UI] automation job created', {
        taskId: taskSnap.id,
        jobId: jobRef.id,
      });

      return {
        jobId: jobRef.id,
        taskId: taskSnap.id,
        status: 'queued' as const,
        reusedExistingJob: false as const,
      };
    })
    );
  };

  let result:
    | {
        jobId: string;
        taskId: string;
        status: string;
        reusedExistingJob: boolean;
      }
    | null = null;
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      result = await runClaimTransaction();
      break;
    } catch (error) {
      lastError = error;
      if (!isRetryableConcurrencyError(error) || attempt >= 2) {
        break;
      }
      console.info('START_TASK_RETRY_AFTER_PRECONDITION', {
        taskId: input.taskId,
        attempt,
        nextAttempt: attempt + 1,
        code: String((error as { code?: string } | null | undefined)?.code || ''),
        message: String((error as { message?: string } | null | undefined)?.message || ''),
      });
      await getDoc(taskRef);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  if (!result && isRetryableConcurrencyError(lastError)) {
    const latestTaskSnap = await getDoc(taskRef);
    if (latestTaskSnap.exists()) {
      const latestTask = latestTaskSnap.data() as Record<string, unknown>;
      const latestStatus = sanitizeStatus(latestTask.status);
      const latestAssignedCarerUid = String(
        latestTask.claimedByUid || latestTask.assignedCarerUid || ''
      ).trim();
      const latestLinkedJobId = String(latestTask.automationJobId || '').trim();
      const latestJobSnap = latestLinkedJobId
        ? await getDoc(doc(firestoreDb, 'automation_jobs', latestLinkedJobId))
        : null;
      const latestJobStatus =
        latestJobSnap?.exists()
          ? String((latestJobSnap.data() as { status?: string }).status || '')
              .trim()
              .toLowerCase()
          : '';

      if (latestStatus === 'in_progress' && latestAssignedCarerUid === currentUser.uid) {
        result = {
          jobId: latestLinkedJobId || automationJobDocId(currentUser.uid, input.taskId),
          taskId: input.taskId,
          status: latestJobStatus || 'queued',
          reusedExistingJob: true,
        };
      }
    }
  }

  if (!result) {
    throw (lastError instanceof Error ? lastError : new Error('Failed to queue the task.'));
  }

  return Promise.resolve(result).then((result) => {
    if (!result.reusedExistingJob) {
      recordDevUsageEstimate({
        automationJobsCreated: 1,
        estReads: 7,
        estWrites: 3,
      });
    }
    return result;
  });
}

export async function startAutomationForTask(input: {
  taskId: string;
  taskLabel: string;
  coadminUid: string;
  player: string;
  game: string;
  currentUsername?: string | null;
  amount?: number | null;
  originalTask: Record<string, unknown>;
  gameLoginDetails?: GameLoginDetailsInput;
}) {
  const currentUser = auth.currentUser;
  if (!currentUser) {
    throw new Error('Not authenticated.');
  }
  const userRef = doc(db, 'users', currentUser.uid);

  return runTransaction(db, async (transaction) => {
    const userSnap = await transaction.get(userRef);
    if (!userSnap.exists()) {
      throw new Error('Current user profile not found.');
    }
    const userData = userSnap.data() as { automationAgentId?: string | null };
    const linkedAgentRaw = String(userData.automationAgentId || '').trim();
    const agentCheck = validateAutomationAgentId(linkedAgentRaw);
    if (!agentCheck.valid || !agentCheck.normalized) {
      throw new Error(
        'No automation agent connected. Use “Connect Automation Agent” on the carer panel first.'
      );
    }
    const jobRef = doc(collection(db, 'automation_jobs'));
    const taskRef = doc(db, 'carerTasks', input.taskId);
    const taskSnap = await transaction.get(taskRef);
    if (!taskSnap.exists()) {
      throw new Error('Task not found');
    }
    const taskData = taskSnap.data() as Record<string, unknown>;
    const linkedJobId = String(taskData.automationJobId || '').trim();
    if (linkedJobId) {
      const linkedJobSnap = await transaction.get(doc(db, 'automation_jobs', linkedJobId));
      if (
        linkedJobSnap.exists() &&
        isActiveAutomationJobStatus((linkedJobSnap.data() as { status?: string }).status)
      ) {
        throw new Error(
          'Automation job already exists for this task. The manual part is also available.'
        );
      }
    }
    const status = sanitizeStatus(taskData.status);
    if (status !== 'in_progress') {
      throw new Error('Task must be in progress before queueing automation this way.');
    }
    if (String(taskData.assignedCarerUid || '') !== currentUser.uid) {
      throw new Error('Only the assigned carer can queue automation for this task.');
    }
    const mappedType = mapTaskType(resolveTaskTypeLabel(taskData));
    if (!isAgentSupportedAutomationType(mappedType)) {
      console.info('[automation] unsupported-job-type-blocked', {
        taskId: input.taskId,
        taskLabel: input.taskLabel,
        mappedType,
      });
      throw new Error(
        `Automation is currently supported only for CREATE_USERNAME, RESET_PASSWORD, RECHARGE, and REDEEM. ${mappedType} must be handled manually.`
      );
    }

    const profile = userSnap.data() as { username?: string };
    const createdByName = profile.username?.trim() || 'Carer';
    const resolvedAccess = resolveAutomationAccessFields(taskData, input.gameLoginDetails);
    const enrichedTaskData = {
      ...taskData,
      gameCredentialUsername: resolvedAccess.gameCredentialUsername,
      gameCredentialPassword: resolvedAccess.gameCredentialPassword,
      loginUrl: resolvedAccess.loginUrl,
      gameLoginUrl: resolvedAccess.gameLoginUrl,
      baseUrl: resolvedAccess.baseUrl,
      siteUrl: resolvedAccess.siteUrl,
      lobbyUrl: resolvedAccess.lobbyUrl,
    } as Record<string, unknown>;

    const payload = buildAutomationPayload({
      taskId: input.taskId,
      freshTask: enrichedTaskData,
      currentUserUid: currentUser.uid,
      currentCarerName: createdByName,
      currentUsername: input.currentUsername ?? null,
    });

    transaction.set(jobRef, {
      carerUid: currentUser.uid,
      coadminUid: String(input.coadminUid || '').trim(),
      agentId: agentCheck.normalized,
      taskId: input.taskId,
      type: mappedType,
      status: 'queued',
      payload: sanitizeForFirestore({
        ...payload,
        originalTask: {
          ...((sanitizeForFirestore(input.originalTask) as Record<string, unknown> | null) || {}),
          ...(payload.originalTask || {}),
        },
      }) as Record<string, unknown>,
      createdByUid: currentUser.uid,
      createdByName,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      startedAt: null,
      completedAt: null,
      ttlExpiresAt: null,
      error: null,
      attempts: 0,
      lastHeartbeatAt: null,
    });

    console.info('[automation] task claimed', {
      taskId: input.taskId,
      carerUid: currentUser.uid,
      reusedExistingJob: false,
      jobId: jobRef.id,
    });
    transaction.update(taskRef, {
      status: 'in_progress',
      assignedCarerUid: currentUser.uid,
      assignedCarerUsername: createdByName,
      assignedCarer: createdByName,
      currentUsername: input.currentUsername ?? taskData.currentUsername ?? null,
      gameCredentialUsername: resolvedAccess.gameCredentialUsername,
      gameCredentialPassword: resolvedAccess.gameCredentialPassword,
      loginUrl: resolvedAccess.loginUrl,
      gameLoginUrl: resolvedAccess.gameLoginUrl,
      baseUrl: resolvedAccess.baseUrl,
      siteUrl: resolvedAccess.siteUrl,
      lobbyUrl: resolvedAccess.lobbyUrl,
      claimedStatus: 'running',
      claimedByUid: currentUser.uid,
      claimedByUsername: createdByName,
      claimedAt: serverTimestamp(),
      startedAt: serverTimestamp(),
      lastHeartbeatAt: serverTimestamp(),
      automationStatus: 'waiting',
      automationJobId: jobRef.id,
      automationError: null,
      automationUpdatedAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    console.info('[automation] task moved to in_progress', {
      taskId: input.taskId,
      assignedCarerUid: currentUser.uid,
      jobId: jobRef.id,
    });
    console.info('[automation] automation job created', {
      taskId: input.taskId,
      jobId: jobRef.id,
      carerUid: currentUser.uid,
    });

    return {
      success: true,
      job: {
        id: jobRef.id,
        status: 'queued' as AutomationJobStatus,
      },
    };
  }).then((result) => {
    recordDevUsageEstimate({
      automationJobsCreated: 1,
      estReads: 6,
      estWrites: 2,
    });
    return result;
  });
}

function mapJobStatusToUiStatus(
  status: AutomationJobStatus | 'cancelled_requested',
  data?: { needsManualReview?: boolean | null }
): AutomationUiStatus | null {
  if (status === 'queued') return 'waiting';
  if (status === 'running') return 'running';
  if (status === 'completed') return 'completed';
  if (status === 'cancelled' || status === 'cancelled_requested') return null;
  if (data?.needsManualReview) return 'pending_review';
  return 'failed';
}

export async function returnTaskToPendingAndCancelAutomation(taskId: string) {
  const currentUser = auth.currentUser;
  if (!currentUser) {
    throw new Error('Not authenticated.');
  }

  const taskRef = doc(db, 'carerTasks', taskId);
  const deterministicJobRef = doc(db, 'automation_jobs', automationJobDocId(currentUser.uid, taskId));
  const loadSameTaskJobRefs = async () => {
    const sameTaskJobsSnap = await getDocs(
      query(collection(db, 'automation_jobs'), where('taskId', '==', taskId), limit(20))
    );
    return sameTaskJobsSnap.docs.map((jobSnap) => jobSnap.ref);
  };
  const isRetryableConcurrencyError = (error: unknown) => {
    const code = String(
      (error as { code?: string } | null | undefined)?.code || ''
    ).toLowerCase();
    const message = String(
      (error as { message?: string } | null | undefined)?.message || ''
    ).toLowerCase();
    return (
      code.includes('failed-precondition') ||
      code.includes('aborted') ||
      message.includes('failed-precondition') ||
      message.includes('too much contention') ||
      message.includes('transaction')
    );
  };

  const concurrencyRetryMessage = 'Task was already changed. Please refresh and try again.';
  const runResetTransaction = async (attempt: number) => {
    const sameTaskJobRefs = await loadSameTaskJobRefs();
    console.info('[carer] returnToPendingTransactionStarted', {
      taskId,
      retryCount: attempt - 1,
      sameTaskJobIds: sameTaskJobRefs.map((jobRef) => jobRef.id),
    });
    const taskSnap = await getDoc(taskRef);
    if (!taskSnap.exists()) {
      throw new Error('Task not found.');
    }
    const taskData = taskSnap.data() as Record<string, unknown>;
    const linkedJobId = String(taskData.automationJobId || '').trim();
    const oldTaskStatus = String(taskData.status || '').trim().toLowerCase() || null;
    const jobRefs = Array.from(
      new Map(
        [
          deterministicJobRef,
          ...(linkedJobId ? [doc(db, 'automation_jobs', linkedJobId)] : []),
          ...sameTaskJobRefs,
        ].map((jobRef) => [jobRef.id, jobRef])
      ).values()
    );
    const jobSnaps = await Promise.all(jobRefs.map((jobRef) => getDoc(jobRef)));
    const jobStates = jobRefs.map((jobRef, index) => {
      const jobSnap = jobSnaps[index];
      const jobData = jobSnap.exists() ? (jobSnap.data() as Record<string, unknown>) : null;
      return {
        ref: jobRef,
        exists: jobSnap.exists(),
        status: String(jobData?.status || '').trim().toLowerCase(),
        taskId: String(jobData?.taskId || '').trim(),
      };
    });
    const linkedJobState =
      jobStates.find((job) => job.ref.id === linkedJobId) ||
      jobStates.find((job) => job.ref.id === deterministicJobRef.id) ||
      null;

    console.info('[carer] back-to-pending clicked', {
      taskId,
      linkedJobId: linkedJobId || deterministicJobRef.id,
      attempt,
    });
    console.info('[carer] returnToPendingTransactionState', {
      taskId,
      oldTaskStatus,
      oldAutomationJobId: linkedJobId || null,
      oldJobStatus: linkedJobState?.status || null,
      retryCount: attempt - 1,
      jobStates: jobStates.map((job) => ({
        jobId: job.ref.id,
        exists: job.exists,
        status: job.status || null,
        taskId: job.taskId || null,
      })),
    });

    const batch = writeBatch(db);
    jobStates.forEach((job) => {
      if (!job.exists) {
        return;
      }
      if (job.taskId && job.taskId !== taskId) {
        return;
      }
      if (job.status === 'queued' || job.status === 'running' || job.status === 'cancelled_requested') {
        batch.update(job.ref, {
          status: 'cancelled',
          claimedStatus: 'cancelled',
          cancelledAt: serverTimestamp(),
          cancelledReason: 'returned_to_pending',
          updatedAt: serverTimestamp(),
          lastHeartbeatAt: serverTimestamp(),
          completedAt: serverTimestamp(),
          ttlExpiresAt: automationJobTtl(),
          error: 'Cancelled by carer (returned_to_pending).',
        });
        console.info('[carer] linked job cancelled', {
          taskId,
          linkedJobId: job.ref.id,
          previousStatus: job.status,
          nextStatus: 'cancelled',
        });
        return;
      }
      console.info('[carer] linked job already terminal; cancel skipped', {
        taskId,
        linkedJobId: job.ref.id,
        previousStatus: job.status || null,
      });
    });

    batch.update(taskRef, {
      ...buildTaskClaimReleaseFields(null, 'pending', null),
      queuedAt: null,
    });
    await batch.commit();
    console.info('[carer] task reset complete', {
      taskId,
      attempt,
      oldTaskStatus,
      oldAutomationJobId: linkedJobId || null,
      oldJobStatus: linkedJobState?.status || null,
      clearedClaimFields: [
        'status',
        'assignedCarerUid',
        'assignedCarer',
        'assignedCarerUsername',
        'claimedStatus',
        'claimedAt',
        'claimedByUid',
        'claimedByUsername',
        'startedAt',
        'lastHeartbeatAt',
        'automationStatus',
        'automationJobId',
        'automationError',
        'queuedAt',
      ],
      retryCount: attempt - 1,
    });
  };

  let lastError: unknown = null;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      await runResetTransaction(attempt);
      return;
    } catch (error) {
      lastError = error;
      if (!isRetryableConcurrencyError(error) || attempt >= 4) {
        break;
      }
      // Explicit fresh read before one retry to avoid stale write races.
      await getDoc(taskRef);
      console.info('[carer] returnToPending retrying after concurrency error', {
        taskId,
        retryCount: attempt,
        message: error instanceof Error ? error.message : String(error),
      });
      await new Promise((resolve) => setTimeout(resolve, 150 * attempt));
    }
  }

  const latestTaskSnap = await getDoc(taskRef);
  if (latestTaskSnap.exists()) {
    const latestTask = latestTaskSnap.data() as Record<string, unknown>;
    const latestStatus = String(latestTask.status || '').trim().toLowerCase();
    const latestClaimedStatus = String(latestTask.claimedStatus || '').trim();
    const latestClaimedByUid = String(latestTask.claimedByUid || '').trim();
    const latestAssignedCarerUid = String(latestTask.assignedCarerUid || '').trim();
    const latestAutomationJobId = String(latestTask.automationJobId || '').trim();
    if (
      latestStatus === 'pending' &&
      !latestClaimedStatus &&
      !latestClaimedByUid &&
      !latestAssignedCarerUid &&
      !latestAutomationJobId
    ) {
      return;
    }
    console.info('[carer] returnToPending latest state still claimed', {
      taskId,
      status: latestStatus || null,
      claimedStatus: latestClaimedStatus || null,
      claimedByUid: latestClaimedByUid || null,
      assignedCarerUid: latestAssignedCarerUid || null,
      automationJobId: latestAutomationJobId || null,
    });
  }

  if (isRetryableConcurrencyError(lastError)) {
    throw new Error(concurrencyRetryMessage);
  }
  throw lastError instanceof Error
    ? lastError
    : new Error('Failed to move task back to pending.');
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
        const mapped = mapJobStatusToUiStatus(
          data.status as AutomationJobStatus | 'cancelled_requested',
          data as { needsManualReview?: boolean | null }
        );
        if (mapped) {
          statusByTaskId[taskId] = mapped;
        }
      }

      onChange(statusByTaskId);
    },
    (error) => {
      onError?.(error as Error);
    }
  );
}
