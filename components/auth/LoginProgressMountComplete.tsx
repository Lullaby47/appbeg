'use client';

import { useEffect } from 'react';

import { completeLoginUiProgress } from '@/lib/client/loginUiProgress';

type LoginProgressMountCompleteProps = {
  role: string;
};

export default function LoginProgressMountComplete({
  role,
}: LoginProgressMountCompleteProps) {
  useEffect(() => {
    completeLoginUiProgress(`dashboard_mounted:${role}`);
  }, [role]);

  return null;
}
