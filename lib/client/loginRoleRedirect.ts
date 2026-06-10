'use client';

import { DASHBOARD_BY_ROLE, isValidRole, type UserRole } from '@/lib/auth/roles';

export function logLoginRoleRedirect(values: {
  uid: string;
  role: string;
  from: string;
  to: string;
  reason: string;
}) {
  console.info('[LOGIN_ROLE_REDIRECT]', values);
}

export function dashboardPathForRole(role: string) {
  if (!isValidRole(role)) {
    return '/login';
  }
  return DASHBOARD_BY_ROLE[role as UserRole];
}
