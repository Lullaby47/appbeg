'use client';

import { useEffect, useMemo, useState } from 'react';
import { motion } from 'motion/react';
import type { PlayerGameLogin } from '@/features/games/playerGameLogins';
import { UNKNOWN_CREATOR_FILTER_KEY } from '../constants';
import { getGameBackgroundImage, normalizeBackgroundKey, normalizeExternalUrl, normalizeGameKey } from '../utils';

type Props = Record<string, any>;

const MOBILE_CREDENTIAL_INITIAL_LIMIT = 10;
const MOBILE_CREDENTIAL_INCREMENT = 10;

function getMobileLowEndMode() {
  if (typeof window === 'undefined') {
    return false;
  }
  return (
    window.matchMedia('(max-width: 767px)').matches ||
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

export default function Vault(props: Props) {
  const {
    coadminFrontendLinkByGameKey,
    copyCredentialValue,
    creatorNames,
    credentialTaskLoadingKey,
    gameBackgroundImageByKey,
    gameLogins,
    loadingList,
    openCredentialResetModal,
    selectedCreatorUid,
    setSelectedCreatorUid,
    togglePassword,
    usernameCarersByGame,
    usernamesCreatorFilterKeys,
    usernamesVisibleLogins,
    visiblePasswords,
  } = props;

  const [mobileLowEndMode, setMobileLowEndMode] = useState(getMobileLowEndMode);
  const [visibleCredentialCount, setVisibleCredentialCount] = useState(
    MOBILE_CREDENTIAL_INITIAL_LIMIT
  );

  useEffect(() => {
    const mobileQuery = window.matchMedia('(max-width: 767px)');
    const reducedMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    const updateMode = () => {
      setMobileLowEndMode(mobileQuery.matches || reducedMotionQuery.matches);
    };

    updateMode();
    mobileQuery.addEventListener('change', updateMode);
    reducedMotionQuery.addEventListener('change', updateMode);
    return () => {
      mobileQuery.removeEventListener('change', updateMode);
      reducedMotionQuery.removeEventListener('change', updateMode);
    };
  }, []);

  useEffect(() => {
    setVisibleCredentialCount(MOBILE_CREDENTIAL_INITIAL_LIMIT);
  }, [mobileLowEndMode, selectedCreatorUid, usernamesVisibleLogins.length]);

  const visibleCredentials = useMemo(
    () =>
      mobileLowEndMode
        ? usernamesVisibleLogins.slice(0, visibleCredentialCount)
        : usernamesVisibleLogins,
    [mobileLowEndMode, usernamesVisibleLogins, visibleCredentialCount]
  );
  const hasMoreCredentials =
    mobileLowEndMode && visibleCredentialCount < usernamesVisibleLogins.length;

  return (

              <div className="space-y-5 sm:space-y-6">
                <div className="fire-panel fire-orange fire-hero rounded-3xl border border-amber-400/35 bg-gradient-to-br from-amber-500/15 via-fuchsia-900/20 to-black/50 p-5 shadow-lg sm:p-6">
                  <p className="text-xs font-black uppercase tracking-[0.35em] text-amber-200/90 sm:text-sm">
                    🔐 VIP vault
                  </p>
                  <h2 className="mt-2 text-3xl font-black text-white sm:text-4xl">Credentials</h2>
                  <p className="mt-2 text-sm text-amber-100/60">Your Usernames and Password</p>
                </div>

                {loadingList ? (
                  <div className="flex justify-center py-12"><i className="fas fa-spinner fa-spin text-3xl text-amber-500"></i></div>
                ) : gameLogins.length === 0 ? (
                  <div className="rounded-xl border border-amber-500/20 bg-black/40 p-8 text-center text-amber-100/50">
                    <i className="fas fa-key text-4xl mb-3 opacity-50"></i>
                    <p>No usernames assigned yet.</p>
                  </div>
                ) : (
                  <>
                    <div className="flex flex-wrap gap-2">
                      {usernamesCreatorFilterKeys.sortedUids.map((uid: string) => (
                        <button
                          key={uid}
                          type="button"
                          onClick={() =>
                            setSelectedCreatorUid((prev: string | null) => (prev === uid ? null : uid))
                          }
                          className={`rounded-xl border px-4 py-2 text-left text-sm font-bold transition-all ${
                            selectedCreatorUid === uid
                              ? 'border-amber-400 bg-amber-500/25 text-amber-100 shadow-lg shadow-amber-500/10'
                              : 'border-amber-500/25 bg-black/40 text-amber-100/80 hover:border-amber-500/50 hover:bg-amber-500/10'
                          }`}
                        >
                          {creatorNames[uid] || 'Unknown Creator'}
                        </button>
                      ))}
                      {usernamesCreatorFilterKeys.hasMissingCreator && (
                        <button
                          key={UNKNOWN_CREATOR_FILTER_KEY}
                          type="button"
                          onClick={() =>
                            setSelectedCreatorUid((prev: string | null) =>
                              prev === UNKNOWN_CREATOR_FILTER_KEY ? null : UNKNOWN_CREATOR_FILTER_KEY
                            )
                          }
                          className={`rounded-xl border px-4 py-2 text-left text-sm font-bold transition-all ${
                            selectedCreatorUid === UNKNOWN_CREATOR_FILTER_KEY
                              ? 'border-amber-400 bg-amber-500/25 text-amber-100 shadow-lg shadow-amber-500/10'
                              : 'border-amber-500/25 bg-black/40 text-amber-100/80 hover:border-amber-500/50 hover:bg-amber-500/10'
                          }`}
                        >
                          Unknown Creator
                        </button>
                      )}
                    </div>

                    {usernamesVisibleLogins.length === 0 ? (
                      <div className="rounded-xl border border-amber-500/20 bg-black/40 p-8 text-center text-amber-100/50">
                        <p>No credentials match this filter.</p>
                      </div>
                    ) : (
                      <>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:gap-5">
                    {visibleCredentials.map((login: PlayerGameLogin) => {
                      const gameCarers =
                        usernameCarersByGame[normalizeGameKey(login.gameName || '')] || [];
                      const visible = visiblePasswords[login.id];
                      const displayUsername = login.gameUsername;
                      const displayPassword = login.gamePassword;
                      const fallbackFrontendUrl =
                        coadminFrontendLinkByGameKey[
                          normalizeBackgroundKey(String(login.gameName || ''))
                        ] || '';
                      const downloadGameUrl = normalizeExternalUrl(
                        login.frontendUrl || fallbackFrontendUrl || login.siteUrl
                      );
                      const gameCardBackgroundImage = getGameBackgroundImage(
                        gameBackgroundImageByKey,
                        login.gameName
                      );
                      return (
                        <motion.div
                          key={login.id}
                          layout={mobileLowEndMode ? false : true}
                          className="fire-panel fire-orange group rounded-[1.7rem] border border-amber-300/25 bg-gradient-to-br from-[#3a140b]/88 via-[#5d2411]/78 to-[#261018]/92 p-3 shadow-[0_18px_40px_-18px_rgba(56,11,4,0.9)] backdrop-blur-xl transition-all sm:p-3.5 sm:hover:border-amber-300/45 sm:hover:shadow-[0_0_30px_-10px_rgba(251,191,36,0.38)]"
                          style={
                            gameCardBackgroundImage
                              ? {
                                  backgroundImage: `linear-gradient(180deg, rgba(0, 0, 0, 0.24) 0%, rgba(0, 0, 0, 0.54) 100%), url("${gameCardBackgroundImage}")`,
                                  backgroundSize: '100% 100%',
                                  backgroundPosition: 'center',
                                  backgroundRepeat: 'no-repeat',
                                  filter: 'brightness(1.14) saturate(1.1)',
                                }
                              : undefined
                          }
                        >
                          <div className="mb-3 flex items-start justify-between gap-3 border-b border-amber-200/10 pb-2.5">
                            <div className="min-w-0">
                              <p className="text-[0.68rem] font-black uppercase tracking-[0.24em] text-amber-100/50">
                                🎮 Game
                              </p>
                              <h3 className="mt-1 break-words bg-gradient-to-r from-amber-50 via-yellow-100 to-orange-200 bg-clip-text text-[1.25rem] font-black leading-tight text-transparent">
                                {login.gameName}
                              </h3>
                              {downloadGameUrl ? (
                                <a
                                  href={downloadGameUrl}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="mt-2 inline-flex items-center rounded-xl border border-red-200/80 bg-red-600 px-3 py-1.5 text-xs font-black uppercase tracking-[0.12em] text-white shadow-[0_0_22px_-6px_rgba(248,113,113,0.95),0_0_38px_-14px_rgba(220,38,38,0.98)] transition hover:bg-red-700 hover:text-white hover:shadow-[0_0_28px_-4px_rgba(252,165,165,1),0_0_46px_-12px_rgba(220,38,38,1)]"
                                >
                                  Download Game
                                </a>
                              ) : null}
                            </div>
                            <span className="shrink-0 rounded-full border border-emerald-300/35 bg-emerald-400/12 px-3 py-1 text-[0.72rem] font-black tracking-wide text-emerald-100 shadow-[0_0_18px_-10px_rgba(52,211,153,0.9)]">
                              ✨ Active
                            </span>
                          </div>

                          <div className="space-y-2.5">
                            <div className="rounded-2xl border border-white/10 bg-white/[0.05] px-3 py-1.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]">
                              <div className="flex items-center justify-between gap-2">
                                <p className="text-[0.72rem] font-black uppercase tracking-[0.18em] text-amber-100/58">
                                  Username
                                </p>
                                <button
                                  type="button"
                                  onClick={(clickEvent) =>
                                    void copyCredentialValue(
                                      String(displayUsername || ''),
                                      'Username',
                                      clickEvent
                                    )
                                  }
                                  className="rounded-xl border border-amber-300/35 bg-amber-400/10 px-3 py-1 text-[0.72rem] font-black text-amber-50 transition hover:bg-amber-400/20"
                                >
                                  Copy
                                </button>
                              </div>
                              <p className="mt-1.5 break-words rounded-xl border border-black/10 bg-black/30 px-3 py-1 font-mono text-[0.95rem] font-bold tracking-[0.08em] text-white shadow-inner">
                                {displayUsername || '—'}
                              </p>
                            </div>

                            <div className="rounded-2xl border border-white/10 bg-white/[0.05] px-3 py-1.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]">
                              <div className="flex items-center justify-between gap-2">
                                <p className="text-[0.72rem] font-black uppercase tracking-[0.18em] text-amber-100/58">
                                  Password
                                </p>
                                <div className="flex gap-2">
                                  <button
                                    type="button"
                                    onClick={(clickEvent) =>
                                      void copyCredentialValue(
                                        visible ? String(displayPassword || '') : '',
                                        'Password',
                                        clickEvent
                                      )
                                    }
                                    disabled={!visible}
                                    className="rounded-xl border border-violet-300/35 bg-violet-400/10 px-3 py-1 text-[0.72rem] font-black text-violet-50 transition hover:bg-violet-400/20 disabled:cursor-not-allowed disabled:opacity-40"
                                  >
                                    Copy
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => togglePassword(login.id)}
                                    className="rounded-xl border border-amber-200/30 bg-amber-400 px-3 py-1 text-sm font-black text-black transition hover:bg-amber-300"
                                    aria-label={visible ? 'Hide password' : 'Show password'}
                                  >
                                    {visible ? '🙈' : '👁️'}
                                  </button>
                                </div>
                              </div>
                              <p className="mt-1.5 break-all rounded-xl border border-black/10 bg-black/30 px-3 py-1 font-mono text-[0.95rem] font-bold tracking-[0.18em] text-white shadow-inner">
                                {visible ? displayPassword : '••••••••••••••••'}
                              </p>
                            </div>

                            <div className="border-t border-amber-200/10 pt-1">
                              <button
                                type="button"
                                onClick={(event) =>
                                  openCredentialResetModal(login, 'reset_password', event)
                                }
                                disabled={credentialTaskLoadingKey === `reset_password:${login.id}`}
                                className="min-h-[44px] w-full rounded-2xl border border-fuchsia-200/15 bg-gradient-to-r from-fuchsia-600 to-violet-600 px-3 py-2 text-sm font-black leading-tight text-white shadow-[0_10px_24px_-16px_rgba(217,70,239,0.95)] transition-all hover:from-fuchsia-500 hover:to-violet-500 disabled:opacity-50"
                              >
                                {credentialTaskLoadingKey === `reset_password:${login.id}` ? (
                                  <i className="fas fa-spinner fa-spin"></i>
                                ) : (
                                  <>Reset password</>
                                )}
                              </button>
                            </div>
                          </div>
                        </motion.div>
                      );
                    })}
                  </div>
                  {hasMoreCredentials ? (
                    <button
                      type="button"
                      onClick={() =>
                        setVisibleCredentialCount((count) =>
                          Math.min(
                            usernamesVisibleLogins.length,
                            count + MOBILE_CREDENTIAL_INCREMENT
                          )
                        )
                      }
                      className="mt-3 min-h-[44px] w-full rounded-2xl border border-amber-400/35 bg-black/45 px-4 py-3 text-sm font-black text-amber-100"
                    >
                      Show more credentials ({usernamesVisibleLogins.length - visibleCredentialCount} more)
                    </button>
                  ) : null}
                      </>
                    )}
                  </>
                )}
              </div>
  );
}
