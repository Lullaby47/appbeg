import type { ReactNode } from 'react';

import LoginProgressMountComplete from '@/components/auth/LoginProgressMountComplete';
import CasinoBackground from '@/components/ui/CasinoBackground';

export default function AdminLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <LoginProgressMountComplete role="admin" />
      <CasinoBackground variant="worker" />
      {children}
    </>
  );
}
