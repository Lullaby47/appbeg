import {
  addDoc,
  Timestamp,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  writeBatch,
} from 'firebase/firestore';

import { auth, db } from '@/lib/firebase/client';
import {
  getCurrentUserCoadminUid as getScopedCurrentUserCoadminUid,
} from '@/lib/coadmin/scope';
import { GameLogin, getGameLoginsByCoadmin } from '@/features/games/gameLogins';
import {
  getPlayerGameLoginsByCoadmin,
  PlayerGameLogin,
} from '@/features/games/playerGameLogins';
import {
  getCompletedPlayerGameRequestsByCoadmin,
  getPendingPlayerGameRequestsByCoadmin,
  PlayerGameRequest,
  PlayerGameRequestStatus,
  PlayerGameRequestType,
} from '@/features/games/playerGameRequests';
import { getPlayersByCoadmin, PlayerUser } from '@/features/users/adminUsers';
import { recordFinancialEvent } from '@/features/risk/playerRisk';

export type CarerTaskType =
  | 'create_game_username'
  | 'reset_password'
  | 'recreate_username'
  | PlayerGameRequestType;
export type CarerTaskStatus =
  | 'pending'
  | 'in_progress'
  | 'completed'
  | 'urgent';

export type CarerTask = {
  id: string;
  coadminUid: string;
  type: CarerTaskType;
  playerUid: string;
  playerUsername: string;
  gameName: string;
  amount?: number | null;
  requestId?: string | null;
  status: CarerTaskStatus;
  assignedCarerUid: string | null;
  assignedCarerUsername?: string | null;
  startedAt?: Timestamp | null;
  expiresAt?: Timestamp | null;
  completedAt?: Timestamp | null;
  createdAt?: Timestamp | null;
  isPoked?: boolean;
  pokedAt?: Timestamp | null;
  pokeMessage?: string | null;
  completedByCarerUid?: string | null;
  completedByCarerUsername?: string | null;
  automationStatus?: 'waiting' | 'running' | 'completed' | 'failed' | null;
  automationJobId?: string | null;
  automationUpdatedAt?: Timestamp | null;
};

export type CarerRewardSummary = {
  completedTaskCount: number;
  totalAwardNpr: number;
};

export type CarerEscalationAlert = {
  id: string;
  coadminUid: string;
  contextType?: 'task_help' | 'cashbox_inquiry';
  taskId?: string | null;
  playerUid?: string | null;
  playerUsername?: string | null;
  gameName?: string | null;
  message: string;
  createdByCarerUid: string;
  createdByCarerUsername: string;
  createdAt?: Timestamp | null;
};

export type CarerRechargeRedeemTotals = {
  totalRechargeAmount: number;
  totalRedeemAmount: number;
};

type SyncTaskInput = {
  coadminUid: string;
  players: PlayerUser[];
  games: GameLogin[];
  logins: PlayerGameLogin[];
  pendingRequests: PlayerGameRequest[];
  completedRequests: PlayerGameRequest[];
};

function normalizeGameName(gameName: string) {
  return gameName.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_');
}

function usernameTaskId(
  coadminUid: string,
  playerUid: string,
  gameName: string
) {
  return `create_game_username__${coadminUid}__${playerUid}__${normalizeGameName(
    gameName
  )}`;
}

function resetPasswordTaskId(
  coadminUid: string,
  playerUid: string,
  gameName: string
) {
  return `reset_password__${coadminUid}__${playerUid}__${normalizeGameName(gameName)}`;
}

function recreateUsernameTaskId(
  coadminUid: string,
  playerUid: string,
  gameName: string
) {
  return `recreate_username__${coadminUid}__${playerUid}__${normalizeGameName(gameName)}`;
}

/** Deterministic `carerTasks` document id for a `playerGameRequests` doc. */
export function carerTaskDocIdForPlayerGameRequest(requestId: string) {
  return `request__${requestId}`;
}

function requestTaskId(requestId: string) {
  return carerTaskDocIdForPlayerGameRequest(requestId);
}

function isClaimablePendingTask(task: CarerTask) {
  return getEffectiveCarerTaskStatus(task) === 'pending';
}

function dedupeById<T extends { id: string }>(items: T[]) {
  return Array.from(new Map(items.map((item) => [item.id, item])).values());
}

function toCarerTask(docId: string, value: Omit<CarerTask, 'id'>): CarerTask {
  return {
    id: docId,
    ...value,
  };
}

function getTaskStatusFromRequestStatus(
  requestStatus: PlayerGameRequestStatus
): CarerTaskStatus {
  if (requestStatus === 'completed') {
    return 'completed';
  }
  // Includes pending, plus legacy poked / pending_review from the removed poke flow.
  return 'pending';
}

function buildCompletedTaskUpdate(values: {
  carerUid: string;
  carerUsername?: string | null;
}) {
  return {
    status: 'completed' as const,
    expiresAt: null,
    completedAt: serverTimestamp(),
    isPoked: false,
    pokedAt: null,
    pokeMessage: null,
    completedByCarerUid: values.carerUid,
    completedByCarerUsername: values.carerUsername || null,
  };
}

function getNepalHour() {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Kathmandu',
    hour: 'numeric',
    hour12: false,
  });
  const parts = formatter.formatToParts(new Date());
  const hourPart = parts.find((part) => part.type === 'hour');
  const parsedHour = Number(hourPart?.value || '0');
  return Number.isFinite(parsedHour) ? parsedHour : 0;
}

function isNepalNightTime() {
  const hour = getNepalHour();
  return hour >= 22 || hour < 6;
}

/**
 * Carer reward tuning constants.
 * Keep these centralized so monthly payout targets are easy to calibrate.
 */
const DAY_USERNAME_REWARD_MIN_NPR = 5;
const DAY_USERNAME_REWARD_MAX_NPR = 10;
const NIGHT_USERNAME_REWARD_MIN_NPR = 8;
const NIGHT_USERNAME_REWARD_MAX_NPR = 15;

const DAY_RECHARGE_REDEEM_REWARD_MIN_NPR = 12;
const DAY_RECHARGE_REDEEM_REWARD_MAX_NPR = 22;
const NIGHT_RECHARGE_REDEEM_REWARD_MIN_NPR = 22;
const NIGHT_RECHARGE_REDEEM_REWARD_MAX_NPR = 35;

