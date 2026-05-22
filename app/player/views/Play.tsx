'use client';

import { motion } from 'motion/react';
import type { PlayerGameLogin } from '@/features/games/playerGameLogins';
import { getGameBackgroundImage } from '../utils';

type Props = Record<string, any>;

export default function Play(props: Props) {
  const {
    copyCredentialValue,
    gameBackgroundImageByKey,
    gameLogins,
    loadingList,
    openActiveTableSplash,
    selectedGameName,
    setSelectedGameName,
    togglePassword,
    visiblePasswords,
  } = props;

  return (

              <div className="space-y-5 sm:space-y-6">
                <div className="fire-panel fire-orange fire-hero relative overflow-hidden rounded-3xl border border-amber-400/30 bg-gradient-to-r from-amber-500/20 via-rose-600/15 to-purple-900/30 p-4 shadow-lg sm:p-5">
                  <div className="pointer-events-none absolute right-4 top-4 text-4xl opacity-20">
                    🎲
                  </div>
                  <p className="text-xs font-black uppercase tracking-[0.35em] text-amber-200/90 sm:text-sm">
                    🎰 High-limit floor
                  </p>
                  <h2 className="mt-2 text-2xl font-black text-white sm:text-3xl">Pick your table</h2>
                  <p className="mt-2 text-sm text-amber-100/60">
                    Tap a table to open the play screen, enter your amount in USD, then recharge ⬇️ or
                    redeem ⬆️.
                  </p>
                </div>

                {loadingList ? (
                  <div className="flex justify-center py-16">
                    <i className="fas fa-spinner fa-spin text-4xl text-amber-400"></i>
                  </div>
                ) : gameLogins.length === 0 ? (
                  <div className="rounded-3xl border border-amber-500/25 bg-black/50 p-10 text-center text-amber-100/55">
                    <span className="text-5xl">🐉</span>
                    <p className="mt-3 font-bold">No tables assigned yet.</p>
                  </div>
                ) : (
                  <>
                    <div className="grid grid-cols-2 gap-2 sm:items-start">
                      {gameLogins.map((game: PlayerGameLogin, index: number) => {
                        const resolvedUsername = (game.gameUsername || '').trim();
                        const resolvedPassword = String(game.gamePassword || '');
                        const isPasswordVisible = Boolean(visiblePasswords[game.id]);
                        const hasUsername = Boolean(resolvedUsername);
                        const isSelected = selectedGameName === game.gameName;
                        const gameCardBackgroundImage = getGameBackgroundImage(
                          gameBackgroundImageByKey,
                          game.gameName
                        );

                        return (
                          <motion.div
                            key={game.id}
                            initial={{ opacity: 0, y: 16 }}
                            animate={{ opacity: 1, y: 0 }}
                            transition={{ delay: index * 0.05 }}
                            onClick={() => {
                              setSelectedGameName(game.gameName);
                              openActiveTableSplash();
                            }}
                            onKeyDown={(event) => {
                              if (event.key === 'Enter' || event.key === ' ') {
                                event.preventDefault();
                                setSelectedGameName(game.gameName);
                                openActiveTableSplash();
                              }
                            }}
                            role="button"
                            tabIndex={0}
                            aria-pressed={isSelected}
                            className={`fire-panel fire-orange group relative w-full self-start overflow-hidden rounded-2xl border p-2 text-left shadow-xl transition-all active:scale-[0.98] hover:scale-[1.01] hover:shadow-[0_0_26px_-8px_rgba(251,191,36,0.5)] ${
                              isSelected
                                ? 'border-amber-400/60 bg-gradient-to-br from-amber-500/25 to-purple-900/40 shadow-[0_0_32px_-8px_rgba(234,179,8,0.55)]'
                                : 'border-white/10 bg-black/45 hover:border-amber-400/35'
                            }`}
                            style={
                              gameCardBackgroundImage
                                ? {
                                    backgroundImage: `linear-gradient(180deg, rgba(0, 0, 0, 0.2) 0%, rgba(0, 0, 0, 0.42) 100%), url("${gameCardBackgroundImage}")`,
                                    backgroundSize: '100% 100%',
                                    backgroundPosition: 'center',
                                    backgroundRepeat: 'no-repeat',
                                    filter: 'brightness(1.12) saturate(1.08)',
                                  }
                                : undefined
                            }
                          >
                            <div className="pointer-events-none absolute -right-6 -top-6 h-24 w-24 rounded-full bg-amber-400/15 blur-2xl" />
                            <div className="relative flex items-start justify-center gap-2">
                              <div className="min-w-0 flex-1 text-center">
                                <h3 className="mt-0.5 truncate bg-gradient-to-r from-amber-100 via-yellow-200 to-orange-300 bg-clip-text text-lg font-black text-transparent drop-shadow-[0_0_12px_rgba(251,191,36,0.45)]">
                                  {game.gameName}
                                </h3>
                              </div>
                            </div>
                            {hasUsername && (
                              <div className="relative mt-1.5 rounded-xl border border-white/10 bg-black/35 px-2 py-1">
                                <div className="flex items-start justify-between gap-1">
                                  <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-amber-100/55">
                                    Game username
                                  </p>
                                  <button
                                    type="button"
                                    onClick={(event) => {
                                      event.preventDefault();
                                      event.stopPropagation();
                                      void copyCredentialValue(resolvedUsername, 'Username', event);
                                    }}
                                    className="shrink-0 rounded-lg border border-amber-300/35 bg-amber-400/10 px-2 py-0.5 text-[10px] font-black text-amber-50 transition hover:bg-amber-400/20"
                                  >
                                    Copy
                                  </button>
                                </div>
                                <p className="mt-0.5 truncate font-mono text-xs font-bold text-white">
                                  {resolvedUsername}
                                </p>
                                <div className="mt-1.5 flex items-start justify-between gap-1">
                                  <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-amber-100/55 leading-tight">
                                    Game password
                                  </p>
                                  <div className="flex shrink-0 items-center gap-1">
                                    <button
                                      type="button"
                                      disabled={!isPasswordVisible || !resolvedPassword}
                                      title={
                                        isPasswordVisible
                                          ? 'Copy password'
                                          : 'Show password to copy'
                                      }
                                      onClick={(event) => {
                                        event.preventDefault();
                                        event.stopPropagation();
                                        void copyCredentialValue(
                                          resolvedPassword,
                                          'Password',
                                          event
                                        );
                                      }}
                                      className="rounded-lg border border-violet-300/35 bg-violet-400/10 px-2 py-0.5 text-[10px] font-black text-violet-50 transition hover:bg-violet-400/20 disabled:cursor-not-allowed disabled:opacity-40"
                                    >
                                      Copy
                                    </button>
                                    <span
                                      onClick={(event) => {
                                        event.preventDefault();
                                        event.stopPropagation();
                                        togglePassword(game.id);
                                      }}
                                      className="cursor-pointer rounded-lg border border-amber-400/40 bg-amber-500/20 px-2 py-0.5 text-xs font-black text-amber-100 hover:bg-amber-500/30"
                                      aria-label={isPasswordVisible ? 'Hide password' : 'Show password'}
                                      role="button"
                                      onKeyDown={(event) => {
                                        if (event.key === 'Enter' || event.key === ' ') {
                                          event.preventDefault();
                                          event.stopPropagation();
                                          togglePassword(game.id);
                                        }
                                      }}
                                      tabIndex={0}
                                    >
                                      {isPasswordVisible ? '🙈' : '👁'}
                                    </span>
                                  </div>
                                </div>
                                <p className="mt-0.5 truncate font-mono text-xs font-bold tracking-wider text-white">
                                  {isPasswordVisible ? resolvedPassword || '—' : '••••••••••'}
                                </p>
                              </div>
                            )}
                            <span
                              className={`relative mt-2 flex min-h-[38px] w-full items-center justify-center rounded-xl px-2 text-sm font-black transition-all duration-300 group-hover:tracking-wide ${
                                isSelected
                                  ? 'bg-gradient-to-r from-amber-300 via-yellow-300 to-orange-300 text-black shadow-[0_0_22px_-2px_rgba(251,191,36,0.7)]'
                                  : 'border border-orange-200/80 bg-orange-500 text-white shadow-[0_0_18px_-6px_rgba(249,115,22,0.75)] group-hover:bg-orange-600 group-hover:shadow-[0_0_26px_-4px_rgba(249,115,22,0.95)]'
                              }`}
                            >
                              {isSelected ? '🔥 Selected' : 'Tap to open'}
                            </span>
                          </motion.div>
                        );
                      })}
                    </div>
                  </>
                )}
              </div>
  );
}
