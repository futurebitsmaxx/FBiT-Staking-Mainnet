'use client';

/**
 * useContract — unified hook for on-chain interactions.
 *
 * `isLive`  → true when real contract addresses are set in env vars.
 *             When false, all action functions throw with a clear error
 *             so the UI can show the user what is missing.
 * `isReady` → isLive AND a wallet is connected.
 *
 * All action functions return { txHash, reward?, stakedAt? } on success
 * and throw on failure.
 */

import { useCallback, useMemo } from 'react';
import { useWallet } from '@/context/WalletContext';
import { useAppStore } from '@/lib/store';
import { NETWORK_CONFIG } from '@/lib/config';
import { getBotGuard } from '@/lib/botManagement';
import type { StakeEntry } from '@/types';

function botCheck(actionType: string): void {
  const result = getBotGuard().canPerformAction(actionType);
  if (!result.allowed) throw new Error(result.reason ?? 'Action blocked by security system.');
}

import {
  solanaInitializePlatform,
  solanaIsPlatformInitialized,
  solanaFetchPlatformStats,
  solanaStake,
  solanaClaimRewards,
  solanaCompoundRewards,
  solanaUnstake,
  solanaFundRewardPool,
  solanaDepositReserve,
  solanaReleaseEmission,
  solanaSetRewardRate,
  solanaSetReferralRewardRate,
  solanaSetReferralPercentages,
  solanaBlockUser,
  solanaUnblockUser,
  solanaGetBlockedUsers,
  solanaTogglePause,
  solanaSetAnnualEmission,
  solanaSetBurnBps,
  solanaRenounceOwnership,
  solanaSetTeamTargetTier,
  solanaGetUserStakes,
  solanaGetTokenBalance,
  solanaGetUserAccount,
  solanaGetReferralInfo,
  solanaRefundRewardPool,
  solanaUpdateUserTeamStats,
  solanaSetBatchApy,
  solanaFixBump,
} from '@/lib/contracts/solana';

function isPlaceholderAddr(addr: string | undefined): boolean {
  if (!addr || addr.length < 10) return true;
  // Reject obvious placeholder strings (e.g. YOUR_SOLANA_PROGRAM_ID)
  if (addr.toUpperCase().startsWith('YOUR_')) return true;
  return false;
}

export interface ContractHook {
  /** true when real contract addresses are configured */
  isLive: boolean;
  /** true when isLive AND wallet connected */
  isReady: boolean;

  stake(amount: number, referrer?: string): Promise<{ txHash: string; stakeIndex?: number; stakedAt?: number }>;
  claimRewards(stakeId: number | string, stakedAt: number): Promise<{ txHash: string; reward: number; burned: number | null }>;
  compoundRewards(stakeId: number | string, stakedAt: number): Promise<{ txHash: string; reward: number; burned: number | null }>;
  unstake(stakeId: number | string, stakedAt: number): Promise<{ txHash: string }>;

  /** Fetch on-chain platform stats and sync them into the Zustand store */
  syncPlatformStats(): Promise<void>;
  /**
   * Fetch the connected wallet's on-chain stakes and token balance,
   * then merge them into the Zustand store (on-chain is source of truth).
   * Safe to call at any time; silently no-ops when wallet is disconnected.
   */
  syncUserData(): Promise<void>;

