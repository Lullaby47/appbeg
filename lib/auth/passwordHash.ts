import 'server-only';

import bcrypt from 'bcrypt';

const BCRYPT_COST = 12;
const BCRYPT_ALGO = 'bcrypt' as const;

export type PasswordHashResult = {
  hash: string;
  algo: typeof BCRYPT_ALGO;
};

export async function hashPassword(password: string): Promise<PasswordHashResult> {
  const hash = await bcrypt.hash(password, BCRYPT_COST);
  return { hash, algo: BCRYPT_ALGO };
}

export async function verifyPassword(
  password: string,
  hash: string,
  algo: string
): Promise<boolean> {
  const normalizedAlgo = String(algo || '').trim().toLowerCase();
  if (normalizedAlgo !== BCRYPT_ALGO) {
    return false;
  }
  if (!password || !hash) {
    return false;
  }
  try {
    return await bcrypt.compare(password, hash);
  } catch {
    return false;
  }
}
