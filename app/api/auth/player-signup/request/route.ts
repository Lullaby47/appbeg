import { NextResponse } from 'next/server';
import { startPlayerSelfSignup } from '@/lib/server/playerSelfSignup';
export const runtime = 'nodejs';
export async function POST(request: Request) {
  try { const result = await startPlayerSelfSignup(request, await request.json()); return NextResponse.json({ ...result, message: 'Verification email sent.' }); }
  catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : 'Unable to start signup.' }, { status: 400 }); }
}
