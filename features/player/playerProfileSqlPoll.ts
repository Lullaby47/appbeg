'use client';

import { getAppSessionRequestHeaders } from '@/features/auth/appSession';
import { logClientFirestoreSkipped } from '@/lib/client/sqlReadMode';

export type PlayerProfileSqlSnapshot = {
  coin: number;
  cash: number;
  username: string;
  status: string | null;
  coadminUid: string | null;
  referralCode: string | null;
  referredByUid: string | null;
  referredByUsername: string | null;
  dismissedPaymentDetailsNoticeVersion: number;
  coadminPaymentDetailsNoticeVersion: number;
  referralBonusNotice: string | null;
  referralBonusNoticeAt: string | null;
};

type SessionMeResponse = {
  ok?: boolean;
  uid?: string;
  username?: string;
  status?: string | null;
  coadminUid?: string | null;
  player?: {
    coin?: number;
    cash?: number;
    referralCode?: string | null;
    referredByUid?: string | null;
    referredByUsername?: string | null;
    dismissedPaymentDetailsNoticeVersion?: number;
    coadminPaymentDetailsNoticeVersion?: number;
    referralBonusNotice?: string | null;
    referralBonusNoticeAt?: string | null;
  };
};

const DEFAULT_POLL_INTERVAL_MS = 12_000;

function mapSessionMeToProfile(payload: SessionMeResponse): PlayerProfileSqlSnapshot | null {
  if (!payload.ok || !payload.uid) {
    return null;
  }

  const player = payload.player;
  return {
    coin: Number(player?.coin || 0),
    cash: Number(player?.cash || 0),
    username: String(payload.username || '').trim(),
    status: payload.status ?? null,
    coadminUid: String(payload.coadminUid || '').trim() || null,
    referralCode: String(player?.referralCode || '').trim() || null,
    referredByUid: String(player?.referredByUid || '').trim() || null,
    referredByUsername: String(player?.referredByUsername || '').trim() || null,
    dismissedPaymentDetailsNoticeVersion: Number(
      player?.dismissedPaymentDetailsNoticeVersion || 0
    ),
    coadminPaymentDetailsNoticeVersion: Number(
      player?.coadminPaymentDetailsNoticeVersion || 0
    ),
    referralBonusNotice: String(player?.referralBonusNotice || '').trim() || null,
    referralBonusNoticeAt: String(player?.referralBonusNoticeAt || '').trim() || null,
  };
}

async function fetchPlayerProfileSnapshot(): Promise<PlayerProfileSqlSnapshot | null> {
  const response = await fetch('/api/auth/session/me', {
    method: 'GET',
    headers: getAppSessionRequestHeaders(),
    cache: 'no-store',
  });
  if (!response.ok) {
    return null;
  }
  const payload = (await response.json().catch(() => ({}))) as SessionMeResponse;
  return mapSessionMeToProfile(payload);
}

export function attachPlayerProfileSqlPoll(
  onChange: (profile: PlayerProfileSqlSnapshot) => void,
  options?: { intervalMs?: number }
) {
  logClientFirestoreSkipped('player_profile_poll', { route: '/api/auth/session/me' });

  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const intervalMs = Math.max(4_000, Number(options?.intervalMs || DEFAULT_POLL_INTERVAL_MS));

  const tick = async () => {
    if (cancelled) {
      return;
    }
    try {
      const profile = await fetchPlayerProfileSnapshot();
      if (!cancelled && profile) {
        onChange(profile);
      }
    } catch {
      // Best-effort profile poll.
    } finally {
      if (!cancelled) {
        timer = setTimeout(() => {
          void tick();
        }, intervalMs);
      }
    }
  };

  void tick();

  return () => {
    cancelled = true;
    if (timer != null) {
      clearTimeout(timer);
      timer = null;
    }
  };
}

export async function loadPlayerProfileSnapshotOnce(): Promise<PlayerProfileSqlSnapshot | null> {
  logClientFirestoreSkipped('player_profile_once', { route: '/api/auth/session/me' });
  return fetchPlayerProfileSnapshot();
}
