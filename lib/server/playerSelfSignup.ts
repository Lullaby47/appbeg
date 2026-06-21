import 'server-only';

import { createHash, randomInt, randomUUID } from 'crypto';

import { adminAuth } from '@/lib/firebase/admin';
import { hashPassword, verifyPassword } from '@/lib/auth/passwordHash';
import { PlayerUsernameValidationError, validatePlayerUsernameForCreation } from '@/lib/server/playerUsernameForCreation';
import { completeCanonicalPlayerCreation } from '@/lib/server/canonicalPlayerCreation';
import { lookupReferrerByCodeFromSql } from '@/lib/sql/authorityReferralCodes';
import { lookupUserDirectoryFromSql } from '@/lib/sql/authorityLookup';
import { resolveCoadminUidByPlayerSignupCode } from '@/lib/sql/coadminPlayerSignupCodes';
import { cleanText, getPlayerMirrorPool } from '@/lib/sql/playerMirrorCommon';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CODE_TTL_MINUTES = 15;
const MAX_CODE_ATTEMPTS = 5;

function digest(value: string) { return createHash('sha256').update(value).digest('hex'); }
function normalizedEmail(value: unknown) { return cleanText(value).toLowerCase(); }
function clientIp(request: Request) { return request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown'; }

async function logEvent(eventType: string, request: Request, data: Record<string, unknown> = {}) {
  const db = getPlayerMirrorPool();
  if (!db) return;
  await db.query(
    `INSERT INTO public.player_signup_events (signup_id,event_type,email,username,ip_hash,details)
     VALUES (NULLIF($1,'')::uuid,$2,NULLIF($3,''),NULLIF($4,''),$5,$6::jsonb)`,
    [cleanText(data.signupId), eventType, normalizedEmail(data.email), cleanText(data.username), digest(clientIp(request)), JSON.stringify(data)]
  );
}

async function enforceRateLimit(request: Request, eventType: string, limit: number) {
  const db = getPlayerMirrorPool();
  if (!db) throw new Error('Signup is temporarily unavailable.');
  const result = await db.query(
    `SELECT count(*)::int AS count FROM public.player_signup_events
      WHERE event_type = $1 AND ip_hash = $2 AND created_at > now() - interval '1 hour'`,
    [eventType, digest(clientIp(request))]
  );
  if (Number(result.rows[0]?.count || 0) >= limit) throw new Error('Too many attempts. Please try again later.');
}

async function assertAvailable(email: string, username: string) {
  const db = getPlayerMirrorPool();
  if (!db) throw new Error('Signup is temporarily unavailable.');
  const existing = await db.query(
    `SELECT username, email FROM public.players_cache
     WHERE deleted_at IS NULL AND (LOWER(username)=LOWER($1) OR LOWER(email)=LOWER($2)) LIMIT 1`,
    [username, email]
  );
  const row = existing.rows[0] as { username?: string; email?: string } | undefined;
  if (row?.email && String(row.email).toLowerCase() === email) throw new Error('Email already in use.');
  if (row) throw new Error('Username already exists.');
  try { await adminAuth.getUserByEmail(email); throw new Error('Email already in use.'); } catch (error) {
    if ((error as { code?: string })?.code !== 'auth/user-not-found') throw error;
  }
}

async function sendCode(email: string, code: string) {
  const apiKey = cleanText(process.env.RESEND_API_KEY);
  const from = cleanText(process.env.RESEND_FROM_EMAIL);
  if (!apiKey || !from) throw new Error('Email verification is not configured. Please contact support.');
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to: [email], subject: 'Your AppBeg verification code', text: `Your AppBeg verification code is ${code}. It expires in ${CODE_TTL_MINUTES} minutes. Do not share this code.` }),
  });
  if (!response.ok) throw new Error('Unable to send verification email. Please try again later.');
}

