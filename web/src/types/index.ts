// ===== NETWORK TYPES =====
export type NetworkType = 'solana';

export type NetworkConfig = {
  name: string;
  type: NetworkType;
  rpcUrl: string;
  explorerUrl: string;
  contractAddress: string;
  stakeTokenAddress: string;
  rewardTokenAddress: string;
  stakeTokenSymbol: string;
  stakeTokenDecimals: number;
  /** Token account that holds staked tokens (authority = platform PDA) */
  stakeVaultAddress?: string;
  /** Token account that holds reward tokens (authority = platform PDA) */
  rewardVaultAddress?: string;
  /** Token account that holds the long-term emission reserve (authority = platform PDA) */
  reserveVaultAddress?: string;
};

// ===== LOCK PERIOD (single: 30 days) =====
export const LOCK_PERIOD = { days: 30, label: '30 Days' };

// Default display APY percent — actual effective APY is PoS-based and fetched from chain.
export const DYNAMIC_APY = 60;

// ===== REFERRAL LEVELS =====
// Fallback only — mirrors the LIVE on-chain Platform.referral_percentages
// (verified directly against the mainnet account 2026-08-21), which an admin
// changed away from the contract's DEFAULT_REFERRAL_PERCENTAGES (30% total,
// see lib.rs) to this lower, evenly-stepped curve (17.75% total) at some
// point post-deploy. Update this if set_referral_percentages is ever called
// again — live data (Platform.referralPercentages) always overrides this
// wherever it's fetched successfully.
export const REFERRAL_LEVELS = [
  { level: 1, percentage: 0.25 },
  { level: 2, percentage: 0.50 },
  { level: 3, percentage: 1.25 },
  { level: 4, percentage: 1.50 },
  { level: 5, percentage: 1.75 },
  { level: 6, percentage: 2.00 },
  { level: 7, percentage: 2.25 },
  { level: 8, percentage: 2.50 },
  { level: 9, percentage: 2.75 },
  { level: 10, percentage: 3.00 },
] as const;

// A second, separate referral layer (v2.7) — recurring on every claim/compound,
// not just once on stake. Levels 1-5 only, reverse-weighted (direct referrer
// earns the most), carved out of the claiming user's own after-fee reward —
// never drawn from the pool. Hardcoded in the contract (CLAIM_REFERRAL_BPS in
// lib.rs), not admin-adjustable, so there's no live on-chain fetch to fall
// back from here.
export const CLAIM_REFERRAL_LEVELS = [
  { level: 1, percentage: 3.00 },
  { level: 2, percentage: 2.50 },
  { level: 3, percentage: 2.00 },
  { level: 4, percentage: 1.50 },
  { level: 5, percentage: 1.00 },
] as const;

// ===== TEAM TARGET BONUS TIERS =====
// 10-level bonus applied on top of staking rewards based on total team staked.
// Fallback values only — live on-chain values (Platform.teamTierMinStaked/teamTierBonusBps)
// override these when available. Mirrors DEFAULT_TEAM_MIN_STAKED/DEFAULT_TEAM_BONUS_BPS
// in lib.rs — Bronze starts at 50K, Titan tops out at 100M (40% of the 250M fixed supply).
export const TEAM_TARGET_TIERS = [
  { tier: 1,  label: 'Bronze',   bonusPercentage: 2,   bonusBps: 200,  minTeamStaked: 50_000,       color: 'amber'   },
  { tier: 2,  label: 'Silver',   bonusPercentage: 3,   bonusBps: 300,  minTeamStaked: 100_000,      color: 'slate'   },
  { tier: 3,  label: 'Gold',     bonusPercentage: 4,   bonusBps: 400,  minTeamStaked: 250_000,      color: 'yellow'  },
  { tier: 4,  label: 'Platinum', bonusPercentage: 5,   bonusBps: 500,  minTeamStaked: 500_000,      color: 'cyan'    },
  { tier: 5,  label: 'Diamond',  bonusPercentage: 6,   bonusBps: 600,  minTeamStaked: 1_000_000,    color: 'purple'  },
  { tier: 6,  label: 'Ruby',     bonusPercentage: 7,   bonusBps: 700,  minTeamStaked: 2_500_000,    color: 'rose'    },
  { tier: 7,  label: 'Emerald',  bonusPercentage: 7.5, bonusBps: 750,  minTeamStaked: 5_000_000,    color: 'green'   },
  { tier: 8,  label: 'Sapphire', bonusPercentage: 8.5, bonusBps: 850,  minTeamStaked: 10_000_000,   color: 'blue'    },
  { tier: 9,  label: 'Obsidian', bonusPercentage: 9,   bonusBps: 900,  minTeamStaked: 20_000_000,   color: 'gray'    },
  { tier: 10, label: 'Titan',    bonusPercentage: 10,  bonusBps: 1000, minTeamStaked: 100_000_000,  color: 'brand'   },
] as const;

export type TeamTargetTier = typeof TEAM_TARGET_TIERS[number];

// Claim interval in seconds (6 hours — 4 intervals/day)
export const CLAIM_COOLDOWN_SECONDS = 21600;

