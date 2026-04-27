'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { onAuthStateChanged, User } from 'firebase/auth';
import { doc, getDoc } from 'firebase/firestore';

import ProtectedRoute from '../../components/auth/ProtectedRoute';
import LogoutButton from '../../components/auth/LogoutButton';
import RoleSidebarLayout, { type NavigationItem } from '@/components/navigation/RoleSidebarLayout';
import ImageUploadField from '@/components/common/ImageUploadField';
import { auth, db } from '@/lib/firebase/client';
import { GameLogin } from '@/features/games/gameLogins';
import {
  createPlayerGameLogin,
  getPlayerGameLoginsByCoadmin,
  PlayerGameLogin,
  updatePlayerGameLogin,
} from '@/features/games/playerGameLogins';
import {
  dismissPendingRedeemAsCarer,
  PlayerGameRequest,
} from '@/features/games/playerGameRequests';
import { blockPlayer, PlayerUser, unblockPlayer } from '@/features/users/adminUsers';
import {
  createCarerCashoutRequest,
  saveCarerPaymentDetails,
} from '@/features/cashouts/carerCashouts';
import {
  CarerRechargeRedeemTotals,
  CarerTask,
  completeRechargeRedeemTask,
  completeUsernameTaskForPlayerGame,
  getEffectiveCarerTaskStatus,
  getCurrentUserCoadminUid,
  listenCarerRechargeRedeemTotalsByCoadmin,
  listenToAvailableCarerTasks,
  releaseExpiredCarerTasks,
  sendCarerEscalationAlert,
  sendCarerCashboxInquiryAlert,
  syncCarerTasksForCoadmin,
} from '@/features/games/carerTasks';
import {
  flagPlayerRisk,
  getPlayerRiskSnapshot,
  listenPlayerRiskSnapshotsByCoadmin,
  PlayerRiskSnapshot,
  sendRiskAlertToStaff,
} from '@/features/risk/playerRisk';
import {
  heartbeatShiftSession,
  endShiftSession,
  startShiftSession,
} from '@/features/shifts/userShifts';
import { usePresenceOnlineMap } from '@/features/presence/userPresence';
import { OnlineIndicator } from '@/components/presence/OnlineIndicator';
import {
  claimTaskAndCreateJob,
  listenAutomationUiStatusByTask,
  startAutomationForTask,
  type AutomationUiStatus,
} from '@/features/automation/automationJobs';

type CarerView =
  | 'dashboard'
  | 'create-username'
  | 'tasks'
  | 'view-players'
  | 'login-details';

type CarerIdentity = {
  uid: string;
  username: string;
  paymentQrUrl?: string;
  paymentQrPublicId?: string;
  paymentDetails?: string;
};

type DashboardCard = {
  label: string;
  value: number;
  tone?: 'default' | 'amber' | 'blue' | 'red';
};

type TaskSection = 'pending' | 'mine' | 'completed';

const AUTOMATION_AGENT_ID = 'car001';

function getTimestampMs(value: unknown) {
  if (!value) {
    return 0;
  }

  if (typeof value === 'object' && value !== null) {
    const maybeTimestamp = value as {
      toDate?: () => Date;
      toMillis?: () => number;
      getTime?: () => number;
      seconds?: number;
    };

    if (typeof maybeTimestamp.toMillis === 'function') {
      return maybeTimestamp.toMillis();
    }

    if (typeof maybeTimestamp.toDate === 'function') {
      return maybeTimestamp.toDate().getTime();
    }

    if (typeof maybeTimestamp.getTime === 'function') {
      return maybeTimestamp.getTime();
    }

    if (typeof maybeTimestamp.seconds === 'number') {
      return maybeTimestamp.seconds * 1000;
    }
  }

  return 0;
}

function sortByNewest<T extends { createdAt?: unknown; completedAt?: unknown; pokedAt?: unknown }>(
  items: T[]
) {
  return [...items].sort((left, right) => {
    const leftTime =
      getTimestampMs(left.pokedAt) ||
      getTimestampMs(left.completedAt) ||
      getTimestampMs(left.createdAt);
    const rightTime =
      getTimestampMs(right.pokedAt) ||
      getTimestampMs(right.completedAt) ||
      getTimestampMs(right.createdAt);

    return rightTime - leftTime;
  });
}

function normalizeGameName(gameName: string) {
  return gameName.trim().toLowerCase();
}

function normalizeSiteUrl(siteUrl?: string | null) {
  const trimmed = String(siteUrl || '').trim();

  if (!trimmed) {
    return '';
  }

  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

function getTaskTypeLabel(task: CarerTask) {
  if (task.type === 'create_game_username') {
    return 'Create Username';
  }

  if (task.type === 'recreate_username') {
    return 'Recreate Username';
  }

  if (task.type === 'reset_password') {
    return 'Reset Password';
  }

  if (task.type === 'recharge') {
    return 'Recharge';
  }

  return 'Redeem';
}

function getTaskTypeClass(task: CarerTask) {
  if (task.type === 'create_game_username') {
    return 'bg-yellow-500/20 text-yellow-200';
  }

  if (task.type === 'recreate_username') {
    return 'bg-amber-500/20 text-amber-200';
  }

  if (task.type === 'reset_password') {
    return 'bg-indigo-500/20 text-indigo-200';
  }

  if (task.type === 'recharge') {
    return 'bg-green-500/20 text-green-200';
  }

  return 'bg-red-500/20 text-red-200';
}

function getTaskActionLabel(task: CarerTask) {
  if (task.type === 'recharge' || task.type === 'redeem') {
    return 'Done';
  }

  return 'Done';
}

function isUsernameWorkflowTask(task: CarerTask) {
  return (
    task.type === 'create_game_username' ||
    task.type === 'recreate_username' ||
    task.type === 'reset_password'
  );
}

function formatNpr(value: number) {
  return `NPR ${Math.round(value).toLocaleString()}`;
}

function getRiskTone(level: string, score: number) {
  if (level === 'high') {
    if (score >= 12) return 'text-orange-500';
    if (score >= 10) return 'text-orange-400';
    return 'text-orange-300';
  }
  if (level === 'medium') return 'text-amber-300';
  return 'text-emerald-300';
}

function getRiskCardTone(level: string, score: number) {
  if (level === 'high') {
    if (score >= 12) {
      return 'border-orange-500/70 bg-orange-500/30 hover:bg-orange-500/35';
    }
    if (score >= 10) {
      return 'border-orange-500/55 bg-orange-500/22 hover:bg-orange-500/28';
    }
    return 'border-orange-400/45 bg-orange-400/16 hover:bg-orange-400/24';
  }
  return 'border-rose-300/25 bg-black/30 hover:bg-black/45';
}

/** Rolling window for Work details recharge / redeem sums. */
const WORK_DETAILS_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

function getNepalClockLabel() {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Kathmandu',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
  }).format(new Date());
}

function isNepalNightNow() {
  const hour = Number(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Kathmandu',
      hour: '2-digit',
      hour12: false,
    }).format(new Date())
  );

  return hour >= 22 || hour < 6;
}

