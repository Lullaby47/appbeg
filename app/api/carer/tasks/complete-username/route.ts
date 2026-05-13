import { FieldValue } from 'firebase-admin/firestore';
import { NextResponse } from 'next/server';

import { adminDb } from '@/lib/firebase/admin';
import { apiError, requireApiUser, scopedCoadminUid } from '@/lib/firebase/apiAuth';

function normalizeGameName(gameName: string) {
  return gameName.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_');
}
function usernameTaskId(coadminUid: string, playerUid: string, gameName: string) {
  return `create_game_username__${coadminUid}__${playerUid}__${normalizeGameName(gameName)}`;
}
function resetPasswordTaskId(coadminUid: string, playerUid: string, gameName: string) {
  return `reset_password__${coadminUid}__${playerUid}__${normalizeGameName(gameName)}`;
}
function recreateUsernameTaskId(coadminUid: string, playerUid: string, gameName: string) {
  return `recreate_username__${coadminUid}__${playerUid}__${normalizeGameName(gameName)}`;
}

function getNepalHour() {
  const formatter = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Kathmandu', hour: 'numeric', hour12: false });
  const parts = formatter.formatToParts(new Date());
  return Number(parts.find((part) => part.type === 'hour')?.value || '0') || 0;
}
function calculateReward() {
  const night = getNepalHour() >= 22 || getNepalHour() < 6;
  const min = night ? 8 : 5;
  const max = night ? 15 : 10;
  const base = Math.floor(Math.random() * (max - min + 1)) + min;
  if (!night) return base;
  const bonusPercent = Math.floor(Math.random() * (15 - 10 + 1)) + 10;
  return Math.round(base * (1 + bonusPercent / 100));
}

export async function POST(request: Request) {
  try {
    const auth = await requireApiUser(request, ['carer', 'staff', 'coadmin', 'admin']);
    if ('response' in auth) return auth.response;
    const body = (await request.json()) as { coadminUid?: unknown; playerUid?: unknown; gameName?: unknown };
    const coadminUid = String(body.coadminUid || '').trim();
    const playerUid = String(body.playerUid || '').trim();
    const gameName = String(body.gameName || '').trim();
    if (!coadminUid || !playerUid || !gameName) {
      return apiError('coadminUid, playerUid, and gameName are required.', 400);
    }

    if (auth.user.role !== 'admin') {
      const callerScope = scopedCoadminUid(auth.user);
      if (callerScope !== coadminUid) return apiError('Forbidden: task is outside your scope.', 403);
    }

    const taskRefs = [
      adminDb.collection('carerTasks').doc(usernameTaskId(coadminUid, playerUid, gameName)),
      adminDb.collection('carerTasks').doc(resetPasswordTaskId(coadminUid, playerUid, gameName)),
      adminDb.collection('carerTasks').doc(recreateUsernameTaskId(coadminUid, playerUid, gameName)),
    ];
    const userRef = adminDb.collection('users').doc(auth.user.uid);
    let completedTaskCount = 0;
    let totalAwardNpr = 0;

    await adminDb.runTransaction(async (transaction) => {
      const taskSnaps = await Promise.all(taskRefs.map((taskRef) => transaction.get(taskRef)));
      const userSnap = await transaction.get(userRef);
      const userData = userSnap.exists ? (userSnap.data() as { cashBoxNpr?: number }) : { cashBoxNpr: 0 };
      for (const taskSnap of taskSnaps) {
        if (!taskSnap.exists) continue;
        const task = taskSnap.data() as { status?: string; assignedCarerUid?: string | null };
        const status = String(task.status || '').toLowerCase();
        if (status === 'completed') continue;
        if (status !== 'in_progress' || (task.assignedCarerUid && task.assignedCarerUid !== auth.user.uid)) {
          throw new Error('Start the task first so it moves to In Progress before completion.');
        }
        transaction.update(taskSnap.ref, {
          status: 'completed',
          expiresAt: null,
          completedAt: FieldValue.serverTimestamp(),
          ttlExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
          automationStatus: 'completed',
          automationUpdatedAt: FieldValue.serverTimestamp(),
          isPoked: false,
          pokedAt: null,
          pokeMessage: null,
          completedByCarerUid: auth.user.uid,
          completedByCarerUsername: auth.user.username || 'Carer',
        });
        completedTaskCount += 1;
        totalAwardNpr += calculateReward();
      }
      if (completedTaskCount > 0) {
        transaction.set(
          userRef,
          { cashBoxNpr: Number(userData.cashBoxNpr || 0) + totalAwardNpr },
          { merge: true }
        );
      }
    });

    return NextResponse.json({ success: true, completedTaskCount, totalAwardNpr });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to complete username task.';
    const status = /not authenticated|authorization|token/i.test(message) ? 401 : /forbidden|scope/i.test(message) ? 403 : /required|start the task/i.test(message) ? 400 : 409;
    return NextResponse.json({ error: message }, { status });
  }
}

