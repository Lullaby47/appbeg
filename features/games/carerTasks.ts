import {
  addDoc,
  arrayUnion,
  Timestamp,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocFromServer,
  getDocs,
  limit,
  onSnapshot,
  orderBy,
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
import {
  automationJobTtl,
  completedCarerTaskTtl,
  completedPlayerGameRequestTtl,
} from '@/lib/firestore/ttl';

export type CarerTaskType =
  | 'create_game_username'
  | 'reset_password'
  | 'recreate_username'
  | PlayerGameRequestType;
export type CarerTaskStatus =
  | 'pending'
  | 'in_progress'
  | 'completed'
  | 'failed'
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
  assignedCarer?: string | null;
  assignedCarerUsername?: string | null;
  claimedStatus?: string | null;
  claimedAt?: Timestamp | null;
  claimedByUid?: string | null;
  claimedByUsername?: string | null;
  lastHeartbeatAt?: Timestamp | null;
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
  automationError?: string | null;
  currentUsername?: string | null;
  gameAccountUsername?: string | null;
  loginUrl?: string | null;
  gameLoginUrl?: string | null;
  lobbyUrl?: string | null;
  siteUrl?: string | null;
  baseUrl?: string | null;
  gameCredentialUsername?: string | null;
  gameCredentialPassword?: string | null;
};

function buildPendingTaskResetFields(): Record<string, unknown> {
  return {
    status: 'pending',
    assignedCarerUid: null,
    assignedCarer: null,
    assignedCarerUsername: null,
    claimedStatus: null,
    claimedAt: null,
    claimedByUid: null,
    claimedByUsername: null,
    startedAt: null,
    runningAt: null,
    expiresAt: null,
    completedAt: null,
    cancelledAt: null,
    failedAt: null,
    ttlExpiresAt: null,
    completedByCarerUid: null,
    completedByCarerUsername: null,
    automationStatus: null,
    automationJobId: null,
    linkedJobId: null,
    currentJobId: null,
    activeJobId: null,
    assignedJobStatus: null,
    automationError: null,
    error: null,
    failureReason: null,
    lastHeartbeatAt: null,
    queuedAt: null,
    automationUpdatedAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };
}

function logTaskResetPending(details: {
  taskId: string;
  oldStatus?: string | null;
  oldAutomationJobId?: string | null;
  oldLinkedJobId?: string | null;
}) {
  console.info('[TASK_RESET_PENDING] taskId=%s', details.taskId);
  console.info('[TASK_RESET_PENDING] oldStatus=%s', details.oldStatus || null);
  console.info('[TASK_RESET_PENDING] oldAutomationJobId=%s', details.oldAutomationJobId || null);
  console.info('[TASK_RESET_PENDING] oldLinkedJobId=%s', details.oldLinkedJobId || null);
  console.info('[TASK_RESET_PENDING] cleared stale automation fields');
  console.info('[TASK_RESET_PENDING] status=pending updatedAt=serverTimestamp');
}

async function forceRefreshTaskFromServer(taskId: string, taskRef = doc(db, 'carerTasks', taskId)) {
  const snapshot = await getDocFromServer(taskRef);
  console.info('[FIRESTORE] forced server refresh taskId=%s', taskId);
  return snapshot;
}

function pendingTaskHasStaleAutomationState(task: CarerTask | undefined) {
  if (!task || task.status !== 'pending') {
    return false;
  }
  return Boolean(
    task.automationJobId ||
      task.automationStatus ||
      task.automationError ||
      task.claimedAt ||
      task.claimedByUid ||
      task.claimedStatus ||
      task.startedAt ||
      task.completedAt ||
      task.lastHeartbeatAt
  );
}

const CARER_TASK_LIVE_LISTENER_LIMIT = 150;
const CARER_TASK_COMPLETED_LISTENER_LIMIT = 50;
const CARER_TOTALS_HISTORY_LIMIT_PER_TYPE = 500;
const CARER_TOTALS_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export type CarerRewardSummary = {
  completedTaskCount: number;
  totalAwardNpr: number;
};