const NIGHT_BONUS_PERCENT_MIN = 10;
const NIGHT_BONUS_PERCENT_MAX = 15;

const URGENT_PENALTY_MIN_NPR = 0;
const URGENT_PENALTY_MAX_NPR = 30;

function randomInt(min: number, max: number) {
  const safeMin = Math.min(min, max);
  const safeMax = Math.max(min, max);
  return Math.floor(Math.random() * (safeMax - safeMin + 1)) + safeMin;
}

function calculateTaskRewardNpr(baseMin: number, baseMax: number) {
  return randomInt(baseMin, baseMax);
}

function calculateUsernameTaskBaseRewardNpr() {
  return isNepalNightTime()
    ? randomInt(NIGHT_USERNAME_REWARD_MIN_NPR, NIGHT_USERNAME_REWARD_MAX_NPR)
    : randomInt(DAY_USERNAME_REWARD_MIN_NPR, DAY_USERNAME_REWARD_MAX_NPR);
}

function calculateRechargeRedeemBaseRewardNpr() {
  return isNepalNightTime()
    ? calculateTaskRewardNpr(
        NIGHT_RECHARGE_REDEEM_REWARD_MIN_NPR,
        NIGHT_RECHARGE_REDEEM_REWARD_MAX_NPR
      )
    : calculateTaskRewardNpr(
        DAY_RECHARGE_REDEEM_REWARD_MIN_NPR,
        DAY_RECHARGE_REDEEM_REWARD_MAX_NPR
      );
}

/**
 * Formula order:
 * baseReward -> (night bonus) -> (urgent penalty) -> finalReward
 */
function applyNightBonusNpr(baseRewardNpr: number) {
  if (!isNepalNightTime()) {
    return baseRewardNpr;
  }

  const bonusPercent = randomInt(NIGHT_BONUS_PERCENT_MIN, NIGHT_BONUS_PERCENT_MAX);
  return Math.round(baseRewardNpr * (1 + bonusPercent / 100));
}

function applyUrgentPenaltyNpr(rewardWithBonusNpr: number, isUrgentOrPoked: boolean) {
  const penaltyNpr = isUrgentOrPoked
    ? randomInt(URGENT_PENALTY_MIN_NPR, URGENT_PENALTY_MAX_NPR)
    : 0;
  return Math.max(0, rewardWithBonusNpr - penaltyNpr);
}

function mapCarerEscalationAlert(
  docId: string,
  value: Omit<CarerEscalationAlert, 'id'>
) {
  return {
    id: docId,
    ...value,
  } satisfies CarerEscalationAlert;
}

async function getCurrentCarerIdentity() {
  const currentUser = auth.currentUser;

  if (!currentUser) {
    throw new Error('Not authenticated.');
  }

  const userSnap = await getDoc(doc(db, 'users', currentUser.uid));

  if (!userSnap.exists()) {
    throw new Error('Current carer profile not found.');
  }

  const userData = userSnap.data() as { username?: string };

  return {
    uid: currentUser.uid,
    username: userData.username?.trim() || 'Carer',
  };
}

async function getCurrentUserIdentityForEscalation() {
  const currentUser = auth.currentUser;

  if (!currentUser) {
    throw new Error('Not authenticated.');
  }

  const userSnap = await getDoc(doc(db, 'users', currentUser.uid));

  if (!userSnap.exists()) {
    throw new Error('Current user profile not found.');
  }

  const userData = userSnap.data() as { username?: string };

  return {
    uid: currentUser.uid,
    username: userData.username?.trim() || 'User',
  };
}

function buildUsernameTask(
  coadminUid: string,
  player: PlayerUser,
  game: GameLogin
): CarerTask {
  return toCarerTask(usernameTaskId(coadminUid, player.uid, game.gameName), {
    coadminUid,
    type: 'create_game_username',
    playerUid: player.uid,
    playerUsername: player.username || 'Player',
    gameName: game.gameName || 'Unknown Game',
    amount: null,
    requestId: null,
    status: 'pending',
    assignedCarerUid: null,
    assignedCarerUsername: null,
    startedAt: null,
    expiresAt: null,
    completedAt: null,
    createdAt: null,
    isPoked: false,
    pokedAt: null,
    pokeMessage: null,
    completedByCarerUid: null,
    completedByCarerUsername: null,
  });
}

function buildRequestTask(
  coadminUid: string,
  request: PlayerGameRequest,
  playerUsername: string
): CarerTask {
  const nextStatus = getTaskStatusFromRequestStatus(request.status);

  return toCarerTask(requestTaskId(request.id), {
    coadminUid,
    type: request.type,
    playerUid: request.playerUid,
    playerUsername: playerUsername || 'Player',
    gameName: request.gameName || 'Unknown Game',
    amount: request.amount ?? null,
    requestId: request.id,
    status: nextStatus,
    assignedCarerUid: null,
    assignedCarerUsername: null,
    startedAt: null,
    expiresAt: null,
    completedAt: request.completedAt || null,
    createdAt: request.createdAt || null,
    isPoked: false,
    pokedAt: null,
    pokeMessage: null,
    completedByCarerUid: null,
    completedByCarerUsername: null,
  });
}

/**
 * Same merge rules as {@link syncCarerTasks} for a single request-linked task.
 * Used by sync and by immediate upserts after player request mutations.
 */
