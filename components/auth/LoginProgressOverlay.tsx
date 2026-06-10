'use client';

import { useSyncExternalStore } from 'react';

import {
  getLoginUiProgress,
  LOGIN_UI_STEP_LABELS,
  LOGIN_UI_STEP_ORDER,
  subscribeLoginUiProgress,
  type LoginUiStep,
} from '@/lib/client/loginUiProgress';

function stepIndex(step: LoginUiStep) {
  return LOGIN_UI_STEP_ORDER.indexOf(step);
}

export default function LoginProgressOverlay() {
  const progress = useSyncExternalStore(
    subscribeLoginUiProgress,
    () => getLoginUiProgress(),
    () => null
  );

  if (!progress?.active) {
    return null;
  }

  const activeIndex = Math.max(0, stepIndex(progress.step));
  const label = LOGIN_UI_STEP_LABELS[progress.step];

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-slate-950/72 px-4 backdrop-blur-md"
      role="status"
      aria-live="polite"
      aria-busy="true"
      aria-label={label}
    >
      <div className="w-full max-w-sm rounded-3xl border border-white/10 bg-white/95 p-8 text-center shadow-2xl shadow-blue-500/20">
        <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center">
          <div className="h-12 w-12 animate-spin rounded-full border-[3px] border-blue-200 border-t-blue-600" />
        </div>
        <p className="text-lg font-semibold tracking-tight text-slate-800">{label}</p>
        <p className="mt-2 text-sm text-slate-500">Please wait while we sign you in securely.</p>
        <ol className="mt-6 space-y-2 text-left">
          {LOGIN_UI_STEP_ORDER.map((step, index) => {
            const done = index < activeIndex;
            const current = index === activeIndex;
            return (
              <li
                key={step}
                className={`flex items-center gap-3 rounded-xl px-3 py-2 text-sm ${
                  current
                    ? 'bg-blue-50 font-medium text-blue-700'
                    : done
                      ? 'text-slate-500'
                      : 'text-slate-300'
                }`}
              >
                <span
                  className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
                    done
                      ? 'bg-emerald-100 text-emerald-700'
                      : current
                        ? 'bg-blue-600 text-white'
                        : 'bg-slate-100 text-slate-400'
                  }`}
                  aria-hidden
                >
                  {done ? '✓' : index + 1}
                </span>
                <span>{LOGIN_UI_STEP_LABELS[step]}</span>
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}
