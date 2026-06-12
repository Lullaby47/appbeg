import type { MetadataRoute } from 'next';

import {
  PWA_APP_NAME,
  PWA_BACKGROUND_COLOR,
  PWA_THEME_COLOR,
} from '@/lib/pwa/constants';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: PWA_APP_NAME,
    short_name: PWA_APP_NAME,
    description:
      'Royal VIP Casino — your VIP player lounge for games, bonuses, and rewards.',
    start_url: '/login',
    display: 'standalone',
    scope: '/',
    theme_color: PWA_THEME_COLOR,
    background_color: PWA_BACKGROUND_COLOR,
    icons: [
      {
        src: '/icons/icon-192.png',
        sizes: '192x192',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: '/icons/icon-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: '/icons/icon-512-maskable.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'maskable',
      },
    ],
  };
}
