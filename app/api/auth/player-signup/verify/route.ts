import { NextResponse } from 'next/server';
import { verifyPlayerSelfSignup } from '@/lib/server/playerSelfSignup';
export const runtime = 'nodejs';
export async function POST(request: Request) {
  try { const result = await verifyPlayerSelfSignup(request, await request.json()); return NextResponse.json({ ...result, message: 'Email verified. Account created successfully.' }); }
  catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : 'Unable to verify signup.' }, { status: 400 }); }
}
