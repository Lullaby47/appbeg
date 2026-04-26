import { UserRole } from './roles';

export type Permission =
  | 'create_coadmin'
  | 'create_carer'
  | 'create_player'
  | 'send_message'
  | 'receive_message';

const rolePermissions: Record<UserRole, Permission[]> = {
  admin: ['create_coadmin'],
  coadmin: ['create_carer', 'create_player'],

  // ✅ FIXED
  staff: ['send_message', 'receive_message'],

  carer: ['send_message', 'receive_message'],
  player: ['send_message', 'receive_message'],
};

export function hasPermission(role: UserRole, permission: Permission) {
  return rolePermissions[role]?.includes(permission);
}