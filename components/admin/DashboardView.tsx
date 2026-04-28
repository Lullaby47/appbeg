'use client';

import DevFirebaseUsageCard from '@/components/admin/DevFirebaseUsageCard';

interface Props {
  coadminCount: number;
  staffCount: number;
  unreadCount?: number;
}

export default function DashboardView({
  coadminCount,
  staffCount,
  unreadCount = 0,
}: Props) {
  return (
    <div>
      <h2 className="text-3xl font-bold mb-4">Dashboard</h2>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="rounded-2xl border border-white/10 bg-white/5 p-6">
          <p className="text-sm text-neutral-400">Total Co-admins</p>
          <p className="text-3xl font-bold mt-2">{coadminCount}</p>
        </div>

        <div className="rounded-2xl border border-white/10 bg-white/5 p-6">
          <p className="text-sm text-neutral-400">Total Staff</p>
          <p className="text-3xl font-bold mt-2">{staffCount}</p>
        </div>

        <div
          className={`rounded-2xl border p-6 ${
            unreadCount > 0
              ? 'border-red-500/40 bg-red-500/10'
              : 'border-white/10 bg-white/5'
          }`}
        >
          <p className="text-sm text-neutral-400">Unread Messages</p>

          <div className="mt-2 flex items-center gap-3">
            <p className="text-3xl font-bold">{unreadCount}</p>

            {unreadCount > 0 && (
              <span className="rounded-full bg-red-500 px-2.5 py-1 text-xs font-bold text-white">
                New
              </span>
            )}
          </div>
        </div>
      </div>

      <div className="mt-8">
        <DevFirebaseUsageCard />
      </div>
    </div>
  );
}