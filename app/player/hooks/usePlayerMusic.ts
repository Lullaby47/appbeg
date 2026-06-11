import { useCallback, useEffect, useRef, useState } from 'react';

import {
  CASINO_BACKGROUND_TRACKS,
  DEFAULT_PLAYER_MUSIC_VOLUME,
  PLAYER_MUSIC_STORAGE_KEY,
} from '../constants';

export function usePlayerMusic() {
  const [musicEnabled, setMusicEnabled] = useState(() => {
    if (typeof window === 'undefined') {
      return false;
    }

    try {
      return window.localStorage.getItem(PLAYER_MUSIC_STORAGE_KEY) === 'true';
    } catch {
      return false;
    }
  });

  const musicEnabledRef = useRef(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const currentTrackRef = useRef<string | null>(null);
  const playRandomTrackRef = useRef<((previousTrack?: string | null) => Promise<void>) | null>(null);
  const interactionListenerCleanupRef = useRef<null | (() => void)>(null);
  const autoplayRetryTimeoutRef = useRef<number | null>(null);
  const pageVisibleRef = useRef(true);
  const audioUnlockedRef = useRef(false);

  const chooseRandomTrack = useCallback((previousTrack?: string | null) => {
    if (CASINO_BACKGROUND_TRACKS.length <= 1) {
      return CASINO_BACKGROUND_TRACKS[0];
    }

    const eligibleTracks = CASINO_BACKGROUND_TRACKS.filter((track) => track !== previousTrack);
    return eligibleTracks[Math.floor(Math.random() * eligibleTracks.length)] || CASINO_BACKGROUND_TRACKS[0];
  }, []);

  const clearInteractionListener = useCallback(() => {
    interactionListenerCleanupRef.current?.();
    interactionListenerCleanupRef.current = null;
  }, []);

  const clearAutoplayRetry = useCallback(() => {
    if (autoplayRetryTimeoutRef.current !== null) {
      window.clearTimeout(autoplayRetryTimeoutRef.current);
      autoplayRetryTimeoutRef.current = null;
    }
  }, []);

  const cleanupAudioElement = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) {
      return;
    }

    audio.pause();
    audio.onended = null;
    audio.onerror = null;
    audio.src = '';
    audioRef.current = null;
  }, []);

  const playCurrentAudio = useCallback(async () => {
    const audio = audioRef.current;
    if (!audio || !musicEnabledRef.current || !pageVisibleRef.current) {
      return false;
    }

    try {
      audio.volume = DEFAULT_PLAYER_MUSIC_VOLUME;
      await audio.play();
      audioUnlockedRef.current = true;
      clearInteractionListener();
      clearAutoplayRetry();
      return true;
    } catch {
      return false;
    }
  }, [clearAutoplayRetry, clearInteractionListener]);

  const attachInteractionListener = useCallback(() => {
    if (interactionListenerCleanupRef.current || typeof window === 'undefined') {
      return;
    }

    const handleInteraction = () => {
      void playCurrentAudio();
    };

    const options: AddEventListenerOptions = { passive: true };
    window.addEventListener('pointerdown', handleInteraction, options);
    window.addEventListener('keydown', handleInteraction, options);
    interactionListenerCleanupRef.current = () => {
      window.removeEventListener('pointerdown', handleInteraction);
      window.removeEventListener('keydown', handleInteraction);
    };
  }, [playCurrentAudio]);

  const playRandomTrack = useCallback(
    async (previousTrack?: string | null) => {
      if (!musicEnabledRef.current) {
        return;
      }

      clearAutoplayRetry();
      cleanupAudioElement();

      const nextTrack = chooseRandomTrack(previousTrack ?? currentTrackRef.current);
      const audio = new Audio(nextTrack);
      audio.volume = DEFAULT_PLAYER_MUSIC_VOLUME;
      audio.preload = 'auto';
      audio.loop = true;
      audio.onended = () => {
        if (!musicEnabledRef.current || !pageVisibleRef.current) {
          return;
        }
        audio.currentTime = 0;
        void playCurrentAudio();
      };
      audio.onerror = () => {
        clearAutoplayRetry();
        autoplayRetryTimeoutRef.current = window.setTimeout(() => {
          autoplayRetryTimeoutRef.current = null;
          void playRandomTrackRef.current?.(nextTrack);
        }, 1200);
      };

      audioRef.current = audio;
      currentTrackRef.current = nextTrack;

      const didPlay = await playCurrentAudio();
      if (!didPlay) {
        attachInteractionListener();
      }
    },
    [
      attachInteractionListener,
      chooseRandomTrack,
      cleanupAudioElement,
      clearAutoplayRetry,
      playCurrentAudio,
    ]
  );

  const playNotificationSound = useCallback(() => {
    const audio = new Audio('/urgency-sound.mp3');
    audio.volume = 0.6;
    void audio.play().catch(() => undefined);
  }, []);

  useEffect(() => {
    playRandomTrackRef.current = playRandomTrack;
  }, [playRandomTrack]);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof document === 'undefined') {
      return undefined;
    }

    const isDocumentVisible = () => document.visibilityState === 'visible';

    const pauseForBackground = () => {
      pageVisibleRef.current = false;
      clearAutoplayRetry();
      audioRef.current?.pause();
    };

    const resumeForForeground = () => {
      pageVisibleRef.current = isDocumentVisible();
      if (!pageVisibleRef.current || !musicEnabledRef.current) {
        return;
      }
      if (!audioUnlockedRef.current) {
        attachInteractionListener();
        return;
      }
      if (audioRef.current) {
        void playCurrentAudio();
      } else {
        void playRandomTrack(currentTrackRef.current);
      }
    };

    const handleVisibilityChange = () => {
      if (isDocumentVisible()) {
        resumeForForeground();
      } else {
        pauseForBackground();
      }
    };

    pageVisibleRef.current = isDocumentVisible();
    if (!pageVisibleRef.current) {
      pauseForBackground();
    }

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('pagehide', pauseForBackground);
    window.addEventListener('blur', pauseForBackground);
    window.addEventListener('freeze', pauseForBackground);
    window.addEventListener('pageshow', resumeForForeground);
    window.addEventListener('focus', resumeForForeground);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('pagehide', pauseForBackground);
      window.removeEventListener('blur', pauseForBackground);
      window.removeEventListener('freeze', pauseForBackground);
      window.removeEventListener('pageshow', resumeForForeground);
      window.removeEventListener('focus', resumeForForeground);
    };
  }, [
    attachInteractionListener,
    clearAutoplayRetry,
    playCurrentAudio,
    playRandomTrack,
  ]);

  useEffect(() => {
    musicEnabledRef.current = musicEnabled;

    try {
      window.localStorage.setItem(PLAYER_MUSIC_STORAGE_KEY, String(musicEnabled));
    } catch {
      // Ignore storage write failures.
    }

    if (!musicEnabled) {
      clearInteractionListener();
      clearAutoplayRetry();
      if (audioRef.current) {
        audioRef.current.pause();
      }
      return;
    }

    if (audioRef.current) {
      void playCurrentAudio();
      return;
    }

    void playRandomTrack(currentTrackRef.current);
  }, [
    clearAutoplayRetry,
    clearInteractionListener,
    musicEnabled,
    playCurrentAudio,
    playRandomTrack,
  ]);

  useEffect(() => {
    return () => {
      clearInteractionListener();
      clearAutoplayRetry();
      cleanupAudioElement();
    };
  }, [cleanupAudioElement, clearAutoplayRetry, clearInteractionListener]);

  return {
    musicEnabled,
    setMusicEnabled,
    playNotificationSound,
  };
}
