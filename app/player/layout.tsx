'use client';

import type { ReactNode } from 'react';

import ProtectedRoute from '@/components/auth/ProtectedRoute';
import CasinoBackground from '@/components/ui/CasinoBackground';

export default function PlayerLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <CasinoBackground variant="player" />
      <ProtectedRoute allowedRoles={['player']}>{children}</ProtectedRoute>
    </>
  );
}