  // Admin
  /** Deposit full token supply once — auto-emission handles pool funding from here on. */
  depositReserve(amount: number): Promise<{ txHash: string }>;
  /** Manually trigger release of any available emission from reserve into pool. */
  releaseEmission(): Promise<{ txHash: string }>;
  fundRewardPool(amount: number): Promise<{ txHash: string }>;
  setRewardRate(rate: number): Promise<{ txHash: string }>;
  setReferralRewardRate(rate: number): Promise<{ txHash: string }>;
  /** Update per-level referral percentages (BPS). Array of 10 values, total must be ≤ 5000 (50%). */
  setReferralPercentages(percentages: [number,number,number,number,number,number,number,number,number,number]): Promise<{ txHash: string }>;
  blockUser(address: string): Promise<{ txHash: string }>;
  unblockUser(address: string): Promise<{ txHash: string }>;
  /** Enumerates all currently-blocked users (no backend/indexer — scans on-chain state directly). */
  getBlockedUsers(): Promise<{ address: string; totalStaked: number }[]>;
  togglePause(currentlyPaused: boolean): Promise<{ txHash: string }>;
  /**
   * Update the annual emission that governs PoS APY.
   * effectiveAPY = clamp(annualEmission × 10000 / totalStaked, 1000, 30000) bps → 10%–300%
   */
  setAnnualEmission(annualEmission: number): Promise<{ txHash: string }>;
  /** Update burn percentage on claim/compound. burnBps: 0–5000 (0%–50%). Default 500 = 5% base (permanently disabled post-renouncement — see solana.ts). */
  setBurnBps(burnBps: number): Promise<{ txHash: string }>;
  /** Update a Team Target Bonus tier (index 0–9, minTeamStaked in token units, bonusBps max 1000) */
  setTeamTargetTier(index: number, minTeamStaked: number, bonusBps: number): Promise<{ txHash: string }>;
  /**
   * Permanently renounce ownership — admin loses all control, but the standard 0.25%
   * platform fee (stake/unstake/claim/compound) keeps flowing to their wallet
   * instead of the next authority's. Irreversible.
   */
  renounceOwnership(): Promise<{ txHash: string }>;
  /** Withdraw tokens from the reward pool back to admin's wallet. */
  refundRewardPool(amount: number): Promise<{ txHash: string }>;
  /** Set the fallback base APY BPS (1000–30000). Only active when emission=0. */
  setBaseFallbackApy(apyBps: number): Promise<{ txHash: string }>;
  /** Admin crank: set a user's team_size and team_total_staked on-chain. */
  updateUserTeamStats(userAddress: string, teamSize: number, teamTotalStaked: number): Promise<{ txHash: string }>;
  /** One-time setup: create the Platform PDA. Must be called before any other instruction. */
  initializePlatform(rewardRate?: number, referralRewardRate?: number): Promise<{ txHash: string }>;
  /** Check whether the Platform PDA has been initialized on-chain. */
  isPlatformInitialized(): Promise<boolean>;
  /** Fix platform.bump = 0 bug in old deployed binary. Sets bump to canonical value (253). */
  fixBump(): Promise<{ txHash: string }>;
}

