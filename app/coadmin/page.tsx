'use client';

import { useEffect, useRef, useState } from 'react';
import { collection, getDocs, query, where } from 'firebase/firestore';
import imageCompression from 'browser-image-compression';

import ProtectedRoute from '../../components/auth/ProtectedRoute';
import DashboardView from '../../components/admin/DashboardView';
import CreateUserForm from '../../components/admin/CreateUserForm';
import UserManagementView from '../../components/admin/UserManagementView';
import ReachOutView from '../../components/admin/ReachOutView';

import { auth, db } from '@/lib/firebase/client';
import {
  belongsToCoadmin,
  getCurrentUserCoadminUid,
} from '@/lib/coadmin/scope';

import {
  StaffUser,
  CarerUser,
  PlayerUser,
  blockCarer,
  blockStaff,
  createStaff,
  createCarer,
  createPlayer,
  deleteStaff,
  deleteCarer,
  deletePlayer,
  getStaff,
  getCarers,
  getPlayers,
  unblockCarer,
  unblockStaff,
} from '@/features/users/adminUsers';

import {
  GameLogin,
  createGameLogin,
  getMyGameLogins,
  updateGameLogin,
} from '@/features/games/gameLogins';
import { listenToUrgentPlayerGameRequestsByCoadmin } from '@/features/games/playerGameRequests';
import {
  CarerEscalationAlert,
  CarerRechargeRedeemTotals,
  deleteCarerEscalationAlert,
  listenCarerRechargeRedeemTotalsByCoadmin,
  listenToCarerEscalationAlertsByCoadmin,
} from '@/features/games/carerTasks';
import {
  CarerCashoutRequest,
  completeCarerCashoutRequest,
  listenPendingCashoutsByCoadmin,
} from '@/features/cashouts/carerCashouts';
import {
  completePlayerCashoutTask,
  getEffectivePlayerCashoutTaskStatus,
  getPlayerCashoutTaskCountdown,
  listenPlayerCashoutTasksByCoadmin,
  PlayerCashoutTask,
  startPlayerCashoutTask,
} from '@/features/cashouts/playerCashoutTasks';
import {
  BonusEvent,
  createBonusEvent,
  listenBonusEventsByCoadmin,
} from '../../features/bonusEvents/bonusEvents';

import {
  listenToMessages,
  listenToUnreadCounts,
  markConversationAsRead,
  sendChatMessage,
  sendImageMessage,
} from '@/features/messages/chatMessages';

import { AdminUser, ChatMessage } from '../../components/admin/types';

type CoadminView =
  | 'dashboard'
  | 'view-tasks'
  | 'create-bonus-event'
  | 'view-bonus-events'
  | 'add-staff'
  | 'view-staff'
  | 'create-carer'
  | 'view-carers'
  | 'create-player'
  | 'view-players'
  | 'add-games'
  | 'game-list'
  | 'reach-out';

function formatNprDisplay(value: number) {
  return `NPR ${Math.round(value).toLocaleString()}`;
}

