import 'server-only';

import type { PoolClient } from 'pg';

import { assertValidGameUsername } from '@/lib/games/gameUsernameRule';
import { cleanText, getPlayerMirrorPool } from '@/lib/sql/playerMirrorCommon';
import { usernameExists } from '@/lib/sql/usernameRegistry';

export type PlayerUsernameDuplicateTable = 'players_cache' | 'game_usernames' | 'username_registry';

export class PlayerUsernameValidationError extends Error {
  constructor(
    message: string,
    public readonly kind: 'rule' | 'duplicate' | 'unavailable',
    public readonly duplicateTable?: PlayerUsernameDuplicateTable
  ) {
    super(message);
  }
}

type ValidationOptions = { client?: PoolClient };

/**
 * Canonical player-login username validation used before player creation.
 * `players_cache` remains globally unique; game username rows use the existing
 * coadmin-scoped active uniqueness model. The external registry is consulted
 * too, although its current implementation is intentionally non-authoritative.
 */
export async function validatePlayerUsernameForCreation(
  value: unknown,
  coadminUid: unknown,
  options: ValidationOptions = {}
) {
  const username = cleanText(value);
  const ownerCoadminUid = cleanText(coadminUid);
  if (!username) {
    throw new PlayerUsernameValidationError('Username is required.', 'rule');
  }
  try {
    assertValidGameUsername(username);
  } catch (error) {
    throw new PlayerUsernameValidationError(
      error instanceof Error ? error.message : 'Invalid username format.',
      'rule'
    );
  }
  if (!ownerCoadminUid) {
    throw new PlayerUsernameValidationError('Coadmin ownership is required.', 'unavailable');
  }

  const db = options.client || getPlayerMirrorPool();
  if (!db) {
    throw new PlayerUsernameValidationError('Username validation is temporarily unavailable.', 'unavailable');
  }

  const result = await db.query<{ duplicate_table: PlayerUsernameDuplicateTable }>(
    `
      SELECT 'players_cache'::text AS duplicate_table
      FROM public.players_cache
      WHERE deleted_at IS NULL AND lower(username)=lower($1)
      LIMIT 1
    `,
    [username]
  );
  if (result.rows.length) {
    throw new PlayerUsernameValidationError('Username already exists.', 'duplicate', 'players_cache');
  }

  const gameUsername = await db.query<{ duplicate_table: PlayerUsernameDuplicateTable }>(
    `
      SELECT 'game_usernames'::text AS duplicate_table
      FROM public.game_usernames
      WHERE status='active' AND coadmin_uid=$2 AND lower(username)=lower($1)
      LIMIT 1
    `,
    [username, ownerCoadminUid]
  );
  if (gameUsername.rows.length) {
    throw new PlayerUsernameValidationError('Username already exists.', 'duplicate', 'game_usernames');
  }

  try {
    if (await usernameExists(username)) {
      throw new PlayerUsernameValidationError('Username already exists.', 'duplicate', 'username_registry');
    }
  } catch (error) {
    if (error instanceof PlayerUsernameValidationError) throw error;
    // Existing admin creation does not fail when the post-create registry is unavailable.
    console.warn('[PLAYER_USERNAME_VALIDATION] registry check unavailable', { username, error });
  }

  return { username, ownerCoadminUid };
}