export type CarerEscalationAlert = {
  id: string;
  coadminUid: string;
  contextType?: 'task_help' | 'cashbox_inquiry';
  /** Who raised this alert (helps coadmin filter staff/player inquiries). */
  escalationFrom?: 'carer' | 'staff' | 'player' | 'risk_auto' | string | null;
  taskId?: string | null;
  playerUid?: string | null;
  playerUsername?: string | null;
  gameName?: string | null;
  message: string;
  createdByCarerUid: string;
  createdByCarerUsername: string;
  dismissedByUids?: string[];
  createdAt?: Timestamp | null;
};

export type CarerRechargeRedeemTotals = {
  totalRechargeAmount: number;
  totalRedeemAmount: number;
};

const STUCK_TASK_TIMEOUT_MS = 10 * 60 * 1000;
const STUCK_AUTOMATION_JOB_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_AUTOMATION_RECOVERY_ATTEMPTS = 3;

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

function normalizeTaskUrl(value?: string | null) {
  const trimmed = String(value || '').trim();
  if (!trimmed) {
    return null;
  }
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

function normalizeTaskText(value?: string | null) {
  return String(value || '').trim() || null;
}

function resolveTaskGameAccess(game?: GameLogin | null) {
  const loginUrl = normalizeTaskUrl(game?.backendUrl || game?.siteUrl || '');
  const siteUrl = normalizeTaskUrl(game?.siteUrl || game?.frontendUrl || game?.backendUrl || '');

  return {
    loginUrl,
    gameLoginUrl: loginUrl,
    lobbyUrl: loginUrl,
    siteUrl,
    baseUrl: loginUrl || siteUrl,
    gameCredentialUsername: normalizeTaskText(game?.username || ''),
    gameCredentialPassword: normalizeTaskText(game?.password || ''),
  };
}

function getTimestampMs(value: unknown) {
  if (!value) {
    return 0;
  }
  if (value instanceof Timestamp) {
    return value.toMillis();
  }
  if (
    typeof value === 'object' &&
    value !== null &&
    'toMillis' in value &&
    typeof (value as { toMillis?: unknown }).toMillis === 'function'
  ) {
    try {
      return Number((value as { toMillis: () => number }).toMillis()) || 0;
    } catch {
      return 0;
    }
  }
  return 0;
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
  if (
    requestStatus === 'failed' ||
    requestStatus === 'pending_review' ||
    requestStatus === 'dismissed'
  ) {
    return 'failed';
  }
  // Includes pending plus legacy poked from the removed poke flow.
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
    ttlExpiresAt: completedCarerTaskTtl(),
    automationStatus: 'completed' as const,
    automationUpdatedAt: serverTimestamp(),
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

async function getAuthHeaders() {
  const currentUser = auth.currentUser;
  if (!currentUser) {
    throw new Error('Not authenticated.');
  }
  const token = await currentUser.getIdToken();
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  };
}

function readApiError(messageFallback: string, payload: unknown) {
  if (
    payload &&
    typeof payload === 'object' &&
    'error' in payload &&
    typeof (payload as { error?: unknown }).error === 'string'
  ) {
    return String((payload as { error: string }).error || messageFallback);
  }
  return messageFallback;
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

  const userData = userSnap.data() as {
    username?: string;
    role?: string;
    coadminUid?: string | null;
  };

  return {
    uid: currentUser.uid,
    username: userData.username?.trim() || 'User',
    role: String(userData.role || '').trim().toLowerCase(),
    coadminUid: userData.coadminUid ?? null,
  };
}

function buildUsernameTask(
  coadminUid: string,
  player: PlayerUser,
  game: GameLogin
): CarerTask {
  const access = resolveTaskGameAccess(game);
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
    ...access,
  });
}

