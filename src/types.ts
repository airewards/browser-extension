export type AccountStatus = 'active' | 'suspended' | 'banned' | 'pending_deletion';

export interface User {
  id: string;
  githubId: string;
  email: string;
  name: string;
  canAdvertise: boolean;
  isAdmin: boolean;
  status: AccountStatus;
  isBanned: boolean;
}

export interface Wallet {
  availableBalance: number;
  pendingBalance: number;
  lockedBalance: number;
  currency: string;
}
