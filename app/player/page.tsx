'use client';

import '../../styles/player-fire.css';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MouseEvent, TouchEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { AnimatePresence, motion } from 'motion/react';
import { onAuthStateChanged, signOut } from 'firebase/auth';
import { doc, getDoc, onSnapshot, updateDoc } from 'firebase/firestore';
import imageCompression from 'browser-image-compression';

import ProtectedRoute from '../../components/auth/ProtectedRoute';
import ImageUploadField from '@/components/common/ImageUploadField';

import { auth, db } from '@/lib/firebase/client';
import { belongsToCoadmin, resolveCoadminUid } from '@/lib/coadmin/scope';
import { getStaff } from '@/features/users/adminUsers';
import { getGameLoginsByCoadmin } from '@/features/games/gameLogins';
import {
  listenToPlayerGameLoginsByPlayer,
  type PlayerGameLogin,
} from '@/features/games/playerGameLogins';
import {
  createPlayerGameRequest,
  dismissPlayerRedeemRequest,
  listenToPlayerGameRequestsByPlayer,
  MAX_REDEEM_AMOUNT,
  MIN_REDEEM_AMOUNT,
  PLAYER_GAME_REDEEM_MAX_PER_24H,
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
  PLAYER_CASHOUT_MAX_NPR_PER_24_H,
  createPlayerCashoutTask,
  getPlayerCashoutPaymentDisplay,
  listenPlayerCashoutTasksByPlayer,
  rolling24hCashoutUsageNprFromTasks,
  type PlayerCashoutTask,
} from '@/features/cashouts/playerCashoutTasks';
import {
  BonusEvent,
  getBonusEventsForPlayerDisplay,
  initiateBonusEventPlay,
  listenBonusEventsByCoadmin,
} from '../../features/bonusEvents/bonusEvents';
import { createCashToCoinTransferRequest } from '@/features/risk/playerRisk';
import { usePresenceOnlineMap } from '@/features/presence/userPresence';
import {
  claimMyReferralReward,
  fetchMyReferralRewards,
  type ReferralRewardGroup,
} from '@/features/referrals/playerReferralRewards';
import {
  claimFreeplayGift,
  fetchPendingFreeplayGift,
} from '@/features/freeplay/playerFreeplay';
import {
  getCoadminMaintenanceBreakClient,
  listenCoadminMaintenanceBreak,
} from '@/features/maintenance/maintenanceBreak';
import { normalizeMaintenanceBreak, type MaintenanceBreak } from '@/lib/maintenance/config';
import { endLocalPlayerSession, getPlayerApiHeaders } from '@/features/auth/playerSession';

import { AdminUser, ChatMessage } from '../../components/admin/types';

import type {
  ClipboardToastState,
  ClipboardToastTone,
  CredentialResetModalState,
  GameBackgroundAsset,
  PlayerGameRequestType,
  PlayerView,
  PlayerWallet,
} from './types';

import {
  ACTIVE_TABLE_SPLASH_HISTORY_KEY,
  BONUS_ROTATE_MS,
  CASINO_BACKGROUND_TRACKS,
  DEFAULT_PLAYER_MUSIC_VOLUME,
  GAME_BACKGROUND_IMAGE_BY_KEY,
  MAX_REQUEST_HISTORY_DISPLAY,
  NAV_ITEMS,
  PLAYER_HELP_HINT_MESSAGE,
  PLAYER_MUSIC_STORAGE_KEY,
  PLAYER_SPLASH_BACKDROP,
  PLAYER_SPLASH_BACKDROP_CENTER,
  PLAYER_SPLASH_CARD,
  SWIPE_NAV_VIEWS,
  UNKNOWN_CREATOR_FILTER_KEY,
} from './constants';

import {
  buildCreatorDisplayLabel,
  clampClipboardToastX,
  formatDateTime,
  getGameBackgroundImage,
  getPlayerAlertInfo,
  getPlayerBonusEventDescription,
  getRecentPlayAmountStorageKey,
  getRequestStatusClass,
  getRequestStatusLabel,
  getTimestampMs,
  normalizeBackgroundKey,
  normalizeExternalUrl,
  normalizeGameKey,
  normalizeRecentAmounts,
  sanitizeWholeAmountText,
  sortByNewest,
} from './utils';

import Lobby from './views/Lobby';
import Bonus from './views/Bonus';
import Play from './views/Play';
import Vault from './views/Vault';
import EarnCoins from './views/EarnCoins';
import Agents from './views/Agents';

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


