import type { ReactNode } from 'react';

import LoginProgressMountComplete from '@/components/auth/LoginProgressMountComplete';
import CasinoBackground from '@/components/ui/CasinoBackground';

export default function StaffLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <LoginProgressMountComplete role="staff" />
      <CasinoBackground variant="worker" />
      {children}
    </>
  );
}
