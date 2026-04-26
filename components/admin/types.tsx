import { CoadminUser, StaffUser } from '@/features/users/adminUsers';

export type AdminView =
  | 'dashboard'
  | 'create-coadmin'
  | 'view-coadmins'
  | 'add-staff'
  | 'view-staff'
  | 'players'
  | 'reach-out';

export type AdminAccountUser = {
  id: string;
  uid: string;
  username: string;
  email: string;
  role: 'admin';
  status: 'active' | 'disabled';
  createdBy: string | null;
  coadminUid?: string | null;
  createdAt?: any;
};

export type AdminUser = AdminAccountUser | CoadminUser | StaffUser;

export interface ChatMessage {
  id: string;
  text?: string;
  imageUrl?: string;
  sender: 'admin' | 'user';
  timestamp: Date;
}
