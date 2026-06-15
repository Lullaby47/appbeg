import { NextResponse } from 'next/server';

import { getPlayerMirrorPool } from '@/lib/sql/playerMirrorCommon';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const pool = getPlayerMirrorPool();
  if (!pool) {
    return NextResponse.json({ ok: false, database: 'error' }, { status: 503 });
  }

  try {
    await pool.query('SELECT 1');
    return NextResponse.json({ ok: true, database: 'ok' });
  } catch (error) {
    console.warn('[HEALTH_CHECK] database failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ ok: false, database: 'error' }, { status: 503 });
  }
}