export function computeRequestLinkedCarerTaskWrite(
  coadminUid: string,
  request: PlayerGameRequest,
  playerUsername: string,
  existingTask: CarerTask | undefined
): Record<string, unknown> {
  const task = buildRequestTask(coadminUid, request, playerUsername);
  const desiredStatus = task.status;
  const existingCompletedAt = existingTask?.completedAt || null;
  const existingCompletedByUid =
    existingTask?.completedByCarerUid || existingTask?.assignedCarerUid || null;
  const existingCompletedByUsername =
    existingTask?.completedByCarerUsername ||
    existingTask?.assignedCarerUsername ||
    null;
  const existingEffectiveStatus = existingTask
    ? getEffectiveCarerTaskStatus(existingTask)
    : null;
  const shouldPreserveExistingStatus =
    desiredStatus === 'pending' &&
    (existingEffectiveStatus === 'in_progress' ||
      existingEffectiveStatus === 'completed');
  const nextStatus = shouldPreserveExistingStatus
    ? existingEffectiveStatus
    : desiredStatus;

  return {
    ...task,
    status: nextStatus,
    assignedCarerUid:
      nextStatus === 'in_progress'
        ? existingTask?.assignedCarerUid ?? null
        : nextStatus === 'urgent'
          ? existingTask?.assignedCarerUid ||
            existingCompletedByUid ||
            null
          : nextStatus === 'completed'
            ? existingTask?.assignedCarerUid ||
              existingCompletedByUid ||
              null
            : existingTask?.assignedCarerUid ?? null,
    assignedCarerUsername:
      nextStatus === 'in_progress'
        ? existingTask?.assignedCarerUsername ?? null
        : nextStatus === 'urgent'
          ? existingTask?.assignedCarerUsername ||
            existingCompletedByUsername ||
            null
          : nextStatus === 'completed'
            ? existingTask?.assignedCarerUsername ||
              existingCompletedByUsername ||
              null
            : existingTask?.assignedCarerUsername ?? null,
    startedAt:
      nextStatus === 'in_progress'
        ? existingTask?.startedAt || serverTimestamp()
        : nextStatus === 'pending' || nextStatus === 'completed'
          ? null
          : existingTask?.startedAt ?? null,
    expiresAt:
      nextStatus === 'in_progress'
        ? existingTask?.expiresAt ?? null
        : nextStatus === 'pending' ||
            nextStatus === 'completed' ||
            nextStatus === 'urgent'
          ? null
          : existingTask?.expiresAt ?? null,
    completedAt:
      nextStatus === 'completed'
        ? request.completedAt || existingCompletedAt || serverTimestamp()
        : nextStatus === 'urgent'
          ? request.completedAt || existingCompletedAt || null
          : null,
    createdAt: request.createdAt || existingTask?.createdAt || serverTimestamp(),
    isPoked: false,
    pokedAt: null,
    pokeMessage: null,
    completedByCarerUid:
      nextStatus === 'completed' || nextStatus === 'urgent'
        ? existingCompletedByUid
        : null,
    completedByCarerUsername:
      nextStatus === 'completed' || nextStatus === 'urgent'
        ? existingCompletedByUsername
        : null,
  };
}

/**
 * Upserts `carerTasks/{request__requestId}` from the current request document shape.
 * Call after every player-side create/update to the linked `playerGameRequests` doc.
 */
export async function upsertCarerTaskForPlayerGameRequest(
  request: PlayerGameRequest
): Promise<void> {
  const coadminUid = String(request.coadminUid || request.createdBy || '').trim();
  if (!request.id.trim() || !coadminUid) {
    return;
  }

  const playerSnap = await getDoc(doc(db, 'users', request.playerUid));
  const playerUsername = playerSnap.exists()
    ? String((playerSnap.data() as { username?: string }).username || '').trim() ||
      'Player'
    : 'Player';

  const taskRef = doc(db, 'carerTasks', requestTaskId(request.id));
  const existingSnap = await getDoc(taskRef);
  const existingTask = existingSnap.exists()
    ? toCarerTask(existingSnap.id, existingSnap.data() as Omit<CarerTask, 'id'>)
    : undefined;

  const payload = computeRequestLinkedCarerTaskWrite(
    coadminUid,
    request,
    playerUsername,
    existingTask
  );
  await setDoc(taskRef, payload, { merge: true });
}

async function getCurrentCoadminTasks(coadminUid: string) {
  const tasksQuery = query(
    collection(db, 'carerTasks'),
    where('coadminUid', '==', coadminUid)
  );
  const snapshot = await getDocs(tasksQuery);

  return new Map(
    snapshot.docs.map((docSnap) => [
      docSnap.id,
      {
        id: docSnap.id,
        ...(docSnap.data() as Omit<CarerTask, 'id'>),
      } as CarerTask,
    ])
  );
}

function getVisibleTaskForCarer(task: CarerTask, currentCarerUid: string) {
  const effectiveStatus = getEffectiveCarerTaskStatus(task);

  if (effectiveStatus === 'completed') {
    return {
      ...task,
      status: 'completed',
    } satisfies CarerTask;
  }

  if (effectiveStatus === 'urgent') {
    if (task.assignedCarerUid !== currentCarerUid) {
      return null;
    }

    return {
      ...task,
      status: 'urgent',
      startedAt: null,
      expiresAt: null,
    } satisfies CarerTask;
  }

  if (effectiveStatus === 'pending') {
    return {
      ...task,
      status: 'pending',
      assignedCarerUid: null,
      assignedCarerUsername: null,
      startedAt: null,
      expiresAt: null,
    } satisfies CarerTask;
  }

  if (task.assignedCarerUid === currentCarerUid) {
    return task;
  }

  return null;
}

export async function getCurrentUserCoadminUid() {
  return getScopedCurrentUserCoadminUid();
}

export function getCarerTaskCountdown() {
  return 0;
}

export function getEffectiveCarerTaskStatus(task: CarerTask): CarerTaskStatus {
  return task.status;
}

