'use client';

import { onAuthStateChanged } from 'firebase/auth';
import { doc, setDoc, serverTimestamp } from 'firebase/firestore';
import { useEffect } from 'react';

import { auth, db } from '@/lib/firebase/client';

const HEARTBEAT_MS = 50_000;

/**
 * Periodically writes `userPresence/{uid}.lastSeenAt` so other users can show online dots.
 * Mount once under a signed-in app shell (e.g. with {@link ProtectedRoute}).
 */
export default function UserPresenceSync() {
  useEffect(() => {
    const cleanups: Array<() => void> = [];

    const unsubscribe = onAuthStateChanged(auth, (user) => {
      for (const c of cleanups) {
        c();
      }
      cleanups.length = 0;

      if (!user) {
        return;
      }

      const ref = doc(db, 'userPresence', user.uid);
      const pulse = () => {
        setDoc(ref, { lastSeenAt: serverTimestamp() }, { merge: true }).catch(
          () => undefined
        );
      };

      pulse();
      const interval = window.setInterval(pulse, HEARTBEAT_MS);
      const onVis = () => {
        if (document.visibilityState === 'visible') {
          pulse();
        }
      };
      document.addEventListener('visibilitychange', onVis);
      const onPageShow = () => pulse();
      window.addEventListener('pageshow', onPageShow);

      cleanups.push(() => {
        window.clearInterval(interval);
        document.removeEventListener('visibilitychange', onVis);
        window.removeEventListener('pageshow', onPageShow);
      });
    });

    return () => {
      for (const c of cleanups) {
        c();
      }
      unsubscribe();
    };
  }, []);

  return null;
}
