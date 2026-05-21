'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { onAuthStateChanged } from 'firebase/auth';
import { doc, getDoc } from 'firebase/firestore';

import { auth, db } from '@/lib/firebase/client';
import { UserRole } from '@/lib/auth/roles';
import { recordDevActiveSession } from '@/features/dev/devUsageEstimates';
import UserPresenceSync from '@/components/presence/UserPresenceSync';
import IdleLogoutSync from '@/components/auth/IdleLogoutSync';
import {
  endLocalPlayerSession,
  forcePlayerSessionLogout,
  getLocalPlayerSessionId,
  isPlayerForcedLogout,
  listenForPlayerSessionReplacement,
  touchPlayerSession,
} from '@/features/auth/playerSession';

type ProtectedRouteProps = {
  allowedRoles: UserRole[];
  children: React.ReactNode;
};

export default function ProtectedRoute({
  allowedRoles,
  children,
}: ProtectedRouteProps) {
  const router = useRouter();
  const [checking, setChecking] = useState(true);
  const [currentRole, setCurrentRole] = useState<UserRole | null>(null);
  const [forcedLogout, setForcedLogout] = useState(false);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
      if (forcedLogout || isPlayerForcedLogout()) {
        setCurrentRole(null);
        setChecking(false);
        return;
      }

      if (!firebaseUser) {
        setCurrentRole(null);
        router.replace('/login');
        return;
      }

      const userRef = doc(db, 'users', firebaseUser.uid);
      const userSnap = await getDoc(userRef);

      if (!userSnap.exists()) {
        setCurrentRole(null);
        router.replace('/login');
        return;
      }

      const userData = userSnap.data();
      const role = userData.role as UserRole;

      if (!allowedRoles.includes(role)) {
        setCurrentRole(null);
        router.replace('/login');
        return;
      }

      const localPlayerSessionId = role === 'player' ? getLocalPlayerSessionId() : '';
      const activePlayerSessionId = String(userData.activeSessionId || '').trim();
      if (
        role === 'player' &&
        (!localPlayerSessionId || localPlayerSessionId !== activePlayerSessionId)
      ) {
        if (localPlayerSessionId && activePlayerSessionId) {
          console.info('[SESSION_GUARD] mismatch detected');
        }
        console.info('[SESSION_GUARD] protected render blocked');
        setCurrentRole(null);
        setForcedLogout(true);
        setChecking(false);
        void forcePlayerSessionLogout({
          redirect: (url) => router.replace(url),
          markSessionInactive: false,
        });
        return;
      }

      setCurrentRole(role);

      if (role === 'player' || role === 'carer') {
        recordDevActiveSession(role, firebaseUser.uid);
      }

      setChecking(false);
    });

    return () => unsubscribe();
  }, [allowedRoles, forcedLogout, router]);

  useEffect(() => {
    if (currentRole !== 'player') {
      return;
    }

    const currentUser = auth.currentUser;
    if (!currentUser) {
      return;
    }

    let stopSessionListener = () => {};
    const triggerForcedLogout = () => {
      setForcedLogout(true);
      setCurrentRole(null);
      stopSessionListener();
      void forcePlayerSessionLogout({
        redirect: (url) => router.replace(url),
      });
    };
    stopSessionListener = listenForPlayerSessionReplacement(currentUser, triggerForcedLogout);
    void touchPlayerSession(currentUser);
    const heartbeat = window.setInterval(() => {
      void touchPlayerSession(currentUser);
    }, 45_000);
    const markInactive = () => {
      void endLocalPlayerSession('browser_closed');
    };
    window.addEventListener('pagehide', markInactive);
    window.addEventListener('beforeunload', markInactive);

    return () => {
      stopSessionListener();
      window.clearInterval(heartbeat);
      window.removeEventListener('pagehide', markInactive);
      window.removeEventListener('beforeunload', markInactive);
    };
  }, [currentRole, router]);

  if (forcedLogout || isPlayerForcedLogout()) {
    console.info('[SESSION_GUARD] protected render blocked');
    return (
      <main className="flex min-h-screen items-center justify-center bg-neutral-950 text-white">
        <p className="text-sm text-neutral-400">Signing out...</p>
      </main>
    );
  }

  if (checking) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-neutral-950 text-white">
        <p className="text-sm text-neutral-400">Checking access...</p>
      </main>
    );
  }

  return (
    <>
      <UserPresenceSync />
      {currentRole !== 'player' && currentRole !== 'carer' ? <IdleLogoutSync /> : null}
      {children}
    </>
  );
}
