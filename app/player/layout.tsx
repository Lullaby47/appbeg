'use client';

import { useEffect } from 'react';
import type { ReactNode } from 'react';

import LoginProgressMountComplete from '@/components/auth/LoginProgressMountComplete';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import CasinoBackground from '@/components/ui/CasinoBackground';
import { installPlayerSessionStorageWatch } from '@/lib/client/playerStaleSession';

export default function PlayerLayout({ children }: { children: ReactNode }) {
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
