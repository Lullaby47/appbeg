import 'server-only';

import {
  mapTaskType,
  resolveAutomationAccessFields,
  resolveTaskTypeLabel,
} from '@/lib/automation/automationClaimPayload';
import {
  claimCarerTaskAsAdmin,
  resolveCurrentUsernameForTask,
  resolveGameLoginDetailsForCoadminGame,
} from '@/lib/automation/carerClaimTaskAdmin';
import {
  isSingleSessionAutomationGame,
  normalizeAutomationGameKey,
} from '@/lib/automation/singleSessionGames';
import { isAuthoritySqlWriteEnabled } from '@/lib/server/authoritySqlWrite';
import { listEnabledAutomationCarersForCoadmin } from '@/lib/sql/automationAutoStateCache';
import { isWithinReturnToPendingCooldown } from '@/lib/sql/authorityCarerTasks';
import { getCarerActiveSingleSessionTaskFromSql } from '@/lib/sql/carerTasksCache';
import { lookupApiUserProfileFromSqlCache } from '@/lib/sql/playersCache';
import { cleanText, getPlayerMirrorPool, toIsoString } from '@/lib/sql/playerMirrorCommon';

const AGENT_SUPPORTED_TYPES = new Set([
  'CREATE_USERNAME',
  'RESET_PASSWORD',
  'RECHARGE',
  'REDEEM',
]);

function isAgentSupportedAutomationType(value: string) {
  return AGENT_SUPPORTED_TYPES.has(value);
}

function taskHasRetryPending(row: Record<string, unknown>): boolean {
  if (row.retry_pending === true) {
    return true;
  }
  const raw = row.raw_firestore_data;
  if (raw && typeof raw === 'object' && (raw as Record<string, unknown>).retryPending === true) {
    return true;
  }
  return false;
}

function taskBlocksAutomationAutoClaim(row: Record<string, unknown>): boolean {
  return (
    taskHasRetryPending(row) ||
    isWithinReturnToPendingCooldown({
      returned_to_pending_at: toIsoString(row.returned_to_pending_at),
      raw_firestore_data:
        row.raw_firestore_data && typeof row.raw_firestore_data === 'object'
          ? (row.raw_firestore_data as Record<string, unknown>)
          : {},
    })
  );
}

export type AutoClaimPendingTaskOnCreateInput = {
  taskId: string;
  coadminUid: string;
  trigger: string;
};

