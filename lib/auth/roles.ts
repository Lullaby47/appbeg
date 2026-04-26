export type UserRole = 'admin' | 'coadmin' | 'staff' | 'carer' | 'player';

export const USER_ROLES = {
  ADMIN: 'admin',
  COADMIN: 'coadmin',
  STAFF: 'staff',
  CARER: 'carer',
  PLAYER: 'player',
} as const;

export const DASHBOARD_BY_ROLE: Record<UserRole, string> = {
  admin: '/admin',
  coadmin: '/coadmin',
  staff: '/staff',
  carer: '/carer',
  player: '/player',
};

export function isValidRole(role: string): role is UserRole {
  return ['admin', 'coadmin', 'staff', 'carer', 'player'].includes(role);
}