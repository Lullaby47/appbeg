import { FieldValue } from 'firebase-admin/firestore';
import { after, NextResponse } from 'next/server';

import { apiError, requireApiUser, scopedCoadminUid, type ApiUser } from '@/lib/firebase/apiAuth';
import { adminDb } from '@/lib/firebase/admin';
import {
  isAuthoritySqlWriteEnabled,
  logAuthoritySqlWrite,
} from '@/lib/server/authoritySqlWrite';
import { dismissRedeemRequestInSql } from '@/lib/sql/authorityGameRequests';
import { mirrorAutomationJobById } from '@/lib/sql/automationJobsCache';
import { tombstoneCarerTaskCache } from '@/lib/sql/carerTasksCache';
import { mirrorPlayerGameRequestById } from '@/lib/sql/playerGameRequestsCache';

type Body = {
  requestId?: unknown;
  idempotencyKey?: unknown;
};

type ScopedRecord = {
  coadminUid?: string | null;
  createdBy?: string | null;
};

type DismissRedeemRecord = ScopedRecord & {
  type?: string | null;
  status?: string | null;
  playerUid?: string | null;
  playerUsername?: string | null;
  gameName?: string | null;
  game?: string | null;
  requestId?: string | null;
  fakeRedeem?: boolean | null;
  fakeRedeemReason?: string | null;
  automationStatus?: string | null;
  pokeMessage?: string | null;
  dismissReasonCode?: string | null;
  dismissReasonMessage?: string | null;
};

const DISMISSIBLE_REDEEM_STATUSES = new Set(['pending', 'poked', 'pending_review']);
const MILKY_WAY_FAKE_REDEEM_CLEANUP_TYPE = 'MILKY_WAY_FAKE_REDEEM_CLEANUP';

function ttlAfterDays(days: number) {
  const DAY_MS = 24 * 60 * 60 * 1000;
  return new Date(Date.now() + days * DAY_MS);
}

function recordScope(record: ScopedRecord) {
  return String(record.coadminUid || '').trim() || String(record.createdBy || '').trim();
}

function normalizeGameKey(value: unknown) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function isMilkyWayRecord(...records: Array<DismissRedeemRecord | null | undefined>) {
  return records.some((record) => {
    const gameKey = normalizeGameKey(record?.gameName || record?.game);
    return gameKey === 'milkyway';
  });
}

function isFakeRedeemDismissal(...records: Array<DismissRedeemRecord | null | undefined>) {
  return records.some((record) => {
    const automationStatus = String(record?.automationStatus || '').trim().toLowerCase();
    const text = [
      record?.pokeMessage,
      record?.fakeRedeemReason,
      record?.dismissReasonCode,
      record?.dismissReasonMessage,
    ]
      .map((value) => String(value || '').toLowerCase())
      .join(' ');

    return (
      record?.fakeRedeem === true ||
      automationStatus === 'fake_redeem' ||
      text.includes('fake redeem')
    );
  });
}

function milkyWayCleanupTaskId(requestId: string) {
  return `milky_way_fake_redeem_cleanup__${requestId.replace(/\//g, '_')}`;
}

function buildMilkyWayCleanupPayload(values: {
  requestId: string;
  linkedTaskId: string;
  playerUid: string;
  playerUsername?: string | null;
  gameName?: string | null;
  coadminUid: string;
}) {
  return {
    cleanupKind: 'milky_way_fake_redeem_modal',
    game: values.gameName || 'Milky Way',
    requestId: values.requestId,
    linkedTaskId: values.linkedTaskId,
    playerUid: values.playerUid,
    playerUsername: values.playerUsername || null,
    coadminUid: values.coadminUid,
    backgroundOnly: true,
    warningOnlyOnFailure: true,
    doNotBlockJobCompletionUi: true,
    requiredSteps: [
      'Click the modal Close X if visible.',
      'Wait until #DialogBySHF is gone or hidden.',
      'Wait until #DialogBySHFLayer is gone or hidden.',
      'Wait until no ChangeTreasure.aspx iframe remains.',
      'Clear search input.',
      'Submit empty search.',
      'Verify User Management ready.',
    ],
    selectors: {
      modal: '#DialogBySHF',
      modalLayer: '#DialogBySHFLayer',
      redeemIframe: 'iframe[src*="ChangeTreasure.aspx"]',
      closeCandidates: [
        '#DialogBySHF .layui-layer-close',
        '#DialogBySHF [aria-label="Close"]',
        '#DialogBySHF .close',
        '.layui-layer-close',
      ],
    },
  };
}

