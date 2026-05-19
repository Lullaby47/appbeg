export default function SignupPage() {
  return (
    <main className="min-h-screen bg-neutral-950 px-4 py-8 text-white">
      <div className="mx-auto flex min-h-[90vh] max-w-md items-center justify-center">
        <div className="w-full rounded-3xl border border-white/10 bg-white/5 p-6 shadow-2xl">
          <h1 className="text-3xl font-bold">Admin Signup Disabled</h1>
          <p className="mt-2 text-sm text-neutral-400">
            Admin signup is disabled. Please use the local admin setup tool.
          </p>
          {/* Admin bootstrap must be done by local Firebase Admin SDK tool, not browser. */}
        </div>
      </div>
    </main>
  );
}
