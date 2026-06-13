export function playerSeenOutcomeKeysStorageKey(playerUid: string) {
  return `playerSeenOutcomeKeys:${playerUid}`;
}

export function playerSeenRechargeSplashIdsStorageKey(playerUid: string) {
  return `playerSeenRechargeSplashIds:${playerUid}`;
}

export function playerSeenRedeemSplashIdsStorageKey(playerUid: string) {
  return `playerSeenRedeemSplashIds:${playerUid}`;
}

export function loadStoredStringSet(key: string): Set<string> {
  if (typeof window === 'undefined') {
    return new Set();
  }

  try {
    const raw = window.sessionStorage.getItem(key);
    const parsed = raw ? (JSON.parse(raw) as string[]) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter(Boolean) : []);
  } catch {
    return new Set();
  }
}

export function persistStoredStringSet(key: string, ids: Set<string>) {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    window.sessionStorage.setItem(key, JSON.stringify([...ids]));
  } catch {
    // Ignore storage write issues and continue UI flow.
  }
}

export function mergeRechargeSplashSeenSets(
  completedIds: Set<string>,
  dismissedIds: Set<string>
) {
  return new Set([...completedIds, ...dismissedIds]);
}

export function mergeRedeemSplashSeenSets(
  completedIds: Set<string>,
  dismissedIds: Set<string>
) {
  return new Set([...completedIds, ...dismissedIds]);
}

export function loadPlayerPopupSeenState(playerUid: string) {
  const rechargeSplashSeen = loadStoredStringSet(playerSeenRechargeSplashIdsStorageKey(playerUid));
  const redeemSplashSeen = loadStoredStringSet(playerSeenRedeemSplashIdsStorageKey(playerUid));

  return {
    outcomeKeys: loadStoredStringSet(playerSeenOutcomeKeysStorageKey(playerUid)),
    rechargeSplashIds: rechargeSplashSeen,
    redeemSplashIds: redeemSplashSeen,
  };
}