export function useContract(): ContractHook {
  const { solanaAddress } = useWallet();
  const { selectedNetwork, updatePlatformStats, loadOnChainData } = useAppStore();

  const chainAddress = solanaAddress;
  const address = solanaAddress;

  const config = NETWORK_CONFIG[selectedNetwork];

  const isLive = useMemo(() => {
    // Needs a deployed contract address and stake token mint.
    if (isPlaceholderAddr(config.contractAddress)) return false;
    if (isPlaceholderAddr(config.stakeTokenAddress)) return false;
    // Vault addresses are NOT checked here — the vault helper functions
    // throw specific "not configured" errors when stake/claim/unstake is
    // attempted without them. Admin-only operations don't need vaults.
    return true;
  }, [config]);

  const isReady = useMemo(() => isLive && !!chainAddress, [isLive, chainAddress]);

  // ── Staking ────────────────────────────────────────────────────────────────

  const stake = useCallback(
    (amount: number, referrer?: string) => {
      botCheck('stake');
      return solanaStake(amount, referrer);
    },
    []
  );

  const claimRewards = useCallback(
    (stakeId: number | string, stakedAt: number) => {
      botCheck('claim');
      return solanaClaimRewards(stakeId, stakedAt);
    },
    []
  );

  const compoundRewards = useCallback(
    (stakeId: number | string, stakedAt: number) => {
      botCheck('compound');
      return solanaCompoundRewards(stakeId, stakedAt);
    },
    []
  );

  const unstake = useCallback(
    (stakeId: number | string, _stakedAt: number) => {
      botCheck('unstake');
      return solanaUnstake(Number(stakeId));
    },
    []
  );

  // ── Sync ──────────────────────────────────────────────────────────────────

  const syncPlatformStats = useCallback(async () => {
    const stats = await solanaFetchPlatformStats();
    if (!stats) return;

    updatePlatformStats(stats);

    // Emission release is bundled as a pre-instruction inside every claim/compound
    // transaction — no separate background trigger needed or wanted here.
  }, [updatePlatformStats]);

  const syncUserData = useCallback(async () => {
    if (!address || !chainAddress) return;

    const tokenConfigured = !isPlaceholderAddr(config.stakeTokenAddress);

    try {
      const update: Parameters<typeof loadOnChainData>[1] = {};

      if (isLive) {
        const [stakesResult, userAccountResult, referralInfoResult] = await Promise.allSettled([
          solanaGetUserStakes(chainAddress),
          solanaGetUserAccount(chainAddress),
          solanaGetReferralInfo(chainAddress),
        ]);
        // Only overwrite stakes when the call succeeded AND returned non-null.
        // null means an RPC error — preserve whatever the store already has.
        if (stakesResult.status === 'fulfilled' && stakesResult.value !== null) {
          update.stakes = stakesResult.value as StakeEntry[];
        }
        if (userAccountResult.status === 'fulfilled' && userAccountResult.value) update.userAccount = userAccountResult.value;
        if (referralInfoResult.status === 'fulfilled' && referralInfoResult.value) {
          update.referralInfo = referralInfoResult.value;
        } else if (update.userAccount) {
          // referralInfo fetch failed OR returned null — always synthesize from
          // userAccount so the count is never lost (covers both RPC errors and
          // cases where the contract returns null for an un-registered user).
          update.referralInfo = {
            totalReferrals:       update.userAccount.referralCount,
            totalReferralRewards: update.userAccount.totalReferralRewards,
            referralLink:         '',
            referrals:            [],
            chain:                [],
            fullNetworkSize:      update.userAccount.teamSize,
            // No on-chain field to derive an active count from in this fallback
            // path (only hit when the full referralInfo fetch itself failed) —
            // 0 undercounts safely rather than guessing.
            fullNetworkActiveCount: 0,
          };
        }
      }

      if (tokenConfigured) {
        const balanceResult = await Promise.allSettled([solanaGetTokenBalance(chainAddress)]);
        if (balanceResult[0].status === 'fulfilled') update.tokenBalance = balanceResult[0].value;
      }

      if (Object.keys(update).length > 0) {
        loadOnChainData(address, update);
      }
    } catch (err) {
      console.warn('[useContract] syncUserData failed:', err);
    }
  }, [address, chainAddress, isLive, config, loadOnChainData]);

  // ── Admin ─────────────────────────────────────────────────────────────────

  const depositReserve = useCallback((amount: number) => solanaDepositReserve(amount), []);
  const releaseEmission = useCallback(() => solanaReleaseEmission(), []);
  const fundRewardPool = useCallback((amount: number) => solanaFundRewardPool(amount), []);
  const setRewardRate = useCallback((rate: number) => solanaSetRewardRate(rate), []);
  const setReferralRewardRate = useCallback((rate: number) => solanaSetReferralRewardRate(rate), []);
  const setReferralPercentages = useCallback(
    (percentages: [number,number,number,number,number,number,number,number,number,number]) =>
      solanaSetReferralPercentages(percentages),
    []
  );
  const blockUser = useCallback((userAddress: string) => solanaBlockUser(userAddress), []);
  const unblockUser = useCallback((userAddress: string) => solanaUnblockUser(userAddress), []);
  const getBlockedUsers = useCallback(() => solanaGetBlockedUsers(), []);
  const togglePause = useCallback((_currentlyPaused: boolean) => solanaTogglePause(), []);
  const setAnnualEmission = useCallback((annualEmission: number) => solanaSetAnnualEmission(annualEmission), []);
  const setBurnBps = useCallback((burnBps: number) => solanaSetBurnBps(burnBps), []);
  const setTeamTargetTier = useCallback(
    (index: number, minTeamStaked: number, bonusBps: number) => solanaSetTeamTargetTier(index, minTeamStaked, bonusBps),
    []
  );
  const renounceOwnership = useCallback(() => solanaRenounceOwnership(), []);
  const refundRewardPool = useCallback((amount: number) => solanaRefundRewardPool(amount), []);
  const updateUserTeamStats = useCallback(
    (userAddress: string, teamSize: number, teamTotalStaked: number) =>
      solanaUpdateUserTeamStats(userAddress, teamSize, teamTotalStaked),
    []
  );
  const setBaseFallbackApy = useCallback((apyBps: number) => solanaSetBatchApy(apyBps), []);
  const initializePlatform = useCallback(
    (rewardRate?: number, referralRewardRate?: number) => solanaInitializePlatform(rewardRate, referralRewardRate),
    []
  );
  const isPlatformInitialized = useCallback(() => solanaIsPlatformInitialized(), []);
  const fixBump = useCallback(() => solanaFixBump(), []);

  return {
    isLive,
    isReady,
    stake,
    claimRewards,
    compoundRewards,
    unstake,
    syncPlatformStats,
    syncUserData,
    depositReserve,
    releaseEmission,
    fundRewardPool,
    setRewardRate,
    setReferralRewardRate,
    setReferralPercentages,
    blockUser,
    unblockUser,
    getBlockedUsers,
    togglePause,
    setAnnualEmission,
    setBurnBps,
    setTeamTargetTier,
    renounceOwnership,
    refundRewardPool,
    updateUserTeamStats,
    setBaseFallbackApy,
    initializePlatform,
    isPlatformInitialized,
    fixBump,
  };
}
