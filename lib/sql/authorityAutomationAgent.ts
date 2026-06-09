import 'server-only';

import type { PoolClient } from 'pg';

import { cleanText, getPlayerMirrorPool } from '@/lib/sql/playerMirrorCommon';

async function patchAutomationAgentInTxn(
  client: PoolClient,
  carerUid: string,
  input: {
    automationAgentId: string | null;
    linkedAt: string | null;
    nowIso: string;
  }
) {
  const patch = {
    automationAgentId: input.automationAgentId,
    automationAgentUpdatedAt: input.nowIso,
    ...(input.linkedAt ? { automationAgentLinkedAt: input.linkedAt } : {}),
    ...(!input.automationAgentId ? { automationAgentLinkedAt: null } : {}),
  };

  await client.query(
    `
      UPDATE public.players_cache
      SET
        updated_at = $2::timestamptz,
        raw_firestore_data = COALESCE(raw_firestore_data, '{}'::jsonb) || $3::jsonb,
        source = 'authority_automation_agent',
        mirrored_at = now()
      WHERE uid = $1
        AND deleted_at IS NULL
    `,
    [carerUid, input.nowIso, JSON.stringify(patch)]
  );

  await client.query(
    `
      UPDATE public.user_balance_snapshots_cache
      SET
        updated_at = $2::timestamptz,
        mirrored_at = now(),
        raw_firestore_data = COALESCE(raw_firestore_data, '{}'::jsonb) || $3::jsonb,
        source = 'authority_automation_agent'
      WHERE firebase_id = $1
        AND deleted_at IS NULL
    `,
    [carerUid, input.nowIso, JSON.stringify(patch)]
  );

  const coadminResult = await client.query(
    `
      SELECT coadmin_uid, created_by
      FROM public.players_cache
      WHERE uid = $1 AND deleted_at IS NULL
      LIMIT 1
    `,
    [carerUid]
  );
  const row = (coadminResult.rows[0] as { coadmin_uid?: unknown; created_by?: unknown }) || {};
  const coadminUid = cleanText(row.coadmin_uid) || cleanText(row.created_by) || null;

  const autoStateRaw = {
    carerUid,
    coadminUid,
    automationAgentId: input.automationAgentId,
    updatedAt: input.nowIso,
    ...(input.linkedAt ? { automationAgentLinkedAt: input.linkedAt } : {}),
  };

  await client.query(
    `
      INSERT INTO public.automation_auto_state_cache (
        carer_uid, coadmin_uid, enabled, automation_agent_id,
        lease_owner, lease_expires_at, updated_at, raw_firestore_data,
        source, mirrored_at, deleted_at
      )
      VALUES (
        $1, NULLIF($2, ''), FALSE, NULLIF($3, ''),
        NULL, NULL, $4::timestamptz, $5::jsonb,
        'authority_automation_agent', now(), NULL
      )
      ON CONFLICT (carer_uid) DO UPDATE SET
        coadmin_uid = COALESCE(EXCLUDED.coadmin_uid, public.automation_auto_state_cache.coadmin_uid),
        automation_agent_id = EXCLUDED.automation_agent_id,
        updated_at = EXCLUDED.updated_at,
        raw_firestore_data = COALESCE(public.automation_auto_state_cache.raw_firestore_data, '{}'::jsonb) || EXCLUDED.raw_firestore_data,
        source = EXCLUDED.source,
        mirrored_at = now(),
        deleted_at = NULL
    `,
    [
      carerUid,
      coadminUid,
      input.automationAgentId,
      input.nowIso,
      JSON.stringify(autoStateRaw),
    ]
  );
}

export async function linkAutomationAgentInSql(input: {
  carerUid: string;
  agentId: string;
  existingAgentId?: string | null;
}) {
  const carerUid = cleanText(input.carerUid);
  const agentId = cleanText(input.agentId);
  if (!carerUid || !agentId) {
    throw new Error('carerUid and agentId are required.');
  }

  const db = getPlayerMirrorPool();
  if (!db) throw new Error('Postgres is unavailable.');

  const nowIso = new Date().toISOString();
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const lock = await client.query(
      `
        SELECT uid, role, raw_firestore_data
        FROM public.players_cache
        WHERE uid = $1 AND deleted_at IS NULL
        FOR UPDATE
      `,
      [carerUid]
    );
    if (!lock.rows.length) throw new Error('Carer profile not found.');
    const profile = lock.rows[0] as Record<string, unknown>;
    if (cleanText(profile.role).toLowerCase() !== 'carer') {
      throw new Error('Only carers can link automation agents.');
    }

    const raw = (profile.raw_firestore_data as Record<string, unknown>) || {};
    const existing = cleanText(input.existingAgentId) || cleanText(raw.automationAgentId);
    const linkedAt = existing ? cleanText(raw.automationAgentLinkedAt) || nowIso : nowIso;

    await patchAutomationAgentInTxn(client, carerUid, {
      automationAgentId: agentId,
      linkedAt,
      nowIso,
    });

    await client.query('COMMIT');
    return { success: true as const, automationAgentId: agentId };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function unlinkAutomationAgentInSql(carerUid: string) {
  const cleanUid = cleanText(carerUid);
  if (!cleanUid) throw new Error('carerUid is required.');

  const db = getPlayerMirrorPool();
  if (!db) throw new Error('Postgres is unavailable.');

  const nowIso = new Date().toISOString();
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const lock = await client.query(
      `
        SELECT uid, role
        FROM public.players_cache
        WHERE uid = $1 AND deleted_at IS NULL
        FOR UPDATE
      `,
      [cleanUid]
    );
    if (!lock.rows.length) throw new Error('Carer profile not found.');
    if (cleanText((lock.rows[0] as { role?: unknown }).role).toLowerCase() !== 'carer') {
      throw new Error('Only carers can unlink automation agents.');
    }

    await patchAutomationAgentInTxn(client, cleanUid, {
      automationAgentId: null,
      linkedAt: null,
      nowIso,
    });

    await client.query('COMMIT');
    return { success: true as const, automationAgentId: null };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
