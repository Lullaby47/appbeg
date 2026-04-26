'use client';

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
    <aside className="w-72 border-r border-white/10 bg-neutral-900/60 p-4">
      <h1 className="mb-6 text-2xl font-bold">Admin Panel</h1>

      <nav className="space-y-2">
        {menuItems.map((item) => (
          <button
            key={item.view}
            onClick={() => onChangeView(item.view)}
            className={`w-full rounded-2xl px-4 py-3 text-left text-sm ${
              activeView === item.view
                ? 'bg-white text-black'
                : 'bg-white/5 text-neutral-300 hover:bg-white/10'
            }`}
          >
            {item.label}
          </button>
        ))}
      </nav>
    </aside>
  );
}