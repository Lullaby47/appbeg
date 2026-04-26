import type { ReactNode } from 'react';

import CasinoBackground from '@/components/ui/CasinoBackground';

export default function PlayerLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <CasinoBackground variant="player" />
      {children}
    </>
  );
}
