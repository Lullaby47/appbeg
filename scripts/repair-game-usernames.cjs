const { Pool } = require('pg');

function clean(value) {
  return String(value || '').trim();
}

function arg(name) {
  return process.argv.includes(name);
}

const dryRun = arg('--dry-run');
const databaseUrl = clean(process.env.DATABASE_URL || process.env.POSTGRES_URL);

if (!databaseUrl) {
  console.error('DATABASE_URL or POSTGRES_URL is required.');
  process.exit(1);
}

async function main() {
  const pool = new Pool({ connectionString: databaseUrl });
  const client = await pool.connect();
  const summary = {
    staleChecked: 0,
    repaired: 0,
    noActivePlayerMatch: 0,
    multipleActivePlayerMatches: 0,
    dryRun,
  };

  try {
    await client.query('BEGIN');

    const stale = await client.query(`
      SELECT gu.id, gu.username, gu.player_uid, gu.coadmin_uid
      FROM public.game_usernames gu
      WHERE gu.status = 'active'
        AND (
          COALESCE(gu.player_uid, '') = ''
          OR NOT EXISTS (
            SELECT 1
            FROM public.players_cache pc
            WHERE pc.uid = gu.player_uid
              AND pc.deleted_at IS NULL
              AND pc.role = 'player'
              AND COALESCE(pc.status, 'active') = 'active'
          )
        )
      ORDER BY gu.updated_at DESC NULLS LAST, gu.created_at DESC NULLS LAST
    `);

    for (const row of stale.rows) {
      summary.staleChecked += 1;
      const matches = await client.query(
        `
          SELECT uid, username, coadmin_uid, created_by
          FROM public.players_cache
          WHERE deleted_at IS NULL
            AND role = 'player'
            AND COALESCE(status, 'active') = 'active'
            AND lower(username) = lower($1)
            AND (
              coadmin_uid = $2
              OR created_by = $2
              OR raw_firestore_data->>'coadminUid' = $2
              OR raw_firestore_data->>'createdBy' = $2
            )
          ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST, mirrored_at DESC NULLS LAST
        `,
        [row.username, row.coadmin_uid]
      );

      if (matches.rows.length === 1) {
        const activePlayer = matches.rows[0];
        if (!dryRun) {
          await client.query(
            `
              UPDATE public.game_usernames
              SET player_uid = $2,
                  status = 'active',
                  updated_at = now(),
                  mirrored_at = now(),
                  source = 'game_username_repair',
                  raw_json = COALESCE(raw_json, '{}'::jsonb) || $3::jsonb
              WHERE id = $1
            `,
            [
              row.id,
              activePlayer.uid,
              JSON.stringify({
                repairedAt: new Date().toISOString(),
                oldPlayerUid: row.player_uid,
                newPlayerUid: activePlayer.uid,
                repairReason: 'active_game_username_player_uid_missing_from_players_cache',
              }),
            ]
          );
        }
        summary.repaired += 1;
        console.info('[GAME_USERNAME_REPAIR]', {
          action: dryRun ? 'would_update' : 'updated',
          id: row.id,
          username: row.username,
          coadminUid: row.coadmin_uid,
          oldPlayerUid: row.player_uid,
          newPlayerUid: activePlayer.uid,
        });
      } else if (matches.rows.length === 0) {
        summary.noActivePlayerMatch += 1;
        console.info('[GAME_USERNAME_REPAIR]', {
          action: 'report_only',
          reason: 'no_active_players_cache_match',
          id: row.id,
          username: row.username,
          coadminUid: row.coadmin_uid,
          oldPlayerUid: row.player_uid,
        });
      } else {
        summary.multipleActivePlayerMatches += 1;
        console.info('[GAME_USERNAME_REPAIR]', {
          action: 'report_only',
          reason: 'multiple_active_players_cache_matches',
          id: row.id,
          username: row.username,
          coadminUid: row.coadmin_uid,
          oldPlayerUid: row.player_uid,
          candidatePlayerUids: matches.rows.map((match) => match.uid),
        });
      }
    }

    if (dryRun) {
      await client.query('ROLLBACK');
    } else {
      await client.query('COMMIT');
    }
    console.info('[GAME_USERNAME_REPAIR]', { action: 'summary', ...summary });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    console.error('[GAME_USERNAME_REPAIR]', {
      action: 'failed',
      error: error instanceof Error ? error.message : String(error),
    });
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main();