export async function syncCarerTasks({
  coadminUid,
  players,
  games,
  logins,
  pendingRequests,
  completedRequests,
}: SyncTaskInput) {
  const existingTasks = await getCurrentCoadminTasks(coadminUid);
  const activePlayerUidSet = new Set(players.map((player) => player.uid));
  const playerNameMap = new Map(
    players.map((player) => [player.uid, player.username || 'Player'])
  );
  const loginKeySet = new Set(
    logins.map(
      (login) => `${login.playerUid}::${normalizeGameName(login.gameName || '')}`
    )
  );
  const allRequests = [...pendingRequests, ...completedRequests];
  const requestIds = new Set(allRequests.map((request) => request.id));

  const batch = writeBatch(db);
  let changed = false;

  for (const player of players) {
    for (const game of games) {
      const taskId = usernameTaskId(coadminUid, player.uid, game.gameName);
      const taskRef = doc(db, 'carerTasks', taskId);
      const existingTask = existingTasks.get(taskId);
      const hasLogin = loginKeySet.has(
        `${player.uid}::${normalizeGameName(game.gameName || '')}`
      );

      if (!existingTask && !hasLogin) {
        const task = buildUsernameTask(coadminUid, player, game);
        batch.set(taskRef, {
          ...task,
          createdAt: serverTimestamp(),
        });
        changed = true;
        continue;
      }

      if (!existingTask) {
        continue;
      }

      if (hasLogin && existingTask.status !== 'completed') {
        batch.update(taskRef, {
          playerUsername: player.username || 'Player',
          gameName: game.gameName || 'Unknown Game',
          status: 'completed',
          assignedCarerUid: existingTask.assignedCarerUid ?? null,
          assignedCarerUsername: existingTask.assignedCarerUsername ?? null,
          startedAt: existingTask.startedAt ?? null,
          expiresAt: null,
          completedAt: serverTimestamp(),
          isPoked: false,
          pokedAt: null,
          pokeMessage: null,
          completedByCarerUid:
            existingTask.completedByCarerUid || existingTask.assignedCarerUid || null,
          completedByCarerUsername:
            existingTask.completedByCarerUsername ||
            existingTask.assignedCarerUsername ||
            null,
        });
        changed = true;
        continue;
      }

      if (!hasLogin && existingTask.status === 'completed' && !existingTask.requestId) {
        batch.update(taskRef, {
          playerUsername: player.username || 'Player',
          gameName: game.gameName || 'Unknown Game',
          status: 'pending',
          assignedCarerUid: null,
          assignedCarerUsername: null,
          startedAt: null,
          expiresAt: null,
          completedAt: null,
          isPoked: false,
          pokedAt: null,
          pokeMessage: null,
          completedByCarerUid: null,
          completedByCarerUsername: null,
        });
        changed = true;
        continue;
      }

      if (
        existingTask.playerUsername !== (player.username || 'Player') ||
        existingTask.gameName !== (game.gameName || 'Unknown Game')
      ) {
        batch.update(taskRef, {
          playerUsername: player.username || 'Player',
          gameName: game.gameName || 'Unknown Game',
        });
        changed = true;
      }
    }
  }

  for (const request of allRequests) {
    const taskId = requestTaskId(request.id);
    const taskRef = doc(db, 'carerTasks', taskId);
    const existingTask = existingTasks.get(taskId);
    const playerUsername = playerNameMap.get(request.playerUid) || 'Player';
    const payload = computeRequestLinkedCarerTaskWrite(
      coadminUid,
      request,
      playerUsername,
      existingTask
    );

    batch.set(taskRef, payload, { merge: true });
    changed = true;
  }

  for (const existingTask of existingTasks.values()) {
    if (!activePlayerUidSet.has(existingTask.playerUid)) {
      if (existingTask.status === 'completed') {
        continue;
      }

      batch.update(doc(db, 'carerTasks', existingTask.id), {
        status: 'completed',
        assignedCarerUid: existingTask.assignedCarerUid ?? null,
        assignedCarerUsername: existingTask.assignedCarerUsername ?? null,
        startedAt: null,
        expiresAt: null,
        completedAt: existingTask.completedAt ?? serverTimestamp(),
        isPoked: false,
        pokedAt: null,
        pokeMessage: null,
        completedByCarerUid:
          existingTask.completedByCarerUid || existingTask.assignedCarerUid || null,
        completedByCarerUsername:
          existingTask.completedByCarerUsername ||
          existingTask.assignedCarerUsername ||
          null,
      });
      changed = true;
      continue;
    }

    if (existingTask.type === 'create_game_username') {
      continue;
    }

    if (!existingTask.requestId || requestIds.has(existingTask.requestId)) {
      continue;
    }

    if (existingTask.status === 'completed') {
      continue;
    }

    batch.update(doc(db, 'carerTasks', existingTask.id), {
      status: 'completed',
      assignedCarerUid: existingTask.assignedCarerUid ?? null,
      assignedCarerUsername: existingTask.assignedCarerUsername ?? null,
      startedAt: null,
      expiresAt: null,
      completedAt: serverTimestamp(),
      isPoked: false,
      pokedAt: null,
      pokeMessage: null,
      completedByCarerUid:
        existingTask.completedByCarerUid || existingTask.assignedCarerUid || null,
      completedByCarerUsername:
        existingTask.completedByCarerUsername ||
        existingTask.assignedCarerUsername ||
        null,
    });
    changed = true;
  }

  if (changed) {
    await batch.commit();
  }
}

async function dropPendingRechargeRequestsWithoutEnoughCoin(
  pendingRequests: PlayerGameRequest[],
  players: PlayerUser[]
) {
  const rechargeRequests = pendingRequests.filter((request) => request.type === 'recharge');

  if (rechargeRequests.length === 0) {
    return pendingRequests;
  }

  const coinByPlayerUid = new Map(
    players.map((player) => [player.uid, Number(player.coin || 0)] as const)
  );

  const invalidRechargeIds = rechargeRequests
    .filter((request) => {
      if (request.coinDeductedOnRequest) {
        return false;
      }
      const playerCoin = Number(coinByPlayerUid.get(request.playerUid) || 0);
      const rechargeAmount = Math.max(0, Number(request.amount || 0));
      return playerCoin < rechargeAmount;
    })
    .map((request) => request.id);

  if (invalidRechargeIds.length === 0) {
    return pendingRequests;
  }

  const invalidSet = new Set(invalidRechargeIds);
  const batch = writeBatch(db);
  invalidRechargeIds.forEach((requestId) => {
    batch.delete(doc(db, 'playerGameRequests', requestId));
    batch.delete(doc(db, 'carerTasks', requestTaskId(requestId)));
  });
  await batch.commit();

  return pendingRequests.filter((request) => !invalidSet.has(request.id));
}