// ===== USER TYPES =====
export interface UserAccount {
  address: string;
  totalStaked: number;
  totalRewardsEarned: number;
  totalReferralRewards: number;
  referrer: string | null;
  referralCount: number;
  teamSize: number;        // total downline members (all levels)
  teamTotalStaked: number; // total FBiT staked by entire team
  isBlocked: boolean;
  registeredAt: number;
  /** On-chain team bonus BPS for this user (from getTeamBonusBps; optional) */
  currentTierBonusBps?: number;
}

export interface StakeEntry {
  id: number | string;
  amount: number;
  lockPeriodIndex: number;
  stakedAt: number;
  unlockAt: number;
  lastClaimAt: number;
  totalClaimed: number;
  isActive: boolean;
  apy: number;
  pendingReward?: number;
}

export interface ReferralInfo {
  totalReferrals: number;
  totalReferralRewards: number;
  referralLink: string;
  referrals: ReferralEntry[];
  chain: string[];
  /** True total downline size at ANY depth — unlike `referrals` (capped at the
   *  10 reward-eligible levels), this has no depth limit. Use for Team Size /
   *  Team Target Bonus tier eligibility, never `referrals.length`. */
  fullNetworkSize: number;
  /** Count of the full-depth downline (see fullNetworkSize) with totalStaked > 0.
   *  Same depth-cap bug as fullNetworkSize applies to a naive `referrals.filter()`
   *  count — use this instead for the "Active" stat. */
  fullNetworkActiveCount: number;
}

export interface ReferralEntry {
  address: string;
  level: number;
  stakedAmount: number;
  rewardEarned: number;
  registeredAt: number;
  /** How many people this entry has directly referred (ground-truth BFS count,
   *  not the on-chain referral_count field, which can silently under-count). */
  directReferrals: number;
}

// ===== PLATFORM TYPES =====
export interface PlatformStats {
  totalStaked: number;
  totalUsers: number;
  rewardPoolBalance: number;
  rewardRate: number;
  referralRewardRate: number;
  isPaused: boolean;
  totalBurned: number;
  /** Annual token emission driving PoS APY (token units, not raw) */
  annualEmission: number;
  /** Burn percentage on claim/compound in basis points (500 = 5% base; can rise to 1000 = 10% when the claim-referral chain is unpaid) */
  burnBps: number;
  /** Current effective APY in basis points (e.g. 25000 = 250%). Fetched live from chain. */
  effectiveAPY: number;
  /** Total tokens deposited into the long-term reserve (not yet in rewardPoolBalance). */
  totalReserve: number;
  /** Unix timestamp when the reserve was first funded — emission clock starts here. */
  emissionStartTime: number;
  /** Cumulative tokens already released from reserve into rewardPoolBalance. */
  totalEmissionReleased: number;
  /** Tokens that can be released from reserve right now. */
  releasableEmission: number;
  // Renouncement
  isRenounced: boolean;
  feeRecipient: string;       // address/pubkey of former admin
  totalFeesCollected: number; // cumulative passive fees paid out
  /** Minimum stake amount in token units — read from contract */
  minStakeAmount?: number;
  /** Max stake per user in token units — read from contract */
  maxStakePerUser?: number;
  /** Lock period in days — read from contract */
  lockPeriodDays?: number;
  /** Minimum seconds between claims — read from contract (CLAIM_INTERVAL = 21600 = 6h) */
  claimIntervalSeconds?: number;
  /** On-chain team tier config — populated from Platform.teamTierMinStaked/teamTierBonusBps. Overrides TEAM_TARGET_TIERS constants when present. */
  teamTiers?: Array<{ tier: number; label: string; color: string; minTeamStaked: number; bonusBps: number; bonusPercentage: number }>;
  /** Per-level referral percentages in BPS from on-chain Platform.referralPercentages. Falls back to REFERRAL_LEVELS constants when absent. */
  referralPercentages?: number[];
}

// ===== ADMIN TYPES =====
export interface AdminAction {
  type: 'fund' | 'setRewardRate' | 'setReferralRate' | 'blockUser' | 'unblockUser' | 'pause' | 'unpause';
  params?: Record<string, any>;
}

// ===== TRANSACTION TYPES =====
export interface TransactionResult {
  success: boolean;
  txHash: string;
  message: string;
}

export interface TxRecord {
  id: string;
  type: 'stake' | 'claim' | 'compound' | 'unstake' | 'admin' | 'referral' | 'team_bonus';
  label: string;
  amount: number;
  txHash: string;
  timestamp: number;
  status: 'success' | 'failed';
  network: NetworkType;
  /** For referral: which level (1–10) */
  referralLevel?: number;
  /** For team_bonus: bonus % applied */
  bonusPercent?: number;
}

export interface WalletData {
  stakes: StakeEntry[];
  tokenBalance: number;
  transactions: TxRecord[];
  userAccount: UserAccount;
  referralInfo: ReferralInfo;
  teamStats: { teamSize: number; teamTotalStaked: number };
}
