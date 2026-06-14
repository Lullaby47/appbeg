'use client';

import { useEffect, useLayoutEffect } from 'react';
import type { ReactNode } from 'react';

import LoginProgressMountComplete from '@/components/auth/LoginProgressMountComplete';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import CasinoBackground from '@/components/ui/CasinoBackground';
import { installPlayerSessionStorageWatch } from '@/lib/client/playerStaleSession';
import { CASINO_BACKGROUND_TRACKS } from './constants';
import {
  clearStaleRoleThemeStorage,
  installPlayerThemeAudioGuard,
  stopWrongPlayerRouteThemeAudio,
} from '@/lib/client/playerThemeAudioGuard';

export default function PlayerLayout({ children }: { children: ReactNode }) {
  useLayoutEffect(() => {
    installPlayerThemeAudioGuard(CASINO_BACKGROUND_TRACKS);
    clearStaleRoleThemeStorage();
    stopWrongPlayerRouteThemeAudio(CASINO_BACKGROUND_TRACKS);
  }, []);

  useEffect(() => {
    installPlayerSessionStorageWatch();
  }, []);

  return (
    <>
      <LoginProgressMountComplete role="player" />
      <CasinoBackground variant="player" />
      <ProtectedRoute allowedRoles={['player']}>{children}</ProtectedRoute>
    </>
  );
}
