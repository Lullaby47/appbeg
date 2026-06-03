export const GAME_USERNAME_PATTERN_SOURCE = String.raw`^[A-Z][A-Za-z]*_?[0-9]+$`;

export const GAME_USERNAME_PATTERN = /^[A-Z][A-Za-z]*_?[0-9]+$/;

export const GAME_USERNAME_RULE_MESSAGE =
  'Username must start with an uppercase letter and end with digits. Examples: Ayush22 or Ayush_22.';

export const GAME_USERNAME_SUBMIT_ERROR_MESSAGE = `Invalid username format.

Use examples like:
Test22
Test_22

Username must start with a capital letter and end with numbers.`;

export function isValidGameUsername(username: string) {
  return GAME_USERNAME_PATTERN.test(username.trim());
}

export function assertValidGameUsername(username: string) {
  if (!isValidGameUsername(username)) {
    throw new Error(GAME_USERNAME_RULE_MESSAGE);
  }
}