export async function syncCarerTasksForCoadmin(coadminUid: string) {
  const players = dedupeById(
    (await getPlayersByCoadmin(coadminUid)).filter((player) => player.status !== 'disabled')
  );
  const games = dedupeById(await getGameLoginsByCoadmin(coadminUid));
  const logins = dedupeById(await getPlayerGameLoginsByCoadmin(coadminUid));
  const pendingRequestsRaw = await getPendingPlayerGameRequestsByCoadmin(coadminUid);
  const pendingRequests = await dropPendingRechargeRequestsWithoutEnoughCoin(
    pendingRequestsRaw.filter((request) => players.some((player) => player.uid === request.playerUid)),
    players
  );
  const completedRequests = (await getCompletedPlayerGameRequestsByCoadmin(coadminUid)).filter(
    (request) => players.some((player) => player.uid === request.playerUid)
  );

  await syncCarerTasks({
    coadminUid,
    players,
    games,
    logins,
    pendingRequests,
    completedRequests,
  });

  return {
    players,
    games,
    logins,
    pendingRequests,
    completedRequests,
  };
}

export function listenToAvailableCarerTasks(
  coadminUid: string,
  currentCarerUid: string,
  callback: (tasks: CarerTask[]) => void,
  onError?: (error: Error) => void
) {
  const tasksQuery = query(
    collection(db, 'carerTasks'),
    where('coadminUid', '==', coadminUid),
    where('status', 'in', ['pending', 'in_progress', 'urgent'])
  );

  return onSnapshot(
    tasksQuery,
    (snapshot) => {
      const tasks = snapshot.docs
        .map((docSnap) => {
          const task = {
            id: docSnap.id,
            ...(docSnap.data() as Omit<CarerTask, 'id'>),
          } satisfies CarerTask;

          return getVisibleTaskForCarer(task, currentCarerUid);
        })
        .filter((task): task is CarerTask => Boolean(task));

      callback(tasks);
    },
    (error) => {
      onError?.(error as Error);
    }
  );
}

export async function releaseExpiredCarerTasks(coadminUid: string) {
  void coadminUid;
}

export async function startCarerTask(taskId: string) {
  const { uid: carerUid, username: carerUsername } = await getCurrentCarerIdentity();
  const taskRef = doc(db, 'carerTasks', taskId);

  await runTransaction(db, async (transaction) => {
    const taskSnap = await transaction.get(taskRef);

    if (!taskSnap.exists()) {
      throw new Error('Task not found.');
    }

    const task = taskSnap.data() as Omit<CarerTask, 'id'>;
    const effectiveStatus = getEffectiveCarerTaskStatus({
      id: taskId,
      ...task,
    });

    if (effectiveStatus === 'completed') {
      throw new Error('Task already completed.');
    }

    if (effectiveStatus === 'urgent' && task.assignedCarerUid !== carerUid) {
      throw new Error('This urgent task is locked to another carer.');
    }

    if (
      effectiveStatus === 'in_progress' &&
      task.assignedCarerUid !== carerUid
    ) {
      throw new Error('Task is already assigned to another carer.');
    }

    const rechargeRequestRef =
      task.type === 'recharge' && task.requestId
        ? doc(db, 'playerGameRequests', task.requestId)
        : null;
    const rechargePlayerRef =
      task.type === 'recharge' ? doc(db, 'users', task.playerUid) : null;
    const rechargeRequestSnap = rechargeRequestRef
      ? await transaction.get(rechargeRequestRef)
      : null;
    const rechargePlayerSnap = rechargePlayerRef
      ? await transaction.get(rechargePlayerRef)
      : null;

    if (task.type === 'recharge') {
      if (!rechargeRequestRef || !rechargeRequestSnap?.exists()) {
        transaction.delete(taskRef);
        throw new Error('Recharge task dismissed: linked request not found.');
      }

      if (!rechargePlayerRef || !rechargePlayerSnap?.exists()) {
        transaction.delete(taskRef);
        transaction.delete(rechargeRequestRef);
        throw new Error('Recharge task dismissed: player profile not found.');
      }

      const requestData = rechargeRequestSnap.data() as Omit<PlayerGameRequest, 'id'>;
      const playerData = rechargePlayerSnap.data() as { coin?: number };
      const rechargeAmount = Math.max(0, Number(requestData.amount || 0));
      const currentCoin = Number(playerData.coin || 0);
      const coinAlreadyHeld = Boolean(
        (requestData as { coinDeductedOnRequest?: boolean | null })
          .coinDeductedOnRequest
      );

      if (
        !coinAlreadyHeld &&
        currentCoin < rechargeAmount
      ) {
        transaction.delete(taskRef);
        transaction.delete(rechargeRequestRef);
        throw new Error('Recharge task dismissed: player has insufficient coin balance.');
      }
    }

    const now = Timestamp.now();

    transaction.update(taskRef, {
      status: 'in_progress',
      assignedCarerUid: carerUid,
      assignedCarerUsername: carerUsername,
      startedAt: now,
      expiresAt: null,
      completedAt:
        effectiveStatus === 'urgent'
          ? task.completedAt || null
          : null,
      completedByCarerUid:
        effectiveStatus === 'urgent'
          ? task.completedByCarerUid || task.assignedCarerUid || null
          : task.completedByCarerUid || null,
      completedByCarerUsername:
        effectiveStatus === 'urgent'
          ? task.completedByCarerUsername || task.assignedCarerUsername || null
          : task.completedByCarerUsername || null,
    });
  });
}

export async function completeCarerTask(taskId: string) {
  const { uid: carerUid, username: carerUsername } =
    await getCurrentCarerIdentity();
  const taskRef = doc(db, 'carerTasks', taskId);

  await runTransaction(db, async (transaction) => {
    const taskSnap = await transaction.get(taskRef);

    if (!taskSnap.exists()) {
      throw new Error('Task not found.');
    }

    const task = taskSnap.data() as Omit<CarerTask, 'id'>;
    const effectiveStatus = getEffectiveCarerTaskStatus({
      id: taskId,
      ...task,
    });

    if (effectiveStatus !== 'in_progress' || task.assignedCarerUid !== carerUid) {
      throw new Error('Only the assigned carer can complete this task.');
    }

    transaction.update(taskRef, buildCompletedTaskUpdate({
      carerUid,
      carerUsername,
    }));
  });
}

