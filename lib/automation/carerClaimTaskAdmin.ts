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
}): Promise<ClaimCarerTaskAdminResult> {
  const taskRef = adminDb.collection('carerTasks').doc(input.taskId);
  const userRef = adminDb.collection('users').doc(input.carerUid);

  const loadSameTaskJobRefs = async () => {
    const sameTaskJobsSnap = await adminDb
      .collection('automation_jobs')
      .where('taskId', '==', input.taskId)
      .limit(20)
      .get();
    return sameTaskJobsSnap.docs.map((jobSnap) => jobSnap.ref);
  };

  const runClaimTransaction = async () => {
    const sameTaskJobRefs = await loadSameTaskJobRefs();
    return adminDb.runTransaction(async (transaction) => {
      const [userSnap, taskSnap] = await Promise.all([
        transaction.get(userRef),
        transaction.get(taskRef),
      ]);
      if (!userSnap.exists) {
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

      if (!taskSnap.exists) {
        throw new Error('Task not found');
      }

      const freshTask = taskSnap.data() as Record<string, unknown>;
      const createdByName = input.carerName?.trim() || userData.username?.trim() || 'Carer';
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
      const legacyJobId = automationJobDocId(currentUserUid, taskSnap.id);
      const candidateJobIds = Array.from(
        new Set([linkedJobId, legacyJobId].filter((value) => Boolean(value)))
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
      const activeSameTaskJobs = candidateJobs.filter((job) =>
        isActiveAutomationJobStatus(job.status)
      );
      const oldSameTaskJobs = candidateJobs.filter(
        (job) => job.snap.exists && !isActiveAutomationJobStatus(job.status)
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
      const jobOwnerUid = (job: (typeof activeSameTaskJobs)[number]) =>
        String(job.data?.carerUid || job.data?.createdByUid || '').trim();
      const myFreshJobs = freshActiveSameTaskJobs.filter(
        (job) => jobOwnerUid(job) === currentUserUid
      );
      const blockingFreshOtherCarer = freshActiveSameTaskJobs.filter(
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
        (orphanedClaimFields ||
          !hasFreshLock ||
          (activeExistingJob?.status === 'running' && !activeExistingJob.heartbeatMs));
      const hasFreshActiveClaim =
        claimedStatus === 'running' && hasFreshLock && !orphanedClaimFields;

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
      if (rawTaskStatus === 'pending' && !reusableActiveJob) {
        const freshIds = new Set(freshActiveSameTaskJobs.map((j) => j.ref.id));
        for (const job of activeSameTaskJobs) {
          if (freshIds.has(job.ref.id)) {
            continue;
          }
          transaction.update(job.ref, {
            status: 'cancelled',
            completedAt: FieldValue.serverTimestamp(),
            ttlExpiresAt: automationJobTtlAdmin(),
            updatedAt: FieldValue.serverTimestamp(),
            lastHeartbeatAt: FieldValue.serverTimestamp(),
            error: 'Stale automation job cleared while reclaiming pending task.',
            cancelledReason: 'pending_reclaim_stale_job',
          });
          console.info('[CARER_ADMIN] stale automation job cancelled for pending reclaim', {
            taskId: taskSnap.id,
            jobId: job.ref.id,
            jobStatus: job.status || null,
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
        reusableActiveJob &&
        isActiveAutomationJobStatus(reusableActiveJob.status) &&
        isFreshAutomationJobSignal(reusableActiveJob) &&
        !staleOrFailedJob &&
        (hasFreshLock || rawTaskStatus === 'pending')
      ) {
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

  const afterTaskSnap = await adminDb.collection('carerTasks').doc(input.taskId).get();
  const afterTask = afterTaskSnap.exists ? (afterTaskSnap.data() as Record<string, unknown>) : null;
  console.info('[AUTO_CLAIM_ADMIN] after task status fields', {
    taskId: input.taskId,
    jobId: result.jobId,
    carerUid: input.carerUid,
    reusedExistingJob: result.reusedExistingJob,
    automationJobCreated: !result.reusedExistingJob,
    originalTaskUpdatedToInProgress:
      Boolean(afterTask) &&
      String(afterTask?.['status'] || '').trim().toLowerCase() === 'in_progress' &&
      String(afterTask?.['assignedCarerUid'] || '').trim() === input.carerUid,
    fields: taskDebugFields(afterTask),
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
