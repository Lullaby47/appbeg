import { FieldValue } from 'firebase-admin/firestore';
import { NextResponse } from 'next/server';

import { adminDb } from '@/lib/firebase/admin';
import { apiError, requireApiUser, scopedCoadminUid } from '@/lib/firebase/apiAuth';
import {
  isAuthoritySqlWriteEnabled,
  logAuthoritySqlWrite,
} from '@/lib/server/authoritySqlWrite';
import { completeRechargeRedeemTaskInSql } from '@/lib/sql/authorityGameRequests';
import { mirrorCarerTaskById } from '@/lib/sql/carerTasksCache';
import { mirrorFinancialEventById } from '@/lib/sql/financialEventsCache';
import { mirrorPlayerGameRequestById } from '@/lib/sql/playerGameRequestsCache';
import { mirrorUserBalanceSnapshotById } from '@/lib/sql/userBalanceSnapshotsCache';

export const runtime = 'nodejs';

type Body = { taskId?: unknown; idempotencyKey?: unknown };

function ttlAfterDays(days: number) {
  const DAY_MS = 24 * 60 * 60 * 1000;
  return new Date(Date.now() + days * DAY_MS);
}

function getNepalHour() {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Kathmandu',
    hour: 'numeric',
    hour12: false,
  });
  const parts = formatter.formatToParts(new Date());
  return Number(parts.find((part) => part.type === 'hour')?.value || '0') || 0;
}

function isNepalNightTime() {
  const hour = getNepalHour();
  return hour >= 22 || hour < 6;
}

function randomInt(min: number, max: number) {
  const safeMin = Math.min(min, max);
  const safeMax = Math.max(min, max);
  return Math.floor(Math.random() * (safeMax - safeMin + 1)) + safeMin;
}

function calculateRechargeRedeemRewardNpr() {
  const base = isNepalNightTime() ? randomInt(22, 35) : randomInt(12, 22);
  if (!isNepalNightTime()) return base;
  const bonusPercent = randomInt(10, 15);
  return Math.round(base * (1 + bonusPercent / 100));
}

