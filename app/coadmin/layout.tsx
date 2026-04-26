import type { ReactNode } from 'react';

import CasinoBackground from '@/components/ui/CasinoBackground';

export default function CoadminLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <CasinoBackground variant="worker" />
      {children}
    </>
  );
}
