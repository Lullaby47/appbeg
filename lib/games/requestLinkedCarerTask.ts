import { FieldValue } from 'firebase-admin/firestore';

export type RequestLinkedCarerTaskType = 'recharge' | 'redeem';

export type RequestLinkedGameCredential = {
  id?: unknown;
  gameName?: unknown;
  username?: unknown;
  password?: unknown;
  backendUrl?: unknown;
  frontendUrl?: unknown;
  siteUrl?: unknown;
};

export type RequestLinkedCarerTaskInput = {
  requestId: string;
  coadminUid: string;
  type: RequestLinkedCarerTaskType;
  playerUid: string;
  playerUsername?: string | null;
  gameName: string;
  amount: number;
  currentUsername?: string | null;
  createdAt?: unknown;
  completedAt?: unknown;
  gameCredential?: RequestLinkedGameCredential | null;
};

export function requestLinkedCarerTaskId(requestId: string) {
  return `request__${requestId}`;
}

function normalizeGameName(gameName: string) {
  return gameName.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_');
}

function normalizeTaskUrl(value?: unknown) {
  const trimmed = String(value || '').trim();
  if (!trimmed) {
    return null;
  }
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

function normalizeTaskText(value?: unknown) {
  return String(value || '').trim() || null;
}

export function findRequestLinkedGameCredential<T extends RequestLinkedGameCredential>(
  rows: T[],
  gameName: string
): T | null {
  const normalizedRequestGame = normalizeGameName(gameName);
  return (
    rows.find(
      (row) => normalizeGameName(String(row.gameName || '')) === normalizedRequestGame
    ) || null
  );
}

function resolveTaskGameAccess(game?: RequestLinkedGameCredential | null) {
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

function buildNewPendingLinkedTaskFields() {
  const now = FieldValue.serverTimestamp();
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
    retryPending: false,
    resetToPendingAt: null,
    returnedToPendingAt: null,
    pendingSince: now,
    lastHeartbeatAt: null,
    queuedAt: null,
    automationUpdatedAt: now,
    updatedAt: now,
  };
}

export function buildPendingRequestLinkedCarerTaskPayload(
  input: RequestLinkedCarerTaskInput
) {
  const currentUsername = String(input.currentUsername || '').trim() || null;

  return {
    coadminUid: input.coadminUid,
    type: input.type,
    playerUid: input.playerUid,
    playerUsername: String(input.playerUsername || '').trim() || 'Player',
    gameName: input.gameName || 'Unknown Game',
    amount: input.amount ?? null,
    requestId: input.requestId,
    createdAt: input.createdAt || FieldValue.serverTimestamp(),
    isPoked: false,
    pokedAt: null,
    pokeMessage: null,
    currentUsername,
    gameAccountUsername: currentUsername,
    ...resolveTaskGameAccess(input.gameCredential),
    ...buildNewPendingLinkedTaskFields(),
  };
}