async function queueMilkyWayFakeRedeemCleanup(values: {
  requestId: string;
  linkedTaskId: string;
  caller: ApiUser;
  coadminUid: string;
  playerUid: string;
  playerUsername?: string | null;
  gameName?: string | null;
}) {
  const cleanupTaskId = milkyWayCleanupTaskId(values.requestId);
  const jobRef = adminDb.collection('automation_jobs').doc(cleanupTaskId);
  const payload = buildMilkyWayCleanupPayload({
    requestId: values.requestId,
    linkedTaskId: values.linkedTaskId,
    playerUid: values.playerUid,
    playerUsername: values.playerUsername,
    gameName: values.gameName,
    coadminUid: values.coadminUid,
  });

  await jobRef.set(
    {
      carerUid: values.caller.uid,
      coadminUid: values.coadminUid,
      agentId: values.caller.automationAgentId || null,
      taskId: cleanupTaskId,
      type: MILKY_WAY_FAKE_REDEEM_CLEANUP_TYPE,
      status: 'queued',
      payload,
      createdByUid: values.caller.uid,
      createdByName: values.caller.username || 'Carer',
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      startedAt: null,
      completedAt: null,
      ttlExpiresAt: null,
      error: null,
      attempts: 0,
      lastHeartbeatAt: null,
    },
    { merge: true }
  );

  console.info('[MILKY_WAY_FAKE_REDEEM_CLEANUP] queued', {
    requestId: values.requestId,
    jobId: jobRef.id,
    carerUid: values.caller.uid,
    agentId: values.caller.automationAgentId || null,
  });
  void mirrorAutomationJobById(jobRef.id, 'appbeg_dismiss_redeem');
}

function errorStatus(message: string) {
  if (/not authenticated|authorization|token/i.test(message)) return 401;
  if (/forbidden|outside your scope/i.test(message)) return 403;
  if (/not dismissible|already|conflict/i.test(message)) return 409;
  if (/required|not found|only|missing scope/i.test(message)) return 400;
  return 500;
}

