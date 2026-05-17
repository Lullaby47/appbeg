/**
 * Server-side (Firebase Admin) carer task claim + automation_jobs creation.
 * Mirrors client `claimTaskAndCreateJob` for the local agent auto-tick API.
 */

import { FieldValue, Timestamp } from 'firebase-admin/firestore';

import { adminDb } from '@/lib/firebase/admin';
import {
  buildAutomationPayload,
  getTimestampMs,
  mapTaskType,
  resolveAutomationAccessFields,
  resolveTaskTypeLabel,
  type GameLoginDetailsInput,
} from '@/lib/automation/automationClaimPayload';

const AUTOMATION_JOB_TTL_MS = 14 * 24 * 60 * 60 * 1000;

function automationJobTtlAdmin() {
  return Timestamp.fromMillis(Date.now() + AUTOMATION_JOB_TTL_MS);
}

const STALE_TASK_CLAIM_TIMEOUT_MS = 5 * 60 * 1000;

const AGENT_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

function logAutoClaimTiming(step: string, startedAt: number, details: Record<string, unknown> = {}) {
  console.info(`[AUTO_CLAIM_TIMING] ${step}`, {
    durationMs: Date.now() - startedAt,
    ...details,
  });
}

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

function automationJobDocId(carerUid: string, taskId: string): string {
  const uid = String(carerUid || '').trim();
  const tid = String(taskId || '').trim().replace(/\//g, '_');
  if (!uid || !tid) {
    throw new Error('carerUid and taskId are required for automation job id.');
  }
  return `${uid}--${tid}`;
}

function isActiveAutomationJobStatus(value: unknown) {
  const normalized = String(value || '').trim().toLowerCase();
  return (
    normalized === 'queued' ||
    normalized === 'claimed' ||
    normalized === 'running' ||
    normalized === 'waiting' ||
    normalized === 'in_progress' ||
    normalized === 'processing' ||
    normalized === 'cancelled_requested'
  );
}

function isTerminalAutomationJobStatus(value: unknown) {
  const normalized = String(value || '').trim().toLowerCase();
  return (
    normalized === 'completed' ||
    normalized === 'failed' ||
    normalized === 'cancelled' ||
    normalized === 'canceled' ||
    normalized === 'dismissed' ||
    normalized === 'terminal' ||
    normalized === 'success' ||
    normalized === 'error'
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
  const error = String(job.data?.error || '').trim().toLowerCase();
  if (error.includes('timed out') || error.includes('returned to the queue')) {
    return false;
  }
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

function sanitizeStatus(value: unknown): string {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'pending') return 'pending';
  if (normalized === 'in_progress') return 'in_progress';
  if (normalized === 'completed') return 'completed';
  if (normalized === 'failed') return 'failed';
  if (normalized === 'urgent') return 'urgent';
  return 'pending';
}

function taskDebugFields(task: Record<string, unknown> | null | undefined) {
  return {
    status: String(task?.['status'] || '').trim() || null,
    assignedCarerUid: String(task?.['assignedCarerUid'] || '').trim() || null,
    assignedCarerUsername: String(task?.['assignedCarerUsername'] || task?.['assignedCarer'] || '').trim() || null,
    claimedByUid: String(task?.['claimedByUid'] || '').trim() || null,
    automationJobId: String(task?.['automationJobId'] || '').trim() || null,
  };
}

function isAgentSupportedAutomationType(value: string) {
  return (
    value === 'CREATE_USERNAME' ||
    value === 'RESET_PASSWORD' ||
    value === 'RECHARGE' ||
    value === 'REDEEM'
  );
}

function isRetryableConcurrencyError(error: unknown) {
  const code = String((error as { code?: string } | null | undefined)?.code || '').toLowerCase();
  const message = String((error as { message?: string } | null | undefined)?.message || '').toLowerCase();
  return (
    code.includes('failed-precondition') ||
    code.includes('aborted') ||
    message.includes('failed-precondition') ||
    message.includes('too much contention') ||
    message.includes('transaction')
  );
}

export type ClaimCarerTaskAdminResult = {
  jobId: string;
  taskId: string;
  status: string;
  reusedExistingJob: boolean;
};

export async function claimCarerTaskAsAdmin(input: {
  carerUid: string;
  taskId: string;
  currentUsername?: string | null;
  carerName?: string | null;
  gameLoginDetails?: GameLoginDetailsInput;
  trustedUser?: {
    username?: string | null;
    automationAgentId?: string | null;
  };
}): Promise<ClaimCarerTaskAdminResult> {
  const totalStartedAt = Date.now();
  const taskRef = adminDb.collection('carerTasks').doc(input.taskId);

  const loadSameTaskJobRefs = async (options: { isPendingCleanTask: boolean }) => {
    const startedAt = Date.now();
    if (options.isPendingCleanTask) {
      logAutoClaimTiming('same_task_jobs_query', startedAt, {
        taskId: input.taskId,
        resultCount: 0,
        skipped: true,
        reason: 'pending_clean_task',
      });
      return [];
    }
    const sameTaskJobsSnap = await adminDb
      .collection('automation_jobs')
      .where('taskId', '==', input.taskId)
      .where('status', 'in', ['queued', 'waiting', 'running', 'in_progress', 'cancelled_requested'])
      .limit(10)
      .get();
    logAutoClaimTiming('same_task_jobs_query', startedAt, {
      taskId: input.taskId,
      resultCount: sameTaskJobsSnap.docs.length,
      activeOnly: true,
    });
    return sameTaskJobsSnap.docs.map((jobSnap) => jobSnap.ref);
  };

  const runClaimTransaction = async () => {
    const transactionStartedAt = Date.now();
    try {
      return await adminDb.runTransaction(async (transaction) => {
      const taskReadStartedAt = Date.now();
      const taskSnap = await transaction.get(taskRef);
      logAutoClaimTiming('task_read', taskReadStartedAt, {
        taskId: input.taskId,
        carerUid: input.carerUid,
        userReadSkipped: Boolean(input.trustedUser),
        taskExists: taskSnap.exists,
      });
      let userData = input.trustedUser as {
        username?: string;
        automationAgentId?: string | null;
      } | undefined;
      if (!userData) {
        const userReadStartedAt = Date.now();
        const userSnap = await transaction.get(adminDb.collection('users').doc(input.carerUid));
        logAutoClaimTiming('user_read', userReadStartedAt, {
          taskId: input.taskId,
          carerUid: input.carerUid,
          userExists: userSnap.exists,
        });
        if (!userSnap.exists) {
          throw new Error('Current user profile not found.');
        }
        userData = userSnap.data() as {
          username?: string;
          automationAgentId?: string | null;
        };
      }
      const linkedAgentRaw = String(userData.automationAgentId || '').trim();
      const agentCheck = validateAutomationAgentId(linkedAgentRaw);
      if (!agentCheck.valid || !agentCheck.normalized) {
        throw new Error(
          'No automation agent connected. Use “Connect Automation Agent” on the carer panel, set the same ID as in your agent .env, then try again.'
        );
      }
      const resolvedAgentId = agentCheck.normalized;

      if (!taskSnap.exists) {
        throw new Error('Task not found');
      }

      const freshTask = taskSnap.data() as Record<string, unknown>;
      const createdByName = input.carerName?.trim() || userData.username?.trim() || 'Carer';
      console.info('[TASK_START] taskId=%s begin path=claimCarerTaskAsAdmin', taskSnap.id);
      console.info('[AUTO_CLAIM_ADMIN] before task status fields', {
        taskId: taskSnap.id,
        carerUid: input.carerUid,
        carerUsername: createdByName,
        fields: taskDebugFields(freshTask),
      });
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
      const currentUserUid = input.carerUid;
      const claimedByCurrentCarer =
        assignedCarerUid === currentUserUid ||
        claimedByUid === currentUserUid ||
        (currentStatus === 'in_progress' &&
          (assignedCarerUid === currentUserUid ||
            (assignedCarerName &&
              createdByName &&
              assignedCarerName.toLowerCase() === createdByName.toLowerCase()))) ||
        (assignedCarerName &&
          createdByName &&
          assignedCarerName.toLowerCase() === createdByName.toLowerCase());
      const linkedJobId = String(freshTask.automationJobId || '').trim();
      console.info('[TASK_START] existing linkedJobId=%s taskId=%s status=%s automationStatus=%s assignedCarer=%s updatedAt=%o createdAt=%o',
        linkedJobId || null,
        taskSnap.id,
        rawTaskStatus,
        automationStatus || null,
        assignedCarerUid || assignedCarerName || null,
        freshTask.updatedAt || null,
        freshTask.createdAt || null
      );
      const isPendingCleanTask =
        rawTaskStatus === 'pending' &&
        !claimedByUid &&
        !assignedCarerUid &&
        !linkedJobId;
      const sameTaskJobRefs = await loadSameTaskJobRefs({ isPendingCleanTask });
      const legacyJobId = automationJobDocId(currentUserUid, taskSnap.id);
      const candidateJobIds = Array.from(
        new Set((isPendingCleanTask ? [] : [linkedJobId, legacyJobId]).filter((value) => Boolean(value)))
      );
      const candidateJobRefs = candidateJobIds.map((jobId) =>
        adminDb.collection('automation_jobs').doc(jobId)
      );
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
        const jobData = jobSnap.exists ? (jobSnap.data() as Record<string, unknown>) : null;
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
        .filter((jobSnap) => jobSnap.exists)
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
          [...legacyCandidateJobs, ...sameTaskJobs].map((job) => [job.ref.id, job])
        ).values()
      );
      candidateJobs.forEach((job) => {
        console.info('[TASK_START] existing job status=%s jobId=%s taskId=%s linked=%s exists=%s createdAt=%o updatedAt=%o heartbeatMs=%s',
          job.status || null,
          job.ref.id,
          String(job.data?.taskId || '').trim() || null,
          job.ref.id === linkedJobId,
          job.snap.exists,
          job.data?.createdAt || null,
          job.data?.updatedAt || null,
          job.heartbeatMs || 0
        );
      });
      const activeSameTaskJobs = candidateJobs.filter((job) =>
        isActiveAutomationJobStatus(job.status)
      );
      const oldSameTaskJobs = candidateJobs.filter(
        (job) => job.snap.exists && !isActiveAutomationJobStatus(job.status)
      );
      oldSameTaskJobs.forEach((job) => {
        console.info('START_TASK_CLEARING_OLD_COMPLETED_JOB_AND_CREATING_NEW', {
          taskId: taskSnap.id,
          jobId: job.ref.id,
          status: job.status || null,
          linked: job.ref.id === linkedJobId,
        });
      });
      const freshActiveSameTaskJobs = activeSameTaskJobs.filter((job) =>
        isFreshAutomationJobSignal(job)
      );
      const jobOwnerUid = (job: (typeof activeSameTaskJobs)[number]) =>
        String(job.data?.carerUid || job.data?.createdByUid || '').trim();
      const freshJobsAllowedToBlock = isPendingCleanTask ? [] : freshActiveSameTaskJobs;
      const myFreshJobs = freshJobsAllowedToBlock.filter(
        (job) => jobOwnerUid(job) === currentUserUid
      );
      const blockingFreshOtherCarer = freshJobsAllowedToBlock.filter(
        (job) => jobOwnerUid(job) !== currentUserUid
      );
      if (blockingFreshOtherCarer.length > 0) {
        console.info('[CARER_ADMIN] claim blocked fresh job owned by another carer', {
          taskId: taskSnap.id,
          blockingJobIds: blockingFreshOtherCarer.map((j) => j.ref.id),
        });
        throw new Error('Automation job already exists for this task.');
      }

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
      const reusableActiveJob = [...myFreshJobs].sort(
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
      const linkedAutomationJobIsTerminal = Boolean(
        linkedAutomationJob &&
          linkedAutomationJob.snap.exists &&
          isTerminalAutomationJobStatus(linkedAutomationJob.status)
      );
      if (linkedAutomationJobIsTerminal) {
        console.info('[TASK_START] linked job terminal; clearing stale link', {
          taskId: taskSnap.id,
          linkedJobId,
          linkedJobStatus: linkedAutomationJob?.status || null,
        });
      }
      const hasLinkedAutomationJob = Boolean(
        linkedAutomationJob && isActiveAutomationJobStatus(linkedAutomationJob.status)
      );
      console.info('[TASK_START] terminalCheck=%o', {
        taskId: taskSnap.id,
        linkedJobId: linkedJobId || null,
        linkedJobStatus: linkedAutomationJob?.status || null,
        hasLinkedAutomationJob,
        activeSameTaskJobCount: activeSameTaskJobs.length,
        freshActiveSameTaskJobCount: freshActiveSameTaskJobs.length,
      });
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
        linkedAutomationJobIsTerminal ||
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
        (orphanedClaimFields ||
          linkedAutomationJobIsTerminal ||
          !hasFreshLock ||
          (activeExistingJob?.status === 'running' && !activeExistingJob.heartbeatMs));
      const hasFreshActiveClaim =
        claimedStatus === 'running' &&
        !linkedAutomationJobIsTerminal &&
        hasFreshLock &&
        !orphanedClaimFields;

      const canStartPendingClean =
        rawTaskStatus === 'pending' &&
        blockingFreshOtherCarer.length === 0 &&
        (freshActiveSameTaskJobs.length === 0 || Boolean(reusableActiveJob));
      console.info('[CARER_ADMIN] claim transaction state', {
        taskId: taskSnap.id,
        rawTaskStatus,
        canStartPendingClean,
        staleTaskFieldsIgnoredForPending: rawTaskStatus === 'pending',
        staleSnapshot:
          rawTaskStatus === 'pending'
            ? {
                assignedCarerUid: assignedCarerUid || null,
                claimedByUid: claimedByUid || null,
                claimedStatus: claimedStatus || null,
                automationJobId: linkedJobId || null,
                automationStatus: automationStatus || null,
              }
            : null,
        freshJobsForSameTask: freshActiveSameTaskJobs.length,
        myFreshJobs: myFreshJobs.length,
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
        isPendingCleanTask,
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

      let skipSingleStaleJobCleanup = false;
      const cleanupStartedAt = Date.now();
      let cleanupCount = 0;
      if (rawTaskStatus === 'pending' && (!reusableActiveJob || isPendingCleanTask)) {
        const freshIds = new Set(isPendingCleanTask ? [] : freshActiveSameTaskJobs.map((j) => j.ref.id));
        for (const job of activeSameTaskJobs) {
          if (freshIds.has(job.ref.id)) {
            continue;
          }
          cleanupCount += 1;
          transaction.update(job.ref, {
            status: 'cancelled',
            completedAt: FieldValue.serverTimestamp(),
            ttlExpiresAt: automationJobTtlAdmin(),
            updatedAt: FieldValue.serverTimestamp(),
            lastHeartbeatAt: FieldValue.serverTimestamp(),
            error: 'Stale automation job cleared while reclaiming pending task.',
            cancelledReason: isPendingCleanTask ? 'stale_returned_to_pending' : 'pending_reclaim_stale_job',
          });
          console.info('[RETURN_TO_PENDING] stale active job cancelled', {
            taskId: taskSnap.id,
            jobId: job.ref.id,
            previousStatus: job.status || null,
            reason: isPendingCleanTask ? 'pending_clean_claim' : 'pending_reclaim_stale_job',
          });
          console.info('[CARER_ADMIN] stale automation job cancelled for pending reclaim', {
            taskId: taskSnap.id,
            jobId: job.ref.id,
            jobStatus: job.status || null,
          });
        }
        if (isPendingCleanTask && activeSameTaskJobs.length > 0) {
          console.info('[AUTO_TICK] pending clean task claim allowed despite stale job', {
            taskId: taskSnap.id,
            staleJobIds: activeSameTaskJobs.map((job) => job.ref.id),
          });
        }
        skipSingleStaleJobCleanup = true;
        console.info('[CARER_ADMIN] pending reclaim will overwrite stale task fields', {
          taskId: taskSnap.id,
          hadAssignedCarerUid: Boolean(assignedCarerUid),
          hadClaimedByUid: Boolean(claimedByUid),
          hadAutomationJobId: Boolean(linkedJobId),
        });
      }
      logAutoClaimTiming('old_job_cleanup', cleanupStartedAt, {
        taskId: taskSnap.id,
        cleanupCount,
        activeSameTaskJobCount: activeSameTaskJobs.length,
      });

      if (rawTaskStatus !== 'pending') {
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
      }

      const resolvedAccess = resolveAutomationAccessFields(freshTask, input.gameLoginDetails);
      const claimedTaskData = {
        ...freshTask,
        status: 'in_progress',
        assignedCarerUid: currentUserUid,
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
        currentUserUid,
        currentCarerName: createdByName,
        currentUsername: input.currentUsername ?? null,
      });
      const coadminUid = String(freshTask.coadminUid || '').trim();
      const staleOrFailedJob =
        !skipSingleStaleJobCleanup &&
        activeExistingJob &&
        (staleClaim || Boolean(automationError) || !isFreshAutomationJobSignal(activeExistingJob))
          ? activeExistingJob
          : null;
      if (staleOrFailedJob) {
        transaction.update(staleOrFailedJob.ref, {
          status: automationError ? 'failed' : 'cancelled',
          completedAt: FieldValue.serverTimestamp(),
          ttlExpiresAt: automationJobTtlAdmin(),
          updatedAt: FieldValue.serverTimestamp(),
          lastHeartbeatAt: FieldValue.serverTimestamp(),
          error: automationError || 'Task claim expired and was cleared before restart.',
          cancelledReason: automationError
            ? 'failed_automation_claim_released'
            : 'stale_claim_cleared',
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
        rawTaskStatus !== 'pending' &&
        reusableActiveJob &&
        isActiveAutomationJobStatus(reusableActiveJob.status) &&
        isFreshAutomationJobSignal(reusableActiveJob) &&
        !staleOrFailedJob &&
        hasFreshLock
      ) {
        console.info('[TASK_START] reusing existing job=%s taskId=%s existingStatus=%s linkedJobId=%s updatedAt=%o createdAt=%o',
          reusableActiveJob.ref.id,
          taskSnap.id,
          reusableActiveJob.status || null,
          linkedJobId || null,
          reusableActiveJob.data?.updatedAt || null,
          reusableActiveJob.data?.createdAt || null
        );
        console.info('[automation] task claimed', {
          taskId: taskSnap.id,
          carerUid: currentUserUid,
          reusedExistingJob: true,
          jobId: reusableActiveJob.ref.id,
        });
        transaction.update(taskRef, {
          ...claimedTaskData,
          claimedStatus: 'running',
          claimedByUid: currentUserUid,
          claimedByUsername: createdByName,
          claimedAt: FieldValue.serverTimestamp(),
          startedAt: FieldValue.serverTimestamp(),
          lastHeartbeatAt: FieldValue.serverTimestamp(),
          automationStatus: reusableActiveJob.status === 'running' ? 'running' : 'waiting',
          automationJobId: reusableActiveJob.ref.id,
          automationError: null,
          automationUpdatedAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        });
        console.info('[automation] task moved to in_progress', {
          taskId: taskSnap.id,
          assignedCarerUid: currentUserUid,
          jobId: reusableActiveJob.ref.id,
          originalTaskUpdatedToInProgress: true,
        });
        console.info('[automation] start-task:decision', {
          taskId: taskSnap.id,
          decision: 'claim allowed',
          reusedExistingJob: true,
          jobId: reusableActiveJob.ref.id,
        });
        logAutoClaimTiming('create_job', Date.now(), {
          taskId: taskSnap.id,
          jobId: reusableActiveJob.ref.id,
          queued: false,
          skipped: true,
          reason: 'reused_existing_job',
        });

        return {
          jobId: reusableActiveJob.ref.id,
          taskId: taskSnap.id,
          status: reusableActiveJob.status || 'queued',
          reusedExistingJob: true as const,
        };
      }

      if (rawTaskStatus !== 'pending') {
        if (!claimedByCurrentCarer && !restartableTask && !staleClaim) {
          console.info('[automation] start-task:decision', {
            taskId: taskSnap.id,
            decision: 'rejected because task is not reclaimable',
          });
          throw new Error('Task already claimed');
        }
      }

      const jobRef = adminDb.collection('automation_jobs').doc();

      const createJobStartedAt = Date.now();
      console.info('[TASK_START] creating fresh automation job=%s taskId=%s previousLinkedJobId=%s type=%s',
        jobRef.id,
        taskSnap.id,
        linkedJobId || null,
        mappedType
      );
      console.info('[automation] task claimed', {
        taskId: taskSnap.id,
        carerUid: currentUserUid,
        reusedExistingJob: false,
        jobId: jobRef.id,
      });
      transaction.update(taskRef, {
        ...claimedTaskData,
        claimedStatus: 'running',
        claimedByUid: currentUserUid,
        claimedByUsername: createdByName,
        claimedAt: FieldValue.serverTimestamp(),
        startedAt: FieldValue.serverTimestamp(),
        lastHeartbeatAt: FieldValue.serverTimestamp(),
        automationStatus: 'waiting',
        automationJobId: jobRef.id,
        automationError: null,
        automationUpdatedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      console.info('[automation] task moved to in_progress', {
        taskId: taskSnap.id,
        assignedCarerUid: currentUserUid,
        jobId: jobRef.id,
        originalTaskUpdatedToInProgress: true,
      });

      const jobData = {
        carerUid: currentUserUid,
        coadminUid,
        agentId: resolvedAgentId,
        taskId: taskSnap.id,
        type: mappedType,
        status: 'queued',
        payload,
        createdByUid: currentUserUid,
        createdByName,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
        startedAt: null,
        completedAt: null,
        ttlExpiresAt: null,
        error: null,
        attempts: 0,
        lastHeartbeatAt: null,
      };
      transaction.set(jobRef, jobData);
      console.info('[TASK_START] task status transition taskId=%s from=%s to=in_progress automationJobId=%s automationStatus=waiting writeTimestamps=serverTimestamp',
        taskSnap.id,
        rawTaskStatus,
        jobRef.id
      );
      console.info('[TASK_START] task linked to fresh automation job=%s taskId=%s previousLinkedJobId=%s',
        jobRef.id,
        taskSnap.id,
        linkedJobId || null
      );
      logAutoClaimTiming('create_job', createJobStartedAt, {
        taskId: taskSnap.id,
        jobId: jobRef.id,
        queued: true,
      });
      console.info('[automation] start-task:decision', {
        taskId: taskSnap.id,
        decision: 'new automation job created',
        jobId: jobRef.id,
      });
      console.info('[automation] automation job created', {
        taskId: taskSnap.id,
        jobId: jobRef.id,
        carerUid: currentUserUid,
      });

      return {
        jobId: jobRef.id,
        taskId: taskSnap.id,
        status: 'queued' as const,
        reusedExistingJob: false as const,
      };
      });
    } finally {
      logAutoClaimTiming('transaction', transactionStartedAt, {
        taskId: input.taskId,
        carerUid: input.carerUid,
      });
    }
  };

  let result: ClaimCarerTaskAdminResult | null = null;
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
      await adminDb.collection('carerTasks').doc(input.taskId).get();
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  if (!result && isRetryableConcurrencyError(lastError)) {
    const latestTaskSnap = await adminDb.collection('carerTasks').doc(input.taskId).get();
    if (latestTaskSnap.exists) {
      const latestTask = latestTaskSnap.data() as Record<string, unknown>;
      const latestStatus = sanitizeStatus(latestTask.status);
      const latestAssignedCarerUid = String(
        latestTask.claimedByUid || latestTask.assignedCarerUid || ''
      ).trim();
      const latestLinkedJobId = String(latestTask.automationJobId || '').trim();
      const latestJobSnap = latestLinkedJobId
        ? await adminDb.collection('automation_jobs').doc(latestLinkedJobId).get()
        : null;
      const latestJobStatus = latestJobSnap?.exists
        ? String((latestJobSnap.data() as { status?: string }).status || '')
            .trim()
            .toLowerCase()
        : '';

      if (latestStatus === 'in_progress' && latestAssignedCarerUid === input.carerUid) {
        console.info('[TASK_START] reusing existing job=%s taskId=%s reason=concurrency_retry_latest_state existingStatus=%s',
          latestLinkedJobId || automationJobDocId(input.carerUid, input.taskId),
          input.taskId,
          latestJobStatus || 'queued'
        );
        result = {
          jobId: latestLinkedJobId || automationJobDocId(input.carerUid, input.taskId),
          taskId: input.taskId,
          status: latestJobStatus || 'queued',
          reusedExistingJob: true,
        };
      }
    }
  }

  if (!result) {
    throw lastError instanceof Error ? lastError : new Error('Failed to queue the task.');
  }

  console.info('[AUTO_CLAIM_ADMIN] after task status fields', {
    taskId: input.taskId,
    jobId: result.jobId,
    carerUid: input.carerUid,
    reusedExistingJob: result.reusedExistingJob,
    automationJobCreated: !result.reusedExistingJob,
    originalTaskUpdatedToInProgress: true,
  });

  logAutoClaimTiming('total', totalStartedAt, {
    taskId: input.taskId,
    carerUid: input.carerUid,
    ok: true,
    jobId: result.jobId,
    reusedExistingJob: result.reusedExistingJob,
  });
  return result;
}

export function normalizeGameNameForAutomation(gameName: string) {
  return gameName.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_');
}

export async function resolveGameLoginDetailsForCoadminGame(
  coadminUid: string,
  gameName: string
): Promise<GameLoginDetailsInput> {
  const target = normalizeGameNameForAutomation(gameName);
  for (const field of ['coadminUid', 'createdBy'] as const) {
    const snap = await adminDb
      .collection('gameLogins')
      .where(field, '==', coadminUid)
      .limit(50)
      .get();
    for (const docSnap of snap.docs) {
      const row = docSnap.data() as {
        gameName?: string;
        username?: string;
        password?: string;
        backendUrl?: string;
        frontendUrl?: string;
        siteUrl?: string;
      };
      if (normalizeGameNameForAutomation(String(row.gameName || '')) !== target) {
        continue;
      }
      return {
        username: row.username || null,
        password: row.password || null,
        backendUrl: row.backendUrl || null,
        frontendUrl: row.frontendUrl || null,
        siteUrl: row.siteUrl || null,
      };
    }
  }
  return null;
}

export async function resolveCurrentUsernameForTask(
  coadminUid: string,
  playerUid: string,
  gameName: string
): Promise<string | null> {
  const snap = await adminDb
    .collection('playerGameLogins')
    .where('playerUid', '==', playerUid)
    .limit(80)
    .get();
  const target = normalizeGameNameForAutomation(gameName);
  for (const docSnap of snap.docs) {
    const row = docSnap.data() as {
      gameName?: string;
      gameUsername?: string;
      coadminUid?: string;
    };
    if (String(row.coadminUid || '').trim() !== String(coadminUid || '').trim()) {
      continue;
    }
    if (normalizeGameNameForAutomation(String(row.gameName || '')) !== target) {
      continue;
    }
    const u = String(row.gameUsername || '').trim();
    return u || null;
  }
  return null;
}
