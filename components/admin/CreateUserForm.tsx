'use client';

import React from 'react';

import {
  GAME_USERNAME_RULE_MESSAGE,
  GAME_USERNAME_SUBMIT_ERROR_MESSAGE,
  isValidGameUsername,
} from '@/lib/games/gameUsernameRule';

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
  validatePlayerUsername?: boolean;
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
  validatePlayerUsername = false,
  onSubmit,
}: Props) {
  const cleanUsername = username.trim();
  const hasTypedUsername = cleanUsername.length > 0;
  const playerUsernameValid = isValidGameUsername(username);
  const showUsernameFeedback = validatePlayerUsername && hasTypedUsername;
  const [usernameError, setUsernameError] = React.useState('');

  function handleUsernameChange(value: string) {
    if (usernameError) {
      setUsernameError('');
    }
    onUsernameChange(value);
  }

  function handleSubmit(e: React.FormEvent) {
    if (validatePlayerUsername && !playerUsernameValid) {
      e.preventDefault();
      setUsernameError(GAME_USERNAME_SUBMIT_ERROR_MESSAGE);
      return;
    }
    onSubmit(e);
  }

  const usernameInputClass =
    validatePlayerUsername && hasTypedUsername
      ? playerUsernameValid
        ? 'border-emerald-500/80 bg-emerald-950/20 focus:border-emerald-400 focus:ring-2 focus:ring-emerald-500/20'
        : 'border-red-500/80 bg-red-950/20 focus:border-red-400 focus:ring-2 focus:ring-red-500/20'
      : 'border-white/10 bg-neutral-900 focus:border-white/30';

  return (
    <div className="max-w-md">
      <h2 className="mb-6 text-3xl font-bold">{title}</h2>

      <form
        onSubmit={handleSubmit}
        className="rounded-2xl border border-white/10 bg-white/5 p-6 space-y-4"
      >
        <div className="space-y-3">
          <input
            value={username}
            onChange={(e) => handleUsernameChange(e.target.value)}
            placeholder={validatePlayerUsername ? 'Player username, e.g. Test22' : 'Username'}
            title={validatePlayerUsername ? GAME_USERNAME_RULE_MESSAGE : undefined}
            aria-invalid={showUsernameFeedback && !playerUsernameValid}
            aria-describedby={validatePlayerUsername ? 'player-username-format-help' : undefined}
            className={`w-full rounded-xl border p-3 outline-none transition ${usernameInputClass}`}
            required
          />

          {validatePlayerUsername ? (
            <div
              id="player-username-format-help"
              className="rounded-xl border border-white/10 bg-black/25 p-3 text-xs leading-relaxed text-neutral-200"
            >
              {showUsernameFeedback ? (
                <p
                  className={`mb-2 font-semibold ${
                    playerUsernameValid ? 'text-emerald-300' : 'text-red-300'
                  }`}
                >
                  {playerUsernameValid ? 'Valid username format.' : 'Invalid username format.'}
                </p>
              ) : null}

              {usernameError ? (
                <pre className="mb-3 whitespace-pre-wrap rounded-lg border border-red-500/35 bg-red-950/40 p-3 font-sans text-xs text-red-100">
                  {usernameError}
                </pre>
              ) : null}

              <p className="font-semibold text-white">Username format:</p>
              <ul className="mt-1 list-disc space-y-1 pl-5">
                <li>Start with a capital letter</li>
                <li>May contain letters</li>
                <li>Optional underscore</li>
                <li>Must end with numbers</li>
              </ul>

              <p className="mt-3 font-semibold text-white">Examples:</p>
              <div className="mt-1 grid grid-cols-2 gap-1 font-mono text-emerald-200">
                <span>Test22</span>
                <span>Test_22</span>
                <span>Rajex22</span>
                <span>Rajex_22</span>
              </div>

              <p className="mt-3 font-semibold text-white">Not allowed:</p>
              <div className="mt-1 grid grid-cols-2 gap-1 font-mono text-red-200">
                <span>test</span>
                <span>test22</span>
                <span>Test</span>
                <span>22Test</span>
              </div>
            </div>
          ) : null}
        </div>

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
