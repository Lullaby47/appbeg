import { Pool } from 'pg';

const createTableSql = `
  CREATE TABLE IF NOT EXISTS usernames_registry (
    id BIGSERIAL PRIMARY KEY,
    username TEXT NOT NULL,
    normalized_username TEXT NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
  )
`;

type GlobalWithUsernameRegistryPool = typeof globalThis & {
  usernameRegistryPool?: Pool;
};

function normalizeUsername(username: string) {
  return username.trim().toLowerCase();
}

function getPool() {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required for username registry.');
  }

  const globalValue = globalThis as GlobalWithUsernameRegistryPool;
  if (!globalValue.usernameRegistryPool) {
    globalValue.usernameRegistryPool = new Pool({ connectionString: databaseUrl });
  }
  return globalValue.usernameRegistryPool;
}

async function readyPool() {
  try {
    const pool = getPool();
    await pool.query(createTableSql);
    console.info('[USERNAME_REGISTRY] using online postgres');
    return pool;
  } catch (error) {
    console.error('[USERNAME_REGISTRY] SQL unavailable', error);
    throw error;
  }
}

export async function usernameExists(username: string) {
  const cleanUsername = username.trim();
  console.info(`[USERNAME_REGISTRY] checking username=${cleanUsername}`);
  try {
    const pool = await readyPool();
    const result = await pool.query(
      'SELECT 1 FROM usernames_registry WHERE normalized_username = $1 LIMIT 1',
      [normalizeUsername(cleanUsername)]
    );
    return result.rowCount !== 0;
  } catch (error) {
    console.error('[USERNAME_REGISTRY] SQL unavailable', error);
    throw error;
  }
}

export async function insertUsername(username: string) {
  const cleanUsername = username.trim();
  try {
    const pool = await readyPool();
    await pool.query(
      'INSERT INTO usernames_registry (username, normalized_username) VALUES ($1, $2)',
      [cleanUsername, normalizeUsername(cleanUsername)]
    );
  } catch (error) {
    if (!isUniqueViolation(error)) {
      console.error('[USERNAME_REGISTRY] SQL unavailable', error);
    }
    throw error;
  }
  console.info(`[USERNAME_REGISTRY] inserted username=${cleanUsername}`);
}

export async function deleteUsername(username: string) {
  const cleanUsername = username.trim();
  try {
    const pool = await readyPool();
    await pool.query('DELETE FROM usernames_registry WHERE normalized_username = $1', [
      normalizeUsername(cleanUsername),
    ]);
  } catch (error) {
    console.error('[USERNAME_REGISTRY] SQL unavailable', error);
    throw error;
  }
  console.info(`[USERNAME_REGISTRY] deleted username=${cleanUsername}`);
}

export function isUniqueViolation(error: unknown) {
  return Boolean(error && typeof error === 'object' && (error as { code?: string }).code === '23505');
}
