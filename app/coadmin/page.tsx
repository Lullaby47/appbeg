'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { collection, doc, getDoc, getDocs, query, where } from 'firebase/firestore';
import imageCompression from 'browser-image-compression';

import ProtectedRoute from '../../components/auth/ProtectedRoute';
import LogoutButton from '../../components/auth/LogoutButton';
import DashboardView from '../../components/admin/DashboardView';
import CreateUserForm from '../../components/admin/CreateUserForm';
import UserManagementView from '../../components/admin/UserManagementView';
import ReachOutView from '../../components/admin/ReachOutView';
import RoleSidebarLayout, { type NavigationItem } from '@/components/navigation/RoleSidebarLayout';

import { auth, db } from '@/lib/firebase/client';
import {
  belongsToCoadmin,
  getCurrentUserCoadminUid,
} from '@/lib/coadmin/scope';

import {
  CarerCreationRequest,
  StaffUser,
  CarerUser,
  PlayerUser,
  blockCarer,
  blockPlayer,
  blockStaff,
  createStaff,
  createPlayer,
  deleteStaff,
  deleteCarer,
  deletePlayer,
  getStaff,
  getCarers,
  getPlayers,
  requestCarerCreation,
  resetCoadminWorkerCredentials,
  unblockCarer,
  unblockPlayer,
  unblockStaff,
} from '@/features/users/adminUsers';
import { adjustPlayerCoin } from '@/features/users/coadminPlayerCoin';

import {
  GameLogin,
  createGameLogin,
  getMyGameLogins,
  updateGameLogin,
} from '@/features/games/gameLogins';
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
  getPlayerCashoutPaymentDisplay,
  listenPlayerCashoutTasksByCoadmin,
  PlayerCashoutTask,
  startPlayerCashoutTask,
} from '@/features/cashouts/playerCashoutTasks';
import {
  BonusEvent,
  COADMIN_AUTO_BONUS_PERCENT_MAX,
  COADMIN_AUTO_BONUS_PERCENT_MIN,
  createBonusEvent,
  getCoadminAutoBonusPercentRange,
  MAX_ACTIVE_BONUS_EVENTS,
  listenBonusEventsByCoadmin,
  setCoadminAutoBonusPercentRange,
} from '../../features/bonusEvents/bonusEvents';
import {
  approveTransferRequest,
  listenPendingTransferRequestsByCoadminOrGlobal,
  rejectTransferRequest,
  TransferRequest,
} from '@/features/risk/playerRisk';

import {
  listenToUnreadCounts,
  markConversationAsRead,
  sendChatMessage,
  sendImageMessage,
} from '@/features/messages/chatMessages';
import { usePaginatedChatMessages } from '@/features/messages/usePaginatedChatMessages';

import { AdminUser, ChatMessage } from '../../components/admin/types';
import {
  getCoadminPaymentDetailPhotos,
  setCoadminPaymentDetailPhotos,
  type PaymentDetailPhoto,
  uploadCoadminPaymentDetailPhoto,
} from '@/features/coinLoad/coinLoadSession';
import ImageUploadField from '@/components/common/ImageUploadField';
import {
  cutWorkerReward,
  listenShiftSessionsByCoadmin,
  type ShiftSession,
} from '@/features/shifts/userShifts';
import { usePresenceOnlineMap } from '@/features/presence/userPresence';

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
  | 'payment-details'
  | 'shifts'
  | 'reach-out';

function formatNprDisplay(value: number) {
  return `NPR ${Math.round(value).toLocaleString()}`;
}

function formatDateTime(value?: { toDate?: () => Date } | null) {
  const date = value?.toDate?.();
  if (!date) {
    return '—';
  }
  return date.toLocaleString();
}

function formatHours(value: number) {
  return `${value.toFixed(2)} h`;
}

function toMillis(value?: { toDate?: () => Date; toMillis?: () => number } | null) {
  if (!value) {
    return 0;
  }
  if (typeof value.toMillis === 'function') {
    return value.toMillis();
  }
  if (typeof value.toDate === 'function') {
    return value.toDate().getTime();
  }
  return 0;
}

function randomInt(min: number, max: number) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function isQuotaExceededMessage(value: unknown) {
  const lower = String(value || '').toLowerCase();
  return (
    lower.includes('resource_exhausted') ||
    lower.includes('quota exceeded') ||
    (lower.includes('quota') && lower.includes('exceeded'))
  );
}

