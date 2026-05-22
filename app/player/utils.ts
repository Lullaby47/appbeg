import type { PlayerGameRequest } from '@/features/games/playerGameRequests';
import type { PlayerAlertInfo, PlayerGameRequestType } from './types';
import {
  DEFAULT_GAME_BACKGROUND_IMAGE,
  GLOBAL_RECENT_PLAY_AMOUNT_STORAGE_KEY,
  RECENT_PLAY_AMOUNT_LIMIT,
} from './constants';

export function getTimestampMs(value: unknown) {
  if (!value) {
    return 0;
  }

  if (typeof value === 'object' && value !== null) {
    const maybeTimestamp = value as {
      toDate?: () => Date;
      toMillis?: () => number;
      getTime?: () => number;
      seconds?: number;
    };

    if (typeof maybeTimestamp.toMillis === 'function') {
      return maybeTimestamp.toMillis();
    }

    if (typeof maybeTimestamp.toDate === 'function') {
      return maybeTimestamp.toDate().getTime();
    }

    if (typeof maybeTimestamp.getTime === 'function') {
      return maybeTimestamp.getTime();
    }

    if (typeof maybeTimestamp.seconds === 'number') {
      return maybeTimestamp.seconds * 1000;
    }
  }

  return 0;
}

export function formatDateTime(value: unknown) {
  const timestampMs = getTimestampMs(value);

  if (!timestampMs) {
    return 'Not available';
  }

  return new Date(timestampMs).toLocaleString();
}

export function getPlayerBonusEventDescription(description: string | null | undefined) {
  const normalizedDescription = description?.trim();

  if (
    normalizedDescription ===
    'Auto-generated co-admin bonus event to maintain active event capacity.'
  ) {
    return null;
  }

  return normalizedDescription || null;
}

export function getRequestStatusLabel(status: PlayerGameRequest['status']) {
  if (status === 'completed') {
    return 'Completed';
  }
  if (status === 'dismissed') {
    return 'Dismissed';
  }
  if (status === 'failed') {
    return 'Failed';
  }
  if (status === 'pending_review') {
    return 'Pending review';
  }
  return 'Pending';
}

export function getRequestStatusClass(status: PlayerGameRequest['status']) {
  if (status === 'completed') {
    return 'bg-emerald-500/20 text-emerald-200';
  }
  if (status === 'dismissed') {
    return 'bg-red-500/20 text-red-200';
  }
  if (status === 'failed') {
    return 'bg-rose-500/20 text-rose-200';
  }
  if (status === 'pending_review') {
    return 'bg-sky-500/20 text-sky-200';
  }

  return 'bg-amber-500/20 text-amber-200';
}

export function sortByNewest<T extends { createdAt?: unknown; completedAt?: unknown; pokedAt?: unknown }>(
  items: T[]
) {
  return [...items].sort((left, right) => {
    const leftTime =
      getTimestampMs(left.pokedAt) ||
      getTimestampMs(left.completedAt) ||
      getTimestampMs(left.createdAt);
    const rightTime =
      getTimestampMs(right.pokedAt) ||
      getTimestampMs(right.completedAt) ||
      getTimestampMs(right.createdAt);

    return rightTime - leftTime;
  });
}

export function normalizeGameKey(gameName: string) {
  return gameName.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_');
}

export function sanitizeWholeAmountText(value: string) {
  return value.replace(/\D/g, '');
}

export function normalizeRecentAmounts(amounts: string[]) {
  const seen = new Set<string>();
  const nextAmounts: string[] = [];

  for (const amount of amounts) {
    const cleanAmount = sanitizeWholeAmountText(amount);
    if (!cleanAmount || seen.has(cleanAmount)) {
      continue;
    }
    seen.add(cleanAmount);
    nextAmounts.push(cleanAmount);
    if (nextAmounts.length >= RECENT_PLAY_AMOUNT_LIMIT) {
      break;
    }
  }

  return nextAmounts;
}

export function getRecentPlayAmountStorageKey(
  playerUidValue: string,
  gameIdValue: string,
  taskType?: PlayerGameRequestType
) {
  if (!playerUidValue || !gameIdValue || !taskType) {
    return GLOBAL_RECENT_PLAY_AMOUNT_STORAGE_KEY;
  }
  return `appbeg:recentAmounts:${playerUidValue}:${gameIdValue}:${taskType}`;
}

