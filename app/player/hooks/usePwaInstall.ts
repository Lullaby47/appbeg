'use client';

import { useCallback, useEffect, useState } from 'react';

import {
  attachGlobalPwaInstallPromptListener,
  clearDeferredInstallPrompt,
  getPwaInstallSnapshot,
  isStandaloneMode,
  markPwaInstalled,
  subscribeToPwaInstallPrompt,
} from '@/lib/pwa/installPromptStore';

const INSTALL_NOT_READY_TOAST_MS = 4000;
const PWA_DEBUG = process.env.NEXT_PUBLIC_PWA_DEBUG === '1';

export const PWA_INSTALL_NOT_READY_MESSAGE =
  'Install is not ready yet. Please try again in a few seconds.';

function isIosDevice(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }

  const { userAgent, platform, maxTouchPoints } = window.navigator;

  if (/iPad|iPhone|iPod/.test(userAgent)) {
    return true;
  }

  return platform === 'MacIntel' && maxTouchPoints > 1;
}

function debugLog(message: string, data?: Record<string, unknown>) {
  if (!PWA_DEBUG) return;
  console.info(`[PWA_INSTALL] ${message}`, data || {});
}

export function usePwaInstall() {
  const [installSnapshot, setInstallSnapshot] = useState(() =>
    getPwaInstallSnapshot()
  );
  const [showIosGuide, setShowIosGuide] = useState(false);
  const [showInstallNotReadyToast, setShowInstallNotReadyToast] =
    useState(false);

  useEffect(() => {
    const unsubscribe = subscribeToPwaInstallPrompt(() => {
      setInstallSnapshot(getPwaInstallSnapshot());
    });

    attachGlobalPwaInstallPromptListener();

    if (isStandaloneMode()) {
      markPwaInstalled('standalone_detected_by_player_hook');
    }

    return unsubscribe;
  }, []);

  useEffect(() => {
    if (!showInstallNotReadyToast) {
      return;
    }

    const timer = window.setTimeout(() => {
      setShowInstallNotReadyToast(false);
    }, INSTALL_NOT_READY_TOAST_MS);

    return () => {
      window.clearTimeout(timer);
    };
  }, [showInstallNotReadyToast]);

  const canShowInstallButton = !installSnapshot.isInstalled;

  const handleInstallClick = useCallback(async () => {
    debugLog('install button clicked');

    if (isIosDevice()) {
      setShowIosGuide(true);
      return;
    }

    const { deferredPrompt } = getPwaInstallSnapshot();
    if (deferredPrompt) {
      debugLog('prompt called');
      await deferredPrompt.prompt();
      const choice = await deferredPrompt.userChoice;

      if (choice.outcome === 'accepted') {
        markPwaInstalled('prompt_accepted');
      } else {
        clearDeferredInstallPrompt('prompt_dismissed');
      }
      return;
    }

    setShowInstallNotReadyToast(true);
  }, []);

  const closeIosGuide = useCallback(() => {
    setShowIosGuide(false);
  }, []);

  const dismissInstallNotReadyToast = useCallback(() => {
    setShowInstallNotReadyToast(false);
  }, []);

  return {
    canShowInstallButton,
    showIosGuide,
    showInstallNotReadyToast,
    closeIosGuide,
    dismissInstallNotReadyToast,
    handleInstallClick,
  };
}