function buildRequestTask(
  coadminUid: string,
  request: PlayerGameRequest,
  playerUsername: string,
  currentUsername?: string | null,
  game?: GameLogin | null
): CarerTask {
  const nextStatus = getTaskStatusFromRequestStatus(request.status);
  const normalizedCurrentUsername = String(currentUsername || '').trim() || null;
  const access = resolveTaskGameAccess(game);

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
    currentUsername: normalizedCurrentUsername,
    gameAccountUsername: normalizedCurrentUsername,
    ...access,
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
  existingTask: CarerTask | undefined,
  currentUsername?: string | null,
  game?: GameLogin | null
): Record<string, unknown> {
  const task = buildRequestTask(coadminUid, request, playerUsername, currentUsername, game);
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
      existingEffectiveStatus === 'completed' ||
      existingEffectiveStatus === 'failed');
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
            : null,
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
            : null,
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
    automationStatus:
      nextStatus === 'completed'
        ? 'completed'
        : nextStatus === 'pending'
          ? null
          : existingTask?.automationStatus ?? null,
    automationUpdatedAt:
      nextStatus === 'completed'
        ? serverTimestamp()
        : nextStatus === 'pending'
          ? serverTimestamp()
          : existingTask?.automationUpdatedAt ?? null,
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
    ...(nextStatus === 'pending' ? buildPendingTaskResetFields() : {}),
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
  const loginQuery = query(
    collection(db, 'playerGameLogins'),
    where('playerUid', '==', request.playerUid)
  );
  const loginSnap = await getDocs(loginQuery);
  const normalizedRequestGame = normalizeGameName(request.gameName || '');
  const coadminGames = await getGameLoginsByCoadmin(coadminUid);
  const matchedGame =
    coadminGames.find(
      (game) => normalizeGameName(String(game.gameName || '')) === normalizedRequestGame
    ) || null;
  const matchedLogin = loginSnap.docs
    .map((docSnap) => docSnap.data() as { gameName?: string; gameUsername?: string })
    .find(
      (entry) =>
        normalizeGameName(String(entry.gameName || '')) === normalizedRequestGame &&
        String(entry.gameUsername || '').trim().length > 0
    );
  const requestGameUsername = String(matchedLogin?.gameUsername || '').trim() || null;

  const payload = computeRequestLinkedCarerTaskWrite(
    coadminUid,
    request,
    playerUsername,
    existingTask,
    requestGameUsername,
    matchedGame
  );
  await setDoc(taskRef, payload, { merge: true });

  const { recordDevUsageEstimate } = await import('@/features/dev/devUsageEstimates');
  recordDevUsageEstimate({
    tasksCreated: existingSnap.exists() ? 0 : 1,
    estReads: 2,
    estWrites: 1,
  });
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

  if (effectiveStatus === 'failed') {
    return null;
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

export function isRealCompletedCarerTask(task: CarerTask): boolean {
  if (getEffectiveCarerTaskStatus(task) !== 'completed') {
    return false;
  }
  const automationStatus = String(task.automationStatus || '').trim().toLowerCase();
  if (
    automationStatus === 'failed' ||
    automationStatus === 'fake_redeem' ||
    automationStatus === 'dismissed' ||
    automationStatus === 'returned_to_pending' ||
    automationStatus === 'cancelled'
  ) {
    return false;
  }
  const lowerPoke = String(task.pokeMessage || '').toLowerCase();
  if (
    lowerPoke.includes('fake redeem') ||
    lowerPoke.includes('dismissed') ||
    lowerPoke.includes('cancelled') ||
    lowerPoke.includes('returned to pending')
  ) {
    return false;
  }
  return true;
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
  const loginUsernameByPlayerGame = new Map(
    logins.map((login) => [
      `${login.playerUid}::${normalizeGameName(login.gameName || '')}`,
      String(login.gameUsername || '').trim() || null,
    ])
  );
  const allRequests = [...pendingRequests, ...completedRequests];
  const requestIds = new Set(allRequests.map((request) => request.id));
  const gameByNormalizedName = new Map(
    games.map((game) => [normalizeGameName(game.gameName || ''), game] as const)
  );

  const batch = writeBatch(db);
  let changed = false;
  const resetTaskIdsToRefresh = new Set<string>();

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
        const access = resolveTaskGameAccess(game);
        batch.update(taskRef, {
          playerUsername: player.username || 'Player',
          gameName: game.gameName || 'Unknown Game',
          status: 'completed',
          automationStatus: 'completed',
          automationUpdatedAt: serverTimestamp(),
          assignedCarerUid: existingTask.assignedCarerUid ?? null,
          assignedCarerUsername: existingTask.assignedCarerUsername ?? null,
          startedAt: existingTask.startedAt ?? null,
          expiresAt: null,
          completedAt: serverTimestamp(),
          ttlExpiresAt: completedCarerTaskTtl(),
          isPoked: false,
          pokedAt: null,
          pokeMessage: null,
          completedByCarerUid:
            existingTask.completedByCarerUid || existingTask.assignedCarerUid || null,
          completedByCarerUsername:
            existingTask.completedByCarerUsername ||
            existingTask.assignedCarerUsername ||
            null,
          ...access,
        });
        changed = true;
        continue;
      }

      if (!hasLogin && existingTask.status === 'completed' && !existingTask.requestId) {
        const access = resolveTaskGameAccess(game);
        batch.update(taskRef, {
          playerUsername: player.username || 'Player',
          gameName: game.gameName || 'Unknown Game',
          ...buildPendingTaskResetFields(),
          isPoked: false,
          pokedAt: null,
          pokeMessage: null,
          ...access,
        });
        logTaskResetPending({
          taskId,
          oldStatus: existingTask.status,
          oldAutomationJobId: existingTask.automationJobId || null,
          oldLinkedJobId: null,
        });
        resetTaskIdsToRefresh.add(taskId);
        changed = true;
        continue;
      }

      if (
        existingTask.playerUsername !== (player.username || 'Player') ||
        existingTask.gameName !== (game.gameName || 'Unknown Game') ||
        existingTask.loginUrl !== (resolveTaskGameAccess(game).loginUrl ?? null) ||
        existingTask.gameCredentialUsername !==
          (resolveTaskGameAccess(game).gameCredentialUsername ?? null) ||
        existingTask.siteUrl !== (resolveTaskGameAccess(game).siteUrl ?? null)
      ) {
        const access = resolveTaskGameAccess(game);
        batch.update(taskRef, {
          playerUsername: player.username || 'Player',
          gameName: game.gameName || 'Unknown Game',
          ...access,
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
    const loginUsername =
      loginUsernameByPlayerGame.get(
        `${request.playerUid}::${normalizeGameName(request.gameName || '')}`
      ) || null;
    const payload = computeRequestLinkedCarerTaskWrite(
      coadminUid,
      request,
      playerUsername,
      existingTask,
      loginUsername,
      gameByNormalizedName.get(normalizeGameName(request.gameName || '')) || null
    );

    batch.set(taskRef, payload, { merge: true });
    if (pendingTaskHasStaleAutomationState(existingTask) && String(payload.status || '') === 'pending') {
      resetTaskIdsToRefresh.add(taskId);
    }
    changed = true;
  }

  for (const existingTask of existingTasks.values()) {
    if (!activePlayerUidSet.has(existingTask.playerUid)) {
      if (existingTask.status === 'completed') {
        continue;
      }

      batch.update(doc(db, 'carerTasks', existingTask.id), {
        status: 'completed',
        automationStatus: 'completed',
        automationUpdatedAt: serverTimestamp(),
        assignedCarerUid: existingTask.assignedCarerUid ?? null,
        assignedCarerUsername: existingTask.assignedCarerUsername ?? null,
        startedAt: null,
        expiresAt: null,
        completedAt: existingTask.completedAt ?? serverTimestamp(),
        ttlExpiresAt: completedCarerTaskTtl(),
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
      automationStatus: 'completed',
      automationUpdatedAt: serverTimestamp(),
      assignedCarerUid: existingTask.assignedCarerUid ?? null,
      assignedCarerUsername: existingTask.assignedCarerUsername ?? null,
      startedAt: null,
      expiresAt: null,
      completedAt: serverTimestamp(),
      ttlExpiresAt: completedCarerTaskTtl(),
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
    await Promise.all(
      Array.from(resetTaskIdsToRefresh).map((taskId) =>
        forceRefreshTaskFromServer(taskId, doc(db, 'carerTasks', taskId))
      )
    );
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

  if (invalidRechargeIds.length > 0) {
    // Keep tasks visible for manual handling. Carer can dismiss explicitly from UI.
    console.info('[carerTasks] keeping pending recharge tasks with low coin', {
      invalidRechargeIds,
    });
  }
  return pendingRequests;
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
  const activeTasksQuery = query(
    collection(db, 'carerTasks'),
    where('coadminUid', '==', coadminUid),
    where('status', 'in', ['pending', 'in_progress', 'urgent']),
    orderBy('createdAt', 'desc'),
    limit(CARER_TASK_LIVE_LISTENER_LIMIT)
  );
  const completedTasksQuery = query(
    collection(db, 'carerTasks'),
    where('coadminUid', '==', coadminUid),
    where('status', '==', 'completed'),
    orderBy('completedAt', 'desc'),
    limit(CARER_TASK_COMPLETED_LISTENER_LIMIT)
  );
  let activeTasks: CarerTask[] = [];
  let completedTasks: CarerTask[] = [];

  const emit = () => {
    const byId = new Map<string, CarerTask>();
    for (const task of [...activeTasks, ...completedTasks]) {
      byId.set(task.id, task);
    }
    callback(Array.from(byId.values()));
  };

  const mapVisibleTasks = (docs: Array<{ id: string; data: () => unknown }>) =>
    docs
      .map((docSnap) => {
        const task = {
          id: docSnap.id,
          ...(docSnap.data() as Omit<CarerTask, 'id'>),
        } satisfies CarerTask;

        return getVisibleTaskForCarer(task, currentCarerUid);
      })
      .filter((task): task is CarerTask => Boolean(task));

  const unsubscribeActive = onSnapshot(
    activeTasksQuery,
    { includeMetadataChanges: true },
    (snapshot) => {
      console.info('[FIRESTORE] snapshot fromCache=%s hasPendingWrites=%s', snapshot.metadata.fromCache, snapshot.metadata.hasPendingWrites);
      activeTasks = mapVisibleTasks(snapshot.docs);
      emit();
    },
    (error) => {
      onError?.(error as Error);
    }
  );
  const unsubscribeCompleted = onSnapshot(
    completedTasksQuery,
    { includeMetadataChanges: true },
    (snapshot) => {
      console.info('[FIRESTORE] snapshot fromCache=%s hasPendingWrites=%s', snapshot.metadata.fromCache, snapshot.metadata.hasPendingWrites);
      completedTasks = mapVisibleTasks(snapshot.docs);
      emit();
    },
    (error) => {
      onError?.(error as Error);
    }
  );

  return () => {
    unsubscribeActive();
    unsubscribeCompleted();
  };
}

export async function releaseExpiredCarerTasks(coadminUid: string) {
  const scopedCoadminUid = String(coadminUid || '').trim();
  if (!scopedCoadminUid) {
    return;
  }

  const [stuckTaskSnap, activeJobSnap] = await Promise.all([
    getDocs(
      query(
        collection(db, 'carerTasks'),
        where('coadminUid', '==', scopedCoadminUid),
        where('status', '==', 'in_progress')
      )
    ),
    getDocs(
      query(
        collection(db, 'automation_jobs'),
        where('coadminUid', '==', scopedCoadminUid),
        where('status', 'in', ['queued', 'running'])
      )
    ),
  ]);

  const nowMs = Date.now();
  const activeJobByTaskId = new Map<
    string,
    {
      id: string;
      status: string;
      attempts: number;
      startedAtMs: number;
      updatedAtMs: number;
      createdAtMs: number;
    }
  >();

  activeJobSnap.docs.forEach((docSnap) => {
    const data = docSnap.data() as {
      taskId?: string;
      status?: string;
      attempts?: number;
      startedAt?: Timestamp | null;
      updatedAt?: Timestamp | null;
      createdAt?: Timestamp | null;
    };
    const taskId = String(data.taskId || '').trim();
    if (!taskId) {
      return;
    }
    activeJobByTaskId.set(taskId, {
      id: docSnap.id,
      status: String(data.status || '').trim(),
      attempts: Math.max(0, Number(data.attempts || 0)),
      startedAtMs: getTimestampMs(data.startedAt),
      updatedAtMs: getTimestampMs(data.updatedAt),
      createdAtMs: getTimestampMs(data.createdAt),
    });
  });

  for (const [taskId, job] of activeJobByTaskId.entries()) {
    if (job.status !== 'running') {
      continue;
    }

    const activityMs = Math.max(job.startedAtMs, job.updatedAtMs, job.createdAtMs);
    if (!activityMs || nowMs - activityMs < STUCK_AUTOMATION_JOB_TIMEOUT_MS) {
      continue;
    }

    const retryable = job.attempts < MAX_AUTOMATION_RECOVERY_ATTEMPTS;
    const jobRef = doc(db, 'automation_jobs', job.id);
    const taskRef = doc(db, 'carerTasks', taskId);

    await runTransaction(db, async (transaction) => {
      const [jobSnap, taskSnap] = await Promise.all([
        transaction.get(jobRef),
        transaction.get(taskRef),
      ]);

      if (!jobSnap.exists()) {
        return;
      }

      const currentJob = jobSnap.data() as {
        status?: string;
        taskId?: string;
        attempts?: number;
        error?: string | null;
      };
      if (String(currentJob.status || '').trim() !== 'running') {
        return;
      }

      const taskData = taskSnap.exists()
        ? (taskSnap.data() as Omit<CarerTask, 'id'>)
        : null;
      const requestId = String(taskData?.requestId || '').trim();
      const requestRef = requestId ? doc(db, 'playerGameRequests', requestId) : null;
      const requestSnap = requestRef ? await transaction.get(requestRef) : null;
      const timeoutMessage = retryable
        ? 'Automation timed out and was returned to the queue.'
        : 'Automation timed out repeatedly and now needs manual review.';

      if (retryable) {
        transaction.update(jobRef, {
          status: 'failed',
          startedAt: null,
          completedAt: serverTimestamp(),
          ttlExpiresAt: automationJobTtl(),
          updatedAt: serverTimestamp(),
          error: timeoutMessage,
          result: null,
          cancelledReason: 'returned_to_pending_timeout',
        });

        if (taskSnap.exists()) {
          transaction.update(taskRef, {
            ...buildPendingTaskResetFields(),
          });
          logTaskResetPending({
            taskId,
            oldStatus: taskData?.status || null,
            oldAutomationJobId: taskData?.automationJobId || job.id,
            oldLinkedJobId: null,
          });
        }

        if (requestRef && requestSnap?.exists()) {
          const requestData = requestSnap.data() as Omit<PlayerGameRequest, 'id'>;
          if (requestData.status !== 'completed') {
            transaction.update(requestRef, {
              status: 'pending',
              completedAt: null,
              ttlExpiresAt: null,
              pokedAt: null,
              pokeMessage: null,
            });
          }
        }

        return;
      }

      transaction.update(jobRef, {
        status: 'failed',
        completedAt: serverTimestamp(),
        ttlExpiresAt: automationJobTtl(),
        updatedAt: serverTimestamp(),
        error: timeoutMessage,
      });

      if (taskSnap.exists()) {
        transaction.update(taskRef, {
          status: 'failed',
          expiresAt: null,
          ttlExpiresAt: completedCarerTaskTtl(),
          automationStatus: 'failed',
          automationJobId: job.id,
          automationUpdatedAt: serverTimestamp(),
        });
      }

      if (requestRef && requestSnap?.exists()) {
        const requestData = requestSnap.data() as Omit<PlayerGameRequest, 'id'>;
        if (requestData.status !== 'completed') {
          transaction.update(requestRef, {
            status: 'pending_review',
            completedAt: null,
            pokedAt: serverTimestamp(),
            pokeMessage: timeoutMessage,
          });
        }
      }
    });
    await forceRefreshTaskFromServer(taskId, taskRef);
  }

  for (const docSnap of stuckTaskSnap.docs) {
    const task = {
      id: docSnap.id,
      ...(docSnap.data() as Omit<CarerTask, 'id'>),
    } satisfies CarerTask;
    const activeJob = activeJobByTaskId.get(task.id);
    if (activeJob) {
      continue;
    }

    const activityMs = Math.max(
      getTimestampMs(task.startedAt),
      getTimestampMs(task.expiresAt),
      getTimestampMs(task.createdAt)
    );
    if (!activityMs || nowMs - activityMs < STUCK_TASK_TIMEOUT_MS) {
      continue;
    }

    const taskRef = doc(db, 'carerTasks', task.id);
    const requestRef = task.requestId ? doc(db, 'playerGameRequests', task.requestId) : null;

    await runTransaction(db, async (transaction) => {
      const [currentTaskSnap, requestSnap] = await Promise.all([
        transaction.get(taskRef),
        requestRef ? transaction.get(requestRef) : Promise.resolve(null),
      ]);
      if (!currentTaskSnap.exists()) {
        return;
      }

      const currentTask = currentTaskSnap.data() as Omit<CarerTask, 'id'>;
      if (currentTask.status !== 'in_progress') {
        return;
      }

      console.info('[carerTasks] transaction-recovery-fixed', {
        taskId: task.id,
        hasRequestRef: Boolean(requestRef),
        requestReadBeforeWrite: true,
      });

      transaction.update(taskRef, {
        ...buildPendingTaskResetFields(),
      });
      logTaskResetPending({
        taskId: task.id,
        oldStatus: currentTask.status,
        oldAutomationJobId: currentTask.automationJobId || null,
        oldLinkedJobId: null,
      });

      if (requestRef && requestSnap?.exists()) {
        const requestData = requestSnap.data() as Omit<PlayerGameRequest, 'id'>;
        if (requestData.status !== 'completed') {
          transaction.update(requestRef, {
            status: 'pending',
            completedAt: null,
            ttlExpiresAt: null,
            pokedAt: null,
            pokeMessage: null,
          });
        }
      }
    });
    await forceRefreshTaskFromServer(task.id, taskRef);
  }
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
  const headers = await getAuthHeaders();
  const response = await fetch('/api/carer/tasks/complete-username', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      coadminUid,
      playerUid,
      gameName,
    }),
  });
  const payload = (await response.json().catch(() => ({}))) as {
    error?: string;
    completedTaskCount?: number;
    totalAwardNpr?: number;
  };
  if (!response.ok) {
    throw new Error(readApiError('Failed to complete username task.', payload));
  }
  return {
    completedTaskCount: Number(payload.completedTaskCount || 0),
    totalAwardNpr: Number(payload.totalAwardNpr || 0),
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
      ...buildPendingTaskResetFields(),
      isPoked: false,
      pokedAt: null,
      pokeMessage: null,
      createdAt: serverTimestamp(),
    },
    { merge: true }
  );
  await forceRefreshTaskFromServer(taskId, taskRef);
}

export async function sendCarerEscalationAlert(task: CarerTask) {
  const { uid: carerUid, username: carerUsername } =
    await getCurrentCarerIdentity();

  await addDoc(collection(db, 'carerEscalationAlerts'), {
    coadminUid: task.coadminUid,
    contextType: 'task_help',
    escalationFrom: 'carer',
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
  /** When the sender is the player, pass their UID so coadmins can audit inquiries. */
  playerUid?: string | null;
  playerUsername?: string | null;
}) {
  const sender = await getCurrentUserIdentityForEscalation();
  const cleanMessage = values.message.trim();

  if (!cleanMessage) {
    throw new Error('Inquiry message is required.');
  }

  const explicitPlayerUid = String(values.playerUid || '').trim();
  const explicitPlayerUsername = String(values.playerUsername || '').trim();

  const playerUid =
    explicitPlayerUid ||
    (sender.role === 'player' ? sender.uid : '') ||
    null;
  const playerUsername =
    explicitPlayerUsername ||
    (sender.role === 'player' ? sender.username || 'Player' : null);

  let escalationFrom: CarerEscalationAlert['escalationFrom'] = sender.role === 'staff'
      ? 'staff'
      : sender.role === 'player'
        ? 'player'
        : 'carer';

  await addDoc(collection(db, 'carerEscalationAlerts'), {
    coadminUid: values.coadminUid,
    contextType: 'cashbox_inquiry',
    escalationFrom,
    taskId: null,
    playerUid,
    playerUsername,
    gameName: null,
    message: cleanMessage,
    createdByCarerUid: sender.uid,
    createdByCarerUsername: sender.username,
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
      const currentUid = auth.currentUser?.uid || '';
      const alerts = snapshot.docs
        .map((docSnap) =>
          mapCarerEscalationAlert(
            docSnap.id,
            docSnap.data() as Omit<CarerEscalationAlert, 'id'>
          )
        )
        .filter(
          (alert) =>
            !currentUid || !Array.isArray(alert.dismissedByUids)
              ? true
              : !alert.dismissedByUids.includes(currentUid)
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
      const currentUid = auth.currentUser?.uid || '';
      const alerts = snapshot.docs
        .map((docSnap) =>
          mapCarerEscalationAlert(
            docSnap.id,
            docSnap.data() as Omit<CarerEscalationAlert, 'id'>
          )
        )
        .filter(
          (alert) =>
            !currentUid || !Array.isArray(alert.dismissedByUids)
              ? true
              : !alert.dismissedByUids.includes(currentUid)
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

export async function dismissCarerEscalationAlertForCurrentUser(alertId: string) {
  const currentUser = auth.currentUser;
  if (!currentUser) {
    throw new Error('Not authenticated.');
  }
  await updateDoc(doc(db, 'carerEscalationAlerts', alertId), {
    dismissedByUids: arrayUnion(currentUser.uid),
  });
}

export async function completeRechargeRedeemTask(task: CarerTask) {
  if (!task.requestId) {
    throw new Error('This task is not linked to a request.');
  }
  const response = await fetch('/api/carer/tasks/complete-recharge-redeem', {
    method: 'POST',
    headers: await getAuthHeaders(),
    body: JSON.stringify({ taskId: task.id }),
  });
  const payload = (await response.json().catch(() => ({}))) as {
    error?: string;
    completedTaskCount?: number;
    totalAwardNpr?: number;
  };
  if (!response.ok) {
    throw new Error(readApiError('Failed to complete task.', payload));
  }

  return {
    completedTaskCount: Number(payload.completedTaskCount || 0),
    totalAwardNpr: Number(payload.totalAwardNpr || 0),
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
    ttlExpiresAt: completedCarerTaskTtl(),
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
  const windowStart = Timestamp.fromMillis(Date.now() - CARER_TOTALS_WINDOW_MS);
  const rechargeQuery = query(
    collection(db, 'carerTasks'),
    where('coadminUid', '==', coadminUid),
    where('status', '==', 'completed'),
    where('type', '==', 'recharge'),
    where('completedAt', '>=', windowStart),
    orderBy('completedAt', 'desc'),
    limit(CARER_TOTALS_HISTORY_LIMIT_PER_TYPE)
  );
  const redeemQuery = query(
    collection(db, 'carerTasks'),
    where('coadminUid', '==', coadminUid),
    where('status', '==', 'completed'),
    where('type', '==', 'redeem'),
    where('completedAt', '>=', windowStart),
    orderBy('completedAt', 'desc'),
    limit(CARER_TOTALS_HISTORY_LIMIT_PER_TYPE)
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
