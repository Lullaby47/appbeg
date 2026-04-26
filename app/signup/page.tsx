'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createUserWithEmailAndPassword } from 'firebase/auth';
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

export default function SignupPage() {
  const router = useRouter();

  const [adminExists, setAdminExists] = useState<boolean | null>(null);

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');

  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  // 🔍 Check if admin exists
  useEffect(() => {
    async function checkAdmin() {
      try {
        const q = query(
          collection(db, 'users'),
          where('role', '==', 'admin')
        );

        const snapshot = await getDocs(q);

        if (!snapshot.empty) {
          // 🚫 BLOCK SIGNUP
          router.replace('/login');
        } else {
          setAdminExists(false);
        }
      } catch (err) {
        console.error(err);
        setError('Failed to check admin.');
        setAdminExists(true);
      }
    }

    checkAdmin();
  }, [router]);

  function makeHiddenEmail(username: string) {
    return `${username}@app.local`;
  }

  async function handleSignup(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();

    const cleanUsername = username.trim().toLowerCase();

    if (!cleanUsername) {
      setError('Username required');
      return;
    }

    if (password.length < 6) {
      setError('Password must be at least 6 characters');
      return;
    }

    setLoading(true);
    setError('');

    try {
      // 🔒 Double check admin
      const q = query(
        collection(db, 'users'),
        where('role', '==', 'admin')
      );

      const snapshot = await getDocs(q);

      if (!snapshot.empty) {
        throw new Error('Admin already exists');
      }

      // 🔒 Check username uniqueness
      const usernameQuery = query(
        collection(db, 'users'),
        where('username', '==', cleanUsername)
      );

      const usernameSnap = await getDocs(usernameQuery);

      if (!usernameSnap.empty) {
        throw new Error('Username already exists');
      }

      const hiddenEmail = makeHiddenEmail(cleanUsername);

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
    } catch (err: any) {
      console.error(err);
      setError(err.message || 'Signup failed');
    } finally {
      setLoading(false);
    }
  }

  if (adminExists === null) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-neutral-950 text-white">
        <p>Loading...</p>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-neutral-950 px-4 py-8 text-white">
      <div className="mx-auto flex min-h-[90vh] max-w-md items-center justify-center">
        <div className="w-full rounded-3xl border border-white/10 bg-white/5 p-6 shadow-2xl">
          <h1 className="text-3xl font-bold">Create Admin</h1>
          <p className="mt-2 text-sm text-neutral-400">
            This page works only once. After admin is created, it is locked.
          </p>

          <form onSubmit={handleSignup} className="mt-6 space-y-4">
            <input
              name="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
              placeholder="Username"
              className="w-full rounded-2xl border border-white/10 bg-neutral-900 px-4 py-3"
            />

            <input
              name="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              type="password"
              required
              minLength={6}
              placeholder="Password"
              className="w-full rounded-2xl border border-white/10 bg-neutral-900 px-4 py-3"
            />

            {error && (
              <p className="text-sm text-red-400">{error}</p>
            )}

            <button
              disabled={loading}
              className="w-full rounded-2xl bg-white py-3 text-black font-semibold"
            >
              {loading ? 'Creating...' : 'Create Admin'}
            </button>
          </form>
        </div>
      </div>
    </main>
  );
}