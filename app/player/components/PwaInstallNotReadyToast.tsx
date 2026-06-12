'use client';

import { AnimatePresence, motion } from 'motion/react';

import { PWA_INSTALL_NOT_READY_MESSAGE } from '../hooks/usePwaInstall';

type PwaInstallNotReadyToastProps = {
  open: boolean;
  onDismiss: () => void;
};

export default function PwaInstallNotReadyToast({
  open,
  onDismiss,
}: PwaInstallNotReadyToastProps) {
  return (
    <AnimatePresence>
      {open ? (
        <motion.div
          role="status"
          aria-live="polite"
          initial={{ opacity: 0, y: 16, scale: 0.96 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 16, scale: 0.96 }}
          transition={{ duration: 0.18 }}
          className="pointer-events-auto fixed bottom-[calc(6.5rem+env(safe-area-inset-bottom))] left-1/2 z-[130] w-[min(calc(100vw-2rem),22rem)] -translate-x-1/2 rounded-2xl border border-amber-400/45 bg-amber-950/95 px-4 py-3 text-center text-sm font-bold text-amber-50 shadow-lg shadow-black/40 backdrop-blur-md"
        >
          <p>{PWA_INSTALL_NOT_READY_MESSAGE}</p>
          <button
            type="button"
            onClick={onDismiss}
            className="mt-2 text-xs font-black uppercase tracking-wide text-amber-300/90"
          >
            Dismiss
          </button>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
