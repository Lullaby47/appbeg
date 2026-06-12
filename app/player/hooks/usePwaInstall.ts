'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
};

/** Max wait for beforeinstallprompt on Android Chrome before manual instructions. */
const ANDROID_PROMPT_WAIT_MS = 6000;

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

function isAndroidChrome(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }

  const ua = window.navigator.userAgent;

  if (!/Android/i.test(ua)) {
    return false;
  }

  if (
    /Firefox|FxiOS|OPR|Opera|EdgA|SamsungBrowser|UCBrowser|MiuiBrowser/i.test(
      ua
    )
  ) {
    return false;
  }

  return /Chrome/i.test(ua);
}

export function usePwaInstall() {
  const [deferredPrompt, setDeferredPrompt] =
    useState<BeforeInstallPromptEvent | null>(null);
  const [isInstalled, setIsInstalled] = useState(false);
  const [isAndroidChromeClient, setIsAndroidChromeClient] = useState(false);
  const [androidPromptTimedOut, setAndroidPromptTimedOut] = useState(false);
  const [showIosGuide, setShowIosGuide] = useState(false);
  const [showAndroidPreparing, setShowAndroidPreparing] = useState(false);
  const [showAndroidFallback, setShowAndroidFallback] = useState(false);
  const androidPromptWaitTimerRef = useRef<number | null>(null);

  const clearAndroidPromptWaitTimer = useCallback(() => {
    if (androidPromptWaitTimerRef.current !== null) {
      window.clearTimeout(androidPromptWaitTimerRef.current);
      androidPromptWaitTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    setIsInstalled(isStandaloneMode());
    setIsAndroidChromeClient(isAndroidChrome());
  }, []);

  useEffect(() => {
    const handleBeforeInstallPrompt = (event: Event) => {
      event.preventDefault();
      clearAndroidPromptWaitTimer();
      setDeferredPrompt(event as BeforeInstallPromptEvent);
      setShowAndroidPreparing(false);
    };

    const handleAppInstalled = () => {
      setIsInstalled(true);
      setDeferredPrompt(null);
      clearAndroidPromptWaitTimer();
    };

    window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
    window.addEventListener('appinstalled', handleAppInstalled);

    return () => {
      window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
      window.removeEventListener('appinstalled', handleAppInstalled);
      clearAndroidPromptWaitTimer();
    };
  }, [clearAndroidPromptWaitTimer]);

  useEffect(() => {
    clearAndroidPromptWaitTimer();

    if (!isAndroidChromeClient || isInstalled || deferredPrompt) {
      return;
    }

    setAndroidPromptTimedOut(false);

    androidPromptWaitTimerRef.current = window.setTimeout(() => {
      androidPromptWaitTimerRef.current = null;
      setAndroidPromptTimedOut(true);
      setShowAndroidPreparing(false);
    }, ANDROID_PROMPT_WAIT_MS);

    return () => {
      clearAndroidPromptWaitTimer();
    };
  }, [
    clearAndroidPromptWaitTimer,
    deferredPrompt,
    isAndroidChromeClient,
    isInstalled,
  ]);

  const canShowInstallButton = !isInstalled;

  const installButtonLabel = useMemo(() => {
    if (isIosDevice()) {
      return 'Install App';
    }

    if (deferredPrompt) {
      return 'Install App';
    }

    if (isAndroidChromeClient && !androidPromptTimedOut) {
      return 'Preparing Install…';
    }

    return 'Install App';
  }, [androidPromptTimedOut, deferredPrompt, isAndroidChromeClient]);

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

    if (isAndroidChrome()) {
      if (androidPromptTimedOut) {
        setShowAndroidFallback(true);
      } else {
        setShowAndroidPreparing(true);
      }
      return;
    }

    setShowAndroidFallback(true);
  }, [androidPromptTimedOut, deferredPrompt]);

  const closeIosGuide = useCallback(() => {
    setShowIosGuide(false);
  }, []);

  const closeAndroidPreparing = useCallback(() => {
    setShowAndroidPreparing(false);
  }, []);

  const closeAndroidFallback = useCallback(() => {
    setShowAndroidFallback(false);
  }, []);

  return {
    canShowInstallButton,
    installButtonLabel,
    showIosGuide,
    showAndroidPreparing,
    showAndroidFallback,
    closeIosGuide,
    closeAndroidPreparing,
    closeAndroidFallback,
    handleInstallClick,
  };
}