export async function POST(request: Request) {
  try {
    const auth = await requireApiUser(request, ['admin', 'coadmin', 'staff', 'carer']);
    if ('response' in auth) return auth.response;

    const body = (await request.json()) as Body;
    const taskId = String(body.taskId || '').trim();
    if (!taskId) {
      return apiError('taskId is required.', 400);
    }

    const caller = auth.user;
    const callerIsAdmin = caller.role === 'admin';
    const callerScope = scopedCoadminUid(caller);
    const idempotencyKey =
      String(body.idempotencyKey || request.headers.get('Idempotency-Key') || '').trim() || null;

    if (isAuthoritySqlWriteEnabled()) {
      const result = await completeRechargeRedeemTaskInSql({
        taskId,
        actorUid: caller.uid,
        actorUsername: caller.username,
        actorRole: caller.role,
        isAdmin: callerIsAdmin,
        scopeUid: callerScope,
        idempotencyKey,
      });
      logAuthoritySqlWrite('/api/carer/tasks/complete-recharge-redeem', {
        taskId,
        requestId: result.requestId,
        duplicate: result.duplicate,
        alreadyCompleted: result.alreadyCompleted,
      });
      return NextResponse.json({
        success: true,
        alreadyCompleted: result.alreadyCompleted,
        completedTaskCount: result.alreadyCompleted ? 0 : 1,
        totalAwardNpr: result.totalAwardNpr,
        duplicate: result.duplicate,
        authority: 'sql',
      });
    }

    const taskRef = adminDb.collection('carerTasks').doc(taskId);
    const eventRef = adminDb.collection('financialEvents').doc();

    let mirroredRequestId = '';
    let mirroredEventId = '';
    const mirroredUserIds = new Set<string>();
    const result = await adminDb.runTransaction(async (transaction) => {
      const taskSnap = await transaction.get(taskRef);
      if (!taskSnap.exists) {
        throw new Error('Task not found.');
      }
      const task = taskSnap.data() as {
        status?: string;
        assignedCarerUid?: string | null;
        assignedCarerUsername?: string | null;
        assignedCarer?: string | null;
        completedByCarerUid?: string | null;
        completedByCarerUsername?: string | null;
        coadminUid?: string;
        playerUid?: string;
        requestId?: string | null;
      };
      const taskStatus = String(task.status || '').toLowerCase();
      if (taskStatus === 'completed') {
        return { alreadyCompleted: true, completedTaskCount: 0, totalAwardNpr: 0 };
      }
      if (taskStatus !== 'in_progress') {
        throw new Error('Start the task first so it moves to In Progress before completion.');
      }

      const taskScope = String(task.coadminUid || '').trim();
      if (!callerIsAdmin && (!callerScope || callerScope !== taskScope)) {
        throw new Error('Forbidden: task is outside your scope.');
      }
      if (task.assignedCarerUid && task.assignedCarerUid !== caller.uid && !callerIsAdmin) {
        throw new Error('Only the assigned handler can complete this task.');
      }
      const requestId = String(task.requestId || '').trim();
      if (!requestId) {
        throw new Error('This task is not linked to a request.');
      }
      mirroredRequestId = requestId;

      const requestRef = adminDb.collection('playerGameRequests').doc(requestId);
      const playerRef = adminDb.collection('users').doc(String(task.playerUid || '').trim());
      const callerRef = adminDb.collection('users').doc(caller.uid);
      const [requestSnap, playerSnap, callerSnap] = await Promise.all([
        transaction.get(requestRef),
        transaction.get(playerRef),
        transaction.get(callerRef),
      ]);
      if (!requestSnap.exists) throw new Error('Related request not found.');
      if (!playerSnap.exists) throw new Error('Related player not found.');

      const requestData = requestSnap.data() as {
        type?: string;
        amount?: number;
        status?: string;
        coinDeductedOnRequest?: boolean | null;
        firstRechargeMatchApplied?: boolean | null;
        coadminUid?: string | null;
      };
      const requestStatus = String(requestData.status || '').toLowerCase();
      if (requestStatus === 'completed') {
        transaction.update(taskRef, {
          status: 'completed',
          expiresAt: null,
          completedAt: FieldValue.serverTimestamp(),
          ttlExpiresAt: ttlAfterDays(30),
          automationStatus: 'completed',
          automationUpdatedAt: FieldValue.serverTimestamp(),
          claimedStatus: 'completed',
          isPoked: false,
          pokedAt: null,
          pokeMessage: null,
          completedByCarerUid:
            task.completedByCarerUid || task.assignedCarerUid || caller.uid,
          completedByCarerUsername:
            task.completedByCarerUsername ||
            task.assignedCarerUsername ||
            task.assignedCarer ||
            caller.username ||
            'Handler',
        });
        console.info('[automation] task completed from already-completed request', {
          taskId,
          completedByCarerUid:
            task.completedByCarerUid || task.assignedCarerUid || caller.uid,
        });
        return { alreadyCompleted: true, completedTaskCount: 0, totalAwardNpr: 0 };
      }
      if (requestStatus !== 'pending' && requestStatus !== 'poked') {
        throw new Error('Request is not available to complete.');
      }

      const rewardNpr = calculateRechargeRedeemRewardNpr();
      const playerData = playerSnap.data() as {
        coin?: number;
        cash?: number;
        firstRechargeMatchUsed?: boolean | null;
      };
      const requestType = String(requestData.type || '').toLowerCase();
      const amount = Math.max(0, Number(requestData.amount || 0));

      if (requestType === 'redeem') {
        transaction.update(playerRef, {
          cash: Number(playerData.cash || 0) + amount,
        });
        mirroredUserIds.add(String(task.playerUid || '').trim());
      } else if (requestType === 'recharge') {
        if (
          Boolean(requestData.firstRechargeMatchApplied) &&
          !Boolean(playerData.firstRechargeMatchUsed)
        ) {
          transaction.update(playerRef, {
            firstRechargeMatchUsed: true,
            firstRechargeMatchUsedAt: FieldValue.serverTimestamp(),
          });
          mirroredUserIds.add(String(task.playerUid || '').trim());
        }
      } else {
        throw new Error('Unsupported request type for completion.');
      }

      transaction.update(taskRef, {
        status: 'completed',
        expiresAt: null,
        completedAt: FieldValue.serverTimestamp(),
        ttlExpiresAt: ttlAfterDays(30),
        automationStatus: 'completed',
        automationUpdatedAt: FieldValue.serverTimestamp(),
        claimedStatus: 'completed',
        isPoked: false,
        pokedAt: null,
        pokeMessage: null,
        completedByCarerUid: caller.uid,
        completedByCarerUsername: caller.username || 'Handler',
      });
      console.info('[automation] task completed', {
        taskId,
        taskType: requestType === 'redeem' ? 'redeem' : 'recharge',
        completedByCarerUid: caller.uid,
      });
      transaction.update(requestRef, {
        status: 'completed',
        completedAt: FieldValue.serverTimestamp(),
        ttlExpiresAt: ttlAfterDays(90),
        pokedAt: null,
        pokeMessage: null,
      });

      const callerData = callerSnap.exists
        ? (callerSnap.data() as { cashBoxNpr?: number })
        : { cashBoxNpr: 0 };
      const cashBoxBefore = Number(callerData.cashBoxNpr || 0);
      const cashBoxAfter = cashBoxBefore + rewardNpr;
      transaction.update(taskRef, {
        rewardAmountNpr: rewardNpr,
        rewardReason: 'recharge_redeem_task_completion',
        cashBoxBefore,
        cashBoxAfter,
        cashBoxDelta: cashBoxAfter - cashBoxBefore,
        actorUid: caller.uid,
        actorRole: caller.role,
        sourceTaskId: taskId,
        sourceRequestId: requestId,
      });
      transaction.set(
        callerRef,
        {
          cashBoxNpr: cashBoxAfter,
        },
        { merge: true }
      );
      mirroredUserIds.add(caller.uid);

      transaction.set(eventRef, {
        playerUid: String(task.playerUid || '').trim(),
        coadminUid: String(requestData.coadminUid || '').trim() || taskScope,
        amountNpr: amount,
        type: requestType === 'redeem' ? 'redeem' : 'deposit',
        requestId,
        createdAt: FieldValue.serverTimestamp(),
      });
      mirroredEventId = eventRef.id;

      return {
        alreadyCompleted: false,
        completedTaskCount: 1,
        totalAwardNpr: rewardNpr,
      };
    });

    void mirrorCarerTaskById(taskId, 'appbeg_complete_recharge_redeem');
    void mirrorPlayerGameRequestById(mirroredRequestId, 'appbeg_complete_recharge_redeem');
    if (mirroredEventId) {
      void mirrorFinancialEventById(mirroredEventId, 'appbeg_complete_recharge_redeem');
    }
    mirroredUserIds.forEach((uid) => {
      void mirrorUserBalanceSnapshotById(uid, 'appbeg_complete_recharge_redeem');
    });
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to complete task.';
    const status =
      /not authenticated|authorization|token/i.test(message)
        ? 401
        : /forbidden|outside your scope|assigned/i.test(message)
          ? 403
          : /already|not available|in progress|conflict/i.test(message)
            ? 409
            : /required|not found|unsupported|only/i.test(message)
              ? 400
              : 500;
    return NextResponse.json({ error: message }, { status });
  }
}

