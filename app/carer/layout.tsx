import type { ReactNode } from 'react';

import CasinoBackground from '@/components/ui/CasinoBackground';

export default function CarerLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <CasinoBackground variant="worker" />
      {children}
    </>
  );
}