export async function startPlayerSelfSignup(request: Request, body: Record<string, unknown>) {
  const email = normalizedEmail(body.email); const username = cleanText(body.username); const password = String(body.password || ''); const referralCode = cleanText(body.referralCode); const coadminSignupCode = cleanText(body.coadminSignupCode).toUpperCase();
  if (!EMAIL.test(email)) throw new Error('Enter a valid email address.');
  if (password.length < 6) throw new Error('Password must be at least 6 characters.');
  if (!coadminSignupCode) throw new Error('Coadmin signup code is required.');
  await enforceRateLimit(request, 'signup_code_lookup', 10);
  await logEvent('signup_code_lookup', request, { email, username });
  const ownerCoadminUid = await resolveCoadminUidByPlayerSignupCode(coadminSignupCode);
  if (!ownerCoadminUid) throw new Error('Invalid coadmin signup code.');
  console.info('[SELF_SIGNUP_USERNAME] validateStart', { usernameEntered: String(body.username || '') });
  try {
    const validated = await validatePlayerUsernameForCreation(username, ownerCoadminUid);
    console.info('[SELF_SIGNUP_USERNAME] normalized', { username: validated.username });
    console.info('[SELF_SIGNUP_USERNAME] valid', { username: validated.username });
  } catch (error) {
    if (error instanceof PlayerUsernameValidationError) {
      if (error.kind === 'duplicate') {
        console.info('[SELF_SIGNUP_USERNAME] duplicateFound', { username, duplicateTable: error.duplicateTable || null });
        console.info('[SELF_SIGNUP_USERNAME] duplicateTable', { table: error.duplicateTable || null });
      } else {
        console.info('[SELF_SIGNUP_USERNAME] ruleRejected', { username, message: error.message });
      }
    }
    throw error;
  }
  if (referralCode && !await lookupReferrerByCodeFromSql(referralCode)) throw new Error('Invalid referral code.');
  await enforceRateLimit(request, 'signup_requested', 5);
    await assertAvailable(email, username);
  const db = getPlayerMirrorPool(); if (!db) throw new Error('Signup is temporarily unavailable.');
  const code = String(randomInt(100000, 1000000)); const hashed = await hashPassword(password); const id = randomUUID();
  await db.query(`DELETE FROM public.player_signup_requests WHERE lower(email)=lower($1) AND verified_at IS NULL`, [email]);
  await db.query(
    `INSERT INTO public.player_signup_requests (id,email,username,password_hash,password_algo,coadmin_signup_code,owner_coadmin_uid,referral_code,verification_code_hash,expires_at)
     VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,NULLIF($8,''),$9,now() + interval '15 minutes')`,
    [id,email,username,hashed.hash,hashed.algo,coadminSignupCode,ownerCoadminUid,referralCode,digest(code)]
  );
  try { await sendCode(email, code); } catch (error) { await db.query('DELETE FROM public.player_signup_requests WHERE id=$1::uuid', [id]); throw error; }
  await logEvent('signup_requested', request, { signupId: id, email, username });
  return { signupId: id };
}

