'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
} from 'firebase/auth';
import {
  collection,
  doc,
  getDocs,
  query,
  serverTimestamp,
  setDoc,
  where,
} from 'firebase/firestore';

import { auth, db } from '@/lib/firebase/client';
import { DASHBOARD_BY_ROLE, isValidRole } from '@/lib/auth/roles';

export default function LoginPage() {
  const router = useRouter();

  const [adminExists, setAdminExists] = useState<boolean | null>(null);

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');

  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

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

  function makeHiddenEmailFromUsername(value: string) {
    const cleanUsername = value.trim().toLowerCase();
    return `${cleanUsername}@app.local`;
  }

  async function handleCreateAdmin(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();

    const cleanUsername = username.trim().toLowerCase();

    if (!cleanUsername) {
      setError('Username is required.');
      return;
    }

    if (password.length < 6) {
      setError('Password must be at least 6 characters.');
      return;
    }

    setError('');
    setLoading(true);

    try {
      const adminQuery = query(
        collection(db, 'users'),
        where('role', '==', 'admin')
      );

      const adminSnapshot = await getDocs(adminQuery);

      if (!adminSnapshot.empty) {
        setAdminExists(true);
        throw new Error('Admin already exists.');
      }

      const usernameQuery = query(
        collection(db, 'users'),
        where('username', '==', cleanUsername)
      );

      const usernameSnapshot = await getDocs(usernameQuery);

      if (!usernameSnapshot.empty) {
        throw new Error('Username already exists.');
      }

      const hiddenEmail = makeHiddenEmailFromUsername(cleanUsername);

      const result = await createUserWithEmailAndPassword(
        auth,
        hiddenEmail,
        password
      );

      await setDoc(doc(db, 'users', result.user.uid), {
        uid: result.user.uid,
        username: cleanUsername,
        email: hiddenEmail,
        role: 'admin',
        createdBy: null,
        createdAt: serverTimestamp(),
        status: 'active',
      });

      router.push('/admin');
    } catch (err) {
      console.error(err);
      setError('Failed to create admin.');
    } finally {
      setLoading(false);
    }
  }

  async function handleLogin(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();

    const cleanUsername = username.trim().toLowerCase();

    if (!cleanUsername) {
      setError('Username is required.');
      return;
    }

    setError('');
    setLoading(true);

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

      if (userData.status !== 'active') {
        throw new Error('Account is not active.');
      }

      const hiddenEmail = userData.email;

      await signInWithEmailAndPassword(auth, hiddenEmail, password);

      const role = userData.role;

      if (!isValidRole(role)) {
        throw new Error('Invalid role.');
      }

      router.push(DASHBOARD_BY_ROLE[role]);
    } catch (err) {
      console.error(err);
      setError('Invalid username or password.');
    } finally {
      setLoading(false);
    }
  }

  if (adminExists === null) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-gradient-to-b from-[#f6f9ff] via-[#eef3ff] to-[#f8f9fb] px-4">
        <div className="w-full max-w-sm rounded-3xl border border-white/80 bg-white/90 p-8 text-center shadow-[0_18px_50px_rgba(24,119,242,0.14)] backdrop-blur">
          <p className="text-sm font-medium text-slate-600">Loading...</p>
        </div>
      </main>
    );
  }

  return (
    <main className="relative min-h-screen overflow-hidden bg-gradient-to-b from-[#f6f9ff] via-[#eef3ff] to-[#f8f9fb] px-4 py-8 text-slate-900">
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute -top-20 left-1/2 h-56 w-56 -translate-x-1/2 rounded-full bg-[#1877f2]/20 blur-3xl" />
        <div className="absolute bottom-0 right-0 h-56 w-56 rounded-full bg-amber-300/20 blur-3xl" />
      </div>

      <div className="relative mx-auto flex min-h-[90vh] max-w-[420px] items-center justify-center">
        <div className="w-full rounded-3xl border border-white/90 bg-white/95 p-6 shadow-[0_20px_65px_rgba(24,119,242,0.18)] backdrop-blur-sm sm:p-7">
          <div className="mb-6 rounded-2xl border border-amber-300/60 bg-gradient-to-r from-amber-50 via-white to-amber-50 px-4 py-3">
            <p className="text-center text-xs font-semibold uppercase tracking-[0.16em] text-amber-700">
              Premium Access
            </p>
          </div>

          {!adminExists ? (
            <>
              <div className="mb-8 text-center">
                <p className="text-sm font-bold text-[#1877f2]">AppBeg</p>
                <h1 className="mt-2 text-3xl font-bold text-slate-900">Create Admin</h1>
                <p className="mt-2 text-sm text-slate-600">
                  Create the first admin account. After this, admin signup is blocked.
                </p>
              </div>

              <form onSubmit={handleCreateAdmin} className="space-y-4">
                <label htmlFor="admin-username" className="sr-only">
                  Username
                </label>
                <input
                  id="admin-username"
                  name="username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  required
                  placeholder="Username"
                  autoComplete="username"
                  className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3.5 text-base text-slate-900 outline-none transition-all placeholder:text-slate-400 focus:border-[#1877f2] focus:ring-4 focus:ring-[#1877f2]/15"
                />

                <label htmlFor="admin-password" className="sr-only">
                  Password
                </label>
                <input
                  id="admin-password"
                  name="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  type="password"
                  required
                  minLength={6}
                  placeholder="Password"
                  autoComplete="new-password"
                  className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3.5 text-base text-slate-900 outline-none transition-all placeholder:text-slate-400 focus:border-[#1877f2] focus:ring-4 focus:ring-[#1877f2]/15"
                />

                {error && (
                  <p className="rounded-2xl border border-red-200 bg-red-50 p-3 text-sm font-medium text-red-600">
                    {error}
                  </p>
                )}

                <button
                  disabled={loading}
                  className="w-full rounded-2xl bg-[#1877f2] px-4 py-3.5 font-semibold text-white shadow-[0_10px_25px_rgba(24,119,242,0.35)] transition-all hover:bg-[#166ee0] active:translate-y-[1px] disabled:opacity-60"
                >
                  {loading ? 'Creating...' : 'Create Admin'}
                </button>
              </form>
            </>
          ) : (
            <>
              <div className="mb-8 text-center">
                <p className="text-sm font-bold text-[#1877f2]">AppBeg</p>
                <h1 className="mt-2 text-3xl font-bold text-slate-900">Welcome Back</h1>
                <p className="mt-2 text-sm text-slate-600">
                  Sign in to continue
                </p>
              </div>

              <form onSubmit={handleLogin} className="space-y-4">
                <label htmlFor="login-username" className="sr-only">
                  Username
                </label>
                <input
                  id="login-username"
                  name="username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  required
                  placeholder="Username"
                  autoComplete="username"
                  className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3.5 text-base text-slate-900 outline-none transition-all placeholder:text-slate-400 focus:border-[#1877f2] focus:ring-4 focus:ring-[#1877f2]/15"
                />

                <label htmlFor="login-password" className="sr-only">
                  Password
                </label>
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
                  className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3.5 text-base text-slate-900 outline-none transition-all placeholder:text-slate-400 focus:border-[#1877f2] focus:ring-4 focus:ring-[#1877f2]/15"
                />

                {error && (
                  <p className="rounded-2xl border border-red-200 bg-red-50 p-3 text-sm font-medium text-red-600">
                    {error}
                  </p>
                )}

                <button
                  disabled={loading}
                  className="w-full rounded-2xl bg-[#1877f2] px-4 py-3.5 font-semibold text-white shadow-[0_10px_25px_rgba(24,119,242,0.35)] transition-all hover:bg-[#166ee0] active:translate-y-[1px] disabled:opacity-60"
                >
                  {loading ? 'Logging in...' : 'Login'}
                </button>

                <div className="flex items-center justify-between px-1 pt-1 text-sm">
                  <button
                    type="button"
                    className="font-medium text-[#1877f2] transition-colors hover:text-[#0f5cc7]"
                  >
                    Forgot password?
                  </button>
                  <button
                    type="button"
                    onClick={() => router.push('/signup')}
                    className="font-medium text-slate-500 transition-colors hover:text-slate-700"
                  >
                    Create account
                  </button>
                </div>
              </form>
            </>
          )}
        </div>
      </div>
    </main>
  );
}