function calculateWorkedHoursLast24hWithHeartbeat(
  sessions: ShiftSession[],
  nowMs: number,
  heartbeatGraceMs: number
) {
  const windowStart = nowMs - 24 * 60 * 60 * 1000;
  let totalMs = 0;

  for (const session of sessions) {
    const loginMs = toMillis(session.loginAt || null);
    if (!loginMs) {
      continue;
    }

    const logoutMs = toMillis(session.logoutAt || null);
    const lastSeenMs = toMillis(session.lastSeenAt || null);
    const inferredAutoLogoutMs =
      session.isActive && lastSeenMs > 0 && nowMs - lastSeenMs > heartbeatGraceMs
        ? lastSeenMs
        : 0;
    const endMs = logoutMs || inferredAutoLogoutMs || nowMs;

    const start = Math.max(loginMs, windowStart);
    const end = Math.min(endMs, nowMs);
    if (end > start) {
      totalMs += end - start;
    }
  }

  return totalMs / (1000 * 60 * 60);
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
  const [pendingCarerRequests, setPendingCarerRequests] = useState<CarerCreationRequest[]>([]);
  const [carerList, setCarerList] = useState<CarerUser[]>([]);
  const [selectedCarer, setSelectedCarer] = useState<CarerUser | null>(null);
  const [deleteCarerTarget, setDeleteCarerTarget] = useState<CarerUser | null>(null);

  const [playerUsername, setPlayerUsername] = useState('');
  const [playerPassword, setPlayerPassword] = useState('');
  const [playerReferralCodeInput, setPlayerReferralCodeInput] = useState('');
  const [playerList, setPlayerList] = useState<PlayerUser[]>([]);
  const [selectedPlayer, setSelectedPlayer] = useState<PlayerUser | null>(null);
  const [deletePlayerTarget, setDeletePlayerTarget] = useState<PlayerUser | null>(null);
  const [playerCoinAmountInput, setPlayerCoinAmountInput] = useState('');
  const [playerCoinAdjustBusy, setPlayerCoinAdjustBusy] = useState(false);

  const [gameName, setGameName] = useState('');
  const [gameUsername, setGameUsername] = useState('');
  const [gamePassword, setGamePassword] = useState('');
  const [gameSiteUrl, setGameSiteUrl] = useState('');
  const [gameLogins, setGameLogins] = useState<GameLogin[]>([]);
  const [editingGame, setEditingGame] = useState<GameLogin | null>(null);
  const [bonusName, setBonusName] = useState('');
  const [bonusGameName, setBonusGameName] = useState('');
  const [bonusAmount, setBonusAmount] = useState('');
  const [bonusDescription, setBonusDescription] = useState('');
  const [bonusPercentage, setBonusPercentage] = useState('');
  const [bonusEvents, setBonusEvents] = useState<BonusEvent[]>([]);
  const [autoBonusMinPercentInput, setAutoBonusMinPercentInput] = useState('5');
  const [autoBonusMaxPercentInput, setAutoBonusMaxPercentInput] = useState('10');
  const [autoBonusRangeBusy, setAutoBonusRangeBusy] = useState(false);

  const [chatUsers, setChatUsers] = useState<AdminUser[]>([]);
  const [reachOutChatUser, setReachOutChatUser] = useState<AdminUser | null>(null);
  const [staffChatUser, setStaffChatUser] = useState<StaffUser | null>(null);

  const [newMessage, setNewMessage] = useState('');
  const coadminChatScrollRef = useRef<HTMLDivElement>(null);
  const [unreadCounts, setUnreadCounts] = useState<Record<string, number>>({});

  const [selectedImage, setSelectedImage] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [sendingImage, setSendingImage] = useState(false);

  const [paymentDetailPhotos, setPaymentDetailPhotos] = useState<PaymentDetailPhoto[]>([]);
  const [loadingPaymentDetailPhotos, setLoadingPaymentDetailPhotos] = useState(false);
  const [paymentDetailUploading, setPaymentDetailUploading] = useState(false);
  const [shiftSessions, setShiftSessions] = useState<ShiftSession[]>([]);
  const [rewardCutAmountByUid, setRewardCutAmountByUid] = useState<Record<string, string>>({});
  const [rewardCutReasonByUid, setRewardCutReasonByUid] = useState<Record<string, string>>({});
  const [rewardCutBusyUid, setRewardCutBusyUid] = useState<string | null>(null);

  const previousUnreadRef = useRef(0);
  const latestCarerEscalationIdRef = useRef<string | null>(null);
  const hasSeenCarerEscalationSnapshotRef = useRef(false);
  const suppressedCashoutIdsRef = useRef<Set<string>>(new Set());

  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const [workerCredentialsLoading, setWorkerCredentialsLoading] = useState(false);
  const [blocking, setBlocking] = useState(false);
  const [loadingList, setLoadingList] = useState(false);
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
  const [pendingTransferRequests, setPendingTransferRequests] = useState<TransferRequest[]>([]);
  const [transferRequestBusyId, setTransferRequestBusyId] = useState<string | null>(null);
  const bonusAutoFillBusyRef = useRef(false);
  const bonusEventsRetryTimerRef = useRef<number | null>(null);
  const bonusEventsRetryCountRef = useRef(0);
  const bonusEventsLastEnsureAttemptedCountRef = useRef<number | null>(null);
  const bonusEventsEnsureCooldownUntilMsRef = useRef(0);
  const bonusEventsLastEnsureAttemptAtMsRef = useRef(0);
  const bonusEventsLatestActiveCountRef = useRef(0);
  const bonusEventsLastMissingCountRef = useRef<number | null>(null);
  const BONUS_ENSURE_CLIENT_COOLDOWN_MS = 45_000;

  const activeChatUser =
    activeView === 'reach-out' ? reachOutChatUser : staffChatUser;
  const isBonusEventsView =
    activeView === 'view-bonus-events' || activeView === 'create-bonus-event';

  const pagedCoadminChat = usePaginatedChatMessages(activeChatUser?.uid ?? null, {
    scrollContainerRef: coadminChatScrollRef,
    onWindowMessages: () => {
      if (activeChatUser) {
        markConversationAsRead(activeChatUser.uid);
      }
    },
  });

  const messages: ChatMessage[] = useMemo(() => {
    const currentUser = auth.currentUser;
    if (!currentUser) {
      return [];
    }
    return pagedCoadminChat.items.map((msg) => ({
      id: msg.id,
      text: msg.text,
      imageUrl: msg.imageUrl,
      sender: msg.senderUid === currentUser.uid ? 'admin' : 'user',
      timestamp: msg.createdAt?.toDate?.() || new Date(),
    }));
  }, [pagedCoadminChat.items]);

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
  const myBonusEvents = bonusEvents;

  useEffect(() => {
    if (!message) {
      return;
    }

    const timer = window.setTimeout(() => {
      setMessage((current) => (current === message ? '' : current));
    }, isQuotaExceededMessage(message) ? 15000 : 7000);

    return () => window.clearTimeout(timer);
  }, [message]);

  function clearBonusEventsMessage() {
    setMessage((current) => (isQuotaExceededMessage(current) ? '' : current));
  }

  function scheduleBonusEventsRetry(restart: () => void) {
    if (bonusEventsRetryTimerRef.current != null) {
      window.clearTimeout(bonusEventsRetryTimerRef.current);
    }

    const retryAttempt = bonusEventsRetryCountRef.current;
    const retryDelayMs = Math.min(60_000, 2_000 * 2 ** retryAttempt);
    bonusEventsRetryTimerRef.current = window.setTimeout(() => {
      bonusEventsRetryTimerRef.current = null;
      restart();
    }, retryDelayMs);
    bonusEventsRetryCountRef.current += 1;
  }

  useEffect(() => {
    let isCancelled = false;

    async function loadAutoBonusPercentRange() {
      const currentUser = auth.currentUser;
      if (!currentUser) {
        return;
      }

      try {
        const range = await getCoadminAutoBonusPercentRange(currentUser.uid);
        if (isCancelled) {
          return;
        }
        setAutoBonusMinPercentInput(String(range.minPercent));
        setAutoBonusMaxPercentInput(String(range.maxPercent));
      } catch (error: unknown) {
        if (!isCancelled) {
          setMessage(
            error instanceof Error
              ? error.message
              : 'Failed to load auto-created bonus range.'
          );
        }
      }
    }

    void loadAutoBonusPercentRange();

    return () => {
      isCancelled = true;
    };
  }, []);

  useEffect(() => {
    if (activeView === 'dashboard') {
      loadStaffList();
      loadCarerList();
      loadPlayerList();
      loadGameLogins();
      loadChatUsers();
      void loadPendingCarerRequestsForCoadmin();
    }

    if (activeView === 'view-staff') loadStaffList();
    if (activeView === 'view-carers') {
      loadCarerList();
      void loadPendingCarerRequestsForCoadmin();
    }
    if (activeView === 'create-carer') {
      void loadPendingCarerRequestsForCoadmin();
    }
    if (activeView === 'shifts') {
      loadStaffList();
      loadCarerList();
    }
    if (activeView === 'view-players') loadPlayerList();
    if (activeView === 'game-list') loadGameLogins();
    if (activeView === 'reach-out') loadChatUsers();
  }, [activeView]);

  useEffect(() => {
    setPlayerCoinAmountInput('');
  }, [selectedPlayer?.uid]);

  useEffect(() => {
    if (activeView !== 'payment-details') {
      return;
    }
    const uid = auth.currentUser?.uid;
    if (!uid) {
      return;
    }
    let cancelled = false;
    setLoadingPaymentDetailPhotos(true);
    setMessage('');
    void (async () => {
      try {
        const urls = await getCoadminPaymentDetailPhotos(uid);
        if (!cancelled) {
          setPaymentDetailPhotos(urls);
        }
      } catch {
        if (!cancelled) {
          setMessage('Failed to load payment reference photos.');
        }
      } finally {
        if (!cancelled) {
          setLoadingPaymentDetailPhotos(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeView]);

  useEffect(() => {
    if (!isBonusEventsView) {
      bonusEventsLastEnsureAttemptedCountRef.current = null;
      return;
    }

    let isCancelled = false;
    let unsubscribe: (() => void) | undefined;

    async function startBonusEventsListener() {
      try {
        const coadminUid = await getCurrentUserCoadminUid();
        const currentUid = auth.currentUser?.uid || null;
        console.info('[bonusEvents] listener-started', {
          coadminUid,
          currentUid,
        });

        if (isCancelled) {
          return;
        }

        const tryAutoFill = (activeCount: number) => {
          bonusEventsLatestActiveCountRef.current = activeCount;
          console.info('[bonusEvents] snapshot-count', {
            activeCount,
            cap: MAX_ACTIVE_BONUS_EVENTS,
          });
          if (activeCount >= MAX_ACTIVE_BONUS_EVENTS) {
            bonusEventsLastEnsureAttemptedCountRef.current = null;
            bonusEventsEnsureCooldownUntilMsRef.current = Date.now() + 60_000;
            bonusEventsLastMissingCountRef.current = null;
            console.info('[bonusEvents] skipped-client-full', {
              activeCount,
              cap: MAX_ACTIVE_BONUS_EVENTS,
            });
            return;
          }
          const missingCount = Math.max(0, MAX_ACTIVE_BONUS_EVENTS - activeCount);
          const isFirstEmptyAttempt =
            activeCount === 0 && bonusEventsLastEnsureAttemptAtMsRef.current === 0;
          const nowMs = Date.now();
          if (!isFirstEmptyAttempt && bonusEventsEnsureCooldownUntilMsRef.current > nowMs) {
            console.info('[bonusEvents] skipped-client-cooldown', {
              activeCount,
              missingCount,
              retryAfterMs: bonusEventsEnsureCooldownUntilMsRef.current - nowMs,
            });
            return;
          }
          if (!isFirstEmptyAttempt && bonusEventsLastMissingCountRef.current === missingCount) {
            bonusEventsEnsureCooldownUntilMsRef.current = nowMs + BONUS_ENSURE_CLIENT_COOLDOWN_MS;
            console.info('[bonusEvents] skipped-client-cooldown', {
              activeCount,
              missingCount,
              retryAfterMs: BONUS_ENSURE_CLIENT_COOLDOWN_MS,
            });
            return;
          }
          if (
            bonusAutoFillBusyRef.current ||
            bonusEventsLastEnsureAttemptedCountRef.current === activeCount
          ) {
            return;
          }

          bonusEventsLastEnsureAttemptedCountRef.current = activeCount;
          bonusEventsLastMissingCountRef.current = missingCount;
          console.info('[bonusEvents] ensure-trigger', {
            activeCount,
            missingCount,
            view: activeView,
          });
          void (async () => {
            try {
              await ensureCoadminBonusCapacity(activeCount, {
                ignoreCooldown: isFirstEmptyAttempt,
              });
            } catch (error: unknown) {
              bonusEventsLastEnsureAttemptedCountRef.current = null;
              if (!isCancelled) {
                const msg =
                  error instanceof Error
                    ? error.message
                    : 'Failed to auto-create bonus events.';
                console.info('[bonusEvents] ensure-error', { message: msg });
                setMessage(msg);
              }
            } finally {
              // capacity helper manages busy flag lifecycle
            }
          })();
        };

        unsubscribe = listenBonusEventsByCoadmin(
          coadminUid,
          (events) => {
            if (!isCancelled) {
              bonusEventsRetryCountRef.current = 0;
              console.info('[coadmin bonusEvents] render-values', {
                snapshotSize: events.length,
                firstEventId: events[0]?.id || null,
                firstEventPercent:
                  events.length > 0
                    ? Number(events[0].bonusPercentage || events[0].bonus_percentage || 0)
                    : null,
                percents: events.slice(0, 10).map((event) =>
                  Number(event.bonusPercentage || event.bonus_percentage || 0)
                ),
              });
              setBonusEvents(events);
              clearBonusEventsMessage();
              tryAutoFill(events.length);
            }
          },
          (error) => {
            if (!isCancelled) {
              setMessage(error.message || 'Failed to listen for bonus events.');
              scheduleBonusEventsRetry(() => {
                if (!isCancelled) {
                  void startBonusEventsListener();
                }
              });
            }
          },
          { skipTimeWindowFilter: true }
        );
      } catch (error: any) {
        if (!isCancelled) {
          const errMsg = error?.message || 'Failed to start bonus events listener.';
          setMessage(errMsg);
          if (String(errMsg).toLowerCase().includes('not authenticated')) {
            bonusEventsRetryCountRef.current = 0;
            bonusEventsRetryTimerRef.current = window.setTimeout(() => {
              bonusEventsRetryTimerRef.current = null;
              if (!isCancelled) {
                void startBonusEventsListener();
              }
            }, 1200);
            return;
          }
          scheduleBonusEventsRetry(() => {
            if (!isCancelled) {
              void startBonusEventsListener();
            }
          });
        }
      }
    }

    void startBonusEventsListener();

    return () => {
      isCancelled = true;
      unsubscribe?.();
      if (bonusEventsRetryTimerRef.current != null) {
        window.clearTimeout(bonusEventsRetryTimerRef.current);
        bonusEventsRetryTimerRef.current = null;
      }
    };
  }, [isBonusEventsView]);

  useEffect(() => {
    let isCancelled = false;
    let unsubscribe: (() => void) | undefined;

    async function startShiftSessionListener() {
      try {
        const coadminUid = await getCurrentUserCoadminUid();
        if (isCancelled) {
          return;
        }
        unsubscribe = listenShiftSessionsByCoadmin(
          coadminUid,
          (items) => {
            if (!isCancelled) {
              setShiftSessions(items);
            }
          },
          (error) => {
            if (!isCancelled) {
              setMessage(error.message || 'Failed to listen for shifts.');
            }
          }
        );
      } catch (error: any) {
        if (!isCancelled) {
          setMessage(error.message || 'Failed to start shifts listener.');
        }
      }
    }

    void startShiftSessionListener();

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
    let isCancelled = false;
    let unsubscribe: (() => void) | undefined;

    async function startTransferRequestListener() {
      try {
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
              setMessage(error.message || 'Failed to load cash-to-coin transfer requests.');
            }
          }
        );
      } catch (error: any) {
        if (!isCancelled) {
          setMessage(error?.message || 'Failed to start transfer request listener.');
        }
      }
    }

    void startTransferRequestListener();

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
      await requestCarerCreation(carerUsername);
      setCarerUsername('');
      setCarerPassword('');
      setMessage('Carer request sent to admin for approval.');
      await loadPendingCarerRequestsForCoadmin();
      await loadCarerList();
    } catch (err: any) {
      setMessage(err.message || 'Failed to request carer creation.');
    } finally {
      setLoading(false);
    }
  }

  async function loadPendingCarerRequestsForCoadmin() {
    const currentUser = auth.currentUser;
    if (!currentUser) return;
    const coadminUid = await getCurrentUserCoadminUid();
    const requestsSnap = await getDocs(
      query(
        collection(db, 'carerCreationRequests'),
        where('coadminUid', '==', coadminUid),
        where('status', '==', 'pending')
      )
    );
    const requests = requestsSnap.docs
      .map((docSnap) => ({ id: docSnap.id, ...(docSnap.data() as Omit<CarerCreationRequest, 'id'>) }))
      .sort((a, b) => {
        const aMs = a.requestedAt?.toDate?.()?.getTime?.() || 0;
        const bMs = b.requestedAt?.toDate?.()?.getTime?.() || 0;
        return bMs - aMs;
      });
    setPendingCarerRequests(requests);
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
      await createGameLogin(gameName, gameUsername, gamePassword, gameSiteUrl);
      setGameName('');
      setGameUsername('');
      setGamePassword('');
      setGameSiteUrl('');
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
        siteUrl: editingGame.siteUrl || '',
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

  async function handleCoadminSetStaffPassword(user: StaffUser) {
    const pw1 = window.prompt('New password (at least 6 characters):', '');
    if (pw1 === null) {
      return;
    }
    if (pw1.length < 6) {
      setMessage('Password must be at least 6 characters.');
      return;
    }
    const pw2 = window.prompt('Confirm new password:', '');
    if (pw2 === null) {
      return;
    }
    if (pw1 !== pw2) {
      setMessage('Passwords do not match.');
      return;
    }
    setWorkerCredentialsLoading(true);
    setMessage('');
    try {
      await resetCoadminWorkerCredentials(user, { newPassword: pw1 });
      await loadStaffList();
      const fresh =
        (await getUsersForCurrentCoadmin(getStaff)).find((s) => s.uid === user.uid) ?? null;
      setSelectedStaff(fresh);
      setMessage('Password updated. Send it to this person through a private channel only.');
    } catch (err: any) {
      setMessage(err?.message || 'Failed to set password.');
    } finally {
      setWorkerCredentialsLoading(false);
    }
  }

  async function handleCoadminSetStaffUsername(user: StaffUser) {
    const next = window.prompt(
      `New login username (lowercase, no spaces; current: ${user.username}):`,
      user.username
    );
    if (next === null) {
      return;
    }
    const clean = next.trim().toLowerCase();
    if (!clean) {
      setMessage('Username is required.');
      return;
    }
    if (clean === user.username) {
      setMessage('That is already the login username.');
      return;
    }
    setWorkerCredentialsLoading(true);
    setMessage('');
    try {
      await resetCoadminWorkerCredentials(user, { newUsername: clean });
      await loadStaffList();
      const fresh =
        (await getUsersForCurrentCoadmin(getStaff)).find((s) => s.uid === user.uid) ?? null;
      setSelectedStaff(fresh);
      setMessage('Login username updated. It must be unique across the app.');
    } catch (err: any) {
      setMessage(err?.message || 'Failed to change username.');
    } finally {
      setWorkerCredentialsLoading(false);
    }
  }

  async function handleCoadminSetCarerPassword(user: CarerUser) {
    const pw1 = window.prompt('New password (at least 6 characters):', '');
    if (pw1 === null) {
      return;
    }
    if (pw1.length < 6) {
      setMessage('Password must be at least 6 characters.');
      return;
    }
    const pw2 = window.prompt('Confirm new password:', '');
    if (pw2 === null) {
      return;
    }
    if (pw1 !== pw2) {
      setMessage('Passwords do not match.');
      return;
    }
    setWorkerCredentialsLoading(true);
    setMessage('');
    try {
      await resetCoadminWorkerCredentials(user, { newPassword: pw1 });
      await loadCarerList();
      const fresh =
        (await getUsersForCurrentCoadmin(getCarers)).find((c) => c.uid === user.uid) ?? null;
      setSelectedCarer(fresh);
      setMessage('Password updated. Send it to this person through a private channel only.');
    } catch (err: any) {
      setMessage(err?.message || 'Failed to set password.');
    } finally {
      setWorkerCredentialsLoading(false);
    }
  }

  async function handleCoadminSetCarerUsername(user: CarerUser) {
    const next = window.prompt(
      `New login username (lowercase, no spaces; current: ${user.username}):`,
      user.username
    );
    if (next === null) {
      return;
    }
    const clean = next.trim().toLowerCase();
    if (!clean) {
      setMessage('Username is required.');
      return;
    }
    if (clean === user.username) {
      setMessage('That is already the login username.');
      return;
    }
    setWorkerCredentialsLoading(true);
    setMessage('');
    try {
      await resetCoadminWorkerCredentials(user, { newUsername: clean });
      await loadCarerList();
      const fresh =
        (await getUsersForCurrentCoadmin(getCarers)).find((c) => c.uid === user.uid) ?? null;
      setSelectedCarer(fresh);
      setMessage('Login username updated. It must be unique across the app.');
    } catch (err: any) {
      setMessage(err?.message || 'Failed to change username.');
    } finally {
      setWorkerCredentialsLoading(false);
    }
  }

  async function handleCoadminSetPlayerPassword(user: PlayerUser) {
    const pw1 = window.prompt(
      `Set new password for player "${user.username}" (min 6 chars):`,
      ''
    );
    if (pw1 == null) return;
    if (pw1.length < 6) {
      setMessage('Password must be at least 6 characters.');
      return;
    }
    const pw2 = window.prompt('Confirm new password:', '');
    if (pw2 == null) return;
    if (pw1 !== pw2) {
      setMessage('Passwords do not match.');
      return;
    }
    setWorkerCredentialsLoading(true);
    setMessage('');
    try {
      await resetCoadminWorkerCredentials(user, { newPassword: pw1 });
      setMessage('Player password updated. Share it securely.');
    } catch (err: any) {
      setMessage(err?.message || 'Failed to set player password.');
    } finally {
      setWorkerCredentialsLoading(false);
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

  async function handleTogglePlayerStatus(user: PlayerUser) {
    const wasDisabled = user.status === 'disabled';

    if (!wasDisabled) {
      const ok = window.confirm(
        'Block this player? They can still sign in to message your team; play and wallet actions stay restricted until unblocked.'
      );
      if (!ok) {
        return;
      }
    }

    setBlocking(true);
    setMessage('');

    try {
      if (wasDisabled) {
        await unblockPlayer(user);
        setMessage('Player unblocked.');
      } else {
        await blockPlayer(user);
        setMessage('Player blocked.');
      }
      await loadPlayerList();
    } catch (err: any) {
      setMessage(err.message || 'Failed to update player status.');
    } finally {
      setBlocking(false);
    }
  }

  async function handleAdjustPlayerCoin(player: PlayerUser, mode: 'add' | 'deduct') {
    const raw = playerCoinAmountInput.trim();
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      setMessage('Enter a positive amount.');
      return;
    }

    const amount = Math.floor(parsed);
    if (amount <= 0) {
      setMessage('Enter a positive amount.');
      return;
    }

    const delta = mode === 'add' ? amount : -amount;

    setPlayerCoinAdjustBusy(true);
    setMessage('');

    try {
      await adjustPlayerCoin({ playerUid: player.uid, delta });
      setMessage(
        mode === 'add'
          ? `Added ${amount} coin for ${player.username || 'player'}.`
          : `Deducted ${amount} coin from ${player.username || 'player'}.`
      );
      setPlayerCoinAmountInput('');

      const list = await getUsersForCurrentCoadmin(getPlayers);
      setPlayerList(list);
      setSelectedPlayer(list.find((p) => p.uid === player.uid) ?? null);
    } catch (err: any) {
      setMessage(err?.message || 'Could not update coin balance.');
    } finally {
      setPlayerCoinAdjustBusy(false);
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

  async function handleApproveTransferRequest(requestId: string) {
    setTransferRequestBusyId(requestId);
    setMessage('');
    try {
      await approveTransferRequest(requestId);
      setMessage(
        'Transfer approved and converted to coin. Most profit comes from cashouts. Repeated cash-to-coin transfers may reduce long-term gains.'
      );
    } catch (error: any) {
      setMessage(error.message || 'Failed to approve transfer request.');
    } finally {
      setTransferRequestBusyId(null);
    }
  }

  async function handleRejectTransferRequest(requestId: string) {
    setTransferRequestBusyId(requestId);
    setMessage('');
    try {
      await rejectTransferRequest(requestId, 'Transfer denied due to suspected misuse.');
      setMessage('Transfer request rejected.');
    } catch (error: any) {
      setMessage(error.message || 'Failed to reject transfer request.');
    } finally {
      setTransferRequestBusyId(null);
    }
  }

  async function handleCreateBonusEvent(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    setMessage('');

    try {
      const resolvedAmount = bonusAmount.trim() ? Number(bonusAmount) : randomInt(10, 50);
      const resolvedPercentage = bonusPercentage.trim()
        ? Number(bonusPercentage)
        : randomInt(5, 10);
      if (!bonusAmount.trim()) {
        setBonusAmount(String(resolvedAmount));
      }
      if (!bonusPercentage.trim()) {
        setBonusPercentage(String(resolvedPercentage));
      }

      const result = await createBonusEvent({
        bonusName,
        gameName: bonusGameName,
        amountNpr: resolvedAmount,
        description: bonusDescription,
        bonusPercentage: resolvedPercentage,
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

  async function ensureCoadminBonusCapacity(
    activeCountHint?: number,
    options?: { ignoreCooldown?: boolean }
  ) {
    if (bonusAutoFillBusyRef.current) {
      console.info('[coadmin] bonus-events:ensure-skip', {
        reason: 'busy',
      });
      return;
    }
    const resolvedActiveCount =
      typeof activeCountHint === 'number'
        ? activeCountHint
        : bonusEventsLatestActiveCountRef.current;
    // Strict full-capacity guard: never call ensure API when active is full.
    if (resolvedActiveCount >= MAX_ACTIVE_BONUS_EVENTS) {
      bonusEventsEnsureCooldownUntilMsRef.current = Date.now() + 60_000;
      bonusEventsLastMissingCountRef.current = null;
      console.info('[bonusEvents] skipped-client-full', {
        activeCount: resolvedActiveCount,
        cap: MAX_ACTIVE_BONUS_EVENTS,
      });
      return;
    }
    const stateActiveCount = bonusEvents.length;
    if (stateActiveCount >= MAX_ACTIVE_BONUS_EVENTS) {
      bonusEventsEnsureCooldownUntilMsRef.current = Date.now() + 60_000;
      bonusEventsLastMissingCountRef.current = null;
      console.info('[bonusEvents] skipped-client-full', {
        activeCount: stateActiveCount,
        cap: MAX_ACTIVE_BONUS_EVENTS,
      });
      return;
    }
    const nowMs = Date.now();
    const retryAfterByAttempt = bonusEventsLastEnsureAttemptAtMsRef.current
      ? BONUS_ENSURE_CLIENT_COOLDOWN_MS - (nowMs - bonusEventsLastEnsureAttemptAtMsRef.current)
      : 0;
    if (!options?.ignoreCooldown && retryAfterByAttempt > 0) {
      console.info('[bonusEvents] skipped-client-cooldown', {
        retryAfterMs: retryAfterByAttempt,
      });
      return;
    }
    if (!options?.ignoreCooldown && bonusEventsEnsureCooldownUntilMsRef.current > nowMs) {
      console.info('[bonusEvents] skipped-client-cooldown', {
        retryAfterMs: bonusEventsEnsureCooldownUntilMsRef.current - nowMs,
      });
      return;
    }
    const missingCount = Math.max(0, MAX_ACTIVE_BONUS_EVENTS - stateActiveCount);
    if (!options?.ignoreCooldown && bonusEventsLastMissingCountRef.current === missingCount) {
      bonusEventsEnsureCooldownUntilMsRef.current = nowMs + BONUS_ENSURE_CLIENT_COOLDOWN_MS;
      console.info('[bonusEvents] skipped-client-cooldown', {
        missingCount,
        retryAfterMs: BONUS_ENSURE_CLIENT_COOLDOWN_MS,
      });
      return;
    }
    bonusAutoFillBusyRef.current = true;
    bonusEventsLastEnsureAttemptAtMsRef.current = nowMs;
    bonusEventsLastMissingCountRef.current = missingCount;
    try {
      const currentUser = auth.currentUser;
      if (!currentUser) {
        console.info('[coadmin] bonus-events:ensure-skip', {
          reason: 'missing-current-user',
        });
        return;
      }
      const idToken = await currentUser.getIdToken();
      const response = await fetch('/api/coadmin/bonus-events/ensure-capacity', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${idToken}`,
        },
        body: JSON.stringify({ activeCountHint: resolvedActiveCount }),
      });
      const data = (await response.json()) as {
        autoCreatedCount?: number;
        totalActive?: number | null;
        skipped?: string;
        retryAfterMs?: number;
        error?: string;
      };
      if (!response.ok) {
        throw new Error(data.error || 'Failed to auto-create bonus events.');
      }
      if (
        data.skipped === 'cooldown' ||
        data.skipped === 'locked' ||
        data.skipped === 'server-cooldown'
      ) {
        bonusEventsEnsureCooldownUntilMsRef.current = Date.now() + Math.max(5_000, Number(data.retryAfterMs || 10_000));
      }
      if (typeof data.totalActive === 'number' && data.totalActive >= MAX_ACTIVE_BONUS_EVENTS) {
        bonusEventsEnsureCooldownUntilMsRef.current = Date.now() + 60_000;
      }
      if (data.skipped === 'server-cooldown') {
        console.info('[coadmin] bonus-events:skipped-server-cooldown', {
          retryAfterMs: Number(data.retryAfterMs || 0),
        });
      }
      const result = {
        autoCreatedCount: Number(data.autoCreatedCount || 0),
      };
      console.info('[bonusEvents] ensure-created', {
        activeCount: stateActiveCount,
        missingCount,
        createdCount: result.autoCreatedCount,
        totalActive: data.totalActive ?? null,
        skipped: data.skipped || null,
      });
      clearBonusEventsMessage();
      if (result.autoCreatedCount > 0) {
        setMessage('Bonus events auto-created successfully.');
      }
    } catch (error: unknown) {
      const msg =
        error instanceof Error ? error.message : 'Failed to auto-create bonus events.';
      console.info('[bonusEvents] ensure-error', { message: msg });
      setMessage(msg);
    } finally {
      bonusAutoFillBusyRef.current = false;
    }
  }

  async function handleSaveAutoBonusPercentRange() {
    setAutoBonusRangeBusy(true);
    setMessage('');

    try {
      const minPercent = Number(autoBonusMinPercentInput);
      const maxPercent = Number(autoBonusMaxPercentInput);

      if (!Number.isFinite(minPercent) || !Number.isFinite(maxPercent)) {
        throw new Error('Auto-created bonus range must use numbers only.');
      }

      const savedRange = await setCoadminAutoBonusPercentRange({
        minPercent,
        maxPercent,
      });
      setAutoBonusMinPercentInput(String(savedRange.minPercent));
      setAutoBonusMaxPercentInput(String(savedRange.maxPercent));
      setMessage(
        savedRange.adjustedEventCount > 0
          ? `Auto-created bonus event range saved: ${savedRange.minPercent}% to ${savedRange.maxPercent}%. Adjusted ${savedRange.adjustedEventCount} existing auto-created bonus events into range.`
          : `Auto-created bonus event range saved: ${savedRange.minPercent}% to ${savedRange.maxPercent}%. New auto-created events will use this range.`
      );
    } catch (error: unknown) {
      setMessage(
        error instanceof Error
          ? error.message
          : 'Failed to save auto-created bonus range.'
      );
    } finally {
      setAutoBonusRangeBusy(false);
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

  async function handleCutRewardForWorker(values: {
    uid: string;
    username: string;
    role: 'staff' | 'carer';
  }) {
    const amountText = rewardCutAmountByUid[values.uid] || '';
    const reasonText = rewardCutReasonByUid[values.uid] || '';
    const amountNpr = Math.round(Number(amountText || 0));
    if (amountNpr <= 0) {
      setMessage('Enter a valid reward cut amount.');
      return;
    }

    setRewardCutBusyUid(values.uid);
    setMessage('');
    try {
      const result = await cutWorkerReward({
        workerUid: values.uid,
        workerRole: values.role,
        workerUsername: values.username,
        amountNpr,
        reason: reasonText,
      });
      if (values.role === 'staff') {
        setStaffList((prev) =>
          prev.map((item) =>
            item.uid === values.uid ? { ...item, cashBoxNpr: result.updatedCashBox } : item
          )
        );
      } else {
        setCarerList((prev) =>
          prev.map((item) =>
            item.uid === values.uid ? { ...item, cashBoxNpr: result.updatedCashBox } : item
          )
        );
      }
      setRewardCutAmountByUid((prev) => ({ ...prev, [values.uid]: '' }));
      setMessage(`Reward cut applied for ${values.username || values.role}.`);
    } catch (error: any) {
      setMessage(error?.message || 'Failed to cut reward.');
    } finally {
      setRewardCutBusyUid(null);
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
      setNewMessage('');
      handleClearImage();
      return;
    }

    setStaffChatUser(user);
    setReachOutChatUser(null);
    setNewMessage('');
    handleClearImage();
    markConversationAsRead(user.uid);
  }

  function handleReachOutUserSelect(user: AdminUser) {
    setReachOutChatUser(user);
    setStaffChatUser(null);
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
    setNewMessage('');
    handleClearImage();
  }

  function handleChangeView(view: CoadminView) {
    setActiveView(view);
    setMessage('');
    resetSelection();
  }

  async function handleAddPaymentDetailPhotos(files: FileList | null) {
    if (!files?.length) {
      return;
    }
    const uid = auth.currentUser?.uid;
    if (!uid) {
      return;
    }
    setPaymentDetailUploading(true);
    setMessage('');
    try {
      const next = [...paymentDetailPhotos];
      for (const file of Array.from(files)) {
        const compressed = await imageCompression(file, {
          maxSizeMB: 0.7,
          maxWidthOrHeight: 1600,
          useWebWorker: true,
        });
        const uploaded = await uploadCoadminPaymentDetailPhoto(uid, compressed);
        next.push(uploaded);
      }
      await setCoadminPaymentDetailPhotos(uid, next);
      setPaymentDetailPhotos(next);
      setMessage('Payment photos saved. Players can use them in Load coin.');
    } catch (err: any) {
      setMessage(err?.message || 'Failed to upload photos.');
    } finally {
      setPaymentDetailUploading(false);
    }
  }

  async function handleRemovePaymentDetailPhoto(index: number) {
    const uid = auth.currentUser?.uid;
    if (!uid) {
      return;
    }
    const next = paymentDetailPhotos.filter((_, i) => i !== index);
    setPaymentDetailUploading(true);
    setMessage('');
    try {
      await setCoadminPaymentDetailPhotos(uid, next);
      setPaymentDetailPhotos(next);
    } catch (err: any) {
      setMessage(err?.message || 'Failed to remove photo.');
    } finally {
      setPaymentDetailUploading(false);
    }
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

  const coadminPresenceUids = useMemo(() => {
    const s = new Set<string>();
    for (const u of staffList) s.add(u.uid);
    for (const u of carerList) s.add(u.uid);
    for (const u of playerList) s.add(u.uid);
    for (const u of chatUsers) s.add(u.uid);
    return Array.from(s);
  }, [staffList, carerList, playerList, chatUsers]);

  const coadminOnlineByUid = usePresenceOnlineMap(coadminPresenceUids);

  const shiftsRows = useMemo(() => {
    const nowMs = Date.now();
    const heartbeatGraceMs = 2 * 60 * 1000;
    const byUser = new Map<string, ShiftSession[]>();
    for (const item of shiftSessions) {
      const list = byUser.get(item.userUid) || [];
      list.push(item);
      byUser.set(item.userUid, list);
    }

    const workers = [
      ...sortedStaff.map((user) => ({ ...user, workerRole: 'staff' as const })),
      ...sortedCarers.map((user) => ({ ...user, workerRole: 'carer' as const })),
    ];

    return workers.map((worker) => {
      const sessions = byUser.get(worker.uid) || [];
      const latestLoginAt =
        [...sessions]
          .map((session) => ({ value: session.loginAt || null, ms: toMillis(session.loginAt || null) }))
          .sort((a, b) => b.ms - a.ms)[0]?.value || null;
      const latestLogoutAtRaw =
        [...sessions]
          .map((session) => ({ value: session.logoutAt || null, ms: toMillis(session.logoutAt || null) }))
          .sort((a, b) => b.ms - a.ms)[0]?.value || null;
      const latestLastSeenAt =
        [...sessions]
          .map((session) => ({ value: session.lastSeenAt || null, ms: toMillis(session.lastSeenAt || null) }))
          .sort((a, b) => b.ms - a.ms)[0]?.value || null;

      const activeSession = [...sessions]
        .filter((session) => Boolean(session.isActive))
        .sort((a, b) => {
          const aMs = toMillis(a.lastSeenAt || null) || toMillis(a.loginAt || null);
          const bMs = toMillis(b.lastSeenAt || null) || toMillis(b.loginAt || null);
          return bMs - aMs;
        })[0];
      const activeSeenMs = toMillis(activeSession?.lastSeenAt || null);
      const isActive =
        Boolean(activeSession) &&
        activeSeenMs > 0 &&
        nowMs - activeSeenMs <= heartbeatGraceMs;

      const workedHoursLast24h = calculateWorkedHoursLast24hWithHeartbeat(
        sessions,
        nowMs,
        heartbeatGraceMs
      );
      const inferredLogoutAt =
        !isActive && latestLogoutAtRaw == null && latestLastSeenAt ? latestLastSeenAt : null;

      return {
        uid: worker.uid,
        username: worker.username,
        role: worker.workerRole,
        cashBoxNpr: Number(worker.cashBoxNpr || 0),
        latestLoginAt,
        latestLogoutAt: latestLogoutAtRaw || inferredLogoutAt,
        isActive,
        lastSeenAt: latestLastSeenAt,
        workedHoursLast24h,
      };
    });
  }, [shiftSessions, sortedCarers, sortedStaff]);
  const menuItems: (NavigationItem & { view: CoadminView })[] = [
    { label: 'Dashboard', view: 'dashboard' },
    { label: 'View Tasks', view: 'view-tasks' },
    { label: 'Create Bonus Event', view: 'create-bonus-event' },
    { label: 'View Bonus Events', view: 'view-bonus-events' },
    { label: 'Add Staff', view: 'add-staff' },
    {
      label: 'View Staff',
      view: 'view-staff',
      unread: staffUnreadCount,
      onClick: () => {
        if (staffUnreadCount > 0) {
          handleOpenFirstUnreadStaffChat();
          return;
        }

        handleChangeView('view-staff');
      },
    },
    { label: 'Hire Carer', view: 'create-carer' },
    { label: 'View Carers', view: 'view-carers' },
    { label: 'Create Player', view: 'create-player' },
    { label: 'View Players', view: 'view-players' },
    { label: 'Add Games', view: 'add-games' },
    { label: 'Game List', view: 'game-list' },
    { label: 'Payment details (photos)', view: 'payment-details' },
    { label: 'Shifts', view: 'shifts' },
    {
      label: 'Reach Out',
      view: 'reach-out',
      unread: reachOutUnreadCount,
      onClick: () => {
        if (reachOutUnreadCount > 0) {
          handleOpenFirstUnreadReachOutChat();
          return;
        }

        handleChangeView('reach-out');
      },
    },
  ];

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
    <ProtectedRoute allowedRoles={['coadmin']}>
      <RoleSidebarLayout
        title="Co-admin Panel"
        activeView={activeView}
        items={menuItems.map((item) => ({
          ...item,
          onClick: item.onClick ?? (() => handleChangeView(item.view as CoadminView)),
        }))}
        footer={<LogoutButton />}
      >
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

              {pendingCarerRequests.length > 0 && (
                <div className="mt-4 rounded-2xl border border-yellow-500/30 bg-yellow-500/10 p-5">
                  <h3 className="text-lg font-bold text-yellow-200">
                    Carer Requests Awaiting Admin Approval ({pendingCarerRequests.length})
                  </h3>
                  <div className="mt-3 space-y-2">
                    {pendingCarerRequests.slice(0, 5).map((request) => (
                      <div
                        key={request.id}
                        className="rounded-xl border border-white/10 bg-black/30 p-3"
                      >
                        <p className="text-sm text-white">
                          Username: <span className="font-semibold">{request.requestedUsername}</span>
                        </p>
                        <p className="text-xs text-yellow-100/70">
                          Requested at: {formatDateTime(request.requestedAt)}
                        </p>
                      </div>
                    ))}
                  </div>
                </div>
              )}

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
                <div className="mt-4 rounded-2xl border border-amber-500/30 bg-amber-500/10 p-5">
                  <h3 className="text-lg font-bold text-amber-200">
                    Cash → Coin Transfer Requests ({pendingTransferRequests.length})
                  </h3>
                  <p className="mt-1 text-xs text-amber-100/80">
                    Approve to move the player&apos;s full cash into coin. Reject to leave balances
                    unchanged. See profit / abuse notes below before approving.
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
                          Cash at request: {formatNprDisplay(request.cashBalanceSnapshot || 0)}
                        </p>
                        <p className="mt-1 text-xs text-amber-100/70">
                          Transfer amount: {formatNprDisplay(request.amountNpr || 0)}
                        </p>
                        <p className="mt-1 text-xs text-amber-100/70">
                          Requested:{' '}
                          {request.requestedAt?.toDate?.().toLocaleString?.() || '—'}
                        </p>
                        <p className="mt-2 text-xs text-amber-200/90">
                          Most profit comes from cashouts. Repeated cash-to-coin transfers may reduce
                          long-term gains — approve only when appropriate.
                        </p>
                        <div className="mt-3 flex flex-wrap gap-2">
                          <button
                            type="button"
                            onClick={() => void handleApproveTransferRequest(request.id)}
                            disabled={transferRequestBusyId === request.id}
                            className="rounded-lg bg-emerald-500 px-3 py-1.5 text-xs font-semibold text-black hover:bg-emerald-400 disabled:opacity-60"
                          >
                            {transferRequestBusyId === request.id ? 'Saving…' : 'Approve'}
                          </button>
                          <button
                            type="button"
                            onClick={() => void handleRejectTransferRequest(request.id)}
                            disabled={transferRequestBusyId === request.id}
                            className="rounded-lg bg-rose-500 px-3 py-1.5 text-xs font-semibold text-white hover:bg-rose-400 disabled:opacity-60"
                          >
                            {transferRequestBusyId === request.id ? 'Saving…' : 'Reject'}
                          </button>
                        </div>
                      </div>
                    ))}
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
                    min={10}
                    max={50}
                    value={bonusAmount}
                    onChange={(event) => setBonusAmount(event.target.value)}
                    className="mt-2 w-full rounded-xl border border-white/15 bg-black/30 px-4 py-3 text-white outline-none focus:border-white/40"
                    placeholder="10 - 50"
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
                    min={5}
                    max={10}
                    value={bonusPercentage}
                    onChange={(event) => setBonusPercentage(event.target.value)}
                    className="mt-2 w-full rounded-xl border border-white/15 bg-black/30 px-4 py-3 text-white outline-none focus:border-white/40"
                    placeholder="5 - 10"
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
              <div className="mb-6 flex flex-col gap-4 rounded-2xl border border-violet-400/25 bg-violet-500/10 p-4 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <h2 className="text-3xl font-bold">View Bonus Events</h2>
                  <p className="mt-1 text-sm text-violet-100/75">
                    Set the percentage range used when coadmin bonus events are auto-created.
                    Examples: `10` to `20`, or `5` to `30`.
                  </p>
                </div>
                <div className="flex flex-wrap items-end gap-3">
                  {isQuotaExceededMessage(message) && (
                    <button
                      type="button"
                      onClick={() => {
                        setMessage('');
                        void ensureCoadminBonusCapacity();
                      }}
                      disabled={bonusAutoFillBusyRef.current}
                      className="min-h-[44px] rounded-xl border border-amber-300/40 bg-amber-200/90 px-4 py-2 text-sm font-semibold text-black transition hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {bonusAutoFillBusyRef.current ? 'Retrying...' : 'Retry now'}
                    </button>
                  )}
                  <label className="flex min-w-[110px] flex-col gap-1 text-sm text-violet-100/80">
                    <span>Min %</span>
                    <input
                      type="number"
                      min={COADMIN_AUTO_BONUS_PERCENT_MIN}
                      max={COADMIN_AUTO_BONUS_PERCENT_MAX}
                      value={autoBonusMinPercentInput}
                      onChange={(event) => setAutoBonusMinPercentInput(event.target.value)}
                      disabled={autoBonusRangeBusy}
                      className="rounded-xl border border-violet-400/35 bg-black/30 px-3 py-2 text-white outline-none transition focus:border-violet-300"
                    />
                  </label>
                  <label className="flex min-w-[110px] flex-col gap-1 text-sm text-violet-100/80">
                    <span>Max %</span>
                    <input
                      type="number"
                      min={COADMIN_AUTO_BONUS_PERCENT_MIN}
                      max={COADMIN_AUTO_BONUS_PERCENT_MAX}
                      value={autoBonusMaxPercentInput}
                      onChange={(event) => setAutoBonusMaxPercentInput(event.target.value)}
                      disabled={autoBonusRangeBusy}
                      className="rounded-xl border border-violet-400/35 bg-black/30 px-3 py-2 text-white outline-none transition focus:border-violet-300"
                    />
                  </label>
                  <button
                    type="button"
                    onClick={() => void handleSaveAutoBonusPercentRange()}
                    disabled={autoBonusRangeBusy}
                    className="min-h-[44px] rounded-xl border border-violet-300/35 bg-white px-4 py-2 text-sm font-semibold text-black transition hover:bg-neutral-200 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {autoBonusRangeBusy ? 'Saving...' : 'Save Range'}
                  </button>
                </div>
              </div>
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
              onCoadminSetPassword={handleCoadminSetStaffPassword}
              onCoadminSetUsername={handleCoadminSetStaffUsername}
              coadminCredentialsLoading={workerCredentialsLoading}
              onlineByUid={coadminOnlineByUid}
              nameMode="coadmin"
              onStartChat={handleStaffStartChat}
              chatUser={staffChatUser}
              messages={messages}
              newMessage={newMessage}
              onMessageChange={setNewMessage}
              onSendMessage={handleSendMessage}
              onImageSelect={handleImageSelect}
              onClearImage={handleClearImage}
              messagesScrollRef={coadminChatScrollRef}
              hasMoreOlderMessages={pagedCoadminChat.hasMoreOlder}
              loadingOlderMessages={pagedCoadminChat.loadingOlder}
              onLoadOlderMessages={pagedCoadminChat.loadOlder}
            />
          )}

          {activeView === 'create-carer' && (
            <div className="space-y-4">
              <div className="rounded-2xl border border-yellow-500/30 bg-yellow-500/10 p-4 text-sm text-yellow-100">
                Carer handles your tasks for you, but you need to pay them.
              </div>
              <CreateUserForm
                title="Hire Carer (Admin Approval)"
                buttonLabel="Send Hire Request"
                loadingLabel="Sending..."
                username={carerUsername}
                password={carerPassword}
                loading={loading}
                onUsernameChange={setCarerUsername}
                onPasswordChange={setCarerPassword}
                showPasswordInput={false}
                passwordRequired={false}
                onSubmit={handleCreateCarer}
              />
            </div>
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
              onCoadminSetUsername={handleCoadminSetCarerUsername}
              coadminCredentialsLoading={workerCredentialsLoading}
              onlineByUid={coadminOnlineByUid}
              nameMode="coadmin"
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
              onToggleBlock={handleTogglePlayerStatus}
              blocking={blocking}
              onCoadminSetPassword={handleCoadminSetPlayerPassword}
              coadminCredentialsLoading={workerCredentialsLoading}
              onlineByUid={coadminOnlineByUid}
              nameMode="coadmin"
              renderSelectedExtras={(user) => (
                <div className="mt-5 w-full max-w-md rounded-2xl border border-emerald-500/20 bg-emerald-950/30 p-4">
                  <p className="text-xs font-bold uppercase tracking-wider text-emerald-200/80">
                    Coin balance
                  </p>
                  <p className="mt-1 text-2xl font-bold text-white tabular-nums">
                    {Math.max(0, Math.floor(Number(user.coin || 0))).toLocaleString()} coin
                  </p>
                  {user.cash != null && (
                    <p className="mt-1 text-sm text-neutral-500">
                      Cash (view only):{' '}
                      <span className="text-neutral-300">
                        {Math.max(0, Math.floor(Number(user.cash || 0))).toLocaleString()}
                      </span>
                    </p>
                  )}
                  <p className="mt-1 text-sm text-neutral-400">
                    Total recharged:{' '}
                    <span className="font-semibold text-emerald-200">
                      {Math.max(
                        0,
                        Math.floor(Number(user.totalRechargeAmount || 0))
                      ).toLocaleString()}
                    </span>
                  </p>
                  <p className="mt-0.5 text-sm text-neutral-400">
                    Total redeemed:{' '}
                    <span className="font-semibold text-rose-200">
                      {Math.max(
                        0,
                        Math.floor(Number(user.totalRedeemAmount || 0))
                      ).toLocaleString()}
                    </span>
                  </p>
                  <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-end">
                    <label className="min-w-0 flex-1 text-sm text-neutral-400">
                      Amount
                      <input
                        type="number"
                        min={1}
                        step={1}
                        inputMode="numeric"
                        value={playerCoinAmountInput}
                        onChange={(e) => setPlayerCoinAmountInput(e.target.value)}
                        disabled={playerCoinAdjustBusy}
                        placeholder="0"
                        className="mt-1 w-full rounded-xl border border-white/15 bg-black/40 px-3 py-2 text-white outline-none focus:border-emerald-500/50 disabled:opacity-50"
                      />
                    </label>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => void handleAdjustPlayerCoin(user, 'add')}
                        disabled={playerCoinAdjustBusy || blocking}
                        className="whitespace-nowrap rounded-xl bg-emerald-500 px-4 py-2.5 text-sm font-bold text-black hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {playerCoinAdjustBusy ? '...' : 'Add coin'}
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleAdjustPlayerCoin(user, 'deduct')}
                        disabled={playerCoinAdjustBusy || blocking}
                        className="whitespace-nowrap rounded-xl border border-rose-500/50 bg-rose-950/40 px-4 py-2.5 text-sm font-bold text-rose-100 hover:bg-rose-900/50 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {playerCoinAdjustBusy ? '...' : 'Deduct coin'}
                      </button>
                    </div>
                  </div>
                  <p className="mt-2 text-xs text-neutral-500">
                    Whole numbers only. Deductions cannot make coin go below zero. Cash
                    is shown for reference; only coin is changed here.
                  </p>
                </div>
              )}
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

                <label className="block text-sm text-neutral-300">
                  <span className="mb-2 block">Backend Link</span>
                  <input
                    value={gameSiteUrl}
                    onChange={(e) => setGameSiteUrl(e.target.value)}
                    placeholder="https://example.com"
                    className="w-full rounded-xl border border-white/10 bg-neutral-900 p-3 outline-none focus:border-white/30"
                  />
                </label>

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

                          <label className="block text-sm text-neutral-300">
                            <span className="mb-2 block">Backend Link</span>
                            <input
                              value={editingGame.siteUrl || ''}
                              onChange={(e) =>
                                setEditingGame({
                                  ...editingGame,
                                  siteUrl: e.target.value,
                                })
                              }
                              placeholder="https://example.com"
                              className="w-full rounded-xl border border-white/10 bg-neutral-900 p-3 outline-none focus:border-white/30"
                            />
                          </label>

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
                            <div className="mt-3 rounded-xl border border-cyan-500/20 bg-cyan-500/5 p-3">
                              <p className="text-xs font-semibold uppercase tracking-wide text-cyan-200/80">
                                Backend Link
                              </p>
                              {game.siteUrl ? (
                                <a
                                  href={game.siteUrl}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="mt-2 block break-all text-sm text-cyan-300 underline underline-offset-2 hover:text-cyan-200"
                                >
                                  {game.siteUrl}
                                </a>
                              ) : (
                                <p className="mt-2 text-sm text-white">Not set</p>
                              )}
                            </div>
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

          {activeView === 'payment-details' && (
            <div>
              <h2 className="text-2xl font-bold">Payment details — reference photos</h2>
              <p className="mt-2 max-w-2xl text-sm text-neutral-400">
                Upload one or more images (QR codes, bank apps, e-wallet screenshots). When a
                player taps <span className="text-neutral-200">Load coin</span> and then{' '}
                <span className="text-neutral-200">Add coins</span>, they see{' '}
                <strong>one image chosen at random</strong> and a 16-digit code that expires in 10
                minutes.
              </p>

              <div className="mt-6 rounded-2xl border border-cyan-500/25 bg-black/30 p-5">
                <label className="block">
                  <span className="text-sm font-semibold text-cyan-100/90">
                    Add photos
                  </span>
                  <input
                    type="file"
                    accept="image/*"
                    multiple
                    disabled={paymentDetailUploading}
                    onChange={(e) => {
                      void handleAddPaymentDetailPhotos(e.target.files);
                      e.target.value = '';
                    }}
                    className="mt-2 block w-full text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-cyan-500/20 file:px-4 file:py-2 file:font-semibold file:text-cyan-100"
                  />
                </label>
                <div className="mt-4">
                  <ImageUploadField
                    label="Quick single upload"
                    autoUpload
                    onUploaded={(uploaded) => {
                      const uid = auth.currentUser?.uid;
                      if (!uid) {
                        return;
                      }
                      const next = [
                        ...paymentDetailPhotos,
                        {
                          imageUrl: uploaded.url,
                          imagePublicId: uploaded.publicId,
                        },
                      ];
                      void setCoadminPaymentDetailPhotos(uid, next)
                        .then(() => {
                          setPaymentDetailPhotos(next);
                          setMessage('Image uploaded successfully.');
                        })
                        .catch((err) =>
                          setMessage(
                            err instanceof Error
                              ? err.message
                              : 'Image upload failed. Please try again.'
                          )
                        );
                    }}
                    onError={(err) => setMessage(err)}
                  />
                </div>
                {paymentDetailUploading ? (
                  <p className="mt-3 text-sm text-amber-200/90">Uploading…</p>
                ) : null}
              </div>

              <div className="mt-6">
                {loadingPaymentDetailPhotos ? (
                  <p className="text-sm text-neutral-500">Loading…</p>
                ) : paymentDetailPhotos.length === 0 ? (
                  <p className="text-sm text-neutral-500">No reference photos yet.</p>
                ) : (
                  <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                    {paymentDetailPhotos.map((photo, index) => (
                      <li
                        key={`${photo.imagePublicId || 'photo'}-${index}`}
                        className="overflow-hidden rounded-2xl border border-white/10 bg-black/40"
                      >
                        <div className="relative aspect-[4/3] w-full">
                          <img
                            src={photo.imageUrl}
                            alt={`Payment reference ${index + 1}`}
                            className="h-full w-full object-contain"
                          />
                        </div>
                        <div className="flex items-center justify-between gap-2 p-2">
                          <span className="text-xs text-neutral-500">#{index + 1}</span>
                          <button
                            type="button"
                            disabled={paymentDetailUploading}
                            onClick={() => void handleRemovePaymentDetailPhoto(index)}
                            className="rounded-lg bg-rose-500/20 px-3 py-1.5 text-xs font-semibold text-rose-200 hover:bg-rose-500/30 disabled:opacity-50"
                          >
                            Remove
                          </button>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          )}

          {activeView === 'shifts' && (
            <div>
              <h2 className="text-2xl font-bold">Shifts</h2>
              <p className="mt-2 text-sm text-neutral-400">
                Live login/logout status for staff and carers, total worked hours in last 24 hours,
                and reward cut controls.
              </p>

              <div className="mt-5 grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
                {shiftsRows.map((row) => (
                  <article
                    key={`${row.role}:${row.uid}`}
                    className="rounded-2xl border border-white/10 bg-black/30 p-4"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="text-base font-semibold text-white">
                          {row.role === 'staff' ? 'Staff' : 'Carer'} Account
                        </p>
                        <p className="text-xs uppercase tracking-wide text-neutral-500">
                          {row.username || 'User'}
                        </p>
                      </div>
                      <span
                        className={`rounded-full px-2.5 py-1 text-xs font-semibold ${
                          row.isActive
                            ? 'bg-emerald-500/20 text-emerald-200'
                            : 'bg-neutral-700/50 text-neutral-200'
                        }`}
                      >
                        {row.isActive ? 'Logged in' : 'Logged out'}
                      </span>
                    </div>

                    <dl className="mt-3 space-y-1 text-sm text-neutral-300">
                      <div className="flex justify-between gap-3">
                        <dt>Last login</dt>
                        <dd className="text-right">{formatDateTime(row.latestLoginAt)}</dd>
                      </div>
                      <div className="flex justify-between gap-3">
                        <dt>Last logout</dt>
                        <dd className="text-right">{formatDateTime(row.latestLogoutAt)}</dd>
                      </div>
                      <div className="flex justify-between gap-3">
                        <dt>Last seen</dt>
                        <dd className="text-right">{formatDateTime(row.lastSeenAt)}</dd>
                      </div>
                      <div className="flex justify-between gap-3">
                        <dt>Worked (24h)</dt>
                        <dd className="text-right font-semibold text-cyan-200">
                          {formatHours(row.workedHoursLast24h)}
                        </dd>
                      </div>
                      <div className="flex justify-between gap-3">
                        <dt>Current reward</dt>
                        <dd className="text-right font-semibold text-amber-200">
                          {formatNprDisplay(row.cashBoxNpr)}
                        </dd>
                      </div>
                    </dl>

                    <div className="mt-4 rounded-xl border border-rose-500/25 bg-rose-500/5 p-3">
                      <p className="text-xs font-semibold uppercase tracking-wide text-rose-200/90">
                        Cut reward
                      </p>
                      <input
                        type="number"
                        min={1}
                        value={rewardCutAmountByUid[row.uid] || ''}
                        onChange={(e) =>
                          setRewardCutAmountByUid((prev) => ({
                            ...prev,
                            [row.uid]: e.target.value,
                          }))
                        }
                        placeholder="Amount (NPR)"
                        className="mt-2 w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-white outline-none ring-cyan-400/40 placeholder:text-neutral-500 focus:ring-2"
                      />
                      <input
                        type="text"
                        value={rewardCutReasonByUid[row.uid] || ''}
                        onChange={(e) =>
                          setRewardCutReasonByUid((prev) => ({
                            ...prev,
                            [row.uid]: e.target.value,
                          }))
                        }
                        placeholder="Reason (optional)"
                        className="mt-2 w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-white outline-none ring-cyan-400/40 placeholder:text-neutral-500 focus:ring-2"
                      />
                      <button
                        type="button"
                        disabled={rewardCutBusyUid === row.uid}
                        onClick={() =>
                          void handleCutRewardForWorker({
                            uid: row.uid,
                            username: row.username,
                            role: row.role,
                          })
                        }
                        className="mt-2 min-h-[44px] w-full rounded-xl bg-rose-500 px-3 py-2 text-sm font-semibold text-white hover:bg-rose-400 disabled:opacity-60"
                      >
                        {rewardCutBusyUid === row.uid ? 'Applying…' : 'Apply Cut'}
                      </button>
                    </div>
                  </article>
                ))}
              </div>

              {shiftsRows.length === 0 && (
                <p className="mt-6 text-sm text-neutral-500">No staff or carer accounts found.</p>
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
              messagesScrollRef={coadminChatScrollRef}
              hasMoreOlderMessages={pagedCoadminChat.hasMoreOlder}
              loadingOlderMessages={pagedCoadminChat.loadingOlder}
              onLoadOlderMessages={pagedCoadminChat.loadOlder}
              onSelectUser={handleReachOutUserSelect}
              onMessageChange={setNewMessage}
              onSendMessage={handleSendMessage}
              onImageSelect={handleImageSelect}
              onClearImage={handleClearImage}
              onlineByUid={coadminOnlineByUid}
              nameMode="coadmin"
            />
          )}
      </RoleSidebarLayout>

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
