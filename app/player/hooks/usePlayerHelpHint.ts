import { useCallback, useEffect, useRef, useState } from 'react';

export function usePlayerHelpHint() {
  const [showPlayerHelpHint, setShowPlayerHelpHint] = useState(false);
  const playerHelpHintSeenRef = useRef(false);
  const playerHelpHintHideTimeoutRef = useRef<number | null>(null);
  const playerHelpHintIdleTimeoutRef = useRef<number | null>(null);

  const clearPlayerHelpHintHideTimeout = useCallback(() => {
    if (playerHelpHintHideTimeoutRef.current !== null) {
      window.clearTimeout(playerHelpHintHideTimeoutRef.current);
      playerHelpHintHideTimeoutRef.current = null;
    }
  }, []);

  const clearPlayerHelpHintIdleTimeout = useCallback(() => {
    if (playerHelpHintIdleTimeoutRef.current !== null) {
      window.clearTimeout(playerHelpHintIdleTimeoutRef.current);
      playerHelpHintIdleTimeoutRef.current = null;
    }
  }, []);

  const showPlayerHelpHintToast = useCallback(() => {
    playerHelpHintSeenRef.current = true;
    clearPlayerHelpHintHideTimeout();
    setShowPlayerHelpHint(true);
    playerHelpHintHideTimeoutRef.current = window.setTimeout(() => {
      setShowPlayerHelpHint(false);
      playerHelpHintHideTimeoutRef.current = null;
    }, 5000);
  }, [clearPlayerHelpHintHideTimeout]);

  const schedulePlayerHelpHintOnIdle = useCallback(() => {
    clearPlayerHelpHintIdleTimeout();
    playerHelpHintIdleTimeoutRef.current = window.setTimeout(() => {
      showPlayerHelpHintToast();
      playerHelpHintIdleTimeoutRef.current = null;
    }, 60000);
  }, [clearPlayerHelpHintIdleTimeout, showPlayerHelpHintToast]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    showPlayerHelpHintToast();
    schedulePlayerHelpHintOnIdle();

    const handlePlayerActivity = () => {
      setShowPlayerHelpHint(false);
      clearPlayerHelpHintHideTimeout();
      schedulePlayerHelpHintOnIdle();
    };

    const options: AddEventListenerOptions = { passive: true };
    window.addEventListener('pointerdown', handlePlayerActivity, options);
    window.addEventListener('keydown', handlePlayerActivity, options);
    window.addEventListener('touchstart', handlePlayerActivity, options);

    return () => {
      window.removeEventListener('pointerdown', handlePlayerActivity);
      window.removeEventListener('keydown', handlePlayerActivity);
      window.removeEventListener('touchstart', handlePlayerActivity);
      clearPlayerHelpHintHideTimeout();
      clearPlayerHelpHintIdleTimeout();
    };
  }, [
    clearPlayerHelpHintHideTimeout,
    clearPlayerHelpHintIdleTimeout,
    schedulePlayerHelpHintOnIdle,
    showPlayerHelpHintToast,
  ]);

  return showPlayerHelpHint;
}
