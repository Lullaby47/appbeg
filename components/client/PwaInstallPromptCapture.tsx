'use client';

import { useEffect } from 'react';

import { attachGlobalPwaInstallPromptListener } from '@/lib/pwa/installPromptStore';

export default function PwaInstallPromptCapture() {
  useEffect(() => {
    attachGlobalPwaInstallPromptListener();
  }, []);

  return null;
}
