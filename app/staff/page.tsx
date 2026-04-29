'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { collection, doc, getDoc, getDocs, onSnapshot, query, where } from 'firebase/firestore';

import ProtectedRoute from '../../components/auth/ProtectedRoute';
import LogoutButton from '../../components/auth/LogoutButton';
import DashboardView from '../../components/admin/DashboardView';
import CreateUserForm from '../../components/admin/CreateUserForm';
import ReachOutView from '../../components/admin/ReachOutView';
import RoleSidebarLayout, { type NavigationItem } from '@/components/navigation/RoleSidebarLayout';

import { auth, db } from '@/lib/firebase/client';
import { belongsToCoadmin, getCurrentUserCoadminUid } from '@/lib/coadmin/scope';
import {
  blockPlayer,
  CoadminUser,
  createCoadmin,
  createPlayer,
  getCoadmins,
  getPlayers,
  getStaff,
  PlayerUser,
  StaffUser,
  unblockPlayer,
} from '@/features/users/adminUsers';
import {
  listenToUnreadCounts,
  markConversationAsRead,
  sendChatMessage,
} from '@/features/messages/chatMessages';
import { usePaginatedChatMessages } from '@/features/messages/usePaginatedChatMessages';
import {
  CarerEscalationAlert,
  deleteCarerEscalationAlert,
  listenToCarerEscalationAlerts,
  listenToCarerEscalationAlertsByCoadmin,
} from '@/features/games/carerTasks';
import {
  completePlayerCashoutTask,
  getEffectivePlayerCashoutTaskStatus,
  getPlayerCashoutTaskCountdown,
  getPlayerCashoutPaymentDisplay,
  listenAllPlayerCashoutTasks,
  listenPlayerCashoutTasksByCoadmin,
  PlayerCashoutTask,
  startPlayerCashoutTask,
} from '@/features/cashouts/playerCashoutTasks';
import {
  approveTransferRequest,
  getPlayerRiskSnapshot,
  listenPendingTransferRequestsByCoadminOrGlobal,
  listenPlayerRiskSnapshotsByCoadmin,
  markRiskReviewed,
  PlayerRiskSnapshot,
  rejectTransferRequest,
  setPlayerBonusBlock,
  setPlayerTransferBlock,
  TransferRequest,
} from '@/features/risk/playerRisk';
import {
  heartbeatShiftSession,
  endShiftSession,
  startShiftSession,
} from '@/features/shifts/userShifts';
import { usePresenceOnlineMap } from '@/features/presence/userPresence';
import { OnlineIndicator } from '@/components/presence/OnlineIndicator';

import { AdminUser, ChatMessage } from '../../components/admin/types';

type StaffView =
  | 'dashboard'
  | 'view-tasks'
  | 'create-player'
  | 'view-players'
  | 'reach-out'
  | 'create-coadmin'
  | 'view-coadmins';

const AED_TO_USD = 0.2723;
const NPR_TO_USD = 0.0075;
const NPR_TO_AED = NPR_TO_USD / AED_TO_USD;

function sortByNewest<T extends { createdAt?: any }>(list: T[]) {
  return [...list].sort((a: any, b: any) => {
    const aTime = a.createdAt?.toDate?.()?.getTime?.() || a.createdAt?.getTime?.() || 0;
    const bTime = b.createdAt?.toDate?.()?.getTime?.() || b.createdAt?.getTime?.() || 0;
    return bTime - aTime;
  });
}

function formatNpr(value: number) {
  return `NPR ${Math.round(value || 0).toLocaleString()}`;
}

