import { getPlayerApiHeaders } from '@/features/auth/playerSession';
import type { GameLogin } from '@/features/games/gameLogins';
import type { ReferralRewardGroup } from '@/features/referrals/playerReferralRewards';

export type PlayerBaseDataStaff = {
  id: string;
  uid: string;
  username: string;
  email: string;
  role: 'staff';
  status: 'active' | 'disabled';
  createdBy: string | null;
  coadminUid?: string | null;
};

export type PlayerBaseDataResponse = {
  staff: PlayerBaseDataStaff[];
  gameLogins: GameLogin[];
  pendingGift: {
    hasPendingGift: boolean;
    giftId: string | null;
    source: 'postgres' | 'firestore' | 'none';
  };
  referralRewards: {
    groups: ReferralRewardGroup[];
    source: 'postgres' | 'firestore' | 'none';
  };
  source: 'postgres' | 'mixed' | 'fallback';
  snapshotAt: string;
};

let inFlightBaseData: Promise<PlayerBaseDataResponse> | null = null;

function normalizeBaseDataResponse(
  payload: PlayerBaseDataResponse & { error?: string }
): PlayerBaseDataResponse {
  return {
    staff: Array.isArray(payload.staff) ? payload.staff : [],
    gameLogins: Array.isArray(payload.gameLogins) ? payload.gameLogins : [],
    pendingGift: {
      hasPendingGift: Boolean(payload.pendingGift?.hasPendingGift),
      giftId: payload.pendingGift?.giftId ?? null,
      source: payload.pendingGift?.source || 'none',
    },
    referralRewards: {
      groups: Array.isArray(payload.referralRewards?.groups)
        ? payload.referralRewards.groups
        : [],
      source: payload.referralRewards?.source || 'none',
    },
    source: payload.source || 'fallback',
    snapshotAt: payload.snapshotAt || new Date().toISOString(),
  };
}

export async function loadPlayerBaseData(): Promise<PlayerBaseDataResponse> {
  if (inFlightBaseData) {
    console.info('[PLAYER_BASE_DATA_CLIENT]', {
      stage: 'start',
      deduped: true,
      usedFallback: false,
    });
    return inFlightBaseData;
  }

  console.info('[PLAYER_BASE_DATA_CLIENT]', {
    stage: 'start',
    deduped: false,
    usedFallback: false,
  });

  inFlightBaseData = (async () => {
    const startedAt = Date.now();
    const headers = await getPlayerApiHeaders(false);
    const response = await fetch('/api/player/base-data', {
      method: 'GET',
      headers,
      cache: 'no-store',
    });
    const payload = (await response.json().catch(() => ({}))) as PlayerBaseDataResponse & {
      error?: string;
    };
    if (!response.ok) {
      throw new Error(payload.error || 'Failed to load player base data.');
    }

    const normalized = normalizeBaseDataResponse(payload);
    console.info('[PLAYER_BASE_DATA_CLIENT]', {
      stage: 'done',
      deduped: false,
      usedFallback: false,
      staffCount: normalized.staff.length,
      gameLoginCount: normalized.gameLogins.length,
      referralGroupCount: normalized.referralRewards.groups.length,
      hasPendingGift: normalized.pendingGift.hasPendingGift,
      source: normalized.source,
      durationMs: Date.now() - startedAt,
    });

    return normalized;
  })();

  try {
    return await inFlightBaseData;
  } finally {
    inFlightBaseData = null;
  }
}
