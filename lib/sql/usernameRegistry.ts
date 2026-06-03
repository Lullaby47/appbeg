import { assertValidGameUsername, isValidGameUsername } from '@/lib/games/gameUsernameRule';

export type RecordGameUsernameInput = {
  username: string;
  game: string;
  playerUid?: string | null;
  coadminUid?: string | null;
  source?: string | null;
};

const REGISTRY_TIMEOUT_MS = 5_000;
let registryUrlLogged = false;

function cleanText(value: string | null | undefined, maxLength?: number) {
  const clean = String(value || '').trim();
  return maxLength ? clean.slice(0, maxLength) : clean;
}

function getRegistryApiConfig() {
  const url = cleanText(process.env.USERNAME_REGISTRY_API_URL);
  const secret = process.env.USERNAME_REGISTRY_SECRET || '';
  if (!url) {
    throw new Error('USERNAME_REGISTRY_API_URL is required for username registry.');
  }
  if (!secret) {
    throw new Error('USERNAME_REGISTRY_SECRET is required for username registry.');
  }
  if (!registryUrlLogged) {
    registryUrlLogged = true;
    console.info('[USERNAME_REGISTRY] Registry URL loaded', { url });
  }
  return { url, secret };
}

export async function usernameExists(username: string) {
  const cleanUsername = cleanText(username, 100);
  if (!isValidGameUsername(cleanUsername)) {
    console.info(`[USERNAME_REGISTRY] invalid username pattern username=${cleanUsername}`);
    return false;
  }

  // AppBeg no longer reads PostgreSQL directly. The VPS registry API only records usernames;
  // recharge validation is performed by coadmin-agent against PostgreSQL.
  console.info('[USERNAME_REGISTRY] skipping AppBeg direct DB existence check', {
    username: cleanUsername,
  });
  return false;
}

export async function recordGameUsername(input: RecordGameUsernameInput) {
  const cleanUsername = cleanText(input.username, 100);
  const cleanGame = cleanText(input.game, 50);
  if (!cleanUsername) throw new Error('Username is required for username registry.');
  if (!cleanGame) throw new Error('Game is required for username registry.');
  assertValidGameUsername(cleanUsername);

  const { url, secret } = getRegistryApiConfig();
  const payload = {
    username: cleanUsername,
    game: cleanGame,
    playerUid: cleanText(input.playerUid || null) || undefined,
    coadminUid: cleanText(input.coadminUid || null) || undefined,
    source: 'appbeg',
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REGISTRY_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-appbeg-registry-secret': secret,
      },
      body: JSON.stringify(payload),
      cache: 'no-store',
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(
        `Username registry API failed status=${response.status} body=${text.slice(0, 500)}`
      );
    }

    console.info('[USERNAME_REGISTRY] Registry call success', {
      url,
      username: cleanUsername,
      game: cleanGame,
      playerUid: payload.playerUid || null,
      coadminUid: payload.coadminUid || null,
      source: payload.source,
    });
  } catch (error) {
    console.warn('[USERNAME_REGISTRY] Registry call failed', {
      url,
      username: cleanUsername,
      game: cleanGame,
      error,
    });
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function insertUsername(username: string, game = 'unknown') {
  await recordGameUsername({ username, game, source: 'legacy_insert_after_firebase' });
}

export async function deleteUsername(username: string) {
  const cleanUsername = cleanText(username, 100);
  if (!isValidGameUsername(cleanUsername)) {
    console.info(`[USERNAME_REGISTRY] skip delete for invalid username=${cleanUsername}`);
    return;
  }

  // The VPS API intentionally exposes only a record/upsert endpoint for now.
  console.info('[USERNAME_REGISTRY] delete requested; VPS registry API has no delete endpoint', {
    username: cleanUsername,
  });
}

export function isUniqueViolation() {
  return false;
}