export async function verifyPlayerSelfSignup(request: Request, body: Record<string, unknown>) {
  const id = cleanText(body.signupId); const code = cleanText(body.code); const password = String(body.password || '');
  if (!/^[0-9]{6}$/.test(code) || !id) throw new Error('Enter the six-digit verification code.');
  await enforceRateLimit(request, 'verification_attempted', 12);
  await logEvent('verification_attempted', request, { signupId: id });
  const db = getPlayerMirrorPool(); if (!db) throw new Error('Signup is temporarily unavailable.');
  const client = await db.connect(); let authUid: string | null = null; let createdAuthThisAttempt = false;
  try {
    await client.query('BEGIN');
    const result = await client.query(`SELECT * FROM public.player_signup_requests WHERE id=$1::uuid FOR UPDATE`, [id]);
    const row = result.rows[0] as Record<string, string | number | null> | undefined;
    if (!row) throw new Error('This verification request was not found.');
    if (row.account_created_at && row.player_uid) {
      await client.query('COMMIT');
      console.info('[SELF_SIGNUP_SETUP_SKIPPED_ALREADY_EXISTS]', { signupId: id, playerUid: row.player_uid });
      return { username: cleanText(row.username), alreadyCreated: true };
    }
    if (new Date(String(row.expires_at)).getTime() < Date.now()) throw new Error('This verification code has expired. Request a new one.');
    if (Number(row.attempts || 0) >= MAX_CODE_ATTEMPTS) throw new Error('Too many incorrect codes. Request a new one.');
    if (digest(code) !== String(row.verification_code_hash)) {
      await client.query('UPDATE public.player_signup_requests SET attempts=attempts+1,updated_at=now() WHERE id=$1::uuid',[id]);
      await client.query('COMMIT');
      throw new Error('Incorrect verification code.');
    }
    if (!await verifyPassword(password, String(row.password_hash), String(row.password_algo))) throw new Error('Password confirmation failed. Start signup again.');
    const email = normalizedEmail(row.email); const username = cleanText(row.username); const ownerCoadminUid = cleanText(row.owner_coadmin_uid);
    if (!ownerCoadminUid) throw new Error('This signup request is missing its coadmin assignment. Start signup again.');
    const owner = await lookupUserDirectoryFromSql(ownerCoadminUid);
    if (!owner || owner.role !== 'coadmin') throw new Error('Player signup is not configured. Please contact support.');
    // A retry may already have created the Firebase identity. The SQL player
    // profile remains the availability authority until canonical setup commits.
    const existingPlayer = await db.query(`SELECT uid FROM public.players_cache WHERE uid = NULLIF($1,'') AND deleted_at IS NULL LIMIT 1`, [cleanText(row.player_uid)]);
    if (existingPlayer.rows.length) {
      await client.query(`UPDATE public.player_signup_requests SET account_created_at=COALESCE(account_created_at,now()),setup_source='player_self_signup',updated_at=now() WHERE id=$1::uuid`, [id]);
      await client.query('COMMIT');
      console.info('[SELF_SIGNUP_SETUP_SKIPPED_ALREADY_EXISTS]', { signupId: id, playerUid: cleanText(row.player_uid) });
      return { username, alreadyCreated: true };
    }
    const existingPlayerByEmail = await db.query(
      `SELECT uid FROM public.players_cache WHERE lower(email)=lower($1) AND deleted_at IS NULL LIMIT 1`,
      [email]
    );
    if (existingPlayerByEmail.rows.length) {
      const playerUid = cleanText(existingPlayerByEmail.rows[0]?.uid);
      await client.query(`UPDATE public.player_signup_requests SET player_uid=$2,verified_at=COALESCE(verified_at,now()),account_created_at=COALESCE(account_created_at,now()),setup_source='player_self_signup',updated_at=now() WHERE id=$1::uuid`, [id, playerUid]);
      await client.query('COMMIT');
      console.info('[SELF_SIGNUP_SETUP_SKIPPED_ALREADY_EXISTS]', { signupId: id, playerUid });
      return { username, alreadyCreated: true };
    }
    if (!cleanText(row.player_uid)) await assertAvailable(email, username);
    if (cleanText(row.referral_code) && !await lookupReferrerByCodeFromSql(cleanText(row.referral_code))) throw new Error('Invalid referral code.');
    if (cleanText(row.player_uid)) {
      authUid = cleanText(row.player_uid);
    } else {
      try {
        const existingAuth = await adminAuth.getUserByEmail(email);
        authUid = existingAuth.uid;
        await adminAuth.updateUser(authUid, { emailVerified: true, password, displayName: username, disabled: false });
      } catch (error) {
        if ((error as { code?: string })?.code !== 'auth/user-not-found') throw error;
        const authUser = await adminAuth.createUser({ email, password, displayName: username, emailVerified: true, disabled: false });
        authUid = authUser.uid; createdAuthThisAttempt = true;
      }
      await client.query(`UPDATE public.player_signup_requests SET player_uid=$2,verified_at=COALESCE(verified_at,now()),updated_at=now() WHERE id=$1::uuid`, [id, authUid]);
    }
    console.info('[SELF_SIGNUP_VERIFIED]', { signupId: id, playerUid: authUid, email });
    const setup = await completeCanonicalPlayerCreation({ uid: authUid, username, email, password, ownerCoadminUid, referralCodeInput: cleanText(row.referral_code) || null, actorUid: authUid, actorRole: 'player', source: 'player_self_signup' });
    await client.query(`UPDATE public.player_signup_requests SET verified_at=COALESCE(verified_at,now()),account_created_at=now(),setup_source='player_self_signup',updated_at=now() WHERE id=$1::uuid`, [id]);
    await client.query('COMMIT');
    console.info('[SELF_SIGNUP_PLAYER_CREATED]', { signupId: id, playerUid: authUid, coadminUid: ownerCoadminUid, taskCount: setup.createdTaskIds.length });
    console.info('[SELF_SIGNUP_USERNAME] createCommitted', { signupId: id, playerUid: authUid, username });
    setup.createdTaskIds.forEach((taskId) => console.info('[SELF_SIGNUP_GAME_USERNAME_TASK_CREATED]', { signupId: id, playerUid: authUid, taskId }));
    await logEvent('verification_succeeded', request, { signupId: id, email, username, uid: authUid });
    await logEvent('account_created', request, { signupId: id, email, username, uid: authUid });
    return { username };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    if (error instanceof PlayerUsernameValidationError && error.kind === 'duplicate') {
      console.info('[SELF_SIGNUP_USERNAME] conflictConcurrentDuplicate', {
        signupId: id,
        username: cleanText(body.username),
        duplicateTable: error.duplicateTable || null,
      });
    }
    if (createdAuthThisAttempt && authUid) await adminAuth.deleteUser(authUid).catch(() => undefined);
    await logEvent('verification_failed', request, { signupId: id, reason: error instanceof Error ? error.message : 'unknown' });
    throw error;
  } finally { client.release(); }
}
