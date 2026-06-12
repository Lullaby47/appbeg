'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
};

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
  const [showIosGuide, setShowIosGuide] = useState(false);
  const [showAndroidPreparing, setShowAndroidPreparing] = useState(false);
  const [showAndroidFallback, setShowAndroidFallback] = useState(false);

  useEffect(() => {
    setIsInstalled(isStandaloneMode());
  }, []);

  useEffect(() => {
    const handleBeforeInstallPrompt = (event: Event) => {
      event.preventDefault();
      setDeferredPrompt(event as BeforeInstallPromptEvent);
      setShowAndroidPreparing(false);
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

  const canShowInstallButton = !isInstalled;

  const installButtonLabel = useMemo(() => {
    if (isIosDevice()) {
      return 'Install App';
    }

    if (isAndroidChrome() && !deferredPrompt) {
      return 'Preparing Install…';
    }

    return 'Install App';
  }, [deferredPrompt]);

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
      setShowAndroidPreparing(true);
      return;
    }

    setShowAndroidFallback(true);
  }, [deferredPrompt]);

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
