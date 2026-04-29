'use client';

import '../../styles/player-fire.css';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { AnimatePresence, motion } from 'motion/react';
import { onAuthStateChanged, signOut } from 'firebase/auth';
import { doc, getDoc, onSnapshot, updateDoc } from 'firebase/firestore';
import imageCompression from 'browser-image-compression';

import ProtectedRoute from '../../components/auth/ProtectedRoute';
import ReachOutView from '../../components/admin/ReachOutView';
import ImageUploadField from '@/components/common/ImageUploadField';

import { auth, db } from '@/lib/firebase/client';
import { belongsToCoadmin, resolveCoadminUid } from '@/lib/coadmin/scope';
import { getStaff } from '@/features/users/adminUsers';
import {
  getPlayerGameLoginsByPlayer,
  PlayerGameLogin,
} from '@/features/games/playerGameLogins';
import {
  createPlayerGameRequest,
  dismissPlayerRedeemRequest,
  listenToPlayerGameRequestsByPlayer,
  PlayerGameRequest,
} from '@/features/games/playerGameRequests';
import {
  listenToUnreadCounts,
  markConversationAsRead,
  sendChatMessage,
  sendImageMessage,
} from '@/features/messages/chatMessages';
import { usePaginatedChatMessages } from '@/features/messages/usePaginatedChatMessages';
import {
  createCoinLoadSession,
  deleteCoinLoadSession,
  getSessionExpiresAtMs,
  type CoinLoadSession,
} from '@/features/coinLoad/coinLoadSession';
import {
  createPlayerCredentialTask,
  getCompletedUsernameCarersByPlayer,
  sendCarerCashboxInquiryAlert,
} from '@/features/games/carerTasks';
import {
  createPlayerCashoutTask,
  getPlayerCashoutPaymentDisplay,
  listenPlayerCashoutTasksByPlayer,
  type PlayerCashoutTask,
} from '@/features/cashouts/playerCashoutTasks';
import {
  BonusEvent,
  getBonusEventsForPlayerDisplay,
  initiateBonusEventPlay,
  listenBonusEventsByCoadmin,
  MAX_PLAYER_BONUS_EVENTS_DISPLAY,
} from '../../features/bonusEvents/bonusEvents';
import {
  createCashToCoinTransferRequest,
  listenTransferRequestsByPlayer,
} from '@/features/risk/playerRisk';
import { usePresenceOnlineMap } from '@/features/presence/userPresence';
import {
  claimMyReferralReward,
  fetchMyReferralRewards,
  type ReferralRewardGroup,
} from '@/features/referrals/playerReferralRewards';

import { AdminUser, ChatMessage } from '../../components/admin/types';

type PlayerView =
  | 'dashboard'
  | 'play'
  | 'bonus-events'
  | 'agents'
  | 'usernames'
  | 'earn-coins';

type PlayerWallet = {
  coin: number;
  cash: number;
};

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

function formatDateTime(value: unknown) {
  const timestampMs = getTimestampMs(value);

  if (!timestampMs) {
    return 'Not available';
  }

  return new Date(timestampMs).toLocaleString();
}

function getPlayerBonusEventDescription(description: string | null | undefined) {
  const normalizedDescription = description?.trim();

  if (
    normalizedDescription ===
    'Auto-generated co-admin bonus event to maintain active event capacity.'
  ) {
    return null;
  }

  return normalizedDescription || null;
}

function getRequestStatusLabel(status: PlayerGameRequest['status']) {
  if (status === 'completed') {
    return 'Completed';
  }
  if (status === 'failed') {
    return 'Failed';
  }
  if (status === 'pending_review') {
    return 'Pending review';
  }
  return 'Pending';
}

function getRequestStatusClass(status: PlayerGameRequest['status']) {
  if (status === 'completed') {
    return 'bg-emerald-500/20 text-emerald-200';
  }
  if (status === 'failed') {
    return 'bg-rose-500/20 text-rose-200';
  }
  if (status === 'pending_review') {
    return 'bg-sky-500/20 text-sky-200';
  }

  return 'bg-amber-500/20 text-amber-200';
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

/** Cap for request history list (20–30 range). */
const MAX_REQUEST_HISTORY_DISPLAY = 30;

/** Full-screen player overlays: consistent splash look (blur + glass). */
const PLAYER_SPLASH_BACKDROP =
  'fixed inset-0 flex items-end justify-center bg-black/80 px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-10 backdrop-blur-xl sm:items-center sm:px-4 sm:pb-0';
const PLAYER_SPLASH_BACKDROP_CENTER =
  'fixed inset-0 flex items-center justify-center bg-black/82 p-4 backdrop-blur-xl';
const PLAYER_SPLASH_CARD =
  'w-full max-w-md rounded-3xl border border-amber-400/25 bg-gradient-to-b from-[#121018] via-zinc-950/98 to-black p-6 shadow-2xl shadow-amber-500/10 sm:rounded-3xl sm:p-7';
const PLAYER_SPLASH_CARD_WIDE =
  'w-full max-w-lg rounded-3xl border border-amber-400/25 bg-gradient-to-b from-[#121018] via-zinc-950/98 to-black p-6 shadow-2xl shadow-amber-500/10 sm:max-w-2xl sm:p-7';
const BONUS_ROTATE_MS = 7500;
const CASINO_BACKGROUND_TRACKS = ['/theme3.mp3'] as const;
const PLAYER_MUSIC_STORAGE_KEY = 'playerBackgroundMusicEnabled';
const DEFAULT_PLAYER_MUSIC_VOLUME = 0.3;
const PLAYER_HELP_HINT_MESSAGE =
  'Press Play to get your game recharged, and click Menu to see more offers.';
const ACTIVE_TABLE_SPLASH_HISTORY_KEY = '__playerActiveTableSplash';

function normalizeGameKey(gameName: string) {
  return gameName.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_');
}

const UNKNOWN_CREATOR_FILTER_KEY = '__unknown_creator__';

function buildCreatorDisplayLabel(data: { role?: string; username?: string } | undefined) {
  if (!data) {
    return 'Unknown Creator';
  }

  const role = String(data.role || '').toLowerCase();

  if (role === 'staff') {
    return 'Staff Team';
  }

  if (role === 'coadmin') {
    return 'Coadmin Team';
  }

  if (role === 'carer') {
    return 'Carer Team';
  }

  return 'Unknown Creator';
}

type PlayerAlertInfo = {
  variant: 'index' | 'permission' | 'lowCoin' | 'generic';
  title: string;
  body: string;
  raw: string;
};

function getPlayerAlertInfo(raw: string): PlayerAlertInfo | null {
  const text = raw.trim();

  if (!text) {
    return null;
  }

  const lower = text.toLowerCase();

  if (
    (lower.includes('index') || lower.includes('indexes')) &&
    (lower.includes('firestore') ||
      lower.includes('failed_precondition') ||
      lower.includes('create_composite') ||
      lower.includes('composite'))
  ) {
    return {
      variant: 'index',
      title: 'Setup needed: Firestore index required',
      body: 'An index must be created in the Firebase console before this data can load. Share the console link from the technical details with your admin.',
      raw: text,
    };
  }

  if (
    lower.includes('permission') ||
    lower.includes('permissions') ||
    lower.includes('insufficient permissions')
  ) {
    return {
      variant: 'permission',
      title: 'Access restricted',
      body: 'Your account may not have permission for this action. If this is unexpected, contact support.',
      raw: text,
    };
  }

  if (
    lower.includes('not enough coin') ||
    lower.includes('insufficient coin') ||
    (lower.includes('recharge') &&
      (lower.includes('add coin first') || lower.includes('low coin')))
  ) {
    return {
      variant: 'lowCoin',
      title: 'Not enough coin for recharge',
      body: text,
      raw: text,
    };
  }

  return {
    variant: 'generic',
    title: 'Notice',
    body: text,
    raw: text,
  };
}

// Legacy helper retained only to avoid a broad page rewrite in this pass.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function FloatingCasinoBackdrop() {
  return (
    <div
      className="pointer-events-none fixed inset-0 z-0 overflow-hidden"
      aria-hidden
    >
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_120%_80%_at_50%_-20%,rgba(168,85,247,0.22),transparent),radial-gradient(ellipse_80%_50%_at_100%_50%,rgba(234,179,8,0.12),transparent),radial-gradient(ellipse_60%_40%_at_0%_80%,rgba(220,38,38,0.1),transparent)]" />
      <div
        className="absolute -left-10 top-[15%] text-4xl opacity-[0.12] sm:text-5xl"
        aria-hidden
      >
        🪙
      </div>
      <div
        className="absolute right-[5%] top-[25%] text-3xl opacity-[0.1] sm:text-4xl"
        aria-hidden
      >
        💎
      </div>
      <div
        className="absolute bottom-[20%] left-[20%] text-3xl opacity-[0.08]"
        aria-hidden
      >
        🎰
      </div>
      <div className="absolute inset-0 bg-[linear-gradient(180deg,transparent_0%,rgba(0,0,0,0.4)_100%)]" />
    </div>
  );
}

const NAV_ITEMS: {
  label: string;
  view: PlayerView;
  icon: string;
  emoji: string;
}[] = [
  { label: 'Lobby', view: 'dashboard', icon: 'tachometer-alt', emoji: '🏠' },
  { label: 'Play', view: 'play', icon: 'dice-d6', emoji: '🎰' },
  { label: 'Bonus', view: 'bonus-events', icon: 'gift', emoji: '🎁' },
  { label: 'Earn Coins', view: 'earn-coins', icon: 'coins', emoji: '🪙' },
  { label: 'Agents', view: 'agents', icon: 'headset', emoji: '💬' },
  { label: 'Vault', view: 'usernames', icon: 'user-secret', emoji: '🔐' },
];

