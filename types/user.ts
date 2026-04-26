import { UserRole } from '@/lib/auth/roles';

export type AppUser = {
  uid: string;
  email: string;
  username: string;
  role: UserRole;
  createdBy: string | null;
  coadminUid?: string | null;
  createdAt: Date;
  status: 'active' | 'disabled';
};
