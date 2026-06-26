import 'server-only';

import {
  cleanText,
  getPlayerMirrorPool,
  toIsoString,
} from '@/lib/sql/playerMirrorCommon';

const RESERVED_AVATAR_NAMES = new Set([
  'admin',
  'administrator',
  'appbeg',
  'coadmin',
  'moderator',
  'staff',
  'support',
]);

export type PlayerChatProfilePublic = {
  isActive: boolean;
  avatarEmoji: string;
  avatarName: string;
  gender: string;
  bio: string;
  avatarImageUrl: string | null;
  reviewStatus: string;
  suspendedUntil: string | null;
  activatedAt: string | null;
};

export type PlayerChatProfileDraftInput = {
  playerUid: string;
  avatarEmoji?: unknown;
  avatarName?: unknown;
  gender?: unknown;
  bio?: unknown;
  avatarImageUrl?: unknown;
  avatarImagePublicId?: unknown;
};

type PlayerProfileRow = {
  uid?: unknown;
  role?: unknown;
  coadmin_uid?: unknown;
  created_by?: unknown;
  raw_firestore_data?: unknown;
};

type ChatProfileRow = {
  is_active?: unknown;
  avatar_emoji?: unknown;
  avatar_name?: unknown;
  gender?: unknown;
  bio?: unknown;
  avatar_image_url?: unknown;
  review_status?: unknown;
  suspended_until?: unknown;
  activated_at?: unknown;
};

function readRawText(row: PlayerProfileRow, key: string) {
  const raw =
    row.raw_firestore_data && typeof row.raw_firestore_data === 'object'
      ? (row.raw_firestore_data as Record<string, unknown>)
      : {};
  return cleanText(raw[key]);
}

function normalizeAvatarName(value: unknown) {
  return cleanText(value).replace(/\s+/g, ' ');
}

function normalizeBio(value: unknown) {
  return cleanText(value).replace(/\s+/g, ' ');
}

function normalizeAvatarEmoji(value: unknown) {
  return cleanText(value);
}

function normalizeGender(value: unknown) {
  return cleanText(value).toLowerCase();
}

function normalizeNullableUrl(value: unknown) {
  return cleanText(value) || null;
}

function validateAvatarName(value: unknown, options?: { required?: boolean }) {
  const avatarName = normalizeAvatarName(value);
  if (!avatarName) {
    if (options?.required) {
      throw new Error('Avatar Name is required.');
    }
    return avatarName;
  }
  if (avatarName.length < 3 || avatarName.length > 32) {
    throw new Error('Avatar Name must be 3-32 characters.');
  }
  const reservedKey = avatarName.toLowerCase().replace(/[^a-z0-9]+/g, '');
  if (RESERVED_AVATAR_NAMES.has(reservedKey)) {
    throw new Error('That Avatar Name is reserved.');
  }
  return avatarName;
}

function validateBio(value: unknown, options?: { required?: boolean }) {
  const bio = normalizeBio(value);
  if (!bio && options?.required) {
    throw new Error('Bio is required.');
  }
  if (bio.length > 120) {
    throw new Error('Bio must be 120 characters or less.');
  }
  return bio;
}

function validateAvatarEmoji(value: unknown, options?: { required?: boolean }) {
  const avatarEmoji = normalizeAvatarEmoji(value);
  if (!avatarEmoji) {
    if (options?.required) {
      throw new Error('Avatar Emoji is required.');
    }
    return avatarEmoji;
  }
  if (avatarEmoji.length > 24) {
    throw new Error('Avatar Emoji is too long.');
  }
  return avatarEmoji;
}

function validateGender(value: unknown, options?: { required?: boolean }) {
  const gender = normalizeGender(value);
  if (!gender) {
    if (options?.required) {
      throw new Error('Gender is required.');
    }
    return gender;
  }
  if (gender !== 'male' && gender !== 'female') {
    throw new Error('Gender must be male or female.');
  }
  return gender;
}

