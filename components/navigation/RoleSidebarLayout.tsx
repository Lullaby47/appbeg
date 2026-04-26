'use client';

import { useState, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';

export type NavigationItem = {
  label: string;
  view: string;
  unread?: number;
  tone?: 'default' | 'danger';
  onClick?: () => void;
};

type RoleSidebarLayoutProps = {
  title: string;
  subtitle?: string;
  activeView: string;
  items: NavigationItem[];
  children: ReactNode;
  footer: ReactNode;
};

function navButtonClass(isActive: boolean, tone: NavigationItem['tone']) {
  if (isActive) {
    return 'bg-white text-black';
  }

  if (tone === 'danger') {
    return 'bg-red-500/10 text-red-100 hover:bg-red-500/20';
  }

  return 'bg-white/5 text-neutral-300 hover:bg-white/10';
}

export default function RoleSidebarLayout({
  title,
  subtitle,
  activeView,
  items,
  children,
  footer,
}: RoleSidebarLayoutProps) {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const activeItem = items.find((item) => item.view === activeView);

  const renderNav = (mobile = false) => (
    <nav className={mobile ? 'space-y-2' : 'space-y-2'}>
      {items.map((item) => {
        const count = item.unread || 0;

        return (
          <button
            key={item.view}
            type="button"
            onClick={() => {
              item.onClick?.();
              setMobileMenuOpen(false);
            }}
            className={`flex min-h-[44px] w-full items-center justify-between rounded-2xl px-4 py-3 text-left text-sm transition ${navButtonClass(
              activeView === item.view,
              item.tone
            )}`}
          >
            <span>{item.label}</span>
            {count > 0 && (
              <span className="rounded-full bg-red-500 px-2 py-0.5 text-xs font-bold text-white">
                {count > 99 ? '99+' : count}
              </span>
            )}
          </button>
        );
      })}
    </nav>
  );

  return (
    <main className="flex min-h-[100dvh] flex-col overflow-x-hidden bg-neutral-950 text-white lg:flex-row">
      <header className="sticky top-0 z-30 border-b border-white/10 bg-neutral-950/95 px-4 py-3 backdrop-blur lg:hidden">
        <div className="flex items-center justify-between gap-3">
          <button
            type="button"
            onClick={() => setMobileMenuOpen(true)}
            className="min-h-[44px] rounded-xl border border-white/15 bg-white/5 px-4 text-sm font-semibold text-white"
            aria-label={`Open ${title} menu`}
          >
            Menu
          </button>
          <div className="min-w-0 flex-1 text-center">
            <p className="truncate text-sm font-bold">{title}</p>
            <p className="truncate text-xs text-neutral-400">
              {activeItem?.label || subtitle || 'Navigation'}
            </p>
          </div>
          <div className="w-[76px] shrink-0 text-right text-[11px] text-neutral-500">
            {subtitle || ''}
          </div>
        </div>
      </header>

      <AnimatePresence>
        {mobileMenuOpen ? (
          <>
            <motion.button
              type="button"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 z-40 bg-black/70 backdrop-blur-sm lg:hidden"
              aria-label="Close menu"
              onClick={() => setMobileMenuOpen(false)}
            />
            <motion.aside
              initial={{ x: '-105%' }}
              animate={{ x: 0 }}
              exit={{ x: '-105%' }}
              transition={{ type: 'spring', damping: 26, stiffness: 280 }}
              className="fixed bottom-0 left-0 top-0 z-50 flex w-[min(22rem,88vw)] flex-col overflow-y-auto border-r border-white/10 bg-neutral-950 p-4 shadow-2xl lg:hidden"
            >
              <div className="mb-6 rounded-2xl border border-white/10 bg-white/5 p-4">
                <h1 className="text-xl font-bold text-white">{title}</h1>
                {subtitle ? <p className="mt-1 text-sm text-neutral-400">{subtitle}</p> : null}
              </div>
              <div className="flex-1">{renderNav(true)}</div>
              <div className="mt-6 border-t border-white/10 pt-4">{footer}</div>
            </motion.aside>
          </>
        ) : null}
      </AnimatePresence>

      <aside className="hidden w-72 shrink-0 border-r border-white/10 bg-neutral-900/60 p-4 lg:block">
        <h1 className="mb-2 text-xl font-bold lg:text-2xl">{title}</h1>
        {subtitle ? <p className="mb-4 text-sm text-neutral-400 lg:mb-6">{subtitle}</p> : null}
        {renderNav()}
        <div className="mt-8">{footer}</div>
      </aside>

      <section className="min-w-0 flex-1 overflow-y-auto overflow-x-hidden p-4 md:p-6">
        {children}
      </section>
    </main>
  );
}
