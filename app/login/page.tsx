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
      <main className="flex min-h-screen items-center justify-center bg-neutral-950 text-white">
        <p className="text-sm text-neutral-400">Loading...</p>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-neutral-950 px-4 py-8 text-white">
      <div className="mx-auto flex min-h-[90vh] max-w-md items-center justify-center">
        <div className="w-full rounded-3xl border border-white/10 bg-white/5 p-6 shadow-2xl">
          {!adminExists ? (
            <>
              <div className="mb-8">
                <h1 className="text-3xl font-bold">Create Admin</h1>
                <p className="mt-2 text-sm text-neutral-400">
                  Create the first admin account. After this, admin signup is blocked.
                </p>
              </div>

              <form onSubmit={handleCreateAdmin} className="space-y-4">
                <input
                  id="admin-username"
                  name="username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  required
                  placeholder="Username"
                  autoComplete="username"
                  className="w-full rounded-2xl border border-white/10 bg-neutral-900 px-4 py-3 outline-none focus:border-white/30"
                />

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
                  className="w-full rounded-2xl border border-white/10 bg-neutral-900 px-4 py-3 outline-none focus:border-white/30"
                />

                {error && (
                  <p className="rounded-2xl bg-red-500/10 p-3 text-sm text-red-400">
                    {error}
                  </p>
                )}

                <button
                  disabled={loading}
                  className="w-full rounded-2xl bg-white px-4 py-3 font-semibold text-black disabled:opacity-60"
                >
                  {loading ? 'Creating...' : 'Create Admin'}
                </button>
              </form>
            </>
          ) : (
            <>
              <div className="mb-8">
                <h1 className="text-3xl font-bold">Login</h1>
                <p className="mt-2 text-sm text-neutral-400">
                  Enter your username and password.
                </p>
              </div>

              <form onSubmit={handleLogin} className="space-y-4">
                <input
                  id="login-username"
                  name="username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  required
                  placeholder="Username"
                  autoComplete="username"
                  className="w-full rounded-2xl border border-white/10 bg-neutral-900 px-4 py-3 outline-none focus:border-white/30"
                />

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
                  className="w-full rounded-2xl border border-white/10 bg-neutral-900 px-4 py-3 outline-none focus:border-white/30"
                />

                {error && (
                  <p className="rounded-2xl bg-red-500/10 p-3 text-sm text-red-400">
                    {error}
                  </p>
                )}

                <button
                  disabled={loading}
                  className="w-full rounded-2xl bg-white px-4 py-3 font-semibold text-black disabled:opacity-60"
                >
                  {loading ? 'Logging in...' : 'Login'}
                </button>
              </form>
            </>
          )}
        </div>
      </div>
    </main>
  );
}