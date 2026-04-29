/**
 * Who is viewing admin-style lists / chat. Controls whether internal usernames are shown.
 * - `player` — co-admins: “Co-admin”; staff: first 3 letters of login only; other roles as below.
 * - `staff` — real usernames for admins, other staff, players, etc.; **coadmin** is labeled **Admin** (not the login name).
 * - `carer` — like staff for hiding co-admins; peer staff in some UIs can stay generic (see below).
 * - `coadmin` — see real names for staff, carers, players, and global admins in reach-out.
 * - `admin` — full real usernames everywhere.
 */
export type PanelNameMode = 'player' | 'staff' | 'carer' | 'coadmin' | 'admin';

function playerVisibleStaffPrefix(username: string) {
  const s = String(username || '').trim().toLowerCase();
  if (!s) {
    return '—';
  }
  if (s.length <= 3) {
    return s;
  }
  return s.slice(0, 3);
}

export function getPanelDisplayName(
  user: { username?: string | null; role?: string | null },
  mode: PanelNameMode
): string {
  const role = String(user.role || '').toLowerCase();
  const u = String(user.username || '').trim() || '?';

  if (mode === 'admin' || mode === 'coadmin') {
    return u;
  }

  if (mode === 'staff') {
    if (role === 'coadmin') {
      return 'Admin';
    }
    return u;
  }

  if (mode === 'carer') {
    if (role === 'coadmin') {
      return 'Co-admin';
    }
    if (role === 'admin') {
      return u;
    }
    if (role === 'staff') {
      return 'Support Team';
    }
    return u;
  }

  // mode === 'player' — co-admin hidden; staff: only first 3 letters of login
  if (role === 'coadmin') {
    return 'Co-admin';
  }
  if (role === 'staff') {
    return playerVisibleStaffPrefix(u);
  }
  if (role === 'admin') {
    return 'Support Team';
  }
  return u;
}
