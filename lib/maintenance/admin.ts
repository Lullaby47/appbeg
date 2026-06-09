import { NextResponse } from 'next/server';

import { adminDb } from '@/lib/firebase/admin';
import {
  isRechargeFirestoreQuotaError,
  timedRechargeFirestoreRead,
} from '@/lib/server/rechargeFirestoreInstrumentation';
import { isAuthoritySqlWriteEnabled } from '@/lib/server/authoritySqlWrite';
import { isAuthSqlReadEnabled } from '@/lib/server/authSqlRead';
import { readCoadminMaintenanceBreakFromSql } from '@/lib/sql/coadminMaintenanceCache';
import {
  maintenanceBreakResponse,
  normalizeMaintenanceBreak,
  type MaintenanceBreak,
} from '@/lib/maintenance/config';

function shouldReadMaintenanceFromSql() {
  return isAuthSqlReadEnabled() || isAuthoritySqlWriteEnabled();
}

export async function getCoadminMaintenanceBreak(
  coadminUid: string,
  options?: { rechargeInstrumentation?: boolean; quotaFailOpen?: boolean }
): Promise<MaintenanceBreak> {
  const cleanCoadminUid = String(coadminUid || '').trim();
  if (!cleanCoadminUid) {
    return normalizeMaintenanceBreak(null);
  }

  if (shouldReadMaintenanceFromSql()) {
    return readCoadminMaintenanceBreakFromSql(cleanCoadminUid);
  }

  try {
    const snapshot = options?.rechargeInstrumentation
      ? await timedRechargeFirestoreRead(
          {
            stage: 'maintenance_break',
            collection: 'coadminMaintenance',
            document: cleanCoadminUid,
          },
          () => adminDb.collection('coadminMaintenance').doc(cleanCoadminUid).get()
        )
      : await adminDb.collection('coadminMaintenance').doc(cleanCoadminUid).get();
    return normalizeMaintenanceBreak(snapshot.data()?.maintenanceBreak);
  } catch (error) {
    if (options?.quotaFailOpen && isRechargeFirestoreQuotaError(error)) {
      console.warn('[MAINTENANCE] recharge quota fail-open', {
        coadminUid: cleanCoadminUid,
        error: error instanceof Error ? error.message : String(error),
      });
      return normalizeMaintenanceBreak(null);
    }
    throw error;
  }
}

export async function getPlayerCoadminMaintenanceBreak(playerUid: string): Promise<{
  coadminUid: string;
  maintenanceBreak: MaintenanceBreak;
}> {
  const cleanPlayerUid = String(playerUid || '').trim();
  if (!cleanPlayerUid) {
    throw new Error('Player profile not found.');
  }

  let coadminUid = '';
  if (shouldReadMaintenanceFromSql()) {
    const { lookupUserDirectoryFromSql } = await import('@/lib/sql/authorityLookup');
    const player = await lookupUserDirectoryFromSql(cleanPlayerUid);
    if (!player) {
      throw new Error('Player profile not found.');
    }
    if (String(player.role || '').toLowerCase() !== 'player') {
      throw new Error('Only players can use this action.');
    }
    coadminUid = String(player.coadminUid || '').trim() || String(player.createdBy || '').trim();
  } else {
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

    coadminUid =
      String(playerData.coadminUid || '').trim() || String(playerData.createdBy || '').trim();
  }
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

/** Uses SQL auth profile scope — avoids redundant Firestore users/{uid} read. */
export async function rejectIfPlayerMaintenanceBreakFromUser(
  user: { uid: string; coadminUid?: string | null; createdBy?: string | null },
  action: string
) {
  const coadminUid =
    String(user.coadminUid || '').trim() || String(user.createdBy || '').trim();
  if (!coadminUid) {
    throw new Error('Player coadmin scope not found.');
  }

  const maintenanceBreak = await getCoadminMaintenanceBreak(coadminUid, {
    rechargeInstrumentation: true,
    quotaFailOpen: true,
  });
  if (!maintenanceBreak.enabled) {
    return;
  }

  console.info('[MAINTENANCE] blocked player action', {
    action,
    playerUid: user.uid,
    coadminUid,
    source: 'auth_user_scope',
  });
  throw new Error(`MAINTENANCE_BREAK:${maintenanceBreak.message}`);
}

export function maintenanceBreakApiResponse(message: string, status = 423) {
  return NextResponse.json(maintenanceBreakResponse(message), { status });
}