export async function completeUsernameTaskForPlayerGame(
  coadminUid: string,
  playerUid: string,
  gameName: string
) {
  const { uid: carerUid, username: carerUsername } =
    await getCurrentCarerIdentity();
  const taskRefs = [
    doc(db, 'carerTasks', usernameTaskId(coadminUid, playerUid, gameName)),
    doc(db, 'carerTasks', resetPasswordTaskId(coadminUid, playerUid, gameName)),
    doc(db, 'carerTasks', recreateUsernameTaskId(coadminUid, playerUid, gameName)),
  ];

  let completedTaskCount = 0;
  let totalAwardNpr = 0;

  await runTransaction(db, async (transaction) => {
    const taskSnaps = await Promise.all(taskRefs.map((taskRef) => transaction.get(taskRef)));
    const carerRef = doc(db, 'users', carerUid);
    const carerSnap = await transaction.get(carerRef);
    const carerData = carerSnap.exists()
      ? (carerSnap.data() as { cashBoxNpr?: number })
      : { cashBoxNpr: 0 };

    for (const taskSnap of taskSnaps) {
      if (!taskSnap.exists()) {
        continue;
      }

      const task = taskSnap.data() as Omit<CarerTask, 'id'>;
      const effectiveStatus = getEffectiveCarerTaskStatus({
        id: taskSnap.id,
        ...task,
      });

      if (effectiveStatus === 'completed') {
        continue;
      }

      if (effectiveStatus !== 'in_progress' || task.assignedCarerUid !== carerUid) {
        throw new Error('Start the task first so it moves to In Progress before completion.');
      }

      transaction.update(taskSnap.ref, buildCompletedTaskUpdate({
        carerUid,
        carerUsername,
      }));
      completedTaskCount += 1;
      const baseRewardNpr = calculateUsernameTaskBaseRewardNpr();
      const rewardWithBonusNpr = applyNightBonusNpr(baseRewardNpr);
      totalAwardNpr += rewardWithBonusNpr;
    }

    if (completedTaskCount > 0) {
      transaction.set(
        carerRef,
        {
          cashBoxNpr: Number(carerData.cashBoxNpr || 0) + totalAwardNpr,
        },
        { merge: true }
      );
    }
  });

  return {
    completedTaskCount,
    totalAwardNpr,
  } satisfies CarerRewardSummary;
}

export async function createPlayerCredentialTask(values: {
  taskType: 'reset_password' | 'recreate_username';
  playerUid: string;
  playerUsername: string;
  gameName: string;
  coadminUid: string;
}) {
  const currentUser = auth.currentUser;

  if (!currentUser) {
    throw new Error('Not authenticated.');
  }

  if (currentUser.uid !== values.playerUid) {
    throw new Error('You can only create credential tasks for your own account.');
  }

  if (!values.gameName.trim()) {
    throw new Error('Game name is required.');
  }

  const taskId =
    values.taskType === 'reset_password'
      ? resetPasswordTaskId(values.coadminUid, values.playerUid, values.gameName)
      : recreateUsernameTaskId(values.coadminUid, values.playerUid, values.gameName);

  const taskRef = doc(db, 'carerTasks', taskId);

  await setDoc(
    taskRef,
    {
      coadminUid: values.coadminUid,
      type: values.taskType,
      playerUid: values.playerUid,
      playerUsername: values.playerUsername || 'Player',
      gameName: values.gameName.trim(),
      amount: null,
      requestId: null,
      status: 'pending',
      assignedCarerUid: null,
      assignedCarerUsername: null,
      startedAt: null,
      expiresAt: null,
      completedAt: null,
      isPoked: false,
      pokedAt: null,
      pokeMessage: null,
      completedByCarerUid: null,
      completedByCarerUsername: null,
      createdAt: serverTimestamp(),
    },
    { merge: true }
  );
}

export async function sendCarerEscalationAlert(task: CarerTask) {
  const { uid: carerUid, username: carerUsername } =
    await getCurrentCarerIdentity();

  await addDoc(collection(db, 'carerEscalationAlerts'), {
    coadminUid: task.coadminUid,
    contextType: 'task_help',
    taskId: task.id,
    playerUid: task.playerUid,
    playerUsername: task.playerUsername || 'Player',
    gameName: task.gameName || 'Unknown Game',
    message: 'This player is being an idiot.',
    createdByCarerUid: carerUid,
    createdByCarerUsername: carerUsername,
    createdAt: serverTimestamp(),
  });
}

export async function sendCarerCashboxInquiryAlert(values: {
  coadminUid: string;
  message: string;
}) {
  const { uid: senderUid, username: senderUsername } =
    await getCurrentUserIdentityForEscalation();
  const cleanMessage = values.message.trim();

  if (!cleanMessage) {
    throw new Error('Inquiry message is required.');
  }

  await addDoc(collection(db, 'carerEscalationAlerts'), {
    coadminUid: values.coadminUid,
    contextType: 'cashbox_inquiry',
    taskId: null,
    playerUid: null,
    playerUsername: null,
    gameName: null,
    message: cleanMessage,
    createdByCarerUid: senderUid,
    createdByCarerUsername: senderUsername,
    createdAt: serverTimestamp(),
  });
}

export function listenToCarerEscalationAlertsByCoadmin(
  coadminUid: string,
  onChange: (alerts: CarerEscalationAlert[]) => void,
  onError?: (error: Error) => void
) {
  const alertsQuery = query(
    collection(db, 'carerEscalationAlerts'),
    where('coadminUid', '==', coadminUid)
  );

  return onSnapshot(
    alertsQuery,
    (snapshot) => {
      const alerts = snapshot.docs
        .map((docSnap) =>
          mapCarerEscalationAlert(
            docSnap.id,
            docSnap.data() as Omit<CarerEscalationAlert, 'id'>
          )
        )
        .sort((a, b) => {
          const aTime = a.createdAt?.toMillis?.() || 0;
          const bTime = b.createdAt?.toMillis?.() || 0;
          return bTime - aTime;
        });

      onChange(alerts);
    },
    (error) => {
      onError?.(error as Error);
    }
  );
}