export async function POST(request: Request) {
  const requestIdForLog = { requestId: '' };

  try {
    const auth = await requireApiUser(request, ['admin', 'coadmin', 'staff', 'carer']);
    if ('response' in auth) return auth.response;

    const body = (await request.json()) as Body;
    const requestId = String(body.requestId || '').trim();
    requestIdForLog.requestId = requestId;
    console.info('DISMISS_REDEEM start', {
      requestId,
      callerUid: auth.user.uid,
      callerRole: auth.user.role,
    });

    if (!requestId) {
      return apiError('requestId is required.', 400);
    }

    const caller = auth.user;
    const callerScope = scopedCoadminUid(caller);
    const isAdmin = caller.role === 'admin';
    const idempotencyKey =
      String(body.idempotencyKey || request.headers.get('Idempotency-Key') || '').trim() || null;

    if (isAuthoritySqlWriteEnabled()) {
      const outcome = await dismissRedeemRequestInSql({
        requestId,
        actorUid: caller.uid,
        actorRole: caller.role,
        isAdmin,
        scopeUid: callerScope,
        idempotencyKey,
      });
      logAuthoritySqlWrite('/api/carer/game-requests/dismiss-redeem', {
        requestId,
        duplicate: outcome.duplicate,
        alreadyDismissed: outcome.alreadyDismissed,
      });
      console.info('DISMISS_REDEEM success', {
        requestId,
        callerUid: caller.uid,
        callerRole: caller.role,
        alreadyDismissed: outcome.alreadyDismissed,
        taskDeleted: outcome.taskDeleted,
        linkedTaskId: outcome.linkedTaskId,
        milkyWayFakeRedeemCleanupQueued: false,
        authority: 'sql',
      });
      return NextResponse.json({
        success: true,
        alreadyDismissed: outcome.alreadyDismissed,
        taskDeleted: outcome.taskDeleted,
        linkedTaskId: outcome.linkedTaskId,
        retryMarkersCleared: true,
        duplicate: outcome.duplicate,
        authority: 'sql',
      });
    }

    const requestRef = adminDb.collection('playerGameRequests').doc(requestId);
    const taskRef = adminDb.collection('carerTasks').doc(`request__${requestId}`);

    const outcome = await adminDb.runTransaction(async (transaction) => {
      const [requestSnap, taskSnap] = await Promise.all([
        transaction.get(requestRef),
        transaction.get(taskRef),
      ]);

      if (!requestSnap.exists) {
        throw new Error('Request not found.');
      }

      const requestData = requestSnap.data() as DismissRedeemRecord;
      if (String(requestData.type || '').toLowerCase() !== 'redeem') {
        throw new Error('Only redeem requests can be dismissed.');
      }

      const playerUid = String(requestData.playerUid || '').trim();
      if (!playerUid) {
        throw new Error('Request player not found.');
      }

      const playerRef = adminDb.collection('users').doc(playerUid);
      const playerSnap = await transaction.get(playerRef);
      if (!playerSnap.exists) {
        throw new Error('Player not found.');
      }

      const playerData = playerSnap.data() as ScopedRecord & { role?: string };
      if (String(playerData.role || '').toLowerCase() !== 'player') {
        throw new Error('Request player not found.');
      }

      const requestScope = recordScope(requestData);
      const playerScope = recordScope(playerData);
      const canonicalRequestScope = requestScope || playerScope;
      if (!canonicalRequestScope) {
        throw new Error('Request missing scope.');
      }
      if (requestScope && playerScope && requestScope !== playerScope) {
        throw new Error('Forbidden: request is outside your scope.');
      }
      if (!isAdmin && (!callerScope || callerScope !== canonicalRequestScope)) {
        throw new Error('Forbidden: request is outside your scope.');
      }

      let linkedTaskData: DismissRedeemRecord | null = null;
      if (taskSnap.exists) {
        linkedTaskData = taskSnap.data() as DismissRedeemRecord;
        const taskScope = recordScope(linkedTaskData);
        if (
          String(linkedTaskData.requestId || requestId).trim() !== requestId ||
          (taskScope && taskScope !== canonicalRequestScope)
        ) {
          throw new Error('Forbidden: linked task is outside your scope.');
        }
      }

      const currentStatus = String(requestData.status || '').toLowerCase();
      const alreadyDismissed = currentStatus === 'dismissed';
      console.info('[REQUEST_DISMISS] requestId=%s statusBefore=%s', requestId, currentStatus || null);
      console.info('[REQUEST_DISMISS] alreadyDismissed=%s', alreadyDismissed);
      console.info('[REQUEST_DISMISS] linkedTaskId=%s', taskRef.id);
      if (!alreadyDismissed && !DISMISSIBLE_REDEEM_STATUSES.has(currentStatus)) {
        throw new Error('Redeem request is not dismissible.');
      }

      transaction.update(requestRef, {
        status: 'dismissed',
        completedAt: FieldValue.serverTimestamp(),
        ttlExpiresAt: ttlAfterDays(90),
        pokedAt: null,
        pokeMessage: null,
        fakeRedeem: null,
        fakeRedeemReason: null,
        dismissType: 'carer_manual',
        dismissedByAutomation: null,
        dismissReasonCode: null,
        dismissReasonMessage: null,
        dismissMeta: null,
        automationError: null,
        error: null,
        failureReason: null,
        retryPending: null,
        retryableFailure: null,
        resetToPendingAt: null,
        returnedToPendingAt: null,
        pendingSince: null,
        automationJobId: null,
        automationStatus: null,
        updatedAt: FieldValue.serverTimestamp(),
      });

      if (taskSnap.exists) {
        transaction.delete(taskRef);
      }

      return {
        alreadyDismissed,
        taskDeleted: taskSnap.exists,
        linkedTaskId: taskRef.id,
        retryMarkersCleared: true,
        queueMilkyWayFakeRedeemCleanup:
          taskSnap.exists &&
          isMilkyWayRecord(linkedTaskData, requestData) &&
          isFakeRedeemDismissal(linkedTaskData, requestData),
        cleanupContext: {
          coadminUid: canonicalRequestScope,
          playerUid,
          playerUsername:
            String(linkedTaskData?.playerUsername || requestData.playerUsername || '').trim() ||
            null,
          gameName: String(linkedTaskData?.gameName || requestData.gameName || '').trim() || null,
        },
      };
    });

    const {
      queueMilkyWayFakeRedeemCleanup: shouldQueueMilkyWayFakeRedeemCleanup,
      cleanupContext,
      ...publicOutcome
    } = outcome;

    if (shouldQueueMilkyWayFakeRedeemCleanup) {
      const caller = auth.user;
      after(async () => {
        try {
          await queueMilkyWayFakeRedeemCleanup({
            requestId,
            linkedTaskId: outcome.linkedTaskId,
            caller,
            coadminUid: cleanupContext.coadminUid,
            playerUid: cleanupContext.playerUid,
            playerUsername: cleanupContext.playerUsername,
            gameName: cleanupContext.gameName,
          });
        } catch (cleanupError) {
          console.warn('[MILKY_WAY_FAKE_REDEEM_CLEANUP] queue failed', {
            requestId,
            error:
              cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
          });
        }
      });
    }

    console.info('DISMISS_REDEEM success', {
      requestId,
      callerUid: auth.user.uid,
      callerRole: auth.user.role,
      ...publicOutcome,
      milkyWayFakeRedeemCleanupQueued: shouldQueueMilkyWayFakeRedeemCleanup,
    });
    console.info('[REQUEST_DISMISS] requestId=%s alreadyDismissed=%s', requestId, publicOutcome.alreadyDismissed);
    console.info('[REQUEST_DISMISS] linkedTaskId=%s', publicOutcome.linkedTaskId);
    console.info('[REQUEST_DISMISS] linkedTaskDeleted=%s', publicOutcome.taskDeleted);
    console.info('[REQUEST_DISMISS] retryMarkersCleared=%s', publicOutcome.retryMarkersCleared);
    if (publicOutcome.taskDeleted) {
      void tombstoneCarerTaskCache(publicOutcome.linkedTaskId, 'appbeg_dismiss_redeem');
    }
    void mirrorPlayerGameRequestById(requestId, 'appbeg_dismiss_redeem');
    return NextResponse.json({ success: true, ...publicOutcome });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to dismiss redeem request.';
    const status = errorStatus(message);
    if (status === 403) {
      console.warn('DISMISS_REDEEM forbidden', {
        requestId: requestIdForLog.requestId,
        error: message,
      });
    }
    return NextResponse.json({ error: message }, { status });
  }
}
