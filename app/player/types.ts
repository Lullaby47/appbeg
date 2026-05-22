import type { PlayerGameLogin } from '@/features/games/playerGameLogins';

export type PlayerView =
  | 'dashboard'
  | 'play'
  | 'bonus-events'
  | 'agents'
  | 'usernames'
  | 'earn-coins';

export type PlayerWallet = {
  coin: number;
  cash: number;
};

export type PlayerGameRequestType = 'recharge' | 'redeem';

export type GameBackgroundAsset = {
  key: string;
  imageUrl: string;
};

export type PlayerAlertInfo = {
  variant: 'index' | 'permission' | 'lowCoin' | 'warning' | 'success';
  title: string;
  body: string;
  raw: string;
};

export type ClipboardToastTone = 'success' | 'warn' | 'error';

export type ClipboardToastState = {
  text: string;
  tone: ClipboardToastTone;
  x: number;
  y: number;
  placeBelow: boolean;
} | null;

export type CredentialResetModalState = null | {
  gameLogin: PlayerGameLogin;
  taskType: 'reset_password' | 'recreate_username';
};
