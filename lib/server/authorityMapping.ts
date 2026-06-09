import 'server-only';

/**
 * Maps legacy Firestore authority collections to SQL cache / ledger tables.
 * SQL authority mode uses players_cache balances + user_balance_events ledger.
 */
export const AUTHORITY_COLLECTION_MAP = {
  users: {
    firestore: 'users',
    sqlProfile: 'players_cache',
    sqlBalance: 'players_cache',
    sqlSnapshot: 'user_balance_snapshots_cache',
    balanceFields: ['coin', 'cash', 'cashBoxNpr', 'promo_locked_coins'] as const,
  },
  financialEvents: {
    firestore: 'financialEvents',
    sqlCache: 'financial_events_cache',
    ledger: 'user_balance_events',
  },
  playerGameRequests: {
    firestore: 'playerGameRequests',
    sqlCache: 'player_game_requests_cache',
  },
  playerCashoutTasks: {
    firestore: 'playerCashoutTasks',
    sqlCache: 'player_cashout_tasks_cache',
  },
  transferRequests: {
    firestore: 'transferRequests',
    sqlCache: 'transfer_requests_cache',
  },
  freeplayPendingGifts: {
    firestore: 'freeplayPendingGifts',
    sqlCache: 'freeplay_pending_gifts_cache',
  },
  freeplayGifts: {
    firestore: 'freeplayGifts',
    sqlCache: 'freeplay_gifts_cache',
    sqlPending: 'freeplay_pending_gifts_cache',
  },
  bonusEvents: {
    firestore: 'bonusEvents',
    sqlCache: 'bonus_events_cache',
  },
  carerTasks: {
    firestore: 'carerTasks',
    sqlCache: 'carer_tasks_cache',
  },
  automationJobs: {
    firestore: 'automationJobs',
    sqlCache: 'automation_jobs_cache',
  },
} as const;

export type AuthorityOperationType =
  | 'balance_adjust'
  | 'freeplay_give'
  | 'freeplay_claim'
  | 'transfer_cash_to_coin'
  | 'transfer_coin_to_cash'
  | 'cashout_create'
  | 'cashout_complete'
  | 'cashout_decline'
  | 'recharge_create'
  | 'redeem_create'
  | 'request_complete'
  | 'request_refund'
  | 'request_dismiss'
  | 'task_claim'
  | 'task_complete'
  | 'task_return'
  | 'task_delete'
  | 'user_create'
  | 'user_status'
  | 'user_password'
  | 'referral_code'
  | 'game_login_manage';

export const AUTHORITY_MIGRATION_ORDER: AuthorityOperationType[] = [
  'user_create',
  'user_status',
  'user_password',
  'referral_code',
  'game_login_manage',
  'balance_adjust',
  'freeplay_give',
  'freeplay_claim',
  'transfer_cash_to_coin',
  'transfer_coin_to_cash',
  'cashout_create',
  'cashout_complete',
  'cashout_decline',
  'recharge_create',
  'redeem_create',
  'request_complete',
  'request_refund',
  'request_dismiss',
  'task_claim',
  'task_complete',
  'task_return',
  'task_delete',
];
