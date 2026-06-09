'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { onAuthStateChanged } from 'firebase/auth';
import { doc, getDoc } from 'firebase/firestore';

import { auth, db } from '@/lib/firebase/client';
import { isValidRole, UserRole } from '@/lib/auth/roles';
import { getLocalAppSessionId } from '@/features/auth/appSession';
import { discardStalePlayerSessionIdForRole } from '@/features/auth/playerSession';
import { getCachedSessionUser, getSessionUserOnce } from '@/features/auth/sessionUser';
import { recordDevActiveSession } from '@/features/dev/devUsageEstimates';
import UserPresenceSync from '@/components/presence/UserPresenceSync';
import IdleLogoutSync from '@/components/auth/IdleLogoutSync';
import {
  endLocalPlayerSession,
  forcePlayerSessionLogout,
  getLocalPlayerSessionId,
  isPlayerForcedLogout,
  isSqlPlayerAppSessionMode,
  listenForPlayerSessionReplacement,
  startPlayerSessionStatusPolling,
  touchPlayerSession,
  seedPlayerSessionVerifyCache,
  verifyActivePlayerSession,
} from '@/features/auth/playerSession';

type ProtectedRouteProps = {
  allowedRoles: UserRole[];
  children: React.ReactNode;
};

const SQL_GUARD_ROLES: UserRole[] = ['admin', 'coadmin', 'staff', 'carer'];

function routeSupportsSqlSessionGuard(allowedRoles: UserRole[]) {
  return allowedRoles.some((role) => SQL_GUARD_ROLES.includes(role));
}

function routeIsPlayerOnly(allowedRoles: UserRole[]) {
  return allowedRoles.length === 1 && allowedRoles[0] === 'player';
}