export function listenToCarerEscalationAlerts(
  onChange: (alerts: CarerEscalationAlert[]) => void,
  onError?: (error: Error) => void
) {
  const alertsQuery = query(collection(db, 'carerEscalationAlerts'));

  return onSnapshot(
    alertsQuery,
    (snapshot) => {
      const alerts = snapshot.docs
        .map((docSnap) =>
          mapCarerEscalationAlert(
            docSnap.id,
            docSnap.data() as Omit<CarerEscalationAlert, 'id'>
          )
        )
        .sort((a, b) => {
          const aTime = a.createdAt?.toMillis?.() || 0;
          const bTime = b.createdAt?.toMillis?.() || 0;
          return bTime - aTime;
        });

      onChange(alerts);
    },
    (error) => {
      onError?.(error as Error);
    }
  );
}

export async function deleteCarerEscalationAlert(alertId: string) {
  await deleteDoc(doc(db, 'carerEscalationAlerts', alertId));
}

export async function completeRechargeRedeemTask(task: CarerTask) {
  if (!task.requestId) {
    throw new Error('This task is not linked to a request.');
  }

  const { uid: carerUid, username: carerUsername } =
    await getCurrentCarerIdentity();
  const taskRef = doc(db, 'carerTasks', task.id);
  const requestRef = doc(db, 'playerGameRequests', task.requestId);
  const playerRef = doc(db, 'users', task.playerUid);

  const baseRewardNpr = calculateRechargeRedeemBaseRewardNpr();
  let finalRewardFromTransaction = baseRewardNpr;
  let completedEventType: 'deposit' | 'redeem' = 'deposit';
  let completedEventAmount = 0;
  let completedEventCoadminUid = task.coadminUid;

  await runTransaction(db, async (transaction) => {
    const [taskSnap, requestSnap, playerSnap] = await Promise.all([
      transaction.get(taskRef),
      transaction.get(requestRef),
      transaction.get(playerRef),
    ]);
    const carerRef = doc(db, 'users', carerUid);
    const carerSnap = await transaction.get(carerRef);

    if (!taskSnap.exists()) {
      throw new Error('Task not found.');
    }

    if (!requestSnap.exists()) {
      throw new Error('Related request not found.');
    }

    if (!playerSnap.exists()) {
      throw new Error('Related player not found.');
    }

    const taskData = taskSnap.data() as Omit<CarerTask, 'id'>;
    const requestData = requestSnap.data() as Omit<PlayerGameRequest, 'id'>;
    const playerData = playerSnap.data() as {
      coin?: number;
      cash?: number;
      activeBonusStaffUid?: string | null;
      activeBonusEventId?: string | null;
      activeBonusEventName?: string | null;
      activeBonusPercentage?: number | null;
    };
    const bonusStaffUid = String(playerData.activeBonusStaffUid || '').trim();
    const bonusStaffRef = bonusStaffUid ? doc(db, 'users', bonusStaffUid) : null;
    const bonusStaffSnap = bonusStaffRef
      ? await transaction.get(bonusStaffRef)
      : null;
    const effectiveStatus = getEffectiveCarerTaskStatus({
      id: task.id,
      ...taskData,
    });

    if (effectiveStatus !== 'in_progress' || taskData.assignedCarerUid !== carerUid) {
      throw new Error('Only the assigned carer can complete this task.');
    }

    const rewardWithBonusNpr = applyNightBonusNpr(baseRewardNpr);
    const finalRewardNpr = applyUrgentPenaltyNpr(rewardWithBonusNpr, false);
    finalRewardFromTransaction = finalRewardNpr;

    if (requestData.type === 'recharge') {
      const rechargeAmount = Math.max(0, Number(requestData.amount || 0));
      const coinAlreadyHeld = Boolean(
        (requestData as { coinDeductedOnRequest?: boolean | null })
          .coinDeductedOnRequest
      );
      completedEventType = 'deposit';
      completedEventAmount = rechargeAmount;
      completedEventCoadminUid = requestData.coadminUid || task.coadminUid;
      const currentCoin = Number(playerData.coin || 0);
      const nextPlayerUpdate: Record<string, unknown> = {};

      if (!coinAlreadyHeld) {
        if (currentCoin < rechargeAmount) {
          throw new Error(
            'Cannot complete: player no longer has enough coin for this recharge. Dismiss the task or wait for the player to top up.'
          );
        }
        nextPlayerUpdate.coin = currentCoin - rechargeAmount;
      }

      if (bonusStaffUid && bonusStaffRef) {
        const configuredBonusPercent = Number(playerData.activeBonusPercentage || 0);
        const bonusPercent =
          configuredBonusPercent > 20
            ? Number((Math.random() * 1.9 + 0.1).toFixed(2)) // 0.10% - 1.99%
            : Math.floor(Math.random() * 11) + 5; // 5-15%
        const bonusRewardNpr = Math.max(
          1,
          Math.round((Number(requestData.amount || 0) * bonusPercent) / 100)
        );
        const bonusStaffData = bonusStaffSnap?.exists()
          ? (bonusStaffSnap.data() as { cashBoxNpr?: number })
          : { cashBoxNpr: 0 };

        transaction.set(
          bonusStaffRef,
          {
            cashBoxNpr: Number(bonusStaffData.cashBoxNpr || 0) + bonusRewardNpr,
          },
          { merge: true }
        );

        nextPlayerUpdate.activeBonusStaffUid = null;
        nextPlayerUpdate.activeBonusEventId = null;
        nextPlayerUpdate.activeBonusEventName = null;
        nextPlayerUpdate.activeBonusPercentage = null;
      }

      if (Object.keys(nextPlayerUpdate).length > 0) {
        transaction.update(playerRef, nextPlayerUpdate);
      }

      transaction.update(taskRef, buildCompletedTaskUpdate({
        carerUid,
        carerUsername,
      }));

      transaction.update(requestRef, {
        status: 'completed',
        completedAt: serverTimestamp(),
        pokedAt: null,
        pokeMessage: null,
      });
    } else if (requestData.type === 'redeem') {
      const redeemAmount = Math.max(0, Number(requestData.amount || 0));
      completedEventType = 'redeem';
      completedEventAmount = redeemAmount;
      completedEventCoadminUid = requestData.coadminUid || task.coadminUid;

      transaction.update(taskRef, buildCompletedTaskUpdate({
        carerUid,
        carerUsername,
      }));

      transaction.update(requestRef, {
        status: 'completed',
        completedAt: serverTimestamp(),
        pokedAt: null,
        pokeMessage: null,
      });

      transaction.update(playerRef, {
        cash: Number(playerData.cash || 0) + redeemAmount,
      });
    } else {
      throw new Error('Unsupported request type for completion.');
    }

    const carerData = carerSnap.exists()
      ? (carerSnap.data() as { cashBoxNpr?: number })
      : { cashBoxNpr: 0 };

    transaction.set(
      carerRef,
      {
        cashBoxNpr: Number(carerData.cashBoxNpr || 0) + finalRewardNpr,
      },
      { merge: true }
    );
  });

  if (completedEventAmount > 0) {
    await recordFinancialEvent({
      playerUid: task.playerUid,
      coadminUid: completedEventCoadminUid,
      amountNpr: completedEventAmount,
      type: completedEventType,
    });
  }

  return {
    completedTaskCount: 1,
    totalAwardNpr: finalRewardFromTransaction,
  } satisfies CarerRewardSummary;
}

