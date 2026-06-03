import { FieldValue } from 'firebase-admin/firestore';
import { NextResponse } from 'next/server';

import { apiError, belongsToScope, requireApiUser, scopedCoadminUid } from '@/lib/firebase/apiAuth';
import { adminDb } from '@/lib/firebase/admin';
import { assertValidGameUsername } from '@/lib/games/gameUsernameRule';
import { deactivateGameUsername, recordGameUsername } from '@/lib/sql/usernameRegistry';

type SavePlayerGameLoginBody = {
  action?: unknown;
  loginId?: unknown;
  playerUid?: unknown;
  playerUsername?: unknown;
  gameName?: unknown;
  gameUsername?: unknown;
  gamePassword?: unknown;
  frontendUrl?: unknown;
  siteUrl?: unknown;
  coadminUid?: unknown;
};

function clean(value: unknown) {
  return String(value || '').trim();
}

async function assertPlayerScope(playerUid: string, coadminUid: string) {
  const playerSnap = await adminDb.collection('users').doc(playerUid).get();
  if (!playerSnap.exists) {
    throw new Error('Player not found.');
  }
  const player = playerSnap.data() as {
    role?: string;
    username?: string | null;
    coadminUid?: string | null;
    createdBy?: string | null;
  };
  if (String(player.role || '').toLowerCase() !== 'player') {
    throw new Error('Selected user is not a player.');
  }
  if (!belongsToScope(player, coadminUid)) {
    throw new Error('Player is outside your coadmin scope.');
  }
  return player;
}

async function recordAfterFirebaseSave(input: {
  username: string;
  game: string;
  playerUid: string;
  coadminUid: string;
  source: string;
}) {
  try {
    await recordGameUsername({
      username: input.username,
      game: input.game,
      playerUid: input.playerUid,
      coadminUid: input.coadminUid,
      source: input.source,
    });
    return { recorded: true as const };
  } catch (error) {
    console.warn('[PLAYER_GAME_LOGINS] VPS username registry record failed after Firebase save', {
      username: input.username,
      game: input.game,
      playerUid: input.playerUid,
      coadminUid: input.coadminUid,
      source: input.source,
      error,
    });
    return {
      recorded: false as const,
      warning: 'Firebase save succeeded, but VPS username registry recording failed.',
    };
  }
}

async function deactivateAfterFirebaseSave(input: {
  username: string;
  playerUid: string;
  reason: 'deleted' | 'archived' | 'removed' | 'replaced';
}) {
  try {
    await deactivateGameUsername({
      username: input.username,
      playerUid: input.playerUid,
      reason: input.reason,
    });
    return { deactivated: true as const };
  } catch (error) {
    console.warn('[PLAYER_GAME_LOGINS] VPS username registry deactivate failed after Firebase save', {
      username: input.username,
      playerUid: input.playerUid,
      reason: input.reason,
      error,
    });
    return { deactivated: false as const };
  }
}

export async function POST(request: Request) {
  try {
    const auth = await requireApiUser(request, ['admin', 'coadmin', 'staff', 'carer']);
    if ('response' in auth) return auth.response;

    const body = (await request.json()) as SavePlayerGameLoginBody;
    const action = clean(body.action || 'create');
    const gameName = clean(body.gameName);
    const gameUsername = clean(body.gameUsername);
    const gamePassword = String(body.gamePassword || '');
    const frontendUrl = clean(body.frontendUrl);
    const siteUrl = clean(body.siteUrl);

    if (!gameName) return apiError('Game name is required.', 400);
    if (!gameUsername) return apiError('Game username is required.', 400);
    assertValidGameUsername(gameUsername);
    if (!gamePassword.trim()) return apiError('Game password is required.', 400);

    const callerScope = scopedCoadminUid(auth.user);
    if (auth.user.role !== 'admin' && !callerScope) {
      return apiError('No coadmin scope found for current user.', 403);
    }

    if (action === 'create') {
      const playerUid = clean(body.playerUid);
      const requestedCoadminUid = clean(body.coadminUid) || clean(callerScope);
      if (!playerUid) return apiError('Player is required.', 400);
      if (!requestedCoadminUid) return apiError('coadminUid is required.', 400);
      if (auth.user.role !== 'admin' && requestedCoadminUid !== callerScope) {
        return apiError('Cannot create username outside your coadmin scope.', 403);
      }

      const player = await assertPlayerScope(playerUid, requestedCoadminUid);
      const playerUsername = clean(body.playerUsername) || clean(player.username) || 'Unknown player';
      const docRef = await adminDb.collection('playerGameLogins').add({
        playerUid,
        playerUsername,
        gameName,
        gameUsername,
        gamePassword,
        frontendUrl,
        siteUrl,
        coadminUid: requestedCoadminUid,
        createdBy: requestedCoadminUid,
        createdAt: FieldValue.serverTimestamp(),
      });

      const registry = await recordAfterFirebaseSave({
        username: gameUsername,
        game: gameName,
        playerUid,
        coadminUid: requestedCoadminUid,
        source: 'appbeg',
      });

      return NextResponse.json({ success: true, id: docRef.id, ...registry });
    }

    if (action === 'update') {
      const loginId = clean(body.loginId);
      if (!loginId) return apiError('Login id is required.', 400);

      const loginRef = adminDb.collection('playerGameLogins').doc(loginId);
      const loginSnap = await loginRef.get();
      if (!loginSnap.exists) return apiError('Game login not found.', 404);
      const login = loginSnap.data() as {
        playerUid?: string;
        gameUsername?: string | null;
        coadminUid?: string | null;
        createdBy?: string | null;
      };
      const coadminUid = clean(login.coadminUid || login.createdBy);
      if (!coadminUid) return apiError('Game login coadmin scope is missing.', 400);
      if (auth.user.role !== 'admin' && coadminUid !== callerScope) {
        return apiError('Cannot update username outside your coadmin scope.', 403);
      }
      const playerUid = clean(login.playerUid);
      if (!playerUid) return apiError('Game login player is missing.', 400);
      await assertPlayerScope(playerUid, coadminUid);

      await loginRef.update({
        gameName,
        gameUsername,
        gamePassword,
        frontendUrl,
        siteUrl,
        updatedAt: FieldValue.serverTimestamp(),
      });

      const previousUsername = clean(login.gameUsername);
      const usernameReplaced =
        previousUsername && previousUsername.toLowerCase() !== gameUsername.toLowerCase();
      if (usernameReplaced) {
        await deactivateAfterFirebaseSave({
          username: previousUsername,
          playerUid,
          reason: 'replaced',
        });
      }

      const registry = await recordAfterFirebaseSave({
        username: gameUsername,
        game: gameName,
        playerUid,
        coadminUid,
        source: 'appbeg',
      });

      return NextResponse.json({ success: true, id: loginId, ...registry });
    }

    return apiError('Invalid player game login action.', 400);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to save game username.';
    const status =
      /not authenticated|authorization|token/i.test(message)
        ? 401
        : /forbidden|outside your coadmin scope|cannot/i.test(message)
          ? 403
          : /not found/i.test(message)
            ? 404
            : /required|invalid|player|username|password|scope/i.test(message)
              ? 400
              : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
