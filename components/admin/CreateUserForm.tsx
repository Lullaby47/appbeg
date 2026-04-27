'use client';

import React from 'react';

interface Props {
  title: string;
  buttonLabel: string;
  loadingLabel: string;
  username: string;
  password: string;
  loading: boolean;
  onUsernameChange: (value: string) => void;
  onPasswordChange: (value: string) => void;
  referralCode?: string;
  onReferralCodeChange?: (value: string) => void;
  showReferralCodeInput?: boolean;
  showPasswordInput?: boolean;
  passwordRequired?: boolean;
  onSubmit: (e: React.FormEvent) => void;
}

export default function CreateUserForm({
  title,
  buttonLabel,
  loadingLabel,
  username,
  password,
  loading,
  onUsernameChange,
  onPasswordChange,
  referralCode = '',
  onReferralCodeChange,
  showReferralCodeInput = false,
  showPasswordInput = true,
  passwordRequired = true,
  onSubmit,
}: Props) {
  return (
    <div className="max-w-md">
      <h2 className="mb-6 text-3xl font-bold">{title}</h2>

      <form
        onSubmit={onSubmit}
        className="rounded-2xl border border-white/10 bg-white/5 p-6 space-y-4"
      >
        <input
          value={username}
          onChange={(e) => onUsernameChange(e.target.value)}
          placeholder="Username"
          className="w-full rounded-xl border border-white/10 bg-neutral-900 p-3 outline-none focus:border-white/30"
          required
        />

        {showPasswordInput ? (
          <input
            value={password}
            onChange={(e) => onPasswordChange(e.target.value)}
            type="password"
            placeholder="Password"
            className="w-full rounded-xl border border-white/10 bg-neutral-900 p-3 outline-none focus:border-white/30"
            required={passwordRequired}
          />
        ) : null}

        {showReferralCodeInput ? (
          <input
            value={referralCode}
            onChange={(e) => onReferralCodeChange?.(e.target.value)}
            type="text"
            inputMode="numeric"
            pattern="\d{6,10}"
            placeholder="Referral Code (optional)"
            className="w-full rounded-xl border border-white/10 bg-neutral-900 p-3 outline-none focus:border-white/30"
          />
        ) : null}

        <button
          disabled={loading}
          className="w-full rounded-xl bg-white p-3 font-semibold text-black disabled:opacity-60"
        >
          {loading ? loadingLabel : buttonLabel}
        </button>
      </form>
    </div>
  );
}