/**
 * Who is viewing admin-style lists / chat. Controls whether internal usernames are shown.
 * - `player` — players only see generic labels (privacy).
 * - `staff` — see real usernames for admins, other staff, players, etc.; only co-accounts are hidden (“Co-admin”).
 * - `carer` — like staff for hiding co-admins; peer staff in some UIs can stay generic (see below).
 * - `coadmin` — see real names for staff, carers, players, and global admins in reach-out.
 * - `admin` — full real usernames everywhere.
 */
export type PanelNameMode = 'player' | 'staff' | 'carer' | 'coadmin' | 'admin';

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
      return 'Co-admin';
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

  // mode === 'player' — no internal usernames
  if (role === 'coadmin') {
    return 'Co-admin';
  }
  if (role === 'admin' || role === 'staff') {
    return 'Support Team';
  }
  return u;
}