export default function CarerPage() {
  const [activeView, setActiveView] = useState<CarerView>('dashboard');
  const [carerIdentity, setCarerIdentity] = useState<CarerIdentity | null>(null);
  const [coadminUid, setCoadminUid] = useState('');

  const [players, setPlayers] = useState<PlayerUser[]>([]);
  const [gameOptions, setGameOptions] = useState<GameLogin[]>([]);
  const [allPlayerLogins, setAllPlayerLogins] = useState<PlayerGameLogin[]>([]);
  const [pendingRequests, setPendingRequests] = useState<PlayerGameRequest[]>([]);
  const [tasks, setTasks] = useState<CarerTask[]>([]);

  const [selectedPlayerUid, setSelectedPlayerUid] = useState('');
  const [editingLogin, setEditingLogin] = useState<PlayerGameLogin | null>(null);
  const [activeUsernameTask, setActiveUsernameTask] = useState<CarerTask | null>(null);

  const [gameName, setGameName] = useState('');
  const [gameUsername, setGameUsername] = useState('');
  const [gamePassword, setGamePassword] = useState('');

  const [bootstrapping, setBootstrapping] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [savingUsername, setSavingUsername] = useState(false);
  const [blockingPlayerUid, setBlockingPlayerUid] = useState<string | null>(null);
  const [taskLoadingId, setTaskLoadingId] = useState<string | null>(null);
  const [dismissRedeemRequestId, setDismissRedeemRequestId] = useState<
    string | null
  >(null);
  const [showRevTotals, setShowRevTotals] = useState(false);
  const [carerRechargeRedeemTotals, setCarerRechargeRedeemTotals] = useState<
    Record<string, CarerRechargeRedeemTotals>
  >({});

  const [errorMessage, setErrorMessage] = useState('');
  const [noticeMessage, setNoticeMessage] = useState('');
  const [showTaskSplash, setShowTaskSplash] = useState(false);
  const [loginDetailsTask, setLoginDetailsTask] = useState<CarerTask | null>(null);
  const [cashBoxNpr, setCashBoxNpr] = useState(0);
  const [nepalClock, setNepalClock] = useState(getNepalClockLabel());
  const [cashoutLoading, setCashoutLoading] = useState(false);
  const [savingPaymentDetails, setSavingPaymentDetails] = useState(false);
  const [showPaymentDetailsPanel, setShowPaymentDetailsPanel] = useState(false);
  const [paymentQrUrl, setPaymentQrUrl] = useState('');
  const [paymentQrPublicId, setPaymentQrPublicId] = useState('');
  const [paymentDetails, setPaymentDetails] = useState('');
  const [showInquiryPanel, setShowInquiryPanel] = useState(false);
  const [inquiryMessage, setInquiryMessage] = useState('');
  const [sendingInquiry, setSendingInquiry] = useState(false);
  const [riskSnapshots, setRiskSnapshots] = useState<PlayerRiskSnapshot[]>([]);
  const [showRiskPanel, setShowRiskPanel] = useState(false);
  const [selectedRiskSnapshot, setSelectedRiskSnapshot] = useState<PlayerRiskSnapshot | null>(
    null
  );
  const [riskActionLoading, setRiskActionLoading] = useState<string | null>(null);
  const [automationLoadingTaskId, setAutomationLoadingTaskId] = useState<string | null>(null);
  const [automationStatusByTaskId, setAutomationStatusByTaskId] = useState<
    Record<string, AutomationUiStatus>
  >({});

  const previousPendingCountRef = useRef(0);
  const shiftSessionIdRef = useRef<string | null>(null);

  const selectedPlayer = useMemo(
    () => players.find((player) => player.uid === selectedPlayerUid) || null,
    [players, selectedPlayerUid]
  );

  const selectedPlayerLogins = useMemo(
    () =>
      sortByNewest(
        allPlayerLogins.filter((login) => login.playerUid === selectedPlayerUid)
      ),
    [allPlayerLogins, selectedPlayerUid]
  );

  const activePlayerUidSet = useMemo(
    () => new Set(players.map((player) => player.uid)),
    [players]
  );

  const existingLoginForSelectedGame = useMemo(() => {
    if (!selectedPlayerUid || !gameName) {
      return null;
    }

    return (
      allPlayerLogins.find(
        (login) =>
          login.playerUid === selectedPlayerUid &&
          normalizeGameName(login.gameName || '') === normalizeGameName(gameName)
      ) || null
    );
  }, [allPlayerLogins, gameName, selectedPlayerUid]);

  const claimablePendingTasks = useMemo(
    () =>
      sortByNewest(
        tasks.filter((task) => getEffectiveCarerTaskStatus(task) === 'pending')
      ),
    [tasks]
  );

  const myInProgressTasks = useMemo(
    () =>
      sortByNewest(
        tasks.filter(
          (task) =>
            getEffectiveCarerTaskStatus(task) === 'in_progress' &&
            task.assignedCarerUid === carerIdentity?.uid
        )
      ),
    [carerIdentity?.uid, tasks]
  );

  const completedTasks = useMemo(
    () => sortByNewest(tasks.filter((task) => task.status === 'completed')),
    [tasks]
  );

  const workDetails30d = useMemo(() => {
    const carerUid = carerIdentity?.uid?.trim();
    if (!carerUid) {
      return {
        rechargeTotal: 0,
        redeemTotal: 0,
        rechargeCount: 0,
        redeemCount: 0,
      };
    }

    const cutoff = Date.now() - WORK_DETAILS_WINDOW_MS;
    let rechargeTotal = 0;
    let redeemTotal = 0;
    let rechargeCount = 0;
    let redeemCount = 0;

    for (const task of tasks) {
      if (task.status !== 'completed') {
        continue;
      }

      if (task.type !== 'recharge' && task.type !== 'redeem') {
        continue;
      }

      const completerUid = String(
        task.completedByCarerUid || task.assignedCarerUid || ''
      ).trim();

      if (completerUid !== carerUid) {
        continue;
      }

      const completedMs = getTimestampMs(task.completedAt);
      if (!completedMs || completedMs < cutoff) {
        continue;
      }

      const amount = Number(task.amount || 0);

      if (task.type === 'recharge') {
        rechargeTotal += amount;
        rechargeCount += 1;
      } else {
        redeemTotal += amount;
        redeemCount += 1;
      }
    }

    return { rechargeTotal, redeemTotal, rechargeCount, redeemCount };
  }, [carerIdentity?.uid, tasks]);

  const redeemShareVsRecharge =
    workDetails30d.rechargeTotal > 0
      ? workDetails30d.redeemTotal / workDetails30d.rechargeTotal
      : workDetails30d.redeemTotal > 0
        ? Number.POSITIVE_INFINITY
        : 0;

  const showRedeemPatternWarning =
    workDetails30d.redeemTotal > 0 &&
    (workDetails30d.rechargeTotal <= 0 || redeemShareVsRecharge > 0.5);

  const usernameNeededCount = useMemo(() => {
    const uniqueLogins = new Set(
      allPlayerLogins.map(
        (login) => `${login.playerUid}::${normalizeGameName(login.gameName || '')}`
      )
    );

    let missingCount = 0;

    for (const player of players) {
      for (const game of gameOptions) {
        if (
          !uniqueLogins.has(
            `${player.uid}::${normalizeGameName(game.gameName || '')}`
          )
        ) {
          missingCount += 1;
        }
      }
    }

    return missingCount;
  }, [allPlayerLogins, gameOptions, players]);

  const pendingRequestCount = pendingRequests.filter(
    (request) => request.status === 'pending'
  ).length;

  const dashboardCards: DashboardCard[] = [
    { label: 'Players Available', value: players.length },
    { label: 'Games Available', value: gameOptions.length },
    { label: 'Username Needed', value: usernameNeededCount, tone: 'amber' },
    { label: 'Pending Requests', value: pendingRequestCount, tone: 'blue' },
  ];
  const riskyPlayers = useMemo(
    () => riskSnapshots.filter((entry) => entry.riskLevel !== 'low').slice(0, 8),
    [riskSnapshots]
  );

  const carerPlayerPresenceUids = useMemo(() => players.map((p) => p.uid), [players]);
  const carerPlayerOnlineByUid = usePresenceOnlineMap(carerPlayerPresenceUids);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
      if (!firebaseUser) {
        setBootstrapping(false);
        setCarerIdentity(null);
        setCoadminUid('');
        return;
      }

      await initializePage(firebaseUser);
    });

    return () => unsubscribe();
  }, []);

  useEffect(() => {
    if (!coadminUid || !carerIdentity?.uid) {
      return;
    }

    const unsubscribe = listenToAvailableCarerTasks(
      coadminUid,
      carerIdentity.uid,
      (incomingTasks) => {
        setTasks(
          sortByNewest(
            incomingTasks.filter((task) => activePlayerUidSet.has(task.playerUid))
          )
        );
      },
      (error) => {
        setErrorMessage(error.message || 'Failed to listen for tasks.');
      }
    );

    return () => unsubscribe();
  }, [activePlayerUidSet, carerIdentity?.uid, coadminUid]);

  useEffect(() => {
    if (!carerIdentity?.uid) {
      setAutomationStatusByTaskId({});
      return;
    }

    const unsubscribe = listenAutomationUiStatusByTask(
      carerIdentity.uid,
      setAutomationStatusByTaskId,
      (error) => {
        setErrorMessage(error.message || 'Failed to listen to automation jobs.');
      }
    );

    return () => unsubscribe();
  }, [carerIdentity?.uid]);

  useEffect(() => {
    if (!coadminUid) {
      setRiskSnapshots([]);
      return;
    }

    const unsubscribe = listenPlayerRiskSnapshotsByCoadmin(
      coadminUid,
      (snapshots) => {
        setRiskSnapshots(snapshots);
      },
      (error) => {
        setErrorMessage(error.message || 'Failed to load risk snapshots.');
      }
    );

    return () => unsubscribe();
  }, [coadminUid]);

  useEffect(() => {
    if (!coadminUid) {
      setCarerRechargeRedeemTotals({});
      return;
    }

    const unsubscribe = listenCarerRechargeRedeemTotalsByCoadmin(
      coadminUid,
      setCarerRechargeRedeemTotals,
      (error) => {
        setErrorMessage(error.message || 'Failed to load recharge/redeem totals.');
      }
    );

    return () => unsubscribe();
  }, [coadminUid]);

  useEffect(() => {
    if (!coadminUid) {
      return;
    }

    const intervalId = window.setInterval(() => {
      void releaseExpiredCarerTasks(coadminUid).catch((error: unknown) => {
        const nextMessage =
          error instanceof Error ? error.message : 'Failed to release expired tasks.';
        setErrorMessage(nextMessage);
      });

      void refreshPageData(false);
    }, 10000);

    return () => window.clearInterval(intervalId);
  }, [coadminUid]);

  useEffect(() => {
    let disposed = false;
    let heartbeatId: number | null = null;

    async function startMyShift() {
      const currentUser = auth.currentUser;
      if (!currentUser) {
        return;
      }
      const userSnap = await getDoc(doc(db, 'users', currentUser.uid));
      if (!userSnap.exists()) {
        return;
      }
      const userData = userSnap.data() as { username?: string };
      const resolvedCoadminUid = await getCurrentUserCoadminUid();
      const sessionId = await startShiftSession({
        coadminUid: resolvedCoadminUid,
        userUid: currentUser.uid,
        userRole: 'carer',
        userUsername: userData.username?.trim() || 'Carer',
      });
      if (disposed) {
        await endShiftSession(sessionId).catch(() => undefined);
        return;
      }
      shiftSessionIdRef.current = sessionId;
      heartbeatId = window.setInterval(() => {
        const id = shiftSessionIdRef.current;
        if (id) {
          void heartbeatShiftSession(id).catch(() => undefined);
        }
      }, 60_000);
    }

    void startMyShift().catch(() => undefined);

    return () => {
      disposed = true;
      if (heartbeatId !== null) {
        window.clearInterval(heartbeatId);
      }
      const id = shiftSessionIdRef.current;
      shiftSessionIdRef.current = null;
      if (id) {
        void endShiftSession(id).catch(() => undefined);
      }
    };
  }, []);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      setNepalClock(getNepalClockLabel());
    }, 1000);

    return () => window.clearInterval(intervalId);
  }, []);

  useEffect(() => {
    const pendingCount = claimablePendingTasks.length;

    if (pendingCount > previousPendingCountRef.current) {
      playPendingNotificationSound();
      setShowTaskSplash(true);
    }

    if (pendingCount === 0) {
      setShowTaskSplash(false);
    }

    previousPendingCountRef.current = pendingCount;
  }, [claimablePendingTasks.length]);

  useEffect(() => {
    if (claimablePendingTasks.length === 0) {
      return;
    }

    const intervalId = window.setInterval(() => {
      setShowTaskSplash(true);
      playPendingNotificationSound();
    }, 5000);

    return () => window.clearInterval(intervalId);
  }, [claimablePendingTasks.length]);

  useEffect(() => {
    if (!selectedPlayerUid) {
      setEditingLogin(null);
      return;
    }

    if (!players.some((player) => player.uid === selectedPlayerUid)) {
      setSelectedPlayerUid('');
      setEditingLogin(null);
      setActiveUsernameTask(null);
      setGameName('');
      setGameUsername('');
      setGamePassword('');
    }
  }, [players, selectedPlayerUid]);

  async function initializePage(firebaseUser: User) {
    setBootstrapping(true);
    setErrorMessage('');

    try {
      const userSnap = await getDoc(doc(db, 'users', firebaseUser.uid));

      if (!userSnap.exists()) {
        throw new Error('Carer profile not found.');
      }

      const userData = userSnap.data() as {
        username?: string;
        paymentQrUrl?: string;
        paymentQrPublicId?: string;
        paymentDetails?: string;
        cashBoxNpr?: number;
      };
      const resolvedCoadminUid = await getCurrentUserCoadminUid();

      setCarerIdentity({
        uid: firebaseUser.uid,
        username: userData.username?.trim() || 'Carer',
        paymentQrUrl: userData.paymentQrUrl?.trim() || '',
        paymentQrPublicId: userData.paymentQrPublicId?.trim() || '',
        paymentDetails: userData.paymentDetails?.trim() || '',
      });
      setPaymentQrUrl(userData.paymentQrUrl?.trim() || '');
      setPaymentQrPublicId(userData.paymentQrPublicId?.trim() || '');
      setPaymentDetails(userData.paymentDetails?.trim() || '');
      setCashBoxNpr(Number(userData.cashBoxNpr || 0));
      setCoadminUid(resolvedCoadminUid);

      await refreshPageData(true, resolvedCoadminUid);
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : 'Failed to load the carer page.'
      );
    } finally {
      setBootstrapping(false);
    }
  }

  async function refreshPageData(showLoader = true, nextCoadminUid = coadminUid) {
    if (!nextCoadminUid) {
      return;
    }

    if (showLoader) {
      setRefreshing(true);
    }

    try {
      await releaseExpiredCarerTasks(nextCoadminUid);

      const synced = await syncCarerTasksForCoadmin(nextCoadminUid);
      const latestLogins = sortByNewest(
        await getPlayerGameLoginsByCoadmin(nextCoadminUid)
      );

      setPlayers(sortByNewest(synced.players));
      setGameOptions(sortByNewest(synced.games));
      setAllPlayerLogins(latestLogins);
      setPendingRequests(sortByNewest(synced.pendingRequests));
      setTasks((currentTasks) =>
        sortByNewest(
          currentTasks.filter((task) =>
            synced.players.some((player) => player.uid === task.playerUid)
          )
        )
      );
      setErrorMessage('');
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : 'Failed to refresh carer data.'
      );
    } finally {
      if (showLoader) {
        setRefreshing(false);
      }
    }
  }

  function resetUsernameForm() {
    setEditingLogin(null);
    setActiveUsernameTask(null);
    setGameName('');
    setGameUsername('');
    setGamePassword('');
  }

  function playPendingNotificationSound() {
    const audio = new Audio('/urgency-sound.mp3');
    audio.volume = 0.9;
    void audio.play().catch(() => undefined);
  }

  async function handleUsernameSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!selectedPlayer) {
      setErrorMessage('Select a player first.');
      return;
    }

    if (!coadminUid) {
      setErrorMessage('Coadmin scope is still loading. Please try again.');
      return;
    }

    if (!gameName.trim() || !gameUsername.trim() || !gamePassword.trim()) {
      setErrorMessage('Player, game, username, and password are all required.');
      return;
    }

    setSavingUsername(true);
    setErrorMessage('');
    setNoticeMessage('');

    try {
      const loginToUpdate = editingLogin || existingLoginForSelectedGame;

      if (loginToUpdate) {
        await updatePlayerGameLogin(loginToUpdate.id, {
          gameName: gameName.trim(),
          gameUsername: gameUsername.trim(),
          gamePassword,
        });
        setNoticeMessage('Game username updated successfully.');
      } else {
        await createPlayerGameLogin({
          playerUid: selectedPlayer.uid,
          playerUsername: selectedPlayer.username || 'Player',
          gameName: gameName.trim(),
          gameUsername: gameUsername.trim(),
          gamePassword,
          coadminUid,
        });
        setNoticeMessage('Game username created successfully.');
      }

      const rewardSummary = await completeUsernameTaskForPlayerGame(
        coadminUid,
        selectedPlayer.uid,
        gameName.trim()
      );

      if (rewardSummary.totalAwardNpr > 0) {
        setCashBoxNpr((previous) => previous + rewardSummary.totalAwardNpr);
        setNoticeMessage(
          `Username task completed. Reward +${formatNpr(
            rewardSummary.totalAwardNpr
          )} added to Cash Box.`
        );
      }
      await refreshPageData(false, coadminUid);
      resetUsernameForm();
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : 'Failed to save the username.'
      );
    } finally {
      setSavingUsername(false);
    }
  }

  async function handleStartTask(task: CarerTask) {
    if (!carerIdentity) {
      setErrorMessage('Carer profile not ready yet. Please try again.');
      return;
    }

    setAutomationLoadingTaskId(task.id);
    setErrorMessage('');
    setNoticeMessage('');

    try {
      const loginForTask =
        allPlayerLogins.find(
          (login) =>
            login.playerUid === task.playerUid &&
            normalizeGameName(login.gameName || '') ===
              normalizeGameName(task.gameName || '')
        ) || null;

      await claimTaskAndCreateJob({
        taskId: task.id,
        agentId: AUTOMATION_AGENT_ID,
        currentUsername: loginForTask?.gameUsername || null,
        carerName: carerIdentity.username,
      });

      setAutomationStatusByTaskId((previous) => ({
        ...previous,
        [task.id]: 'waiting',
      }));
      setNoticeMessage('Task claimed and automation job queued.');
    } catch (error) {
      const fallback =
        error instanceof Error ? error.message : 'Failed to queue the task.';
      if (fallback === 'Task already claimed') {
        setErrorMessage('This task was already claimed by another carer.');
      } else if (fallback === 'Task not found') {
        setErrorMessage('This task no longer exists.');
      } else {
        setErrorMessage(fallback);
      }
    } finally {
      setAutomationLoadingTaskId(null);
    }
  }

  async function handleDismissPendingRedeem(task: CarerTask) {
    const requestId = task.requestId?.trim();

    if (!requestId) {
      setErrorMessage('This task has no linked request to dismiss.');
      return;
    }

    if (task.type !== 'redeem') {
      return;
    }

    const ok = window.confirm(
      'Dismiss this redeem request as fake or mistaken? It will be removed from the queue.'
    );

    if (!ok) {
      return;
    }

    setDismissRedeemRequestId(requestId);
    setErrorMessage('');
    setNoticeMessage('');

    try {
      await dismissPendingRedeemAsCarer(requestId);
      setNoticeMessage('Pending redeem request dismissed.');
      await refreshPageData(false);
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : 'Failed to dismiss redeem request.'
      );
    } finally {
      setDismissRedeemRequestId(null);
    }
  }

  async function handleCompleteRechargeRedeem(task: CarerTask) {
    setTaskLoadingId(task.id);
    setErrorMessage('');
    setNoticeMessage('');

    try {
      const rewardSummary = await completeRechargeRedeemTask(task);
      setCashBoxNpr((previous) => previous + rewardSummary.totalAwardNpr);
      setNoticeMessage(
        `Task completed. Reward +${formatNpr(
          rewardSummary.totalAwardNpr
        )} added to Cash Box.`
      );
      await refreshPageData(false);
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : 'Failed to complete the task.'
      );
    } finally {
      setTaskLoadingId(null);
    }
  }

  async function handleStartAutomation(task: CarerTask) {
    setAutomationLoadingTaskId(task.id);
    setErrorMessage('');
    setNoticeMessage('');
    const loginForTask =
      allPlayerLogins.find(
        (login) =>
          login.playerUid === task.playerUid &&
          normalizeGameName(login.gameName || '') ===
            normalizeGameName(task.gameName || '')
      ) || null;
    try {
      await startAutomationForTask({
        agentId: AUTOMATION_AGENT_ID,
        taskId: task.id,
        taskLabel: getTaskTypeLabel(task),
        player: task.playerUsername || 'Player',
        game: task.gameName || 'Unknown Game',
        currentUsername: loginForTask?.gameUsername || null,
        amount: task.amount ?? null,
        originalTask: task as Record<string, unknown>,
      });
      setAutomationStatusByTaskId((previous) => ({
        ...previous,
        [task.id]: 'waiting',
      }));
      setNoticeMessage('Automation job queued. Waiting for local agent.');
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : 'Failed to start automation.'
      );
    } finally {
      setAutomationLoadingTaskId(null);
    }
  }

  async function handleCashoutRequest() {
    if (!carerIdentity || !coadminUid) {
      setErrorMessage('Cashout is not ready. Please wait.');
      return;
    }

    if (cashBoxNpr <= 0) {
      setErrorMessage('Cash box is empty.');
      return;
    }

    if (!paymentQrUrl.trim()) {
      setErrorMessage('Please add payment QR details before requesting cashout.');
      setShowPaymentDetailsPanel(true);
      return;
    }

    setCashoutLoading(true);
    setErrorMessage('');
    setNoticeMessage('');

    try {
      await createCarerCashoutRequest({
        coadminUid,
        carerUid: carerIdentity.uid,
        carerUsername: carerIdentity.username,
        amountNpr: cashBoxNpr,
        paymentQrUrl: paymentQrUrl.trim(),
        paymentQrPublicId: paymentQrPublicId.trim(),
        paymentDetails: paymentDetails.trim(),
      });
      setNoticeMessage(
        `Cashout request of ${formatNpr(cashBoxNpr)} sent to coadmin successfully.`
      );
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Failed to request cashout.');
    } finally {
      setCashoutLoading(false);
    }
  }

  async function handleSavePaymentDetails() {
    setSavingPaymentDetails(true);
    setErrorMessage('');
    setNoticeMessage('');

    try {
      await saveCarerPaymentDetails({
        paymentQrUrl,
        paymentQrPublicId,
        paymentDetails,
      });
      setCarerIdentity((previous) =>
        previous
          ? {
              ...previous,
              paymentQrUrl: paymentQrUrl.trim(),
              paymentQrPublicId: paymentQrPublicId.trim(),
              paymentDetails: paymentDetails.trim(),
            }
          : previous
      );
      setNoticeMessage('Payment details saved successfully.');
      setShowPaymentDetailsPanel(false);
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : 'Failed to save payment details.'
      );
    } finally {
      setSavingPaymentDetails(false);
    }
  }

  async function handleSendInquiry() {
    if (!coadminUid) {
      setErrorMessage('Coadmin is not ready yet. Please try again.');
      return;
    }

    const cleanMessage = inquiryMessage.trim();

    if (cleanMessage.length < 8) {
      setErrorMessage('Please write a clear inquiry message (at least 8 characters).');
      return;
    }

    setSendingInquiry(true);
    setErrorMessage('');
    setNoticeMessage('');

    try {
      await sendCarerCashboxInquiryAlert({
        coadminUid,
        message: cleanMessage,
      });
      setNoticeMessage('Urgent inquiry sent to coadmin and staff.');
      setShowInquiryPanel(false);
      setInquiryMessage('');
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Failed to send inquiry.');
    } finally {
      setSendingInquiry(false);
    }
  }

  async function handleCarerEscalation(task: CarerTask) {
    setTaskLoadingId(task.id);
    setErrorMessage('');
    setNoticeMessage('');

    try {
      await sendCarerEscalationAlert(task);
      setNoticeMessage('Help alert sent to coadmin and staff.');
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : 'Failed to send help alert.'
      );
    } finally {
      setTaskLoadingId(null);
    }
  }

  function handleSelectPlayer(playerUid: string) {
    setSelectedPlayerUid(playerUid);
    setEditingLogin(null);
    setActiveUsernameTask(null);
    setGameName('');
    setGameUsername('');
    setGamePassword('');
    setErrorMessage('');
    setNoticeMessage('');
  }

  function startEdit(login: PlayerGameLogin) {
    setSelectedPlayerUid(login.playerUid);
    setEditingLogin(login);
    setActiveUsernameTask(null);
    setGameName(login.gameName || '');
    setGameUsername(login.gameUsername || '');
    setGamePassword(login.gamePassword || '');
    setActiveView('create-username');
    setErrorMessage('');
    setNoticeMessage('');
  }

  function continueUsernameTask(task: CarerTask) {
    const matchingPlayer = players.find((player) => player.uid === task.playerUid);

    if (!matchingPlayer) {
      setErrorMessage('The player for this task could not be found.');
      return;
    }

    setSelectedPlayerUid(matchingPlayer.uid);
    setActiveUsernameTask(task);
    setEditingLogin(null);
    setGameName(task.gameName || '');
    setGameUsername('');
    setGamePassword('');
    setActiveView('create-username');
    setShowTaskSplash(false);
    setNoticeMessage('');
  }

  async function handleTogglePlayerStatus(player: PlayerUser) {
    setBlockingPlayerUid(player.uid);
    setErrorMessage('');
    setNoticeMessage('');

    try {
      if (player.status === 'disabled') {
        await unblockPlayer(player);
      } else {
        await blockPlayer(player);
      }

      await refreshPageData(false);
      setNoticeMessage(
        `Player ${player.status === 'disabled' ? 'unblocked' : 'blocked'} successfully.`
      );
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : 'Failed to update player status.'
      );
    } finally {
      setBlockingPlayerUid(null);
    }
  }

  async function handleOpenRiskPanel(playerUid: string) {
    setRiskActionLoading(`open-${playerUid}`);
    setErrorMessage('');
    try {
      const snapshot = await getPlayerRiskSnapshot(playerUid);
      if (!snapshot) {
        setErrorMessage('Risk data is not ready for this player yet.');
        return;
      }
      setSelectedRiskSnapshot(snapshot);
      setShowRiskPanel(true);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Failed to load risk profile.');
    } finally {
      setRiskActionLoading(null);
    }
  }

  async function handleFlagRiskPlayer() {
    if (!selectedRiskSnapshot) {
      return;
    }

    setRiskActionLoading(`flag-${selectedRiskSnapshot.playerUid}`);
    setErrorMessage('');
    try {
      await flagPlayerRisk({
        playerUid: selectedRiskSnapshot.playerUid,
        playerUsername: selectedRiskSnapshot.playerUsername,
        reason: 'Carer flagged player for risk review.',
      });
      setNoticeMessage('Player flagged for staff review.');
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Failed to flag player.');
    } finally {
      setRiskActionLoading(null);
    }
  }

  async function handleSendRiskAlertToStaff() {
    if (!selectedRiskSnapshot || !coadminUid) {
      return;
    }

    setRiskActionLoading(`alert-${selectedRiskSnapshot.playerUid}`);
    setErrorMessage('');
    try {
      await sendRiskAlertToStaff({
        playerUid: selectedRiskSnapshot.playerUid,
        playerUsername: selectedRiskSnapshot.playerUsername,
        coadminUid,
        reason: `Risk alert from carer: ${selectedRiskSnapshot.alerts[0] || 'Suspicious recycle pattern observed.'}`,
      });
      setNoticeMessage('Risk alert sent to staff.');
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Failed to send risk alert.');
    } finally {
      setRiskActionLoading(null);
    }
  }

  function renderDashboard() {
    return (
      <div className="space-y-6">
        <div>
          <h2 className="text-3xl font-bold">Dashboard</h2>
          <p className="mt-2 text-sm text-neutral-400">
            Track players, games, missing usernames, and shared recharge/redeem requests.
          </p>
        </div>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div className="rounded-2xl border border-emerald-500/20 bg-emerald-500/10 p-6">
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm text-emerald-100/80">Cash Box</p>
              <button
                type="button"
                onClick={() => setShowInquiryPanel(true)}
                className="rounded-lg bg-red-600 px-3 py-1.5 text-xs font-bold text-white hover:bg-red-500"
              >
                Inquire
              </button>
            </div>
            <p className="mt-2 text-3xl font-bold text-emerald-200">
              {formatNpr(cashBoxNpr)}
            </p>
            <p className="mt-2 text-xs text-emerald-100/80">
              {isNepalNightNow() ? 'Night bonus active (+10%-15%).' : ''}
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => void handleCashoutRequest()}
                disabled={cashoutLoading || cashBoxNpr <= 0}
                className="rounded-xl bg-emerald-500 px-4 py-2 text-xs font-bold text-black hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {cashoutLoading ? 'Sending...' : 'Cashout'}
              </button>
              <button
                type="button"
                onClick={() => setShowPaymentDetailsPanel(true)}
                className="rounded-xl bg-white/10 px-4 py-2 text-xs font-bold text-white hover:bg-white/20"
              >
                Payment Details
              </button>
            </div>
          </div>

          <div className="rounded-2xl border border-blue-500/20 bg-blue-500/10 p-6">
            <p className="text-sm text-blue-100/80">Nepal Clock</p>
            <p className="mt-2 text-3xl font-bold text-blue-200">{nepalClock}</p>
            <p className="mt-2 text-xs text-blue-100/80">Timezone: Asia/Kathmandu</p>
          </div>
        </div>

        <div className="rounded-2xl border border-amber-500/30 bg-amber-950/25 p-6">
          <h3 className="text-lg font-bold text-amber-100">Work details</h3>
          <p className="mt-1 text-xs text-amber-200/70">
            Your completed recharge and redeem totals in the last 30 days (tasks you
            finished).
          </p>
          <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="rounded-xl border border-emerald-500/25 bg-emerald-950/30 p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-emerald-200/80">
                Total recharged (30d)
              </p>
              <p className="mt-2 text-2xl font-bold text-emerald-100">
                {formatNpr(workDetails30d.rechargeTotal)}
              </p>
              <p className="mt-1 text-xs text-emerald-200/60">
                {workDetails30d.rechargeCount} completed task
                {workDetails30d.rechargeCount === 1 ? '' : 's'}
              </p>
            </div>
            <div className="rounded-xl border border-rose-500/25 bg-rose-950/30 p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-rose-200/80">
                Total redeemed (30d)
              </p>
              <p className="mt-2 text-2xl font-bold text-rose-100">
                {formatNpr(workDetails30d.redeemTotal)}
              </p>
              <p className="mt-1 text-xs text-rose-200/60">
                {workDetails30d.redeemCount} completed task
                {workDetails30d.redeemCount === 1 ? '' : 's'}
              </p>
            </div>
          </div>
          {workDetails30d.rechargeTotal > 0 && workDetails30d.redeemTotal > 0 ? (
            <p className="mt-3 text-xs text-amber-100/60">
              Redeem vs recharge (amount):{' '}
              <span className="font-semibold text-amber-200">
                {Math.round(
                  (workDetails30d.redeemTotal / workDetails30d.rechargeTotal) * 100
                )}
                %
              </span>{' '}
              of recharge.
            </p>
          ) : null}

          {showRedeemPatternWarning ? (
            <div
              role="alert"
              className="mt-4 rounded-xl border border-rose-500/45 bg-rose-950/50 p-4 text-sm leading-relaxed text-rose-50"
            >
              <p className="font-bold text-rose-200">⚠️ Redeem pattern notice</p>
              <p className="mt-2">
                Your account may be reviewed to confirm redeem requests were legitimate and
                match real gameplay. Redeem totals that look unlikely compared to recharges
                can be flagged.
              </p>
              <p className="mt-2">
                Mistakes or abuse found on a regular basis can lead to{' '}
                <span className="font-semibold text-rose-200">account deactivation</span>.
              </p>
            </div>
          ) : null}
        </div>

        {riskyPlayers.length > 0 && (
          <div className="rounded-2xl border border-orange-500/35 bg-orange-500/10 p-6">
            <h3 className="text-lg font-bold text-rose-200">Risky Players</h3>
            <div className="mt-3 space-y-2">
              {riskyPlayers.map((risk) => (
                <button
                  key={risk.playerUid}
                  type="button"
                  onClick={() => void handleOpenRiskPanel(risk.playerUid)}
                  className={`flex w-full items-center justify-between rounded-xl border px-4 py-3 text-left ${getRiskCardTone(
                    risk.riskLevel,
                    risk.riskScore || 0
                  )}`}
                >
                  <div>
                    <p className="text-sm font-semibold text-white">{risk.playerUsername}</p>
                    <p className="text-xs text-rose-100/70">
                      {risk.alerts[0] || 'Risk pattern detected'} · Last:{' '}
                      {risk.lastActivityAt?.toDate?.().toLocaleString?.() || 'N/A'}
                    </p>
                  </div>
                  <span
                    className={`text-xs font-bold uppercase ${getRiskTone(
                      risk.riskLevel,
                      risk.riskScore || 0
                    )}`}
                  >
                    {risk.riskLevel} ({risk.riskScore})
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-5">
          {dashboardCards.map((card) => {
            const toneClass =
              card.tone === 'amber'
                ? 'border-yellow-500/20 bg-yellow-500/10 text-yellow-100'
                : card.tone === 'blue'
                  ? 'border-blue-500/20 bg-blue-500/10 text-blue-100'
                  : card.tone === 'red'
                    ? 'border-red-500/20 bg-red-500/10 text-red-100'
                    : 'border-white/10 bg-white/5 text-white';

            return (
              <div key={card.label} className={`rounded-2xl border p-6 ${toneClass}`}>
                <p className="text-sm opacity-80">{card.label}</p>
                <p className="mt-2 text-3xl font-bold">{card.value}</p>
              </div>
            );
          })}
        </div>

        <div className="flex flex-wrap gap-3">
          <button
            onClick={() => {
              setActiveView('tasks');
              void refreshPageData();
            }}
            className="rounded-2xl bg-white px-4 py-3 text-sm font-bold text-black hover:bg-neutral-200"
          >
            Open Tasks
          </button>

          <button
            onClick={() => {
              const firstRiskPlayer = riskyPlayers[0]?.playerUid || players[0]?.uid || '';
              if (!firstRiskPlayer) {
                setErrorMessage('No player available to inspect.');
                return;
              }
              void handleOpenRiskPanel(firstRiskPlayer);
            }}
            className="rounded-2xl bg-white/10 px-4 py-3 text-sm font-bold text-white hover:bg-white/20"
          >
            View Player Risk Data
          </button>
        </div>
      </div>
    );
  }

  function renderCreateUsername() {
    return (
      <div className="space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h2 className="text-3xl font-bold">Create Username</h2>
            <p className="mt-2 text-sm text-neutral-400">
              Create or update a player game username from the shared coadmin game list.
            </p>
          </div>

          {activeUsernameTask && (
            <div className="rounded-2xl border border-yellow-500/20 bg-yellow-500/10 px-4 py-3 text-sm text-yellow-100">
              Active task: {(activeUsernameTask.playerUsername || 'Player').trim()} /{' '}
              {(activeUsernameTask.gameName || 'Unknown Game').trim()}
            </div>
          )}
        </div>

        <div className="grid grid-cols-1 gap-6 xl:grid-cols-[320px_1fr]">
          <div className="rounded-2xl border border-white/10 bg-white/5 p-5">
            <div className="mb-4">
              <h3 className="text-lg font-semibold">Select Player</h3>
              <p className="mt-1 text-sm text-neutral-400">
                Choose a player before creating or editing a game login.
              </p>
            </div>

            {players.length === 0 ? (
              <p className="text-sm text-neutral-400">No players available.</p>
            ) : (
              <div className="space-y-3">
                {players.map((player) => {
                  const isSelected = player.uid === selectedPlayerUid;

                  return (
                    <button
                      key={player.uid}
                      onClick={() => handleSelectPlayer(player.uid)}
                      className={`w-full rounded-2xl px-4 py-3 text-left ${
                        isSelected
                          ? 'bg-white text-black'
                          : 'bg-neutral-900 text-white hover:bg-neutral-800'
                      }`}
                    >
                      <p className="font-semibold">{player.username || 'Unnamed Player'}</p>
                      <p
                        className={`mt-1 text-xs ${
                          isSelected ? 'text-black/60' : 'text-neutral-500'
                        }`}
                      >
                        {player.status || 'unknown'}
                      </p>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          <div className="space-y-6">
            <form
              onSubmit={handleUsernameSubmit}
              className="rounded-2xl border border-white/10 bg-white/5 p-6"
            >
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <div className="md:col-span-2">
                  <p className="mb-2 text-sm text-neutral-400">Selected Player</p>
                  <div className="rounded-xl bg-neutral-900 px-4 py-3 font-semibold">
                    {selectedPlayer?.username || 'No player selected'}
                  </div>
                </div>

                <label className="block">
                  <span className="mb-2 block text-sm text-neutral-400">Game</span>
                  <select
                    value={gameName}
                    onChange={(event) => setGameName(event.target.value)}
                    className="w-full rounded-xl border border-white/10 bg-neutral-900 px-4 py-3 text-white outline-none focus:border-white/30"
                    disabled={!selectedPlayer}
                    required
                  >
                    <option value="">Select Game</option>
                    {gameOptions.map((game) => (
                      <option key={game.id} value={game.gameName}>
                        {game.gameName || 'Unnamed Game'}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="block">
                  <span className="mb-2 block text-sm text-neutral-400">Game Username</span>
                  <input
                    value={gameUsername}
                    onChange={(event) => setGameUsername(event.target.value)}
                    className="w-full rounded-xl border border-white/10 bg-neutral-900 px-4 py-3 text-white outline-none focus:border-white/30"
                    placeholder="Enter game username"
                    disabled={!selectedPlayer}
                    required
                  />
                </label>

                <label className="block md:col-span-2">
                  <span className="mb-2 block text-sm text-neutral-400">Game Password</span>
                  <input
                    value={gamePassword}
                    onChange={(event) => setGamePassword(event.target.value)}
                    className="w-full rounded-xl border border-white/10 bg-neutral-900 px-4 py-3 text-white outline-none focus:border-white/30"
                    placeholder="Enter game password"
                    disabled={!selectedPlayer}
                    required
                  />
                </label>
              </div>

              {existingLoginForSelectedGame && !editingLogin && (
                <div className="mt-4 rounded-2xl border border-blue-500/20 bg-blue-500/10 px-4 py-3 text-sm text-blue-100">
                  A username already exists for this player/game. Submitting will update it.
                </div>
              )}

              <div className="mt-6 flex flex-wrap gap-3">
                <button
                  type="submit"
                  disabled={!selectedPlayer || savingUsername}
                  className="rounded-xl bg-white px-4 py-3 font-semibold text-black hover:bg-neutral-200 disabled:opacity-60"
                >
                  {savingUsername
                    ? editingLogin || existingLoginForSelectedGame
                      ? 'Updating...'
                      : 'Creating...'
                    : editingLogin || existingLoginForSelectedGame
                      ? 'Update Username'
                      : 'Create Username'}
                </button>

                {(editingLogin || activeUsernameTask || gameName || gameUsername || gamePassword) && (
                  <button
                    type="button"
                    onClick={resetUsernameForm}
                    className="rounded-xl bg-white/10 px-4 py-3 font-semibold text-white hover:bg-white/20"
                  >
                    Cancel
                  </button>
                )}
              </div>
            </form>

            <div className="rounded-2xl border border-white/10 bg-white/5 p-6">
              <div className="mb-4">
                <h3 className="text-xl font-bold">Existing Usernames</h3>
                <p className="mt-1 text-sm text-neutral-400">
                  Review and edit any existing username for the selected player.
                </p>
              </div>

              {!selectedPlayer ? (
                <p className="text-sm text-neutral-400">
                  Select a player to view existing usernames.
                </p>
              ) : selectedPlayerLogins.length === 0 ? (
                <p className="text-sm text-neutral-400">
                  No usernames have been created for this player yet.
                </p>
              ) : (
                <div className="space-y-3">
                  {selectedPlayerLogins.map((login) => (
                    <div
                      key={login.id}
                      className="rounded-2xl border border-white/10 bg-neutral-900 p-4"
                    >
                      <div className="flex flex-wrap items-start justify-between gap-4">
                        <div>
                          <h4 className="text-lg font-bold">
                            {login.gameName || 'Unnamed Game'}
                          </h4>
                          <p className="mt-2 text-sm text-neutral-400">
                            Username:{' '}
                            <span className="text-white">
                              {login.gameUsername || 'Not set'}
                            </span>
                          </p>
                          <p className="mt-1 text-sm text-neutral-400">
                            Password:{' '}
                            <span className="text-white">
                              {login.gamePassword || 'Not set'}
                            </span>
                          </p>
                        </div>

                        <button
                          onClick={() => startEdit(login)}
                          className="rounded-xl bg-yellow-400 px-4 py-2 text-sm font-bold text-black hover:bg-yellow-300"
                        >
                          Edit
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  function renderTaskCard(task: CarerTask, section: TaskSection) {
    const loginForTask =
      allPlayerLogins.find(
        (login) =>
          login.playerUid === task.playerUid &&
          normalizeGameName(login.gameName || '') ===
            normalizeGameName(task.gameName || '')
      ) || null;

    const isRequestTask = task.type === 'recharge' || task.type === 'redeem';

    const statusLabel =
      section === 'pending'
        ? 'Pending'
        : section === 'mine'
          ? 'In Progress'
          : 'Completed';
    const automationStatus =
      automationStatusByTaskId[task.id] || task.automationStatus || null;
    const isAutomationQueued =
      automationStatus === 'waiting' || automationStatus === 'running';

    return (
      <div
        key={task.id}
        className="rounded-2xl border border-white/10 bg-neutral-950/70 p-4"
      >
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <span
                className={`rounded-full px-3 py-1 text-xs font-bold uppercase ${getTaskTypeClass(task)}`}
              >
                {getTaskTypeLabel(task)}
              </span>

              <span className="rounded-full bg-white/10 px-3 py-1 text-xs text-white">
                {statusLabel}
              </span>
              {automationStatus && (
                <span className="rounded-full bg-violet-500/20 px-3 py-1 text-xs font-bold uppercase text-violet-200">
                  Automation: {automationStatus}
                </span>
              )}
            </div>

            <h4 className="text-lg font-bold">
              {(task.playerUsername || 'Player').trim()} /{' '}
              {(task.gameName || 'Unknown Game').trim()}
            </h4>

            <p className="mt-2 text-sm text-neutral-400">
              Player: <span className="text-white">{task.playerUsername || 'Player'}</span>
            </p>

            <p className="mt-1 text-sm text-neutral-400">
              Game: <span className="text-white">{task.gameName || 'Unknown Game'}</span>
            </p>

            <p className="mt-1 text-sm text-neutral-400">
              Current Username:{' '}
              <span className="text-white">
                {loginForTask?.gameUsername || 'Not assigned'}
              </span>
            </p>

            {typeof task.amount === 'number' && (
              <p className="mt-1 text-sm text-neutral-400">
                Amount: <span className="text-white">{task.amount}</span>
              </p>
            )}

            {task.assignedCarerUsername && (
              <p className="mt-1 text-sm text-neutral-400">
                Assigned Carer:{' '}
                <span className="text-white">{task.assignedCarerUsername}</span>
              </p>
            )}
          </div>

          {section === 'pending' && (
            <div className="flex flex-col gap-2">
              <button
                onClick={() => setLoginDetailsTask(task)}
                className="rounded-xl bg-blue-500/20 px-4 py-2 text-sm font-bold text-blue-100 hover:bg-blue-500/30"
              >
                Login Details
              </button>
              {task.type === 'redeem' && task.requestId && (
                <button
                  type="button"
                  onClick={() => void handleDismissPendingRedeem(task)}
                  disabled={
                    dismissRedeemRequestId === task.requestId ||
                    taskLoadingId === task.id
                  }
                  className="rounded-xl border border-amber-500/40 bg-amber-500/15 px-4 py-2 text-sm font-bold text-amber-100 hover:bg-amber-500/25 disabled:opacity-60"
                >
                  {dismissRedeemRequestId === task.requestId
                    ? 'Dismissing...'
                    : 'Dismiss fake redeem'}
                </button>
              )}
              <button
                onClick={() => void handleStartTask(task)}
                disabled={automationLoadingTaskId === task.id || isAutomationQueued}
                className="rounded-xl bg-white px-4 py-2 text-sm font-bold text-black hover:bg-neutral-200 disabled:opacity-60"
              >
                {automationLoadingTaskId === task.id
                  ? 'Queueing...'
                  : automationStatus === 'waiting'
                    ? 'Queued'
                    : automationStatus === 'running'
                      ? 'Running...'
                      : 'Start Task'}
              </button>
            </div>
          )}

          {section === 'mine' && isUsernameWorkflowTask(task) && (
            <div className="flex flex-col gap-2">
              <button
                onClick={() => setLoginDetailsTask(task)}
                className="rounded-xl bg-blue-500/20 px-4 py-2 text-sm font-bold text-blue-100 hover:bg-blue-500/30"
              >
                Login Details
              </button>
              <button
                onClick={() => void handleStartAutomation(task)}
                disabled={automationLoadingTaskId === task.id || isAutomationQueued}
                className="rounded-xl border border-violet-400/40 bg-violet-500/15 px-4 py-2 text-sm font-bold text-violet-100 hover:bg-violet-500/25 disabled:opacity-60"
              >
                {automationLoadingTaskId === task.id
                  ? 'Queueing...'
                  : automationStatus === 'waiting'
                    ? 'Queued'
                    : automationStatus === 'running'
                      ? 'Running...'
                      : 'Start Automation'}
              </button>
              <button
                onClick={() => continueUsernameTask(task)}
                className="rounded-xl bg-yellow-400 px-4 py-2 text-sm font-bold text-black hover:bg-yellow-300"
              >
                Continue Task
              </button>
            </div>
          )}

          {section === 'mine' && isRequestTask && (
            <div className="flex flex-col gap-2">
              <button
                onClick={() => setLoginDetailsTask(task)}
                className="rounded-xl bg-blue-500/20 px-4 py-2 text-sm font-bold text-blue-100 hover:bg-blue-500/30"
              >
                Login Details
              </button>
              <button
                onClick={() => void handleStartAutomation(task)}
                disabled={automationLoadingTaskId === task.id || isAutomationQueued}
                className="rounded-xl border border-violet-400/40 bg-violet-500/15 px-4 py-2 text-sm font-bold text-violet-100 hover:bg-violet-500/25 disabled:opacity-60"
              >
                {automationLoadingTaskId === task.id
                  ? 'Queueing...'
                  : automationStatus === 'waiting'
                    ? 'Queued'
                    : automationStatus === 'running'
                      ? 'Running...'
                      : 'Start Automation'}
              </button>
              <button
                onClick={() => void handleCompleteRechargeRedeem(task)}
                disabled={taskLoadingId === task.id}
                className="rounded-xl bg-white px-4 py-2 text-sm font-bold text-black hover:bg-neutral-200 disabled:opacity-60"
              >
                {taskLoadingId === task.id ? 'Saving...' : getTaskActionLabel(task)}
              </button>
            </div>
          )}

        </div>
      </div>
    );
  }

  function renderTasks() {
    return (
      <div className="space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h2 className="text-3xl font-bold">Tasks</h2>
            <p className="mt-2 text-sm text-neutral-400">
              Shared task pool for all carers under the same coadmin.
            </p>
          </div>

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => setShowRevTotals((open) => !open)}
              className="rounded-xl border border-emerald-500/40 bg-emerald-500/15 px-4 py-2 text-sm font-bold text-emerald-100 hover:bg-emerald-500/25"
            >
              Rev
            </button>
            <button
              onClick={() => void refreshPageData()}
              className="rounded-xl bg-white px-4 py-2 text-sm font-bold text-black hover:bg-neutral-200"
            >
              Refresh
            </button>
          </div>
        </div>

        {showRevTotals && carerIdentity && (
          <div className="rounded-2xl border border-emerald-500/30 bg-emerald-950/30 p-5 text-sm text-emerald-50">
            <p className="text-xs font-bold uppercase tracking-wider text-emerald-200/80">
              Your completed totals (recharge / redeem amounts)
            </p>
            <p className="mt-3 text-lg font-bold text-white">
              Total recharged:{' '}
              <span className="text-emerald-300">
                {formatNpr(
                  carerRechargeRedeemTotals[carerIdentity.uid]?.totalRechargeAmount ||
                    0
                )}
              </span>
            </p>
            <p className="mt-1 text-lg font-bold text-white">
              Total redeemed:{' '}
              <span className="text-emerald-300">
                {formatNpr(
                  carerRechargeRedeemTotals[carerIdentity.uid]?.totalRedeemAmount || 0
                )}
              </span>
            </p>
            <p className="mt-3 text-xs text-emerald-100/60">
              Based on tasks you completed under this coadmin. Updates as you finish
              recharge and redeem tasks.
            </p>
          </div>
        )}

        <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
          <div className="rounded-2xl border border-red-500/20 bg-red-500/10 p-5">
            <h3 className="mb-4 text-xl font-bold text-red-200">Pending Tasks</h3>
            {claimablePendingTasks.length === 0 ? (
              <p className="text-sm text-red-100/70">No pending tasks right now.</p>
            ) : (
              <div className="space-y-3">
                {claimablePendingTasks.map((task) => renderTaskCard(task, 'pending'))}
              </div>
            )}
          </div>

          <div className="rounded-2xl border border-blue-500/20 bg-blue-500/10 p-5">
            <h3 className="mb-4 text-xl font-bold text-blue-200">In Progress By Me</h3>
            {myInProgressTasks.length === 0 ? (
              <p className="text-sm text-blue-100/70">No tasks are currently assigned to you.</p>
            ) : (
              <div className="space-y-3">
                {myInProgressTasks.map((task) => renderTaskCard(task, 'mine'))}
              </div>
            )}
          </div>

          <div className="rounded-2xl border border-green-500/20 bg-green-500/10 p-5">
            <h3 className="mb-4 text-xl font-bold text-green-200">Completed Tasks</h3>
            {completedTasks.length === 0 ? (
              <p className="text-sm text-green-100/70">No completed tasks yet.</p>
            ) : (
              <div className="space-y-3">
                {completedTasks.map((task) => renderTaskCard(task, 'completed'))}
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  function renderPlayers() {
    return (
      <div className="space-y-6">
        <div>
          <h2 className="text-3xl font-bold">View Players</h2>
          <p className="mt-2 text-sm text-neutral-400">
            Review players under your coadmin scope and block or unblock access.
          </p>
        </div>

        {players.length === 0 ? (
          <div className="rounded-2xl border border-white/10 bg-white/5 p-6 text-sm text-neutral-400">
            No players found.
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {players.map((player) => (
              <div
                key={player.uid}
                className="rounded-2xl border border-white/10 bg-white/5 p-5"
              >
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <h3 className="flex flex-wrap items-center gap-2 text-2xl font-bold">
                      <OnlineIndicator
                        online={Boolean(carerPlayerOnlineByUid[player.uid])}
                        sizeClassName="h-3 w-3"
                      />
                      <span>{player.username || 'Unnamed Player'}</span>
                    </h3>
                    <p className="mt-2 text-sm text-neutral-400">
                      Status: <span className="text-white">{player.status}</span>
                    </p>
                  </div>

                  <div className="flex flex-col gap-2">
                    <button
                      type="button"
                      onClick={() => void handleTogglePlayerStatus(player)}
                      disabled={blockingPlayerUid === player.uid}
                      className="rounded-xl bg-yellow-500/20 px-4 py-2 text-sm font-semibold text-yellow-300 hover:bg-yellow-500/30 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {blockingPlayerUid === player.uid
                        ? 'Updating...'
                        : player.status === 'disabled'
                          ? 'Unblock'
                          : 'Block'}
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleOpenRiskPanel(player.uid)}
                      disabled={riskActionLoading === `open-${player.uid}`}
                      className="rounded-xl bg-white/10 px-4 py-2 text-xs font-semibold text-white hover:bg-white/20 disabled:opacity-60"
                    >
                      {riskActionLoading === `open-${player.uid}`
                        ? 'Loading...'
                        : 'View Player Risk Data'}
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  function renderLoginDetails() {
    return (
      <div className="space-y-6">
        <div>
          <h2 className="text-3xl font-bold">Login Details</h2>
          <p className="mt-2 text-sm text-neutral-400">
            Coadmin game login credentials by respective game.
          </p>
        </div>

        {gameOptions.length === 0 ? (
          <div className="rounded-2xl border border-white/10 bg-white/5 p-6 text-sm text-neutral-400">
            No game login details found.
          </div>
        ) : (
          <div className="space-y-4">
            {gameOptions.map((game) => (
              <div
                key={game.id}
                className="rounded-2xl border border-white/10 bg-white/5 p-5"
              >
                <h3 className="text-2xl font-bold">{game.gameName || 'Unnamed Game'}</h3>
                <p className="mt-3 text-sm text-neutral-400">
                  Username: <span className="text-white">{game.username || 'Not set'}</span>
                </p>
                <p className="mt-1 text-sm text-neutral-400">
                  Password:{' '}
                  <span className="break-all text-white">{game.password || 'Not set'}</span>
                </p>
                <p className="mt-1 text-sm text-neutral-400">
                  Site:{' '}
                  {game.siteUrl ? (
                    <a
                      href={normalizeSiteUrl(game.siteUrl)}
                      target="_blank"
                      rel="noreferrer"
                      className="break-all text-cyan-300 underline underline-offset-2 hover:text-cyan-200"
                    >
                      {game.siteUrl}
                    </a>
                  ) : (
                    <span className="text-white">Not set</span>
                  )}
                </p>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  const menuItems: (NavigationItem & { view: CarerView })[] = [
    { view: 'dashboard', label: 'Dashboard' },
    { view: 'create-username', label: 'Create Username' },
    {
      view: 'tasks',
      label: 'Tasks',
      unread: claimablePendingTasks.length + myInProgressTasks.length,
    },
    { view: 'view-players', label: 'View Players' },
    { view: 'login-details', label: 'Login Details' },
  ];

  function handleChangeView(view: CarerView) {
    setActiveView(view);
    setNoticeMessage('');
  }

  return (
    <ProtectedRoute allowedRoles={['carer']}>
      <RoleSidebarLayout
        title="Carer Panel"
        subtitle={carerIdentity?.username || 'Carer'}
        activeView={activeView}
        items={menuItems.map((item) => ({
          ...item,
          onClick: () => handleChangeView(item.view as CarerView),
        }))}
        footer={<LogoutButton />}
      >
          {errorMessage && (
            <div className="mb-4 rounded-2xl border border-red-500/20 bg-red-500/10 p-4 text-sm text-red-100">
              {errorMessage}
            </div>
          )}

          {noticeMessage && (
            <div className="mb-4 rounded-2xl border border-green-500/20 bg-green-500/10 p-4 text-sm text-green-100">
              {noticeMessage}
            </div>
          )}

          {showTaskSplash && claimablePendingTasks.length > 0 && (
            <div className="mb-6 rounded-3xl border border-yellow-400/30 bg-yellow-500/10 p-5">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div>
                  <p className="text-xs font-bold uppercase tracking-[0.2em] text-yellow-200">
                    Task Alert
                  </p>
                  <h2 className="mt-2 text-2xl font-bold">
                    {claimablePendingTasks.length} claimable pending task
                    {claimablePendingTasks.length === 1 ? '' : 's'}
                  </h2>
                  <p className="mt-1 text-sm text-yellow-100/80">
                    Start a task before another carer claims it.
                  </p>
                </div>

                <div className="flex gap-3">
                  <button
                    onClick={() => {
                      setActiveView('tasks');
                      setShowTaskSplash(false);
                    }}
                    className="rounded-2xl bg-white px-4 py-3 text-sm font-bold text-black hover:bg-neutral-200"
                  >
                    Open Tasks
                  </button>
                  <button
                    onClick={() => setShowTaskSplash(false)}
                    className="rounded-2xl bg-white/10 px-4 py-3 text-sm font-bold text-white hover:bg-white/20"
                  >
                    Dismiss
                  </button>
                </div>
              </div>
            </div>
          )}

          {(bootstrapping || refreshing) && (
            <div className="mb-6 rounded-2xl border border-white/10 bg-white/5 p-4 text-sm text-neutral-300">
              {bootstrapping ? 'Loading carer page...' : 'Refreshing data...'}
            </div>
          )}

          {activeView === 'dashboard' && renderDashboard()}
          {activeView === 'create-username' && renderCreateUsername()}
          {activeView === 'tasks' && renderTasks()}
          {activeView === 'view-players' && renderPlayers()}
          {activeView === 'login-details' && renderLoginDetails()}
      </RoleSidebarLayout>

      {showRiskPanel && selectedRiskSnapshot && (
        <div
          onClick={() => setShowRiskPanel(false)}
          className="fixed inset-0 z-[58] flex items-center justify-center bg-black/80 px-4"
        >
          <div
            onClick={(event) => event.stopPropagation()}
            className="max-h-[90vh] w-full max-w-4xl overflow-y-auto rounded-3xl border border-white/20 bg-neutral-900 p-6"
          >
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-2xl font-bold">Player Risk Data</h3>
              <button
                type="button"
                onClick={() => setShowRiskPanel(false)}
                className="rounded-lg bg-white/10 px-3 py-1.5 text-xs font-semibold text-white hover:bg-white/20"
              >
                Close
              </button>
            </div>

            <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
              <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
                <p className="text-xs text-neutral-400">Player Summary</p>
                <p className="mt-2 text-lg font-semibold text-white">
                  {selectedRiskSnapshot.playerUsername}
                </p>
                <p
                  className={`text-sm font-bold uppercase ${getRiskTone(
                    selectedRiskSnapshot.riskLevel,
                    selectedRiskSnapshot.riskScore || 0
                  )}`}
                >
                  {selectedRiskSnapshot.riskLevel} risk
                </p>
                <p className="text-sm text-neutral-200">Score: {selectedRiskSnapshot.riskScore}</p>
              </div>
              <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
                <p className="text-xs text-neutral-400">Financial Data</p>
                <p className="mt-2 text-sm text-neutral-200">
                  Deposits: {formatNpr(selectedRiskSnapshot.totalDeposits || 0)}
                </p>
                <p className="text-sm text-neutral-200">
                  Cashouts: {formatNpr(selectedRiskSnapshot.totalCashouts || 0)}
                </p>
                <p className="text-sm text-neutral-200">
                  Transfers: {formatNpr(selectedRiskSnapshot.totalTransfers || 0)}
                </p>
                <p className="text-sm text-neutral-200">
                  Bonus claimed: {formatNpr(selectedRiskSnapshot.totalBonusClaimed || 0)}
                </p>
              </div>
              <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
                <p className="text-xs text-neutral-400">Activity (last 24h / 7d)</p>
                <p className="mt-2 text-sm text-neutral-200">
                  Cashouts: {selectedRiskSnapshot.activity24h?.cashouts || 0} /{' '}
                  {selectedRiskSnapshot.activity7d?.cashouts || 0}
                </p>
                <p className="text-sm text-neutral-200">
                  Transfers: {selectedRiskSnapshot.activity24h?.transfers || 0} /{' '}
                  {selectedRiskSnapshot.activity7d?.transfers || 0}
                </p>
                <p className="text-sm text-neutral-200">
                  Bonus usage: {selectedRiskSnapshot.activity24h?.bonus || 0} /{' '}
                  {selectedRiskSnapshot.activity7d?.bonus || 0}
                </p>
                <p className="text-sm text-neutral-200">
                  Deposits: {selectedRiskSnapshot.activity24h?.deposits || 0} /{' '}
                  {selectedRiskSnapshot.activity7d?.deposits || 0}
                </p>
              </div>
              <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
                <p className="text-xs text-neutral-400">Behavior Analysis</p>
                <p className="mt-2 text-sm text-neutral-200">
                  Deposit/Cashout ratio: {selectedRiskSnapshot.depositToCashoutRatio || 0}
                </p>
                <p className="text-sm text-neutral-200">
                  Bonus/Deposit ratio: {selectedRiskSnapshot.bonusToDepositRatio || 0}
                </p>
                <p className="text-sm text-neutral-200">
                  Cycle count: {selectedRiskSnapshot.cycleCount || 0}
                </p>
              </div>
            </div>

            <div className="mt-4 rounded-2xl border border-amber-400/30 bg-amber-500/10 p-4 text-sm text-amber-100">
              Repeated cashout → coin transfer → bonus usage can reduce system profit. Use this
              feature mainly for retention, not repeated recycling.
            </div>

            <div className="mt-4 rounded-2xl border border-rose-400/30 bg-rose-500/10 p-4">
              <p className="text-xs font-bold uppercase tracking-[0.2em] text-rose-100">Alerts</p>
              <div className="mt-2 space-y-1 text-sm text-rose-50">
                {(selectedRiskSnapshot.alerts || []).length === 0 ? (
                  <p>No active alerts.</p>
                ) : (
                  selectedRiskSnapshot.alerts.map((alert) => <p key={alert}>- {alert}</p>)
                )}
              </div>
            </div>

            <div className="mt-4 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => void handleFlagRiskPlayer()}
                disabled={riskActionLoading === `flag-${selectedRiskSnapshot.playerUid}`}
                className="rounded-lg bg-rose-500 px-3 py-2 text-xs font-semibold text-white hover:bg-rose-400 disabled:opacity-60"
              >
                Flag player
              </button>
              <button
                type="button"
                onClick={() => void handleSendRiskAlertToStaff()}
                disabled={riskActionLoading === `alert-${selectedRiskSnapshot.playerUid}`}
                className="rounded-lg bg-white/15 px-3 py-2 text-xs font-semibold text-white hover:bg-white/25 disabled:opacity-60"
              >
                Send alert to staff
              </button>
            </div>
          </div>
        </div>
      )}

      {showPaymentDetailsPanel && (
        <div
          onClick={() => setShowPaymentDetailsPanel(false)}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 px-4"
        >
          <div
            onClick={(event) => event.stopPropagation()}
            className="w-full max-w-xl rounded-3xl border border-white/20 bg-neutral-900 p-6 shadow-2xl"
          >
            <h3 className="text-2xl font-bold text-white">Payment Details</h3>
            <p className="mt-2 text-sm text-neutral-400">
              Add your payment QR and details. Coadmin will use this for cashout transfer.
            </p>

            <label className="mt-4 block text-sm text-neutral-300">
              Payment QR URL
              <input
                value={paymentQrUrl}
                onChange={(event) => setPaymentQrUrl(event.target.value)}
                placeholder="https://example.com/qr-image.png"
                className="mt-2 w-full rounded-xl border border-white/10 bg-black px-4 py-3 text-white outline-none focus:border-white/30"
              />
            </label>
            <div className="mt-4">
              <ImageUploadField
                label="Upload payment QR image"
                valueUrl={paymentQrUrl}
                autoUpload
                onUploaded={(uploaded) => {
                  setPaymentQrUrl(uploaded.url);
                  setPaymentQrPublicId(uploaded.publicId);
                  setNoticeMessage('Image uploaded successfully.');
                  setErrorMessage('');
                }}
                onError={() => {
                  setErrorMessage('Image upload failed. Please try again.');
                }}
              />
            </div>

            <label className="mt-4 block text-sm text-neutral-300">
              Payment Notes / UPI / Bank Details
              <textarea
                value={paymentDetails}
                onChange={(event) => setPaymentDetails(event.target.value)}
                placeholder="UPI ID / account details / notes"
                className="mt-2 min-h-24 w-full rounded-xl border border-white/10 bg-black px-4 py-3 text-white outline-none focus:border-white/30"
              />
            </label>

            <div className="mt-5 flex gap-3">
              <button
                type="button"
                onClick={() => setShowPaymentDetailsPanel(false)}
                className="flex-1 rounded-xl bg-white/10 px-4 py-3 font-semibold text-white hover:bg-white/20"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void handleSavePaymentDetails()}
                disabled={savingPaymentDetails}
                className="flex-1 rounded-xl bg-white px-4 py-3 font-semibold text-black hover:bg-neutral-200 disabled:opacity-60"
              >
                {savingPaymentDetails ? 'Saving...' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}

      {showInquiryPanel && (
        <div
          onClick={() => setShowInquiryPanel(false)}
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 px-4"
        >
          <div
            onClick={(event) => event.stopPropagation()}
            className="w-full max-w-xl rounded-3xl border border-red-400/40 bg-red-950 p-6 shadow-2xl"
          >
            <h3 className="text-2xl font-bold text-white">Urgent Inquiry</h3>
            <p className="mt-2 text-sm text-red-100/80">
              Write a clear urgent message. This will be shown as a red splash to coadmin and staff.
            </p>

            <label className="mt-4 block text-sm text-red-100">
              Inquiry message
              <textarea
                value={inquiryMessage}
                onChange={(event) => setInquiryMessage(event.target.value)}
                placeholder="Write the issue clearly..."
                className="mt-2 min-h-28 w-full rounded-xl border border-red-200/20 bg-black/40 px-4 py-3 text-white outline-none focus:border-red-300"
              />
            </label>

            <div className="mt-5 flex gap-3">
              <button
                type="button"
                onClick={() => setShowInquiryPanel(false)}
                className="flex-1 rounded-xl bg-white/10 px-4 py-3 font-semibold text-white hover:bg-white/20"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void handleSendInquiry()}
                disabled={sendingInquiry}
                className="flex-1 rounded-xl bg-white px-4 py-3 font-semibold text-black hover:bg-neutral-200 disabled:opacity-60"
              >
                {sendingInquiry ? 'Sending...' : 'Send Urgent'}
              </button>
            </div>
          </div>
        </div>
      )}

      {loginDetailsTask && (
        <div
          onClick={() => setLoginDetailsTask(null)}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 px-4"
        >
          <div
            onClick={(event) => event.stopPropagation()}
            className="w-full max-w-xl rounded-3xl border border-white/20 bg-neutral-900 p-6 shadow-2xl"
          >
            <h3 className="text-2xl font-bold text-white">Login Details</h3>
            <p className="mt-2 text-sm text-neutral-400">
              {(loginDetailsTask.playerUsername || 'Player').trim()} /{' '}
              {(loginDetailsTask.gameName || 'Unknown Game').trim()}
            </p>

            {(() => {
              const relatedPlayerLogin =
                allPlayerLogins.find(
                  (login) =>
                    login.playerUid === loginDetailsTask.playerUid &&
                    normalizeGameName(login.gameName || '') ===
                      normalizeGameName(loginDetailsTask.gameName || '')
                ) || null;
              const relatedCoadminGame =
                gameOptions.find(
                  (game) =>
                    normalizeGameName(game.gameName || '') ===
                    normalizeGameName(loginDetailsTask.gameName || '')
                ) || null;

              if (!relatedPlayerLogin && !relatedCoadminGame) {
                return (
                  <div className="mt-4 rounded-2xl border border-yellow-500/30 bg-yellow-500/10 p-4 text-sm text-yellow-100">
                    No login details found yet for this player/game.
                  </div>
                );
              }

              return (
                <div className="mt-4 space-y-3">
                  <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
                    <p className="text-xs text-neutral-400">Game Name</p>
                    <p className="mt-1 text-lg font-semibold text-white">
                      {relatedPlayerLogin?.gameName ||
                        relatedCoadminGame?.gameName ||
                        'Unknown Game'}
                    </p>
                  </div>
                  <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
                    <p className="text-xs text-neutral-400">
                      Username (Coadmin Game List)
                    </p>
                    <p className="mt-1 text-lg font-semibold text-white">
                      {relatedCoadminGame?.username || relatedPlayerLogin?.gameUsername || 'Not set'}
                    </p>
                  </div>
                  <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
                    <p className="text-xs text-neutral-400">
                      Password (Coadmin Game List)
                    </p>
                    <p className="mt-1 text-lg font-semibold text-white break-all">
                      {relatedCoadminGame?.password || relatedPlayerLogin?.gamePassword || 'Not set'}
                    </p>
                  </div>
                  <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
                    <p className="text-xs text-neutral-400">Game Site Link</p>
                    {relatedCoadminGame?.siteUrl ? (
                      <a
                        href={normalizeSiteUrl(relatedCoadminGame.siteUrl)}
                        target="_blank"
                        rel="noreferrer"
                        className="mt-1 block break-all text-lg font-semibold text-cyan-300 underline underline-offset-2 hover:text-cyan-200"
                      >
                        {relatedCoadminGame.siteUrl}
                      </a>
                    ) : (
                      <p className="mt-1 text-lg font-semibold text-white">Not set</p>
                    )}
                  </div>
                  {relatedPlayerLogin && (
                    <div className="rounded-2xl border border-emerald-500/20 bg-emerald-500/10 p-4">
                      <p className="text-xs text-emerald-200">Player Specific Username</p>
                      <p className="mt-1 text-sm text-white">
                        {relatedPlayerLogin.gameUsername || 'Not set'}
                      </p>
                      <p className="mt-2 text-xs text-emerald-200">Player Specific Password</p>
                      <p className="mt-1 text-sm text-white break-all">
                        {relatedPlayerLogin.gamePassword || 'Not set'}
                      </p>
                    </div>
                  )}
                </div>
              );
            })()}

            <button
              type="button"
              onClick={() => setLoginDetailsTask(null)}
              className="mt-5 w-full rounded-2xl bg-white px-4 py-3 font-bold text-black hover:bg-neutral-200"
            >
              Close
            </button>
          </div>
        </div>
      )}
    </ProtectedRoute>
  );
}
