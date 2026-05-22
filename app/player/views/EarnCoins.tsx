'use client';

import type { ReferralRewardGroup } from '@/features/referrals/playerReferralRewards';

type Props = Record<string, any>;

export default function EarnCoins(props: Props) {
  const {
    claimingReferredPlayerUid,
    handleClaimReferralReward,
    referralRewardGroups,
    referralRewardsLoading,
    referredByPlayerName,
  } = props;

  return (

              <div className="space-y-5 sm:space-y-6">
                <div className="fire-panel fire-orange rounded-3xl border border-amber-400/35 bg-gradient-to-br from-amber-500/20 via-orange-900/20 to-black/60 p-5 shadow-[0_0_42px_-16px_rgba(251,191,36,0.65)] sm:p-6">
                  <p className="text-xs font-black uppercase tracking-[0.3em] text-amber-200/90">
                    Permanent bonus event
                  </p>
                  <h3 className="mt-2 text-2xl font-black text-white sm:text-3xl">
                    Earn from your referrals!
                  </h3>
                  <p className="mt-3 text-sm text-amber-100/85 sm:text-base">
                    🎁 $15 free play when your friend signs up
                    <br />
                    💰 $5 bonus after their first deposit
                    <br />
                    📈 Earn percentage-based income every time your referred players recharge and play
                    <br />
                    <br />
                    All earnings are added to your Earn section in real-time.
                    <br />
                    <br />
                    Bonus terms apply
                  </p>
                </div>

                <div className="fire-panel fire-orange fire-hero rounded-3xl border border-amber-400/35 bg-gradient-to-br from-amber-500/15 via-emerald-900/20 to-black/50 p-5 shadow-lg sm:p-6">
                  <p className="text-xs font-black uppercase tracking-[0.35em] text-amber-200/90 sm:text-sm">
                    🪙 Earn coins
                  </p>
                  <h2 className="mt-2 text-3xl font-black text-white sm:text-4xl">
                    Referral players
                  </h2>
                  <p className="mt-2 text-sm text-amber-100/60">
                    Players who joined using your referral code are listed below.
                  </p>
                  {referredByPlayerName ? (
                    <p className="mt-2 text-xs text-emerald-200/80">
                      You were referred by:{' '}
                      <span className="font-bold text-emerald-300">{referredByPlayerName}</span>
                    </p>
                  ) : null}
                </div>

                {referralRewardsLoading ? (
                  <div className="flex justify-center py-12">
                    <i className="fas fa-spinner fa-spin text-3xl text-amber-500"></i>
                  </div>
                ) : referralRewardGroups.length === 0 ? (
                  <div className="rounded-2xl border border-amber-500/20 bg-black/40 p-8 text-center text-amber-100/50">
                    <i className="fas fa-user-plus text-4xl opacity-50"></i>
                    <p className="mt-3">No referral players yet.</p>
                    <p className="mt-1 text-xs text-amber-100/40">
                      Share your referral code from the Lobby card to invite players.
                    </p>
                  </div>
                ) : (
                  <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                    {referralRewardGroups.map((group: ReferralRewardGroup) => (
                      <div
                        key={group.referredPlayerUid}
                        className="fire-panel fire-orange rounded-2xl border border-amber-400/25 bg-gradient-to-br from-black/60 to-emerald-950/20 p-4"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <h3 className="mt-1 text-xl font-black text-white">
                              {group.referredPlayerName || 'Unnamed Player'}
                            </h3>
                            <p className="mt-1 text-sm text-amber-100/70">
                              Claimable:{' '}
                              <span className="font-black text-emerald-300">
                                {Math.max(0, Number(group.pendingRewardCoins || 0)).toFixed(2)} points
                              </span>
                            </p>
                          </div>
                        </div>

                        <div className="mt-3 flex items-center justify-end gap-3">
                          {group.hasClaimableReward ? (
                            <button
                              type="button"
                              onClick={() =>
                                void handleClaimReferralReward(group.referredPlayerUid)
                              }
                              disabled={claimingReferredPlayerUid === group.referredPlayerUid}
                              className="rounded-xl border border-red-400/60 bg-red-500/20 px-3 py-2 text-sm font-black text-red-100 hover:bg-red-500/30 disabled:opacity-50"
                              title="Claim accumulated reward"
                            >
                              {claimingReferredPlayerUid === group.referredPlayerUid
                                ? '...'
                                : '🎁'}
                            </button>
                          ) : (
                            <span className="text-xs text-amber-100/55">No rewards available.</span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
  );
}
