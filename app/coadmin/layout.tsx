import type { ReactNode } from 'react';

import LoginProgressMountComplete from '@/components/auth/LoginProgressMountComplete';
import CasinoBackground from '@/components/ui/CasinoBackground';

export default function CoadminLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <LoginProgressMountComplete role="coadmin" />
      <CasinoBackground variant="worker" />
      {children}
    </>
  );
}