export function normalizeBackgroundKey(gameName: string) {
  return gameName.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function getGameBackgroundImage(
  backgroundsByKey: Record<string, string>,
  gameName?: string | null
) {
  const key = normalizeBackgroundKey(String(gameName || ''));
  if (!key) {
    return DEFAULT_GAME_BACKGROUND_IMAGE;
  }
  return backgroundsByKey[key] || DEFAULT_GAME_BACKGROUND_IMAGE;
}

export function normalizeExternalUrl(siteUrl?: string | null) {
  const trimmed = String(siteUrl || '').trim();
  if (!trimmed) {
    return '';
  }
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

export function buildCreatorDisplayLabel(data: { role?: string; username?: string } | undefined) {
  if (!data) {
    return 'Unknown Creator';
  }

  const role = String(data.role || '').toLowerCase();

  if (role === 'staff') {
    return 'Staff Team';
  }

  if (role === 'coadmin') {
    return 'Coadmin Team';
  }

  if (role === 'carer') {
    return 'Carer Team';
  }

  return 'Unknown Creator';
}

export function clampClipboardToastX(clientX: number) {
  if (typeof window === 'undefined') {
    return clientX;
  }
  const half = 88;
  const pad = 10;
  return Math.min(Math.max(clientX, pad + half), window.innerWidth - pad - half);
}

export function isClipboardBannerMessage(raw: string) {
  const t = raw.trim().toLowerCase();

  return (
    t.endsWith(' copied to clipboard.') ||
    /^nothing to copy for\b/.test(raw.trim()) ||
    t.includes('nothing to copy for ') ||
    t === 'could not copy. select and copy manually.' ||
    t === 'referral code copied.' ||
    t === 'referral code is not available yet.' ||
    t === 'could not copy referral code.' ||
    t === 'code copied to clipboard.' ||
    (t.includes('copy failed') && t.includes('code'))
  );
}

export function getPlayerAlertInfo(raw: string): PlayerAlertInfo | null {
  const text = raw.trim();

  if (!text) {
    return null;
  }

  if (isClipboardBannerMessage(raw)) {
    return null;
  }

  const lower = text.toLowerCase();

  if (
    (lower.includes('index') || lower.includes('indexes')) &&
    (lower.includes('firestore') ||
      lower.includes('failed_precondition') ||
      lower.includes('create_composite') ||
      lower.includes('composite'))
  ) {
    return {
      variant: 'index',
      title: 'Setup needed: Firestore index required',
      body: 'An index must be created in the Firebase console before this data can load. Share the console link from the technical details with your admin.',
      raw: text,
    };
  }

  if (
    lower.includes('permission') ||
    lower.includes('permissions') ||
    lower.includes('insufficient permissions')
  ) {
    return {
      variant: 'permission',
      title: 'Access restricted',
      body: 'Your account may not have permission for this action. If this is unexpected, contact support.',
      raw: text,
    };
  }

  if (
    lower.includes('not enough coin') ||
    lower.includes('insufficient coin') ||
    (lower.includes('recharge') &&
      (lower.includes('add coin first') || lower.includes('low coin')))
  ) {
    return {
      variant: 'lowCoin',
      title: 'Not enough coin for recharge',
      body: text,
      raw: text,
    };
  }

  if (
    lower.includes('blocked') ||
    lower.includes('denied') ||
    lower.includes('failed') ||
    lower.includes('invalid') ||
    lower.includes('wait until') ||
    lower.includes('limit') ||
    lower.includes('minimum withdrawal') ||
    lower.includes('possible bonus abuse') ||
    lower.includes('not enough') ||
    lower.includes('required') ||
    lower.includes('disabled') ||
    lower.includes('cannot') ||
    lower.includes('outside your coadmin scope')
  ) {
    return {
      variant: 'warning',
      title: 'Warning',
      body: text,
      raw: text,
    };
  }

  if (
    lower.includes('request sent') ||
    lower.includes('approved') ||
    lower.includes('successful') ||
    lower.includes('successfully') ||
    lower.includes('uploaded successfully') ||
    lower.includes('loaded your last used') ||
    lower.includes('dismissed') ||
    lower.includes('converted to coin') ||
    lower.includes('inquiry sent')
  ) {
    return {
      variant: 'success',
      title: 'Success',
      body: text,
      raw: text,
    };
  }

  return {
    variant: 'success',
    title: 'Notice',
    body: text,
    raw: text,
  };
}
