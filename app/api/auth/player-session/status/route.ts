import { NextResponse } from 'next/server';

import { resolvePlayerSessionStatus } from '@/lib/server/playerSessionStatus';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const { status, result } = await resolvePlayerSessionStatus(request);
  return NextResponse.json(result, { status });
}
