export const SINGLE_SESSION_AUTOMATION_GAMES = new Set(['ultra_panda', 'vb_link']);

export function normalizeAutomationGameKey(value: unknown) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

export function isSingleSessionAutomationGame(value: unknown) {
  return SINGLE_SESSION_AUTOMATION_GAMES.has(normalizeAutomationGameKey(value));
}