export default function PlayerPage() {
  const router = useRouter();
  const [activeView, setActiveView] = useState<PlayerView>('dashboard');
  const [playerUid, setPlayerUid] = useState('');

  const [agents, setAgents] = useState<AdminUser[]>([]);
  const [selectedAgent, setSelectedAgent] = useState<AdminUser | null>(null);

  const [gameLogins, setGameLogins] = useState<PlayerGameLogin[]>([]);
  const [coadminFrontendLinkByGameKey, setCoadminFrontendLinkByGameKey] = useState<
    Record<string, string>
  >({});
  const [bonusEvents, setBonusEvents] = useState<BonusEvent[]>([]);
  const [usernameCarersByGame, setUsernameCarersByGame] = useState<Record<string, string[]>>({});
  const [creatorNames, setCreatorNames] = useState<Record<string, string>>({});
  const [selectedCreatorUid, setSelectedCreatorUid] = useState<string | null>(null);
  const [playerCoadminUid, setPlayerCoadminUid] = useState('');
  const [visiblePasswords, setVisiblePasswords] = useState<Record<string, boolean>>({});

  const [selectedGameName, setSelectedGameName] = useState('');
  const [gameBackgroundImageByKey, setGameBackgroundImageByKey] = useState<Record<string, string>>(
    GAME_BACKGROUND_IMAGE_BY_KEY
  );
  const [playAmount, setPlayAmount] = useState('');
  const [requestLoading, setRequestLoading] = useState(false);
  const [playRequestSplash, setPlayRequestSplash] = useState<null | {
    type: PlayerGameRequestType;
    gameName: string;
    amountText: string;
  }>(null);
  const [recentPlayAmounts, setRecentPlayAmounts] = useState<string[]>([]);
  const [isPlayAmountEditable, setIsPlayAmountEditable] = useState(false);
  const [showActiveTableSplash, setShowActiveTableSplash] = useState(false);
  const [coinLoading, setCoinLoading] = useState(false);
  const [requestHistory, setRequestHistory] = useState<PlayerGameRequest[]>([]);
  const [dismissRedeemLoadingId, setDismissRedeemLoadingId] = useState<string | null>(null);
  const [redeemDismissSplashRequest, setRedeemDismissSplashRequest] =
    useState<PlayerGameRequest | null>(null);
  const [isBlockedPlayer, setIsBlockedPlayer] = useState(false);
  const [maintenanceBreak, setMaintenanceBreak] = useState<MaintenanceBreak>(
    normalizeMaintenanceBreak(null)
  );
  const [wallet, setWallet] = useState<PlayerWallet>({ coin: 0, cash: 0 });
  const [referralCode, setReferralCode] = useState('');
  const [referredByPlayerName, setReferredByPlayerName] = useState('');
  const [referredByPlayerUid, setReferredByPlayerUid] = useState('');
  const [referralRewardGroups, setReferralRewardGroups] = useState<ReferralRewardGroup[]>([]);
  const [referralRewardsLoading, setReferralRewardsLoading] = useState(false);
  const [claimingReferredPlayerUid, setClaimingReferredPlayerUid] = useState<string | null>(null);
  const [earnedRewardSplashCoins, setEarnedRewardSplashCoins] = useState<number | null>(null);
  const [hasPendingFreeplayGift, setHasPendingFreeplayGift] = useState(false);
  const [pendingFreeplayGiftId, setPendingFreeplayGiftId] = useState('');
  const [claimingFreeplayGift, setClaimingFreeplayGift] = useState(false);
  const [freeplayClaimSuccessMessage, setFreeplayClaimSuccessMessage] = useState('');
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
  const [paymentDetailsNoticeVersion, setPaymentDetailsNoticeVersion] = useState(0);
  const [dismissedPaymentDetailsNoticeVersion, setDismissedPaymentDetailsNoticeVersion] =
    useState(0);
  const [showCashoutInquiryPanel, setShowCashoutInquiryPanel] = useState(false);
  const [cashoutInquiryMessage, setCashoutInquiryMessage] = useState('');
  const [sendingCashoutInquiry, setSendingCashoutInquiry] = useState(false);
  const [showInquirySentToast, setShowInquirySentToast] = useState(false);
  const [activatingBonusEventId, setActivatingBonusEventId] = useState<string | null>(null);
  const [bonusErrorSplashMessage, setBonusErrorSplashMessage] = useState('');
  const [credentialTaskLoadingKey, setCredentialTaskLoadingKey] = useState<string | null>(
    null
  );
  const [credentialResetModal, setCredentialResetModal] =
    useState<CredentialResetModalState>(null);

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
  const referralCodeEnsureInFlightRef = useRef(false);
  const clipboardToastTimerRef = useRef<number | null>(null);
  const rechargeSuccessSplashTimerRef = useRef<number | null>(null);

  const [clipboardToast, setClipboardToast] = useState<ClipboardToastState>(null);
  const [showRechargeSuccessSplash, setShowRechargeSuccessSplash] = useState(false);

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
  const [showBonusPanelHint, setShowBonusPanelHint] = useState(false);
  const [showLogoutConfirmSplash, setShowLogoutConfirmSplash] = useState(false);
  const [logoutLoading, setLogoutLoading] = useState(false);
  const [bonusVanishedToast, setBonusVanishedToast] = useState(false);
  const knownRechargeRequestStatusByIdRef = useRef<Record<string, PlayerGameRequest['status']>>({});
  const seenCompletedRechargeSplashIdsRef = useRef<Set<string>>(new Set());
  const knownRedeemRequestStatusByIdRef = useRef<Record<string, PlayerGameRequest['status']>>({});
  const seenDismissedRedeemSplashIdsRef = useRef<Set<string>>(new Set());
  const bonusSwipeStartXRef = useRef<number | null>(null);
  const activeTableHistoryOpenRef = useRef(false);
  const showActiveTableSplashRef = useRef(false);
  const activeTableSplashContentRef = useRef<HTMLDivElement | null>(null);
  const activeTableAmountInputRef = useRef<HTMLInputElement | null>(null);
  const giftSoundRef = useRef<HTMLAudioElement | null>(null);
  const activeTableSoundRef = useRef<HTMLAudioElement | null>(null);
  const notificationSoundRef = useRef<HTMLAudioElement | null>(null);
  const lastGiftSoundStartedAtRef = useRef(0);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [activeTableKeyboardInset, setActiveTableKeyboardInset] = useState(0);
  const [activeTableViewportHeight, setActiveTableViewportHeight] = useState<number | null>(null);
  const playerHelpHintSeenRef = useRef(false);
  const playerHelpHintHideTimeoutRef = useRef<number | null>(null);
  const playerHelpHintIdleTimeoutRef = useRef<number | null>(null);

  const playSoundEffect = useCallback(
    (
      soundRef: { current: HTMLAudioElement | null },
      source: string,
      volume: number
    ) => {
      const audio = soundRef.current ?? new Audio(source);
      if (!soundRef.current) {
        audio.preload = 'auto';
        soundRef.current = audio;
      }
      if (!audio.paused && !audio.ended) {
        return;
      }

      audioRef.current?.pause();
      if (soundRef !== giftSoundRef) {
        giftSoundRef.current?.pause();
      }
      if (soundRef !== activeTableSoundRef) {
        activeTableSoundRef.current?.pause();
      }
      if (soundRef !== notificationSoundRef) {
        notificationSoundRef.current?.pause();
      }
      audio.volume = volume;
      audio.currentTime = 0;
      void audio.play().catch(() => undefined);
    },
    []
  );

  const playGiftSound = useCallback(() => {
    const now = Date.now();
    if (now - lastGiftSoundStartedAtRef.current < 600) {
      return;
    }
    lastGiftSoundStartedAtRef.current = now;
    playSoundEffect(giftSoundRef, '/gift.mp3', 0.45);
  }, [playSoundEffect]);

  const playTableOpenSound = useCallback(() => {
    const audio = activeTableSoundRef.current;
    if (audio && !audio.paused) {
      audio.pause();
    }
    playSoundEffect(activeTableSoundRef, '/play.mp3', 0.4);
  }, [playSoundEffect]);

  function hasActiveTableSplashHistoryState() {
    const state = window.history.state as Record<string, unknown> | null;
    return Boolean(state?.[ACTIVE_TABLE_SPLASH_HISTORY_KEY]);
  }

  function openActiveTableSplash() {
    playTableOpenSound();
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
    setIsPlayAmountEditable(false);
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

  function updatePlayAmount(value: string) {
    setPlayAmount(sanitizeWholeAmountText(value));
  }

  function selectRecentPlayAmount(value: string) {
    updatePlayAmount(value);
    setIsPlayAmountEditable(false);
    activeTableAmountInputRef.current?.blur();
  }

  function loadRecentPlayAmountsFromStorage(key: string) {
    if (typeof window === 'undefined') {
      return [] as string[];
    }

    try {
      const parsed = JSON.parse(window.localStorage.getItem(key) || '[]');
      return normalizeRecentAmounts(Array.isArray(parsed) ? parsed.map(String) : []);
    } catch {
      return [];
    }
  }

  function saveRecentPlayAmount(taskType: PlayerGameRequestType, amountText: string) {
    if (typeof window === 'undefined') {
      return;
    }

    const amount = sanitizeWholeAmountText(amountText);
    if (!amount) {
      return;
    }

    const scopedKey = getRecentPlayAmountStorageKey(recentPlayAmountPlayerUid, recentPlayAmountGameId, taskType);
    const displayKey = getRecentPlayAmountStorageKey(recentPlayAmountPlayerUid, recentPlayAmountGameId);
    const nextScopedAmounts = normalizeRecentAmounts([
      amount,
      ...loadRecentPlayAmountsFromStorage(scopedKey),
    ]);
    const nextDisplayAmounts =
      displayKey === scopedKey
        ? nextScopedAmounts
        : normalizeRecentAmounts([amount, ...loadRecentPlayAmountsFromStorage(displayKey)]);

    try {
      window.localStorage.setItem(scopedKey, JSON.stringify(nextScopedAmounts));
      if (displayKey !== scopedKey) {
        window.localStorage.setItem(displayKey, JSON.stringify(nextDisplayAmounts));
      }
    } catch {
      // Keep the successful request flow intact if browser storage is unavailable.
    }
    setRecentPlayAmounts(nextDisplayAmounts);
  }

  function clearRecentPlayAmounts() {
    if (typeof window !== 'undefined') {
      const displayKey = getRecentPlayAmountStorageKey(recentPlayAmountPlayerUid, recentPlayAmountGameId);
      const rechargeKey = getRecentPlayAmountStorageKey(
        recentPlayAmountPlayerUid,
        recentPlayAmountGameId,
        'recharge'
      );
      const redeemKey = getRecentPlayAmountStorageKey(
        recentPlayAmountPlayerUid,
        recentPlayAmountGameId,
        'redeem'
      );
      try {
        [displayKey, rechargeKey, redeemKey].forEach((key) => window.localStorage.removeItem(key));
      } catch {
        // Clearing the input should still work if browser storage is unavailable.
      }
    }
    setRecentPlayAmounts([]);
    setPlayAmount('');
    setIsPlayAmountEditable(false);
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
  const panelSwipeStartRef = useRef<{ x: number; y: number } | null>(null);
  const musicEnabledRef = useRef(false);
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

  useEffect(() => {
    return () => {
      [giftSoundRef, activeTableSoundRef, notificationSoundRef].forEach((soundRef) => {
        const audio = soundRef.current;
        if (!audio) {
          return;
        }
        audio.pause();
        audio.src = '';
        soundRef.current = null;
      });
    };
  }, []);

  useEffect(() => {
    if (!playerCoadminUid) {
      setCoadminFrontendLinkByGameKey({});
      return;
    }

    let isCancelled = false;

    async function loadCoadminFrontendLinks() {
      try {
        const coadminGames = await getGameLoginsByCoadmin(playerCoadminUid);
        const nextMap: Record<string, string> = {};
        for (const game of coadminGames) {
          const key = normalizeBackgroundKey(String(game.gameName || ''));
          const frontendLink = normalizeExternalUrl(game.frontendUrl || '');
          if (!key || !frontendLink) {
            continue;
          }
          nextMap[key] = frontendLink;
        }
        if (!isCancelled) {
          setCoadminFrontendLinkByGameKey(nextMap);
        }
      } catch {
        if (!isCancelled) {
          setCoadminFrontendLinkByGameKey({});
        }
      }
    }

    void loadCoadminFrontendLinks();
    return () => {
      isCancelled = true;
    };
  }, [playerCoadminUid]);

  const selectedGameBackgroundImage = useMemo(() => {
    return getGameBackgroundImage(gameBackgroundImageByKey, selectedGameName);
  }, [gameBackgroundImageByKey, selectedGameName]);

  const selectedGameLogin = useMemo(() => {
    const selectedKey = normalizeGameKey(selectedGameName);
    if (!selectedKey) {
      return null;
    }

    return (
      gameLogins.find((login) => normalizeGameKey(String(login.gameName || '')) === selectedKey) ||
      null
    );
  }, [gameLogins, selectedGameName]);

  const recentPlayAmountPlayerUid = playerUid || auth.currentUser?.uid || '';
  const recentPlayAmountGameId = selectedGameLogin?.id || normalizeGameKey(selectedGameName);
  const recentPlayAmountStorageKey = getRecentPlayAmountStorageKey(
    recentPlayAmountPlayerUid,
    recentPlayAmountGameId
  );

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setRecentPlayAmounts(loadRecentPlayAmountsFromStorage(recentPlayAmountStorageKey));
    }, 0);

    return () => window.clearTimeout(timeoutId);
  }, [recentPlayAmountStorageKey]);

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

  const rollingCashoutUsedNpr = useMemo(
    () => rolling24hCashoutUsageNprFromTasks(playerCashoutTasks),
    [playerCashoutTasks]
  );

  const cashoutRemainingQuotaNpr = Math.max(
    0,
    PLAYER_CASHOUT_MAX_NPR_PER_24_H - rollingCashoutUsedNpr
  );

  const cashoutThisRequestNpr = Math.min(Number(wallet.cash || 0), cashoutRemainingQuotaNpr);

  useEffect(() => {
    let isCancelled = false;

    async function loadGameBackgrounds() {
      try {
        const response = await fetch('/api/player/game-backgrounds');
        if (!response.ok) {
          return;
        }
        const payload = (await response.json()) as { backgrounds?: GameBackgroundAsset[] };
        const nextMap: Record<string, string> = { ...GAME_BACKGROUND_IMAGE_BY_KEY };
        for (const item of payload.backgrounds || []) {
          const key = normalizeBackgroundKey(item.key);
          if (!key) {
            continue;
          }
          const imageUrl = String(item.imageUrl || '').trim();
          if (imageUrl.endsWith('.png')) {
            nextMap[key] = imageUrl;
          }
        }
        if (!isCancelled) {
          setGameBackgroundImageByKey(nextMap);
        }
      } catch {
        if (!isCancelled) {
          setGameBackgroundImageByKey(GAME_BACKGROUND_IMAGE_BY_KEY);
        }
      }
    }

    void loadGameBackgrounds();
    return () => {
      isCancelled = true;
    };
  }, []);

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
  useEffect(() => {
    if (!playerUid) {
      knownRechargeRequestStatusByIdRef.current = {};
      seenCompletedRechargeSplashIdsRef.current = new Set();
      knownRedeemRequestStatusByIdRef.current = {};
      seenDismissedRedeemSplashIdsRef.current = new Set();
      return;
    }

    const recentCompletionCutoffMs = Date.now() - 5 * 60 * 1000;
    const nextRechargeStatusById: Record<string, PlayerGameRequest['status']> = {};
    const nextStatusById: Record<string, PlayerGameRequest['status']> = {};

    for (const request of requestHistory) {
      if (request.type === 'recharge') {
        nextRechargeStatusById[request.id] = request.status;
        const previousStatus = knownRechargeRequestStatusByIdRef.current[request.id];
        const completedAtMs = getTimestampMs(request.completedAt);
        const recentlyCompleted = completedAtMs >= recentCompletionCutoffMs;
        const justCompleted =
          request.status === 'completed' &&
          ((previousStatus !== undefined && previousStatus !== 'completed') ||
            (previousStatus === undefined && recentlyCompleted));

        if (justCompleted && !seenCompletedRechargeSplashIdsRef.current.has(request.id)) {
          showRechargeSuccessToast();
          seenCompletedRechargeSplashIdsRef.current.add(request.id);
        }
      }

      if (request.type !== 'redeem') {
        continue;
      }

      nextStatusById[request.id] = request.status;
      const previousStatus = knownRedeemRequestStatusByIdRef.current[request.id];
      const justDismissed = previousStatus && previousStatus !== 'dismissed' && request.status === 'dismissed';
      const shouldShowDismissSplash =
        justDismissed && !seenDismissedRedeemSplashIdsRef.current.has(request.id);

      if (shouldShowDismissSplash) {
        setRedeemDismissSplashRequest(request);
        seenDismissedRedeemSplashIdsRef.current.add(request.id);
      }
    }

    knownRechargeRequestStatusByIdRef.current = nextRechargeStatusById;
    knownRedeemRequestStatusByIdRef.current = nextStatusById;
  }, [playerUid, requestHistory]);

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
  const isTimedSplashAlert = Boolean(playerAlert && playerAlert.variant !== 'index');

  useEffect(() => {
    if (!isTimedSplashAlert) {
      return undefined;
    }

    const timeoutId = window.setTimeout(() => {
      setMessage('');
    }, 1300);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [isTimedSplashAlert, message]);

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
      giftSoundRef.current?.pause();
      activeTableSoundRef.current?.pause();
      notificationSoundRef.current?.pause();
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

  useEffect(() => {
    return () => {
      if (clipboardToastTimerRef.current !== null) {
        clearTimeout(clipboardToastTimerRef.current);
      }
      if (rechargeSuccessSplashTimerRef.current !== null) {
        clearTimeout(rechargeSuccessSplashTimerRef.current);
      }
    };
  }, []);

  function showRechargeSuccessToast() {
    if (rechargeSuccessSplashTimerRef.current !== null) {
      clearTimeout(rechargeSuccessSplashTimerRef.current);
      rechargeSuccessSplashTimerRef.current = null;
    }

    setShowRechargeSuccessSplash(true);
    rechargeSuccessSplashTimerRef.current = window.setTimeout(() => {
      setShowRechargeSuccessSplash(false);
      rechargeSuccessSplashTimerRef.current = null;
    }, 1000);
  }

  function showClipboardToast(
    text: string,
    tone: ClipboardToastTone,
    event: Pick<MouseEvent, 'clientX' | 'clientY'>
  ) {
    if (clipboardToastTimerRef.current !== null) {
      clearTimeout(clipboardToastTimerRef.current);
      clipboardToastTimerRef.current = null;
    }

    const x = clampClipboardToastX(event.clientX);
    const y = event.clientY;
    const placeBelow = y < 52;

    setClipboardToast({ text, tone, x, y, placeBelow });
    clipboardToastTimerRef.current = window.setTimeout(() => {
      setClipboardToast(null);
      clipboardToastTimerRef.current = null;
    }, 2200);
  }

  async function copyCredentialValue(value: string, label: string, event: MouseEvent) {
    const clean = value.trim();

    if (!clean) {
      showClipboardToast(`Nothing to copy for ${label}.`, 'warn', event);
      return;
    }

    try {
      await navigator.clipboard.writeText(clean);
      showClipboardToast('Copied.', 'success', event);
    } catch {
      showClipboardToast('Could not copy.', 'error', event);
    }
  }

  async function handleCopyReferralCode(event: MouseEvent) {
    const code = referralCode.trim();
    if (!code) {
      showClipboardToast('Referral code is not ready yet.', 'warn', event);
      return;
    }

    try {
      await navigator.clipboard.writeText(code);
      showClipboardToast('Copied.', 'success', event);
    } catch {
      showClipboardToast('Could not copy.', 'error', event);
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

  const profile = playerSnap.data() as { role?: string; referralCode?: string };
  if (String(profile.role || '').toLowerCase() !== 'player') {
    return;
  }
  const existingCode = String(profile.referralCode || '').trim();
    if (/^\d{6,10}$/.test(existingCode)) {
      setReferralCode(existingCode);
    }

    referralCodeEnsureInFlightRef.current = true;
    try {
      const currentUser = auth.currentUser;
      if (!currentUser) {
        return;
      }
      const res = await fetch('/api/player/ensure-referral-code', {
        method: 'POST',
        headers: await getPlayerApiHeaders(false),
      });
      const data = (await res.json()) as {
        success?: boolean;
        referralCode?: string;
        error?: string;
      };
      if (data.success && data.referralCode) {
        setReferralCode(String(data.referralCode).trim());
      } else if (data.error && data.error !== 'Only players have referral codes.') {
        console.warn('Referral code ensure failed:', data.error);
      }
    } catch (error) {
      console.error(error);
    } finally {
      referralCodeEnsureInFlightRef.current = false;
    }
  }

  const playNotificationSound = useCallback(() => {
    playSoundEffect(notificationSoundRef, '/urgency-sound.mp3', 0.6);
  }, [playSoundEffect]);

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

  /** Loads carer/game metadata for credential cards (logins come from realtime listener below). */
  const syncCredentialSidecarsForPlayer = useCallback(
    async (currentPlayerUid: string, sortedLogins: PlayerGameLogin[]) => {
      try {
        const carerMapping = await getCompletedUsernameCarersByPlayer(currentPlayerUid);
        setUsernameCarersByGame(carerMapping);

        const creatorUids = [
          ...new Set(
            sortedLogins
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
          error instanceof Error ? error.message : 'Failed to load credential details.'
        );
      }
    },
    []
  );

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      const nextPlayerUid = user?.uid || '';
      setPlayerUid(nextPlayerUid);

      if (!nextPlayerUid) {
        setIsBlockedPlayer(false);
        setWallet({ coin: 0, cash: 0 });
        setPlayerCoadminUid('');
        setPaymentDetailsNoticeVersion(0);
        setDismissedPaymentDetailsNoticeVersion(0);
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
        if (!resolvedCoadminUid) {
          setPaymentDetailsNoticeVersion(0);
        }
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
    if (!playerCoadminUid) {
      setMaintenanceBreak(normalizeMaintenanceBreak(null));
      return;
    }

    return listenCoadminMaintenanceBreak(
      playerCoadminUid,
      setMaintenanceBreak,
      () => setMaintenanceBreak(normalizeMaintenanceBreak(null))
    );
  }, [playerCoadminUid]);

  useEffect(() => {
    if (!playerCoadminUid) {
      return;
    }

    const unsubscribe = onSnapshot(
      doc(db, 'users', playerCoadminUid),
      (snapshot) => {
        if (!snapshot.exists()) {
          setPaymentDetailsNoticeVersion(0);
          return;
        }

        const coadminData = snapshot.data() as {
          paymentDetailsNoticeVersion?: number;
        };
        setPaymentDetailsNoticeVersion(Number(coadminData.paymentDetailsNoticeVersion || 0));
      },
      () => setPaymentDetailsNoticeVersion(0)
    );

    return () => unsubscribe();
  }, [playerCoadminUid]);

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

    setLoadingList(true);
    setMessage('');

    const loaderTimeoutId = window.setTimeout(() => {
      void loadAgents();
    }, 0);

    const unsubscribeLogins = listenToPlayerGameLoginsByPlayer(
      playerUid,
      (list) => {
        const sorted = sortByNewest(list);
        setGameLogins(sorted);
        setLoadingList(false);
        void syncCredentialSidecarsForPlayer(playerUid, sorted);
      },
      (error) => {
        setLoadingList(false);
        setMessage(error.message || 'Failed to listen for credential updates.');
      }
    );

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
      unsubscribeLogins();
      unsubscribeRequests();
    };
  }, [loadAgents, playerUid, syncCredentialSidecarsForPlayer]);

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

    const unsubscribe = onSnapshot(
      doc(db, 'users', playerUid),
      (snapshot) => {
        if (!snapshot.exists()) {
          setWallet({ coin: 0, cash: 0 });
          setIsBlockedPlayer(false);
          return;
        }

        const playerData = snapshot.data() as {
          role?: string;
          status?: string;
          coin?: number;
          cash?: number;
          coadminUid?: string | null;
          createdBy?: string | null;
          referralCode?: string;
          referredByUid?: string;
          referredByUsername?: string;
          referralBonusNotice?: string;
          referralBonusNoticeAt?: unknown;
          dismissedPaymentDetailsNoticeVersion?: number;
        };

        setWallet({
          coin: Number(playerData.coin || 0),
          cash: Number(playerData.cash || 0),
        });
        setDismissedPaymentDetailsNoticeVersion(
          Number(playerData.dismissedPaymentDetailsNoticeVersion || 0)
        );
        const resolvedCoadminUid = resolveCoadminUid({
          uid: playerUid,
          ...playerData,
        });
        if (!resolvedCoadminUid) {
          setPaymentDetailsNoticeVersion(0);
        }
        setPlayerCoadminUid(resolvedCoadminUid ? String(resolvedCoadminUid) : '');
        const isPlayerRole = String(playerData.role || '').toLowerCase() === 'player';
        const nextReferralCode = String(playerData.referralCode || '').trim();
        if (isPlayerRole && /^\d{6,10}$/.test(nextReferralCode)) {
          setReferralCode(nextReferralCode);
        } else if (isPlayerRole) {
          setReferralCode('');
          void ensureCurrentPlayerReferralCode(playerUid);
        } else {
          setReferralCode('');
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
        setDismissedPaymentDetailsNoticeVersion(0);
        setReferralCode('');
        setReferredByPlayerName('');
        setReferredByPlayerUid('');
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

  const loadFreeplayGift = useCallback(async () => {
    if (!playerUid) {
      setHasPendingFreeplayGift(false);
      setPendingFreeplayGiftId('');
      return;
    }
    try {
      const pendingGift = await fetchPendingFreeplayGift();
      setHasPendingFreeplayGift(pendingGift.hasPendingGift);
      setPendingFreeplayGiftId(pendingGift.giftId);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Failed to load FreePlay gift.');
    }
  }, [playerUid]);

  async function handleClaimFreeplayGift() {
    if (!hasPendingFreeplayGift || !pendingFreeplayGiftId || claimingFreeplayGift) {
      return;
    }
    const revealStartedAt = Date.now();
    playGiftSound();
    setClaimingFreeplayGift(true);
    setMessage('');
    try {
      const result = await claimFreeplayGift(pendingFreeplayGiftId);
      const revealTimeRemainingMs = Math.max(0, 450 - (Date.now() - revealStartedAt));
      if (revealTimeRemainingMs > 0) {
        await new Promise<void>((resolve) => {
          window.setTimeout(resolve, revealTimeRemainingMs);
        });
      }
      setHasPendingFreeplayGift(false);
      setPendingFreeplayGiftId('');
      setFreeplayClaimSuccessMessage(
        result.message || `You got ${result.amount} FreePlay coins!`
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Failed to claim FreePlay gift.');
      await loadFreeplayGift();
    } finally {
      setClaimingFreeplayGift(false);
    }
  }

  useEffect(() => {
    if (!freeplayClaimSuccessMessage) {
      return;
    }
    const timeoutId = window.setTimeout(() => {
      setFreeplayClaimSuccessMessage('');
    }, 3000);
    return () => window.clearTimeout(timeoutId);
  }, [freeplayClaimSuccessMessage]);

  useEffect(() => {
    if (activeView !== 'earn-coins') {
      return;
    }
    void loadReferralRewards();
    void loadFreeplayGift();
  }, [activeView, loadFreeplayGift, loadReferralRewards]);

  useEffect(() => {
    if (activeView === 'agents' && playerUid) {
      const nextTimeoutId = window.setTimeout(() => {
        void loadAgents();
      }, 0);
      return () => window.clearTimeout(nextTimeoutId);
    }
    return undefined;
  }, [activeView, loadAgents, playerUid]);

  useEffect(() => {
    if (activeView !== 'play') {
      closeActiveTableSplash();
    }
    if (activeView !== 'usernames') {
      setCredentialResetModal(null);
    }
  }, [activeView]);

  useEffect(() => {
    if (activeView !== 'bonus-events') {
      setShowBonusPanelHint(false);
      return;
    }

    setShowBonusPanelHint(true);
    const timeoutId = window.setTimeout(() => {
      setShowBonusPanelHint(false);
    }, 5000);

    return () => window.clearTimeout(timeoutId);
  }, [activeView]);

  useEffect(() => {
    if (!maintenanceBreak.enabled) {
      return;
    }

    console.info('[MAINTENANCE] blocked player action', {
      playerUid: playerUid || auth.currentUser?.uid || null,
      coadminUid: playerCoadminUid || null,
    });
    closeActiveTableSplash();
    setShowCashoutModal(false);
    setShowLoadCoinPanel(false);
    setShowCoinConfirmSplash(false);
    setPlayRequestSplash(null);
    setRequestLoading(false);
    if (activeView === 'play' || activeView === 'bonus-events' || activeView === 'earn-coins') {
      setActiveView('dashboard');
    }
  }, [activeView, closeActiveTableSplash, maintenanceBreak.enabled, playerCoadminUid, playerUid]);

  async function handleGameRequest(type: PlayerGameRequestType) {
    if (maintenanceBreak.enabled) {
      console.info('[MAINTENANCE] blocked player action', {
        action: type,
        playerUid: playerUid || auth.currentUser?.uid || null,
        coadminUid: playerCoadminUid || null,
      });
      setMessage(maintenanceBreak.message);
      return;
    }

    if (isBlockedPlayer) {
      setMessage(
        'Your account is blocked. Recharge and redeem requests are disabled.'
      );
      return;
    }

    const amountText = sanitizeWholeAmountText(playAmount);
    const amountNum = Number(amountText);
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
    if (type === 'redeem') {
      if (!Number.isFinite(amountNum) || amountNum < MIN_REDEEM_AMOUNT || amountNum > MAX_REDEEM_AMOUNT) {
        setMessage(`Redeem amount must be between ${MIN_REDEEM_AMOUNT} and ${MAX_REDEEM_AMOUNT}.`);
        return;
      }
    }

    closeActiveTableSplash();
    setPlayRequestSplash({
      type,
      gameName: selectedGameName,
      amountText,
    });
    setRequestLoading(true);
    setMessage('');

    try {
      await createPlayerGameRequest({
        gameName: selectedGameName,
        amount: amountNum,
        type,
      });

      saveRecentPlayAmount(type, amountText);
      if (type === 'redeem') {
        setMessage('Redeem request sent.');
      }
      setPlayAmount('');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Request failed.');
    } finally {
      setRequestLoading(false);
      setPlayRequestSplash(null);
    }
  }

  async function performDismissRedeemRequest(request: PlayerGameRequest) {
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

  async function confirmDismissRedeemSplash() {
    const request = redeemDismissSplashRequest;
    if (!request) {
      return;
    }
    try {
      await performDismissRedeemRequest(request);
    } finally {
      setRedeemDismissSplashRequest(null);
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
    const credentialCoadminUid =
      String(gameLogin.coadminUid || '').trim() || String(playerCoadminUid || '').trim();
    const currentMaintenanceBreak =
      maintenanceBreak.enabled || !credentialCoadminUid
        ? maintenanceBreak
        : await getCoadminMaintenanceBreakClient(credentialCoadminUid);
    if (currentMaintenanceBreak.enabled) {
      setMessage(currentMaintenanceBreak.message);
      return;
    }

    const loadingKey = `${taskType}:${gameLogin.id}`;
    setCredentialTaskLoadingKey(loadingKey);
    setMessage('');

    try {
      await createPlayerCredentialTask({
        taskType,
        playerUid: gameLogin.playerUid,
        playerUsername: gameLogin.playerUsername || 'Player',
        gameName: gameLogin.gameName,
        coadminUid: credentialCoadminUid,
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

  function handleChangeView(view: PlayerView, options: { scrollToTop?: boolean } = {}) {
    setActiveView(view);
    setMobileMenuOpen(false);
    setMessage('');
    setSelectedAgent(null);
    setNewMessage('');
    handleClearImage();
    if (options.scrollToTop === false) {
      return;
    }
    // Player page scrolls inside its own container, not only the window.
    requestAnimationFrame(() => {
      pageScrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  }

  function handlePanelTouchStart(event: TouchEvent<HTMLDivElement>) {
    if (event.touches.length !== 1) {
      panelSwipeStartRef.current = null;
      return;
    }

    const touch = event.touches[0];
    panelSwipeStartRef.current = { x: touch.clientX, y: touch.clientY };
  }

  function handlePanelTouchEnd(event: TouchEvent<HTMLDivElement>) {
    const start = panelSwipeStartRef.current;
    panelSwipeStartRef.current = null;
    if (!start || event.changedTouches.length !== 1) {
      return;
    }

    const touch = event.changedTouches[0];
    const deltaX = touch.clientX - start.x;
    const deltaY = touch.clientY - start.y;
    const absX = Math.abs(deltaX);
    const absY = Math.abs(deltaY);

    // Ignore small accidental drags; users often nudge the page while tapping controls.
    const minimumHorizontalSwipePx = 50;
    // Only mostly-horizontal gestures switch panels, preserving normal vertical scrolling.
    const horizontalDominanceRatio = 1.5;
    if (absX < minimumHorizontalSwipePx || absX < absY * horizontalDominanceRatio) {
      return;
    }

    const currentIndex = SWIPE_NAV_VIEWS.indexOf(activeView);
    if (currentIndex === -1) {
      return;
    }

    const nextIndex = deltaX < 0 ? currentIndex + 1 : currentIndex - 1;
    const nextView = SWIPE_NAV_VIEWS[nextIndex];
    if (!nextView) {
      return;
    }

    handleChangeView(nextView, { scrollToTop: false });
  }

  function togglePassword(loginId: string) {
    setVisiblePasswords((previous) => ({
      ...previous,
      [loginId]: !previous[loginId],
    }));
  }

  async function handleCoinButtonClick() {
    if (maintenanceBreak.enabled) {
      console.info('[MAINTENANCE] blocked player action', {
        action: 'cash_to_coin',
        playerUid: playerUid || auth.currentUser?.uid || null,
        coadminUid: playerCoadminUid || null,
      });
      setMessage(maintenanceBreak.message);
      return;
    }

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
      const result = await createCashToCoinTransferRequest(parsedAmount);
      setMessage(result.message);
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : 'Failed to transfer cash to coin.'
      );
    } finally {
      setCoinLoading(false);
    }
  }

  async function handlePlayerCashoutRequest() {
    if (maintenanceBreak.enabled) {
      console.info('[MAINTENANCE] blocked player action', {
        action: 'cashout',
        playerUid: playerUid || auth.currentUser?.uid || null,
        coadminUid: playerCoadminUid || null,
      });
      setMessage(maintenanceBreak.message);
      return;
    }

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
    if (maintenanceBreak.enabled) {
      console.info('[MAINTENANCE] blocked player action', {
        action: 'bonus_event',
        playerUid: playerUid || auth.currentUser?.uid || null,
        coadminUid: playerCoadminUid || null,
      });
      setMessage(maintenanceBreak.message);
      return;
    }

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
      await endLocalPlayerSession('logout');
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
      setShowInquirySentToast(true);
      window.setTimeout(() => setShowInquirySentToast(false), 2500);
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
    if (maintenanceBreak.enabled) {
      console.info('[MAINTENANCE] blocked player action', {
        action: 'coin_load',
        playerUid: playerUid || auth.currentUser?.uid || null,
        coadminUid: playerCoadminUid || null,
      });
      setMessage(maintenanceBreak.message);
      return;
    }

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

  const shouldShowPaymentDetailsNotice =
    paymentDetailsNoticeVersion > 0 &&
    paymentDetailsNoticeVersion > dismissedPaymentDetailsNoticeVersion;

  async function dismissPaymentDetailsNotice() {
    if (!playerUid || paymentDetailsNoticeVersion <= 0) {
      return;
    }

    try {
      await updateDoc(doc(db, 'users', playerUid), {
        dismissedPaymentDetailsNoticeVersion: paymentDetailsNoticeVersion,
      });
      setDismissedPaymentDetailsNoticeVersion(paymentDetailsNoticeVersion);
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : 'Failed to dismiss payment details notice.'
      );
    }
  }

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
                          onClick={() => setRedeemDismissSplashRequest(request)}
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
        className={`group flex w-full items-center justify-between rounded-2xl px-4 py-3 text-left text-[0.98rem] font-bold transition-all duration-200 active:scale-[0.98] md:text-[1.05rem] ${
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
        className="player-fire-page relative z-0 flex min-h-[100dvh] flex-col overflow-y-auto overflow-x-hidden bg-transparent pb-[calc(5.25rem+env(safe-area-inset-bottom))] text-white md:flex-row md:items-start lg:pb-0"
      >
        <div className="ember-overlay" aria-hidden="true" />
        {maintenanceBreak.enabled ? (
          <div
            className="fixed inset-0 z-[220] flex items-center justify-center bg-zinc-950/95 px-4 py-6 text-white backdrop-blur-xl"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="maintenance-break-title"
          >
            <div className="w-full max-w-xl rounded-2xl border border-amber-300/30 bg-black/55 p-6 text-center shadow-2xl shadow-amber-950/30 sm:p-8">
              <p className="text-xs font-black uppercase tracking-[0.28em] text-amber-300/80">
                Maintenance Break
              </p>
              <h1
                id="maintenance-break-title"
                className="mt-3 text-2xl font-black leading-tight text-white sm:text-3xl"
              >
                {maintenanceBreak.title}
              </h1>
              <p className="mt-5 whitespace-pre-line text-sm leading-relaxed text-zinc-200 sm:text-base">
                {maintenanceBreak.message}
              </p>
              <button
                type="button"
                onClick={() => void performLogout()}
                disabled={logoutLoading}
                className="mt-7 min-h-[48px] rounded-xl border border-white/15 bg-white/10 px-5 py-3 text-sm font-bold text-white transition hover:bg-white/15 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {logoutLoading ? 'Logging out...' : 'Logout'}
              </button>
            </div>
          </div>
        ) : null}
        {showPlayerHelpHint && (
          <div className="pointer-events-none fixed left-1/2 top-1/2 z-50 w-[min(92vw,560px)] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-amber-400/25 bg-black/55 px-4 py-3 text-center text-xs font-semibold text-amber-100/80 shadow-[0_0_24px_-10px_rgba(251,191,36,0.65)] backdrop-blur-xl">
            {PLAYER_HELP_HINT_MESSAGE}
          </div>
        )}

        <header className="fire-panel fire-orange sticky top-0 z-30 shrink-0 border-b border-amber-500/20 bg-black/65 px-3 py-2.5 backdrop-blur-2xl md:hidden">
          <div className="grid grid-cols-3 items-center gap-2">
            <div className="flex min-h-[44px] min-w-0 items-center justify-start">
              <button
                type="button"
                onClick={() => setMobileMenuOpen(true)}
                className="flex min-h-[44px] min-w-[72px] shrink-0 items-center justify-center rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 text-sm font-black uppercase tracking-wide text-amber-100"
                aria-label="Open menu"
              >
                ☰ Menu
              </button>
            </div>
            <div className="flex min-w-0 justify-center">
              <div className="w-full rounded-xl border border-amber-400/30 bg-black/35 px-2 py-1.5 text-center shadow-[0_0_20px_-10px_rgba(251,191,36,0.75)]">
                <p className="text-[10px] font-black uppercase tracking-[0.32em] text-amber-300/95">
                  Royal VIP
                </p>
                <p className="mt-0.5 bg-gradient-to-r from-white via-amber-100 to-amber-300 bg-clip-text text-base font-black leading-tight text-transparent drop-shadow-[0_0_10px_rgba(251,191,36,0.35)]">
                  Casino
                </p>
              </div>
            </div>
            <div className="min-w-0 justify-self-end text-right text-sm leading-tight">
              <p className="font-bold text-amber-200">
                🪙 {formatWalletAmount(wallet.coin)}
              </p>
              <p className="font-bold text-emerald-300">
                💵 {formatWalletAmount(wallet.cash)}
              </p>
            </div>
          </div>

          <div className="mt-2 grid w-full grid-cols-3 gap-2">
              <button
                type="button"
                onClick={() => handleChangeView('play')}
                disabled={maintenanceBreak.enabled}
                className="fire-button fire-orange min-h-[48px] scale-[1.04] rounded-xl border border-red-200/80 bg-gradient-to-r from-red-500 via-red-400 to-rose-500 px-2 text-sm font-black text-white shadow-[0_0_34px_-6px_rgba(239,68,68,0.9)] transition-transform hover:scale-[1.1] hover:brightness-110 active:scale-[1.03]"
              >
              🎰 Play
            </button>
            <button
                type="button"
                onClick={() => setShowCashoutModal(true)}
                disabled={wallet.cash <= 0 || isBlockedPlayer || maintenanceBreak.enabled}
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
              disabled={coinLoading || maintenanceBreak.enabled}
              className="fire-button fire-orange min-h-[40px] rounded-xl border border-emerald-400/35 bg-emerald-500/15 px-2 text-sm font-bold text-emerald-100 disabled:opacity-50"
            >
              {coinLoading ? '⏳' : '🪙 To coin'}
            </button>
          </div>
        </header>

        <button
          type="button"
          onClick={() => setMusicEnabled((previous) => !previous)}
          className="fixed bottom-[calc(5.75rem+env(safe-area-inset-bottom))] right-3 z-40 inline-flex h-10 w-10 items-center justify-center rounded-full border border-amber-400/35 bg-black/70 text-lg text-amber-100 shadow-[0_0_24px_-10px_rgba(234,179,8,0.7)] backdrop-blur-xl transition hover:border-amber-300/60 hover:bg-black/80 lg:bottom-4 lg:right-4"
          aria-pressed={musicEnabled}
          aria-label={musicEnabled ? 'Turn music off' : 'Turn music on'}
          title={musicEnabled ? 'Turn music off' : 'Turn music on'}
        >
          <span className="relative inline-flex h-5 w-5 items-center justify-center" aria-hidden>
            <span className={musicEnabled ? 'text-amber-100' : 'text-amber-100/80'}>♪</span>
            {!musicEnabled ? (
              <span className="pointer-events-none absolute inset-[-8px] flex items-center justify-center">
                <span className="block h-[3px] w-[150%] rotate-[-42deg] rounded-full bg-red-500 shadow-[0_0_10px_rgba(239,68,68,0.75)]" />
              </span>
            ) : null}
          </span>
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
                className="fixed inset-0 z-40 bg-black/75 backdrop-blur-md md:hidden"
                onClick={() => setMobileMenuOpen(false)}
              />
              <motion.aside
                initial={{ opacity: 0, y: -20, scale: 0.98 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -20, scale: 0.98 }}
                transition={{ type: 'spring', damping: 24, stiffness: 280 }}
                className="fixed inset-y-0 left-0 z-50 flex h-screen w-screen max-w-[17.6rem] flex-col overflow-hidden rounded-none rounded-r-3xl border-r border-amber-500/30 bg-[#0a0612]/97 shadow-2xl shadow-purple-900/40 backdrop-blur-2xl md:hidden"
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
                    {NAV_ITEMS.map((item) => (
                      <div key={item.view} className="space-y-1.5">
                        {renderNavButton(item, item.view === 'agents' ? totalUnread : 0, () => {
                          if (item.view === 'agents' && totalUnread > 0) {
                            handleOpenFirstUnreadAgent();
                            setMobileMenuOpen(false);
                            return;
                          }
                          handleChangeView(item.view);
                        })}
                        {item.view === 'usernames' ? (
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
                        ) : null}
                      </div>
                    ))}
                  </nav>
                </div>
              </motion.aside>
            </>
          ) : null}
        </AnimatePresence>

        <aside className="fire-panel fire-orange relative z-20 hidden w-72 shrink-0 overflow-y-auto border-r border-amber-500/25 bg-black/45 p-5 backdrop-blur-2xl md:block xl:w-80">
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
              {NAV_ITEMS.map((item) => (
                <div key={item.view} className="space-y-2">
                  {renderNavButton(item, item.view === 'agents' ? totalUnread : 0, () => {
                    if (item.view === 'agents' && totalUnread > 0) {
                      handleOpenFirstUnreadAgent();
                      return;
                    }
                    handleChangeView(item.view);
                  })}
                  {item.view === 'usernames' ? (
                    <button
                      type="button"
                      onClick={() => setShowLogoutConfirmSplash(true)}
                      className="w-full rounded-2xl border border-rose-500/40 bg-rose-950/40 py-3.5 text-sm font-bold text-rose-100 transition hover:bg-rose-500/15"
                    >
                      Log out
                    </button>
                  ) : null}
                </div>
              ))}
            </nav>
          </div>
        </aside>

        <section className="relative z-10 flex min-h-0 w-full min-w-0 flex-1 flex-col md:min-h-0">
          <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_15%_0%,rgba(250,204,21,0.09),transparent_40%),radial-gradient(circle_at_90%_15%,rgba(168,85,247,0.12),transparent_35%),radial-gradient(circle_at_50%_100%,rgba(220,38,38,0.06),transparent_45%)]" />
          <div className="pointer-events-none absolute top-0 right-0 h-72 w-72 rounded-full bg-amber-500/10 blur-3xl" />

          <div className="relative z-10 flex min-h-0 flex-1 flex-col">
            <div
              className="flex min-h-0 flex-1 flex-col overflow-x-hidden px-3 pb-4 pt-4 md:px-7 md:pb-8 md:pt-6"
              onTouchStart={handlePanelTouchStart}
              onTouchEnd={handlePanelTouchEnd}
            >
              {activeView === 'dashboard' ? (
              <>
              <div className="player-lobby-action-grid relative z-20 mb-4 hidden shrink-0 gap-2 md:grid md:gap-2.5 lg:gap-3">
                <div className="fire-panel fire-orange rounded-2xl border border-amber-300/60 bg-gradient-to-br from-amber-400/35 to-yellow-500/20 px-4 py-3 text-right shadow-lg shadow-amber-400/25 md:px-4 md:py-3 lg:px-5">
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
                  className="fire-button fire-purple rounded-2xl border border-fuchsia-300/45 bg-gradient-to-r from-fuchsia-600 via-violet-500 to-purple-600 px-3 py-3 text-xs font-black leading-tight text-white shadow-[0_0_26px_-10px_rgba(192,38,211,0.9)] transition-all hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60 md:px-4 lg:px-5 lg:text-base"
                >
                  {coinLoading ? '⏳ Transferring…' : '⇄ Transfer Cash → Coin'}
                </button>

                <button
                  type="button"
                  onClick={() => {
                    setShowLoadCoinPanel(true);
                    setMessage('');
                  }}
                  disabled={isBlockedPlayer || maintenanceBreak.enabled}
                  className="fire-button fire-orange rounded-2xl border border-amber-400/45 bg-amber-500/20 px-3 py-3 text-sm font-black text-amber-50 shadow-md transition-all hover:bg-amber-500/35 disabled:cursor-not-allowed disabled:opacity-60 lg:px-5 lg:text-base"
                >
                  ⬇ Load coin
                </button>

                <div className="fire-panel fire-green rounded-2xl border border-emerald-300/60 bg-gradient-to-br from-emerald-400/35 to-emerald-700/25 px-4 py-3 text-right shadow-lg shadow-emerald-400/25 md:px-4 lg:px-5">
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
                  disabled={wallet.cash <= 0 || isBlockedPlayer || maintenanceBreak.enabled}
                  className="fire-button fire-orange rounded-2xl border border-amber-400/45 bg-amber-500/20 px-3 py-3 text-sm font-black text-amber-50 shadow-md transition-all hover:bg-amber-500/35 disabled:cursor-not-allowed disabled:opacity-60 lg:px-5 lg:text-base"
                >
                  💸 Cashout
                </button>
                <button
                  type="button"
                  onClick={() => setActiveView('play')}
                  disabled={maintenanceBreak.enabled}
                  className="fire-button fire-orange rounded-2xl border border-red-200/70 bg-gradient-to-r from-red-500 via-red-400 to-rose-500 px-3 py-3 text-sm font-black text-white shadow-[0_0_26px_-10px_rgba(239,68,68,0.9)] transition-all hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60 lg:px-5 lg:text-base"
                >
                  🎰 Play
                </button>
              </div>

              <div className="relative z-20 mb-4 grid shrink-0 grid-cols-3 gap-2 md:hidden">
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
                  disabled={coinLoading || maintenanceBreak.enabled}
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
                  disabled={isBlockedPlayer || maintenanceBreak.enabled}
                  className="fire-button fire-purple min-h-[44px] rounded-2xl border border-fuchsia-300/45 bg-gradient-to-r from-fuchsia-600 via-violet-500 to-purple-600 px-2 py-2 text-xs font-black text-white shadow-[0_0_24px_-12px_rgba(192,38,211,0.95)] active:scale-[0.99] hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  ⬇ Load coin
                </button>
                <button
                  type="button"
                  onClick={() => setShowCashoutModal(true)}
                  disabled={wallet.cash <= 0 || isBlockedPlayer || maintenanceBreak.enabled}
                  className="fire-button fire-orange min-h-[44px] rounded-2xl border border-amber-400/45 bg-amber-500/20 px-2 py-2 text-xs font-black text-amber-50 active:scale-[0.99] disabled:opacity-60"
                >
                  💸 Cashout
                </button>
                <button
                  type="button"
                  onClick={() => setActiveView('play')}
                  disabled={maintenanceBreak.enabled}
                  className="fire-button fire-orange min-h-[44px] rounded-2xl border border-red-200/70 bg-gradient-to-r from-red-500 via-red-400 to-rose-500 px-2 py-2 text-xs font-black text-white shadow-[0_0_24px_-12px_rgba(239,68,68,0.95)] active:scale-[0.99] hover:brightness-110 disabled:opacity-60"
                >
                  🎰 Play
                </button>
              </div>
              </>
              ) : null}

              {playerAlert ? (
                <motion.div
                  initial={
                    playerAlert.variant === 'index'
                      ? { opacity: 0, y: -10 }
                      : { opacity: 0, scale: 0.94, y: -24 }
                  }
                  animate={{ opacity: 1, scale: 1, y: 0 }}
                  className={
                    playerAlert.variant === 'index'
                      ? 'fire-panel fire-orange mb-4 rounded-2xl border border-amber-400/50 bg-gradient-to-br from-amber-950/90 via-[#1a1008] to-black/80 p-4 shadow-xl backdrop-blur-md sm:p-5'
                      : playerAlert.variant === 'success'
                        ? 'fixed left-1/2 top-1/2 z-[130] w-[min(92vw,32rem)] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-3xl border border-emerald-300/45 bg-gradient-to-br from-emerald-700/95 via-emerald-900/95 to-black/90 p-7 text-white shadow-[0_0_0_100vmax_rgba(6,95,70,0.38),0_24px_70px_-18px_rgba(6,78,59,0.92)] backdrop-blur-xl md:left-[calc(18rem+(100vw-18rem)/2)] md:w-[min(calc((100vw-18rem)*0.6),42rem)] xl:left-[calc(20rem+(100vw-20rem)/2)] xl:w-[min(calc((100vw-20rem)*0.6),46rem)]'
                        : 'fixed left-1/2 top-1/2 z-[130] w-[min(92vw,32rem)] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-3xl border border-red-300/45 bg-gradient-to-br from-red-800/95 via-rose-950/95 to-black/90 p-7 text-white shadow-[0_0_0_100vmax_rgba(127,29,29,0.55),0_24px_70px_-18px_rgba(127,29,29,0.95)] backdrop-blur-xl md:left-[calc(18rem+(100vw-18rem)/2)] md:w-[min(calc((100vw-18rem)*0.6),42rem)] xl:left-[calc(20rem+(100vw-20rem)/2)] xl:w-[min(calc((100vw-20rem)*0.6),46rem)]'
                  }
                >
                  <div className="flex items-start justify-between gap-3">
                    <h3 className="text-2xl font-black text-white">
                      {playerAlert.variant === 'index'
                        ? '⚙️ '
                        : playerAlert.variant === 'lowCoin'
                          ? '🪙 '
                          : '⚠️ '}
                      {playerAlert.variant === 'index'
                        ? playerAlert.title
                        : playerAlert.variant === 'success'
                          ? playerAlert.title
                          : 'Warning'}
                    </h3>
                    <button
                      type="button"
                      onClick={() => setMessage('')}
                      className={
                        playerAlert.variant === 'index'
                          ? 'shrink-0 rounded-lg border border-white/15 bg-white/5 px-2.5 py-1 text-sm font-bold text-white/80 hover:bg-white/10'
                          : playerAlert.variant === 'success'
                            ? 'shrink-0 rounded-xl bg-white px-4 py-2 text-sm font-black text-emerald-800 hover:bg-emerald-100'
                            : 'shrink-0 rounded-xl bg-white px-4 py-2 text-sm font-black text-red-800 hover:bg-red-100'
                      }
                      aria-label="Dismiss alert"
                    >
                      ✕
                    </button>
                  </div>
                  <p
                    className={`mt-2 text-base leading-relaxed sm:text-[1.05rem] ${
                      playerAlert.variant === 'index'
                        ? 'text-amber-50/90'
                        : playerAlert.variant === 'success'
                          ? 'text-emerald-50'
                          : 'text-red-50'
                    }`}
                  >
                    {playerAlert.body}
                  </p>
                  {playerAlert.variant === 'index' ? (
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
                  ) : null}
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
            {activeView === 'dashboard' && <Lobby activatingBonusEventId={activatingBonusEventId} activeBonusCarouselIndex={activeBonusCarouselIndex} agents={agents} bonusStripPaused={bonusStripPaused} bonusVanishedToast={bonusVanishedToast} formatWalletAmount={formatWalletAmount} gameLogins={gameLogins} handleActivateBonusEvent={handleActivateBonusEvent} handleCopyReferralCode={handleCopyReferralCode} handleOpenFirstUnreadAgent={handleOpenFirstUnreadAgent} isBlockedPlayer={isBlockedPlayer} maintenanceBreak={maintenanceBreak} playerBonusEvents={playerBonusEvents} referralCode={referralCode} setActiveView={setActiveView} setBonusCarouselIndex={setBonusCarouselIndex} setBonusStripPaused={setBonusStripPaused} setMessage={setMessage} setShowLoadCoinPanel={setShowLoadCoinPanel} totalUnread={totalUnread} wallet={wallet} />}

            {activeView === 'bonus-events' && <Bonus activatingBonusEventId={activatingBonusEventId} activeBonusCarouselIndex={activeBonusCarouselIndex} bonusSwipeStartXRef={bonusSwipeStartXRef} bonusVanishedToast={bonusVanishedToast} handleActivateBonusEvent={handleActivateBonusEvent} maintenanceBreak={maintenanceBreak} playerBonusEvents={playerBonusEvents} setBonusCarouselIndex={setBonusCarouselIndex} setBonusStripPaused={setBonusStripPaused} showBonusPanelHint={showBonusPanelHint} />}

            {/* PLAY VIEW */}
            {activeView === 'play' && <Play copyCredentialValue={copyCredentialValue} gameBackgroundImageByKey={gameBackgroundImageByKey} gameLogins={gameLogins} loadingList={loadingList} openActiveTableSplash={openActiveTableSplash} selectedGameName={selectedGameName} setSelectedGameName={setSelectedGameName} togglePassword={togglePassword} visiblePasswords={visiblePasswords} />}

            {/* USERNAMES VIEW */}
            {activeView === 'usernames' && <Vault coadminFrontendLinkByGameKey={coadminFrontendLinkByGameKey} copyCredentialValue={copyCredentialValue} creatorNames={creatorNames} credentialTaskLoadingKey={credentialTaskLoadingKey} gameBackgroundImageByKey={gameBackgroundImageByKey} gameLogins={gameLogins} loadingList={loadingList} openCredentialResetModal={openCredentialResetModal} selectedCreatorUid={selectedCreatorUid} setSelectedCreatorUid={setSelectedCreatorUid} togglePassword={togglePassword} usernameCarersByGame={usernameCarersByGame} usernamesCreatorFilterKeys={usernamesCreatorFilterKeys} usernamesVisibleLogins={usernamesVisibleLogins} visiblePasswords={visiblePasswords} />}

            {/* EARN COINS VIEW */}
            {activeView === 'earn-coins' && <EarnCoins claimingFreeplayGift={claimingFreeplayGift} claimingReferredPlayerUid={claimingReferredPlayerUid} freeplayClaimSuccessMessage={freeplayClaimSuccessMessage} handleClaimFreeplayGift={handleClaimFreeplayGift} handleClaimReferralReward={handleClaimReferralReward} hasPendingFreeplayGift={hasPendingFreeplayGift} referralRewardGroups={referralRewardGroups} referralRewardsLoading={referralRewardsLoading} referredByPlayerName={referredByPlayerName} />}

            {/* AGENTS VIEW - ReachOutView integration remains the same but styled via the prop structure */}
            {activeView === 'agents' && <Agents agentOnlineByUid={agentOnlineByUid} agents={agents} agentsScrollRef={agentsScrollRef} handleAgentSelect={handleAgentSelect} handleClearImage={handleClearImage} handleImageSelect={handleImageSelect} handleSendMessage={handleSendMessage} imagePreview={imagePreview} messages={messages} newMessage={newMessage} pagedAgentChat={pagedAgentChat} selectedAgent={selectedAgent} sendingImage={sendingImage} setNewMessage={setNewMessage} unreadCounts={unreadCounts} />}
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
          className={`fixed bottom-[calc(5.75rem+env(safe-area-inset-bottom))] left-4 z-[60] h-12 w-12 items-center justify-center rounded-full border border-emerald-300/50 bg-emerald-500/20 text-2xl shadow-lg shadow-emerald-500/30 backdrop-blur-sm transition hover:bg-emerald-500/30 lg:bottom-4 lg:left-4 lg:inline-flex ${
            mobileMenuOpen ? 'inline-flex' : 'hidden'
          }`}
          aria-label="Open player chat"
          title="Chat with online players"
          onClick={() => setMobileMenuOpen(false)}
        >
          💬
        </Link>
      </main>

      {clipboardToast ? (
        <motion.div
          initial={{ opacity: 0, scale: 0.94 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.18 }}
          className={`pointer-events-none fixed z-[200] max-w-[min(220px,calc(100vw-16px))] whitespace-normal rounded-lg border px-3 py-1.5 text-center text-xs font-bold shadow-lg backdrop-blur-md ${
            clipboardToast.tone === 'success'
              ? 'border-emerald-400/60 bg-emerald-600/90 text-emerald-50 shadow-emerald-950/40'
              : clipboardToast.tone === 'warn'
                ? 'border-amber-400/55 bg-amber-950/92 text-amber-50'
                : 'border-rose-400/55 bg-rose-950/92 text-rose-50'
          }`}
          style={{
            left: clipboardToast.x,
            top: clipboardToast.y,
            transform: clipboardToast.placeBelow
              ? 'translate(-50%, 14px)'
              : 'translate(-50%, calc(-100% - 14px))',
          }}
          role="status"
          aria-live="polite"
        >
          {clipboardToast.text}
        </motion.div>
      ) : null}

      <AnimatePresence>
        {showRechargeSuccessSplash ? (
          <motion.div
            className="pointer-events-none fixed inset-0 z-[210] flex items-center justify-center px-4"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.14 }}
            role="status"
            aria-live="polite"
          >
            <motion.div
              initial={{ opacity: 0, y: 12, scale: 0.92 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -8, scale: 0.96 }}
              transition={{ duration: 0.18, ease: 'easeOut' }}
              className="w-[min(92vw,23rem)] overflow-hidden rounded-3xl border border-emerald-200/55 bg-gradient-to-br from-emerald-400/95 via-green-600/95 to-emerald-950/95 px-5 py-4 text-center text-white shadow-[0_0_44px_-8px_rgba(16,185,129,0.95),0_22px_60px_-24px_rgba(6,78,59,0.95)] backdrop-blur-xl sm:px-6 sm:py-5"
            >
              <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl border border-white/35 bg-white/20 text-3xl shadow-[0_0_24px_rgba(187,247,208,0.55)]">
                ✓
              </div>
              <p className="mt-3 text-lg font-black leading-tight text-white sm:text-xl">
                ✅ Recharge Successful
              </p>
              <p className="mt-1 text-sm font-semibold text-emerald-50/85">
                Coins added to your Game
              </p>
            </motion.div>
          </motion.div>
        ) : null}
      </AnimatePresence>

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
          className="fixed inset-0 z-[74] flex items-end justify-center bg-gradient-to-b from-[#24351f]/82 via-[#1b2a19]/82 to-[#14170d]/88 px-3 pt-4 backdrop-blur-xl sm:px-4"
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
            className="relative flex min-h-0 w-full max-w-lg flex-col overflow-hidden rounded-[28px] border border-amber-400/35 bg-gradient-to-b from-zinc-900/82 to-zinc-950/92 shadow-2xl shadow-amber-900/25 backdrop-blur-xl sm:rounded-3xl"
            style={{
              maxHeight: activeTableViewportHeight
                ? `${Math.max(320, activeTableViewportHeight - 16)}px`
                : 'calc(100dvh - 1rem)',
              ...(selectedGameBackgroundImage
                ? {
                    backgroundImage: `linear-gradient(180deg, rgba(0, 0, 0, 0.08) 0%, rgba(0, 0, 0, 0.28) 100%), url("${selectedGameBackgroundImage}")`,
                    backgroundSize: '100% 100%',
                    backgroundPosition: 'center',
                    backgroundRepeat: 'no-repeat',
                    filter: 'brightness(1.35) saturate(1.18)',
                  }
                : {}),
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
                  onChange={(event) => updatePlayAmount(event.target.value)}
                  onPointerDown={(event) => {
                    event.currentTarget.readOnly = false;
                    setIsPlayAmountEditable(true);
                  }}
                  onFocus={() => {
                    setIsPlayAmountEditable(true);
                    nudgeActiveTableForKeyboard();
                  }}
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  enterKeyHint="done"
                  autoComplete="off"
                  readOnly={!isPlayAmountEditable}
                  placeholder="Enter amount in USD"
                  className="min-h-[52px] w-full rounded-2xl border border-amber-400/40 bg-black/70 px-4 py-3 text-lg text-white outline-none focus:border-amber-300 focus:ring-2 focus:ring-amber-400/30"
                />
                <div className="mt-3 flex flex-wrap gap-2 sm:hidden">
                  {recentPlayAmounts.map((amount, index) => (
                    <button
                      key={amount}
                      type="button"
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => selectRecentPlayAmount(amount)}
                      className={`min-h-[36px] rounded-full border px-3 text-sm font-black text-white shadow-[0_0_18px_-6px_rgba(249,115,22,0.9)] ${
                        index === 0
                          ? 'border-orange-100 bg-gradient-to-r from-orange-400 via-orange-500 to-amber-400'
                          : 'border-orange-200/80 bg-orange-500'
                      }`}
                    >
                      {index === 0 ? `Last: ${amount}` : amount}
                    </button>
                  ))}
                  {recentPlayAmounts.length > 0 ? (
                    <button
                      type="button"
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={clearRecentPlayAmounts}
                      className="min-h-[36px] rounded-full border border-rose-300/35 bg-rose-500/15 px-3 text-sm font-black text-rose-100"
                    >
                      Clear
                    </button>
                  ) : null}
                </div>
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
                <p className="mt-2 text-xs leading-relaxed text-rose-100/70">
                  Redeem limit is {PLAYER_GAME_REDEEM_MAX_PER_24H} per game in a rolling 24-hour
                  window. The timer resets as older redeems leave that game&apos;s window.
                </p>
                <p className="mt-2 text-xs leading-relaxed text-amber-100/70">
                  Redeem requests must be between {MIN_REDEEM_AMOUNT} and {MAX_REDEEM_AMOUNT}.
                </p>
                {playAmount &&
                Number.isFinite(Number(playAmount)) &&
                Number(playAmount) > 0 &&
                (Number(playAmount) < MIN_REDEEM_AMOUNT ||
                  Number(playAmount) > MAX_REDEEM_AMOUNT) ? (
                  <p className="mt-2 text-sm font-bold text-rose-300">
                    Redeem amount must be between {MIN_REDEEM_AMOUNT} and {MAX_REDEEM_AMOUNT}.
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
                    maintenanceBreak.enabled ||
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
                    isBlockedPlayer ||
                    maintenanceBreak.enabled ||
                    !Number.isFinite(Number(playAmount)) ||
                    Number(playAmount) < MIN_REDEEM_AMOUNT ||
                    Number(playAmount) > MAX_REDEEM_AMOUNT
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
                  disabled={
                    coinLoadBusy ||
                    !playerCoadminUid ||
                    isBlockedPlayer ||
                    maintenanceBreak.enabled
                  }
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
                      onClick={async (e) => {
                        try {
                          await navigator.clipboard.writeText(activeCoinLoad.hashCode);
                          showClipboardToast('Copied.', 'success', e);
                        } catch {
                          showClipboardToast('Could not copy.', 'error', e);
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
          className="fixed inset-0 z-[73] flex items-end justify-center bg-black/82 px-3 pt-4 backdrop-blur-xl sm:items-center sm:p-4"
        >
          <div
            onClick={(event) => event.stopPropagation()}
            className="fire-panel fire-green max-h-[100svh] w-full max-w-lg overflow-y-auto overscroll-contain rounded-t-3xl border border-amber-400/25 bg-gradient-to-b from-[#121018] via-zinc-950/98 to-black text-white shadow-2xl shadow-amber-500/10 sm:max-h-[calc(100dvh-2rem)] sm:max-w-2xl sm:rounded-3xl"
          >
            <div className="p-6 sm:p-7">
            <h3 className="text-2xl font-black">Player Cashout</h3>
            <p className="mt-2 text-sm text-cyan-100/80">
              You can cash out up to ${formatWalletAmount(PLAYER_CASHOUT_MAX_NPR_PER_24_H)} in a rolling 24-hour window
              (excluding declined requests). Anything above that stays in your cash balance until the
              window allows more.
            </p>
            <p className="mt-4 rounded-xl border border-cyan-300/30 bg-cyan-500/10 px-4 py-3 text-sm text-cyan-100">
              <span className="block">
                This request amount: ${formatWalletAmount(cashoutThisRequestNpr)}{' '}
                {Number(wallet.cash || 0) > cashoutThisRequestNpr ? (
                  <span className="text-cyan-200/85">
                    (${formatWalletAmount(wallet.cash)} available; rest stays until quota opens)
                  </span>
                ) : null}
              </span>
              <span className="mt-2 block text-xs text-cyan-200/80">
                Window used: ${formatWalletAmount(rollingCashoutUsedNpr)} / $
                {formatWalletAmount(PLAYER_CASHOUT_MAX_NPR_PER_24_H)}
              </span>
            </p>

            {cashoutThisRequestNpr <= 0 && Number(wallet.cash || 0) > 0 ? (
              <p className="mt-3 rounded-xl border border-amber-400/35 bg-amber-500/15 px-4 py-3 text-sm font-semibold text-amber-100">
                You already used this 24-hour allowance. More opens as older requests exit the window—no
                fixed clock. Your cash stays in your wallet until then.
              </p>
            ) : null}

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
            </div>

            <div className="sticky bottom-0 flex gap-3 border-t border-white/10 bg-black/90 px-6 pb-[calc(24px+env(safe-area-inset-bottom))] pt-4 backdrop-blur-xl sm:px-7 sm:pb-7">
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
                disabled={cashoutLoading || cashoutThisRequestNpr <= 0}
                className="fire-button fire-green flex-1 rounded-xl bg-cyan-400 px-4 py-3 text-sm font-black text-black hover:bg-cyan-300 disabled:opacity-60"
              >
                {cashoutLoading ? 'Sending...' : 'Send Cashout'}
              </button>
            </div>
          </div>
        </div>
      )}

      {shouldShowPaymentDetailsNotice && (
        <div
          onClick={() => void dismissPaymentDetailsNotice()}
          className={`${PLAYER_SPLASH_BACKDROP_CENTER} z-[78] bg-black/85`}
          role="dialog"
          aria-modal="true"
          aria-labelledby="payment-details-notice-title"
        >
          <div
            onClick={(event) => event.stopPropagation()}
            className="fire-panel fire-purple w-full max-w-lg rounded-3xl border border-violet-300/45 bg-gradient-to-br from-violet-950 via-zinc-950 to-black p-7 text-center text-white shadow-2xl shadow-violet-900/30 backdrop-blur-xl"
          >
            <p className="text-xs font-black uppercase tracking-[0.26em] text-violet-100/80">
              Payment Update
            </p>
            <h3 id="payment-details-notice-title" className="mt-3 text-2xl font-black">
              Payment details changed
            </h3>
            <p className="mt-4 text-sm leading-relaxed text-violet-50/90">
              Payment details for loading coins has been changed. Please click on Load Coin to see
              the latest payment details.
            </p>
            <button
              type="button"
              onClick={() => void dismissPaymentDetailsNotice()}
              className="fire-button fire-purple mt-7 w-full rounded-2xl bg-white px-4 py-3 text-sm font-black uppercase text-violet-950 hover:bg-violet-50"
            >
              Got it
            </button>
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

      <AnimatePresence>
        {showInquirySentToast ? (
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            transition={{ duration: 0.25 }}
            className="fixed left-1/2 top-[calc(4.75rem+env(safe-area-inset-top))] z-[130] w-[min(92vw,460px)] -translate-x-1/2 rounded-2xl border border-emerald-400/45 bg-emerald-500/20 px-4 py-3 text-center text-sm font-bold text-emerald-100 shadow-[0_0_26px_-8px_rgba(52,211,153,0.85)] backdrop-blur-xl"
          >
            Inquiry sent successfully. Staff and coadmin have been notified.
          </motion.div>
        ) : null}
      </AnimatePresence>

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

      {redeemDismissSplashRequest ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="redeem-dismiss-splash-title"
          onClick={() => {
            if (dismissRedeemLoadingId === redeemDismissSplashRequest.id) {
              return;
            }
            setRedeemDismissSplashRequest(null);
          }}
          className="fixed inset-0 z-[125] flex items-center justify-center bg-red-900/95 px-4 backdrop-blur-sm"
        >
          <div
            onClick={(event) => event.stopPropagation()}
            className="w-full max-w-lg rounded-3xl border border-red-300/50 bg-gradient-to-b from-red-950 to-red-900 p-8 shadow-2xl shadow-black/40"
          >
            {redeemDismissSplashRequest.status === 'dismissed' ? (
              <>
                <p className="text-center text-4xl font-black text-red-100">!</p>
                <h3
                  id="redeem-dismiss-splash-title"
                  className="mt-2 text-center text-2xl font-black text-white"
                >
                  Redeem request dismissed
                </h3>
                <p className="mt-5 text-center text-base leading-relaxed text-red-50/95">
                  A staff member marked this redeem request as fake or mistaken and removed it from
                  the pending queue.
                </p>
                <p className="mt-4 text-center text-sm leading-relaxed text-red-100/85">
                  If this was an error, contact support with your request amount and game details.
                </p>
                <div className="mt-8 flex justify-center">
                  <button
                    type="button"
                    onClick={() => setRedeemDismissSplashRequest(null)}
                    className="w-full rounded-xl bg-white px-4 py-3 text-sm font-black uppercase tracking-wide text-red-900 hover:bg-red-50 sm:w-auto sm:min-w-48"
                  >
                    Okay
                  </button>
                </div>
              </>
            ) : (
              <>
            <p className="text-center text-4xl font-black text-red-100">!</p>
            <h3
              id="redeem-dismiss-splash-title"
              className="mt-2 text-center text-2xl font-black text-white"
            >
              Before you dismiss this redeem
            </h3>
            <p className="mt-5 text-center text-base leading-relaxed text-red-50/95">
              Please confirm you received the <strong className="text-white">full redeem amount</strong>{' '}
              for this request:{' '}
              <strong className="tabular-nums text-white">
                ${formatWalletAmount(Number(redeemDismissSplashRequest.amount || 0))}
              </strong>
              . Only dismiss if the payout is complete or you truly need to cancel this request.
            </p>
            <p className="mt-4 text-center text-sm leading-relaxed text-red-100/85">
              Payout may be instant or take up to about 24 hours, and can arrive in smaller parts—wait
              unless you are sure.
            </p>
            <p className="mt-5 rounded-xl border border-red-400/40 bg-black/30 p-4 text-sm leading-relaxed text-red-100/95">
              <span className="font-black text-red-200">Warning: </span>
              False or abusive dismissals may lead to a review and{' '}
              <strong className="text-white">your account could be banned or restricted.</strong>
            </p>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:justify-center">
              <button
                type="button"
                disabled={dismissRedeemLoadingId === redeemDismissSplashRequest.id}
                onClick={() => setRedeemDismissSplashRequest(null)}
                className="flex-1 rounded-xl border border-white/20 bg-white/10 px-4 py-3 text-sm font-semibold text-white hover:bg-white/15 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Go back
              </button>
              <button
                type="button"
                onClick={() => void confirmDismissRedeemSplash()}
                disabled={dismissRedeemLoadingId === redeemDismissSplashRequest.id}
                className="flex-1 rounded-xl bg-white px-4 py-3 text-sm font-black uppercase tracking-wide text-red-900 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {dismissRedeemLoadingId === redeemDismissSplashRequest.id
                  ? 'Dismissing…'
                  : 'I understand — dismiss'}
              </button>
            </div>
              </>
            )}
          </div>
        </div>
      ) : null}

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