function mapProfileRow(row: ChatProfileRow | null): PlayerChatProfilePublic {
  return {
    isActive: row?.is_active === true,
    avatarEmoji: cleanText(row?.avatar_emoji),
    avatarName: cleanText(row?.avatar_name),
    gender: normalizeGender(row?.gender),
    bio: cleanText(row?.bio),
    avatarImageUrl: cleanText(row?.avatar_image_url) || null,
    reviewStatus: cleanText(row?.review_status) || 'approved',
    suspendedUntil: toIsoString(row?.suspended_until),
    activatedAt: toIsoString(row?.activated_at),
  };
}

function defaultProfile(): PlayerChatProfilePublic {
  return {
    isActive: false,
    avatarEmoji: '',
    avatarName: '',
    gender: '',
    bio: '',
    avatarImageUrl: null,
    reviewStatus: 'approved',
    suspendedUntil: null,
    activatedAt: null,
  };
}

async function readPlayerForSelfProfile(playerUid: string) {
  const db = getPlayerMirrorPool();
  const uid = cleanText(playerUid);
  if (!db) {
    throw new Error('Postgres is unavailable.');
  }
  if (!uid) {
    throw new Error('Player session required.');
  }

  const result = await db.query<PlayerProfileRow>(
    `
      SELECT uid, role, coadmin_uid, created_by, raw_firestore_data
      FROM public.players_cache
      WHERE uid = $1
        AND deleted_at IS NULL
      LIMIT 1
    `,
    [uid]
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error('Player profile not found.');
  }
  if (cleanText(row.role).toLowerCase() !== 'player') {
    throw new Error('Only players can manage Player Chat profiles.');
  }

  const coadminUid =
    cleanText(row.coadmin_uid) ||
    cleanText(row.created_by) ||
    readRawText(row, 'coadminUid') ||
    readRawText(row, 'createdBy');
  if (!coadminUid) {
    throw new Error('Player coadmin scope not found.');
  }

  return {
    playerUid: uid,
    coadminUid,
  };
}

async function readProfileRow(playerUid: string) {
  const db = getPlayerMirrorPool();
  if (!db) {
    throw new Error('Postgres is unavailable.');
  }
  const result = await db.query<ChatProfileRow>(
    `
      SELECT is_active, avatar_emoji, avatar_name, gender, bio, avatar_image_url, review_status,
             suspended_until, activated_at
      FROM public.player_chat_profiles
      WHERE player_uid = $1
      LIMIT 1
    `,
    [playerUid]
  );
  return result.rows[0] || null;
}

export async function getMyPlayerChatProfileInSql(input: {
  playerUid: string;
}): Promise<PlayerChatProfilePublic> {
  const player = await readPlayerForSelfProfile(input.playerUid);
  const row = await readProfileRow(player.playerUid);
  return row ? mapProfileRow(row) : defaultProfile();
}

export async function upsertMyPlayerChatProfileInSql(
  input: PlayerChatProfileDraftInput
): Promise<PlayerChatProfilePublic> {
  const player = await readPlayerForSelfProfile(input.playerUid);
  const existing = await readProfileRow(player.playerUid);
  const wasActive = existing?.is_active === true;
  const avatarEmoji = validateAvatarEmoji(input.avatarEmoji, { required: wasActive });
  const avatarName = validateAvatarName(input.avatarName, { required: wasActive });
  const gender = validateGender(input.gender, { required: wasActive });
  const bio = validateBio(input.bio, { required: wasActive });
  const avatarImageUrl = normalizeNullableUrl(input.avatarImageUrl);
  const avatarImagePublicId = normalizeNullableUrl(input.avatarImagePublicId);

  const db = getPlayerMirrorPool();
  if (!db) {
    throw new Error('Postgres is unavailable.');
  }

  const result = await db.query<ChatProfileRow>(
    `
      INSERT INTO public.player_chat_profiles (
        player_uid, coadmin_uid, is_active, avatar_emoji, avatar_name, gender, bio,
        avatar_image_url, avatar_image_public_id, review_status,
        created_at, updated_at
      )
      VALUES (
        $1, $2, FALSE, $3, $4, $5, $6,
        $7, $8, 'approved',
        now(), now()
      )
      ON CONFLICT (player_uid) DO UPDATE SET
        coadmin_uid = EXCLUDED.coadmin_uid,
        avatar_emoji = EXCLUDED.avatar_emoji,
        avatar_name = EXCLUDED.avatar_name,
        gender = EXCLUDED.gender,
        bio = EXCLUDED.bio,
        avatar_image_url = EXCLUDED.avatar_image_url,
        avatar_image_public_id = EXCLUDED.avatar_image_public_id,
        updated_at = now()
      RETURNING is_active, avatar_emoji, avatar_name, gender, bio, avatar_image_url, review_status,
                suspended_until, activated_at
    `,
    [
      player.playerUid,
      player.coadminUid,
      avatarEmoji,
      avatarName,
      gender,
      bio,
      avatarImageUrl,
      avatarImagePublicId,
    ]
  );

  return mapProfileRow(result.rows[0] || null);
}

