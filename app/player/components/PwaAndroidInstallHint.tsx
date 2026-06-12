'use client';

import { AnimatePresence, motion } from 'motion/react';

import {
  PLAYER_SPLASH_BACKDROP_CENTER,
  PLAYER_SPLASH_CARD,
} from '../constants';

type PwaAndroidInstallHintProps = {
  open: boolean;
  onClose: () => void;
};

export default function PwaAndroidInstallHint({
  open,
  onClose,
}: PwaAndroidInstallHintProps) {
  return (
    <AnimatePresence>
      {open ? (
        <>
          <motion.button
            type="button"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            aria-label="Close install hint"
            className={`${PLAYER_SPLASH_BACKDROP_CENTER} z-[120]`}
            onClick={onClose}
          />
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-labelledby="pwa-android-install-title"
            initial={{ opacity: 0, scale: 0.96, y: 12 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 12 }}
            transition={{ type: 'spring', damping: 24, stiffness: 280 }}
            className={`${PLAYER_SPLASH_CARD} fixed left-1/2 top-1/2 z-[121] w-[min(calc(100vw-2rem),28rem)] -translate-x-1/2 -translate-y-1/2`}
          >
            <h2
              id="pwa-android-install-title"
              className="text-center text-xl font-black text-amber-100"
            >
              Install Royal VIP
            </h2>
            <p className="mt-2 text-center text-sm text-amber-100/70">
              Add this app to your home screen for quick access.
            </p>
            <ol className="mt-5 space-y-4 text-sm text-amber-50/90">
              <li className="rounded-2xl border border-amber-400/20 bg-black/35 px-4 py-3">
                <span className="font-black text-amber-300">Step 1:</span> Tap
                the Chrome menu ⋮
              </li>
              <li className="rounded-2xl border border-amber-400/20 bg-black/35 px-4 py-3">
                <span className="font-black text-amber-300">Step 2:</span> Tap
                &quot;Add to Home screen&quot; or &quot;Install app&quot;
              </li>
              <li className="rounded-2xl border border-amber-400/20 bg-black/35 px-4 py-3">
                <span className="font-black text-amber-300">Step 3:</span> Tap
                &quot;Install&quot; or &quot;Add&quot;
              </li>
            </ol>
            <button
              type="button"
              onClick={onClose}
              className="mt-6 w-full rounded-2xl border border-amber-400/35 bg-amber-500/15 py-3 text-sm font-black text-amber-100 transition hover:bg-amber-500/25"
            >
              Got it
            </button>
          </motion.div>
        </>
      ) : null}
    </AnimatePresence>
  );
}
