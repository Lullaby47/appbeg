'use client';

export type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
};

type PwaInstallSnapshot = {
  deferredPrompt: BeforeInstallPromptEvent | null;
  isInstalled: boolean;
};

declare global {
  interface Window {
    __royalVipDeferredInstallPrompt?: BeforeInstallPromptEvent | null;
  }
}

const PWA_DEBUG = process.env.NEXT_PUBLIC_PWA_DEBUG === '1';
const subscribers = new Set<() => void>();

let deferredPrompt: BeforeInstallPromptEvent | null = null;
let isInstalled = false;
let listenerAttached = false;

function debugLog(message: string, data?: Record<string, unknown>) {
  if (!PWA_DEBUG) return;
  console.info(`[PWA_INSTALL] ${message}`, data || {});
}

function notifySubscribers() {
  subscribers.forEach((subscriber) => subscriber());
}

export function isStandaloneMode(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }

  if (window.matchMedia('(display-mode: standalone)').matches) {
    return true;
  }

  return Boolean(
    (window.navigator as Navigator & { standalone?: boolean }).standalone
  );
}

export function getPwaInstallSnapshot(): PwaInstallSnapshot {
  return {
    deferredPrompt,
    isInstalled,
  };
}

export function subscribeToPwaInstallPrompt(listener: () => void) {
  subscribers.add(listener);
  return () => {
    subscribers.delete(listener);
  };
}

export function clearDeferredInstallPrompt(reason: string) {
  deferredPrompt = null;
  if (typeof window !== 'undefined') {
    window.__royalVipDeferredInstallPrompt = null;
  }
  debugLog('prompt cleared', { reason });
  notifySubscribers();
}

export function markPwaInstalled(reason: string) {
  isInstalled = true;
  clearDeferredInstallPrompt(reason);
  notifySubscribers();
}

export function attachGlobalPwaInstallPromptListener() {
  if (typeof window === 'undefined' || listenerAttached) {
    return;
  }

  listenerAttached = true;
  debugLog('listener attached');

  if (isStandaloneMode()) {
    markPwaInstalled('standalone_detected');
    return;
  }

  const handleBeforeInstallPrompt = (event: Event) => {
    event.preventDefault();
    deferredPrompt = event as BeforeInstallPromptEvent;
    window.__royalVipDeferredInstallPrompt = deferredPrompt;
    debugLog('beforeinstallprompt captured');
    debugLog('prompt stored');
    notifySubscribers();
  };

  const handleAppInstalled = () => {
    debugLog('appinstalled');
    markPwaInstalled('appinstalled');
  };

  window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
  window.addEventListener('appinstalled', handleAppInstalled);
}
