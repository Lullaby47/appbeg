'use client';

import LogoutButton from '@/components/auth/LogoutButton';

import { AdminView } from './types';

const menuItems: { label: string; view: AdminView }[] = [
  { label: 'Dashboard', view: 'dashboard' },
  { label: 'Create Co-admin', view: 'create-coadmin' },
  { label: 'View Co-admins', view: 'view-coadmins' },
  { label: 'Add Staff', view: 'add-staff' },
  { label: 'View Staff', view: 'view-staff' },
  { label: 'Players', view: 'players' },
  { label: 'Reach Out', view: 'reach-out' },
];

interface Props {
  activeView: AdminView;
  onChangeView: (view: AdminView) => void;
}

export default function AdminSidebar({ activeView, onChangeView }: Props) {
  return (
    <aside className="w-full shrink-0 border-b border-white/10 bg-neutral-900/60 p-4 lg:w-72 lg:border-b-0 lg:border-r">
      <h1 className="mb-4 text-xl font-bold lg:mb-6 lg:text-2xl">Admin Panel</h1>

      <nav className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1 lg:mx-0 lg:block lg:space-y-2 lg:overflow-visible lg:px-0 lg:pb-0">
        {menuItems.map((item) => (
          <button
            key={item.view}
            onClick={() => onChangeView(item.view)}
            className={`min-h-[44px] shrink-0 rounded-2xl px-4 py-3 text-left text-sm lg:w-full ${
              activeView === item.view
                ? 'bg-white text-black'
                : 'bg-white/5 text-neutral-300 hover:bg-white/10'
            }`}
          >
            {item.label}
          </button>
        ))}
      </nav>

      <div className="mt-4 lg:mt-8">
        <LogoutButton />
      </div>
    </aside>
  );
}