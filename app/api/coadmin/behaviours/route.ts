import { NextResponse } from 'next/server';
import { adminAuth, adminDb } from '@/lib/firebase/admin';

type AnyDoc = Record<string, any>;

function toMs(value: any): number {
  if (!value) return 0;
  if (typeof value?.toMillis === 'function') {
    try {
      return Number(value.toMillis()) || 0;
    } catch {
      return 0;
    }
  }
  const asDate = new Date(value);
  return Number.isFinite(asDate.getTime()) ? asDate.getTime() : 0;
}

function isWithin(ms: number, fromMs: number): boolean {
  return ms > 0 && ms >= fromMs;
}

function riskLevelFromScore(score: number): 'low' | 'medium' | 'high' {
  if (score >= 51) return 'high';
  if (score >= 21) return 'medium';
  return 'low';
}

export async function GET(request: Request) {
  try {
    const header = request.headers.get('Authorization') || '';
    const token = header.match(/^Bearer\s+(\S+)$/i)?.[1];
    if (!token) {
      return NextResponse.json({ error: 'Missing or invalid authorization.' }, { status: 401 });
    }

    const decoded = await adminAuth.verifyIdToken(token);
    const callerSnap = await adminDb.collection('users').doc(decoded.uid).get();
    if (!callerSnap.exists) {
      return NextResponse.json({ error: 'User profile not found.' }, { status: 404 });
    }
    const caller = callerSnap.data() as { role?: string };
    if (String(caller.role || '').toLowerCase() !== 'coadmin') {
      return NextResponse.json({ error: 'Only coadmin can view behaviours.' }, { status: 403 });
    }

    const url = new URL(request.url);
    const selectedStaffId = String(url.searchParams.get('staffId') || '').trim();

    const [staffSnap, playersSnap, cashoutsSnap, requestsSnap] = await Promise.all([
      adminDb.collection('users').where('role', '==', 'staff').where('coadminUid', '==', decoded.uid).get(),
      adminDb.collection('users').where('role', '==', 'player').where('coadminUid', '==', decoded.uid).get(),
      adminDb.collection('playerCashoutTasks').where('coadminUid', '==', decoded.uid).get(),
      adminDb.collection('playerGameRequests').where('coadminUid', '==', decoded.uid).where('type', '==', 'redeem').get(),
    ]);

    const now = Date.now();
    const dayStart = new Date();
    dayStart.setHours(0, 0, 0, 0);
    const todayStartMs = dayStart.getTime();
    const yesterdayStartMs = todayStartMs - 24 * 60 * 60 * 1000;
    const sevenDaysAgoMs = now - 7 * 24 * 60 * 60 * 1000;
    const oneDayAgoMs = now - 24 * 60 * 60 * 1000;
    const oneHourMs = 60 * 60 * 1000;

    const staffDocs = staffSnap.docs.map((d) => ({ id: d.id, ...(d.data() as AnyDoc) }));
    const playerDocs = playersSnap.docs.map((d) => ({ id: d.id, ...(d.data() as AnyDoc) }));
    const cashoutDocs = cashoutsSnap.docs.map((d) => ({ id: d.id, ...(d.data() as AnyDoc) }));
    const redeemRequestDocs = requestsSnap.docs.map((d) => ({ id: d.id, ...(d.data() as AnyDoc) }));

    const playersByStaffId = new Map<string, AnyDoc[]>();
    for (const player of playerDocs) {
      const staffId = String(player.createdByStaffId || '').trim();
      if (!staffId) continue;
      const list = playersByStaffId.get(staffId) || [];
      list.push(player);
      playersByStaffId.set(staffId, list);
    }

    const rows = staffDocs
      .filter((staff) => !selectedStaffId || staff.id === selectedStaffId)
      .map((staff) => {
        const staffId = String(staff.id);
        const linkedPlayers = playersByStaffId.get(staffId) || [];
        const linkedPlayerIds = new Set(linkedPlayers.map((p) => String(p.id)));

        const completedCashouts = cashoutDocs.filter(
          (c) =>
            String(c.assignedHandlerUid || '').trim() === staffId &&
            String(c.status || '').toLowerCase() === 'completed'
        );

        const totalCashoutAmount = completedCashouts.reduce(
          (sum, c) => sum + Math.max(0, Number(c.amountNpr || 0)),
          0
        );
        const cashoutsToday = completedCashouts.filter((c) =>
          isWithin(toMs(c.completedAt || c.createdAt), todayStartMs)
        );
        const cashoutsYesterday = completedCashouts.filter((c) => {
          const ms = toMs(c.completedAt || c.createdAt);
          return ms >= yesterdayStartMs && ms < todayStartMs;
        });
        const cashoutsLast7d = completedCashouts.filter((c) =>
          isWithin(toMs(c.completedAt || c.createdAt), sevenDaysAgoMs)
        );

        const playersCreatedToday = linkedPlayers.filter((p) =>
          isWithin(toMs(p.createdAt), todayStartMs)
        ).length;
        const playersCreatedYesterday = linkedPlayers.filter((p) => {
          const ms = toMs(p.createdAt);
          return ms >= yesterdayStartMs && ms < todayStartMs;
        }).length;
        const playersCreatedLast7d = linkedPlayers.filter((p) =>
          isWithin(toMs(p.createdAt), sevenDaysAgoMs)
        ).length;
        const playersCreatedLast24h = linkedPlayers.filter((p) =>
          isWithin(toMs(p.createdAt), oneDayAgoMs)
        ).length;

        const cashoutsLast24h = completedCashouts.filter((c) =>
          isWithin(toMs(c.completedAt || c.createdAt), oneDayAgoMs)
        ).length;

        const quickCashoutPlayerIds = new Set<string>();
        for (const c of completedCashouts) {
          const playerId = String(c.playerUid || '').trim();
          if (!playerId || !linkedPlayerIds.has(playerId)) continue;
          const player = linkedPlayers.find((p) => String(p.id) === playerId);
          if (!player) continue;
          const playerCreatedMs = toMs(player.createdAt);
          const cashoutMs = toMs(c.completedAt || c.createdAt);
          if (playerCreatedMs > 0 && cashoutMs > 0 && cashoutMs - playerCreatedMs <= oneHourMs) {
            quickCashoutPlayerIds.add(playerId);
          }
        }

        const repeatedCashoutPlayerIds = new Set<string>();
        const cashoutCountByPlayer = new Map<string, number>();
        for (const c of completedCashouts) {
          const playerId = String(c.playerUid || '').trim();
          if (!playerId) continue;
          const current = cashoutCountByPlayer.get(playerId) || 0;
          cashoutCountByPlayer.set(playerId, current + 1);
          if (current + 1 >= 3) repeatedCashoutPlayerIds.add(playerId);
        }

        const bonusBlockedPlayers = linkedPlayers.filter((p) => {
          const boolBlocked = Boolean(p.bonusBlocked);
          const untilMs = toMs(p.bonusBlockedUntil);
          return boolBlocked || untilMs > now;
        });

        const redeemLimitHitPlayers = linkedPlayers.filter((p) => {
          const lockStartedAtMs = toMs(p.redeemWindow24h?.lockStartedAt);
          return lockStartedAtMs > 0 && lockStartedAtMs >= sevenDaysAgoMs;
        });

        const pendingReviewCashouts = redeemRequestDocs.filter((req) => {
          const status = String(req.status || '').toLowerCase();
          const playerUid = String(req.playerUid || '').trim();
          return status === 'pending_review' && linkedPlayerIds.has(playerUid);
        });

        let riskScore = 0;
        const riskFlags: string[] = [];

        if (playersCreatedLast24h > 10) {
          riskScore += 10;
          riskFlags.push('Created more than 10 players in 24h');
        }
        if (cashoutsLast24h > 5) {
          riskScore += 10;
          riskFlags.push('Handled more than 5 cashouts in 24h');
        }
        if (quickCashoutPlayerIds.size > 0) {
          riskScore += 15;
          riskFlags.push('Player cashout happened within 1 hour of account creation');
        }
        if (pendingReviewCashouts.length >= 2) {
          riskScore += 20;
          riskFlags.push('Multiple pending_review cashouts linked to staff');
        }
        if (bonusBlockedPlayers.length >= 2) {
          riskScore += 20;
          riskFlags.push('Multiple bonus-blocked players linked to staff');
        }
        if (repeatedCashoutPlayerIds.size > 0) {
          riskScore += 25;
          riskFlags.push('Same player has many cashouts in short time');
        }

        const riskLevel = riskLevelFromScore(riskScore);

        return {
          staff: {
            staffId,
            name: String(staff.username || 'Staff'),
            role: String(staff.role || 'staff'),
            createdAt: staff.createdAt || null,
            rewardBlocked: Boolean(staff.rewardBlocked),
          },
          accountCreation: {
            totalPlayersCreated: linkedPlayers.length,
            playersCreatedToday,
            playersCreatedYesterday,
            playersCreatedLast7d,
          },
          cashoutActivity: {
            totalCashoutRequestsHandled: completedCashouts.length,
            totalCashoutAmountHandled: totalCashoutAmount,
            cashoutsToday: cashoutsToday.length,
            cashoutsYesterday: cashoutsYesterday.length,
            cashoutsLast7d: cashoutsLast7d.length,
            averageCashoutAmount: completedCashouts.length
              ? totalCashoutAmount / completedCashouts.length
              : 0,
          },
          playerRiskPatterns: {
            quickPlayerCreation: playersCreatedLast24h > 10,
            cashoutSoonAfterCreation: quickCashoutPlayerIds.size > 0,
            repeatedCashouts: repeatedCashoutPlayerIds.size > 0,
            redeemLimitHitsOften: redeemLimitHitPlayers.length > 0,
            bonusBlockedPlayers: bonusBlockedPlayers.length,
            pendingReviewCashouts: pendingReviewCashouts.length,
          },
          staffRiskSummary: {
            riskScore,
            riskLevel,
            riskFlags,
          },
          details: {
            playersCreated: linkedPlayers
              .slice(0, 100)
              .map((p) => ({
                playerId: String(p.id),
                username: String(p.username || 'Player'),
                createdAt: p.createdAt || null,
                bonusBlocked: Boolean(p.bonusBlocked) || toMs(p.bonusBlockedUntil) > now,
              })),
            recentCashoutsHandled: completedCashouts
              .sort((a, b) => toMs(b.completedAt || b.createdAt) - toMs(a.completedAt || a.createdAt))
              .slice(0, 100)
              .map((c) => ({
                cashoutId: String(c.id),
                playerId: String(c.playerUid || ''),
                amount: Number(c.amountNpr || 0),
                status: String(c.status || ''),
                createdAt: c.createdAt || null,
                completedAt: c.completedAt || null,
              })),
            riskyPlayers: linkedPlayers
              .filter(
                (p) =>
                  quickCashoutPlayerIds.has(String(p.id)) ||
                  repeatedCashoutPlayerIds.has(String(p.id)) ||
                  (Boolean(p.bonusBlocked) || toMs(p.bonusBlockedUntil) > now) ||
                  toMs(p.redeemWindow24h?.lockStartedAt) > 0
              )
              .slice(0, 100)
              .map((p) => ({
                playerId: String(p.id),
                username: String(p.username || 'Player'),
                createdAt: p.createdAt || null,
                flags: [
                  quickCashoutPlayerIds.has(String(p.id))
                    ? 'cashes out soon after account creation'
                    : null,
                  repeatedCashoutPlayerIds.has(String(p.id))
                    ? 'same player has repeated cashouts'
                    : null,
                  Boolean(p.bonusBlocked) || toMs(p.bonusBlockedUntil) > now
                    ? 'bonusBlocked = true'
                    : null,
                  toMs(p.redeemWindow24h?.lockStartedAt) > 0 ? 'hits redeem limit often' : null,
                ].filter(Boolean),
              })),
            pendingReviewCashouts: pendingReviewCashouts
              .slice(0, 100)
              .map((req) => ({
                requestId: String(req.id),
                playerId: String(req.playerUid || ''),
                amount: Number(req.amount || 0),
                status: String(req.status || ''),
                reason: String(req.pokeMessage || req.reason || 'pending_review'),
                createdAt: req.createdAt || null,
              })),
          },
        };
      });

    return NextResponse.json({
      success: true,
      staffBehaviours: rows,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to load behaviours.';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