export async function autoClaimPendingTaskOnCreate(
  input: AutoClaimPendingTaskOnCreateInput
): Promise<{
  claimed: boolean;
  reason?: string;
  taskId?: string;
  jobId?: string;
  carerUid?: string;
}> {
  const taskId = cleanText(input.taskId);
  const coadminUid = cleanText(input.coadminUid);
  const trigger = cleanText(input.trigger) || 'unknown';

  console.info('[AUTO_CLAIM_TASK_CREATED_TRIGGER]', { taskId, coadminUid, trigger });
  console.info('[AUTO_CLAIM_PENDING_TASKS_START]', { taskId, coadminUid, trigger });

  if (!isAuthoritySqlWriteEnabled()) {
    const reason = 'sql_write_disabled';
    console.info('[AUTO_CLAIM_PENDING_TASKS_RESULT]', { taskId, coadminUid, claimed: false, reason });
    return { claimed: false, reason };
  }

  if (!taskId || !coadminUid) {
    const reason = 'missing_task_or_coadmin';
    console.info('[AUTO_CLAIM_PENDING_TASKS_RESULT]', { taskId, coadminUid, claimed: false, reason });
    return { claimed: false, reason };
  }

  const db = getPlayerMirrorPool();
  if (!db) {
    const reason = 'postgres_unavailable';
    console.info('[AUTO_CLAIM_PENDING_TASKS_RESULT]', { taskId, coadminUid, claimed: false, reason });
    return { claimed: false, reason };
  }

  const enabledCarers = await listEnabledAutomationCarersForCoadmin(coadminUid);
  if (!enabledCarers.length) {
    console.info('[AUTO_DISPATCH_SKIPPED_AUTOMATION_OFF]', {
      route: 'autoClaimPendingTaskOnCreate',
      taskId,
      coadminUid,
      trigger,
      enabledCarerCount: 0,
      reason: 'automation_disabled',
    });
    console.info('[AUTO_CLAIM_SKIPPED_DISABLED]', { taskId, coadminUid, trigger });
    console.info('[AUTO_CLAIM_PENDING_TASKS_RESULT]', {
      taskId,
      coadminUid,
      claimed: false,
      reason: 'automation_disabled',
    });
    return { claimed: false, reason: 'automation_disabled' };
  }

  const taskResult = await db.query(
    `
      SELECT
        firebase_id, coadmin_uid, status, type, player_uid, game_name, request_id,
        current_username, game_account_username, login_url, game_login_url, lobby_url,
        site_url, base_url, game_credential_username, game_credential_password,
        retry_pending, returned_to_pending_at, raw_firestore_data, deleted_at
      FROM public.carer_tasks_cache
      WHERE firebase_id = $1
      LIMIT 1
    `,
    [taskId]
  );
  const taskRow = taskResult.rows[0] as Record<string, unknown> | undefined;
  if (!taskRow || taskRow.deleted_at) {
    const reason = 'task_missing';
    console.info('[AUTO_CLAIM_PENDING_TASKS_RESULT]', { taskId, coadminUid, claimed: false, reason });
    return { claimed: false, reason };
  }

  const taskStatus = cleanText(taskRow.status).toLowerCase();
  if (taskStatus !== 'pending') {
    const reason = 'task_not_pending';
    console.info('[AUTO_CLAIM_PENDING_TASKS_RESULT]', {
      taskId,
      coadminUid,
      claimed: false,
      reason,
      status: taskStatus,
    });
    return { claimed: false, reason };
  }

  if (cleanText(taskRow.coadmin_uid) !== coadminUid) {
    const reason = 'coadmin_mismatch';
    console.info('[AUTO_CLAIM_PENDING_TASKS_RESULT]', { taskId, coadminUid, claimed: false, reason });
    return { claimed: false, reason };
  }

  if (taskBlocksAutomationAutoClaim(taskRow)) {
    console.info('[AUTO_CLAIM_SKIPPED_RECENTLY_RETURNED]', {
      taskId,
      coadminUid,
      trigger,
      retryPending: taskHasRetryPending(taskRow),
      returnedToPendingAt: toIsoString(taskRow.returned_to_pending_at),
    });
    console.info('[AUTO_CLAIM_PENDING_TASKS_RESULT]', {
      taskId,
      coadminUid,
      claimed: false,
      reason: 'return_cooldown_or_retry_pending',
    });
    return { claimed: false, reason: 'return_cooldown_or_retry_pending' };
  }

  const mappedType = mapTaskType(resolveTaskTypeLabel(taskRow));
  if (mappedType === 'CREATE_USERNAME') {
    console.info('[AUTO_TICK_SQL_CREATE_USERNAME_ELIGIBLE]', {
      taskId,
      coadminUid,
      trigger,
    });
  }
  if (!isAgentSupportedAutomationType(mappedType)) {
    console.info('[AUTO_TICK_SQL_SKIPPED_TYPE]', {
      taskId,
      coadminUid,
      mappedType,
      trigger,
    });
    const reason = 'unsupported_automation_type';
    console.info('[AUTO_CLAIM_PENDING_TASKS_RESULT]', {
      taskId,
      coadminUid,
      claimed: false,
      reason,
      mappedType,
    });
    return { claimed: false, reason };
  }

  const gameName = cleanText(taskRow.game_name);
  const playerUid = cleanText(taskRow.player_uid);
  if (!gameName || !playerUid) {
    const reason = 'missing_game_or_player';
    console.info('[AUTO_CLAIM_PENDING_TASKS_RESULT]', { taskId, coadminUid, claimed: false, reason });
    return { claimed: false, reason };
  }

  for (const state of enabledCarers) {
    const carerUid = cleanText(state.carerUid);
    if (!carerUid) {
      continue;
    }

    console.info('[AUTO_CLAIM_STATE_READ]', {
      taskId,
      coadminUid,
      carerUid,
      enabled: state.enabled,
      automationAgentId: state.automationAgentId,
      trigger,
    });

    if (isSingleSessionAutomationGame(gameName)) {
      const gameKey = normalizeAutomationGameKey(gameName);
      const activeSameGame = await getCarerActiveSingleSessionTaskFromSql(
        coadminUid,
        carerUid,
        gameKey
      );
      if (activeSameGame.hit) {
        console.info('[AUTO_TICK_SINGLE_SESSION_BLOCKED]', {
          route: 'autoClaimPendingTaskOnCreate',
          taskId,
          carerUid,
          coadminUid,
          gameName,
          gameKey,
          activeTaskId: activeSameGame.taskId,
          activeJobId: activeSameGame.jobId,
          activeJobStatus: activeSameGame.jobStatus,
          reason: 'single_session_game_active',
        });
        console.info('[AUTO_CLAIM_PENDING_TASKS_RESULT]', {
          taskId,
          coadminUid,
          carerUid,
          claimed: false,
          reason: 'single_session_game_active',
          activeTaskId: activeSameGame.taskId,
        });
        continue;
      }
    }

    const profileLookup = await lookupApiUserProfileFromSqlCache(carerUid);
    const profile = profileLookup.profile;
    const carerName = cleanText(profile?.username) || 'Carer';
    const automationAgentId =
      cleanText(state.automationAgentId) || cleanText(profile?.automationAgentId);
    if (!automationAgentId) {
      console.info('[AUTO_CLAIM_PENDING_TASKS_RESULT]', {
        taskId,
        coadminUid,
        carerUid,
        claimed: false,
        reason: 'missing_automation_agent_id',
      });
      continue;
    }

    const taskAccess = resolveAutomationAccessFields(taskRow);
    const hasEmbeddedGameLoginDetails = Boolean(
      taskAccess.loginUrl &&
        taskAccess.gameCredentialUsername &&
        taskAccess.gameCredentialPassword
    );
    const gameLoginDetails = hasEmbeddedGameLoginDetails
      ? null
      : await resolveGameLoginDetailsForCoadminGame(coadminUid, gameName);

    const embeddedCurrentUsername =
      cleanText(taskRow.current_username) || cleanText(taskRow.game_account_username) || null;
    const fromSql =
      embeddedCurrentUsername || mappedType === 'CREATE_USERNAME'
        ? null
        : await resolveCurrentUsernameForTask(coadminUid, playerUid, gameName, {
            taskType: mappedType,
          });
    if (mappedType === 'CREATE_USERNAME' && !embeddedCurrentUsername) {
      console.info('[CLAIM_TASK_SQL_GAME_LOGIN_MISSING_ALLOWED]', {
        taskId,
        coadminUid,
        carerUid,
        playerUid,
        gameName,
        type: mappedType,
        reason: 'create_username_has_no_existing_player_game_login',
      });
    }
    const currentUsername = embeddedCurrentUsername || fromSql || null;
    if (!currentUsername && mappedType !== 'CREATE_USERNAME') {
      console.info('[AUTO_CLAIM_PENDING_TASKS_RESULT]', {
        taskId,
        coadminUid,
        carerUid,
        claimed: false,
        reason: 'player_game_login_missing_sql',
        message: 'Game login not found in SQL cache.',
        mappedType,
      });
      continue;
    }

    try {
      const result = await claimCarerTaskAsAdmin({
        carerUid,
        carerCoadminUid: coadminUid,
        taskId,
        currentUsername,
        carerName,
        gameLoginDetails,
        trustedUser: {
          username: carerName,
          automationAgentId,
        },
        skipLocked: true,
        allowRetryPendingClaim: false,
        requireAutomationEnabled: true,
      });

      if (!result.reusedExistingJob) {
        console.info('[AUTO_CLAIM_JOB_QUEUED]', {
          taskId: result.taskId,
          jobId: result.jobId,
          carerUid,
          coadminUid,
          agentId: automationAgentId,
          jobStatus: result.status,
        });
        console.info('[AUTO_CLAIM_OUTBOX_JOB_AVAILABLE]', {
          taskId: result.taskId,
          jobId: result.jobId,
          carerUid,
          agentId: automationAgentId,
        });
      }

      console.info('[AUTO_CLAIM_PENDING_TASKS_RESULT]', {
        taskId: result.taskId,
        jobId: result.jobId,
        carerUid,
        coadminUid,
        claimed: true,
        reusedExistingJob: result.reusedExistingJob,
        trigger,
      });
      return {
        claimed: true,
        taskId: result.taskId,
        jobId: result.jobId,
        carerUid,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.info('[AUTO_CLAIM_PENDING_TASKS_RESULT]', {
        taskId,
        coadminUid,
        carerUid,
        claimed: false,
        reason: 'claim_failed',
        message,
      });
    }
  }

  console.info('[AUTO_CLAIM_PENDING_TASKS_RESULT]', {
    taskId,
    coadminUid,
    claimed: false,
    reason: 'no_eligible_carer_claimed',
    enabledCarerCount: enabledCarers.length,
  });
  return { claimed: false, reason: 'no_eligible_carer_claimed' };
}

export function scheduleAutoClaimPendingTaskOnCreate(input: AutoClaimPendingTaskOnCreateInput) {
  if (!isAuthoritySqlWriteEnabled()) {
    return;
  }
  void autoClaimPendingTaskOnCreate(input).catch((error) => {
    console.error('[AUTO_CLAIM_PENDING_TASKS_ERROR]', {
      taskId: input.taskId,
      coadminUid: input.coadminUid,
      trigger: input.trigger,
      error: error instanceof Error ? error.message : String(error),
    });
  });
}