export async function activateMyPlayerChatProfileInSql(input: {
  playerUid: string;
}): Promise<PlayerChatProfilePublic> {
  const player = await readPlayerForSelfProfile(input.playerUid);
  const existing = await readProfileRow(player.playerUid);
  if (!existing) {
    throw new Error('Save your Chat Profile before activating Player Chat.');
  }

  const avatarEmoji = validateAvatarEmoji(cleanText(existing.avatar_emoji), { required: true });
  const avatarName = validateAvatarName(cleanText(existing.avatar_name), { required: true });
  const gender = validateGender(cleanText(existing.gender), { required: true });
  const bio = validateBio(cleanText(existing.bio), { required: true });
  const reviewStatus = cleanText(existing.review_status) || 'approved';
  if (reviewStatus !== 'approved') {
    throw new Error('Player Chat profile is not approved for activation.');
  }
  const suspendedUntil = toIsoString(existing.suspended_until);
  if (suspendedUntil && new Date(suspendedUntil).getTime() > Date.now()) {
    throw new Error('Player Chat profile is suspended.');
  }

  const db = getPlayerMirrorPool();
  if (!db) {
    throw new Error('Postgres is unavailable.');
  }

  const result = await db.query<ChatProfileRow>(
    `
      UPDATE public.player_chat_profiles
      SET coadmin_uid = $2,
          is_active = TRUE,
          avatar_emoji = $3,
          avatar_name = $4,
          gender = $5,
          bio = $6,
          updated_at = now(),
          activated_at = COALESCE(activated_at, now()),
          deactivated_at = NULL
      WHERE player_uid = $1
      RETURNING is_active, avatar_emoji, avatar_name, gender, bio, avatar_image_url, review_status,
                suspended_until, activated_at
    `,
    [player.playerUid, player.coadminUid, avatarEmoji, avatarName, gender, bio]
  );

  return mapProfileRow(result.rows[0] || null);
}

export async function deactivateMyPlayerChatProfileInSql(input: {
  playerUid: string;
}): Promise<PlayerChatProfilePublic> {
  const player = await readPlayerForSelfProfile(input.playerUid);
  const db = getPlayerMirrorPool();
  if (!db) {
    throw new Error('Postgres is unavailable.');
  }

  const result = await db.query<ChatProfileRow>(
    `
      INSERT INTO public.player_chat_profiles (
        player_uid, coadmin_uid, is_active, review_status,
        created_at, updated_at, deactivated_at
      )
      VALUES ($1, $2, FALSE, 'approved', now(), now(), now())
      ON CONFLICT (player_uid) DO UPDATE SET
        coadmin_uid = EXCLUDED.coadmin_uid,
        is_active = FALSE,
        updated_at = now(),
        deactivated_at = now()
      RETURNING is_active, avatar_emoji, avatar_name, gender, bio, avatar_image_url, review_status,
                suspended_until, activated_at
    `,
    [player.playerUid, player.coadminUid]
  );

  return mapProfileRow(result.rows[0] || null);
}
