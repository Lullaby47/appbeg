'use client';

import { useEffect } from 'react';
import { usePathname } from 'next/navigation';

import { logClientFirestoreRuntimeAudit } from '@/lib/client/sqlReadMode';

export default function ClientFirestoreRuntimeAudit() {
  const pathname = usePathname();

  useEffect(() => {
    logClientFirestoreRuntimeAudit(pathname || '');
  }, [pathname]);

  return null;
}
