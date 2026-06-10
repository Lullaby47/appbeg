'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { onAuthStateChanged } from 'firebase/auth';
import { doc, getDoc } from 'firebase/firestore';

import { auth, db } from '@/lib/firebase/client';
import { DASHBOARD_BY_ROLE, isValidRole, UserRole } from '@/lib/auth/roles';
import { getLocalAppSessionId } from '@/features/auth/appSession';
import { discardStalePlayerSessionIdForRole } from '@/features/auth/playerSession';
import { getCachedSessionUser, getSessionUserOnce } from '@/features/auth/sessionUser';
import { recordDevActiveSession } from '@/features/dev/devUsageEstimates';
import UserPresenceSync from '@/components/presence/UserPresenceSync';
import IdleLogoutSync from '@/components/auth/IdleLogoutSync';
import {
  currentClientPath,
  logProtectedRouteDecision,
} from '@/lib/client/protectedRouteLog';
import {
  logChatLogoutTrigger,
  shouldProtectPlayerChatSession,
} from '@/lib/client/chatLogoutDiagnostics';
import { shouldLogoutAfterInvalidPlayerSessionStatus } from '@/lib/client/playerSessionInvalidGuard';
import { markPlayerClientRouteNavigation } from '@/lib/client/playerSessionNavigationGuard';
import {
  endLocalPlayerSessionOnBrowserLeave,
  forcePlayerSessionLogout,
  getLocalPlayerSessionId,
  isPlayerForcedLogout,
  isPlayerSessionReady,
  isSqlPlayerAppSessionMode,
  listenForPlayerSessionReplacement,
  startPlayerSessionStatusPolling,
  touchPlayerSession,
  seedPlayerSessionVerifyCache,
  verifyActivePlayerSession,
  waitForPlayerSessionReady,
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

function redirectToLogin(
  router: ReturnType<typeof useRouter>,
  values: {
    file: string;
    function: string;
    reason: string;
    trigger: string;
    uid?: string | null;
    role?: string | null;
  }
) {
  if (shouldProtectPlayerChatSession()) {
    logChatLogoutTrigger({
      file: values.file,
      function: values.function,
      reason: `deferred_${values.reason}`,
      trigger: values.trigger,
      uid: values.uid ?? null,
      role: values.role ?? null,
    });
    return false;
  }

  logChatLogoutTrigger({
    file: values.file,
    function: values.function,
    reason: values.reason,
    trigger: values.trigger,
    uid: values.uid ?? null,
    role: values.role ?? null,
  });
  router.replace('/login');
  return true;
}

function redirectRoleMismatch(
  router: ReturnType<typeof useRouter>,
  sessionUser: { uid: string; role: UserRole },
  allowedRoles: UserRole[],
  reason: string
): 'denied' {
  const redirectTo = DASHBOARD_BY_ROLE[sessionUser.role];
  logProtectedRouteDecision({
    path: currentClientPath(),
    uid: sessionUser.uid,
    role: sessionUser.role,
    allowedRoles,
    decision: 'redirect',
    redirectTo,
    reason,
  });
  router.replace(redirectTo);
  return 'denied';
}

export default function ProtectedRoute({
  allowedRoles,
  children,
}: ProtectedRouteProps) {
  const router = useRouter();
  const pathname = usePathname();
  const pathnameRef = useRef(pathname);
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

      try {
        await waitForPlayerSessionReady();
      } catch {
        console.info('[PROTECTED_ROUTE_AUTH]', {
          source: 'player_app_session',
          ok: false,
          reason: 'player_session_wait_timeout',
          hasAppSessionId: Boolean(getLocalAppSessionId()),
          hasPlayerSessionId: Boolean(getLocalPlayerSessionId()),
        });
      }

      if (!isPlayerSessionReady()) {
        console.info('[PROTECTED_ROUTE_AUTH]', {
          source: 'player_app_session',
          ok: false,
          reason: 'player_session_not_ready',
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
          if (!shouldLogoutAfterInvalidPlayerSessionStatus(sessionStatus.reason)) {
            setCurrentRole('player');
            recordDevActiveSession('player', sessionUser.uid);
            setChecking(false);
            return 'allowed';
          }
          setCurrentRole(null);
          setForcedLogout(true);
          setChecking(false);
          void forcePlayerSessionLogout({
            redirect: (url) => router.replace(url),
            markSessionInactive: true,
            trigger: 'tryPlayerAppSessionGuard',
            sourceFile: 'components/auth/ProtectedRoute.tsx',
            sourceFunction: 'tryPlayerAppSessionGuard',
            reason: sessionStatus.reason,
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
        return redirectRoleMismatch(
          router,
          sessionUser as { uid: string; role: UserRole },
          allowedRoles,
          'role_not_allowed_for_route'
        );
      }

      logProtectedRouteDecision({
        path: currentClientPath(),
        uid: sessionUser.uid,
        role: sessionUser.role,
        allowedRoles,
        decision: 'allow',
        reason: usedCachedSession ? 'cached_app_session' : 'app_session',
      });

      console.info('[PROTECTED_ROUTE_AUTH]', {
        source: usedCachedSession ? 'cached_app_session' : 'app_session',
        ok: true,
        role: sessionUser.role,
        uid: sessionUser.uid,
      });

      setCurrentRole(sessionUser.role);
      if (sessionUser.role !== 'player') {
        discardStalePlayerSessionIdForRole(sessionUser.role, 'protected_route_non_player');
      }
      if (sessionUser.role === 'carer') {
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
          const cachedPlayer = getCachedSessionUser();
          console.info('[PROTECTED_ROUTE_AUTH]', {
            source: 'firebase',
            ok: false,
            reason: 'missing_firebase_user',
            cachedRole: cachedPlayer?.role ?? null,
            path: currentClientPath(),
          });
          if (
            cachedPlayer?.role === 'player' &&
            getLocalAppSessionId() &&
            getLocalPlayerSessionId()
          ) {
            console.info('[PROTECTED_ROUTE_AUTH]', {
              source: 'firebase',
              ok: true,
              uid: cachedPlayer.uid,
              role: 'player',
              reason: 'sql_app_session_without_firebase_user',
            });
            setCurrentRole('player');
            recordDevActiveSession('player', cachedPlayer.uid);
            setChecking(false);
            return;
          }
          setCurrentRole(null);
          redirectToLogin(router, {
            file: 'components/auth/ProtectedRoute.tsx',
            function: 'startFirebaseGuard',
            reason: 'missing_firebase_user',
            trigger: 'onAuthStateChanged',
            uid: cachedPlayer?.uid ?? null,
            role: cachedPlayer?.role ?? null,
          });
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
          redirectToLogin(router, {
            file: 'components/auth/ProtectedRoute.tsx',
            function: 'startFirebaseGuard',
            reason: 'firestore_user_missing',
            trigger: 'onAuthStateChanged',
            uid: firebaseUser.uid,
          });
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
          if (isValidRole(role)) {
            redirectRoleMismatch(
              router,
              { uid: firebaseUser.uid, role },
              allowedRoles,
              'firebase_role_not_allowed_for_route'
            );
          } else {
            logProtectedRouteDecision({
              path: currentClientPath(),
              uid: firebaseUser.uid,
              role,
              allowedRoles,
              decision: 'deny',
              redirectTo: '/login',
              reason: 'invalid_firebase_role',
            });
            redirectToLogin(router, {
              file: 'components/auth/ProtectedRoute.tsx',
              function: 'startFirebaseGuard',
              reason: 'invalid_firebase_role',
              trigger: 'onAuthStateChanged',
              uid: firebaseUser.uid,
              role,
            });
          }
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
              if (!shouldLogoutAfterInvalidPlayerSessionStatus(sessionStatus.reason)) {
                console.info('[SESSION_GUARD] sql_player_transient_verify_failure', {
                  uid: firebaseUser.uid,
                  reason: sessionStatus.reason,
                  consecutiveGuard: true,
                });
                setCurrentRole('player');
                recordDevActiveSession('player', firebaseUser.uid);
                setChecking(false);
                return;
              }
              setCurrentRole(null);
              setForcedLogout(true);
              setChecking(false);
              void forcePlayerSessionLogout({
                redirect: (url) => router.replace(url),
                markSessionInactive: true,
                trigger: 'startFirebaseGuard',
                sourceFile: 'components/auth/ProtectedRoute.tsx',
                sourceFunction: 'startFirebaseGuard',
                reason: sessionStatus.reason,
              });
              return;
            }
            if (sqlPlayerMode) {
              console.info('[SESSION_GUARD] sql_player_transient_verify_failure', {
                uid: firebaseUser.uid,
                reason: sessionStatus.reason,
              });
              setCurrentRole('player');
              recordDevActiveSession('player', firebaseUser.uid);
              setChecking(false);
              return;
            }
            setCurrentRole(null);
            setForcedLogout(true);
            setChecking(false);
            void forcePlayerSessionLogout({
              redirect: (url) => router.replace(url),
              markSessionInactive: false,
              trigger: 'startFirebaseGuard',
              sourceFile: 'components/auth/ProtectedRoute.tsx',
              sourceFunction: 'startFirebaseGuard',
              reason: sessionStatus.reason,
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

        logProtectedRouteDecision({
          path: currentClientPath(),
          uid: firebaseUser.uid,
          role,
          allowedRoles,
          decision: 'allow',
          reason: 'firebase_auth',
        });

        setCurrentRole(role);

        if (role !== 'player') {
          discardStalePlayerSessionIdForRole(role, 'protected_route_non_player');
        }

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

      if (getLocalAppSessionId()) {
        const cachedUser = getCachedSessionUser();
        const sessionUser =
          cachedUser && isValidRole(cachedUser.role)
            ? cachedUser
            : await getSessionUserOnce();
        if (cancelled) {
          return;
        }
        if (sessionUser && isValidRole(sessionUser.role)) {
          if (!allowedRoles.includes(sessionUser.role)) {
            setCurrentRole(null);
            setChecking(false);
            redirectRoleMismatch(
              router,
              sessionUser as { uid: string; role: UserRole },
              allowedRoles,
              'sql_session_role_not_allowed_for_route'
            );
            return;
          }
        }
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

  useLayoutEffect(() => {
    markPlayerClientRouteNavigation(pathname);
    pathnameRef.current = pathname;
  }, [pathname]);

  useEffect(() => {
    if (currentRole !== 'player') {
      return;
    }

    if (!isPlayerSessionReady()) {
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
          trigger: 'listenForPlayerSessionReplacement',
          sourceFile: 'components/auth/ProtectedRoute.tsx',
          sourceFunction: 'playerSessionReplacementListener',
          reason: 'session_replaced',
        });
      });
    }

    void touchPlayerSession(currentUser);
    const heartbeat = window.setInterval(() => {
      void touchPlayerSession(auth.currentUser);
    }, 45_000);
    const mountedAt = Date.now();
    const markInactive = (event: Event) => {
      void endLocalPlayerSessionOnBrowserLeave(event, {
        mountedAt,
        route: pathnameRef.current || currentClientPath(),
      });
    };
    window.addEventListener('pagehide', markInactive);

    return () => {
      stopSessionListener();
      stopPolling();
      window.clearInterval(heartbeat);
      window.removeEventListener('pagehide', markInactive);
    };
  }, [currentRole]);

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
