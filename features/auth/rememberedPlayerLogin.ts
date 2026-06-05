'use client';

export const PLAYER_REMEMBERED_LOGIN_KEY = 'appbeg:playerRememberedLogin';

export function rememberPlayerLoginCredentials(username: string, password: string) {
  if (typeof window === 'undefined') {
    return;
  }
  const cleanUsername = username.trim();
  if (!cleanUsername || !password) {
    return;
  }
  window.localStorage.setItem(
    PLAYER_REMEMBERED_LOGIN_KEY,
    JSON.stringify({
      username: cleanUsername,
      password,
      updatedAt: new Date().toISOString(),
    })
  );
}