function formatAed(value: number) {
  return `AED ${Math.round(value || 0).toLocaleString()}`;
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

function getRiskPlayerCardClass(level: string, score: number, hasUnread: boolean) {
  const unreadRing = hasUnread ? ' ring-1 ring-red-500/40' : '';

  if (level === 'high') {
    if (score >= 12) {
      return `rounded-2xl border border-orange-500/75 bg-orange-500/32 p-5${unreadRing}`;
    }
    if (score >= 10) {
      return `rounded-2xl border border-orange-500/60 bg-orange-500/24 p-5${unreadRing}`;
    }
    return `rounded-2xl border border-orange-400/45 bg-orange-400/16 p-5${unreadRing}`;
  }

  if (level === 'medium') {
    return `rounded-2xl border border-amber-400/35 bg-amber-400/10 p-5${unreadRing}`;
  }

  return hasUnread
    ? 'rounded-2xl border border-red-500/40 bg-red-500/10 p-5 ring-1 ring-red-500/30'
    : 'rounded-2xl border border-white/10 bg-white/5 p-5';
}

export default function StaffPage() {
  const [activeView, setActiveView] = useState<StaffView>('dashboard');
  const [creatorRole, setCreatorRole] = useState<'admin' | 'coadmin' | null>(null);
  const [playerUsername, setPlayerUsername] = useState('');
  const [playerPassword, setPlayerPassword] = useState('');
  const [playerReferralCodeInput, setPlayerReferralCodeInput] = useState('');
  const [coadminUsername, setCoadminUsername] = useState('');
  const [coadminPassword, setCoadminPassword] = useState('');
  const [players, setPlayers] = useState<PlayerUser[]>([]);
  const [coadmins, setCoadmins] = useState<CoadminUser[]>([]);
  const [allStaffUsers, setAllStaffUsers] = useState<StaffUser[]>([]);
  const [chatUsers, setChatUsers] = useState<AdminUser[]>([]);
  const [selectedChatUser, setSelectedChatUser] = useState<AdminUser | null>(null);
  const [selectedPlayerChatUser, setSelectedPlayerChatUser] = useState<PlayerUser | null>(null);
  const [newMessage, setNewMessage] = useState('');
  const staffReachOutScrollRef = useRef<HTMLDivElement | null>(null);
  const staffPlayerScrollRef = useRef<HTMLDivElement | null>(null);
  const [newPlayerMessage, setNewPlayerMessage] = useState('');
  const [unreadCounts, setUnreadCounts] = useState<Record<string, number>>({});
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const [loadingList, setLoadingList] = useState(false);
  const [staffCashBoxNpr, setStaffCashBoxNpr] = useState(0);
  const [latestCarerEscalation, setLatestCarerEscalation] =
    useState<CarerEscalationAlert | null>(null);
  const [showCarerEscalationSplash, setShowCarerEscalationSplash] = useState(false);
  const [recentCarerEscalations, setRecentCarerEscalations] = useState<
    CarerEscalationAlert[]
  >([]);
  const [dismissedCarerEscalationIds, setDismissedCarerEscalationIds] = useState<
    string[]
  >([]);
  const [playerCashoutTasks, setPlayerCashoutTasks] = useState<PlayerCashoutTask[]>([]);
  const [playerCashoutTaskLoadingId, setPlayerCashoutTaskLoadingId] = useState<string | null>(
    null
  );
  const [countdownTick, setCountdownTick] = useState(0);
  const [pendingTransferRequests, setPendingTransferRequests] = useState<TransferRequest[]>([]);
  const [riskSnapshots, setRiskSnapshots] = useState<PlayerRiskSnapshot[]>([]);
  const [selectedRiskSnapshot, setSelectedRiskSnapshot] = useState<PlayerRiskSnapshot | null>(null);
  const [showRiskPanel, setShowRiskPanel] = useState(false);
  const [riskActionLoading, setRiskActionLoading] = useState<string | null>(null);
  const latestCarerEscalationIdRef = useRef<string | null>(null);
  const hasSeenCarerEscalationSnapshotRef = useRef(false);
  const previousPlayerChatUnreadRef = useRef(0);
  const hasSyncedPlayerChatUnreadRef = useRef(false);
  const shiftSessionIdRef = useRef<string | null>(null);
  const [playerBlockActionUid, setPlayerBlockActionUid] = useState<string | null>(null);

  const pagedStaffAgentChat = usePaginatedChatMessages(selectedChatUser?.uid ?? null, {
    scrollContainerRef: staffReachOutScrollRef,
    onWindowMessages: () => {
      if (selectedChatUser) {
        markConversationAsRead(selectedChatUser.uid);
      }
    },
  });
  const pagedStaffPlayerChat = usePaginatedChatMessages(selectedPlayerChatUser?.uid ?? null, {
    scrollContainerRef: staffPlayerScrollRef,
    onWindowMessages: () => {
      if (selectedPlayerChatUser) {
        markConversationAsRead(selectedPlayerChatUser.uid);
      }
    },
  });

  const messages: ChatMessage[] = useMemo(() => {
    const currentUser = auth.currentUser;
    if (!currentUser) {
      return [];
    }
    return pagedStaffAgentChat.items.map((msg) => ({
      id: msg.id,
      text: msg.text,
      imageUrl: msg.imageUrl,
      sender: msg.senderUid === currentUser.uid ? 'admin' : 'user',
      timestamp: msg.createdAt?.toDate?.() || new Date(),
    }));
  }, [pagedStaffAgentChat.items]);

  const playerMessages: ChatMessage[] = useMemo(() => {
    const currentUser = auth.currentUser;
    if (!currentUser) {
      return [];
    }
    return pagedStaffPlayerChat.items.map((msg) => ({
      id: msg.id,
      text: msg.text,
      imageUrl: msg.imageUrl,
      sender: msg.senderUid === currentUser.uid ? 'admin' : 'user',
      timestamp: msg.createdAt?.toDate?.() || new Date(),
    }));
  }, [pagedStaffPlayerChat.items]);

  const reachOutUnread = useMemo(
    () => chatUsers.reduce((total, user) => total + (unreadCounts[user.uid] || 0), 0),
    [chatUsers, unreadCounts]
  );

  const reachOutUnreadCounts = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(unreadCounts).filter(([uid]) =>
          chatUsers.some((user) => user.uid === uid)
        )
      ),
    [chatUsers, unreadCounts]
  );
  const visibleRecentCarerEscalations = recentCarerEscalations.filter(
    (alert) => !dismissedCarerEscalationIds.includes(alert.id)
  );
  const visiblePlayerCashoutTasks = playerCashoutTasks
    .map((task) => ({
      ...task,
      status: getEffectivePlayerCashoutTaskStatus(task),
    }))
    .filter((task) => task.status !== 'completed');
  const completedPlayerCashoutTasks = playerCashoutTasks
    .map((task) => ({
      ...task,
      status: getEffectivePlayerCashoutTaskStatus(task),
    }))
    .filter((task) => task.status === 'completed');
  const currentUserUid = auth.currentUser?.uid || '';
  const staffCashBoxAedEstimate = Number(staffCashBoxNpr || 0) * NPR_TO_AED;
  const riskyPlayers = useMemo(
    () => riskSnapshots.filter((entry) => entry.riskLevel !== 'low').slice(0, 10),
    [riskSnapshots]
  );
  const riskByPlayerUid = useMemo(
    () => new Map(riskSnapshots.map((entry) => [entry.playerUid, entry])),
    [riskSnapshots]
  );
  const playerChatUnreadTotal = useMemo(
    () => players.reduce((sum, player) => sum + (unreadCounts[player.uid] || 0), 0),
    [players, unreadCounts]
  );

  const playPlayerMessageSound = useCallback(() => {
    const audio = new Audio('/urgency-sound.mp3');
    audio.volume = 0.6;
    void audio.play().catch(() => undefined);
  }, []);

  const playersSortedByUnread = useMemo(() => {
    return [...players].sort((a, b) => {
      const unreadB = unreadCounts[b.uid] || 0;
      const unreadA = unreadCounts[a.uid] || 0;
      if (unreadB !== unreadA) {
        return unreadB - unreadA;
      }
      const aTime = (a as { createdAt?: { toDate?: () => Date } }).createdAt?.toDate?.()?.getTime() || 0;
      const bTime = (b as { createdAt?: { toDate?: () => Date } }).createdAt?.toDate?.()?.getTime() || 0;
      return bTime - aTime;
    });
  }, [players, unreadCounts]);

  const staffPresenceUids = useMemo(() => {
    const s = new Set<string>();
    for (const p of players) s.add(p.uid);
    for (const u of chatUsers) s.add(u.uid);
    for (const c of coadmins) s.add(c.uid);
    return Array.from(s);
  }, [players, chatUsers, coadmins]);
  const staffOnlineByUid = usePresenceOnlineMap(staffPresenceUids);

  useEffect(() => {
    if (loadingList) {
      return;
    }

    if (!hasSyncedPlayerChatUnreadRef.current) {
      hasSyncedPlayerChatUnreadRef.current = true;
      previousPlayerChatUnreadRef.current = playerChatUnreadTotal;
      return;
    }

    if (playerChatUnreadTotal > previousPlayerChatUnreadRef.current) {
      playPlayerMessageSound();
      if (
        typeof document !== 'undefined' &&
        document.hidden &&
        typeof window !== 'undefined' &&
        'Notification' in window &&
        window.Notification?.permission === 'granted'
      ) {
        try {
          const delta = playerChatUnreadTotal - previousPlayerChatUnreadRef.current;
          new window.Notification('New message from player', {
            body: delta === 1 ? 'You have a new unread message.' : `${delta} new unread messages.`,
            tag: 'staff-player-chat',
          });
        } catch {
          // ignore
        }
      }
    }

    previousPlayerChatUnreadRef.current = playerChatUnreadTotal;
  }, [playPlayerMessageSound, playerChatUnreadTotal, loadingList]);

  async function loadPlayers() {
    setLoadingList(true);

    try {
      const coadminUid = await getCurrentUserCoadminUid();
      const allPlayers = await getPlayers();
      const relatedPlayers = allPlayers.filter((player) =>
        belongsToCoadmin(player, coadminUid)
      );
      setPlayers(sortByNewest(relatedPlayers));
    } catch (error: any) {
      setMessage(error.message || 'Failed to load players.');
    } finally {
      setLoadingList(false);
    }
  }

  async function loadCoadminsAndStaff() {
    setLoadingList(true);

    try {
      const [coadminList, staffList] = await Promise.all([getCoadmins(), getStaff()]);
      setCoadmins(sortByNewest(coadminList));
      setAllStaffUsers(sortByNewest(staffList));
    } catch (error: any) {
      setMessage(error.message || 'Failed to load coadmins and staff.');
    } finally {
      setLoadingList(false);
    }
  }

  async function loadCreatorRole() {
    try {
      const currentUser = auth.currentUser;

      if (!currentUser) {
        setCreatorRole(null);
        return;
      }

      const currentUserSnap = await getDoc(doc(db, 'users', currentUser.uid));

      if (!currentUserSnap.exists()) {
        setCreatorRole(null);
        return;
      }

      const currentUserData = currentUserSnap.data() as {
        createdBy?: string | null;
      };
      const creatorUid = currentUserData.createdBy ? String(currentUserData.createdBy) : '';

      if (!creatorUid) {
        setCreatorRole(null);
        return;
      }

      const creatorSnap = await getDoc(doc(db, 'users', creatorUid));

      if (!creatorSnap.exists()) {
        setCreatorRole(null);
        return;
      }

      const creatorData = creatorSnap.data() as { role?: string };
      const nextRole = String(creatorData.role || '').toLowerCase();

      if (nextRole === 'admin' || nextRole === 'coadmin') {
        setCreatorRole(nextRole);
        return;
      }

      setCreatorRole(null);
    } catch {
      setCreatorRole(null);
    }
  }

  async function loadReachOutUsers() {
    try {
      const currentUser = auth.currentUser;

      if (!currentUser) {
        setChatUsers([]);
        return;
      }

      if (creatorRole === 'admin') {
        const [adminsSnap, coadminsSnap] = await Promise.all([
          getDocs(query(collection(db, 'users'), where('role', '==', 'admin'))),
          getDocs(query(collection(db, 'users'), where('role', '==', 'coadmin'))),
        ]);

        const admins = adminsSnap.docs.map((docSnap) => ({
          id: docSnap.id,
          ...(docSnap.data() as Omit<AdminUser, 'id'>),
        })) as AdminUser[];
        const coadmins = coadminsSnap.docs.map((docSnap) => ({
          id: docSnap.id,
          ...(docSnap.data() as Omit<AdminUser, 'id'>),
        })) as AdminUser[];

        setChatUsers(sortByNewest([...admins, ...coadmins]));
      } else {
        const coadminUid = await getCurrentUserCoadminUid();
        const [coadminSnap, allStaff] = await Promise.all([
          getDoc(doc(db, 'users', coadminUid)),
          getStaff(),
        ]);

        const siblingStaff = allStaff.filter(
          (staff: StaffUser) =>
            belongsToCoadmin(staff, coadminUid) && staff.uid !== currentUser.uid
        );

        const scopedUsers: AdminUser[] = [...siblingStaff];

        if (coadminSnap.exists()) {
          scopedUsers.unshift({
            id: coadminSnap.id,
            ...(coadminSnap.data() as Omit<AdminUser, 'id'>),
          });
        }

        setChatUsers(scopedUsers);
      }
    } catch (error: any) {
      setMessage(error.message || 'Failed to load chat users.');
    }
  }

  useEffect(() => {
    void loadCreatorRole();
  }, []);

  useEffect(() => {
    hasSyncedPlayerChatUnreadRef.current = false;
    previousPlayerChatUnreadRef.current = 0;
  }, [creatorRole]);

  useEffect(() => {
    const currentUser = auth.currentUser;

    if (!currentUser) {
      setStaffCashBoxNpr(0);
      return;
    }

    const unsubscribe = onSnapshot(
      doc(db, 'users', currentUser.uid),
      (userSnap) => {
        if (!userSnap.exists()) {
          setStaffCashBoxNpr(0);
          return;
        }

        const userData = userSnap.data() as { cashBoxNpr?: number };
        setStaffCashBoxNpr(Number(userData.cashBoxNpr || 0));
      },
      () => {
        setStaffCashBoxNpr(0);
      }
    );

    return () => unsubscribe();
  }, []);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      setCountdownTick((tick) => tick + 1);
    }, 1000);

    return () => window.clearInterval(intervalId);
  }, []);

  useEffect(() => {
    void loadPlayers();
    void loadReachOutUsers();
    const unsubscribe = listenToUnreadCounts(setUnreadCounts);
    return () => unsubscribe();
  }, [creatorRole]);

  useEffect(() => {
    let isCancelled = false;
    let unsubscribe: (() => void) | undefined;

    async function startPlayerCashoutTaskListener() {
      try {
        if (creatorRole === 'admin') {
          unsubscribe = listenAllPlayerCashoutTasks(
            (tasks) => {
              if (!isCancelled) {
                setPlayerCashoutTasks(tasks);
              }
            },
            (error) => {
              if (!isCancelled) {
                setMessage(error.message || 'Failed to listen for player cashout tasks.');
              }
            }
          );
          return;
        }

        const coadminUid = await getCurrentUserCoadminUid();

        if (isCancelled) {
          return;
        }

        unsubscribe = listenPlayerCashoutTasksByCoadmin(
          coadminUid,
          (tasks) => {
            if (!isCancelled) {
              setPlayerCashoutTasks(tasks);
            }
          },
          (error) => {
            if (!isCancelled) {
              setMessage(error.message || 'Failed to listen for player cashout tasks.');
            }
          }
        );
      } catch (error: any) {
        if (!isCancelled) {
          setMessage(error.message || 'Failed to start player cashout task listener.');
        }
      }
    }

    void startPlayerCashoutTaskListener();

    return () => {
      isCancelled = true;
      unsubscribe?.();
    };
  }, [creatorRole]);

  useEffect(() => {
    let isCancelled = false;
    let unsubscribe: (() => void) | undefined;

    async function startTransferRequestListener() {
      try {
        if (creatorRole === 'admin') {
          unsubscribe = listenPendingTransferRequestsByCoadminOrGlobal(
            '',
            (requests) => {
              if (!isCancelled) {
                setPendingTransferRequests(requests);
              }
            },
            (error) => {
              if (!isCancelled) {
                setMessage(error.message || 'Failed to load transfer requests.');
              }
            }
          );
          return;
        }

        const coadminUid = await getCurrentUserCoadminUid();
        if (isCancelled) {
          return;
        }
        unsubscribe = listenPendingTransferRequestsByCoadminOrGlobal(
          coadminUid,
          (requests) => {
            if (!isCancelled) {
              setPendingTransferRequests(requests);
            }
          },
          (error) => {
            if (!isCancelled) {
              setMessage(error.message || 'Failed to load transfer requests.');
            }
          }
        );
      } catch (error: any) {
        if (!isCancelled) {
          setMessage(error.message || 'Failed to start transfer requests listener.');
        }
      }
    }

    void startTransferRequestListener();

    return () => {
      isCancelled = true;
      unsubscribe?.();
    };
  }, [creatorRole]);

  useEffect(() => {
    let isCancelled = false;
    let unsubscribe: (() => void) | undefined;

    async function startRiskSnapshotListener() {
      try {
        if (creatorRole === 'admin') {
          unsubscribe = listenPlayerRiskSnapshotsByCoadmin(
            '',
            (snapshots) => {
              if (!isCancelled) {
                setRiskSnapshots(snapshots);
              }
            },
            (error) => {
              if (!isCancelled) {
                setMessage(error.message || 'Failed to load player risk snapshots.');
              }
            }
          );
          return;
        }

        const coadminUid = await getCurrentUserCoadminUid();
        if (isCancelled) {
          return;
        }
        unsubscribe = listenPlayerRiskSnapshotsByCoadmin(
          coadminUid,
          (snapshots) => {
            if (!isCancelled) {
              setRiskSnapshots(snapshots);
            }
          },
          (error) => {
            if (!isCancelled) {
              setMessage(error.message || 'Failed to load player risk snapshots.');
            }
          }
        );
      } catch (error: any) {
        if (!isCancelled) {
          setMessage(error.message || 'Failed to start risk snapshot listener.');
        }
      }
    }

    void startRiskSnapshotListener();

    return () => {
      isCancelled = true;
      unsubscribe?.();
    };
  }, [creatorRole]);

  useEffect(() => {
    if (activeView === 'dashboard' || activeView === 'view-players') {
      void loadPlayers();
    }

    if (activeView === 'reach-out') {
      void loadReachOutUsers();
    }

    if (activeView === 'view-coadmins') {
      void loadCoadminsAndStaff();
    }
  }, [activeView]);

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
      const coadminUid = await getCurrentUserCoadminUid();
      const sessionId = await startShiftSession({
        coadminUid,
        userUid: currentUser.uid,
        userRole: 'staff',
        userUsername: userData.username?.trim() || 'Staff',
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
    let isCancelled = false;
    let unsubscribe: (() => void) | undefined;

    async function startCarerEscalationListener() {
      try {
        if (isCancelled) {
          return;
        }

        const onAlerts = (alerts: CarerEscalationAlert[]) => {
          if (isCancelled) {
            return;
          }

          setRecentCarerEscalations(alerts.slice(0, 6));

          if (!hasSeenCarerEscalationSnapshotRef.current) {
            hasSeenCarerEscalationSnapshotRef.current = true;
            latestCarerEscalationIdRef.current = alerts[0]?.id || null;
            return;
          }

          if (alerts.length === 0) {
            return;
          }

          const latestAlert = alerts[0];

          if (latestAlert.id === latestCarerEscalationIdRef.current) {
            return;
          }

          latestCarerEscalationIdRef.current = latestAlert.id;
          setLatestCarerEscalation(latestAlert);
          setShowCarerEscalationSplash(true);

          const audio = new Audio('/urgency-sound.mp3');
          audio.volume = 1;
          audio.play().catch(() => {});
        };

        if (creatorRole === 'admin') {
          unsubscribe = listenToCarerEscalationAlerts(
            onAlerts,
            (error) => {
              if (!isCancelled) {
                setMessage(error.message || 'Failed to listen for carer alerts.');
              }
            }
          );
          return;
        }

        const coadminUid = await getCurrentUserCoadminUid();

        if (isCancelled) {
          return;
        }

        unsubscribe = listenToCarerEscalationAlertsByCoadmin(
          coadminUid,
          onAlerts,
          (error) => {
            if (!isCancelled) {
              setMessage(error.message || 'Failed to listen for carer alerts.');
            }
          }
        );
      } catch (error: any) {
        if (!isCancelled) {
          setMessage(error.message || 'Failed to start carer alert listener.');
        }
      }
    }

    void startCarerEscalationListener();

    return () => {
      isCancelled = true;
      unsubscribe?.();
    };
  }, [creatorRole]);

  async function handleCreatePlayer(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    setMessage('');

    try {
      const result = await createPlayer(playerUsername, playerPassword, playerReferralCodeInput);
      setPlayerUsername('');
      setPlayerPassword('');
      setPlayerReferralCodeInput('');
      setMessage(
        result?.referralApplied
          ? 'Referral was successful. Referral bonus has been added.'
          : 'Player created successfully.'
      );
      await loadPlayers();
    } catch (error: any) {
      setMessage(error.message || 'Failed to create player.');
    } finally {
      setLoading(false);
    }
  }

  async function handleDismissCarerEscalation(alertId: string) {
    try {
      await deleteCarerEscalationAlert(alertId);
      setDismissedCarerEscalationIds((current) =>
        current.includes(alertId) ? current : [...current, alertId]
      );
    } catch (error: any) {
      setMessage(error.message || 'Failed to dismiss urgent notification.');
    }
  }

  function formatCountdownMs(remainingMs: number) {
    const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1000));
    const minutes = Math.floor(totalSeconds / 60)
      .toString()
      .padStart(2, '0');
    const seconds = (totalSeconds % 60).toString().padStart(2, '0');
    return `${minutes}:${seconds}`;
  }

  async function handleStartPlayerCashoutTask(taskId: string) {
    setPlayerCashoutTaskLoadingId(taskId);
    setMessage('');
    try {
      await startPlayerCashoutTask(taskId);
    } catch (error: any) {
      setMessage(error.message || 'Failed to start player cashout task.');
    } finally {
      setPlayerCashoutTaskLoadingId(null);
    }
  }

  async function handleCompletePlayerCashoutTask(taskId: string) {
    setPlayerCashoutTaskLoadingId(taskId);
    setMessage('');
    try {
      await completePlayerCashoutTask(taskId);
      setMessage('Player cashout task completed.');
    } catch (error: any) {
      setMessage(error.message || 'Failed to complete player cashout task.');
    } finally {
      setPlayerCashoutTaskLoadingId(null);
    }
  }

  async function handleApproveTransferRequest(requestId: string) {
    setRiskActionLoading(`approve-${requestId}`);
    setMessage('');
    try {
      await approveTransferRequest(requestId);
      setMessage(
        'Transfer approved and converted to coin. Most profit comes from cashouts. Repeated cash-to-coin transfers may reduce long-term gains.'
      );
    } catch (error: any) {
      setMessage(error.message || 'Failed to approve transfer request.');
    } finally {
      setRiskActionLoading(null);
    }
  }

  async function handleRejectTransferRequest(requestId: string) {
    setRiskActionLoading(`reject-${requestId}`);
    setMessage('');
    try {
      await rejectTransferRequest(requestId, 'Transfer denied due to suspected misuse.');
      setMessage('Transfer request rejected.');
    } catch (error: any) {
      setMessage(error.message || 'Failed to reject transfer request.');
    } finally {
      setRiskActionLoading(null);
    }
  }

  async function handleOpenRiskPanel(playerUid: string) {
    setRiskActionLoading(`open-${playerUid}`);
    try {
      const snapshot = await getPlayerRiskSnapshot(playerUid);
      if (!snapshot) {
        setMessage('Risk data is not ready for this player yet.');
        return;
      }
      setSelectedRiskSnapshot(snapshot);
      setShowRiskPanel(true);
    } catch (error: any) {
      setMessage(error.message || 'Failed to load player risk data.');
    } finally {
      setRiskActionLoading(null);
    }
  }

  async function handleStaffRiskAction(action: 'review' | 'bonus' | 'transfer', enabled?: boolean) {
    if (!selectedRiskSnapshot) return;

    const playerUid = selectedRiskSnapshot.playerUid;
    setRiskActionLoading(`${action}-${playerUid}`);
    setMessage('');
    try {
      if (action === 'review') {
        await markRiskReviewed(playerUid);
      } else if (action === 'bonus') {
        await setPlayerBonusBlock(playerUid, Boolean(enabled));
      } else if (action === 'transfer') {
        await setPlayerTransferBlock(playerUid, Boolean(enabled));
      }

      const refreshed = await getPlayerRiskSnapshot(playerUid);
      if (refreshed) {
        setSelectedRiskSnapshot(refreshed);
      }
      setMessage('Risk action saved.');
    } catch (error: any) {
      setMessage(error.message || 'Failed to save risk action.');
    } finally {
      setRiskActionLoading(null);
    }
  }

  async function handleCreateCoadmin(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    setMessage('');

    try {
      await createCoadmin(coadminUsername, coadminPassword);
      setCoadminUsername('');
      setCoadminPassword('');
      setMessage('Coadmin created successfully.');
      await loadCoadminsAndStaff();
    } catch (error: any) {
      setMessage(error.message || 'Failed to create coadmin.');
    } finally {
      setLoading(false);
    }
  }

  async function handleSendMessage(event: React.FormEvent) {
    event.preventDefault();

    if (!selectedChatUser || !newMessage.trim()) return;

    try {
      await sendChatMessage(selectedChatUser.uid, newMessage.trim());
      setNewMessage('');
    } catch (error: any) {
      setMessage(error.message || 'Failed to send message.');
    }
  }

  async function handleSendPlayerMessage(event: React.FormEvent) {
    event.preventDefault();

    if (!selectedPlayerChatUser || !newPlayerMessage.trim()) return;

    try {
      await sendChatMessage(selectedPlayerChatUser.uid, newPlayerMessage.trim());
      setNewPlayerMessage('');
      markConversationAsRead(selectedPlayerChatUser.uid);
    } catch (error: any) {
      setMessage(error.message || 'Failed to send player message.');
    }
  }

  function handleSelectReachOutUser(user: AdminUser) {
    setSelectedChatUser(user);
    setNewMessage('');
    markConversationAsRead(user.uid);
  }

  function handleOpenPlayerChat(user: PlayerUser) {
    setSelectedPlayerChatUser(user);
    setNewPlayerMessage('');
    markConversationAsRead(user.uid);
  }

  async function handleTogglePlayerStatus(player: PlayerUser) {
    const wasDisabled = player.status === 'disabled';

    if (!wasDisabled) {
      const ok = window.confirm(
        'Block this player? They can still sign in to message staff; other features stay restricted until unblocked.'
      );
      if (!ok) {
        return;
      }
    }

    setPlayerBlockActionUid(player.uid);
    setMessage('');

    try {
      if (wasDisabled) {
        await unblockPlayer(player);
      } else {
        await blockPlayer(player);
      }

      await loadPlayers();
      setMessage(wasDisabled ? 'Player unblocked.' : 'Player blocked.');
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : 'Failed to update player status.'
      );
    } finally {
      setPlayerBlockActionUid(null);
    }
  }

  function handleChangeView(view: StaffView) {
    setActiveView(view);
    setMessage('');

    if (view !== 'reach-out') {
      setSelectedChatUser(null);
      setNewMessage('');
    }

    if (view !== 'view-players') {
      setSelectedPlayerChatUser(null);
      setNewPlayerMessage('');
    }
  }

  const isAdminCreatedStaff = creatorRole === 'admin';
  const menuItems: (NavigationItem & { view: StaffView })[] = isAdminCreatedStaff
    ? [
        { label: 'Dashboard', view: 'dashboard' },
        { label: 'View Tasks', view: 'view-tasks' },
        { label: 'Create Coadmin', view: 'create-coadmin' },
        { label: 'View Coadmins', view: 'view-coadmins' },
        { label: 'Reach Out', view: 'reach-out', unread: reachOutUnread },
      ]
    : [
        { label: 'Dashboard', view: 'dashboard' },
        { label: 'View Tasks', view: 'view-tasks' },
        { label: 'Create Player', view: 'create-player' },
        { label: 'View Players', view: 'view-players', unread: playerChatUnreadTotal },
        { label: 'Reach Out', view: 'reach-out', unread: reachOutUnread },
      ];
  const sidebarItems = menuItems.map((item) => ({
    ...item,
    onClick: () => handleChangeView(item.view as StaffView),
  }));

  function renderPlayerCashoutPayment(task: PlayerCashoutTask) {
    const payment = getPlayerCashoutPaymentDisplay(task);

    if (payment.method === 'qr') {
      return (
        <div className="mt-2 space-y-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-cyan-100/75">
            Payout method: QR
          </p>
          {payment.qrImageUrl ? (
            <div className="overflow-hidden rounded-xl border border-cyan-300/20 bg-black/35">
              <img
                src={payment.qrImageUrl}
                alt="Player payout QR"
                className="max-h-52 w-full object-contain"
              />
            </div>
          ) : (
            <p className="text-xs text-cyan-100/70">QR image not provided.</p>
          )}
        </div>
      );
    }

    if (payment.method === 'app') {
      return (
        <div className="mt-2 grid gap-1 text-xs text-cyan-100/75">
          <p className="font-semibold uppercase tracking-wide text-cyan-100/75">
            Payout method: Payment app
          </p>
          <p>App name: {payment.paymentAppName || 'Not provided'}</p>
          <p>Cash tag: {payment.paymentAppCashTag || 'Not provided'}</p>
          <p>Name on app: {payment.paymentAppAccountName || 'Not provided'}</p>
        </div>
      );
    }

    return (
      <p className="mt-1 text-xs text-cyan-100/70">
        Payment details: {task.paymentDetails || 'Not provided'}
      </p>
    );
  }

  return (
    <ProtectedRoute allowedRoles={['staff']}>
      <RoleSidebarLayout
        title="Staff Panel"
        activeView={activeView}
        items={sidebarItems}
        footer={<LogoutButton />}
      >
          <div className="mb-4 rounded-2xl border border-emerald-500/30 bg-emerald-500/10 p-4">
            <p className="text-xs uppercase tracking-[0.2em] text-emerald-200/80">
              Cash Box
            </p>
            <p className="mt-1 text-2xl font-bold text-emerald-100">
              {formatAed(staffCashBoxAedEstimate)}
            </p>
            <p className="mt-1 text-xs text-emerald-100/70">
              Stored base value: {formatNpr(staffCashBoxNpr)} (AED estimate via fixed FX).
              Cashout handler reward is now 1.5%.
            </p>
          </div>

          {message && (
            <div className="mb-4 rounded-2xl bg-white/10 p-3 text-sm text-neutral-300">
              {message}
            </div>
          )}

          {activeView === 'dashboard' && (
            <div className="space-y-6">
              <DashboardView
                coadminCount={isAdminCreatedStaff ? coadmins.length : 1}
                staffCount={players.length}
                unreadCount={reachOutUnread}
              />

              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                {!isAdminCreatedStaff && (
                  <div className="rounded-3xl border border-white/10 bg-white/5 p-5">
                    <p className="text-sm text-neutral-400">Players Created</p>
                    <p className="mt-2 text-3xl font-bold">{players.length}</p>
                  </div>
                )}
                <div className="rounded-3xl border border-white/10 bg-white/5 p-5">
                  <p className="text-sm text-neutral-400">Reach Out Contacts</p>
                  <p className="mt-2 text-3xl font-bold">{chatUsers.length}</p>
                </div>
              </div>

              <div>
                <button
                  type="button"
                  onClick={() => {
                    const firstRiskPlayer = riskyPlayers[0]?.playerUid || players[0]?.uid || '';
                    if (!firstRiskPlayer) {
                      setMessage('No player available to inspect.');
                      return;
                    }
                    void handleOpenRiskPanel(firstRiskPlayer);
                  }}
                  className="rounded-xl bg-white/10 px-4 py-2 text-sm font-semibold text-white hover:bg-white/20"
                >
                  View Player Risk Data
                </button>
              </div>

              {visibleRecentCarerEscalations.length > 0 && (
                <div className="rounded-2xl border border-red-500/30 bg-red-500/10 p-5">
                  <h3 className="text-lg font-bold text-red-200">
                    Urgent Carer Notifications ({visibleRecentCarerEscalations.length})
                  </h3>
                  <div className="mt-3 space-y-3">
                    {visibleRecentCarerEscalations.map((alert) => (
                      <div
                        key={alert.id}
                        className="rounded-xl border border-red-400/25 bg-black/30 p-4"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <p className="text-sm font-semibold text-white">
                              Sender: {alert.createdByCarerUsername || 'User'}
                            </p>
                            <p className="mt-1 text-sm text-red-100/90">
                              Message: {alert.message || 'No message provided.'}
                            </p>
                          </div>
                          <button
                            type="button"
                            onClick={() => void handleDismissCarerEscalation(alert.id)}
                            className="rounded-lg bg-white/15 px-3 py-1.5 text-xs font-semibold text-white hover:bg-white/25"
                          >
                            Dismiss
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {visiblePlayerCashoutTasks.length > 0 && (
                <div className="rounded-2xl border border-cyan-500/30 bg-cyan-500/10 p-5">
                  <h3 className="text-lg font-bold text-cyan-200">
                    Player Cashout Tasks ({visiblePlayerCashoutTasks.length})
                  </h3>
                  <div className="mt-3 space-y-3">
                    {visiblePlayerCashoutTasks.map((task) => {
                      const isInProgress = task.status === 'in_progress';
                      const remainingMs = getPlayerCashoutTaskCountdown(task);
                      const actionLabel = isInProgress
                        ? `Done (${formatCountdownMs(remainingMs + countdownTick * 0)})`
                        : 'Start Task';

                      return (
                        <div
                          key={task.id}
                          className="rounded-xl border border-cyan-400/25 bg-black/30 p-4"
                        >
                          <div className="flex flex-wrap items-start justify-between gap-4">
                            <div>
                              <p className="text-sm font-semibold text-white">
                                Player: {task.playerUsername}
                              </p>
                              <p className="text-sm text-cyan-100/85">
                                Amount: {formatNpr(task.amountNpr || 0)}
                              </p>
                              {renderPlayerCashoutPayment(task)}
                            </div>
                            <button
                              type="button"
                              onClick={() =>
                                void (isInProgress
                                  ? handleCompletePlayerCashoutTask(task.id)
                                  : handleStartPlayerCashoutTask(task.id))
                              }
                              disabled={playerCashoutTaskLoadingId === task.id}
                              className="rounded-lg bg-white px-4 py-2 text-sm font-semibold text-black hover:bg-neutral-200 disabled:opacity-60"
                            >
                              {playerCashoutTaskLoadingId === task.id ? 'Saving...' : actionLabel}
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {pendingTransferRequests.length > 0 && (
                <div className="rounded-2xl border border-amber-500/30 bg-amber-500/10 p-5">
                  <h3 className="text-lg font-bold text-amber-200">
                    Cash → Coin Transfer Requests ({pendingTransferRequests.length})
                  </h3>
                  <p className="mt-1 text-xs text-amber-100/80">
                    Check if player is abusing bonus or recycling funds.
                  </p>
                  <div className="mt-3 space-y-3">
                    {pendingTransferRequests.map((request) => (
                      <div
                        key={request.id}
                        className="rounded-xl border border-amber-300/25 bg-black/30 p-4"
                      >
                        <p className="text-sm font-semibold text-white">
                          Player: {request.playerUsername}
                        </p>
                        <p className="mt-1 text-xs text-amber-100/85">
                          Cash balance: {formatNpr(request.cashBalanceSnapshot || request.amountNpr || 0)}
                        </p>
                        <p className="mt-1 text-xs text-amber-100/70">
                          Requested transfer: {formatNpr(request.amountNpr || 0)}
                        </p>
                        <p className="mt-1 text-xs text-amber-100/70">
                          Requested at: {request.requestedAt?.toDate?.().toLocaleString?.() || 'Now'}
                        </p>
                        <div className="mt-3 flex flex-wrap gap-2">
                          <button
                            type="button"
                            onClick={() => void handleOpenRiskPanel(request.playerUid)}
                            className="rounded-lg bg-white/15 px-3 py-1.5 text-xs font-semibold text-white hover:bg-white/25"
                          >
                            View Player Risk Data
                          </button>
                          <button
                            type="button"
                            onClick={() => void handleApproveTransferRequest(request.id)}
                            disabled={riskActionLoading === `approve-${request.id}`}
                            className="rounded-lg bg-emerald-500 px-3 py-1.5 text-xs font-semibold text-black hover:bg-emerald-400 disabled:opacity-60"
                          >
                            {riskActionLoading === `approve-${request.id}` ? 'Saving...' : 'Approve'}
                          </button>
                          <button
                            type="button"
                            onClick={() => void handleRejectTransferRequest(request.id)}
                            disabled={riskActionLoading === `reject-${request.id}`}
                            className="rounded-lg bg-rose-500 px-3 py-1.5 text-xs font-semibold text-white hover:bg-rose-400 disabled:opacity-60"
                          >
                            {riskActionLoading === `reject-${request.id}` ? 'Saving...' : 'Reject'}
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {riskyPlayers.length > 0 && (
                <div className="rounded-2xl border border-orange-500/35 bg-orange-500/10 p-5">
                  <h3 className="text-lg font-bold text-rose-200">Risky Players</h3>
                  <div className="mt-3 space-y-2">
                    {riskyPlayers.map((playerRisk) => (
                      <button
                        key={playerRisk.playerUid}
                        type="button"
                        onClick={() => void handleOpenRiskPanel(playerRisk.playerUid)}
                        className={`flex w-full items-center justify-between rounded-xl border px-4 py-3 text-left ${getRiskCardTone(
                          playerRisk.riskLevel,
                          playerRisk.riskScore || 0
                        )}`}
                      >
                        <div>
                          <p className="text-sm font-semibold text-white">{playerRisk.playerUsername}</p>
                          <p className="text-xs text-rose-100/70">
                            {playerRisk.alerts[0] || 'Risk pattern detected'} · Last:{' '}
                            {playerRisk.lastActivityAt?.toDate?.().toLocaleString?.() || 'N/A'}
                          </p>
                        </div>
                        <div
                          className={`text-xs font-bold uppercase ${getRiskTone(
                            playerRisk.riskLevel,
                            playerRisk.riskScore || 0
                          )}`}
                        >
                          {playerRisk.riskLevel} ({playerRisk.riskScore})
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {activeView === 'view-tasks' && (
            <div>
              <h2 className="mb-6 text-3xl font-bold">Completed Tasks</h2>

              {completedPlayerCashoutTasks.length === 0 ? (
                <p className="text-sm text-neutral-400">No completed tasks yet.</p>
              ) : (
                <div className="space-y-3">
                  {completedPlayerCashoutTasks.map((task) => (
                    <div
                      key={task.id}
                      className="rounded-xl border border-cyan-400/25 bg-cyan-500/10 p-4"
                    >
                      <p className="text-sm font-semibold text-white">
                        Player: {task.playerUsername}
                      </p>
                      <p className="text-sm text-cyan-100/85">
                        Amount: {formatNpr(task.amountNpr || 0)}
                      </p>
                      {renderPlayerCashoutPayment(task)}
                      <p className="mt-1 text-xs text-cyan-100/70">
                        Completed: {task.completedAt?.toDate?.().toLocaleString?.() || 'Done'}
                      </p>
                      <p className="mt-1 text-xs text-cyan-100/70">
                        Handler: {task.assignedHandlerUsername || 'Unknown'}
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {!isAdminCreatedStaff && activeView === 'create-player' && (
            <CreateUserForm
              title="Create Player"
              buttonLabel="Create Player"
              loadingLabel="Creating..."
              username={playerUsername}
              password={playerPassword}
              referralCode={playerReferralCodeInput}
              onReferralCodeChange={setPlayerReferralCodeInput}
              showReferralCodeInput
              loading={loading}
              onUsernameChange={setPlayerUsername}
              onPasswordChange={setPlayerPassword}
              onSubmit={handleCreatePlayer}
            />
          )}

          {!isAdminCreatedStaff && activeView === 'view-players' && (
            <div>
              <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
                <h2 className="text-3xl font-bold">Players</h2>
                {playerChatUnreadTotal > 0 && (
                  <span className="rounded-full bg-red-500 px-3 py-1 text-xs font-bold text-white">
                    {playerChatUnreadTotal} unread
                  </span>
                )}
              </div>

              {loadingList ? (
                <p className="text-sm text-neutral-400">Loading...</p>
              ) : players.length === 0 ? (
                <p className="text-sm text-neutral-400">No players found.</p>
              ) : (
                <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                  {playersSortedByUnread.map((player) => {
                    const unreadFromPlayer = unreadCounts[player.uid] || 0;
                    const playerRisk = riskByPlayerUid.get(player.uid);
                    const playerCardClass = getRiskPlayerCardClass(
                      playerRisk?.riskLevel || 'low',
                      playerRisk?.riskScore || 0,
                      unreadFromPlayer > 0
                    );

                    return (
                    <div
                      key={player.uid}
                      className={`${playerCardClass} relative overflow-hidden`}
                    >
                      {unreadFromPlayer > 0 && (
                        <div
                          className="absolute right-3 top-3 z-10 flex h-8 min-w-[2rem] items-center justify-center rounded-full bg-red-500 px-2 text-xs font-bold text-white shadow-lg ring-2 ring-red-400/40 animate-pulse"
                          title={`${unreadFromPlayer} unread message${unreadFromPlayer === 1 ? '' : 's'}`}
                        >
                          {unreadFromPlayer > 99 ? '99+' : unreadFromPlayer}
                        </div>
                      )}
                      <h3
                        className={`flex flex-wrap items-center gap-2 pr-20 text-2xl font-bold capitalize`}
                      >
                        <OnlineIndicator
                          online={Boolean(staffOnlineByUid[player.uid])}
                          sizeClassName="h-3 w-3"
                        />
                        <span>{player.username || 'Unnamed Player'}</span>
                        {unreadFromPlayer > 0 && (
                          <span className="ml-1 inline-block align-middle text-sm font-semibold text-red-300">
                            · Unread
                          </span>
                        )}
                      </h3>
                      <p className="mt-3 text-sm text-neutral-400">
                        Role: <span className="text-white">{player.role}</span>
                      </p>
                      <p className="mt-1 text-sm text-neutral-400">
                        Status:{' '}
                        <span
                          className={
                            player.status === 'disabled' ? 'text-amber-200' : 'text-white'
                          }
                        >
                          {player.status}
                        </span>
                      </p>
                      {playerRisk ? (
                        <p className="mt-2 text-xs font-semibold text-orange-200/90">
                          Risk: {String(playerRisk.riskLevel).toUpperCase()} ({playerRisk.riskScore || 0})
                        </p>
                      ) : null}
                      <p className="mt-2 text-sm text-neutral-300">
                        Coin:{' '}
                        <span className="font-bold tabular-nums text-amber-200">
                          {Math.max(0, Math.floor(Number(player.coin || 0))).toLocaleString()}
                        </span>
                      </p>
                      {player.cash != null && (
                        <p className="mt-0.5 text-xs text-neutral-500">
                          Cash (view only):{' '}
                          {Math.max(0, Math.floor(Number(player.cash || 0))).toLocaleString()}
                        </p>
                      )}
                      <div className="mt-4 flex flex-wrap gap-2">
                        <button
                          type="button"
                          onClick={() => void handleOpenRiskPanel(player.uid)}
                          disabled={riskActionLoading === `open-${player.uid}`}
                          className="rounded-lg bg-white/10 px-3 py-2 text-xs font-semibold text-white hover:bg-white/20 disabled:opacity-60"
                        >
                          {riskActionLoading === `open-${player.uid}`
                            ? 'Loading...'
                            : 'View Player Risk Data'}
                        </button>
                        <button
                          type="button"
                          onClick={() => handleOpenPlayerChat(player)}
                          className={`rounded-lg px-3 py-2 text-xs font-semibold ${
                            unreadFromPlayer > 0
                              ? 'bg-cyan-500/40 text-cyan-50 ring-1 ring-cyan-300/50 hover:bg-cyan-500/50'
                              : 'bg-cyan-500/20 text-cyan-200 hover:bg-cyan-500/30'
                          }`}
                        >
                          Message Player{' '}
                          {unreadFromPlayer > 0
                            ? `(${unreadFromPlayer > 9 ? '9+' : unreadFromPlayer} unread)`
                            : ''}
                        </button>
                        {player.status === 'disabled' ? (
                          <button
                            type="button"
                            onClick={() => void handleTogglePlayerStatus(player)}
                            disabled={playerBlockActionUid === player.uid}
                            className="rounded-lg border border-emerald-500/40 bg-emerald-500/15 px-3 py-2 text-xs font-semibold text-emerald-200 hover:bg-emerald-500/25 disabled:opacity-60"
                          >
                            {playerBlockActionUid === player.uid ? 'Working…' : 'Unblock player'}
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={() => void handleTogglePlayerStatus(player)}
                            disabled={playerBlockActionUid === player.uid}
                            className="rounded-lg border border-rose-500/35 bg-rose-500/15 px-3 py-2 text-xs font-semibold text-rose-200 hover:bg-rose-500/25 disabled:opacity-60"
                          >
                            {playerBlockActionUid === player.uid ? 'Working…' : 'Block player'}
                          </button>
                        )}
                      </div>
                    </div>
                    );
                  })}
                </div>
              )}

              {selectedPlayerChatUser && (
                <div className="mt-6 flex max-h-[min(80dvh,42rem)] flex-col overflow-hidden rounded-2xl border border-cyan-500/30 bg-cyan-500/10 p-4 sm:max-h-[min(85dvh,46rem)]">
                  <div className="shrink-0 border-b border-cyan-400/20 pb-3">
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex items-center gap-2">
                        <OnlineIndicator
                          online={Boolean(staffOnlineByUid[selectedPlayerChatUser.uid])}
                          sizeClassName="h-3 w-3"
                        />
                        <div>
                          <h3 className="text-lg font-bold text-cyan-100">
                            Chat with {selectedPlayerChatUser.username}
                          </h3>
                          <p className="text-xs text-cyan-100/70">Player support conversation</p>
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => setSelectedPlayerChatUser(null)}
                        className="rounded-lg bg-white/15 px-3 py-1.5 text-xs font-semibold text-white hover:bg-white/25"
                      >
                        Close
                      </button>
                    </div>
                  </div>

                  <div
                    ref={staffPlayerScrollRef}
                    className="mt-3 min-h-0 flex-1 space-y-2 overflow-y-auto overflow-x-hidden overscroll-contain rounded-xl bg-black/25 p-3"
                  >
                    {pagedStaffPlayerChat.hasMoreOlder ? (
                      <div className="sticky top-0 z-10 -mt-0.5 mb-2 flex justify-center">
                        <button
                          type="button"
                          disabled={pagedStaffPlayerChat.loadingOlder}
                          onClick={() => void pagedStaffPlayerChat.loadOlder()}
                          className="rounded-full border border-cyan-400/35 bg-black/50 px-4 py-1.5 text-xs font-semibold text-cyan-100/90 shadow-sm hover:border-cyan-300/50 disabled:opacity-50"
                        >
                          {pagedStaffPlayerChat.loadingOlder
                            ? 'Loading…'
                            : 'Load previous messages'}
                        </button>
                      </div>
                    ) : null}
                    {playerMessages.length === 0 ? (
                      <p className="text-sm text-cyan-100/60">
                        No messages yet. Send first message to player.
                      </p>
                    ) : (
                      playerMessages.map((msg) => (
                        <div
                          key={msg.id}
                          className={`flex ${msg.sender === 'admin' ? 'justify-end' : 'justify-start'}`}
                        >
                          <div
                            className={`max-w-[80%] rounded-xl px-3 py-2 text-sm ${
                              msg.sender === 'admin'
                                ? 'bg-white text-black'
                                : 'bg-cyan-950/70 text-cyan-50'
                            }`}
                          >
                            {msg.text ? <p>{msg.text}</p> : null}
                            {msg.imageUrl ? (
                              <a
                                className="mt-1 block text-xs underline"
                                href={msg.imageUrl}
                                target="_blank"
                                rel="noreferrer"
                              >
                                View image
                              </a>
                            ) : null}
                            <p className="mt-1 text-[11px] opacity-70">
                              {msg.timestamp.toLocaleTimeString()}
                            </p>
                          </div>
                        </div>
                      ))
                    )}
                  </div>

                  <form
                    onSubmit={handleSendPlayerMessage}
                    className="mt-3 flex shrink-0 gap-2"
                  >
                    <input
                      value={newPlayerMessage}
                      onChange={(event) => setNewPlayerMessage(event.target.value)}
                      placeholder="Type message to player..."
                      className="min-w-0 flex-1 rounded-xl border border-cyan-400/25 bg-black/30 px-4 py-3 text-sm text-white outline-none focus:border-cyan-300"
                    />
                    <button
                      type="submit"
                      disabled={!newPlayerMessage.trim()}
                      className="rounded-xl bg-white px-4 py-2 text-sm font-semibold text-black hover:bg-neutral-200 disabled:opacity-50"
                    >
                      Send
                    </button>
                  </form>
                </div>
              )}
            </div>
          )}

          {isAdminCreatedStaff && activeView === 'create-coadmin' && (
            <CreateUserForm
              title="Create Coadmin"
              buttonLabel="Create Coadmin"
              loadingLabel="Creating..."
              username={coadminUsername}
              password={coadminPassword}
              loading={loading}
              onUsernameChange={setCoadminUsername}
              onPasswordChange={setCoadminPassword}
              onSubmit={handleCreateCoadmin}
            />
          )}

          {isAdminCreatedStaff && activeView === 'view-coadmins' && (
            <div>
              <h2 className="mb-6 text-3xl font-bold">Coadmins</h2>

              {loadingList ? (
                <p className="text-sm text-neutral-400">Loading...</p>
              ) : coadmins.length === 0 ? (
                <p className="text-sm text-neutral-400">No coadmins found.</p>
              ) : (
                <div className="space-y-4">
                  {coadmins.map((coadmin) => {
                    const coadminStaff = allStaffUsers.filter((staff) =>
                      belongsToCoadmin(staff, coadmin.uid)
                    );

                    return (
                      <div
                        key={coadmin.uid}
                        className="rounded-2xl border border-white/10 bg-white/5 p-5"
                      >
                        <h3 className="flex flex-wrap items-center gap-2 text-2xl font-bold">
                          <OnlineIndicator
                            online={Boolean(staffOnlineByUid[coadmin.uid])}
                            sizeClassName="h-3 w-3"
                          />
                          <span className="text-white">Co-admin</span>
                        </h3>
                        <p className="mt-2 text-sm text-neutral-400">
                          Status: <span className="text-white">{coadmin.status}</span>
                        </p>

                        <div className="mt-4 rounded-xl border border-white/10 bg-black/30 p-4">
                          <p className="text-sm font-semibold text-white">
                            Staff under this coadmin ({coadminStaff.length})
                          </p>

                          {coadminStaff.length === 0 ? (
                            <p className="mt-2 text-sm text-neutral-400">
                              No staff linked yet.
                            </p>
                          ) : (
                            <div className="mt-3 space-y-2">
                              {coadminStaff.map((staff) => (
                                <div
                                  key={staff.uid}
                                  className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm"
                                >
                                  <OnlineIndicator
                                    online={Boolean(staffOnlineByUid[staff.uid])}
                                    sizeClassName="h-2.5 w-2.5"
                                    ringClassName="ring-black/30"
                                  />
                                  <span className="font-mono font-semibold text-white">
                                    {staff.username || '—'}
                                  </span>
                                  <span className="text-neutral-400">· {staff.status}</span>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {activeView === 'reach-out' && (
            <ReachOutView
              chatUsers={chatUsers}
              selectedChatUser={selectedChatUser}
              messages={messages}
              newMessage={newMessage}
              unreadCounts={reachOutUnreadCounts}
              messagesScrollRef={staffReachOutScrollRef}
              hasMoreOlderMessages={pagedStaffAgentChat.hasMoreOlder}
              loadingOlderMessages={pagedStaffAgentChat.loadingOlder}
              onLoadOlderMessages={pagedStaffAgentChat.loadOlder}
              onSelectUser={handleSelectReachOutUser}
              onMessageChange={setNewMessage}
              onSendMessage={handleSendMessage}
              onlineByUid={staffOnlineByUid}
              nameMode="staff"
            />
          )}
      </RoleSidebarLayout>

      {showRiskPanel && selectedRiskSnapshot && (
        <div
          onClick={() => setShowRiskPanel(false)}
          className="fixed inset-0 z-[58] flex items-center justify-center bg-black/80 px-4"
        >
          <div
            onClick={(event) => event.stopPropagation()}
            className="max-h-[90vh] w-full max-w-4xl overflow-y-auto rounded-3xl border border-white/15 bg-neutral-900 p-6 text-white"
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h3 className="text-2xl font-bold">Player Risk Data</h3>
              <button
                type="button"
                onClick={() => setShowRiskPanel(false)}
                className="rounded-lg bg-white/10 px-3 py-1.5 text-xs font-semibold hover:bg-white/20"
              >
                Close
              </button>
            </div>

            <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
              <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
                <p className="text-xs text-neutral-400">Player Summary</p>
                <p className="mt-2 text-lg font-semibold">{selectedRiskSnapshot.playerUsername}</p>
                <p
                  className={`text-sm font-bold uppercase ${getRiskTone(
                    selectedRiskSnapshot.riskLevel,
                    selectedRiskSnapshot.riskScore || 0
                  )}`}
                >
                  {selectedRiskSnapshot.riskLevel} risk
                </p>
                <p className="text-sm text-neutral-300">
                  Score: {selectedRiskSnapshot.riskScore}
                </p>
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
                <p className="text-xs text-neutral-400">Activity (24h / 7d)</p>
                <p className="mt-2 text-sm text-neutral-200">
                  Cashouts: {selectedRiskSnapshot.activity24h?.cashouts || 0} /{' '}
                  {selectedRiskSnapshot.activity7d?.cashouts || 0}
                </p>
                <p className="text-sm text-neutral-200">
                  Transfers: {selectedRiskSnapshot.activity24h?.transfers || 0} /{' '}
                  {selectedRiskSnapshot.activity7d?.transfers || 0}
                </p>
                <p className="text-sm text-neutral-200">
                  Bonus: {selectedRiskSnapshot.activity24h?.bonus || 0} /{' '}
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
              {pendingTransferRequests
                .filter((request) => request.playerUid === selectedRiskSnapshot.playerUid)
                .slice(0, 1)
                .map((request) => (
                  <div key={request.id} className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => void handleApproveTransferRequest(request.id)}
                      disabled={riskActionLoading === `approve-${request.id}`}
                      className="rounded-lg bg-emerald-500 px-3 py-2 text-xs font-semibold text-black hover:bg-emerald-400 disabled:opacity-60"
                    >
                      Approve transfer
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleRejectTransferRequest(request.id)}
                      disabled={riskActionLoading === `reject-${request.id}`}
                      className="rounded-lg bg-rose-500 px-3 py-2 text-xs font-semibold text-white hover:bg-rose-400 disabled:opacity-60"
                    >
                      Reject transfer
                    </button>
                  </div>
                ))}
              <button
                type="button"
                onClick={() => void handleStaffRiskAction('review')}
                disabled={riskActionLoading === `review-${selectedRiskSnapshot.playerUid}`}
                className="rounded-lg bg-white/15 px-3 py-2 text-xs font-semibold hover:bg-white/25 disabled:opacity-60"
              >
                Mark reviewed
              </button>
              <button
                type="button"
                onClick={() => void handleStaffRiskAction('bonus', true)}
                disabled={riskActionLoading === `bonus-${selectedRiskSnapshot.playerUid}`}
                className="rounded-lg bg-rose-500 px-3 py-2 text-xs font-semibold text-white hover:bg-rose-400 disabled:opacity-60"
              >
                Block bonus temporarily
              </button>
              <button
                type="button"
                onClick={() => void handleStaffRiskAction('bonus', false)}
                disabled={riskActionLoading === `bonus-${selectedRiskSnapshot.playerUid}`}
                className="rounded-lg bg-emerald-500 px-3 py-2 text-xs font-semibold text-black hover:bg-emerald-400 disabled:opacity-60"
              >
                Unblock bonus
              </button>
              <button
                type="button"
                onClick={() => void handleStaffRiskAction('transfer', true)}
                disabled={riskActionLoading === `transfer-${selectedRiskSnapshot.playerUid}`}
                className="rounded-lg bg-rose-500 px-3 py-2 text-xs font-semibold text-white hover:bg-rose-400 disabled:opacity-60"
              >
                Block transfer temporarily
              </button>
              <button
                type="button"
                onClick={() => void handleStaffRiskAction('transfer', false)}
                disabled={riskActionLoading === `transfer-${selectedRiskSnapshot.playerUid}`}
                className="rounded-lg bg-emerald-500 px-3 py-2 text-xs font-semibold text-black hover:bg-emerald-400 disabled:opacity-60"
              >
                Unblock transfer
              </button>
            </div>
          </div>
        </div>
      )}

      {showCarerEscalationSplash && latestCarerEscalation && (
        <div
          onClick={() => setShowCarerEscalationSplash(false)}
          className="fixed inset-0 z-[60] flex items-center justify-center bg-red-700/90 px-4 backdrop-blur-sm"
        >
          <div className="w-full max-w-2xl rounded-3xl border border-red-200/40 bg-gradient-to-br from-red-700 via-red-800 to-red-950 p-8 text-white shadow-2xl">
            <p className="text-xs font-bold uppercase tracking-[0.3em] text-red-100">
              {latestCarerEscalation.contextType === 'cashbox_inquiry'
                ? 'Carer Inquiry Alert'
                : 'Carer Help Alert'}
            </p>
            <h2 className="mt-3 text-3xl font-bold">
              {latestCarerEscalation.contextType === 'cashbox_inquiry'
                ? 'Urgent inquiry from carer.'
                : 'This player is being an idiot.'}
            </h2>
            {latestCarerEscalation.contextType !== 'cashbox_inquiry' && (
              <p className="mt-3 text-sm text-red-100/85">
                Player: {latestCarerEscalation.playerUsername} /{' '}
                {latestCarerEscalation.gameName}
              </p>
            )}
            <p className="mt-3 text-sm text-red-100/90">
              Message: {latestCarerEscalation.message}
            </p>
            <p className="mt-2 text-sm text-red-100/75">
              Sender: {latestCarerEscalation.createdByCarerUsername}
            </p>
            <p className="mt-6 text-sm font-semibold text-red-100">
              Click anywhere to dismiss.
            </p>
          </div>
        </div>
      )}
    </ProtectedRoute>
  );
}