export async function ensureUsernameTaskExists(
  coadminUid: string,
  player: PlayerUser,
  game: GameLogin
) {
  const taskId = usernameTaskId(coadminUid, player.uid, game.gameName);
  const taskRef = doc(db, 'carerTasks', taskId);
  const taskSnap = await getDoc(taskRef);

  if (taskSnap.exists()) {
    return;
  }

  const task = buildUsernameTask(coadminUid, player, game);

  await setDoc(taskRef, {
    ...task,
    createdAt: serverTimestamp(),
  });
}

export async function completeCreateGameUsernameTask(values: {
  coadminUid: string;
  playerUid: string;
  gameName: string;
}) {
  return completeUsernameTaskForPlayerGame(
    values.coadminUid,
    values.playerUid,
    values.gameName
  );
}

export function listenToCarerTasks(
  coadminUid: string,
  onChange: (tasks: CarerTask[]) => void
) {
  const currentCarerUid = auth.currentUser?.uid;

  if (!currentCarerUid) {
    throw new Error('Not authenticated.');
  }

  return listenToAvailableCarerTasks(coadminUid, currentCarerUid, onChange);
}

export async function completeLegacyRechargeRedeemTask(taskId: string) {
  await updateDoc(doc(db, 'carerTasks', taskId), {
    status: 'completed',
    expiresAt: null,
    completedAt: serverTimestamp(),
    isPoked: false,
    pokedAt: null,
    pokeMessage: null,
  });
}

export function getClaimablePendingTaskCount(tasks: CarerTask[]) {
  return tasks.filter(isClaimablePendingTask).length;
}

export async function getCompletedUsernameCarersByPlayer(playerUid: string) {
  if (!playerUid) {
    return {} as Record<string, string[]>;
  }

  const tasksQuery = query(
    collection(db, 'carerTasks'),
    where('playerUid', '==', playerUid),
    where('status', '==', 'completed')
  );
  const snapshot = await getDocs(tasksQuery);

  const mapping: Record<string, string[]> = {};

  snapshot.docs.forEach((docSnap) => {
    const task = {
      id: docSnap.id,
      ...(docSnap.data() as Omit<CarerTask, 'id'>),
    } as CarerTask;

    if (
      task.type !== 'create_game_username' &&
      task.type !== 'recreate_username' &&
      task.type !== 'reset_password'
    ) {
      return;
    }

    const normalizedGame = normalizeGameName(task.gameName || '');

    if (!normalizedGame) {
      return;
    }

    const carerName =
      String(task.completedByCarerUsername || task.assignedCarerUsername || '').trim() ||
      'Carer';

    if (!mapping[normalizedGame]) {
      mapping[normalizedGame] = [];
    }

    if (!mapping[normalizedGame].includes(carerName)) {
      mapping[normalizedGame].push(carerName);
    }
  });

  return mapping;
}

export function listenCarerRechargeRedeemTotalsByCoadmin(
  coadminUid: string,
  onChange: (totalsByCarerUid: Record<string, CarerRechargeRedeemTotals>) => void,
  onError?: (error: Error) => void
) {
  const rechargeQuery = query(
    collection(db, 'carerTasks'),
    where('coadminUid', '==', coadminUid),
    where('status', '==', 'completed'),
    where('type', '==', 'recharge')
  );
  const redeemQuery = query(
    collection(db, 'carerTasks'),
    where('coadminUid', '==', coadminUid),
    where('status', '==', 'completed'),
    where('type', '==', 'redeem')
  );

  let rechargeTasks: CarerTask[] = [];
  let redeemTasks: CarerTask[] = [];

  const emit = () => {
    const totals: Record<string, CarerRechargeRedeemTotals> = {};

    for (const task of [...rechargeTasks, ...redeemTasks]) {
      const carerUid = String(task.completedByCarerUid || task.assignedCarerUid || '').trim();
      if (!carerUid) {
        continue;
      }
      if (!totals[carerUid]) {
        totals[carerUid] = {
          totalRechargeAmount: 0,
          totalRedeemAmount: 0,
        };
      }
      const amount = Number(task.amount || 0);
      if (task.type === 'recharge') {
        totals[carerUid].totalRechargeAmount += amount;
      } else {
        totals[carerUid].totalRedeemAmount += amount;
      }
    }

    onChange(totals);
  };

  const unsubRecharge = onSnapshot(
    rechargeQuery,
    (snapshot) => {
      rechargeTasks = snapshot.docs.map((docSnap) => ({
        id: docSnap.id,
        ...(docSnap.data() as Omit<CarerTask, 'id'>),
      }));
      emit();
    },
    (error) => onError?.(error as Error)
  );
  const unsubRedeem = onSnapshot(
    redeemQuery,
    (snapshot) => {
      redeemTasks = snapshot.docs.map((docSnap) => ({
        id: docSnap.id,
        ...(docSnap.data() as Omit<CarerTask, 'id'>),
      }));
      emit();
    },
    (error) => onError?.(error as Error)
  );

  return () => {
    unsubRecharge();
    unsubRedeem();
  };
}