export default function ProtectedRoute({
  allowedRoles,
  children,
}: ProtectedRouteProps) {
  const router = useRouter();
  const [checking, setChecking] = useState(true);
  const [currentRole, setCurrentRole] = useState<UserRole | null>(null);
  const [forcedLogout, setForcedLogout] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let unsubscribeFirebase: (() => void) | undefined;

    async function tryPlayerAppSessionGuard(): Promise<'allowed' | 'fallback' | 'denied'> {
      if (!routeIsPlayerOnly(allowedRoles) || !isSqlPlayerAppSessionMode()) {
        return 'fallback';
      }

      if (!getLocalAppSessionId() || !getLocalPlayerSessionId()) {
        console.info('[PROTECTED_ROUTE_AUTH]', {
          source: 'player_app_session',
          ok: false,
          reason: 'missing_session_ids',
        });
        return 'fallback';
      }

      const cachedUser = getCachedSessionUser();
      const usedCachedSession = Boolean(cachedUser && cachedUser.role === 'player');
      const sessionUser = usedCachedSession
        ? cachedUser
        : await getSessionUserOnce();
      if (cancelled) {
        return 'denied';
      }

      if (!sessionUser || sessionUser.role !== 'player') {
        console.info('[PROTECTED_ROUTE_AUTH]', {
          source: 'player_app_session',
          ok: false,
          reason: 'missing_or_invalid_session',
        });
        return 'fallback';
      }

      const sessionStatus = await verifyActivePlayerSession();
      if (!sessionStatus.ok) {
        if (sessionStatus.reason === 'session_replaced' && sessionStatus.activeSessionId) {
          console.info('[SESSION_GUARD] old device kicked because session mismatch', {
            uid: sessionUser.uid,
            localSessionId: getLocalPlayerSessionId() || null,
            activeSessionId: sessionStatus.activeSessionId,
          });
        }
        console.info('[PROTECTED_ROUTE_AUTH]', {
          source: 'player_app_session',
          ok: false,
          uid: sessionUser.uid,
          reason: sessionStatus.reason,
        });
        if (
          sessionStatus.reason === 'session_replaced' ||
          sessionStatus.reason === 'session_inactive'
        ) {
          setCurrentRole(null);
          setForcedLogout(true);
          setChecking(false);
          void forcePlayerSessionLogout({
            redirect: (url) => router.replace(url),
            markSessionInactive: true,
          });
          return 'denied';
        }
        console.info('[PROTECTED_ROUTE_AUTH]', {
          source: 'player_app_session',
          ok: true,
          uid: sessionUser.uid,
          role: 'player',
          reason: 'transient_verify_failure_allowed',
        });
        setCurrentRole('player');
        recordDevActiveSession('player', sessionUser.uid);
        setChecking(false);
        return 'allowed';
      }

      seedPlayerSessionVerifyCache(sessionStatus);
      console.info('[PROTECTED_ROUTE_AUTH]', {
        source: usedCachedSession ? 'cached_app_session' : 'player_app_session',
        ok: true,
        uid: sessionUser.uid,
        role: 'player',
      });
      setCurrentRole('player');
      recordDevActiveSession('player', sessionUser.uid);
      setChecking(false);
      return 'allowed';
    }

    async function tryAppSessionGuard(): Promise<'allowed' | 'fallback' | 'denied'> {
      if (!routeSupportsSqlSessionGuard(allowedRoles)) {
        return 'fallback';
      }

      const cachedUser = getCachedSessionUser();
      const usedCachedSession = Boolean(cachedUser && isValidRole(cachedUser.role));
      const sessionUser = usedCachedSession
        ? cachedUser
        : await getSessionUserOnce();
      if (cancelled) {
        return 'denied';
      }

      if (!sessionUser || !isValidRole(sessionUser.role)) {
        console.info('[PROTECTED_ROUTE_AUTH]', {
          source: 'app_session',
          ok: false,
          reason: 'missing_or_invalid_session',
        });
        return 'fallback';
      }

      if (!allowedRoles.includes(sessionUser.role)) {
        console.info('[PROTECTED_ROUTE_AUTH]', {
          source: 'app_session',
          ok: false,
          role: sessionUser.role,
          reason: 'role_not_allowed',
        });
        setCurrentRole(null);
        router.replace('/login');
        return 'denied';
      }

      console.info('[PROTECTED_ROUTE_AUTH]', {
        source: usedCachedSession ? 'cached_app_session' : 'app_session',
        ok: true,
        role: sessionUser.role,
        uid: sessionUser.uid,
      });

      setCurrentRole(sessionUser.role);
      if (sessionUser.role === 'carer') {
        discardStalePlayerSessionIdForRole(sessionUser.role, 'protected_route_carer');
        recordDevActiveSession(sessionUser.role, sessionUser.uid);
      }
      setChecking(false);
      return 'allowed';
    }

    function startFirebaseGuard() {
      unsubscribeFirebase = onAuthStateChanged(auth, async (firebaseUser) => {
        if (cancelled) {
          return;
        }

        if (forcedLogout || isPlayerForcedLogout()) {
          setCurrentRole(null);
          setChecking(false);
          return;
        }

        if (!firebaseUser) {
          console.info('[PROTECTED_ROUTE_AUTH]', {
            source: 'firebase',
            ok: false,
            reason: 'missing_firebase_user',
          });
          setCurrentRole(null);
          router.replace('/login');
          return;
        }

        const userRef = doc(db, 'users', firebaseUser.uid);
        const userSnap = await getDoc(userRef);

        if (!userSnap.exists()) {
          console.info('[PROTECTED_ROUTE_AUTH]', {
            source: 'firebase',
            ok: false,
            uid: firebaseUser.uid,
            reason: 'firestore_user_missing',
          });
          setCurrentRole(null);
          router.replace('/login');
          return;
        }

        const userData = userSnap.data();
        const role = userData.role as UserRole;

        if (!allowedRoles.includes(role)) {
          console.info('[PROTECTED_ROUTE_AUTH]', {
            source: 'firebase',
            ok: false,
            uid: firebaseUser.uid,
            role,
            reason: 'role_not_allowed',
          });
          setCurrentRole(null);
          router.replace('/login');
          return;
        }

        if (role === 'player') {
          const sqlPlayerMode = isSqlPlayerAppSessionMode();
          const sessionStatus = await verifyActivePlayerSession();
          if (!sessionStatus.ok) {
            if (sessionStatus.reason === 'session_replaced' && sessionStatus.activeSessionId) {
              console.info('[SESSION_GUARD] old device kicked because session mismatch', {
                uid: firebaseUser.uid,
                localSessionId: getLocalPlayerSessionId() || null,
                activeSessionId: sessionStatus.activeSessionId,
              });
            }
            console.info('[SESSION_GUARD] protected render blocked', {
              uid: firebaseUser.uid,
              reason: sessionStatus.reason,
              activeSessionId: sessionStatus.activeSessionId || null,
              source: sessionStatus.source || null,
              sqlPlayerMode,
            });
            if (
              sessionStatus.reason === 'session_replaced' ||
              sessionStatus.reason === 'session_inactive'
            ) {
              setCurrentRole(null);
              setForcedLogout(true);
              setChecking(false);
              void forcePlayerSessionLogout({
                redirect: (url) => router.replace(url),
                markSessionInactive: true,
              });
              return;
            }
            if (sqlPlayerMode) {
              console.info('[SESSION_GUARD] sql_player_transient_verify_failure', {
                uid: firebaseUser.uid,
                reason: sessionStatus.reason,
              });
              return;
            }
            setCurrentRole(null);
            setForcedLogout(true);
            setChecking(false);
            void forcePlayerSessionLogout({
              redirect: (url) => router.replace(url),
              markSessionInactive: false,
            });
            return;
          }

          seedPlayerSessionVerifyCache(sessionStatus);
          console.info('[SESSION_GUARD] protected render allowed', {
            uid: firebaseUser.uid,
            reason: 'session_match',
            source: sessionStatus.source || 'sql',
          });
        }

        console.info('[PROTECTED_ROUTE_AUTH]', {
          source: 'firebase',
          ok: true,
          uid: firebaseUser.uid,
          role,
        });

        setCurrentRole(role);

        if (role === 'player' || role === 'carer') {
          recordDevActiveSession(role, firebaseUser.uid);
        }

        setChecking(false);
      });
    }

    void (async () => {
      if (forcedLogout || isPlayerForcedLogout()) {
        setCurrentRole(null);
        setChecking(false);
        return;
      }

      const playerSqlResult = await tryPlayerAppSessionGuard();
      if (cancelled || playerSqlResult === 'allowed' || playerSqlResult === 'denied') {
        return;
      }

      const sqlResult = await tryAppSessionGuard();
      if (cancelled || sqlResult === 'allowed' || sqlResult === 'denied') {
        return;
      }

      startFirebaseGuard();
    })();

    return () => {
      cancelled = true;
      unsubscribeFirebase?.();
    };
  }, [allowedRoles, forcedLogout]);

  useEffect(() => {
    if (currentRole !== 'player') {
      return;
    }

    const sessionId = getLocalPlayerSessionId();
    if (!sessionId) {
      return;
    }

    const currentUser = auth.currentUser;
    let stopSessionListener = () => {};

    const handlePollKick = () => {
      setForcedLogout(true);
      setCurrentRole(null);
      stopSessionListener();
    };

    const stopPolling = startPlayerSessionStatusPolling({
      intervalMs: 12_000,
      redirect: (url) => router.replace(url),
      onReplaced: handlePollKick,
      onInactive: handlePollKick,
    });

    const sqlPlayerAppSession = isSqlPlayerAppSessionMode();

    if (currentUser && !sqlPlayerAppSession) {
      stopSessionListener = listenForPlayerSessionReplacement(currentUser, () => {
        setForcedLogout(true);
        setCurrentRole(null);
        stopSessionListener();
        stopPolling();
        void forcePlayerSessionLogout({
          redirect: (url) => router.replace(url),
        });
      });
    }

    void touchPlayerSession(currentUser);
    const heartbeat = window.setInterval(() => {
      void touchPlayerSession(auth.currentUser);
    }, 45_000);
    const mountedAt = Date.now();
    const markInactive = () => {
      if (Date.now() - mountedAt < 30_000) {
        console.info('[PLAYER_SESSION_LOCAL] skip_end_during_boot_window');
        return;
      }
      void endLocalPlayerSession('browser_closed');
    };
    window.addEventListener('pagehide', markInactive);
    window.addEventListener('beforeunload', markInactive);

    return () => {
      stopSessionListener();
      stopPolling();
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
