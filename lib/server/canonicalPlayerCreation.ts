import 'server-only';

import { createPlayerInSql, type CreatePlayerInSqlInput } from '@/lib/sql/authorityAdminPlayer';
import { coadminTaskLiveChannel, insertLiveOutboxEvent } from '@/lib/sql/liveOutbox';
import { recordGameUsername } from '@/lib/sql/usernameRegistry';

export type CanonicalPlayerCreationInput = CreatePlayerInSqlInput & {
  source?: string;
};

/**
 * Shared post-verification/player-admin setup. The SQL helper is the authority
 * for profiles, credentials, balances, referrals, login usernames and pending
 * carer tasks; this wrapper keeps the external registry and self-signup event
 * side effects consistent with that same creation result.
 */
export async function completeCanonicalPlayerCreation(input: CanonicalPlayerCreationInput) {
  const source = input.source || 'authority_create_player';
  const result = await createPlayerInSql({ ...input, source });

  try {
    await recordGameUsername({
      username: input.username,
      game: 'player_login',
      playerUid: input.uid,
      coadminUid: input.ownerCoadminUid,
      source,
    });
  } catch (error) {
    // This matches the established admin flow: the authoritative player is not
    // rolled back solely because the external registry is temporarily down.
    console.warn('[PLAYER_LOGIN_USERNAME_REGISTRY] record failed after player creation', {
      username: input.username,
      playerUid: input.uid,
      coadminUid: input.ownerCoadminUid,
      source,
      error,
    });
  }

  if (source === 'player_self_signup') {
    await insertLiveOutboxEvent({
      channel: coadminTaskLiveChannel(input.ownerCoadminUid),
      eventType: 'player.created',
      entityType: 'player',
      entityId: input.uid,
      source,
      mirroredAt: new Date().toISOString(),
      payload: {
        entityId: input.uid,
        playerUid: input.uid,
        username: input.username,
        coadminUid: input.ownerCoadminUid,
        status: 'active',
        source,
      },
    });
    console.info('[SELF_SIGNUP_COADMIN_NOTIFIED]', {
      playerUid: input.uid,
      coadminUid: input.ownerCoadminUid,
    });
  }

  return result;
}
