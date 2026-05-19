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

export function maintenanceBreakApiResponse(message: string, status = 423) {
  return NextResponse.json(maintenanceBreakResponse(message), { status });
}
