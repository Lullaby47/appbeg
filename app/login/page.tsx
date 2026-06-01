'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { onAuthStateChanged } from 'firebase/auth';
import { signInWithEmailAndPassword, signOut } from 'firebase/auth';
import {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  where,
} from 'firebase/firestore';

import { auth, db } from '@/lib/firebase/client';
import { DASHBOARD_BY_ROLE, isValidRole } from '@/lib/auth/roles';
import {
  getLocalPlayerSessionId,
  PLAYER_REPLACED_LOGIN_MESSAGE,
  startPlayerSession,
} from '@/features/auth/playerSession';

export default function LoginPage() {
  const router = useRouter();

  const [adminExists, setAdminExists] = useState<boolean | null>(null);

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');

  const [error, setError] = useState(() => {
    if (typeof window === 'undefined') {
      return '';
    }
    const params = new URLSearchParams(window.location.search);
    const message = params.get('message');
    const reason = params.get('reason');
    return message === 'another-device' || reason === 'session_replaced'
      ? PLAYER_REPLACED_LOGIN_MESSAGE
      : '';
  });
  const [loading, setLoading] = useState(false);
  const loginInProgressRef = useRef(false);

  useEffect(() => {
    async function checkAdminExists() {
      try {
        const adminQuery = query(
          collection(db, 'users'),
          where('role', '==', 'admin')
        );

        const snapshot = await getDocs(adminQuery);
        setAdminExists(!snapshot.empty);
      } catch (err) {
        console.error(err);
        setError('Failed to check admin status.');
        setAdminExists(true);
      }
    }

    checkAdminExists();
  }, []);

  // If the user is already signed in, send them to their app — so the browser
  // "back" key does not look like a confusing pseudo-logout on /login.
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      if (loginInProgressRef.current) {
        return;
      }

      if (!user) {
        return;
      }

      try {
        const userSnap = await getDoc(doc(db, 'users', user.uid));
        if (!userSnap.exists()) {
          return;
        }

        const role = (userSnap.data() as { role?: string }).role;
        if (role && isValidRole(role)) {
          if (role === 'player' && !getLocalPlayerSessionId()) {
            console.info('[PLAYER_LOGIN_SESSION] login-page redirect blocked', {
              uid: user.uid,
              reason: 'missing_local_session_id',
            });
            await signOut(auth);
            return;
          }
          console.info('[PLAYER_LOGIN_SESSION] login-page redirect allowed', {
            uid: user.uid,
            role,
            reason: 'existing_authenticated_user',
          });
          router.replace(DASHBOARD_BY_ROLE[role]);
        }
      } catch {
        // ignore; user can still use the form
      }
    });

    return () => unsubscribe();
  }, [router]);

  async function handleLogin(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();

    const cleanUsername = username.trim().toLowerCase();

    if (!cleanUsername) {
      setError('Username is required.');
      return;
    }

    setError('');
    setLoading(true);
    loginInProgressRef.current = true;

    try {
      const userQuery = query(
        collection(db, 'users'),
        where('username', '==', cleanUsername)
      );

      const userSnapshot = await getDocs(userQuery);

      if (userSnapshot.empty) {
        throw new Error('User not found.');
      }

      const userDoc = userSnapshot.docs[0];
      const userData = userDoc.data();

      const userRole = String(userData.role || '');
      const isActive = userData.status === 'active';
      const isBlockedPlayer = userData.status === 'disabled' && userRole === 'player';
      if (!isActive && !isBlockedPlayer) {
        throw new Error('Account is not active.');
      }

      const hiddenEmail = userData.email;

      const credential = await signInWithEmailAndPassword(auth, hiddenEmail, password);

      const role = userData.role;

      if (!isValidRole(role)) {
        throw new Error('Invalid role.');
      }

      if (role === 'player') {
        const { sessionId } = await startPlayerSession(credential.user);
        console.info('[PLAYER_LOGIN_SESSION] player login allowed after session write', {
          uid: credential.user.uid,
          sessionId,
          reason: 'active_session_saved',
        });
      }

      router.push(DASHBOARD_BY_ROLE[role]);
    } catch (err) {
      console.error(err);
      setError('Invalid username or password.');
    } finally {
      loginInProgressRef.current = false;
      setLoading(false);
    }
  }

  if (adminExists === null) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-gradient-to-br from-slate-50 via-white to-blue-50/30 px-4">
        <div className="w-full max-w-sm animate-pulse rounded-2xl bg-white/80 p-6 text-center shadow-xl shadow-blue-500/5 backdrop-blur-sm">
          <div className="mx-auto mb-3 h-8 w-8 rounded-full bg-blue-100" />
          <p className="text-sm font-medium text-slate-500">Loading secure access...</p>
        </div>
      </main>
    );
  }

  return (
    <main className="relative flex min-h-screen items-center justify-center overflow-hidden bg-gradient-to-br from-slate-50 via-white to-blue-50/40 px-4 py-8">
      {/* Premium background shine effect */}
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute -left-32 -top-32 h-64 w-64 rounded-full bg-blue-100/40 blur-3xl" />
        <div className="absolute -bottom-40 right-0 h-80 w-80 rounded-full bg-amber-100/30 blur-3xl" />
        <div className="absolute left-1/2 top-1/2 h-96 w-96 -translate-x-1/2 -translate-y-1/2 rounded-full bg-gradient-to-r from-blue-50/20 via-white to-amber-50/20 blur-3xl" />
      </div>

      <div className="relative w-full max-w-md">
        {/* Premium badge - subtle casino touch */}
        <div className="mb-2 flex justify-center">
          <div className="inline-flex items-center gap-1.5 rounded-full bg-white/70 px-3 py-1 shadow-sm ring-1 ring-amber-200/50 backdrop-blur-sm">
            <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
            <span className="text-[11px] font-semibold uppercase tracking-wider text-amber-600/80">
              Premium Access
            </span>
            <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
          </div>
        </div>

        <div className="overflow-hidden rounded-3xl bg-white/90 shadow-2xl shadow-blue-500/10 backdrop-blur-sm transition-all duration-300 ring-1 ring-white/50">
          {/* Subtle gold top border accent */}
          <div className="h-1 w-full bg-gradient-to-r from-blue-500 via-amber-400/60 to-blue-500" />

          <div className="p-6 sm:p-8">
            {!adminExists ? (
              <>
                <div className="mb-8 text-center">
                  <h1 className="text-3xl font-bold tracking-tight text-slate-800">
                    Admin Setup Disabled
                  </h1>
                  <p className="mt-2 text-sm text-slate-500">
                    Admin setup is disabled in the browser. Please use the local admin setup tool.
                  </p>
                </div>

                {/* Admin bootstrap must be done by local Firebase Admin SDK tool, not browser. */}
              </>
            ) : (
              <>
                <div className="mb-8 text-center">
                  <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-gradient-to-br from-blue-500 to-blue-600 shadow-md">
                    <span className="text-xl font-bold text-white">A</span>
                  </div>
                  <h1 className="text-3xl font-bold tracking-tight text-slate-800">
                    Welcome Back
                  </h1>
                  <p className="mt-2 text-sm text-slate-500">
                    Sign in to your account
                  </p>
                </div>

                <form onSubmit={handleLogin} className="space-y-5">
                  <div>
                    <input
                      id="login-username"
                      name="username"
                      value={username}
                      onChange={(e) => setUsername(e.target.value)}
                      required
                      placeholder="Username"
                      autoComplete="username"
                      className="h-14 w-full rounded-xl border border-slate-200 bg-white/80 px-4 text-base text-slate-800 outline-none transition-all duration-200 placeholder:text-slate-400 focus:border-blue-400 focus:bg-white focus:ring-2 focus:ring-blue-200/80"
                    />
                  </div>

                  <div>
                    <input
                      id="login-password"
                      name="password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      type="password"
                      required
                      minLength={6}
                      placeholder="Password"
                      autoComplete="current-password"
                      className="h-14 w-full rounded-xl border border-slate-200 bg-white/80 px-4 text-base text-slate-800 outline-none transition-all duration-200 placeholder:text-slate-400 focus:border-blue-400 focus:bg-white focus:ring-2 focus:ring-blue-200/80"
                    />
                  </div>

                  {error && (
                    <div className="animate-in fade-in slide-in-from-top-2 duration-300 rounded-xl border border-red-200 bg-red-50/80 p-3 text-sm font-medium text-red-600 backdrop-blur-sm">
                      {error}
                    </div>
                  )}

                  <button
                    disabled={loading}
                    className="group relative h-12 w-full overflow-hidden rounded-xl bg-gradient-to-r from-blue-600 to-blue-500 font-semibold text-white shadow-md shadow-blue-500/25 transition-all duration-200 hover:shadow-lg hover:shadow-blue-500/30 active:scale-[0.98] disabled:opacity-60 disabled:hover:scale-100"
                  >
                    <span className="relative z-10">
                      {loading ? 'Signing in...' : 'Login'}
                    </span>
                    <div className="absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-white/20 to-transparent transition-transform duration-500 group-hover:translate-x-full" />
                  </button>

                </form>
              </>
            )}
          </div>
        </div>

        {/* Subtle footer note - premium touch */}
        <p className="mt-6 text-center text-[11px] font-medium text-slate-400/80">
          Secure • Encrypted • Protected
        </p>
      </div>
    </main>
  );
}
