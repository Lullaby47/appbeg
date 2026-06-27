'use client';

import { GAME_BACKGROUND_IMAGE_BY_KEY } from './constants';
import { getMobileGameBackgroundImage } from './utils';
import { markPlayerPerf, PLAYER_PERF_DEBUG } from './performance';

type WarmStatus = 'queued' | 'loading' | 'decoded' | 'failed';

type WarmEntry = {
  decode: boolean;
  reason: string;
  url: string;
};

type WarmOptions = {
  decode?: boolean;
  priority?: 'high' | 'idle';
  reason?: string;
};

const MAX_CONCURRENT_DECODES = 2;
const MAX_BATCH_STARTS = 2;

const imageStatusByUrl = new Map<string, WarmStatus>();
const imageQueue: WarmEntry[] = [];
let activeDecodes = 0;
let scheduled = false;

export const PLAYER_DECORATIVE_ASSET_URLS = [
  '/assets/player/embers.png',
  '/assets/player/fire-orange.png',
  '/assets/player/fire-green.png',
  '/assets/player/fire-purple.png',
];

export const PLAYER_FREEPLAY_GIFT_IMAGE_URL = '/assets/player/freeplay-gift-box.webp';

function getIdleScheduler() {
  if (typeof window === 'undefined') {
    return null;
  }
  return (
    window.requestIdleCallback ||
    ((callback: IdleRequestCallback) =>
      window.setTimeout(
        () =>
          callback({
            didTimeout: false,
            timeRemaining: () => 0,
          } as IdleDeadline),
        90
      ))
  );
}

function scheduleQueue(priority: WarmOptions['priority'] = 'idle') {
  if (scheduled || typeof window === 'undefined') {
    return;
  }
  scheduled = true;
  const run = () => {
    scheduled = false;
    processQueue();
  };
  if (priority === 'high') {
    window.setTimeout(run, 0);
    return;
  }
  const scheduler = getIdleScheduler();
  scheduler?.(run, { timeout: 1_200 });
}

function normalizeUrl(url: string) {
  return String(url || '').trim();
}

function markDecoded(url: string, reason: string, startedAt: number) {
  imageStatusByUrl.set(url, 'decoded');
  markPlayerPerf('image_decode_done', {
    url,
    reason,
    durationMs: Math.round(performance.now() - startedAt),
  });
}

function processQueue() {
  let started = 0;
  while (
    activeDecodes < MAX_CONCURRENT_DECODES &&
    started < MAX_BATCH_STARTS &&
    imageQueue.length > 0
  ) {
    const entry = imageQueue.shift();
    if (!entry) {
      break;
    }
    if (imageStatusByUrl.get(entry.url) === 'decoded') {
      continue;
    }

    started += 1;
    activeDecodes += 1;
    imageStatusByUrl.set(entry.url, 'loading');
    const startedAt =
      typeof performance !== 'undefined' && typeof performance.now === 'function'
        ? performance.now()
        : Date.now();
    markPlayerPerf('image_decode_start', {
      url: entry.url,
      reason: entry.reason,
    });

    const image = new Image();
    image.decoding = 'async';

    const finish = (status: WarmStatus) => {
      activeDecodes = Math.max(0, activeDecodes - 1);
      imageStatusByUrl.set(entry.url, status);
      if (status === 'failed') {
        markPlayerPerf('image_decode_failed', {
          url: entry.url,
          reason: entry.reason,
        });
      }
      scheduleQueue('idle');
    };

    image.onload = () => {
      if (!entry.decode || typeof image.decode !== 'function') {
        markDecoded(entry.url, entry.reason, startedAt);
        finish('decoded');
        return;
      }
      image
        .decode()
        .then(() => {
          markDecoded(entry.url, entry.reason, startedAt);
          finish('decoded');
        })
        .catch(() => {
          markDecoded(entry.url, entry.reason, startedAt);
          finish('decoded');
        });
    };
    image.onerror = () => finish('failed');
    image.src = entry.url;
  }

  if (imageQueue.length > 0 && activeDecodes < MAX_CONCURRENT_DECODES) {
    scheduleQueue('idle');
  }
}

export function warmPlayerImage(url: string, options: WarmOptions = {}) {
  const normalizedUrl = normalizeUrl(url);
  if (!normalizedUrl || typeof window === 'undefined') {
    return;
  }
  const currentStatus = imageStatusByUrl.get(normalizedUrl);
  if (currentStatus === 'queued' || currentStatus === 'loading' || currentStatus === 'decoded') {
    return;
  }

  imageStatusByUrl.set(normalizedUrl, 'queued');
  const entry: WarmEntry = {
    decode: options.decode !== false,
    reason: options.reason || 'unspecified',
    url: normalizedUrl,
  };
  if (options.priority === 'high') {
    imageQueue.unshift(entry);
  } else {
    imageQueue.push(entry);
  }
  scheduleQueue(options.priority);
}

export function warmPlayerImages(urls: string[], options: WarmOptions = {}) {
  for (const url of urls) {
    warmPlayerImage(url, options);
  }
}

export function isPlayerMobileViewport() {
  if (typeof window === 'undefined') {
    return false;
  }
  return window.matchMedia('(max-width: 767px)').matches;
}

export function getPreferredPlayerGameImageUrl(imagePath: string, forceMobile = false) {
  if (forceMobile || isPlayerMobileViewport()) {
    return getMobileGameBackgroundImage(imagePath);
  }
  return imagePath;
}

export function getDefaultPlayerGameImageUrls(forceMobile = false) {
  return Object.values(GAME_BACKGROUND_IMAGE_BY_KEY).map((url) =>
    getPreferredPlayerGameImageUrl(url, forceMobile)
  );
}

export function notePlayerImageElementLoad(url: string, context: string) {
  const normalizedUrl = normalizeUrl(url);
  if (!normalizedUrl) {
    return;
  }
  imageStatusByUrl.set(normalizedUrl, 'decoded');
  if (PLAYER_PERF_DEBUG) {
    markPlayerPerf('image_element_loaded', {
      url: normalizedUrl,
      context,
    });
  }
}