export default function CoadminPage() {
  const [activeView, setActiveView] = useState<CoadminView>('dashboard');

  const [staffUsername, setStaffUsername] = useState('');
  const [staffPassword, setStaffPassword] = useState('');
  const [staffList, setStaffList] = useState<StaffUser[]>([]);
  const [selectedStaff, setSelectedStaff] = useState<StaffUser | null>(null);
  const [deleteStaffTarget, setDeleteStaffTarget] = useState<StaffUser | null>(null);

  const [carerUsername, setCarerUsername] = useState('');
  const [carerPassword, setCarerPassword] = useState('');
  const [carerList, setCarerList] = useState<CarerUser[]>([]);
  const [selectedCarer, setSelectedCarer] = useState<CarerUser | null>(null);
  const [deleteCarerTarget, setDeleteCarerTarget] = useState<CarerUser | null>(null);

  const [playerUsername, setPlayerUsername] = useState('');
  const [playerPassword, setPlayerPassword] = useState('');
  const [playerReferralCodeInput, setPlayerReferralCodeInput] = useState('');
  const [playerList, setPlayerList] = useState<PlayerUser[]>([]);
  const [selectedPlayer, setSelectedPlayer] = useState<PlayerUser | null>(null);
  const [deletePlayerTarget, setDeletePlayerTarget] = useState<PlayerUser | null>(null);

  const [gameName, setGameName] = useState('');
  const [gameUsername, setGameUsername] = useState('');
  const [gamePassword, setGamePassword] = useState('');
  const [gameLogins, setGameLogins] = useState<GameLogin[]>([]);
  const [editingGame, setEditingGame] = useState<GameLogin | null>(null);
  const [bonusName, setBonusName] = useState('');
  const [bonusGameName, setBonusGameName] = useState('');
  const [bonusAmount, setBonusAmount] = useState('');
  const [bonusDescription, setBonusDescription] = useState('');
  const [bonusPercentage, setBonusPercentage] = useState('');
  const [bonusEvents, setBonusEvents] = useState<BonusEvent[]>([]);

  const [chatUsers, setChatUsers] = useState<AdminUser[]>([]);
  const [reachOutChatUser, setReachOutChatUser] = useState<AdminUser | null>(null);
  const [staffChatUser, setStaffChatUser] = useState<StaffUser | null>(null);

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [newMessage, setNewMessage] = useState('');
  const [unreadCounts, setUnreadCounts] = useState<Record<string, number>>({});

  const [selectedImage, setSelectedImage] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [sendingImage, setSendingImage] = useState(false);

  const previousUnreadRef = useRef(0);
  const previousUrgentRequestCountRef = useRef<number | null>(null);
  const latestCarerEscalationIdRef = useRef<string | null>(null);
  const hasSeenCarerEscalationSnapshotRef = useRef(false);
  const suppressedCashoutIdsRef = useRef<Set<string>>(new Set());

  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const [blocking, setBlocking] = useState(false);
  const [loadingList, setLoadingList] = useState(false);
  const [urgentRequestCount, setUrgentRequestCount] = useState(0);
  const [showUrgentSplash, setShowUrgentSplash] = useState(false);
  const [latestCarerEscalation, setLatestCarerEscalation] =
    useState<CarerEscalationAlert | null>(null);
  const [showCarerEscalationSplash, setShowCarerEscalationSplash] = useState(false);
  const [recentCarerEscalations, setRecentCarerEscalations] = useState<
    CarerEscalationAlert[]
  >([]);
  const [dismissedCarerEscalationIds, setDismissedCarerEscalationIds] = useState<
    string[]
  >([]);
  const [pendingCashouts, setPendingCashouts] = useState<CarerCashoutRequest[]>([]);
  const [carerRechargeRedeemTotals, setCarerRechargeRedeemTotals] = useState<
    Record<string, CarerRechargeRedeemTotals>
  >({});
  const [playerCashoutTasks, setPlayerCashoutTasks] = useState<PlayerCashoutTask[]>([]);
  const [playerCashoutTaskLoadingId, setPlayerCashoutTaskLoadingId] = useState<string | null>(
    null
  );
  const [countdownTick, setCountdownTick] = useState(0);

  const activeChatUser =
    activeView === 'reach-out' ? reachOutChatUser : staffChatUser;

  const totalUnread = Object.values(unreadCounts).reduce(
    (total, count) => total + count,
    0
  );

  const staffUnreadCount = staffList.reduce(
    (total, staff) => total + (unreadCounts[staff.uid] || 0),
    0
  );

  const reachOutUnreadCount = chatUsers.reduce(
    (total, user) => total + (unreadCounts[user.uid] || 0),
    0
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
  const myBonusEvents = bonusEvents.filter((event) => event.createdByUid === currentUserUid);

  useEffect(() => {
    if (activeView === 'dashboard') {
      loadStaffList();
      loadCarerList();
      loadPlayerList();
      loadGameLogins();
      loadChatUsers();
    }

    if (activeView === 'view-staff') loadStaffList();
    if (activeView === 'view-carers') loadCarerList();
    if (activeView === 'view-players') loadPlayerList();
    if (activeView === 'game-list') loadGameLogins();
    if (activeView === 'reach-out') loadChatUsers();
  }, [activeView]);

  useEffect(() => {
    let isCancelled = false;
    let unsubscribe: (() => void) | undefined;

    async function startBonusEventsListener() {
      try {
        const coadminUid = await getCurrentUserCoadminUid();

        if (isCancelled) {
          return;
        }

        unsubscribe = listenBonusEventsByCoadmin(
          coadminUid,
          (events) => {
            if (!isCancelled) {
              setBonusEvents(events);
            }
          },
          (error) => {
            if (!isCancelled) {
              setMessage(error.message || 'Failed to listen for bonus events.');
            }
          }
        );
      } catch (error: any) {
        if (!isCancelled) {
          setMessage(error.message || 'Failed to start bonus events listener.');
        }
      }
    }

    void startBonusEventsListener();

    return () => {
      isCancelled = true;
      unsubscribe?.();
    };
  }, []);

  useEffect(() => {
    let isCancelled = false;
    let unsubscribe: (() => void) | undefined;

    async function startCarerTotalsListener() {
      try {
        const coadminUid = await getCurrentUserCoadminUid();

        if (isCancelled) {
          return;
        }

        unsubscribe = listenCarerRechargeRedeemTotalsByCoadmin(
          coadminUid,
          (totals) => {
            if (!isCancelled) {
              setCarerRechargeRedeemTotals(totals);
            }
          },
          (error) => {
            if (!isCancelled) {
              setMessage(error.message || 'Failed to listen for carer totals.');
            }
          }
        );
      } catch (error: any) {
        if (!isCancelled) {
          setMessage(error.message || 'Failed to start carer totals listener.');
        }
      }
    }

    void startCarerTotalsListener();

    return () => {
      isCancelled = true;
      unsubscribe?.();
    };
  }, []);

  useEffect(() => {
    const currentUser = auth.currentUser;
    if (!currentUser) return;

    const unsubscribe = listenToUnreadCounts(setUnreadCounts);
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    let isCancelled = false;
    let unsubscribe: (() => void) | undefined;

    async function startCashoutListener() {
      try {
        const coadminUid = await getCurrentUserCoadminUid();

        if (isCancelled) {
          return;
        }

        unsubscribe = listenPendingCashoutsByCoadmin(
          coadminUid,
          (items) => {
            if (!isCancelled) {
              const visibleItems = items.filter(
                (item) => !suppressedCashoutIdsRef.current.has(item.id)
              );
              setPendingCashouts(visibleItems);
            }
          },
          (error) => {
            if (!isCancelled) {
              setMessage(error.message || 'Failed to listen for carer cashout requests.');
            }
          }
        );
      } catch (err: unknown) {
        if (!isCancelled) {
          setMessage(
            err instanceof Error
              ? err.message
              : 'Failed to start carer cashout listener.'
          );
        }
      }
    }

    void startCashoutListener();

    return () => {
      isCancelled = true;
      unsubscribe?.();
    };
  }, []);

  useEffect(() => {
    let isCancelled = false;
    let unsubscribe: (() => void) | undefined;

    async function startPlayerCashoutTaskListener() {
      try {
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
  }, []);

  useEffect(() => {
    if (pendingCashouts.length === 0) {
      return;
    }

    const playAudio = () => {
      const audio = new Audio('/notification.mp3');
      audio.volume = 0.9;
      audio.play().catch(() => {});
    };

    playAudio();
    const intervalId = window.setInterval(playAudio, 60000);

    return () => window.clearInterval(intervalId);
  }, [pendingCashouts.length]);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      setCountdownTick((tick) => tick + 1);
    }, 1000);

    return () => window.clearInterval(intervalId);
  }, []);

  useEffect(() => {
    if (totalUnread > previousUnreadRef.current) {
      playNotificationSound();
    }

    previousUnreadRef.current = totalUnread;
  }, [totalUnread]);

  useEffect(() => {
    let isCancelled = false;
    let unsubscribe: (() => void) | undefined;

    async function startUrgentListener() {
      try {
        const coadminUid = await getCurrentUserCoadminUid();

        if (isCancelled) {
          return;
        }

        unsubscribe = listenToUrgentPlayerGameRequestsByCoadmin(
          coadminUid,
          (requests) => {
            if (isCancelled) {
              return;
            }

            const nextCount = requests.length;
            const previousCount = previousUrgentRequestCountRef.current;

            setUrgentRequestCount(nextCount);
            setShowUrgentSplash(nextCount > 0);

            if (previousCount !== null && nextCount > previousCount) {
              const audio = new Audio('/urgency-sound.mp3');
              audio.volume = 0.9;
              audio.play().catch(() => {});
            }

            previousUrgentRequestCountRef.current = nextCount;
          },
          (error) => {
            if (!isCancelled) {
              setMessage(error.message || 'Failed to listen for urgent player requests.');
            }
          }
        );
      } catch (err: unknown) {
        if (!isCancelled) {
          setMessage(
            err instanceof Error
              ? err.message
              : 'Failed to start urgent player request listener.'
          );
        }
      }
    }

    void startUrgentListener();

    return () => {
      isCancelled = true;
      unsubscribe?.();
    };
  }, []);

  useEffect(() => {
    let isCancelled = false;
    let unsubscribe: (() => void) | undefined;

    async function startCarerEscalationListener() {
      try {
        const coadminUid = await getCurrentUserCoadminUid();

        if (isCancelled) {
          return;
        }

        unsubscribe = listenToCarerEscalationAlertsByCoadmin(
          coadminUid,
          (alerts) => {
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
          },
          (error) => {
            if (!isCancelled) {
              setMessage(error.message || 'Failed to listen for carer help alerts.');
            }
          }
        );
      } catch (err: unknown) {
        if (!isCancelled) {
          setMessage(
            err instanceof Error
              ? err.message
              : 'Failed to start carer help alert listener.'
          );
        }
      }
    }

    void startCarerEscalationListener();

    return () => {
      isCancelled = true;
      unsubscribe?.();
    };
  }, []);

  useEffect(() => {
    if (!activeChatUser) return;

    const currentUser = auth.currentUser;

    if (!currentUser) {
      setMessage('Not authenticated.');
      return;
    }

    markConversationAsRead(activeChatUser.uid);

    const unsubscribe = listenToMessages(activeChatUser.uid, (items) => {
      const mappedMessages: ChatMessage[] = items.map((msg) => ({
        id: msg.id,
        text: msg.text,
        imageUrl: msg.imageUrl,
        sender: msg.senderUid === currentUser.uid ? 'admin' : 'user',
        timestamp: msg.createdAt?.toDate?.() || new Date(),
      }));

      setMessages(mappedMessages);
      markConversationAsRead(activeChatUser.uid);
    });

    return () => unsubscribe();
  }, [activeChatUser]);

  function playNotificationSound() {
    const audio = new Audio('/notification.mp3');
    audio.volume = 0.6;
    audio.play().catch(() => {});
  }

  async function getUsersForCurrentCoadmin<
    T extends { createdBy?: string | null; coadminUid?: string | null }
  >(loader: () => Promise<T[]>) {
    const coadminUid = await getCurrentUserCoadminUid();
    const list = await loader();

    return list.filter((user) => belongsToCoadmin(user, coadminUid));
  }

  async function loadStaffList() {
    setLoadingList(true);

    try {
      setStaffList(await getUsersForCurrentCoadmin(getStaff));
    } catch (err: any) {
      setMessage(err.message || 'Failed to load staff.');
    } finally {
      setLoadingList(false);
    }
  }

  async function loadCarerList() {
    setLoadingList(true);

    try {
      setCarerList(await getUsersForCurrentCoadmin(getCarers));
    } catch (err: any) {
      setMessage(err.message || 'Failed to load carers.');
    } finally {
      setLoadingList(false);
    }
  }

  async function loadPlayerList() {
    setLoadingList(true);

    try {
      setPlayerList(await getUsersForCurrentCoadmin(getPlayers));
    } catch (err: any) {
      setMessage(err.message || 'Failed to load players.');
    } finally {
      setLoadingList(false);
    }
  }

  async function loadGameLogins() {
    setLoadingList(true);

    try {
      const coadminUid = await getCurrentUserCoadminUid();
      const list = await getMyGameLogins();
      const relatedGames = list.filter((game) => belongsToCoadmin(game, coadminUid));
      setGameLogins(sortByNewest(relatedGames));
    } catch (err: any) {
      setMessage(err.message || 'Failed to load games.');
    } finally {
      setLoadingList(false);
    }
  }

  async function loadChatUsers() {
    try {
      const adminQuery = query(collection(db, 'users'), where('role', '==', 'admin'));
      const adminSnapshot = await getDocs(adminQuery);

      const admins = adminSnapshot.docs.map((docSnap) => ({
        id: docSnap.id,
        ...(docSnap.data() as any),
      })) as AdminUser[];

      const adminUIDs = admins.map((admin: any) => admin.uid);
      const allStaff = await getStaff();

      const adminStaff = allStaff.filter((staff) =>
        adminUIDs.includes(staff.createdBy || '')
      );

      setChatUsers([...admins, ...adminStaff]);
    } catch (err: any) {
      setMessage(err.message || 'Failed to load users.');
    }
  }

  async function handleCreateStaff(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setMessage('');

    try {
      await createStaff(staffUsername, staffPassword);
      setStaffUsername('');
      setStaffPassword('');
      setMessage('Staff created successfully.');
      await loadStaffList();
    } catch (err: any) {
      setMessage(err.message || 'Failed to create staff.');
    } finally {
      setLoading(false);
    }
  }

  async function handleCreateCarer(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setMessage('');

    try {
      await createCarer(carerUsername, carerPassword);
      setCarerUsername('');
      setCarerPassword('');
      setMessage('Carer created successfully.');
      await loadCarerList();
    } catch (err: any) {
      setMessage(err.message || 'Failed to create carer.');
    } finally {
      setLoading(false);
    }
  }

  async function handleCreatePlayer(e: React.FormEvent) {
    e.preventDefault();
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
      await loadPlayerList();
    } catch (err: any) {
      setMessage(err.message || 'Failed to create player.');
    } finally {
      setLoading(false);
    }
  }

  async function handleCreateGame(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setMessage('');

    try {
      await createGameLogin(gameName, gameUsername, gamePassword);
      setGameName('');
      setGameUsername('');
      setGamePassword('');
      setMessage('Game login added successfully.');
      await loadGameLogins();
    } catch (err: any) {
      setMessage(err.message || 'Failed to add game.');
    } finally {
      setLoading(false);
    }
  }

  async function handleUpdateGame(e: React.FormEvent) {
    e.preventDefault();

    if (!editingGame) return;

    setLoading(true);
    setMessage('');

    try {
      await updateGameLogin(editingGame.id, {
        gameName: editingGame.gameName,
        username: editingGame.username,
        password: editingGame.password,
      });

      setEditingGame(null);
      setMessage('Game login updated.');
      await loadGameLogins();
    } catch (err: any) {
      setMessage(err.message || 'Failed to update game.');
    } finally {
      setLoading(false);
    }
  }

  async function handleDeleteStaff() {
    if (!deleteStaffTarget) return;
    setLoading(true);

    try {
      await deleteStaff(deleteStaffTarget);
      await loadStaffList();

      if (staffChatUser?.uid === deleteStaffTarget.uid) {
        setStaffChatUser(null);
        setMessages([]);
      }

      setSelectedStaff(null);
      setDeleteStaffTarget(null);
      setMessage('Staff deleted.');
    } catch (err: any) {
      setMessage(err.message || 'Delete failed.');
    } finally {
      setLoading(false);
    }
  }

  async function handleDeleteCarer() {
    if (!deleteCarerTarget) return;
    setLoading(true);

    try {
      await deleteCarer(deleteCarerTarget);
      await loadCarerList();
      setSelectedCarer(null);
      setDeleteCarerTarget(null);
      setMessage('Carer deleted.');
    } catch (err: any) {
      setMessage(err.message || 'Delete failed.');
    } finally {
      setLoading(false);
    }
  }

  async function handleDeletePlayer() {
    if (!deletePlayerTarget) return;
    setLoading(true);

    try {
      await deletePlayer(deletePlayerTarget);
      await loadPlayerList();
      setSelectedPlayer(null);
      setDeletePlayerTarget(null);
      setMessage('Player deleted.');
    } catch (err: any) {
      setMessage(err.message || 'Delete failed.');
    } finally {
      setLoading(false);
    }
  }

  async function handleCompleteCashout(request: CarerCashoutRequest) {
    setLoading(true);
    setMessage('');
    const previousPendingCashouts = pendingCashouts;
    const settledIdsForCarer = pendingCashouts
      .filter((item) => item.carerUid === request.carerUid)
      .map((item) => item.id);

    settledIdsForCarer.forEach((id) => suppressedCashoutIdsRef.current.add(id));

    // Remove this carer's request box immediately from UI on Done.
    setPendingCashouts((current) =>
      current.filter((item) => item.carerUid !== request.carerUid)
    );

    try {
      await completeCarerCashoutRequest(request.id);
      setMessage(`Cashout settled for ${request.carerUsername}. Cash box reset.`);
    } catch (err: any) {
      settledIdsForCarer.forEach((id) => suppressedCashoutIdsRef.current.delete(id));
      // Restore UI list if request failed.
      setPendingCashouts(previousPendingCashouts);
      setMessage(err.message || 'Failed to settle cashout request.');
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

  async function handleCreateBonusEvent(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    setMessage('');

    try {
      await createBonusEvent({
        bonusName,
        gameName: bonusGameName,
        amountNpr: Number(bonusAmount),
        description: bonusDescription,
        bonusPercentage: Number(bonusPercentage),
      });
      setBonusName('');
      setBonusGameName('');
      setBonusAmount('');
      setBonusDescription('');
      setBonusPercentage('');
      setMessage('Bonus event created successfully.');
    } catch (error: any) {
      setMessage(error.message || 'Failed to create bonus event.');
    } finally {
      setLoading(false);
    }
  }

  async function handleToggleStaffStatus(user: StaffUser) {
    setBlocking(true);
    setMessage('');

    try {
      if (user.status === 'disabled') {
        await unblockStaff(user);
      } else {
        await blockStaff(user);
      }

      await loadStaffList();
      setMessage(`Staff ${user.status === 'disabled' ? 'unblocked' : 'blocked'} successfully.`);
    } catch (err: any) {
      setMessage(err.message || 'Failed to update staff status.');
    } finally {
      setBlocking(false);
    }
  }

  async function handleToggleCarerStatus(user: CarerUser) {
    setBlocking(true);
    setMessage('');

    try {
      if (user.status === 'disabled') {
        await unblockCarer(user);
      } else {
        await blockCarer(user);
      }

      await loadCarerList();
      setMessage(`Carer ${user.status === 'disabled' ? 'unblocked' : 'blocked'} successfully.`);
    } catch (err: any) {
      setMessage(err.message || 'Failed to update carer status.');
    } finally {
      setBlocking(false);
    }
  }

  async function handleImageSelect(file: File) {
    try {
      const compressed = await imageCompression(file, {
        maxSizeMB: 0.7,
        maxWidthOrHeight: 1000,
        useWebWorker: true,
      });

      setSelectedImage(compressed);
      setImagePreview(URL.createObjectURL(compressed));
    } catch (err) {
      console.error(err);
      setMessage('Failed to process image.');
    }
  }

  function handleClearImage() {
    setSelectedImage(null);

    if (imagePreview) {
      URL.revokeObjectURL(imagePreview);
    }

    setImagePreview(null);
  }

  async function handleSendMessage(e: React.FormEvent) {
    e.preventDefault();

    if (!activeChatUser) return;

    try {
      if (selectedImage) {
        setSendingImage(true);
        await sendImageMessage(activeChatUser.uid, selectedImage);
        handleClearImage();
      }

      if (newMessage.trim()) {
        await sendChatMessage(activeChatUser.uid, newMessage);
        setNewMessage('');
      }
    } catch (err: any) {
      setMessage(err.message || 'Failed to send message.');
    } finally {
      setSendingImage(false);
    }
  }

  function handleStaffStartChat(user: StaffUser) {
    if (staffChatUser?.uid === user.uid) {
      setStaffChatUser(null);
      setMessages([]);
      setNewMessage('');
      handleClearImage();
      return;
    }

    setStaffChatUser(user);
    setReachOutChatUser(null);
    setMessages([]);
    setNewMessage('');
    handleClearImage();
    markConversationAsRead(user.uid);
  }

  function handleReachOutUserSelect(user: AdminUser) {
    setReachOutChatUser(user);
    setStaffChatUser(null);
    setMessages([]);
    setNewMessage('');
    handleClearImage();
    markConversationAsRead(user.uid);
  }

  async function handleOpenFirstUnreadStaffChat() {
    let staffUsers = staffList;

    if (staffUsers.length === 0) {
      staffUsers = await getUsersForCurrentCoadmin(getStaff);
      setStaffList(staffUsers);
    }

    const unreadStaff =
      staffUsers.find((staff) => (unreadCounts[staff.uid] || 0) > 0) || null;

    setActiveView('view-staff');

    if (unreadStaff) {
      setSelectedStaff(unreadStaff);
      setStaffChatUser(unreadStaff);
      setReachOutChatUser(null);
      setMessages([]);
      setNewMessage('');
      handleClearImage();
      markConversationAsRead(unreadStaff.uid);
    }
  }

  async function handleOpenFirstUnreadReachOutChat() {
    let users = chatUsers;

    if (users.length === 0) {
      await loadChatUsers();
      users = chatUsers;
    }

    const unreadUser =
      users.find((user) => (unreadCounts[user.uid] || 0) > 0) || null;

    setActiveView('reach-out');

    if (unreadUser) {
      setReachOutChatUser(unreadUser);
      setStaffChatUser(null);
      setMessages([]);
      setNewMessage('');
      handleClearImage();
      markConversationAsRead(unreadUser.uid);
    }
  }

  async function handleOpenAnyUnreadChat() {
    if (staffUnreadCount > 0) {
      await handleOpenFirstUnreadStaffChat();
      return;
    }

    if (reachOutUnreadCount > 0) {
      await handleOpenFirstUnreadReachOutChat();
    }
  }

  function resetSelection() {
    setMessage('');
    setSelectedStaff(null);
    setSelectedCarer(null);
    setSelectedPlayer(null);
    setDeleteStaffTarget(null);
    setDeleteCarerTarget(null);
    setDeletePlayerTarget(null);
    setStaffChatUser(null);
    setReachOutChatUser(null);
    setEditingGame(null);
    setMessages([]);
    setNewMessage('');
    handleClearImage();
  }

  function handleChangeView(view: CoadminView) {
    setActiveView(view);
    resetSelection();
  }

  function sortByNewest<T extends { createdAt?: any }>(list: T[]) {
    return [...list].sort((a: any, b: any) => {
      const aTime =
        a.createdAt?.toDate?.()?.getTime?.() ||
        a.createdAt?.getTime?.() ||
        0;

      const bTime =
        b.createdAt?.toDate?.()?.getTime?.() ||
        b.createdAt?.getTime?.() ||
        0;

      return bTime - aTime;
    });
  }

  const sortedStaff = sortByNewest(staffList);
  const sortedCarers = sortByNewest(carerList);
  const sortedPlayers = sortByNewest(playerList);

  return (
    <ProtectedRoute allowedRoles={['coadmin']}>
      <main className="flex min-h-screen bg-neutral-950 text-white">
        <aside className="w-72 border-r border-white/10 bg-neutral-900/60 p-4">
          <h1 className="mb-6 text-2xl font-bold">Co-admin Panel</h1>

          <nav className="space-y-2">
            {[
              { label: 'Dashboard', view: 'dashboard' },
              { label: 'View Tasks', view: 'view-tasks' },
              { label: 'Create Bonus Event', view: 'create-bonus-event' },
              { label: 'View Bonus Events', view: 'view-bonus-events' },
              { label: 'Add Staff', view: 'add-staff' },
              { label: 'View Staff', view: 'view-staff', unread: staffUnreadCount },
              { label: 'Create Carer', view: 'create-carer' },
              { label: 'View Carers', view: 'view-carers' },
              { label: 'Create Player', view: 'create-player' },
              { label: 'View Players', view: 'view-players' },
              { label: 'Add Games', view: 'add-games' },
              { label: 'Game List', view: 'game-list' },
              { label: 'Reach Out', view: 'reach-out', unread: reachOutUnreadCount },
            ].map((item) => (
              <button
                key={item.view}
                onClick={() => {
                  if (
                    item.view === 'view-staff' &&
                    item.unread !== undefined &&
                    item.unread > 0
                  ) {
                    handleOpenFirstUnreadStaffChat();
                    return;
                  }

                  if (
                    item.view === 'reach-out' &&
                    item.unread !== undefined &&
                    item.unread > 0
                  ) {
                    handleOpenFirstUnreadReachOutChat();
                    return;
                  }

                  handleChangeView(item.view as CoadminView);
                }}
                className={`flex w-full items-center justify-between rounded-2xl px-4 py-3 text-left text-sm ${
                  activeView === item.view
                    ? 'bg-white text-black'
                    : 'bg-white/5 text-neutral-300 hover:bg-white/10'
                }`}
              >
                <span>{item.label}</span>

                {item.unread !== undefined && item.unread > 0 && (
                  <span className="rounded-full bg-red-500 px-2 py-0.5 text-xs font-bold text-white">
                    {item.unread > 9 ? '9+' : item.unread}
                  </span>
                )}
              </button>
            ))}
          </nav>
        </aside>

        <section className="flex-1 p-6 overflow-y-auto">
          {message && (
            <div className="mb-4 rounded-2xl bg-white/10 p-3 text-sm text-neutral-300">
              {message}
            </div>
          )}

          {activeView === 'dashboard' && (
            <div>
              <DashboardView
                coadminCount={0}
                staffCount={staffList.length}
                unreadCount={totalUnread}
              />

              <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-3">
                <div className="rounded-2xl border border-white/10 bg-white/5 p-6">
                  <p className="text-sm text-neutral-400">Total Carers</p>
                  <p className="mt-2 text-3xl font-bold">{carerList.length}</p>
                </div>

                <div className="rounded-2xl border border-white/10 bg-white/5 p-6">
                  <p className="text-sm text-neutral-400">Total Players</p>
                  <p className="mt-2 text-3xl font-bold">{playerList.length}</p>
                </div>

                <div className="rounded-2xl border border-white/10 bg-white/5 p-6">
                  <p className="text-sm text-neutral-400">Total Games</p>
                  <p className="mt-2 text-3xl font-bold">{gameLogins.length}</p>
                </div>
              </div>

              {pendingCashouts.length > 0 && (
                <div className="mt-4 rounded-2xl border border-emerald-500/30 bg-emerald-500/10 p-5">
                  <h3 className="text-lg font-bold text-emerald-200">
                    Carer Cashout Requests ({pendingCashouts.length})
                  </h3>

                  <div className="mt-3 space-y-3">
                    {pendingCashouts.map((request) => (
                      <div
                        key={request.id}
                        className="rounded-xl border border-white/10 bg-black/30 p-4"
                      >
                        <div className="flex flex-wrap items-start justify-between gap-4">
                          <div>
                            <p className="text-sm font-semibold text-white">
                              {request.carerUsername}
                            </p>
                            <p className="text-sm text-neutral-300">
                              Amount: NPR {Math.round(request.amountNpr || 0).toLocaleString()}
                            </p>
                            {request.paymentDetails && (
                              <p className="mt-1 text-xs text-neutral-400">
                                {request.paymentDetails}
                              </p>
                            )}
                            {request.paymentQrUrl && (
                              <a
                                href={request.paymentQrUrl}
                                target="_blank"
                                rel="noreferrer"
                                className="mt-2 inline-block text-xs font-semibold text-cyan-300 hover:text-cyan-200"
                              >
                                Open Payment QR
                              </a>
                            )}
                          </div>

                          <button
                            type="button"
                            disabled={loading}
                            onClick={() => void handleCompleteCashout(request)}
                            className="rounded-lg bg-white px-4 py-2 text-sm font-semibold text-black hover:bg-neutral-200 disabled:opacity-60"
                          >
                            Done
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {visibleRecentCarerEscalations.length > 0 && (
                <div className="mt-4 rounded-2xl border border-red-500/30 bg-red-500/10 p-5">
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
                <div className="mt-4 rounded-2xl border border-cyan-500/30 bg-cyan-500/10 p-5">
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
                                Amount: NPR {Math.round(task.amountNpr || 0).toLocaleString()}
                              </p>
                              <p className="mt-1 text-xs text-cyan-100/70">
                                Payment details: {task.paymentDetails || 'Not provided'}
                              </p>
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

              {totalUnread > 0 && (
                <button
                  onClick={handleOpenAnyUnreadChat}
                  className="mt-4 rounded-2xl bg-red-500 px-4 py-3 text-sm font-bold text-white hover:bg-red-600"
                >
                  Open unread chat
                </button>
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
                        Amount: NPR {Math.round(task.amountNpr || 0).toLocaleString()}
                      </p>
                      <p className="mt-1 text-xs text-cyan-100/70">
                        Payment details: {task.paymentDetails || 'Not provided'}
                      </p>
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

          {activeView === 'create-bonus-event' && (
            <form
              onSubmit={handleCreateBonusEvent}
              className="max-w-2xl rounded-2xl border border-white/10 bg-white/5 p-6"
            >
              <h2 className="text-3xl font-bold">Create Bonus Event</h2>
              <div className="mt-5 space-y-4">
                <label className="block text-sm">
                  Bonus Name
                  <input
                    value={bonusName}
                    onChange={(event) => setBonusName(event.target.value)}
                    className="mt-2 w-full rounded-xl border border-white/15 bg-black/30 px-4 py-3 text-white outline-none focus:border-white/40"
                    placeholder="Bonus name"
                  />
                </label>
                <label className="block text-sm">
                  Game Name
                  <select
                    value={bonusGameName}
                    onChange={(event) => setBonusGameName(event.target.value)}
                    className="mt-2 w-full rounded-xl border border-white/15 bg-black/30 px-4 py-3 text-white outline-none focus:border-white/40"
                  >
                    <option value="">Select game</option>
                    {gameLogins.map((game) => (
                      <option key={game.id} value={game.gameName}>
                        {game.gameName}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block text-sm">
                  Amount
                  <input
                    type="number"
                    min={1}
                    value={bonusAmount}
                    onChange={(event) => setBonusAmount(event.target.value)}
                    className="mt-2 w-full rounded-xl border border-white/15 bg-black/30 px-4 py-3 text-white outline-none focus:border-white/40"
                    placeholder="e.g. 1000"
                  />
                </label>
                <label className="block text-sm">
                  Description
                  <textarea
                    value={bonusDescription}
                    onChange={(event) => setBonusDescription(event.target.value)}
                    className="mt-2 min-h-24 w-full rounded-xl border border-white/15 bg-black/30 px-4 py-3 text-white outline-none focus:border-white/40"
                    placeholder="Describe this bonus"
                  />
                </label>
                <label className="block text-sm">
                  Bonus Percentage
                  <input
                    type="number"
                    min={1}
                    value={bonusPercentage}
                    onChange={(event) => setBonusPercentage(event.target.value)}
                    className="mt-2 w-full rounded-xl border border-white/15 bg-black/30 px-4 py-3 text-white outline-none focus:border-white/40"
                    placeholder="e.g. 10"
                  />
                </label>
                <button
                  type="submit"
                  disabled={loading}
                  className="rounded-xl bg-white px-5 py-3 text-sm font-semibold text-black hover:bg-neutral-200 disabled:opacity-60"
                >
                  {loading ? 'Creating...' : 'Create Bonus Event'}
                </button>
              </div>
            </form>
          )}

          {activeView === 'view-bonus-events' && (
            <div>
              <h2 className="mb-6 text-3xl font-bold">View Bonus Events</h2>
              {myBonusEvents.length === 0 ? (
                <p className="text-sm text-neutral-400">No bonus events created yet.</p>
              ) : (
                <div className="space-y-3">
                  {myBonusEvents.map((event) => (
                    <div
                      key={event.id}
                      className="rounded-xl border border-violet-400/25 bg-violet-500/10 p-4"
                    >
                      <p className="text-base font-semibold text-white">{event.bonusName}</p>
                      <p className="mt-1 text-sm text-violet-100/85">
                        Game: {event.gameName} | Amount: NPR{' '}
                        {Math.round(event.amountNpr || 0).toLocaleString()}
                      </p>
                      <p className="mt-1 text-sm text-violet-100/85">{event.description}</p>
                      <p className="mt-1 text-xs text-violet-100/70">
                        Bonus: {event.bonusPercentage}% | Created:{' '}
                        {event.createdAt?.toDate?.().toLocaleString?.() || 'Now'}
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {activeView === 'add-staff' && (
            <CreateUserForm
              title="Add Staff"
              buttonLabel="Create Staff"
              loadingLabel="Creating..."
              username={staffUsername}
              password={staffPassword}
              loading={loading}
              onUsernameChange={setStaffUsername}
              onPasswordChange={setStaffPassword}
              onSubmit={handleCreateStaff}
            />
          )}

          {activeView === 'view-staff' && (
            <UserManagementView<StaffUser>
              title="Staff"
              emptyText="No staff found."
              selectText="Select a staff member to manage."
              deleteTitle="Delete staff?"
              deleteMessage="Are you sure you want to delete"
              users={sortedStaff}
              selectedUser={selectedStaff}
              deleteTarget={deleteStaffTarget}
              loadingList={loadingList}
              loading={loading}
              unreadCounts={unreadCounts}
              imagePreview={imagePreview}
              sendingImage={sendingImage}
              onSelectUser={setSelectedStaff}
              onSetDeleteTarget={setDeleteStaffTarget}
              onDelete={handleDeleteStaff}
              onToggleBlock={handleToggleStaffStatus}
              blocking={blocking}
              onStartChat={handleStaffStartChat}
              chatUser={staffChatUser}
              messages={messages}
              newMessage={newMessage}
              onMessageChange={setNewMessage}
              onSendMessage={handleSendMessage}
              onImageSelect={handleImageSelect}
              onClearImage={handleClearImage}
            />
          )}

          {activeView === 'create-carer' && (
            <CreateUserForm
              title="Create Carer"
              buttonLabel="Create Carer"
              loadingLabel="Creating..."
              username={carerUsername}
              password={carerPassword}
              loading={loading}
              onUsernameChange={setCarerUsername}
              onPasswordChange={setCarerPassword}
              onSubmit={handleCreateCarer}
            />
          )}

          {activeView === 'view-carers' && (
            <UserManagementView<CarerUser>
              title="Carers"
              emptyText="No carers found."
              selectText="Select a carer to manage."
              deleteTitle="Delete carer?"
              deleteMessage="Are you sure you want to delete"
              users={sortedCarers}
              selectedUser={selectedCarer}
              deleteTarget={deleteCarerTarget}
              loadingList={loadingList}
              loading={loading}
              carersVisualTheme
              onSelectUser={setSelectedCarer}
              onSetDeleteTarget={setDeleteCarerTarget}
              onDelete={handleDeleteCarer}
              onToggleBlock={handleToggleCarerStatus}
              blocking={blocking}
              renderSelectedExtras={(carer) => {
                const rechargeTotal = Math.round(
                  carerRechargeRedeemTotals[carer.uid]?.totalRechargeAmount || 0
                );
                const redeemTotal = Math.round(
                  carerRechargeRedeemTotals[carer.uid]?.totalRedeemAmount || 0
                );
                const redeemShare =
                  rechargeTotal > 0 ? redeemTotal / rechargeTotal : redeemTotal > 0 ? Infinity : 0;
                const showRedeemWarning =
                  redeemTotal > 0 && (rechargeTotal <= 0 || redeemShare > 0.5);

                return (
                  <div className="mt-5 space-y-4">
                    <div className="rounded-2xl border border-amber-500/30 bg-amber-950/25 p-5 shadow-[0_0_32px_-10px_rgba(234,179,8,0.2)]">
                      <h4 className="text-sm font-black uppercase tracking-wide text-amber-200/90">
                        Work details
                      </h4>
                      <p className="mt-1 text-xs text-amber-100/55">
                        Completed recharge & redeem totals (all time, from finished tasks).
                      </p>
                      <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
                        <div className="rounded-xl border border-emerald-500/25 bg-emerald-950/35 p-4">
                          <p className="text-xs font-bold uppercase tracking-wide text-emerald-200/80">
                            Total recharged
                          </p>
                          <p className="mt-2 text-xl font-black text-emerald-100 sm:text-2xl">
                            {formatNprDisplay(rechargeTotal)}
                          </p>
                        </div>
                        <div className="rounded-xl border border-rose-500/25 bg-rose-950/35 p-4">
                          <p className="text-xs font-bold uppercase tracking-wide text-rose-200/80">
                            Total redeemed
                          </p>
                          <p className="mt-2 text-xl font-black text-rose-100 sm:text-2xl">
                            {formatNprDisplay(redeemTotal)}
                          </p>
                        </div>
                      </div>
                      {rechargeTotal > 0 && redeemTotal > 0 ? (
                        <p className="mt-3 text-xs text-amber-100/60">
                          Redeem vs recharge (amount):{' '}
                          <span className="font-semibold text-amber-200">
                            {Math.round((redeemTotal / rechargeTotal) * 100)}%
                          </span>{' '}
                          of recharge.
                        </p>
                      ) : null}
                      {showRedeemWarning ? (
                        <div
                          role="alert"
                          className="mt-4 rounded-xl border border-rose-500/45 bg-rose-950/50 p-4 text-sm leading-relaxed text-rose-50"
                        >
                          <p className="font-bold text-rose-200">⚠️ Redeem pattern notice</p>
                          <p className="mt-2">
                            This carer&apos;s redeem volume is high versus recharge. Their account
                            may be reviewed for legitimate redeems.
                          </p>
                        </div>
                      ) : null}
                    </div>

                    <div className="rounded-2xl border border-violet-500/30 bg-violet-950/25 p-5">
                      <p className="text-xs font-black uppercase tracking-wide text-violet-200/90">
                        Payment details
                      </p>
                      {carer.paymentDetails ? (
                        <p className="mt-2 text-sm text-violet-50/95">{carer.paymentDetails}</p>
                      ) : (
                        <p className="mt-2 text-sm text-violet-200/60">
                          No payment details added yet.
                        </p>
                      )}
                      {carer.paymentQrUrl ? (
                        <a
                          href={carer.paymentQrUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="mt-3 inline-flex items-center gap-2 text-sm font-bold text-violet-200 hover:text-violet-100"
                        >
                          🔗 Open QR link
                        </a>
                      ) : null}
                    </div>
                  </div>
                );
              }}
            />
          )}

          {activeView === 'create-player' && (
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

          {activeView === 'view-players' && (
            <UserManagementView<PlayerUser>
              title="Players"
              emptyText="No players found."
              selectText="Select a player to manage."
              deleteTitle="Delete player?"
              deleteMessage="Are you sure you want to delete"
              users={sortedPlayers}
              selectedUser={selectedPlayer}
              deleteTarget={deletePlayerTarget}
              loadingList={loadingList}
              loading={loading}
              onSelectUser={setSelectedPlayer}
              onSetDeleteTarget={setDeletePlayerTarget}
              onDelete={handleDeletePlayer}
            />
          )}

          {activeView === 'add-games' && (
            <div className="max-w-md">
              <h2 className="mb-6 text-3xl font-bold">Add Game</h2>

              <form
                onSubmit={handleCreateGame}
                className="space-y-4 rounded-2xl border border-white/10 bg-white/5 p-6"
              >
                <input
                  value={gameName}
                  onChange={(e) => setGameName(e.target.value)}
                  placeholder="Game Name"
                  className="w-full rounded-xl border border-white/10 bg-neutral-900 p-3 outline-none focus:border-white/30"
                  required
                />

                <input
                  value={gameUsername}
                  onChange={(e) => setGameUsername(e.target.value)}
                  placeholder="Username"
                  className="w-full rounded-xl border border-white/10 bg-neutral-900 p-3 outline-none focus:border-white/30"
                  required
                />

                <input
                  value={gamePassword}
                  onChange={(e) => setGamePassword(e.target.value)}
                  placeholder="Password"
                  className="w-full rounded-xl border border-white/10 bg-neutral-900 p-3 outline-none focus:border-white/30"
                  required
                />

                <button
                  disabled={loading}
                  className="w-full rounded-xl bg-white p-3 font-semibold text-black disabled:opacity-60"
                >
                  {loading ? 'Adding...' : 'Add Game'}
                </button>
              </form>
            </div>
          )}

          {activeView === 'game-list' && (
            <div>
              <h2 className="mb-6 text-3xl font-bold">Game List</h2>

              {loadingList ? (
                <p className="text-sm text-neutral-400">Loading...</p>
              ) : gameLogins.length === 0 ? (
                <p className="text-sm text-neutral-400">No games found.</p>
              ) : (
                <div className="space-y-4">
                  {gameLogins.map((game) => (
                    <div
                      key={game.id}
                      className="rounded-2xl border border-white/10 bg-white/5 p-5"
                    >
                      {editingGame?.id === game.id ? (
                        <form onSubmit={handleUpdateGame} className="space-y-3">
                          <input
                            value={editingGame.gameName}
                            onChange={(e) =>
                              setEditingGame({
                                ...editingGame,
                                gameName: e.target.value,
                              })
                            }
                            className="w-full rounded-xl border border-white/10 bg-neutral-900 p-3 outline-none focus:border-white/30"
                          />

                          <input
                            value={editingGame.username}
                            onChange={(e) =>
                              setEditingGame({
                                ...editingGame,
                                username: e.target.value,
                              })
                            }
                            className="w-full rounded-xl border border-white/10 bg-neutral-900 p-3 outline-none focus:border-white/30"
                          />

                          <input
                            value={editingGame.password}
                            onChange={(e) =>
                              setEditingGame({
                                ...editingGame,
                                password: e.target.value,
                              })
                            }
                            className="w-full rounded-xl border border-white/10 bg-neutral-900 p-3 outline-none focus:border-white/30"
                          />

                          <div className="flex gap-3">
                            <button
                              disabled={loading}
                              className="rounded-xl bg-white px-4 py-2 font-semibold text-black disabled:opacity-60"
                            >
                              {loading ? 'Saving...' : 'Save'}
                            </button>

                            <button
                              type="button"
                              onClick={() => setEditingGame(null)}
                              className="rounded-xl bg-white/10 px-4 py-2 font-semibold text-white hover:bg-white/20"
                            >
                              Cancel
                            </button>
                          </div>
                        </form>
                      ) : (
                        <div className="flex items-start justify-between gap-4">
                          <div>
                            <h3 className="text-xl font-bold">{game.gameName}</h3>
                            <p className="mt-2 text-sm text-neutral-400">
                              Username:{' '}
                              <span className="text-white">{game.username}</span>
                            </p>
                            <p className="mt-1 text-sm text-neutral-400">
                              Password:{' '}
                              <span className="text-white">{game.password}</span>
                            </p>
                          </div>

                          <button
                            onClick={() => setEditingGame(game)}
                            className="rounded-xl bg-white px-4 py-2 text-sm font-semibold text-black hover:bg-neutral-200"
                          >
                            Edit
                          </button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {activeView === 'reach-out' && (
            <ReachOutView
              chatUsers={chatUsers}
              selectedChatUser={reachOutChatUser}
              messages={messages}
              newMessage={newMessage}
              unreadCounts={unreadCounts}
              imagePreview={imagePreview}
              sendingImage={sendingImage}
              onSelectUser={handleReachOutUserSelect}
              onMessageChange={setNewMessage}
              onSendMessage={handleSendMessage}
              onImageSelect={handleImageSelect}
              onClearImage={handleClearImage}
            />
          )}
        </section>
      </main>

      {showUrgentSplash && urgentRequestCount > 0 && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-red-950/85 px-4 backdrop-blur-sm">
          <div className="w-full max-w-2xl rounded-3xl border border-red-300/30 bg-gradient-to-br from-red-950 via-red-900 to-black p-8 text-white shadow-2xl">
            <p className="text-xs font-bold uppercase tracking-[0.3em] text-red-200">
              Urgent Player Alert
            </p>
            <h2 className="mt-3 text-3xl font-bold">
              Help Me request received from player side.
            </h2>
            <p className="mt-3 text-sm text-red-100/80">
              {urgentRequestCount} urgent player request
              {urgentRequestCount === 1 ? '' : 's'} need attention right now.
            </p>

            <div className="mt-6 flex flex-wrap gap-3">
              <button
                onClick={() => {
                  setActiveView('view-players');
                  setShowUrgentSplash(false);
                }}
                className="rounded-2xl bg-white px-5 py-3 text-sm font-bold text-black hover:bg-neutral-200"
              >
                Open Players
              </button>
              <button
                onClick={() => setShowUrgentSplash(false)}
                className="rounded-2xl bg-white/10 px-5 py-3 text-sm font-bold text-white hover:bg-white/20"
              >
                Dismiss
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
                Player: {latestCarerEscalation.playerUsername} / {latestCarerEscalation.gameName}
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
