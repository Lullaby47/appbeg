import { NextResponse } from 'next/server';

import { adminDb } from '@/lib/firebase/admin';
import {
  maintenanceBreakResponse,
  normalizeMaintenanceBreak,
  type MaintenanceBreak,
} from '@/lib/maintenance/config';

export async function getCoadminMaintenanceBreak(
  coadminUid: string
): Promise<MaintenanceBreak> {
  const cleanCoadminUid = String(coadminUid || '').trim();
  if (!cleanCoadminUid) {
    return normalizeMaintenanceBreak(null);
  }

  const snapshot = await adminDb.collection('coadminMaintenance').doc(cleanCoadminUid).get();
  return normalizeMaintenanceBreak(snapshot.data()?.maintenanceBreak);
}

export async function getPlayerCoadminMaintenanceBreak(playerUid: string): Promise<{
  coadminUid: string;
  maintenanceBreak: MaintenanceBreak;
}> {
  const cleanPlayerUid = String(playerUid || '').trim();
  if (!cleanPlayerUid) {
    throw new Error('Player profile not found.');
  }

  const playerSnap = await adminDb.collection('users').doc(cleanPlayerUid).get();
  if (!playerSnap.exists) {
    throw new Error('Player profile not found.');
  }

  const playerData = playerSnap.data() as {
    role?: string;
    coadminUid?: string | null;
    createdBy?: string | null;
  };
  if (String(playerData.role || '').toLowerCase() !== 'player') {
    throw new Error('Only players can use this action.');
  }

  const coadminUid =
    String(playerData.coadminUid || '').trim() || String(playerData.createdBy || '').trim();
  if (!coadminUid) {
    throw new Error('Player coadmin scope not found.');
  }

  return {
    coadminUid,
    maintenanceBreak: await getCoadminMaintenanceBreak(coadminUid),
  };
}

export async function rejectIfPlayerMaintenanceBreak(playerUid: string, action: string) {
  const { coadminUid, maintenanceBreak } = await getPlayerCoadminMaintenanceBreak(playerUid);
  if (!maintenanceBreak.enabled) {
    return;
  }

  console.info('[MAINTENANCE] blocked player action', {
    action,
    playerUid,
    coadminUid,
  });
  throw new Error(`MAINTENANCE_BREAK:${maintenanceBreak.message}`);
}

export function maintenanceBreakApiResponse(message: string, status = 423) {
  return NextResponse.json(maintenanceBreakResponse(message), { status });
}