export default function PlayerPage() {
  const router = useRouter();
  const [activeView, setActiveView] = useState<PlayerView>('dashboard');
  const [playerUid, setPlayerUid] = useState('');

  const [agents, setAgents] = useState<AdminUser[]>([]);
  const [selectedAgent, setSelectedAgent] = useState<AdminUser | null>(null);

  const [gameLogins, setGameLogins] = useState<PlayerGameLogin[]>([]);
  const [bonusEvents, setBonusEvents] = useState<BonusEvent[]>([]);
  const [usernameCarersByGame, setUsernameCarersByGame] = useState<Record<string, string[]>>({});
  const [creatorNames, setCreatorNames] = useState<Record<string, string>>({});
  const [selectedCreatorUid, setSelectedCreatorUid] = useState<string | null>(null);
  const [playerCoadminUid, setPlayerCoadminUid] = useState('');
  const [visiblePasswords, setVisiblePasswords] = useState<Record<string, boolean>>({});

  const [selectedGameName, setSelectedGameName] = useState('');
  const [playAmount, setPlayAmount] = useState('');
  const [requestLoading, setRequestLoading] = useState(false);
  const [playRequestSplash, setPlayRequestSplash] = useState<null | {
    type: 'recharge' | 'redeem';
    gameName: string;
    amountText: string;
  }>(null);
  const [showActiveTableSplash, setShowActiveTableSplash] = useState(false);
  const [coinLoading, setCoinLoading] = useState(false);
  const [requestHistory, setRequestHistory] = useState<PlayerGameRequest[]>([]);
  const [dismissRedeemLoadingId, setDismissRedeemLoadingId] = useState<string | null>(null);
  const [isBlockedPlayer, setIsBlockedPlayer] = useState(false);
  const [wallet, setWallet] = useState<PlayerWallet>({ coin: 0, cash: 0 });
  const [referralCode, setReferralCode] = useState('');
  const [referredByPlayerName, setReferredByPlayerName] = useState('');
  const [referredByPlayerUid, setReferredByPlayerUid] = useState('');
  const [referralRewardGroups, setReferralRewardGroups] = useState<ReferralRewardGroup[]>([]);
  const [referralRewardsLoading, setReferralRewardsLoading] = useState(false);
  const [claimingReferredPlayerUid, setClaimingReferredPlayerUid] = useState<string | null>(null);
  const [earnedRewardSplashCoins, setEarnedRewardSplashCoins] = useState<number | null>(null);
  const [showCashoutModal, setShowCashoutModal] = useState(false);
  const [showCoinConfirmSplash, setShowCoinConfirmSplash] = useState(false);
  const [transferCoinAmountInput, setTransferCoinAmountInput] = useState('');
  const [showLoadCoinPanel, setShowLoadCoinPanel] = useState(false);
  const [activeCoinLoad, setActiveCoinLoad] = useState<CoinLoadSession | null>(null);
  const [loadCoinTimeLeftSec, setLoadCoinTimeLeftSec] = useState(0);
  const [coinLoadBusy, setCoinLoadBusy] = useState(false);
  const [cashoutPayoutMethod, setCashoutPayoutMethod] = useState<'qr' | 'app'>('qr');
  const [cashoutQrUrl, setCashoutQrUrl] = useState('');
  const [cashoutAppName, setCashoutAppName] = useState('');
  const [cashoutCashTag, setCashoutCashTag] = useState('');
  const [cashoutAccountName, setCashoutAccountName] = useState('');
  const [playerCashoutTasks, setPlayerCashoutTasks] = useState<PlayerCashoutTask[]>([]);
  const [cashoutLoading, setCashoutLoading] = useState(false);
  const [showCashoutSuccessSplash, setShowCashoutSuccessSplash] = useState(false);
  const [showCashoutInquiryPanel, setShowCashoutInquiryPanel] = useState(false);
  const [cashoutInquiryMessage, setCashoutInquiryMessage] = useState('');
  const [sendingCashoutInquiry, setSendingCashoutInquiry] = useState(false);
  const [activatingBonusEventId, setActivatingBonusEventId] = useState<string | null>(null);
  const [bonusErrorSplashMessage, setBonusErrorSplashMessage] = useState('');
  const [credentialTaskLoadingKey, setCredentialTaskLoadingKey] = useState<string | null>(
    null
  );
  const [credentialResetModal, setCredentialResetModal] = useState<null | {
    gameLogin: PlayerGameLogin;
    taskType: 'reset_password' | 'recreate_username';
  }>(null);

  const [newMessage, setNewMessage] = useState('');
  const [unreadCounts, setUnreadCounts] = useState<Record<string, number>>({});
  const agentsScrollRef = useRef<HTMLDivElement>(null);

  const [selectedImage, setSelectedImage] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [sendingImage, setSendingImage] = useState(false);

  const pageScrollRef = useRef<HTMLElement | null>(null);
  const previousUnreadRef = useRef(0);
  const pagedAgentChat = usePaginatedChatMessages(selectedAgent?.uid ?? null, {
    scrollContainerRef: agentsScrollRef,
    onWindowMessages: () => {
      if (selectedAgent) {
        markConversationAsRead(selectedAgent.uid);
      }
    },
  });
  const messages: ChatMessage[] = useMemo(() => {
    const currentUser = auth.currentUser;
    if (!currentUser) {
      return [];
    }
    return pagedAgentChat.items.map((msg) => ({
      id: msg.id,
      text: msg.text,
      imageUrl: msg.imageUrl,
      sender: msg.senderUid === currentUser.uid ? 'admin' : 'user',
      timestamp: msg.createdAt?.toDate?.() || new Date(),
    }));
  }, [pagedAgentChat.items]);
  const hasSeenCashoutTaskSnapshotRef = useRef(false);
  const knownCompletedCashoutTaskIdsRef = useRef<Set<string>>(new Set());
  const cashoutSplashSeenIdsRef = useRef<Set<string>>(new Set());
  const knownCashoutStatusByIdRef = useRef<Record<string, string>>({});
  const transferResponseSeenRef = useRef<Set<string>>(new Set());
  const referralCodeEnsureInFlightRef = useRef(false);
  const lastSyncedRequestTotalsRef = useRef<string | null>(null);

  const [message, setMessage] = useState('');
  const [loadingList, setLoadingList] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [showPlayerHelpHint, setShowPlayerHelpHint] = useState(false);
  const [musicEnabled, setMusicEnabled] = useState(() => {
    if (typeof window === 'undefined') {
      return false;
    }

    try {
      return window.localStorage.getItem(PLAYER_MUSIC_STORAGE_KEY) === 'true';
    } catch {
      return false;
    }
  });
  const [bonusCarouselIndex, setBonusCarouselIndex] = useState(0);
  const [bonusStripPaused, setBonusStripPaused] = useState(false);
  const [showLogoutConfirmSplash, setShowLogoutConfirmSplash] = useState(false);
  const [logoutLoading, setLogoutLoading] = useState(false);
  const [bonusVanishedToast, setBonusVanishedToast] = useState(false);
  const bonusSwipeStartXRef = useRef<number | null>(null);
  const activeTableHistoryOpenRef = useRef(false);
  const showActiveTableSplashRef = useRef(false);
  const activeTableSplashContentRef = useRef<HTMLDivElement | null>(null);
  const activeTableAmountInputRef = useRef<HTMLInputElement | null>(null);
  const [activeTableKeyboardInset, setActiveTableKeyboardInset] = useState(0);
  const [activeTableViewportHeight, setActiveTableViewportHeight] = useState<number | null>(null);
  const playerHelpHintSeenRef = useRef(false);
  const playerHelpHintHideTimeoutRef = useRef<number | null>(null);
  const playerHelpHintIdleTimeoutRef = useRef<number | null>(null);

  function hasActiveTableSplashHistoryState() {
    const state = window.history.state as Record<string, unknown> | null;
    return Boolean(state?.[ACTIVE_TABLE_SPLASH_HISTORY_KEY]);
  }

  function openActiveTableSplash() {
    if (!activeTableHistoryOpenRef.current) {
      window.history.pushState(
        {
          ...(window.history.state || {}),
          [ACTIVE_TABLE_SPLASH_HISTORY_KEY]: true,
        },
        ''
      );
      activeTableHistoryOpenRef.current = true;
    }
    setShowActiveTableSplash(true);
  }

  function closeActiveTableSplash(options?: { fromPopState?: boolean }) {
    setShowActiveTableSplash(false);
    if (!options?.fromPopState && hasActiveTableSplashHistoryState()) {
      activeTableHistoryOpenRef.current = false;
      window.history.back();
    }
  }

  function nudgeActiveTableForKeyboard() {
    if (typeof window === 'undefined') {
      return;
    }
    window.setTimeout(() => {
      activeTableAmountInputRef.current?.scrollIntoView({
        block: 'center',
        behavior: 'smooth',
      });
    }, 120);
  }

  useEffect(() => {
    showActiveTableSplashRef.current = showActiveTableSplash;
  }, [showActiveTableSplash]);

  const clearPlayerHelpHintHideTimeout = useCallback(() => {
    if (playerHelpHintHideTimeoutRef.current !== null) {
      window.clearTimeout(playerHelpHintHideTimeoutRef.current);
      playerHelpHintHideTimeoutRef.current = null;
    }
  }, []);

  const clearPlayerHelpHintIdleTimeout = useCallback(() => {
    if (playerHelpHintIdleTimeoutRef.current !== null) {
      window.clearTimeout(playerHelpHintIdleTimeoutRef.current);
      playerHelpHintIdleTimeoutRef.current = null;
    }
  }, []);

  const showPlayerHelpHintToast = useCallback(() => {
    playerHelpHintSeenRef.current = true;
    clearPlayerHelpHintHideTimeout();
    setShowPlayerHelpHint(true);
    playerHelpHintHideTimeoutRef.current = window.setTimeout(() => {
      setShowPlayerHelpHint(false);
      playerHelpHintHideTimeoutRef.current = null;
    }, 5000);
  }, [clearPlayerHelpHintHideTimeout]);

  const schedulePlayerHelpHintOnIdle = useCallback(() => {
    clearPlayerHelpHintIdleTimeout();
    playerHelpHintIdleTimeoutRef.current = window.setTimeout(() => {
      showPlayerHelpHintToast();
      playerHelpHintIdleTimeoutRef.current = null;
    }, 60000);
  }, [clearPlayerHelpHintIdleTimeout, showPlayerHelpHintToast]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    showPlayerHelpHintToast();
    schedulePlayerHelpHintOnIdle();

    const handlePlayerActivity = () => {
      setShowPlayerHelpHint(false);
      clearPlayerHelpHintHideTimeout();
      schedulePlayerHelpHintOnIdle();
    };

    const options: AddEventListenerOptions = { passive: true };
    window.addEventListener('pointerdown', handlePlayerActivity, options);
    window.addEventListener('keydown', handlePlayerActivity, options);
    window.addEventListener('touchstart', handlePlayerActivity, options);

    return () => {
      window.removeEventListener('pointerdown', handlePlayerActivity);
      window.removeEventListener('keydown', handlePlayerActivity);
      window.removeEventListener('touchstart', handlePlayerActivity);
      clearPlayerHelpHintHideTimeout();
      clearPlayerHelpHintIdleTimeout();
    };
  }, [
    clearPlayerHelpHintHideTimeout,
    clearPlayerHelpHintIdleTimeout,
    schedulePlayerHelpHintOnIdle,
    showPlayerHelpHintToast,
  ]);

  useEffect(() => {
    if (typeof document === 'undefined') {
      return;
    }

    const pageNode = pageScrollRef.current;
    const bodyStyle = document.body.style;
    const docStyle = document.documentElement.style;
    const previousBodyOverflow = bodyStyle.overflow;
    const previousDocOverflow = docStyle.overflow;
    const previousPageOverflowY = pageNode?.style.overflowY ?? '';
    const previousPageTouchAction = pageNode?.style.touchAction ?? '';

    if (mobileMenuOpen) {
      bodyStyle.overflow = 'hidden';
      docStyle.overflow = 'hidden';
      if (pageNode) {
        pageNode.style.overflowY = 'hidden';
        pageNode.style.touchAction = 'none';
      }
    }

    return () => {
      bodyStyle.overflow = previousBodyOverflow;
      docStyle.overflow = previousDocOverflow;
      if (pageNode) {
        pageNode.style.overflowY = previousPageOverflowY;
        pageNode.style.touchAction = previousPageTouchAction;
      }
    };
  }, [mobileMenuOpen]);

  useEffect(() => {
    const onPopState = () => {
      if (!showActiveTableSplashRef.current && !activeTableHistoryOpenRef.current) {
        return;
      }
      activeTableHistoryOpenRef.current = false;
      closeActiveTableSplash({ fromPopState: true });
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  useEffect(() => {
    if (!showActiveTableSplash) {
      setActiveTableKeyboardInset(0);
      setActiveTableViewportHeight(null);
      return;
    }
    if (typeof window === 'undefined') {
      return;
    }

    const vv = window.visualViewport;
    if (!vv) {
      return;
    }

    const updateViewportMetrics = () => {
      const viewportHeight = Math.round(vv.height);
      const keyboardInset = Math.max(
        0,
        Math.round(window.innerHeight - (vv.height + vv.offsetTop))
      );
      setActiveTableViewportHeight(viewportHeight);
      setActiveTableKeyboardInset(keyboardInset);
    };

    updateViewportMetrics();
    vv.addEventListener('resize', updateViewportMetrics);
    vv.addEventListener('scroll', updateViewportMetrics);
    window.addEventListener('orientationchange', updateViewportMetrics);

    return () => {
      vv.removeEventListener('resize', updateViewportMetrics);
      vv.removeEventListener('scroll', updateViewportMetrics);
      window.removeEventListener('orientationchange', updateViewportMetrics);
    };
  }, [showActiveTableSplash]);
  const selfClaimedBonusIdRef = useRef<string | null>(null);
  const lastBonusIdsRef = useRef<string[]>([]);
  const musicEnabledRef = useRef(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const currentTrackRef = useRef<string | null>(null);
  const playRandomTrackRef = useRef<((previousTrack?: string | null) => Promise<void>) | null>(null);
  const interactionListenerCleanupRef = useRef<null | (() => void)>(null);
  const autoplayRetryTimeoutRef = useRef<number | null>(null);

  const formatWalletAmount = useCallback((value: number) => {
    return new Intl.NumberFormat('en-US').format(value);
  }, []);

  const totalUnread = agents.reduce((total, agent) => {
    return total + (unreadCounts[agent.uid] || 0);
  }, 0);
  const agentPresenceUids = useMemo(() => agents.map((a) => a.uid), [agents]);
  const agentOnlineByUid = usePresenceOnlineMap(agentPresenceUids);
  const playerBonusEvents = useMemo(
    () => getBonusEventsForPlayerDisplay(bonusEvents),
    [bonusEvents]
  );
  const shouldListenToBonusEvents =
    Boolean(playerCoadminUid) && activeView === 'bonus-events';

  const activeBonusCarouselIndex = useMemo(() => {
    if (playerBonusEvents.length === 0) {
      return 0;
    }

    return Math.min(bonusCarouselIndex, Math.max(0, playerBonusEvents.length - 1));
  }, [bonusCarouselIndex, playerBonusEvents.length]);

  const lastUsedQrCashout = useMemo(() => {
    return playerCashoutTasks
      .map((task) => ({ task, payment: getPlayerCashoutPaymentDisplay(task) }))
      .find(({ payment }) => payment.method === 'qr' && payment.qrImageUrl);
  }, [playerCashoutTasks]);

  const lastUsedAppCashout = useMemo(() => {
    return playerCashoutTasks
      .map((task) => ({ task, payment: getPlayerCashoutPaymentDisplay(task) }))
      .find(
        ({ payment }) =>
          payment.method === 'app' &&
          payment.paymentAppName &&
          payment.paymentAppCashTag &&
          payment.paymentAppAccountName
      );
  }, [playerCashoutTasks]);

  useEffect(() => {
    const len = playerBonusEvents.length;
    if (len <= 1 || bonusStripPaused) {
      return;
    }
    const intervalId = window.setInterval(() => {
      setBonusCarouselIndex((i) => (i + 1) % len);
    }, BONUS_ROTATE_MS);
    return () => window.clearInterval(intervalId);
  }, [playerBonusEvents.length, bonusStripPaused]);

  useEffect(() => {
    const nextIds = playerBonusEvents.map((e) => e.id);
    const previous = lastBonusIdsRef.current;
    if (previous.length > 0) {
      for (const id of previous) {
        if (!nextIds.includes(id)) {
          if (selfClaimedBonusIdRef.current === id) {
            selfClaimedBonusIdRef.current = null;
          } else {
            setBonusVanishedToast(true);
            window.setTimeout(() => setBonusVanishedToast(false), 4500);
          }
          break;
        }
      }
    }
    lastBonusIdsRef.current = nextIds;
  }, [playerBonusEvents]);

  const displayedRequestHistory = useMemo(
    () => requestHistory.slice(0, MAX_REQUEST_HISTORY_DISPLAY),
    [requestHistory]
  );
  const requestTotals = useMemo(() => {
    return requestHistory.reduce(
      (acc, request) => {
        const amount = Math.max(0, Number(request.amount || 0));
        if (request.type === 'recharge') {
          acc.rechargeAmount += amount;
          acc.rechargeCount += 1;
        } else if (request.type === 'redeem') {
          acc.redeemAmount += amount;
          acc.redeemCount += 1;
        }
        return acc;
      },
      {
        rechargeAmount: 0,
        redeemAmount: 0,
        rechargeCount: 0,
        redeemCount: 0,
      }
    );
  }, [requestHistory]);

  const usernamesCreatorFilterKeys = useMemo(() => {
    const uidSet = new Set<string>();
    let hasMissingCreator = false;

    for (const login of gameLogins) {
      const uid = String(login.createdBy || '').trim();
      if (uid) {
        uidSet.add(uid);
      } else {
        hasMissingCreator = true;
      }
    }

    const sortedUids = [...uidSet].sort((left, right) =>
      (creatorNames[left] || left).localeCompare(creatorNames[right] || right)
    );

    return { sortedUids, hasMissingCreator };
  }, [gameLogins, creatorNames]);

  const usernamesVisibleLogins = useMemo(() => {
    if (!selectedCreatorUid) {
      return gameLogins;
    }

    if (selectedCreatorUid === UNKNOWN_CREATOR_FILTER_KEY) {
      return gameLogins.filter((login) => !String(login.createdBy || '').trim());
    }

    return gameLogins.filter(
      (login) => String(login.createdBy || '').trim() === selectedCreatorUid
    );
  }, [gameLogins, selectedCreatorUid]);

  const playerAlert = useMemo(() => getPlayerAlertInfo(message), [message]);

  const chooseRandomTrack = useCallback((previousTrack?: string | null) => {
    if (CASINO_BACKGROUND_TRACKS.length <= 1) {
      return CASINO_BACKGROUND_TRACKS[0];
    }

    const eligibleTracks = CASINO_BACKGROUND_TRACKS.filter((track) => track !== previousTrack);
    return eligibleTracks[Math.floor(Math.random() * eligibleTracks.length)] || CASINO_BACKGROUND_TRACKS[0];
  }, []);

  const clearInteractionListener = useCallback(() => {
    interactionListenerCleanupRef.current?.();
    interactionListenerCleanupRef.current = null;
  }, []);

  const clearAutoplayRetry = useCallback(() => {
    if (autoplayRetryTimeoutRef.current !== null) {
      window.clearTimeout(autoplayRetryTimeoutRef.current);
      autoplayRetryTimeoutRef.current = null;
    }
  }, []);

  const cleanupAudioElement = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) {
      return;
    }

    audio.pause();
    audio.onended = null;
    audio.onerror = null;
    audio.src = '';
    audioRef.current = null;
  }, []);

  const playCurrentAudio = useCallback(async () => {
    const audio = audioRef.current;
    if (!audio || !musicEnabledRef.current) {
      return false;
    }

    try {
      audio.volume = DEFAULT_PLAYER_MUSIC_VOLUME;
      await audio.play();
      clearInteractionListener();
      clearAutoplayRetry();
      return true;
    } catch {
      return false;
    }
  }, [clearAutoplayRetry, clearInteractionListener]);

  const attachInteractionListener = useCallback(() => {
    if (interactionListenerCleanupRef.current || typeof window === 'undefined') {
      return;
    }

    const handleInteraction = () => {
      void playCurrentAudio();
    };

    const options: AddEventListenerOptions = { passive: true };
    window.addEventListener('pointerdown', handleInteraction, options);
    window.addEventListener('keydown', handleInteraction, options);
    interactionListenerCleanupRef.current = () => {
      window.removeEventListener('pointerdown', handleInteraction);
      window.removeEventListener('keydown', handleInteraction);
    };
  }, [playCurrentAudio]);

  const playRandomTrack = useCallback(
    async (previousTrack?: string | null) => {
      if (!musicEnabledRef.current) {
        return;
      }

      clearAutoplayRetry();
      cleanupAudioElement();

      const nextTrack = chooseRandomTrack(previousTrack ?? currentTrackRef.current);
      const audio = new Audio(nextTrack);
      audio.volume = DEFAULT_PLAYER_MUSIC_VOLUME;
      audio.preload = 'auto';
      audio.onended = () => {
        void playRandomTrackRef.current?.(nextTrack);
      };
      audio.onerror = () => {
        clearAutoplayRetry();
        autoplayRetryTimeoutRef.current = window.setTimeout(() => {
          autoplayRetryTimeoutRef.current = null;
          void playRandomTrackRef.current?.(nextTrack);
        }, 1200);
      };

      audioRef.current = audio;
      currentTrackRef.current = nextTrack;

      const didPlay = await playCurrentAudio();
      if (!didPlay) {
        attachInteractionListener();
      }
    },
    [
      attachInteractionListener,
      chooseRandomTrack,
      cleanupAudioElement,
      clearAutoplayRetry,
      playCurrentAudio,
    ]
  );
  useEffect(() => {
    playRandomTrackRef.current = playRandomTrack;
  }, [playRandomTrack]);

  async function copyCredentialValue(value: string, label: string) {
    const clean = value.trim();

    if (!clean) {
      setMessage(`Nothing to copy for ${label}.`);
      return;
    }

    try {
      await navigator.clipboard.writeText(clean);
      setMessage(`${label} copied to clipboard.`);
    } catch {
      setMessage('Could not copy. Select and copy manually.');
    }
  }

  async function handleCopyReferralCode() {
    const code = referralCode.trim();
    if (!code) {
      setMessage('Referral code is not available yet.');
      return;
    }

    try {
      await navigator.clipboard.writeText(code);
      setMessage('Referral code copied.');
    } catch {
      setMessage('Could not copy referral code.');
    }
  }

  async function ensureCurrentPlayerReferralCode(currentPlayerUid: string) {
    if (!currentPlayerUid || referralCodeEnsureInFlightRef.current) {
      return;
    }

    const playerRef = doc(db, 'users', currentPlayerUid);
    const playerSnap = await getDoc(playerRef);
    if (!playerSnap.exists()) {
      return;
    }

    const existingCode = String(
      (playerSnap.data() as { referralCode?: string }).referralCode || ''
    ).trim();
    if (/^\d{6,10}$/.test(existingCode)) {
      setReferralCode(existingCode);
    }

    referralCodeEnsureInFlightRef.current = true;
    try {
      const currentUser = auth.currentUser;
      if (!currentUser) {
        return;
      }
      const token = await currentUser.getIdToken();
      const res = await fetch('/api/player/ensure-referral-code', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = (await res.json()) as {
        success?: boolean;
        referralCode?: string;
        error?: string;
      };
      if (data.success && data.referralCode) {
        setReferralCode(String(data.referralCode).trim());
      } else if (data.error) {
        console.warn('Referral code ensure failed:', data.error);
      }
    } catch (error) {
      console.error(error);
    } finally {
      referralCodeEnsureInFlightRef.current = false;
    }
  }

  const playNotificationSound = useCallback(() => {
    const audio = new Audio('/urgency-sound.mp3');
    audio.volume = 0.6;
    void audio.play().catch(() => undefined);
  }, []);

  useEffect(() => {
    musicEnabledRef.current = musicEnabled;

    try {
      window.localStorage.setItem(PLAYER_MUSIC_STORAGE_KEY, String(musicEnabled));
    } catch {
      // Ignore storage write failures.
    }

    if (!musicEnabled) {
      clearInteractionListener();
      clearAutoplayRetry();
      if (audioRef.current) {
        audioRef.current.pause();
      }
      return;
    }

    if (audioRef.current) {
      void playCurrentAudio();
      return;
    }

    void playRandomTrack(currentTrackRef.current);
  }, [
    clearAutoplayRetry,
    clearInteractionListener,
    musicEnabled,
    playCurrentAudio,
    playRandomTrack,
  ]);

  useEffect(() => {
    return () => {
      clearInteractionListener();
      clearAutoplayRetry();
      cleanupAudioElement();
    };
  }, [cleanupAudioElement, clearAutoplayRetry, clearInteractionListener]);

  const loadAgents = useCallback(async () => {
    try {
      const currentUser = auth.currentUser;

      if (!currentUser) {
        return;
      }

      const playerSnap = await getDoc(doc(db, 'users', currentUser.uid));

      if (!playerSnap.exists()) {
        setAgents([]);
        return;
      }

      const playerData = playerSnap.data();
      const coadminUid = resolveCoadminUid({
        uid: currentUser.uid,
        ...(playerData as Record<string, unknown>),
      });

      if (!coadminUid) {
        setAgents([]);
        return;
      }

      const allStaff = await getStaff();
      const relatedStaff = allStaff.filter((staff) =>
        belongsToCoadmin(staff, String(coadminUid))
      );

      setAgents(relatedStaff);
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : 'Failed to load agents.'
      );
    }
  }, []);

  const loadPlayerUsernames = useCallback(async (currentPlayerUid: string) => {
    setLoadingList(true);
    setMessage('');
    setSelectedCreatorUid(null);

    try {
      const [list, carerMapping] = await Promise.all([
        getPlayerGameLoginsByPlayer(currentPlayerUid),
        getCompletedUsernameCarersByPlayer(currentPlayerUid),
      ]);
      const sorted = sortByNewest(list);
      setGameLogins(sorted);
      setUsernameCarersByGame(carerMapping);

      const creatorUids = [
        ...new Set(
          sorted
            .map((login) => String(login.createdBy || '').trim())
            .filter(Boolean)
        ),
      ];
      const nameEntries = await Promise.all(
        creatorUids.map(async (uid) => {
          try {
            const snap = await getDoc(doc(db, 'users', uid));
            if (!snap.exists()) {
              return [uid, 'Unknown Creator'] as const;
            }
            const userData = snap.data() as { role?: string; username?: string };
            return [uid, buildCreatorDisplayLabel(userData)] as const;
          } catch {
            return [uid, 'Unknown Creator'] as const;
          }
        })
      );
      const nextCreatorNames: Record<string, string> = {};
      for (const [uid, label] of nameEntries) {
        nextCreatorNames[uid] = label;
      }
      setCreatorNames(nextCreatorNames);
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : 'Failed to load usernames.'
      );
    } finally {
      setLoadingList(false);
    }
  }, []);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      const nextPlayerUid = user?.uid || '';
      setPlayerUid(nextPlayerUid);

      if (!nextPlayerUid) {
        setIsBlockedPlayer(false);
        setWallet({ coin: 0, cash: 0 });
        setPlayerCoadminUid('');
        setShowCashoutSuccessSplash(false);
        hasSeenCashoutTaskSnapshotRef.current = false;
        knownCompletedCashoutTaskIdsRef.current = new Set();
        cashoutSplashSeenIdsRef.current = new Set();
        knownCashoutStatusByIdRef.current = {};
        setAgents([]);
        setGameLogins([]);
        setBonusEvents([]);
        setUsernameCarersByGame({});
        setCreatorNames({});
        setSelectedCreatorUid(null);
        setRequestHistory([]);
        return;
      }

      try {
        const playerSnap = await getDoc(doc(db, 'users', nextPlayerUid));
        const playerData = playerSnap.data() as
          | { status?: string; coin?: number; cash?: number }
          | undefined;
        setIsBlockedPlayer(playerData?.status === 'disabled');
        setWallet({
          coin: Number(playerData?.coin || 0),
          cash: Number(playerData?.cash || 0),
        });
        const resolvedCoadminUid = resolveCoadminUid({
          uid: nextPlayerUid,
          ...(playerData as Record<string, unknown>),
        });
        setPlayerCoadminUid(resolvedCoadminUid ? String(resolvedCoadminUid) : '');
      } catch {
        setIsBlockedPlayer(false);
        setWallet({ coin: 0, cash: 0 });
        setPlayerCoadminUid('');
        setBonusEvents([]);
        setUsernameCarersByGame({});
      }
    });

    return () => unsubscribe();
  }, []);

  useEffect(() => {
    const unsubscribe = listenToUnreadCounts(setUnreadCounts);
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    if (totalUnread > previousUnreadRef.current) {
      playNotificationSound();
    }

    previousUnreadRef.current = totalUnread;
  }, [playNotificationSound, totalUnread]);

  useEffect(() => {
    if (!playerUid) return;

    const loaderTimeoutId = window.setTimeout(() => {
      void loadAgents();
      void loadPlayerUsernames(playerUid);
    }, 0);

    const unsubscribeRequests = listenToPlayerGameRequestsByPlayer(
      playerUid,
      (requests) => {
        setRequestHistory(sortByNewest(requests));
      },
      (error) => {
        setMessage(error.message || 'Failed to load request history.');
      }
    );

    return () => {
      window.clearTimeout(loaderTimeoutId);
      unsubscribeRequests();
    };
  }, [loadAgents, loadPlayerUsernames, playerUid]);

  useEffect(() => {
    if (!playerUid) {
      return;
    }

    const splashSeenStorageKey = `playerCashoutSplashSeen:${playerUid}`;
    try {
      const raw = window.sessionStorage.getItem(splashSeenStorageKey);
      const parsed = raw ? (JSON.parse(raw) as string[]) : [];
      cashoutSplashSeenIdsRef.current = new Set(
        Array.isArray(parsed) ? parsed.filter(Boolean) : []
      );
    } catch {
      cashoutSplashSeenIdsRef.current = new Set();
    }

    const unsubscribe = listenPlayerCashoutTasksByPlayer(
      playerUid,
      (tasks) => {
        setPlayerCashoutTasks(tasks);
        const completedTasks = tasks.filter((task) => task.status === 'completed');
        const recentCompletionCutoffMs = Date.now() - 5 * 60 * 1000;

        const nextStatusById: Record<string, string> = {};
        const newlyCompleted = completedTasks.filter((task) => {
          const previousStatus = knownCashoutStatusByIdRef.current[task.id];
          const completedAtMs = getTimestampMs(task.completedAt);
          const recentlyCompleted = completedAtMs >= recentCompletionCutoffMs;
          nextStatusById[task.id] = task.status;
          return (
            !cashoutSplashSeenIdsRef.current.has(task.id) &&
            ((previousStatus !== undefined && previousStatus !== 'completed') ||
              (previousStatus === undefined && recentlyCompleted))
          );
        });

        tasks.forEach((task) => {
          if (!nextStatusById[task.id]) {
            nextStatusById[task.id] = task.status;
          }
        });

        if (newlyCompleted.length > 0) {
          setShowCashoutSuccessSplash(true);
          newlyCompleted.forEach((task) => {
            cashoutSplashSeenIdsRef.current.add(task.id);
          });
          try {
            window.sessionStorage.setItem(
              splashSeenStorageKey,
              JSON.stringify([...cashoutSplashSeenIdsRef.current])
            );
          } catch {
            // Ignore storage write issues and continue UI flow.
          }
        }

        hasSeenCashoutTaskSnapshotRef.current = true;
        knownCompletedCashoutTaskIdsRef.current = new Set(
          completedTasks.map((task) => task.id)
        );
        knownCashoutStatusByIdRef.current = nextStatusById;
      },
      (error) => {
        setMessage(error.message || 'Failed to confirm cashout completion.');
      }
    );

    return () => unsubscribe();
  }, [playerUid]);

  useEffect(() => {
    if (!playerUid) {
      return;
    }

    const totalsSignature = JSON.stringify({
      playerUid,
      rechargeAmount: Math.round(requestTotals.rechargeAmount),
      redeemAmount: Math.round(requestTotals.redeemAmount),
      rechargeCount: requestTotals.rechargeCount,
      redeemCount: requestTotals.redeemCount,
    });

    if (lastSyncedRequestTotalsRef.current === totalsSignature) {
      return;
    }

    lastSyncedRequestTotalsRef.current = totalsSignature;

    void updateDoc(doc(db, 'users', playerUid), {
      totalRechargeAmount: Math.round(requestTotals.rechargeAmount),
      totalRedeemAmount: Math.round(requestTotals.redeemAmount),
      totalRechargeCount: requestTotals.rechargeCount,
      totalRedeemCount: requestTotals.redeemCount,
      rechargeRedeemTotalsUpdatedAt: new Date(),
    }).catch(() => {
      lastSyncedRequestTotalsRef.current = null;
      // Non-blocking metrics sync.
    });
  }, [playerUid, requestTotals]);

  useEffect(() => {
    if (!referredByPlayerUid || referredByPlayerName) {
      return;
    }
    let cancelled = false;
    void getDoc(doc(db, 'users', referredByPlayerUid))
      .then((snap) => {
        if (!snap.exists() || cancelled) {
          return;
        }
        const username = String((snap.data() as { username?: string }).username || '').trim();
        if (username) {
          setReferredByPlayerName(username);
        }
      })
      .catch(() => {
        // Best-effort fallback for legacy users.
      });
    return () => {
      cancelled = true;
    };
  }, [referredByPlayerUid, referredByPlayerName]);

  useEffect(() => {
    if (!playerCoadminUid || !shouldListenToBonusEvents) {
      setBonusEvents([]);
      return;
    }

    console.log('[player bonusEvents] coadminUid', playerCoadminUid);
    console.log('[player bonusEvents] listener:start');
    const unsubscribe = listenBonusEventsByCoadmin(
      playerCoadminUid,
      (events) => {
        console.log('[player bonusEvents] render-values', {
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
      },
      (error) => {
        console.error('[player bonusEvents] error', error);
        setMessage(error.message || 'Failed to load bonus events.');
      },
      {
        skipTimeWindowFilter: true,
        onSnapshotDebug: ({ snapshotSize, firstDocData }) => {
          console.log('[player bonusEvents] snapshot size', snapshotSize);
          console.log('[player bonusEvents] first doc', firstDocData);
        },
      }
    );

    return () => {
      console.info('[player] bonus-events-listener:stop', {
        playerCoadminUid,
        activeView,
      });
      unsubscribe();
    };
  }, [activeView, playerCoadminUid, shouldListenToBonusEvents]);

  useEffect(() => {
    if (!playerUid) {
      return;
    }

    transferResponseSeenRef.current = new Set();
    const unsubscribe = onSnapshot(
      doc(db, 'users', playerUid),
      (snapshot) => {
        if (!snapshot.exists()) {
          setWallet({ coin: 0, cash: 0 });
          setIsBlockedPlayer(false);
          return;
        }

        const playerData = snapshot.data() as {
          status?: string;
          coin?: number;
          cash?: number;
          referralCode?: string;
          referredByUid?: string;
          referredByUsername?: string;
          referralBonusNotice?: string;
          referralBonusNoticeAt?: unknown;
        };

        setWallet({
          coin: Number(playerData.coin || 0),
          cash: Number(playerData.cash || 0),
        });
        const nextReferralCode = String(playerData.referralCode || '').trim();
        if (/^\d{6,10}$/.test(nextReferralCode)) {
          setReferralCode(nextReferralCode);
        } else {
          setReferralCode('');
          void ensureCurrentPlayerReferralCode(playerUid);
        }
        setReferredByPlayerName(String(playerData.referredByUsername || '').trim());
        setReferredByPlayerUid(String(playerData.referredByUid || '').trim());
        setIsBlockedPlayer(playerData.status === 'disabled');

        const referralNotice = String(playerData.referralBonusNotice || '').trim();
        const noticeTimestamp = getTimestampMs(playerData.referralBonusNoticeAt);
        if (referralNotice && noticeTimestamp > 0) {
          const noticeKey = `playerReferralNoticeSeen:${playerUid}:${noticeTimestamp}`;
          const hasSeen = window.sessionStorage.getItem(noticeKey) === '1';
          if (!hasSeen) {
            setMessage('Your referral was successful. Referral bonus has been added.');
            window.sessionStorage.setItem(noticeKey, '1');
          }
        }
      },
      () => {
        setWallet({ coin: 0, cash: 0 });
        setReferralCode('');
        setReferredByPlayerName('');
        setReferredByPlayerUid('');
      }
    );

    return () => unsubscribe();
  }, [playerUid]);

  useEffect(() => {
    if (!playerUid) {
      return;
    }

    const unsubscribe = listenTransferRequestsByPlayer(
      playerUid,
      (requests) => {
        const latestProcessed = requests.find((request) => request.status !== 'pending');
        if (!latestProcessed) {
          return;
        }
        if (transferResponseSeenRef.current.has(latestProcessed.id)) {
          return;
        }

        transferResponseSeenRef.current.add(latestProcessed.id);
        if (latestProcessed.status === 'approved') {
          setMessage('Transfer approved and converted to coin.');
          return;
        }
        setMessage(latestProcessed.rejectionReason || 'Transfer denied due to suspected misuse.');
      },
      () => {
        // Silent fail to avoid interrupting gameplay flow.
      }
    );

    return () => unsubscribe();
  }, [playerUid]);

  const loadReferralRewards = useCallback(async () => {
    if (!playerUid) {
      setReferralRewardGroups([]);
      setReferralRewardsLoading(false);
      return;
    }
    setReferralRewardsLoading(true);
    try {
      const groups = await fetchMyReferralRewards();
      setReferralRewardGroups(groups);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Failed to load referral rewards.');
    } finally {
      setReferralRewardsLoading(false);
    }
  }, [playerUid]);

  async function handleClaimReferralReward(referredPlayerUid: string) {
    if (!referredPlayerUid || claimingReferredPlayerUid) {
      return;
    }
    setClaimingReferredPlayerUid(referredPlayerUid);
    setMessage('');
    try {
      const result = await claimMyReferralReward(referredPlayerUid);
      setMessage(
        result.message ||
          "Congratulations! You received referral reward coins from this player's recharge."
      );
      setEarnedRewardSplashCoins(Math.max(0, Number(result.rewardCoins || 0)));
      await loadReferralRewards();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Failed to claim referral reward.');
    } finally {
      setClaimingReferredPlayerUid(null);
    }
  }

  useEffect(() => {
    if (activeView !== 'earn-coins') {
      return;
    }
    void loadReferralRewards();
  }, [activeView, loadReferralRewards]);

  useEffect(() => {
    if (activeView === 'agents' && playerUid) {
      const nextTimeoutId = window.setTimeout(() => {
        void loadAgents();
      }, 0);
      return () => window.clearTimeout(nextTimeoutId);
    }

    if (
      playerUid &&
      (
        activeView === 'usernames' ||
        activeView === 'play' ||
        activeView === 'dashboard' ||
        activeView === 'bonus-events'
      )
    ) {
      const nextTimeoutId = window.setTimeout(() => {
        void loadPlayerUsernames(playerUid);
      }, 0);
      return () => window.clearTimeout(nextTimeoutId);
    }
  }, [activeView, loadAgents, loadPlayerUsernames, playerUid]);

  useEffect(() => {
    if (activeView !== 'play') {
      closeActiveTableSplash();
    }
    if (activeView !== 'usernames') {
      setCredentialResetModal(null);
    }
  }, [activeView]);

  async function handleGameRequest(type: 'recharge' | 'redeem') {
    if (isBlockedPlayer) {
      setMessage(
        'Your account is blocked. Recharge and redeem requests are disabled.'
      );
      return;
    }

    const amountNum = Number(playAmount);
    if (type === 'recharge') {
      if (!Number.isFinite(amountNum) || amountNum <= 0) {
        setMessage('Enter a valid amount.');
        return;
      }
      const uid = auth.currentUser?.uid;
      if (uid) {
        const liveSnap = await getDoc(doc(db, 'users', uid));
        if (liveSnap.exists()) {
          const liveCoin = Number(
            (liveSnap.data() as { coin?: number }).coin || 0
          );
          setWallet((w) => ({ ...w, coin: liveCoin }));
          if (liveCoin < amountNum) {
            setMessage(
              'Not enough coin to send a recharge. Add coin first — for example use “Transfer all cash to coin” when you have cash, or use a lower amount.'
            );
            return;
          }
        }
      } else if (amountNum > wallet.coin) {
        setMessage(
          'Not enough coin to send a recharge. Add coin first — for example use “Transfer all cash to coin” when you have cash, or use a lower amount.'
        );
        return;
      }
    }

    closeActiveTableSplash();
    setPlayRequestSplash({
      type,
      gameName: selectedGameName,
      amountText: String(playAmount),
    });
    setRequestLoading(true);
    setMessage('');

    try {
      await createPlayerGameRequest({
        gameName: selectedGameName,
        amount: Number(playAmount),
        type,
      });

      setMessage(`${type === 'recharge' ? 'Recharge' : 'Redeem'} request sent.`);
      setPlayAmount('');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Request failed.');
    } finally {
      setRequestLoading(false);
      setPlayRequestSplash(null);
    }
  }

  async function handleDismissRedeemRequest(request: PlayerGameRequest) {
    setDismissRedeemLoadingId(request.id);
    setMessage('');

    try {
      await dismissPlayerRedeemRequest(request.id);
      setMessage('Redeem request dismissed.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Failed to dismiss redeem request.');
    } finally {
      setDismissRedeemLoadingId(null);
    }
  }

  function openCredentialResetModal(
    gameLogin: PlayerGameLogin,
    taskType: 'reset_password' | 'recreate_username'
  ) {
    setCredentialResetModal({ gameLogin, taskType });
  }

  async function executeCredentialResetTask(
    gameLogin: PlayerGameLogin,
    taskType: 'reset_password' | 'recreate_username'
  ) {
    const loadingKey = `${taskType}:${gameLogin.id}`;
    setCredentialTaskLoadingKey(loadingKey);
    setMessage('');

    try {
      await createPlayerCredentialTask({
        taskType,
        playerUid: gameLogin.playerUid,
        playerUsername: gameLogin.playerUsername || 'Player',
        gameName: gameLogin.gameName,
        coadminUid: gameLogin.coadminUid,
      });

      setMessage(
        taskType === 'reset_password'
          ? 'Reset password task created successfully.'
          : 'Recreate username task created successfully.'
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Failed to create task.');
    } finally {
      setCredentialTaskLoadingKey(null);
    }
  }

  async function confirmCredentialResetModal() {
    if (!credentialResetModal) {
      return;
    }
    const { gameLogin, taskType } = credentialResetModal;
    setCredentialResetModal(null);
    await executeCredentialResetTask(gameLogin, taskType);
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
    } catch (error) {
      console.error(error);
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

  async function handleSendMessage(event: React.FormEvent) {
    event.preventDefault();

    if (!selectedAgent) {
      return;
    }

    try {
      if (selectedImage) {
        setSendingImage(true);
        await sendImageMessage(selectedAgent.uid, selectedImage);
        handleClearImage();
      }

      if (newMessage.trim()) {
        await sendChatMessage(selectedAgent.uid, newMessage);
        setNewMessage('');
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Failed to send message.');
    } finally {
      setSendingImage(false);
    }
  }

  function handleAgentSelect(agent: AdminUser) {
    setSelectedAgent(agent);
    setNewMessage('');
    handleClearImage();
    markConversationAsRead(agent.uid);
  }

  function handleOpenFirstUnreadAgent() {
    const unreadAgent =
      agents.find((agent) => (unreadCounts[agent.uid] || 0) > 0) || null;

    setActiveView('agents');

    if (unreadAgent) {
      handleAgentSelect(unreadAgent);
    }
  }

  function handleChangeView(view: PlayerView) {
    setActiveView(view);
    setMobileMenuOpen(false);
    setMessage('');
    setSelectedAgent(null);
    setNewMessage('');
    handleClearImage();
    // Player page scrolls inside its own container, not only the window.
    requestAnimationFrame(() => {
      pageScrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  }

  function togglePassword(loginId: string) {
    setVisiblePasswords((previous) => ({
      ...previous,
      [loginId]: !previous[loginId],
    }));
  }

  async function handleCoinButtonClick() {
    if (!playerUid) {
      setMessage('Player profile not loaded yet.');
      return;
    }

    const parsedAmount = Number(transferCoinAmountInput);
    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
      setMessage('Enter a valid transfer amount.');
      return;
    }
    if (parsedAmount > Number(wallet.cash || 0)) {
      setMessage('Transfer amount cannot exceed your cash balance.');
      return;
    }

    setCoinLoading(true);
    setMessage('');

    try {
      const result = await createCashToCoinTransferRequest(playerUid, parsedAmount);
      setMessage(result.message);
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : 'Failed to submit transfer request.'
      );
    } finally {
      setCoinLoading(false);
    }
  }

  async function handlePlayerCashoutRequest() {
    if (!playerCoadminUid) {
      setMessage('Coadmin not found for this player.');
      return;
    }

    const composedPaymentDetails =
      cashoutPayoutMethod === 'qr'
        ? cashoutQrUrl.trim()
          ? `Payout method: QR\nQR image: ${cashoutQrUrl.trim()}`
          : ''
        : [
            'Payout method: Payment app',
            cashoutAppName.trim() ? `App name: ${cashoutAppName.trim()}` : '',
            cashoutCashTag.trim() ? `Cash tag: ${cashoutCashTag.trim()}` : '',
            cashoutAccountName.trim() ? `Name on app: ${cashoutAccountName.trim()}` : '',
          ]
            .filter(Boolean)
            .join('\n');

    if (!composedPaymentDetails) {
      setMessage(
        cashoutPayoutMethod === 'qr'
          ? 'Upload your QR before sending cashout.'
          : 'Enter your payment app name, cash tag, and name on the app.'
      );
      return;
    }

    if (
      cashoutPayoutMethod === 'app' &&
      (!cashoutAppName.trim() || !cashoutCashTag.trim() || !cashoutAccountName.trim())
    ) {
      setMessage('Enter your payment app name, cash tag, and name on the app.');
      return;
    }

    setCashoutLoading(true);
    setMessage('');

    try {
      await createPlayerCashoutTask({
        coadminUid: playerCoadminUid,
        paymentDetails: composedPaymentDetails,
        payoutMethod: cashoutPayoutMethod,
        qrImageUrl: cashoutPayoutMethod === 'qr' ? cashoutQrUrl.trim() : '',
        paymentAppName: cashoutPayoutMethod === 'app' ? cashoutAppName.trim() : '',
        paymentAppCashTag: cashoutPayoutMethod === 'app' ? cashoutCashTag.trim() : '',
        paymentAppAccountName:
          cashoutPayoutMethod === 'app' ? cashoutAccountName.trim() : '',
      });

      setMessage('Cashout request sent. Waiting for confirmation.');
      setShowCashoutModal(false);
      setCashoutPayoutMethod('qr');
      setCashoutQrUrl('');
      setCashoutAppName('');
      setCashoutCashTag('');
      setCashoutAccountName('');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Failed to create cashout request.');
    } finally {
      setCashoutLoading(false);
    }
  }

  async function handleActivateBonusEvent(bonusEvent: BonusEvent) {
    if (!playerUid) {
      setMessage('Player profile not loaded yet.');
      return;
    }

    setActivatingBonusEventId(bonusEvent.id);
    setMessage('');

    try {
      await initiateBonusEventPlay({
        playerUid,
        bonusEventId: bonusEvent.id,
      });
      selfClaimedBonusIdRef.current = bonusEvent.id;
      setMessage(
        `Bonus "${bonusEvent.bonusName}" started. Coins deducted and recharge task created automatically.`
      );
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Failed to activate bonus event.';
      const lower = errorMessage.toLowerCase();
      if (
        lower.includes('low coin') ||
        lower.includes('already') ||
        lower.includes('no longer available') ||
        lower.includes('blocked')
      ) {
        setBonusErrorSplashMessage(errorMessage);
      } else {
        setMessage(errorMessage);
      }
    } finally {
      setActivatingBonusEventId(null);
    }
  }

  async function performLogout() {
    setLogoutLoading(true);
    setMessage('');
    try {
      await signOut(auth);
      setShowLogoutConfirmSplash(false);
      router.replace('/login');
    } catch (err) {
      setMessage(
        err instanceof Error ? err.message : 'Could not sign out. Try again.'
      );
    } finally {
      setLogoutLoading(false);
    }
  }

  async function handleSendCashoutInquiry() {
    if (!playerCoadminUid) {
      setMessage('Coadmin not found for this player.');
      return;
    }

    const cleanMessage = cashoutInquiryMessage.trim();

    if (cleanMessage.length < 8) {
      setMessage('Please write a clear inquiry message (at least 8 characters).');
      return;
    }

    setSendingCashoutInquiry(true);
    setMessage('');

    try {
      await sendCarerCashboxInquiryAlert({
        coadminUid: playerCoadminUid,
        message: cleanMessage,
      });
      setMessage('Inquiry sent to coadmin and staff.');
      setCashoutInquiryMessage('');
      setShowCashoutInquiryPanel(false);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Failed to send inquiry.');
    } finally {
      setSendingCashoutInquiry(false);
    }
  }

  useEffect(() => {
    if (!activeCoinLoad) {
      setLoadCoinTimeLeftSec(0);
      return;
    }
    const exp = getSessionExpiresAtMs(activeCoinLoad);
    const sessionId = activeCoinLoad.id;
    const tick = () => {
      const left = Math.max(0, Math.ceil((exp - Date.now()) / 1000));
      setLoadCoinTimeLeftSec(left);
      if (left <= 0) {
        void deleteCoinLoadSession(sessionId)
          .catch(() => undefined)
          .finally(() => {
            setActiveCoinLoad((prev) => (prev?.id === sessionId ? null : prev));
            setShowLoadCoinPanel(false);
            setMessage('Payment code expired. Request a new one if you still need to pay.');
          });
        return true;
      }
      return false;
    };
    if (tick()) {
      return;
    }
    const id = setInterval(() => {
      if (tick()) {
        clearInterval(id);
      }
    }, 1000);
    return () => clearInterval(id);
  }, [activeCoinLoad]);

  async function handleCreateCoinLoadSession() {
    if (!playerCoadminUid) {
      setMessage('No co-admin is linked to your account yet.');
      return;
    }
    if (isBlockedPlayer) {
      setMessage('Your account is restricted. Contact an agent for help with payments.');
      return;
    }
    setCoinLoadBusy(true);
    setMessage('');
    try {
      const s = await createCoinLoadSession(playerCoadminUid);
      setActiveCoinLoad(s);
    } catch (e) {
      setMessage(
        e instanceof Error ? e.message : 'Could not create payment code. Try again or contact an agent.'
      );
    } finally {
      setCoinLoadBusy(false);
    }
  }

  function formatLoadCoinCountdown(totalSec: number) {
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  // Kept for possible reuse outside the Play view while the Play panel no longer renders it.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  function renderRequestHistory() {
    return (
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35 }}
        className="mt-6 rounded-3xl border border-amber-400/25 bg-black/40 p-4 shadow-[0_0_40px_-10px_rgba(234,179,8,0.35)] backdrop-blur-xl sm:p-6"
      >
        <div className="mb-5">
          <h3 className="flex items-center gap-2 text-xl font-black bg-gradient-to-r from-amber-200 via-yellow-300 to-amber-400 bg-clip-text text-transparent sm:text-2xl">
            <span aria-hidden>📜</span> Request History
          </h3>
          <p className="mt-2 text-xs text-amber-100/55 sm:text-sm">
            Showing up to {MAX_REQUEST_HISTORY_DISPLAY} most recent recharge and redeem
            requests.
          </p>
        </div>

        {displayedRequestHistory.length === 0 ? (
          <p className="text-sm text-amber-100/40">No recharge or redeem requests yet.</p>
        ) : (
          <div className="space-y-4">
            {displayedRequestHistory.map((request) => {
              const canDismissRedeem =
                request.type === 'redeem' && request.status === 'pending';

              return (
                <motion.div
                  key={request.id}
                  layout
                  className="group rounded-2xl border border-white/10 bg-gradient-to-br from-white/[0.07] to-transparent p-4 shadow-lg transition-all active:scale-[0.99] sm:p-5 sm:hover:border-amber-400/35 sm:hover:shadow-[0_0_24px_-8px_rgba(234,179,8,0.4)]"
                >
                  <div className="flex flex-wrap items-start justify-between gap-4">
                    <div className="flex-1">
                      <div className="flex flex-wrap items-center gap-2 mb-2">
                        <span className={`rounded-full px-3 py-1 text-xs font-bold uppercase shadow-md ${
                          request.type === 'recharge' 
                            ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30' 
                            : 'bg-rose-500/20 text-rose-300 border border-rose-500/30'
                        }`}>
                          <i className={`fas fa-${request.type === 'recharge' ? 'arrow-down' : 'arrow-up'} mr-1 text-xs`}></i>
                          {request.type}
                        </span>
                        <span
                          className={`rounded-full px-3 py-1 text-xs font-bold ${getRequestStatusClass(
                            request.status
                          )}`}
                        >
                          {getRequestStatusLabel(request.status)}
                        </span>
                      </div>

                      <h4 className="text-xl font-black text-white tracking-wide">
                        {request.gameName}
                      </h4>
                      <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
                        <p className="text-amber-100/60">Amount: <span className="text-white font-bold">${formatWalletAmount(Number(request.amount || 0))}</span></p>
                        <p className="text-amber-100/60">Requested: <span className="text-white">{formatDateTime(request.createdAt)}</span></p>
                        <p className="text-amber-100/60">Completed: <span className="text-white">{formatDateTime(request.completedAt)}</span></p>
                      </div>
                    </div>

                    <div className="flex flex-wrap gap-2">
                      {canDismissRedeem && (
                        <button
                          type="button"
                          onClick={() => void handleDismissRedeemRequest(request)}
                          disabled={dismissRedeemLoadingId === request.id}
                          className="rounded-xl bg-white/10 px-4 py-2 text-xs font-bold text-white hover:bg-white/20 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {dismissRedeemLoadingId === request.id ? 'Dismissing...' : 'Dismiss'}
                        </button>
                      )}
                    </div>
                  </div>
                </motion.div>
              );
            })}
            {requestHistory.length > MAX_REQUEST_HISTORY_DISPLAY && (
              <p className="pt-2 text-center text-xs text-amber-100/40">
                {requestHistory.length - MAX_REQUEST_HISTORY_DISPLAY} older request
                {requestHistory.length - MAX_REQUEST_HISTORY_DISPLAY === 1 ? '' : 's'} not shown in this list.
              </p>
            )}
          </div>
        )}
      </motion.div>
    );
  }

  function renderNavButton(
    item: (typeof NAV_ITEMS)[number],
    unread: number,
    onNavigate: () => void
  ) {
    const isActive = activeView === item.view;

    return (
      <button
        key={item.view}
        type="button"
        onClick={onNavigate}
        className={`group flex w-full items-center justify-between rounded-2xl px-4 py-3 text-left text-[0.98rem] font-bold transition-all duration-200 active:scale-[0.98] lg:text-[1.05rem] ${
          isActive
            ? 'bg-gradient-to-r from-amber-400 via-yellow-500 to-amber-500 text-black shadow-[0_0_28px_-4px_rgba(234,179,8,0.65)]'
            : 'border border-white/10 bg-white/[0.04] text-amber-100/85 hover:border-amber-400/35 hover:bg-amber-500/10 hover:text-white'
        }`}
      >
        <span className="flex min-w-0 items-center gap-3">
          <span className="text-lg" aria-hidden>
            {item.emoji}
          </span>
          <span className="truncate">
            <i
              className={`fas fa-${item.icon} mr-2 w-4 ${
                isActive ? 'text-black' : 'text-amber-400/80'
              }`}
            ></i>
            {item.label}
          </span>
        </span>

        {unread > 0 && (
          <span className="flex h-6 min-w-[24px] shrink-0 items-center justify-center rounded-full bg-red-500 px-1.5 text-[10px] font-black text-white shadow-lg ring-2 ring-black/30">
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>
    );
  }

  return (
    <ProtectedRoute allowedRoles={['player']}>
      <main
        ref={pageScrollRef}
        className="player-fire-page relative z-0 flex min-h-[100dvh] flex-col overflow-y-auto overflow-x-hidden bg-transparent pb-[calc(5.25rem+env(safe-area-inset-bottom))] text-white lg:flex-row lg:pb-0"
      >
        <div className="ember-overlay" aria-hidden="true" />
        {showPlayerHelpHint && (
          <div className="pointer-events-none fixed left-1/2 top-1/2 z-50 w-[min(92vw,560px)] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-amber-400/25 bg-black/55 px-4 py-3 text-center text-xs font-semibold text-amber-100/80 shadow-[0_0_24px_-10px_rgba(251,191,36,0.65)] backdrop-blur-xl">
            {PLAYER_HELP_HINT_MESSAGE}
          </div>
        )}

        <header className="fire-panel fire-orange sticky top-0 z-30 shrink-0 border-b border-amber-500/20 bg-black/65 px-3 py-2.5 backdrop-blur-2xl lg:hidden">
          <div className="flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={() => setMobileMenuOpen(true)}
            className="flex min-h-[44px] min-w-[72px] items-center justify-center rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 text-sm font-black uppercase tracking-wide text-amber-100"
            aria-label="Open menu"
          >
            ☰ Menu
          </button>
          <div className="rounded-xl border border-amber-400/30 bg-black/35 px-3 py-1.5 text-center shadow-[0_0_20px_-10px_rgba(251,191,36,0.75)]">
            <p className="text-[10px] font-black uppercase tracking-[0.32em] text-amber-300/95">
              Royal VIP
            </p>
            <p className="mt-0.5 bg-gradient-to-r from-white via-amber-100 to-amber-300 bg-clip-text text-base font-black leading-tight text-transparent drop-shadow-[0_0_10px_rgba(251,191,36,0.35)]">
              Casino
            </p>
          </div>
          <div className="max-w-[42%] text-right text-sm leading-tight">
            <p className="font-bold text-amber-200">
              🪙 {formatWalletAmount(wallet.coin)}
            </p>
            <p className="font-bold text-emerald-300">
              💵 {formatWalletAmount(wallet.cash)}
            </p>
          </div>
          </div>

          <div className="mt-2 grid grid-cols-3 gap-2">
            <button
              type="button"
              onClick={() => handleChangeView('play')}
              className="fire-button fire-orange min-h-[48px] scale-[1.04] rounded-xl border border-red-200/80 bg-gradient-to-r from-red-500 via-red-400 to-rose-500 px-2 text-sm font-black text-white shadow-[0_0_34px_-6px_rgba(239,68,68,0.9)] transition-transform hover:scale-[1.1] hover:brightness-110 active:scale-[1.03]"
            >
              🎰 Play
            </button>
            <button
              type="button"
              onClick={() => setShowCashoutModal(true)}
              disabled={wallet.cash <= 0 || isBlockedPlayer}
              className="fire-button fire-green min-h-[40px] rounded-xl border border-cyan-400/35 bg-cyan-500/15 px-2 text-sm font-bold text-cyan-100 disabled:opacity-50"
            >
              💸 Cashout
            </button>
            <button
              type="button"
              onClick={() => {
                setTransferCoinAmountInput(String(Math.max(0, Number(wallet.cash || 0))));
                setShowCoinConfirmSplash(true);
              }}
              disabled={coinLoading}
              className="fire-button fire-orange min-h-[40px] rounded-xl border border-emerald-400/35 bg-emerald-500/15 px-2 text-sm font-bold text-emerald-100 disabled:opacity-50"
            >
              {coinLoading ? '⏳' : '🪙 To coin'}
            </button>
          </div>
        </header>

        <button
          type="button"
          onClick={() => setMusicEnabled((previous) => !previous)}
          className="fixed bottom-[calc(5.75rem+env(safe-area-inset-bottom))] right-3 z-40 min-h-[44px] rounded-full border border-amber-400/35 bg-black/70 px-4 py-2 text-sm font-black uppercase tracking-wide text-amber-100 shadow-[0_0_24px_-10px_rgba(234,179,8,0.7)] backdrop-blur-xl transition hover:border-amber-300/60 hover:bg-black/80 lg:bottom-4 lg:right-4"
          aria-pressed={musicEnabled}
          aria-label={musicEnabled ? 'Turn music off' : 'Turn music on'}
        >
          {musicEnabled ? 'Music On' : 'Music Off'}
        </button>

        <AnimatePresence>
          {mobileMenuOpen ? (
            <>
              <motion.button
                type="button"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                aria-label="Close menu"
                className="fixed inset-0 z-40 bg-black/75 backdrop-blur-md lg:hidden"
                onClick={() => setMobileMenuOpen(false)}
              />
              <motion.aside
                initial={{ opacity: 0, y: -20, scale: 0.98 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -20, scale: 0.98 }}
                transition={{ type: 'spring', damping: 24, stiffness: 280 }}
                className="fixed inset-y-0 left-0 z-50 flex h-screen w-screen max-w-[17.6rem] flex-col overflow-hidden rounded-none rounded-r-3xl border-r border-amber-500/30 bg-[#0a0612]/97 shadow-2xl shadow-purple-900/40 backdrop-blur-2xl lg:hidden"
              >
                <div className="mb-4 border-b border-amber-500/25 bg-gradient-to-br from-[#3f2517] via-[#2a1839] to-[#120f16] px-4 py-5 text-center shadow-[inset_0_-18px_30px_-20px_rgba(251,146,60,0.7)]">
                  <p className="text-xs font-black uppercase tracking-[0.35em] text-amber-300">
                    Jackpot Club
                  </p>
                  <h1 className="mt-1 text-2xl font-black bg-gradient-to-r from-white via-amber-200 to-amber-400 bg-clip-text text-transparent">
                    VIP Lounge
                  </h1>
                </div>
                <div className="flex min-h-0 flex-1 flex-col px-4 pb-4">
                <nav className="space-y-1.5">
                  {NAV_ITEMS.map((item) =>
                    renderNavButton(item, item.view === 'agents' ? totalUnread : 0, () => {
                      if (item.view === 'agents' && totalUnread > 0) {
                        handleOpenFirstUnreadAgent();
                        setMobileMenuOpen(false);
                        return;
                      }
                      handleChangeView(item.view);
                    })
                  )}
                </nav>
                <div className="mt-auto border-t border-amber-500/20 pt-4">
                  <button
                    type="button"
                    onClick={() => {
                      setShowLogoutConfirmSplash(true);
                      setMobileMenuOpen(false);
                    }}
                    className="w-full rounded-2xl border border-rose-500/40 bg-rose-500/10 py-3.5 text-sm font-black text-rose-100 transition hover:bg-rose-500/20"
                  >
                    Log out
                  </button>
                </div>
                </div>
              </motion.aside>
            </>
          ) : null}
        </AnimatePresence>

        <aside className="fire-panel fire-orange relative z-20 hidden w-72 shrink-0 overflow-y-auto border-r border-amber-500/25 bg-black/45 p-5 backdrop-blur-2xl xl:w-80 lg:block">
          <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-amber-500/[0.07] via-transparent to-purple-600/10" />
          <div className="pointer-events-none absolute top-0 left-0 h-40 w-full bg-[radial-gradient(ellipse_at_top,rgba(250,204,21,0.18),transparent_70%)]" />

          <div className="relative z-10">
            <div className="fire-panel fire-orange fire-hero mb-8 rounded-2xl border border-amber-400/35 bg-gradient-to-br from-amber-500/15 to-purple-900/25 p-5 text-center shadow-[0_0_40px_-12px_rgba(234,179,8,0.4)]">
              <p className="text-xs font-black uppercase tracking-[0.4em] text-amber-300">
                Royal
              </p>
              <h1 className="mt-1 text-3xl font-black bg-gradient-to-r from-white via-amber-200 to-amber-400 bg-clip-text text-transparent xl:text-4xl">
                Casino
              </h1>
              <p className="mt-2 text-xs text-amber-200/55">💎 VIP Player Lounge</p>
            </div>

            <nav className="space-y-2">
              {NAV_ITEMS.map((item) =>
                renderNavButton(item, item.view === 'agents' ? totalUnread : 0, () => {
                  if (item.view === 'agents' && totalUnread > 0) {
                    handleOpenFirstUnreadAgent();
                    return;
                  }
                  handleChangeView(item.view);
                })
              )}
            </nav>
            <div className="mt-8">
              <button
                type="button"
                onClick={() => setShowLogoutConfirmSplash(true)}
                className="w-full rounded-2xl border border-rose-500/40 bg-rose-950/40 py-3.5 text-sm font-bold text-rose-100 transition hover:bg-rose-500/15"
              >
                Log out
              </button>
            </div>
          </div>
        </aside>

        <section className="relative z-10 flex min-h-0 flex-1 flex-col lg:min-h-screen">
          <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_15%_0%,rgba(250,204,21,0.09),transparent_40%),radial-gradient(circle_at_90%_15%,rgba(168,85,247,0.12),transparent_35%),radial-gradient(circle_at_50%_100%,rgba(220,38,38,0.06),transparent_45%)]" />
          <div className="pointer-events-none absolute top-0 right-0 h-72 w-72 rounded-full bg-amber-500/10 blur-3xl" />

          <div className="relative z-10 flex min-h-0 flex-1 flex-col">
            <div className="flex min-h-0 flex-1 flex-col overflow-x-hidden px-3 pb-4 pt-4 md:px-7 md:pb-8 md:pt-6">
              {activeView === 'dashboard' ? (
              <>
              <div className="relative z-20 mb-4 hidden shrink-0 flex-wrap items-stretch justify-end gap-3 lg:flex">
                <div className="fire-panel fire-orange rounded-2xl border border-amber-300/60 bg-gradient-to-br from-amber-400/35 to-yellow-500/20 px-5 py-3 text-right shadow-lg shadow-amber-400/25">
                  <div className="flex items-center justify-between gap-3">
                    <span className="inline-flex h-10 w-10 items-center justify-center rounded-xl border border-amber-200/40 bg-amber-200/15 text-2xl shadow-[0_0_18px_rgba(251,191,36,0.35)]">
                      🪙
                    </span>
                    <p className="text-xs font-black uppercase tracking-[0.28em] text-amber-100/90">
                      Coin
                    </p>
                  </div>
                  <p className="mt-1 text-2xl font-black tabular-nums text-white">
                    {formatWalletAmount(wallet.coin)}
                  </p>
                </div>

                <button
                  type="button"
                  onClick={() => {
                    setTransferCoinAmountInput(String(Math.max(0, Number(wallet.cash || 0))));
                    setShowCoinConfirmSplash(true);
                  }}
                  disabled={coinLoading}
                  className="fire-button fire-purple rounded-2xl border border-fuchsia-300/45 bg-gradient-to-r from-fuchsia-600 via-violet-500 to-purple-600 px-5 py-3 text-base font-black text-white shadow-[0_0_26px_-10px_rgba(192,38,211,0.9)] transition-all hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {coinLoading ? '⏳ Transferring…' : '⇄ Transfer Cash → Coin'}
                </button>

                <button
                  type="button"
                  onClick={() => {
                    setShowLoadCoinPanel(true);
                    setMessage('');
                  }}
                  disabled={isBlockedPlayer}
                  className="fire-button fire-orange rounded-2xl border border-amber-400/45 bg-amber-500/20 px-5 py-3 text-base font-black text-amber-50 shadow-md transition-all hover:bg-amber-500/35 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  ⬇ Load coin
                </button>

                <div className="fire-panel fire-green rounded-2xl border border-emerald-300/60 bg-gradient-to-br from-emerald-400/35 to-emerald-700/25 px-5 py-3 text-right shadow-lg shadow-emerald-400/25">
                  <div className="flex items-center justify-between gap-3">
                    <span className="inline-flex h-10 w-10 items-center justify-center rounded-xl border border-emerald-200/40 bg-emerald-200/15 text-2xl shadow-[0_0_18px_rgba(74,222,128,0.35)]">
                      💵
                    </span>
                    <p className="text-xs font-black uppercase tracking-[0.28em] text-emerald-100/90">
                      Cash
                    </p>
                  </div>
                  <p className="mt-1 text-2xl font-black tabular-nums text-white">
                    {formatWalletAmount(wallet.cash)}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setShowCashoutModal(true)}
                  disabled={wallet.cash <= 0 || isBlockedPlayer}
                  className="fire-button fire-orange rounded-2xl border border-amber-400/45 bg-amber-500/20 px-5 py-3 text-base font-black text-amber-50 shadow-md transition-all hover:bg-amber-500/35 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  💸 Cashout
                </button>
                <button
                  type="button"
                  onClick={() => setShowLogoutConfirmSplash(true)}
                  className="rounded-2xl border border-white/15 bg-white/5 px-4 py-3 text-base font-bold text-amber-100/85 transition hover:bg-white/10"
                >
                  Log out
                </button>
              </div>

              <div className="relative z-20 mb-4 grid shrink-0 grid-cols-3 gap-2 lg:hidden">
                <div className="fire-panel fire-orange rounded-2xl border border-amber-300/60 bg-gradient-to-br from-amber-400/35 to-yellow-600/20 p-3 text-center shadow-md shadow-amber-400/20">
                  <span className="mx-auto inline-flex h-9 w-9 items-center justify-center rounded-xl border border-amber-200/40 bg-amber-200/15 text-xl shadow-[0_0_14px_rgba(251,191,36,0.35)]">
                    🪙
                  </span>
                  <p className="mt-1 text-xs font-black uppercase tracking-wider text-amber-100/90">
                    Coin
                  </p>
                  <p className="mt-0.5 text-2xl font-black tabular-nums text-white">
                    {formatWalletAmount(wallet.coin)}
                  </p>
                </div>
                <div className="fire-panel fire-green rounded-2xl border border-emerald-300/60 bg-gradient-to-br from-emerald-400/35 to-emerald-700/20 p-3 text-center shadow-md shadow-emerald-400/20">
                  <span className="mx-auto inline-flex h-9 w-9 items-center justify-center rounded-xl border border-emerald-200/40 bg-emerald-200/15 text-xl shadow-[0_0_14px_rgba(74,222,128,0.35)]">
                    💵
                  </span>
                  <p className="mt-1 text-xs font-black uppercase tracking-wider text-emerald-100/90">
                    Cash
                  </p>
                  <p className="mt-0.5 text-2xl font-black tabular-nums text-white">
                    {formatWalletAmount(wallet.cash)}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setTransferCoinAmountInput(String(Math.max(0, Number(wallet.cash || 0))));
                    setShowCoinConfirmSplash(true);
                  }}
                  disabled={coinLoading}
                  className="fire-button fire-orange min-h-[44px] rounded-2xl border border-amber-400/45 bg-amber-500/20 px-2 py-2 text-xs font-black text-amber-50 active:scale-[0.99] disabled:opacity-60"
                >
                  {coinLoading ? '⏳ Transferring…' : '⇄ Transfer cash to coin'}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setShowLoadCoinPanel(true);
                    setMessage('');
                  }}
                  disabled={isBlockedPlayer}
                  className="fire-button fire-purple min-h-[44px] rounded-2xl border border-fuchsia-300/45 bg-gradient-to-r from-fuchsia-600 via-violet-500 to-purple-600 px-2 py-2 text-xs font-black text-white shadow-[0_0_24px_-12px_rgba(192,38,211,0.95)] active:scale-[0.99] hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  ⬇ Load coin
                </button>
                <button
                  type="button"
                  onClick={() => setShowCashoutModal(true)}
                  disabled={wallet.cash <= 0 || isBlockedPlayer}
                  className="fire-button fire-orange min-h-[44px] rounded-2xl border border-amber-400/45 bg-amber-500/20 px-2 py-2 text-xs font-black text-amber-50 active:scale-[0.99] disabled:opacity-60"
                >
                  💸 Cashout
                </button>
              </div>
              </>
              ) : null}

              {playerAlert ? (
                <motion.div
                  initial={{ opacity: 0, y: -10 }}
                  animate={{ opacity: 1, y: 0 }}
                  className={`fire-panel fire-orange mb-4 rounded-2xl border p-4 shadow-xl backdrop-blur-md sm:p-5 ${
                    playerAlert.variant === 'index'
                      ? 'border-amber-400/50 bg-gradient-to-br from-amber-950/90 via-[#1a1008] to-black/80'
                      : playerAlert.variant === 'permission'
                        ? 'border-rose-400/45 bg-gradient-to-br from-rose-950/85 to-black/80'
                        : playerAlert.variant === 'lowCoin'
                          ? 'border-orange-400/55 bg-gradient-to-br from-orange-950/90 via-[#1a0f08] to-black/85'
                          : 'border-violet-400/40 bg-gradient-to-br from-violet-950/80 to-black/80'
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <h3 className="text-xl font-black text-white">
                      {playerAlert.variant === 'index'
                        ? '⚙️ '
                        : playerAlert.variant === 'lowCoin'
                          ? '🪙 '
                          : '⚠️ '}
                      {playerAlert.title}
                    </h3>
                    <button
                      type="button"
                      onClick={() => setMessage('')}
                      className="shrink-0 rounded-lg border border-white/15 bg-white/5 px-2.5 py-1 text-sm font-bold text-white/80 hover:bg-white/10"
                      aria-label="Dismiss alert"
                    >
                      ✕
                    </button>
                  </div>
                  <p
                    className={`mt-2 text-base leading-relaxed sm:text-[1.05rem] ${
                      playerAlert.variant === 'lowCoin'
                        ? 'text-orange-50/95'
                        : 'text-amber-50/90'
                    }`}
                  >
                    {playerAlert.body}
                  </p>
                  {playerAlert.variant === 'lowCoin' ? null : playerAlert.variant ===
                    'index' ? (
                    <div className="mt-3 rounded-xl border border-amber-400/25 bg-black/40 px-3 py-3 text-xs text-amber-100/80">
                      <p className="text-sm font-black uppercase tracking-wider text-amber-200/90">
                        Technical details
                      </p>
                      {(() => {
                        const url = playerAlert.raw.match(
                          /https:\/\/console\.firebase\.google\.com[^\s]*/i
                        )?.[0];
                        return url ? (
                          <a
                            href={url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="mt-2 block w-full rounded-lg border border-amber-400/40 bg-amber-500/15 py-2.5 text-center text-sm font-black text-amber-100 hover:bg-amber-500/25"
                          >
                            Open “Create index” in Firebase Console ↗
                          </a>
                        ) : null;
                      })()}
                      <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-all font-mono text-[10px] text-amber-100/50">
                        {playerAlert.raw}
                      </pre>
                    </div>
                  ) : (
                    <details className="mt-3 rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-xs text-amber-100/65">
                      <summary className="cursor-pointer font-bold text-amber-200/90">
                        Technical details
                      </summary>
                      <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-all font-mono text-[10px] text-amber-100/50">
                        {playerAlert.raw}
                      </pre>
                    </details>
                  )}
                </motion.div>
              ) : null}

            {isBlockedPlayer && (
              <div className="fire-panel fire-orange mb-5 rounded-xl border border-rose-500/40 bg-rose-500/15 backdrop-blur-sm p-4 text-sm text-rose-100 flex items-center gap-3">
                <i className="fas fa-ban text-rose-300 text-lg"></i>
                <span>
                  Your account is restricted. You can open{' '}
                  <span className="font-bold text-rose-50">Agents</span> to message your team. Recharge, redeem, and
                  other actions stay unavailable until a manager unblocks you.
                </span>
              </div>
            )}
            
            {/* DASHBOARD VIEW */}
            {activeView === 'dashboard' && (
              <div className="space-y-5 sm:space-y-6">
                <motion.div
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.45 }}
                  className="player-dashboard-hero fire-panel fire-orange fire-hero relative z-0 grid h-auto min-h-0 w-full max-w-full content-center items-center overflow-hidden rounded-3xl border border-amber-400/35 bg-gradient-to-br from-amber-500/20 via-rose-600/10 to-purple-900/35 text-left shadow-[0_0_50px_-12px_rgba(234,179,8,0.45)]"
                >
                  <div className="pointer-events-none absolute -right-8 top-1 text-7xl opacity-[0.04] sm:-right-10 sm:-top-10 sm:text-8xl sm:opacity-[0.07]">
                    🎰
                  </div>
                  <div className="pointer-events-none absolute bottom-0 left-1/4 h-32 w-32 rounded-full bg-red-500/12 blur-3xl sm:h-40 sm:w-40 sm:bg-red-500/15" />
                  <div className="pointer-events-none absolute right-8 top-4 h-20 w-20 rounded-full bg-amber-400/12 blur-2xl sm:right-10 sm:top-10 sm:h-32 sm:w-32 sm:bg-amber-400/20" />

                  <div className="player-dashboard-hero__content relative row-start-1 w-full min-w-0 self-center pt-0">
                    <div className="player-dashboard-hero__intro min-w-0 w-full text-left">
                      <p className="flex items-center gap-2 text-base font-black uppercase tracking-[0.3em] text-amber-200/90 sm:text-lg">
                        <span className="text-lg">👑</span> VIP welcome
                      </p>
                      <h2 className="mt-2 text-[clamp(2.625rem,5vw,4.5rem)] font-black leading-[0.98] bg-gradient-to-r from-white via-amber-100 to-amber-300 bg-clip-text text-transparent">
                        Jackpot floor is open
                      </h2>
                      <p className="mt-2.5 max-w-xl text-[1.05rem] leading-relaxed text-amber-100/80 sm:mt-3 sm:text-[1.18rem]">
                        💎 Luxury tables, 🔥 live agents, 🪙 instant balance — tap Play to hit the
                        reels and send recharge or redeem requests.
                      </p>
                    </div>

                    <div className="player-dashboard-hero__main flex min-w-0 w-full flex-col gap-3.5 sm:gap-4">
                      <div className="grid max-w-lg grid-cols-2 gap-2.5">
                        <div className="fire-panel fire-orange rounded-2xl border border-amber-300/60 bg-black/35 px-3 py-3 text-center backdrop-blur-md shadow-[0_0_20px_-8px_rgba(251,191,36,0.55)]">
                          <span className="mx-auto inline-flex h-10 w-10 items-center justify-center rounded-xl border border-amber-200/40 bg-amber-200/15 text-2xl">
                            🪙
                          </span>
                          <p className="mt-1 text-sm font-black uppercase tracking-wider text-amber-100/90 sm:text-[0.95rem]">
                            Coin
                          </p>
                          <p className="mt-1 text-2xl font-black tabular-nums text-white sm:text-[2rem]">
                            {formatWalletAmount(wallet.coin)}
                          </p>
                        </div>
                        <div className="fire-panel fire-green rounded-2xl border border-emerald-300/60 bg-black/35 px-3 py-3 text-center backdrop-blur-md shadow-[0_0_20px_-8px_rgba(74,222,128,0.55)]">
                          <span className="mx-auto inline-flex h-10 w-10 items-center justify-center rounded-xl border border-emerald-200/40 bg-emerald-200/15 text-2xl">
                            💵
                          </span>
                          <p className="mt-1 text-sm font-black uppercase tracking-wider text-emerald-100/90 sm:text-[0.95rem]">
                            Cash
                          </p>
                          <p className="mt-1 text-2xl font-black tabular-nums text-white sm:text-[2rem]">
                            {formatWalletAmount(wallet.cash)}
                          </p>
                        </div>
                      </div>
                      <div className="fire-panel fire-orange flex flex-wrap items-center gap-2 rounded-2xl border border-cyan-400/30 bg-black/35 px-3 py-3 sm:max-w-lg">
                        <p className="text-sm font-black uppercase tracking-wide text-cyan-200/85 sm:text-base">
                          Your Referral Code:{' '}
                          <span className="text-base text-white sm:text-lg">{referralCode || 'Not available'}</span>
                        </p>
                        <button
                          type="button"
                          onClick={() => void handleCopyReferralCode()}
                          disabled={!referralCode}
                          className="fire-button fire-orange rounded-xl bg-cyan-400 px-3 py-2 text-sm font-black text-black hover:bg-cyan-300 disabled:opacity-50 sm:text-base"
                        >
                          Copy Referral Code
                        </button>
                      </div>
                      <div className="sm:max-w-lg">
                        <button
                          type="button"
                          onClick={() => {
                            setShowLoadCoinPanel(true);
                            setMessage('');
                          }}
                          disabled={isBlockedPlayer}
                          className="fire-button fire-purple w-full min-h-[52px] rounded-2xl border border-violet-400/50 bg-violet-500/20 py-3 text-base font-black text-violet-50 transition hover:bg-violet-500/30 disabled:cursor-not-allowed disabled:opacity-60 sm:text-lg"
                        >
                          ⬇ Load coin — payment reference
                        </button>
                      </div>
                    </div>

                    <div className="player-dashboard-hero__cta mx-auto flex w-full min-w-0 min-h-0 max-w-md flex-col items-stretch justify-center gap-3 self-stretch sm:max-w-lg lg:mx-0 lg:min-w-0 lg:max-w-[min(19rem,36vw)]">
                      <button
                        type="button"
                        onClick={() => setActiveView('play')}
                        className="fire-button fire-orange relative min-h-[56px] overflow-hidden rounded-2xl border border-red-200/70 bg-gradient-to-r from-red-500 via-red-400 to-rose-500 px-8 py-4 text-xl font-black text-white shadow-[0_0_30px_6px_rgba(239,68,68,0.45)] shadow-red-900/40 transition-all hover:scale-[1.02] hover:brightness-110 hover:shadow-[0_0_42px_8px_rgba(239,68,68,0.55)] sm:min-h-[60px] sm:text-[1.35rem]"
                      >
                        <span className="relative z-10 flex items-center justify-center gap-2">
                          🎰 Play now
                          <i className="fas fa-arrow-right text-base"></i>
                        </span>
                      </button>

                      {totalUnread > 0 ? (
                        <button
                          type="button"
                          onClick={handleOpenFirstUnreadAgent}
                          className="fire-button fire-orange flex min-h-[48px] items-center justify-center gap-2 rounded-2xl border border-rose-400/40 bg-rose-500/20 px-4 py-3 text-base font-black text-rose-100 shadow-lg transition-all hover:bg-rose-500/30 sm:text-lg"
                        >
                          💬 Unread messages ({totalUnread})
                        </button>
                      ) : null}
                    </div>
                  </div>
                </motion.div>

                <div className="fire-panel fire-orange rounded-2xl border border-rose-500/35 bg-gradient-to-br from-rose-950/50 to-black/50 p-4 shadow-lg backdrop-blur-md sm:p-5">
                  <p className="flex items-center gap-2 text-xl font-black uppercase tracking-wide text-rose-200/95">
                    <span className="text-lg">⚠️</span> Redeem accuracy
                  </p>
                  <p className="mt-2 text-base leading-relaxed text-rose-100/90 sm:text-[1.05rem]">
                    If a redeem looks too big or wrong, you risk penalties or account block. Only
                    submit truthful amounts.
                  </p>
                </div>

                <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                  {[
                    { icon: '🎮', label: 'Games', value: gameLogins.length, tone: 'amber' },
                    { icon: '🎧', label: 'Agents', value: agents.length, tone: 'purple' },
                    { icon: '📋', label: 'Requests', value: requestHistory.length, tone: 'gold' },
                    {
                      icon: '✉️',
                      label: 'Unread',
                      value: totalUnread,
                      tone: totalUnread > 0 ? 'alert' : 'muted',
                    },
                  ].map((card, index) => (
                    <motion.div
                      key={card.label}
                      initial={{ opacity: 0, y: 12 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: index * 0.05 }}
                      className={`fire-panel fire-orange rounded-2xl border p-4 text-center shadow-lg backdrop-blur-md transition-all active:scale-[0.98] sm:p-5 ${
                        card.tone === 'alert'
                          ? 'border-rose-400/40 bg-rose-500/15'
                          : 'border-white/10 bg-black/40 hover:border-amber-400/30'
                      }`}
                    >
                      <span className="text-2xl sm:text-3xl" aria-hidden>
                        {card.icon}
                      </span>
                      <p className="mt-1 text-[10px] font-bold uppercase tracking-wider text-amber-100/50">
                        {card.label}
                      </p>
                      <p className="mt-1 text-2xl font-black tabular-nums text-white sm:text-3xl">
                        {card.value}
                      </p>
                    </motion.div>
                  ))}
                </div>

                {false ? (
                <div
                  className="group/bonus relative overflow-hidden rounded-3xl border border-violet-400/35 bg-gradient-to-br from-violet-950/60 via-black/50 to-fuchsia-950/25 p-4 shadow-[0_0_40px_-12px_rgba(139,92,246,0.35)] backdrop-blur-xl sm:p-6"
                  onPointerEnter={() => setBonusStripPaused(true)}
                  onPointerLeave={() => setBonusStripPaused(false)}
                >
                  <div
                    className="pointer-events-none absolute -right-16 -top-20 h-56 w-56 rounded-full bg-fuchsia-500/20 blur-3xl"
                    aria-hidden
                  />
                  <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="flex items-center gap-2 text-lg font-black text-violet-100 sm:text-xl">
                          <span className="text-2xl" aria-hidden>
                            🎁
                          </span>
                          Bonus drops
                        </h3>
                        {playerBonusEvents.length > 0 ? (
                          <span className="rounded-full border border-violet-400/35 bg-violet-500/20 px-2.5 py-0.5 text-[10px] font-black uppercase tracking-widest text-fuchsia-100">
                            Queue · {playerBonusEvents.length} active
                          </span>
                        ) : null}
                        {bonusStripPaused && playerBonusEvents.length > 1 ? (
                          <span className="text-[10px] font-bold uppercase tracking-wider text-amber-200/80">
                            Paused
                          </span>
                        ) : null}
                      </div>
                      <p className="mt-1 max-w-xl text-[11px] font-medium text-violet-200/60 sm:text-xs">
                        New rewards from your staff &amp; coadmin queue here (up to{' '}
                        {MAX_PLAYER_BONUS_EVENTS_DISPLAY}, newest first). The carousel rotates
                        &mdash; hover to pause. First tap wins; then it vanishes for everyone, with
                        a soft fade.
                      </p>
                    </div>
                    {playerBonusEvents.length > 1 ? (
                      <div className="flex gap-2">
                        <button
                          type="button"
                          aria-label="Previous bonus"
                          onClick={() =>
                            setBonusCarouselIndex((i) =>
                              i <= 0 ? playerBonusEvents.length - 1 : i - 1
                            )
                          }
                          className="rounded-xl border border-violet-400/40 bg-violet-500/20 px-3 py-2 text-sm font-bold text-violet-50 shadow-inner transition hover:bg-violet-500/30"
                        >
                          ‹
                        </button>
                        <button
                          type="button"
                          aria-label="Next bonus"
                          onClick={() =>
                            setBonusCarouselIndex((i) =>
                              i >= playerBonusEvents.length - 1 ? 0 : i + 1
                            )
                          }
                          className="rounded-xl border border-violet-400/40 bg-violet-500/20 px-3 py-2 text-sm font-bold text-violet-50 shadow-inner transition hover:bg-violet-500/30"
                        >
                          ›
                        </button>
                      </div>
                    ) : null}
                  </div>

                  <AnimatePresence>
                    {bonusVanishedToast ? (
                      <motion.div
                        key="vanish"
                        initial={{ opacity: 0, y: -6 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -8 }}
                        transition={{ duration: 0.35 }}
                        className="mb-3 flex items-center gap-2 rounded-2xl border border-amber-400/30 bg-gradient-to-r from-amber-500/20 to-rose-500/15 px-3 py-2.5 text-xs font-semibold text-amber-100 shadow-lg shadow-amber-900/20"
                      >
                        <span className="text-lg" aria-hidden>
                          ✨
                        </span>
                        <span>
                          A bonus you were eyeing was just claimed — it&apos;s gone in a snap. Next
                          drop loading…
                        </span>
                      </motion.div>
                    ) : null}
                  </AnimatePresence>

                  {playerBonusEvents.length > 1 ? (
                    <div className="mb-3 flex flex-wrap items-center gap-1.5">
                      {playerBonusEvents.map((e, i) => (
                        <button
                          key={e.id}
                          type="button"
                          onClick={() => setBonusCarouselIndex(i)}
                          className={`max-w-[140px] truncate rounded-lg border px-2 py-1 text-left text-[10px] font-bold transition ${
                            i === activeBonusCarouselIndex
                              ? 'border-fuchsia-400/60 bg-fuchsia-500/25 text-fuchsia-50 shadow-[0_0_12px_rgba(217,70,239,0.35)]'
                              : 'border-violet-500/25 bg-black/30 text-violet-200/80 hover:border-violet-400/50'
                          }`}
                          title={e.bonusName}
                        >
                          {e.bonusName}
                        </button>
                      ))}
                    </div>
                  ) : null}

                  {playerBonusEvents.length > 1 ? (
                    <div
                      className="mb-4 flex items-center justify-center gap-1.5"
                      aria-hidden
                    >
                      {playerBonusEvents.map((e, i) => (
                        <button
                          key={`dot-${e.id}`}
                          type="button"
                          onClick={() => setBonusCarouselIndex(i)}
                          aria-label={`Show bonus ${i + 1}`}
                          className={`h-2 rounded-full transition-all ${
                            i === activeBonusCarouselIndex
                              ? 'w-6 bg-gradient-to-r from-fuchsia-400 to-violet-400'
                              : 'w-2 bg-violet-600/50 hover:bg-violet-400/70'
                          }`}
                        />
                      ))}
                    </div>
                  ) : null}

                  {playerBonusEvents.length === 0 ? (
                    <div className="py-6 text-center">
                      <p className="text-sm text-violet-200/50">
                        No bonus events right now. When staff or coadmin post one, it &apos;ll
                        appear here with a glow.
                      </p>
                    </div>
                  ) : (
                    <div className="relative min-h-[12rem]">
                      <AnimatePresence initial={false} mode="wait">
                        <motion.div
                          key={playerBonusEvents[activeBonusCarouselIndex]?.id || 'bonus'}
                          initial={{ opacity: 0, y: 14, filter: 'blur(10px)' }}
                          animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
                          exit={{ opacity: 0, y: -12, filter: 'blur(8px)' }}
                          transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
                          className="rounded-2xl border border-fuchsia-400/20 bg-gradient-to-b from-violet-950/40 to-black/50 p-4 shadow-inner sm:p-5"
                        >
                          {(() => {
                            const event = playerBonusEvents[activeBonusCarouselIndex];
                            if (!event) {
                              return null;
                            }
                            const eventDescription = getPlayerBonusEventDescription(
                              event.description
                            );
                            return (
                              <>
                                <p className="text-xs font-bold uppercase tracking-[0.2em] text-fuchsia-200/80">
                                  Featured drop
                                </p>
                                <p className="mt-1 text-xl font-black text-white sm:text-2xl">
                                  {event.bonusName}
                                </p>
                                <p className="mt-2 text-sm text-violet-100/85">
                                  🎯 {event.gameName} ·{' '}
                                  <span className="font-semibold text-fuchsia-100">
                                    ${Math.round(event.amountNpr || 0).toLocaleString('en-US')} USD
                                  </span>
                                </p>
                                {eventDescription ? (
                                  <p className="mt-2 line-clamp-3 text-sm leading-relaxed text-violet-100/80">
                                    {eventDescription}
                                  </p>
                                ) : null}
                                <p className="mt-2 text-xs text-violet-200/60">
                                  +{event.bonusPercentage}% boost · from{' '}
                                  {event.createdByRole === 'staff'
                                    ? 'Staff Team'
                                    : 'Coadmin Team'}
                                </p>
                                <button
                                  type="button"
                                  onClick={() => void handleActivateBonusEvent(event)}
                                  disabled={activatingBonusEventId === event.id}
                                  className="mt-4 flex min-h-[50px] w-full items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-fuchsia-500 via-violet-500 to-fuchsia-600 py-3 text-sm font-black text-white shadow-lg shadow-fuchsia-500/25 transition hover:brightness-110 active:scale-[0.99] disabled:opacity-60"
                                >
                                  {activatingBonusEventId === event.id ? (
                                    <>
                                      <i className="fas fa-circle-notch fa-spin" aria-hidden />
                                      Locking in…
                                    </>
                                  ) : (
                                    <>🎰 Claim this drop</>
                                  )}
                                </button>
                              </>
                            );
                          })()}
                        </motion.div>
                      </AnimatePresence>
                    </div>
                  )}
                </div>
                ) : null}

              </div>
            )}

            {activeView === 'bonus-events' && (
              <div className="-mb-[200px] space-y-5 pb-0 sm:space-y-6">
                <AnimatePresence>
                  {bonusVanishedToast ? (
                    <motion.div
                      key="bonus-events-vanish"
                      initial={{ opacity: 0, y: -6 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -8 }}
                      transition={{ duration: 0.35 }}
                      className="flex items-center gap-2 rounded-2xl border border-amber-400/30 bg-gradient-to-r from-amber-500/20 to-rose-500/15 px-3 py-2.5 text-xs font-semibold text-amber-100 shadow-lg shadow-amber-900/20"
                    >
                      <span className="text-lg" aria-hidden>
                        ✨
                      </span>
                      <span>
                        A bonus was just claimed and vanished. Keep watching for the next drop.
                      </span>
                    </motion.div>
                  ) : null}
                </AnimatePresence>
                <div
                  className="fire-panel fire-purple group/bonus relative flex flex-col justify-start overflow-hidden rounded-3xl border border-violet-400/35 bg-gradient-to-br from-violet-950/70 via-black/55 to-fuchsia-950/30 px-4 pb-4 pt-0 shadow-[0_0_40px_-12px_rgba(139,92,246,0.35)] backdrop-blur-xl sm:px-6 sm:pb-6 sm:pt-0"
                  onPointerEnter={() => setBonusStripPaused(true)}
                  onPointerLeave={() => setBonusStripPaused(false)}
                >
                  <div
                    className="pointer-events-none absolute -right-16 -top-20 h-56 w-56 rounded-full bg-fuchsia-500/20 blur-3xl"
                    aria-hidden
                  />
                  {playerBonusEvents.length === 0 ? (
                    <div className="rounded-3xl border border-dashed border-violet-400/25 bg-black/25 px-5 py-12 text-center">
                      <p className="text-4xl" aria-hidden>
                        🎁
                      </p>
                      <p className="mt-4 text-base font-bold text-violet-100">
                        No bonus events right now. Check back soon.
                      </p>
                    </div>
                  ) : (
                    <div className="relative -mt-40 min-h-0 sm:-mt-44">
                      <AnimatePresence initial={false} mode="wait">
                        <motion.div
                          key={playerBonusEvents[activeBonusCarouselIndex]?.id || 'bonus-events-card'}
                          initial={{ opacity: 0, y: 14, filter: 'blur(10px)' }}
                          animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
                          exit={{ opacity: 0, y: -12, filter: 'blur(8px)' }}
                          transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
                          className="rounded-3xl border border-fuchsia-400/25 bg-gradient-to-br from-white/[0.08] via-violet-950/45 to-black/70 p-5 shadow-[0_0_36px_-12px_rgba(244,114,182,0.45)] sm:p-6"
                          onTouchStart={(event) => {
                            bonusSwipeStartXRef.current = event.touches[0]?.clientX ?? null;
                          }}
                          onTouchEnd={(event) => {
                            const startX = bonusSwipeStartXRef.current;
                            const endX = event.changedTouches[0]?.clientX ?? null;
                            bonusSwipeStartXRef.current = null;
                            if (
                              startX == null ||
                              endX == null ||
                              playerBonusEvents.length <= 1
                            ) {
                              return;
                            }
                            const deltaX = endX - startX;
                            if (Math.abs(deltaX) < 40) {
                              return;
                            }
                            if (deltaX < 0) {
                              setBonusCarouselIndex((i) =>
                                i >= playerBonusEvents.length - 1 ? 0 : i + 1
                              );
                            } else {
                              setBonusCarouselIndex((i) =>
                                i <= 0 ? playerBonusEvents.length - 1 : i - 1
                              );
                            }
                          }}
                        >
                          {(() => {
                            const event = playerBonusEvents[activeBonusCarouselIndex];
                            if (!event) {
                              return null;
                            }
                            const eventDescription = getPlayerBonusEventDescription(
                              event.description
                            );

                            return (
                              <>
                                <p className="text-xs font-bold uppercase tracking-[0.24em] text-fuchsia-200/85">
                                  Limited drop
                                </p>
                                <h3 className="mt-2 text-2xl font-black text-white sm:text-3xl">
                                  {event.bonusName}
                                </h3>
                                {eventDescription ? (
                                  <p className="mt-2 text-sm text-violet-100/80 sm:text-base">
                                    {eventDescription}
                                  </p>
                                ) : null}

                                <div className="mt-5 grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
                                  <div className="rounded-2xl border border-white/10 bg-black/30 p-3">
                                    <p className="text-[10px] font-black uppercase tracking-wider text-violet-200/55">
                                      Game Name
                                    </p>
                                    <p className="mt-1 font-bold text-white">{event.gameName}</p>
                                  </div>
                                  <div className="rounded-2xl border border-white/10 bg-black/30 p-3">
                                    <p className="text-[10px] font-black uppercase tracking-wider text-violet-200/55">
                                      Bonus Name
                                    </p>
                                    <p className="mt-1 font-bold text-white">{event.bonusName}</p>
                                  </div>
                                  <div className="rounded-2xl border border-white/10 bg-black/30 p-3">
                                    <p className="text-[10px] font-black uppercase tracking-wider text-violet-200/55">
                                      Amount
                                    </p>
                                    <p className="mt-1 font-bold text-white">
                                      ${Math.round(event.amountNpr || 0).toLocaleString('en-US')}
                                    </p>
                                  </div>
                                  <div className="rounded-2xl border border-white/10 bg-black/30 p-3">
                                    <p className="text-[10px] font-black uppercase tracking-wider text-violet-200/55">
                                      Percentage
                                    </p>
                                    <p className="mt-1 font-bold text-white">+{event.bonusPercentage}%</p>
                                  </div>
                                  <div className="rounded-2xl border border-white/10 bg-black/30 p-3">
                                    <p className="text-[10px] font-black uppercase tracking-wider text-violet-200/55">
                                      Created By
                                    </p>
                                    <p className="mt-1 font-bold text-white">
                                      {event.createdByRole === 'staff'
                                        ? 'Staff Team'
                                        : 'Coadmin Team'}
                                    </p>
                                  </div>
                                  <div className="rounded-2xl border border-fuchsia-400/25 bg-fuchsia-500/10 p-3">
                                    <p className="text-[10px] font-black uppercase tracking-wider text-fuchsia-200/70">
                                      Status
                                    </p>
                                    <p className="mt-1 font-bold text-fuchsia-50">Available now</p>
                                  </div>
                                </div>

                                <button
                                  type="button"
                                  onClick={() => void handleActivateBonusEvent(event)}
                                  disabled={activatingBonusEventId === event.id}
                                  className="fire-button fire-purple mt-5 flex min-h-[52px] w-full items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-fuchsia-500 via-violet-500 to-amber-400 py-3 text-sm font-black text-white shadow-lg shadow-fuchsia-500/25 transition hover:brightness-110 active:scale-[0.99] disabled:opacity-60"
                                >
                                  {activatingBonusEventId === event.id ? (
                                    <>
                                      <i className="fas fa-circle-notch fa-spin" aria-hidden />
                                      Opening drop...
                                    </>
                                  ) : (
                                    <>Claim / Open Bonus</>
                                  )}
                                </button>
                              </>
                            );
                          })()}
                        </motion.div>
                      </AnimatePresence>
                    </div>
                  )}
                </div>

                <div className="fire-panel fire-purple rounded-3xl border border-violet-400/25 bg-gradient-to-br from-[#21102f]/90 via-[#14091f]/92 to-black/85 p-5 shadow-[0_0_34px_-16px_rgba(168,85,247,0.55)] sm:p-6">
                  <p className="text-xs font-black uppercase tracking-[0.28em] text-fuchsia-200/80">
                    Bonus Event Guide
                  </p>
                  <h3 className="mt-2 text-2xl font-black text-white sm:text-[1.8rem]">
                    How bonus events work
                  </h3>
                  <div className="mt-4 space-y-3 text-sm leading-relaxed text-violet-100/82 sm:text-base">
                    <p>
                      Bonus events are limited drops. When a bonus appears, you can open it and
                      try to claim it before another player does.
                    </p>
                    <p>
                      Each event shows the game, bonus amount, and bonus percentage, so you can
                      quickly see what you are getting before you claim.
                    </p>
                    <p>
                      When you claim a bonus event, that drop is locked in and removed from the
                      live list. If someone else claims it first, it disappears and you need to
                      wait for the next bonus event.
                    </p>
                  </div>
                </div>
              </div>
            )}

            {/* PLAY VIEW */}
            {activeView === 'play' && (
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
                      {gameLogins.map((game, index) => {
                        const resolvedUsername = (game.gameUsername || '').trim();
                        const resolvedPassword = String(game.gamePassword || '');
                        const isPasswordVisible = Boolean(visiblePasswords[game.id]);
                        const hasUsername = Boolean(resolvedUsername);
                        const isSelected = selectedGameName === game.gameName;

                        return (
                          <motion.button
                            key={game.id}
                            type="button"
                            initial={{ opacity: 0, y: 16 }}
                            animate={{ opacity: 1, y: 0 }}
                            transition={{ delay: index * 0.05 }}
                            onClick={() => {
                              setSelectedGameName(game.gameName);
                                openActiveTableSplash();
                            }}
                            className={`fire-panel fire-orange group relative w-full self-start overflow-hidden rounded-2xl border p-2 text-left shadow-xl transition-all active:scale-[0.98] hover:scale-[1.01] hover:shadow-[0_0_26px_-8px_rgba(251,191,36,0.5)] ${
                              isSelected
                                ? 'border-amber-400/60 bg-gradient-to-br from-amber-500/25 to-purple-900/40 shadow-[0_0_32px_-8px_rgba(234,179,8,0.55)]'
                                : 'border-white/10 bg-black/45 hover:border-amber-400/35'
                            }`}
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
                              <div className="relative mt-1.5 rounded-xl border border-white/10 bg-black/35 px-2 py-1.5">
                                <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-amber-100/55">
                                  Game username
                                </p>
                                <p className="mt-0.5 truncate font-mono text-sm font-bold text-white">
                                  {resolvedUsername}
                                </p>
                                <div className="mt-1.5 flex items-center justify-between gap-1.5">
                                  <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-amber-100/55">
                                    Game password
                                  </p>
                                  <span
                                    onClick={(event) => {
                                      event.preventDefault();
                                      event.stopPropagation();
                                      togglePassword(game.id);
                                    }}
                                    className="cursor-pointer rounded-lg border border-amber-400/40 bg-amber-500/20 px-2 py-0.5 text-xs font-black text-amber-100 hover:bg-amber-500/30"
                                    aria-label={isPasswordVisible ? 'Hide password' : 'Show password'}
                                    role="button"
                                  >
                                    {isPasswordVisible ? '🙈' : '👁'}
                                  </span>
                                </div>
                                <p className="mt-0.5 truncate font-mono text-sm font-bold tracking-wider text-white">
                                  {isPasswordVisible ? resolvedPassword || '—' : '••••••••••'}
                                </p>
                              </div>
                            )}
                            <span
                              className={`relative mt-2 flex min-h-[38px] w-full items-center justify-center rounded-xl px-2 text-sm font-black transition-all duration-300 group-hover:tracking-wide ${
                                isSelected
                                  ? 'bg-gradient-to-r from-amber-300 via-yellow-300 to-orange-300 text-black shadow-[0_0_22px_-2px_rgba(251,191,36,0.7)]'
                                  : 'border border-amber-300/60 bg-gradient-to-r from-amber-500/25 to-orange-500/20 text-amber-50 shadow-[0_0_18px_-6px_rgba(251,191,36,0.55)] group-hover:from-amber-400/40 group-hover:to-orange-400/35 group-hover:shadow-[0_0_26px_-4px_rgba(251,191,36,0.75)]'
                              }`}
                            >
                              {isSelected ? '🔥 Selected' : 'Tap to open'}
                            </span>
                          </motion.button>
                        );
                      })}
                    </div>
                  </>
                )}
              </div>
            )}

            {/* USERNAMES VIEW */}
            {activeView === 'usernames' && (
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
                      {usernamesCreatorFilterKeys.sortedUids.map((uid) => (
                        <button
                          key={uid}
                          type="button"
                          onClick={() =>
                            setSelectedCreatorUid((prev) => (prev === uid ? null : uid))
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
                            setSelectedCreatorUid((prev) =>
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
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:gap-5">
                    {usernamesVisibleLogins.map((login) => {
                      const gameCarers =
                        usernameCarersByGame[normalizeGameKey(login.gameName || '')] || [];
                      const visible = visiblePasswords[login.id];
                      const displayUsername = login.gameUsername;
                      const displayPassword = login.gamePassword;
                      return (
                        <motion.div
                          key={login.id}
                          layout
                          className="fire-panel fire-orange group rounded-[1.7rem] border border-amber-300/25 bg-gradient-to-br from-[#3a140b]/88 via-[#5d2411]/78 to-[#261018]/92 p-3 shadow-[0_18px_40px_-18px_rgba(56,11,4,0.9)] backdrop-blur-xl transition-all sm:p-3.5 sm:hover:border-amber-300/45 sm:hover:shadow-[0_0_30px_-10px_rgba(251,191,36,0.38)]"
                        >
                          <div className="mb-3 flex items-start justify-between gap-3 border-b border-amber-200/10 pb-2.5">
                            <div className="min-w-0">
                              <p className="text-[0.68rem] font-black uppercase tracking-[0.24em] text-amber-100/50">
                                🎮 Game
                              </p>
                              <h3 className="mt-1 break-words bg-gradient-to-r from-amber-50 via-yellow-100 to-orange-200 bg-clip-text text-[1.25rem] font-black leading-tight text-transparent">
                                {login.gameName}
                              </h3>
                            </div>
                            <span className="shrink-0 rounded-full border border-emerald-300/35 bg-emerald-400/12 px-3 py-1 text-[0.72rem] font-black tracking-wide text-emerald-100 shadow-[0_0_18px_-10px_rgba(52,211,153,0.9)]">
                              ✨ Active
                            </span>
                          </div>

                          <div className="space-y-2.5">
                            <div className="rounded-2xl border border-white/10 bg-white/[0.05] p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]">
                              <div className="flex items-center justify-between gap-2">
                                <p className="text-[0.72rem] font-black uppercase tracking-[0.18em] text-amber-100/58">
                                  Username
                                </p>
                                <button
                                  type="button"
                                  onClick={() =>
                                    void copyCredentialValue(String(displayUsername || ''), 'Username')
                                  }
                                  className="rounded-xl border border-amber-300/35 bg-amber-400/10 px-3 py-1 text-[0.72rem] font-black text-amber-50 transition hover:bg-amber-400/20"
                                >
                                  Copy
                                </button>
                              </div>
                              <p className="mt-2 break-words rounded-xl border border-black/10 bg-black/30 px-3 py-2 font-mono text-[1.02rem] font-bold tracking-[0.08em] text-white shadow-inner">
                                {displayUsername || '—'}
                              </p>
                            </div>

                            <div className="rounded-2xl border border-cyan-300/18 bg-cyan-950/18 p-3">
                              <p className="text-[0.72rem] font-black uppercase tracking-[0.16em] text-cyan-100/82">
                                Carer who created this
                              </p>
                              {gameCarers.length === 0 ? (
                                <p className="mt-2 text-sm text-cyan-100/65">No carer info yet.</p>
                              ) : (
                                <p className="mt-2 text-[1rem] font-semibold leading-snug text-white">
                                  {gameCarers.join(', ')}
                                </p>
                              )}
                            </div>

                            <div className="rounded-2xl border border-white/10 bg-white/[0.05] p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]">
                              <div className="flex items-center justify-between gap-2">
                                <p className="text-[0.72rem] font-black uppercase tracking-[0.18em] text-amber-100/58">
                                  Password
                                </p>
                                <div className="flex gap-2">
                                  <button
                                    type="button"
                                    onClick={() =>
                                      void copyCredentialValue(
                                        visible ? String(displayPassword || '') : '',
                                        'Password'
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
                              <p className="mt-2 break-all rounded-xl border border-black/10 bg-black/30 px-3 py-2 font-mono text-[1.02rem] font-bold tracking-[0.18em] text-white shadow-inner">
                                {visible ? displayPassword : '••••••••••••••••'}
                              </p>
                            </div>

                            <div className="grid grid-cols-2 gap-2 border-t border-amber-200/10 pt-1">
                              <button
                                type="button"
                                onClick={() => openCredentialResetModal(login, 'recreate_username')}
                                disabled={
                                  credentialTaskLoadingKey === `recreate_username:${login.id}`
                                }
                                className="min-h-[44px] rounded-2xl border border-amber-200/20 bg-gradient-to-r from-amber-400 to-orange-400 px-3 py-2 text-sm font-black leading-tight text-black shadow-[0_10px_22px_-14px_rgba(251,191,36,0.95)] transition-all hover:from-amber-300 hover:to-orange-300 disabled:opacity-50"
                              >
                                {credentialTaskLoadingKey === `recreate_username:${login.id}` ? (
                                  <i className="fas fa-spinner fa-spin"></i>
                                ) : (
                                  <>Reset username</>
                                )}
                              </button>
                              <button
                                type="button"
                                onClick={() => openCredentialResetModal(login, 'reset_password')}
                                disabled={credentialTaskLoadingKey === `reset_password:${login.id}`}
                                className="min-h-[44px] rounded-2xl border border-fuchsia-200/15 bg-gradient-to-r from-fuchsia-600 to-violet-600 px-3 py-2 text-sm font-black leading-tight text-white shadow-[0_10px_24px_-16px_rgba(217,70,239,0.95)] transition-all hover:from-fuchsia-500 hover:to-violet-500 disabled:opacity-50"
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
                    )}
                  </>
                )}
              </div>
            )}

            {/* EARN COINS VIEW */}
            {activeView === 'earn-coins' && (
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
                    {referralRewardGroups.map((group) => (
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
            )}

            {/* AGENTS VIEW - ReachOutView integration remains the same but styled via the prop structure */}
            {activeView === 'agents' && (
              <div className="flex min-h-0 min-w-0 max-h-[min(78dvh,calc(100dvh-11rem))] flex-1 flex-col overflow-hidden sm:max-h-[min(82dvh,calc(100dvh-10rem))]">
                <ReachOutView
                  chatUsers={agents}
                  selectedChatUser={selectedAgent}
                  messages={messages}
                  newMessage={newMessage}
                  unreadCounts={unreadCounts}
                  imagePreview={imagePreview}
                  sendingImage={sendingImage}
                  messagesScrollRef={agentsScrollRef}
                  hasMoreOlderMessages={pagedAgentChat.hasMoreOlder}
                  loadingOlderMessages={pagedAgentChat.loadingOlder}
                  onLoadOlderMessages={pagedAgentChat.loadOlder}
                  onSelectUser={handleAgentSelect}
                  onMessageChange={setNewMessage}
                  onSendMessage={handleSendMessage}
                  onImageSelect={handleImageSelect}
                  onClearImage={handleClearImage}
                  onlineByUid={agentOnlineByUid}
                />
              </div>
            )}
            </div>
          </div>
        </section>

        <nav
          className="fixed bottom-0 left-0 right-0 z-40 flex items-stretch justify-around border-t border-amber-500/25 bg-[#07030a]/95 px-1 pb-[env(safe-area-inset-bottom)] pt-2 shadow-[0_-8px_32px_rgba(0,0,0,0.55)] backdrop-blur-2xl lg:hidden"
          aria-label="Main navigation"
        >
          {NAV_ITEMS.filter((item) => item.view !== 'play').map((item) => {
            const isActive = activeView === item.view;
            const unread = item.view === 'agents' ? totalUnread : 0;

            return (
              <button
                key={item.view}
                type="button"
                onClick={() => {
                  if (item.view === 'agents' && unread > 0) {
                    handleOpenFirstUnreadAgent();
                    return;
                  }
                  handleChangeView(item.view);
                }}
                className={`relative flex min-w-0 flex-1 flex-col items-center gap-0.5 rounded-xl py-2 text-[10px] font-black uppercase tracking-wide transition-all active:scale-95 sm:text-[11px] ${
                  isActive
                    ? 'text-amber-300'
                    : 'text-amber-100/45 hover:text-amber-200/80'
                }`}
              >
                <span className="text-lg leading-none sm:text-xl" aria-hidden>
                  {item.emoji}
                </span>
                <span className="max-w-full truncate px-0.5">{item.label}</span>
                {unread > 0 ? (
                  <span className="absolute right-2 top-1 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-red-500 px-1 text-[9px] font-black text-white shadow-md">
                    {unread > 9 ? '9+' : unread}
                  </span>
                ) : null}
                {isActive ? (
                  <span className="absolute bottom-1 h-0.5 w-8 rounded-full bg-gradient-to-r from-amber-400 to-yellow-500 shadow-[0_0_12px_rgba(234,179,8,0.8)]" />
                ) : null}
              </button>
            );
          })}
        </nav>
        <Link
          href="/player/chat"
          className="fixed bottom-[calc(5.75rem+env(safe-area-inset-bottom))] left-4 z-50 inline-flex h-12 w-12 items-center justify-center rounded-full border border-emerald-300/50 bg-emerald-500/20 text-2xl shadow-lg shadow-emerald-500/30 backdrop-blur-sm transition hover:bg-emerald-500/30 lg:bottom-4 lg:left-4"
          aria-label="Open player chat"
          title="Chat with online players"
        >
          💬
        </Link>
      </main>

      {credentialResetModal ? (
        <div
          className={`${PLAYER_SPLASH_BACKDROP} z-[78]`}
          onClick={() => setCredentialResetModal(null)}
          role="dialog"
          aria-modal="true"
          aria-labelledby="credential-reset-title"
        >
          <div
            onClick={(event) => event.stopPropagation()}
            className={`${PLAYER_SPLASH_CARD} sm:max-w-md`}
          >
            <p className="text-center text-2xl" aria-hidden>
              {credentialResetModal.taskType === 'reset_password' ? '🔑' : '🔁'}
            </p>
            <h3
              id="credential-reset-title"
              className="mt-2 text-center text-xl font-black text-white sm:text-2xl"
            >
              {credentialResetModal.taskType === 'reset_password'
                ? 'Reset game password?'
                : 'Recreate game username?'}
            </h3>
            <p className="mt-3 text-center text-sm leading-relaxed text-amber-100/75">
              <span className="font-bold text-amber-200">
                {credentialResetModal.gameLogin.gameName}
              </span>
              {' — '}
              {credentialResetModal.taskType === 'reset_password'
                ? 'A carer will set a new password for this table.'
                : 'A carer will assign a new username for this table.'}
            </p>
            <p className="mt-2 text-center text-xs text-amber-200/50">
              Your team is notified. You can continue playing other tables while this is processed.
            </p>
            <div className="mt-6 flex flex-col gap-3 sm:flex-row-reverse">
              <button
                type="button"
                onClick={() => void confirmCredentialResetModal()}
                className="min-h-[52px] flex-1 rounded-2xl bg-gradient-to-r from-amber-400 to-yellow-400 py-3.5 text-base font-black text-black shadow-lg shadow-amber-500/20 transition hover:brightness-110 active:scale-[0.99]"
              >
                Yes, request it
              </button>
              <button
                type="button"
                onClick={() => setCredentialResetModal(null)}
                className="min-h-[52px] flex-1 rounded-2xl border border-white/20 bg-white/5 py-3.5 text-base font-bold text-amber-100 transition hover:bg-white/10"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {showActiveTableSplash && selectedGameName ? (
        <div
          className="fixed inset-0 z-[74] flex items-end justify-center bg-black/82 px-3 pt-4 backdrop-blur-xl sm:px-4"
          style={{
            paddingBottom: `max(0.75rem, calc(env(safe-area-inset-bottom) + ${activeTableKeyboardInset}px))`,
          }}
          onClick={() => closeActiveTableSplash()}
          role="dialog"
          aria-modal="true"
          aria-labelledby="active-table-title"
        >
          <div
            onClick={(event) => event.stopPropagation()}
            ref={activeTableSplashContentRef}
            className="relative flex min-h-0 w-full max-w-lg flex-col overflow-hidden rounded-[28px] border border-amber-400/35 bg-gradient-to-b from-black/90 to-zinc-950/98 shadow-2xl shadow-amber-900/25 backdrop-blur-xl sm:rounded-3xl"
            style={{
              maxHeight: activeTableViewportHeight
                ? `${Math.max(320, activeTableViewportHeight - 16)}px`
                : 'calc(100dvh - 1rem)',
            }}
          >
            <div className="relative shrink-0 border-b border-white/10 px-4 pb-3 pt-4 sm:px-6 sm:pt-5">
              <button
                type="button"
                aria-label="Close"
                onClick={() => closeActiveTableSplash()}
                className="absolute right-3 top-3 z-10 flex h-10 w-10 items-center justify-center rounded-xl border border-amber-500/35 bg-black/60 text-xl font-bold leading-none text-amber-100 transition hover:bg-amber-500/15 sm:right-4 sm:top-4"
              >
                ×
              </button>
              <p className="text-[10px] font-black uppercase tracking-[0.28em] text-amber-200/65">
                Active table
              </p>
              <h3
                id="active-table-title"
                className="mt-1 pr-12 text-2xl font-black text-amber-300 sm:text-3xl"
              >
                {selectedGameName}
              </h3>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-6 sm:py-5">
              <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-3 sm:p-4">
                <label className="mb-2 block text-sm font-bold text-amber-100/75">
                  💰 Amount (deducts from your coin)
                </label>
                <input
                  ref={activeTableAmountInputRef}
                  value={playAmount}
                  onChange={(event) => setPlayAmount(event.target.value)}
                  onFocus={nudgeActiveTableForKeyboard}
                  type="number"
                  min="1"
                  inputMode="decimal"
                  placeholder="Enter amount in USD"
                  autoFocus
                  className="min-h-[52px] w-full rounded-2xl border border-amber-400/40 bg-black/70 px-4 py-3 text-lg text-white outline-none focus:border-amber-300 focus:ring-2 focus:ring-amber-400/30"
                />
                <p className="mt-2 text-xs leading-relaxed text-amber-100/60">
                  Available coin:{' '}
                  <span className="font-bold text-amber-200">{formatWalletAmount(wallet.coin)}</span>
                  {' — '}
                  Recharge is only sent if this amount is covered.
                </p>
                {playAmount &&
                Number.isFinite(Number(playAmount)) &&
                Number(playAmount) > 0 &&
                Number(playAmount) > wallet.coin ? (
                  <p className="mt-2 text-sm font-bold text-rose-300">
                    Not enough coin. Lower the amount or add coin first.
                  </p>
                ) : null}
              </div>

              <div className="mt-4 flex items-start gap-2 rounded-2xl border border-white/10 bg-white/[0.06] p-3 text-sm text-amber-100/65 sm:p-4">
                <span className="text-lg">🛡️</span>
                <span>Requests go to your team for secure processing.</span>
              </div>
            </div>

            <div className="sticky bottom-0 shrink-0 border-t border-white/10 bg-gradient-to-t from-black/95 to-black/85 px-4 py-3 backdrop-blur sm:px-6 sm:py-4">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <button
                  type="button"
                  disabled={
                    requestLoading ||
                    !selectedGameName ||
                    !playAmount ||
                    isBlockedPlayer ||
                    (Number.isFinite(Number(playAmount)) &&
                      Number(playAmount) > 0 &&
                      Number(playAmount) > wallet.coin)
                  }
                  onClick={() => void handleGameRequest('recharge')}
                  className="flex min-h-[52px] items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-emerald-600 to-emerald-500 px-4 py-3 text-base font-black text-white shadow-lg shadow-emerald-500/25 transition-all hover:brightness-110 disabled:opacity-50"
                >
                  <span>⬇️</span> Send Recharge
                </button>

                <button
                  type="button"
                  disabled={
                    requestLoading ||
                    !selectedGameName ||
                    !playAmount ||
                    isBlockedPlayer
                  }
                  onClick={() => void handleGameRequest('redeem')}
                  className="flex min-h-[52px] items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-rose-700 to-red-600 px-4 py-3 text-base font-black text-white shadow-lg shadow-rose-500/25 transition-all hover:brightness-110 disabled:opacity-50"
                >
                  <span>⬆️</span> Send Redeem
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {playRequestSplash && (
        <div
          className={`${PLAYER_SPLASH_BACKDROP_CENTER} z-[75] bg-gradient-to-b from-black/80 to-zinc-950/95`}
          role="alert"
          aria-live="polite"
          aria-busy="true"
        >
          <div className="w-full max-w-md overflow-hidden rounded-3xl border border-amber-400/40 bg-gradient-to-br from-amber-900/90 via-zinc-900 to-fuchsia-950/90 p-7 text-center text-white shadow-[0_0_60px_-12px_rgba(234,179,8,0.4)] backdrop-blur-xl">
            <p className="text-xs font-black uppercase tracking-[0.3em] text-amber-200/90">
              Active table
            </p>
            <h3 className="mt-3 text-2xl font-black sm:text-3xl">
              {playRequestSplash.type === 'recharge'
                ? 'Sending recharge request'
                : 'Sending redeem request'}
            </h3>
            <p className="mt-2 line-clamp-2 text-sm text-amber-100/80">
              <span className="font-bold text-amber-200">🎰 {playRequestSplash.gameName}</span>
            </p>
            <p className="mt-1 text-sm text-amber-100/60">
              Amount:{' '}
              <span className="font-mono font-bold text-white">
                ${playRequestSplash.amountText} USD
              </span>
            </p>
            <div className="mt-7 flex items-center justify-center gap-2">
              <i className="fas fa-circle-notch fa-spin text-2xl text-amber-300" aria-hidden></i>
              <span className="text-sm font-bold text-amber-100/90">Please wait…</span>
            </div>
            <p className="mt-4 text-xs text-amber-200/50">
              This will close when your request is finished.
            </p>
          </div>
        </div>
      )}

      {showLoadCoinPanel && (
        <div
          onClick={() => setShowLoadCoinPanel(false)}
          className={`${PLAYER_SPLASH_BACKDROP_CENTER} z-[120]`}
        >
          <div
            onClick={(event) => event.stopPropagation()}
            className="fire-panel fire-purple relative z-[121] isolate w-full max-w-md overflow-hidden rounded-3xl border border-violet-400/40 bg-gradient-to-br from-violet-950/95 via-zinc-900 to-black/95 p-6 text-left text-white shadow-[0_0_60px_-12px_rgba(139,92,246,0.45)] backdrop-blur-xl sm:p-7"
          >
            <h3 className="text-2xl font-black">Load coin</h3>
            <p className="mt-2 text-sm text-violet-100/80">
              Get the one-time reference image and 16-digit code from your co-admin. When depositing,
              you must paste this 16-digit code in the payment note/remark. If the code is missing,
              your payment may not be matched and could be lost. The code expires in 10 minutes.
            </p>

            {!activeCoinLoad ? (
              <div className="mt-6">
                <button
                  type="button"
                  onClick={() => void handleCreateCoinLoadSession()}
                  disabled={coinLoadBusy || !playerCoadminUid || isBlockedPlayer}
                  className="fire-button fire-purple w-full min-h-[52px] rounded-2xl bg-gradient-to-r from-violet-500 to-fuchsia-600 py-3 text-sm font-black text-white shadow-lg shadow-violet-500/25 transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {coinLoadBusy ? 'Preparing…' : 'Add coins'}
                </button>
                {!playerCoadminUid ? (
                  <p className="mt-2 text-xs text-amber-200/90">
                    Your account is not linked to a co-admin yet. Contact an agent.
                  </p>
                ) : null}
                {isBlockedPlayer ? (
                  <p className="mt-2 text-xs text-rose-200/90">Restricted account — ask an agent for help.</p>
                ) : null}
              </div>
            ) : (
              <div className="mt-6 space-y-4">
                <div className="overflow-hidden rounded-2xl border border-white/10 bg-black/40">
                  <img
                    src={activeCoinLoad.paymentPhotoUrl}
                    alt="Payment reference"
                    className="max-h-64 w-full object-contain"
                  />
                </div>
                <div>
                  <p className="text-xs font-bold uppercase tracking-wider text-violet-200/80">
                    Your 16-digit code
                  </p>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <code className="flex-1 break-all rounded-xl border border-violet-400/30 bg-black/50 px-3 py-2 text-center text-lg font-mono font-bold tracking-wider text-white sm:text-xl">
                      {activeCoinLoad.hashCode}
                    </code>
                    <button
                      type="button"
                      onClick={async () => {
                        try {
                          await navigator.clipboard.writeText(activeCoinLoad.hashCode);
                          setMessage('Code copied to clipboard.');
                        } catch {
                          setMessage('Copy failed. Select the code and copy manually.');
                        }
                      }}
                      className="shrink-0 rounded-xl border border-violet-400/40 bg-violet-500/20 px-4 py-2 text-sm font-bold text-violet-50 hover:bg-violet-500/30"
                    >
                      Copy
                    </button>
                  </div>
                </div>
                <p className="text-center text-sm font-bold text-amber-200/95">
                  Time left: {formatLoadCoinCountdown(loadCoinTimeLeftSec)}
                </p>
                <p className="text-center text-xs text-neutral-400">
                  When the timer ends, this screen closes and the code is removed from the server.
                </p>
              </div>
            )}

            <div className="mt-6 flex justify-end">
              <button
                type="button"
                onClick={() => setShowLoadCoinPanel(false)}
                className="rounded-xl bg-white/10 px-4 py-2.5 text-sm font-bold text-white hover:bg-white/20"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {showCoinConfirmSplash && (
        <div
          onClick={() => setShowCoinConfirmSplash(false)}
          className={`${PLAYER_SPLASH_BACKDROP_CENTER} z-[72]`}
        >
          <div
            onClick={(event) => event.stopPropagation()}
            className={`${PLAYER_SPLASH_CARD} fire-panel fire-orange text-white`}
          >
            <h3 className="text-2xl font-black">Transfer to coin?</h3>
            <p className="mt-2 text-sm text-amber-100/85">
              Enter the cash amount you want to transfer into coin balance.
            </p>
            <p className="mt-3 rounded-xl border border-amber-300/25 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
              Current cash: ${formatWalletAmount(wallet.cash)}
            </p>
            <label className="mt-3 block text-sm text-amber-100/90">
              Transfer amount
              <input
                type="number"
                min={1}
                step={1}
                inputMode="numeric"
                value={transferCoinAmountInput}
                onChange={(event) => setTransferCoinAmountInput(event.target.value)}
                className="mt-2 w-full rounded-xl border border-amber-300/30 bg-black/35 px-4 py-3 text-white outline-none focus:border-amber-300/60"
                placeholder="Enter amount"
              />
            </label>
            <div className="mt-5 flex gap-3">
              <button
                type="button"
                onClick={() => setShowCoinConfirmSplash(false)}
                className="flex-1 rounded-xl bg-white/10 px-4 py-3 text-sm font-bold text-white hover:bg-white/20"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowCoinConfirmSplash(false);
                  void handleCoinButtonClick();
                }}
                disabled={coinLoading}
                className="fire-button fire-orange flex-1 rounded-xl bg-amber-400 px-4 py-3 text-sm font-black text-black hover:bg-amber-300 disabled:opacity-60"
              >
                {coinLoading ? 'Transferring...' : 'Yes, transfer'}
              </button>
            </div>
          </div>
        </div>
      )}

      {showCashoutModal && (
        <div
          onClick={() => setShowCashoutModal(false)}
          className={`${PLAYER_SPLASH_BACKDROP_CENTER} z-[73]`}
        >
          <div
            onClick={(event) => event.stopPropagation()}
            className={`${PLAYER_SPLASH_CARD_WIDE} fire-panel fire-green text-white`}
          >
            <h3 className="text-2xl font-black">Player Cashout</h3>
            <p className="mt-2 text-sm text-cyan-100/80">
              Cashout uses your full available cash amount. Add payment details to continue.
            </p>
            <p className="mt-4 rounded-xl border border-cyan-300/30 bg-cyan-500/10 px-4 py-3 text-sm text-cyan-100">
              Cashing out full amount: ${formatWalletAmount(wallet.cash)}
            </p>

            <div className="mt-4">
              <p className="text-sm font-semibold text-cyan-100">How should we pay you?</p>
              <div className="mt-3 grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => setCashoutPayoutMethod('qr')}
                  className={`rounded-xl border px-4 py-3 text-sm font-black transition ${
                    cashoutPayoutMethod === 'qr'
                      ? 'border-cyan-300/60 bg-cyan-400/20 text-cyan-50'
                      : 'border-white/15 bg-black/35 text-cyan-100/80 hover:border-cyan-400/40'
                  }`}
                >
                  QR
                </button>
                <button
                  type="button"
                  onClick={() => setCashoutPayoutMethod('app')}
                  className={`rounded-xl border px-4 py-3 text-sm font-black transition ${
                    cashoutPayoutMethod === 'app'
                      ? 'border-cyan-300/60 bg-cyan-400/20 text-cyan-50'
                      : 'border-white/15 bg-black/35 text-cyan-100/80 hover:border-cyan-400/40'
                  }`}
                >
                  Payment App
                </button>
              </div>
            </div>

            <div className="mt-4 space-y-2">
              {lastUsedQrCashout?.payment.qrImageUrl ? (
                <button
                  type="button"
                  onClick={() => {
                    setCashoutPayoutMethod('qr');
                    setCashoutQrUrl(lastUsedQrCashout.payment.qrImageUrl || '');
                    setMessage('Loaded your last used QR details.');
                  }}
                  className="w-full rounded-xl border border-cyan-300/25 bg-cyan-500/10 px-4 py-3 text-left text-sm font-semibold text-cyan-50 transition hover:bg-cyan-500/15"
                >
                  Use last QR
                </button>
              ) : null}

              {lastUsedAppCashout?.payment ? (
                <button
                  type="button"
                  onClick={() => {
                    setCashoutPayoutMethod('app');
                    setCashoutAppName(lastUsedAppCashout.payment.paymentAppName || '');
                    setCashoutCashTag(lastUsedAppCashout.payment.paymentAppCashTag || '');
                    setCashoutAccountName(
                      lastUsedAppCashout.payment.paymentAppAccountName || ''
                    );
                    setMessage('Loaded your last used payment app details.');
                  }}
                  className="w-full rounded-xl border border-cyan-300/25 bg-cyan-500/10 px-4 py-3 text-left text-sm font-semibold text-cyan-50 transition hover:bg-cyan-500/15"
                >
                  Use last payment app details
                </button>
              ) : null}
            </div>

            {cashoutPayoutMethod === 'qr' ? (
              <div className="mt-4 rounded-2xl border border-white/10 bg-black/25 p-4">
                <ImageUploadField
                  label="Upload your QR"
                  valueUrl={cashoutQrUrl || undefined}
                  onUploaded={(uploaded) => {
                    setCashoutQrUrl(uploaded.url);
                    setMessage('QR uploaded successfully.');
                  }}
                  onError={(uploadMessage) => setMessage(uploadMessage)}
                  className="space-y-3"
                />
              </div>
            ) : (
              <div className="mt-4 grid gap-3">
                <label className="block text-sm font-semibold text-cyan-100">
                  Payment App Name
                  <input
                    type="text"
                    value={cashoutAppName}
                    onChange={(event) => setCashoutAppName(event.target.value)}
                    className="mt-2 min-h-[48px] w-full rounded-xl border border-white/15 bg-black/40 px-4 py-3 text-white outline-none focus:border-cyan-400/60"
                    placeholder="Chime, Cash App, Venmo..."
                  />
                </label>
                <label className="block text-sm font-semibold text-cyan-100">
                  CashTag / Username
                  <input
                    type="text"
                    value={cashoutCashTag}
                    onChange={(event) => setCashoutCashTag(event.target.value)}
                    className="mt-2 min-h-[48px] w-full rounded-xl border border-white/15 bg-black/40 px-4 py-3 text-white outline-none focus:border-cyan-400/60"
                    placeholder="$name or app username"
                  />
                </label>
                <label className="block text-sm font-semibold text-cyan-100">
                  Name On The App
                  <input
                    type="text"
                    value={cashoutAccountName}
                    onChange={(event) => setCashoutAccountName(event.target.value)}
                    className="mt-2 min-h-[48px] w-full rounded-xl border border-white/15 bg-black/40 px-4 py-3 text-white outline-none focus:border-cyan-400/60"
                    placeholder="Your payout name"
                  />
                </label>
              </div>
            )}

            <div className="mt-5 flex gap-3">
              <button
                type="button"
                onClick={() => setShowCashoutModal(false)}
                className="flex-1 rounded-xl bg-white/10 px-4 py-3 text-sm font-bold text-white hover:bg-white/20"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void handlePlayerCashoutRequest()}
                disabled={cashoutLoading}
                className="fire-button fire-green flex-1 rounded-xl bg-cyan-400 px-4 py-3 text-sm font-black text-black hover:bg-cyan-300 disabled:opacity-60"
              >
                {cashoutLoading ? 'Sending...' : 'Send Cashout'}
              </button>
            </div>
          </div>
        </div>
      )}

      {showCashoutSuccessSplash && (
        <div
          onClick={() => {
            setShowCashoutSuccessSplash(false);
            setShowCashoutInquiryPanel(false);
          }}
          className={`${PLAYER_SPLASH_BACKDROP_CENTER} z-[76]`}
        >
          <div
            onClick={(event) => event.stopPropagation()}
            className="fire-panel fire-green w-full max-w-2xl rounded-3xl border border-emerald-300/40 bg-gradient-to-br from-emerald-600 via-emerald-700 to-emerald-900 p-7 text-white shadow-2xl shadow-emerald-900/30 backdrop-blur-xl"
          >
            <p className="text-xs font-black uppercase tracking-[0.28em] text-emerald-100/90">
              Cashout Successful
            </p>
            <h3 className="mt-3 text-3xl font-black">Cashout Successful!</h3>
            <p className="mt-2 text-sm text-emerald-50/90">
              Your cashout has been completed. You can dismiss or send an inquiry.
            </p>

            {showCashoutInquiryPanel && (
              <div className="mt-5 rounded-2xl border border-white/20 bg-black/30 p-4">
                <label className="block text-sm font-semibold text-emerald-100">
                  Inquiry message
                  <textarea
                    value={cashoutInquiryMessage}
                    onChange={(event) => setCashoutInquiryMessage(event.target.value)}
                    className="mt-2 min-h-24 w-full rounded-xl border border-white/20 bg-black/40 px-4 py-3 text-white outline-none focus:border-emerald-200"
                    placeholder="Write your inquiry..."
                  />
                </label>
              </div>
            )}

            <div className="mt-6 flex flex-wrap gap-3">
              <button
                type="button"
                onClick={() => {
                  setShowCashoutSuccessSplash(false);
                  setShowCashoutInquiryPanel(false);
                }}
                className="rounded-xl bg-white/15 px-5 py-3 text-sm font-bold text-white hover:bg-white/25"
              >
                Dismiss
              </button>
              {!showCashoutInquiryPanel ? (
                <button
                  type="button"
                  onClick={() => setShowCashoutInquiryPanel(true)}
                  className="rounded-xl bg-white px-5 py-3 text-sm font-black text-emerald-900 hover:bg-emerald-100"
                >
                  Inquire
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => void handleSendCashoutInquiry()}
                  disabled={sendingCashoutInquiry}
                  className="rounded-xl bg-white px-5 py-3 text-sm font-black text-emerald-900 hover:bg-emerald-100 disabled:opacity-60"
                >
                  {sendingCashoutInquiry ? 'Sending...' : 'Send Inquiry'}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {bonusErrorSplashMessage && (
        <div
          onClick={() => setBonusErrorSplashMessage('')}
          className={`${PLAYER_SPLASH_BACKDROP_CENTER} z-[80] bg-gradient-to-b from-red-950/90 to-black/90`}
        >
          <div
            onClick={(event) => event.stopPropagation()}
            className="w-full max-w-xl rounded-3xl border border-red-300/45 bg-gradient-to-br from-red-800/95 via-rose-950/95 to-black/90 p-7 text-white shadow-2xl shadow-red-900/30 backdrop-blur-xl"
          >
            <p className="text-xs font-black uppercase tracking-[0.28em] text-red-100">
              Bonus Event Failed
            </p>
            <h3 className="mt-3 text-2xl font-black">Can&apos;t initiate bonus event</h3>
            <p className="mt-3 text-sm text-red-100/90">{bonusErrorSplashMessage}</p>
            <button
              type="button"
              onClick={() => setBonusErrorSplashMessage('')}
              className="mt-6 rounded-xl bg-white px-5 py-3 text-sm font-black text-red-800 hover:bg-red-100"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      {earnedRewardSplashCoins !== null && (
        <div
          onClick={() => setEarnedRewardSplashCoins(null)}
          className={`${PLAYER_SPLASH_BACKDROP_CENTER} z-[84] bg-black/90`}
        >
          <div
            onClick={(event) => event.stopPropagation()}
            className="w-full max-w-md rounded-3xl border border-rose-500/45 bg-gradient-to-b from-[#2a0a14] via-[#170710] to-[#0a0408] p-6 text-center shadow-2xl shadow-rose-900/25"
          >
            <p className="text-4xl" aria-hidden>
              🎁
            </p>
            <h3 className="mt-3 text-2xl font-black text-white">Congratulations!</h3>
            <p className="mt-3 text-sm text-rose-100/85">
              You received referral reward coins from this player&apos;s recharge.
            </p>
            <p className="mt-3 text-lg font-black text-emerald-300">
              +{Math.max(0, Number(earnedRewardSplashCoins || 0))} coin added
            </p>
            <button
              type="button"
              onClick={() => setEarnedRewardSplashCoins(null)}
              className="mt-6 rounded-xl bg-white px-5 py-3 text-sm font-black text-rose-800 hover:bg-rose-100"
            >
              Awesome
            </button>
          </div>
        </div>
      )}

      <AnimatePresence>
        {showLogoutConfirmSplash && (
          <motion.div
            key="logout-splash"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[100] flex items-center justify-center bg-black/88 p-4 backdrop-blur-2xl"
            onClick={() => {
              if (!logoutLoading) {
                setShowLogoutConfirmSplash(false);
              }
            }}
            role="dialog"
            aria-modal="true"
            aria-labelledby="logout-confirm-title"
          >
            <motion.div
              initial={{ scale: 0.9, opacity: 0, y: 20 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.96, opacity: 0, y: 12 }}
              transition={{ type: 'spring', damping: 26, stiffness: 320 }}
              onClick={(e) => e.stopPropagation()}
              className="w-full max-w-md rounded-3xl border border-rose-500/40 bg-gradient-to-b from-rose-950/95 via-zinc-950 to-black p-6 shadow-[0_0_60px_-12px_rgba(244,63,94,0.45)] sm:p-8"
            >
              <p className="text-center text-4xl" aria-hidden>
                👋
              </p>
              <h2
                id="logout-confirm-title"
                className="mt-3 text-center text-2xl font-black text-white sm:text-3xl"
              >
                Sign out of VIP Lounge?
              </h2>
              <p className="mt-3 text-center text-sm leading-relaxed text-rose-100/80">
                You can come back anytime with your username and password. The browser
                <span className="font-semibold text-amber-200"> back </span>button alone does
                not sign you out.
              </p>
              <div className="mt-8 flex flex-col gap-3 sm:flex-row-reverse">
                <button
                  type="button"
                  onClick={() => void performLogout()}
                  disabled={logoutLoading}
                  className="min-h-[52px] flex-1 rounded-2xl bg-gradient-to-r from-rose-500 to-rose-700 py-3.5 text-base font-black text-white shadow-lg shadow-rose-500/30 transition hover:brightness-110 disabled:opacity-50"
                >
                  {logoutLoading ? 'Signing out…' : 'Yes, sign out'}
                </button>
                <button
                  type="button"
                  onClick={() => setShowLogoutConfirmSplash(false)}
                  disabled={logoutLoading}
                  className="min-h-[52px] flex-1 rounded-2xl border border-white/20 bg-white/5 py-3.5 text-base font-bold text-amber-100 transition hover:bg-white/10 disabled:opacity-50"
                >
                  Stay playing
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </ProtectedRoute>
  );
}
