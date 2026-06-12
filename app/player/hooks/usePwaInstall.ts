'use client';

import { useCallback, useEffect, useState } from 'react';

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
};

const INSTALL_NOT_READY_TOAST_MS = 4000;

export const PWA_INSTALL_NOT_READY_MESSAGE =
  'Install is not ready yet. Please try again in a few seconds.';

function isStandaloneMode(): boolean {
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

export function usePwaInstall() {
  const [deferredPrompt, setDeferredPrompt] =
    useState<BeforeInstallPromptEvent | null>(null);
  const [isInstalled, setIsInstalled] = useState(false);
  const [showIosGuide, setShowIosGuide] = useState(false);
  const [showInstallNotReadyToast, setShowInstallNotReadyToast] =
    useState(false);

  useEffect(() => {
    setIsInstalled(isStandaloneMode());
  }, []);

  useEffect(() => {
    const handleBeforeInstallPrompt = (event: Event) => {
      event.preventDefault();
      setDeferredPrompt(event as BeforeInstallPromptEvent);
    };

    const handleAppInstalled = () => {
      setIsInstalled(true);
      setDeferredPrompt(null);
    };

    window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
    window.addEventListener('appinstalled', handleAppInstalled);

    return () => {
      window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
      window.removeEventListener('appinstalled', handleAppInstalled);
    };
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

  const canShowInstallButton = !isInstalled;

  const handleInstallClick = useCallback(async () => {
    if (isIosDevice()) {
      setShowIosGuide(true);
      return;
    }

    if (deferredPrompt) {
      await deferredPrompt.prompt();
      const choice = await deferredPrompt.userChoice;

      if (choice.outcome === 'accepted') {
        setIsInstalled(true);
      }

      setDeferredPrompt(null);
      return;
    }

    setShowInstallNotReadyToast(true);
  }, [deferredPrompt]);

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
