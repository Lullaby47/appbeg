import type { Metadata } from 'next';

import InstallPageClient from './InstallPageClient';

export const metadata: Metadata = {
  title: 'Install Royal VIP',
  description: 'Add Royal VIP to your phone for faster access.',
};

export default function InstallPage() {
  return <InstallPageClient />;
}
