import type { ReactNode } from 'react';

import LoginProgressMountComplete from '@/components/auth/LoginProgressMountComplete';
import CasinoBackground from '@/components/ui/CasinoBackground';

export default function CarerLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <LoginProgressMountComplete role="carer" />
      <CasinoBackground variant="worker" />
      {children}
    </>
  );
}
