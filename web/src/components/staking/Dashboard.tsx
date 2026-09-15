'use client';

import React, { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import toast from 'react-hot-toast';
import { useWallet } from '@/context/WalletContext';
import { useAppStore } from '@/lib/store';
import { useContract } from '@/hooks/useContract';
import {
  formatNumber,
  getTimeRemaining,
  calculatePendingReward,
  calculateLivePendingReward,
  getLockPeriodInfo,
  canClaimRewards,
  getNextClaimLabel,
  getDailyReward,
} from '@/lib/utils';
import { getExplorerTxUrl } from '@/lib/config';
import { checkRateLimit, sanitizeErrorMessage } from '@/lib/security';
import ContractSetupNotice from '@/components/ui/ContractSetupNotice';
import UsdValue from '@/components/ui/UsdValue';
import { useTokenPrice } from '@/hooks/useTokenPrice';
import { LOCK_PERIOD, TEAM_TARGET_TIERS, type PlatformStats } from '@/types';
import { solanaGetTokenBalance } from '@/lib/contracts/solana';

type ActionKey = string;

export default function Dashboard() {
  const { address, solanaAddress } = useWallet();
  const {
    selectedNetwork,
    platformStats,
    getWalletData,
    claimStakeReward,
    compoundStakeReward,
    unstakeEntry,
    addTransaction,
    loadOnChainData,
    setConnectGateOpen,
  } = useAppStore();
  const contract = useContract();
  const { pairs: pricePairs } = useTokenPrice();
  const fbitPriceUsd = pricePairs[0]?.priceUsd ? Number(pricePairs[0].priceUsd) : null;

  // Re-render every second so pending rewards tick live
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  // Direct balance fetch — reads straight from RPC into local state
  const [tokenBalance, setTokenBalance] = useState(0);
  const [balanceFetching, setBalanceFetching] = useState(false);

  const fetchTokenBalance = useCallback(async () => {
    if (!address) return;
    setBalanceFetching(true);
    try {
      let bal = 0;
      const addr = solanaAddress ?? address;
      if (addr) bal = await solanaGetTokenBalance(addr);
      setTokenBalance(bal);
      loadOnChainData(address, { tokenBalance: bal });
    } catch (err) {
      console.warn('[fetchTokenBalance] failed:', err);
    } finally {
      setBalanceFetching(false);
    }
  }, [address, solanaAddress, selectedNetwork, loadOnChainData]);

  useEffect(() => {
    if (!address) { setTokenBalance(0); setBalanceFetching(false); return; }
    fetchTokenBalance();
    const id = setInterval(fetchTokenBalance, 30_000);
    return () => clearInterval(id);
  }, [address, fetchTokenBalance]);

  // Pull platform stats + user data on connect/network-switch, then poll every 30 s
  useEffect(() => {
    if (!address) return;
    void contract.syncPlatformStats().catch(() => {});
    void contract.syncUserData().catch(() => {});
    const id = setInterval(() => {
      void contract.syncPlatformStats().catch(() => {});
      void contract.syncUserData().catch(() => {});
    }, 60_000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address, selectedNetwork]);

  const [loading, setLoading] = useState<Record<ActionKey, boolean>>({});
  const [showHistory, setShowHistory] = useState(false);

  const walletData = getWalletData();
  const stakes = walletData?.stakes ?? [];
  const userAccount = walletData?.userAccount ?? null;
  const referralInfo = walletData?.referralInfo ?? null;
  const transactions = walletData?.transactions ?? [];

  // team_size on-chain is only updated when remaining_accounts are passed at stake time.
  // Use the full-depth BFS network count as fallback so Dashboard matches ReferralPanel.
  // Must be fullNetworkSize (unbounded depth), not referrals.length (capped at the
  // 10 reward-eligible levels) — a downline chain can run deeper than that.
  const networkTotal = referralInfo?.fullNetworkSize ?? 0;
  const effectiveTeamSize = Math.max(userAccount?.teamSize ?? 0, networkTotal);
  // Same depth-cap bug as team_size: on-chain team_total_staked only propagates
  // up the nearest 10 ancestors from each staker, so it undercounts for deeper
  // networks — use the full-depth BFS sum for Team Target Bonus tier math.
  const effectiveTeamTotalStaked = Math.max(userAccount?.teamTotalStaked ?? 0, referralInfo?.fullNetworkTotalStaked ?? 0);

  const activeStakes = stakes
    .filter(s => s.isActive)
    .filter(s => {
      const id = typeof s.id === 'number' ? s.id : parseInt(String(s.id), 10);
      return Number.isFinite(id) && id >= 0 && Number.isInteger(id);
    });
  const totalUserStaked = activeStakes.reduce((a, s) => a + s.amount, 0);
  // Always use live platform APY for reward display — APY is dynamic (not locked at stake time)
  const liveApyBps = platformStats.effectiveAPY || 1000;

  // Live display reward — counts smoothly every second for visual feedback.
  // Actual claimable amount (on-chain, discrete 6h intervals) is used inside handleClaim/handleCompound.
  const getLiveDisplay = (s: typeof activeStakes[0]) =>
    calculateLivePendingReward(s.amount, liveApyBps, s.lastClaimAt);

  // Fallback for claim handler when on-chain result.reward is 0.
  const getDiscretePending = (s: typeof activeStakes[0]) =>
    s.pendingReward !== undefined ? s.pendingReward : calculatePendingReward(s.amount, liveApyBps, s.lastClaimAt);

  const totalPending = activeStakes.reduce((a, s) => a + getLiveDisplay(s), 0);
  const totalClaimed = stakes.reduce((a, s) => a + s.totalClaimed, 0);

  const setActionLoading = (key: ActionKey, v: boolean) =>
    setLoading(prev => ({ ...prev, [key]: v }));

  const handleClaim = useCallback(async (stakeId: number | string) => {
    const stake = stakes.find(s => s.id === stakeId);
    if (!stake) return;
    // Guard: stakeId must be a non-negative integer — stale localStorage can hold "" or NaN
    const numericId = typeof stakeId === 'number' ? stakeId : parseInt(String(stakeId), 10);
    if (!Number.isFinite(numericId) || numericId < 0) {
      toast.error('Stake data is stale — refreshing from chain…');
      void contract.syncUserData().catch(() => {});
      return;
    }
    if (!checkRateLimit('claim', { maxCalls: 5, windowMs: 60_000 })) {
      toast.error('Too many claim attempts. Please wait a minute.');
      return;
    }
    const key = `${stakeId}-claim`;
    setActionLoading(key, true);
    try {
      if (!contract.isLive) throw new Error('Contract not configured. Set up your deployment addresses to execute on-chain transactions.');
      const result = await contract.claimRewards(stakeId, stake.stakedAt);
      const txHash = result.txHash;
      // result.reward is already the true net amount (post fee, burn, and the
      // claim-time referral cut) read directly from the confirmed transaction's
      // own on-chain event — not a client-side estimate (see solanaClaimRewards).
      const net    = result.reward > 0 ? result.reward : getDiscretePending(stake);
      const burned = result.burned; // exact, from the same transaction's TokensBurned event (may be null on a parse failure)

      void contract.syncPlatformStats().catch(() => {});
      void contract.syncUserData().catch(() => {});
      void fetchTokenBalance();

      claimStakeReward(stakeId, net);

      const burnedLabel = burned != null ? ` (burned ${formatNumber(burned)})` : '';
      addTransaction({
        id: Date.now().toString(),
        type: 'claim',
        label: `Claimed ${formatNumber(net)} FBiT${burnedLabel}`,
        amount: net,
        txHash,
        timestamp: Date.now(),
        status: 'success',
        network: selectedNetwork,
      });
      toast.success(
        burned != null
          ? `✓ Claimed ${formatNumber(net)} FBiT · ${formatNumber(burned)} FBiT burned 🔥`
          : `✓ Claimed ${formatNumber(net)} FBiT`
      );
    } catch (err: any) {
      console.error('[handleClaim] error:', err);
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('invalid BigNumberish') || msg.includes('BigNumberish')) {
        toast.error('Transaction failed — please refresh the page and try again.');
        void contract.syncUserData().catch(() => {});
      } else {
        toast.error(sanitizeErrorMessage(err));
      }
    } finally {
      setActionLoading(key, false);
    }
  }, [stakes, contract, platformStats, claimStakeReward, addTransaction, selectedNetwork, fetchTokenBalance]);

  const handleCompound = useCallback(async (stakeId: number | string) => {
    const stake = stakes.find(s => s.id === stakeId);
    if (!stake) return;
    const numericId = typeof stakeId === 'number' ? stakeId : parseInt(String(stakeId), 10);
    if (!Number.isFinite(numericId) || numericId < 0) {
      toast.error('Stake data is stale — refreshing from chain…');
      void contract.syncUserData().catch(() => {});
      return;
    }
    if (!checkRateLimit('compound', { maxCalls: 5, windowMs: 60_000 })) {
      toast.error('Too many compound attempts. Please wait a minute.');
      return;
    }
    const key = `${stakeId}-compound`;
    setActionLoading(key, true);
    try {
      if (!contract.isLive) throw new Error('Contract not configured. Set up your deployment addresses to execute on-chain transactions.');
      const result = await contract.compoundRewards(stakeId, stake.stakedAt);
      const txHash = result.txHash;
      // result.reward is already the true net compound amount (post fee, burn,
      // and the claim-time referral cut), read from the confirmed transaction's
      // own on-chain event — not a client-side estimate (see solanaCompoundRewards).
      const net    = result.reward > 0 ? result.reward : getDiscretePending(stake);
      const burned = result.burned; // exact, from the same transaction's TokensBurned event (may be null on a parse failure)

      void contract.syncPlatformStats().catch(() => {});
      void contract.syncUserData().catch(() => {});

      compoundStakeReward(stakeId, net);

      const burnedLabel = burned != null ? ` (burned ${formatNumber(burned, 8)})` : '';
      addTransaction({
        id: Date.now().toString(),
        type: 'compound',
        label: `Compounded ${formatNumber(net, 8)} FBiT${burnedLabel}`,
        amount: net,
        txHash,
        timestamp: Date.now(),
        status: 'success',
        network: selectedNetwork,
      });
      toast.success(
        burned != null
          ? `↑ Compounded ${formatNumber(net, 8)} FBiT · ${formatNumber(burned, 8)} FBiT burned 🔥`
          : `↑ Compounded ${formatNumber(net, 8)} FBiT`
      );
    } catch (err: any) {
      console.error('[handleCompound] error:', err);
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('invalid BigNumberish') || msg.includes('BigNumberish')) {
        toast.error('Transaction failed — please refresh the page and try again.');
        void contract.syncUserData().catch(() => {});
      } else {
        toast.error(sanitizeErrorMessage(err));
      }
    } finally {
      setActionLoading(key, false);
    }
  }, [stakes, contract, platformStats, compoundStakeReward, addTransaction, selectedNetwork]);

  const handleUnstake = useCallback(async (stakeId: number | string) => {
    const stake = stakes.find(s => s.id === stakeId);
    if (!stake) return;
    const numericId = typeof stakeId === 'number' ? stakeId : parseInt(String(stakeId), 10);
    if (!Number.isFinite(numericId) || numericId < 0) {
      toast.error('Stake data is stale — refreshing from chain…');
      void contract.syncUserData().catch(() => {});
      return;
    }
    if (!checkRateLimit('unstake', { maxCalls: 3, windowMs: 60_000 })) {
      toast.error('Too many unstake attempts. Please wait a minute.');
      return;
    }
    const key = `${stakeId}-unstake`;
    setActionLoading(key, true);
    try {
      if (!contract.isLive) throw new Error('Contract not configured. Set up your deployment addresses to execute on-chain transactions.');
      const result = await contract.unstake(stakeId, stake.stakedAt);
      const txHash = result.txHash;
      void contract.syncPlatformStats().catch(() => {});
      void contract.syncUserData().catch(() => {});
      void fetchTokenBalance();

      unstakeEntry(stakeId);
      addTransaction({
        id: Date.now().toString(),
        type: 'unstake',
        label: `Unstaked ${formatNumber(stake.amount)} FBiT`,
        amount: stake.amount,
        txHash,
        timestamp: Date.now(),
        status: 'success',
        network: selectedNetwork,
      });
      toast.success(`✓ Unstaked ${formatNumber(stake.amount)} FBiT — returned to wallet!`);
    } catch (err: any) {
      console.error('[handleUnstake] error:', err);
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('invalid BigNumberish') || msg.includes('BigNumberish')) {
        toast.error('Transaction failed — please refresh the page and try again.');
        void contract.syncUserData().catch(() => {});
      } else {
        toast.error(sanitizeErrorMessage(err));
      }
    } finally {
      setActionLoading(key, false);
    }
  }, [stakes, contract, unstakeEntry, addTransaction, selectedNetwork, fetchTokenBalance]);

  if (!address) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] text-center px-4">
        <div className="w-20 h-20 rounded-2xl bg-linear-to-br from-brand-500/20 to-accent-purple/20 flex items-center justify-center mb-6 animate-float">
          <span className="text-4xl">◈</span>
        </div>
        <h2 className="font-display text-2xl sm:text-3xl font-bold mb-3">Welcome to FutureBit</h2>
        <p className="text-text-secondary max-w-md mb-8">
          Connect your wallet to stake FBiT tokens, earn rewards up to 300% APY, and build your referral network.
        </p>
        <div className="flex flex-wrap justify-center gap-3 mb-8">
          <div className="glass-card text-center py-3 px-6">
            <div className="text-brand-400 font-display font-bold text-lg">{Math.round((platformStats.effectiveAPY || 1000) / 100)}%</div>
            <div className="text-text-muted text-xs mt-0.5">{LOCK_PERIOD.label} · PoS · 10%–300%</div>
          </div>
        </div>
        <div className="flex flex-wrap justify-center gap-4">
          <button
            type="button"
            onClick={() => setConnectGateOpen(true)}
            className="btn-primary text-base px-8 py-3.5"
          >
            Connect Wallet
          </button>
          <Link href="/" className="btn-secondary text-base px-8 py-3.5">
            ← Home
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Blocked account banner */}
      {userAccount?.isBlocked && (
        <div className="glass-card border border-accent-rose/40 bg-accent-rose/5 flex items-center gap-3 p-4">
          <span className="text-accent-rose text-xl shrink-0">🚫</span>
          <div>
            <p className="font-display font-semibold text-accent-rose text-sm">Account Blocked</p>
            <p className="text-text-muted text-xs mt-0.5">
              Your wallet has been blocked by the platform. Stake, claim, and compound actions are disabled. Contact support if you believe this is an error.
            </p>
          </div>
        </div>
      )}

      {/* Contract setup notice */}
      <ContractSetupNotice />

      {/* Platform Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 sm:gap-4">
        <StatCard label="Total Value Locked"   value={`${formatNumber(platformStats.totalStaked)} FBiT`} icon="◈" accent="brand"
          usdSub={<UsdValue amount={platformStats.totalStaked} priceUsd={fbitPriceUsd} />} />
        <StatCard label="Total Users"          value={formatNumber(platformStats.totalUsers, 0)}          icon="◎" accent="purple" />
        <StatCard label="Reward Pool"          value={`${formatNumber(platformStats.rewardPoolBalance)} FBiT`} icon="⬡" accent="cyan"
          usdSub={<UsdValue amount={platformStats.rewardPoolBalance} priceUsd={fbitPriceUsd} />} />
        <StatCard label="Current APY"          value={`${Math.round((platformStats.effectiveAPY || 1000) / 100)}%`} icon="%" accent="amber" />
      </div>

      {/* User Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 sm:gap-4">
        <div className="glass-card">
          <p className="text-text-muted text-xs font-display uppercase tracking-wider mb-1">Total Staked</p>
          <p className="stat-value text-xl sm:text-2xl md:text-3xl">{formatNumber(totalUserStaked, 8)}</p>
          <p className="text-text-secondary text-xs mt-1">
            FBiT Tokens <UsdValue amount={totalUserStaked} priceUsd={fbitPriceUsd} />
          </p>
        </div>
        <div className="glass-card">
          <p className="text-text-muted text-xs font-display uppercase tracking-wider mb-1">Pending Rewards</p>
          <p className="stat-value text-xl sm:text-2xl md:text-3xl tabular-nums">
            {formatNumber(totalPending, 8)}
          </p>
          <p className="text-text-secondary text-xs mt-1">
            FBiT Accruing <UsdValue amount={totalPending} priceUsd={fbitPriceUsd} />
          </p>
        </div>
        <div className="glass-card">
          <p className="text-text-muted text-xs font-display uppercase tracking-wider mb-1">Total Claimed</p>
          <p className="stat-value text-xl sm:text-2xl md:text-3xl">{formatNumber(totalClaimed, 8)}</p>
          <p className="text-text-secondary text-xs mt-1">
            FBiT Earned <UsdValue amount={totalClaimed} priceUsd={fbitPriceUsd} />
          </p>
        </div>
        <div className="glass-card">
          <p className="text-text-muted text-xs font-display uppercase tracking-wider mb-1">Wallet Balance</p>
          {balanceFetching && tokenBalance === 0 ? (
            <p className="stat-value text-xl sm:text-2xl md:text-3xl text-text-muted animate-pulse">···</p>
          ) : (
            <p className="stat-value text-xl sm:text-2xl md:text-3xl">{formatNumber(tokenBalance, 8)}</p>
          )}
          <p className="text-text-secondary text-xs mt-1">
            FBiT Available <UsdValue amount={tokenBalance} priceUsd={fbitPriceUsd} />
          </p>
        </div>
      </div>

      {/* Referral Stats */}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3 sm:gap-4">
        <div className="glass-card border border-accent-purple/10 bg-linear-to-br from-accent-purple/5 to-transparent">
          <p className="text-text-muted text-xs font-display uppercase tracking-wider mb-1">My Referrals</p>
          <p className="font-display font-bold text-2xl sm:text-3xl gradient-text">
            {referralInfo?.totalReferrals ?? userAccount?.referralCount ?? 0}
          </p>
          <p className="text-text-secondary text-xs mt-1">Total referred users</p>
        </div>
        <div className="glass-card border border-accent-cyan/10 bg-linear-to-br from-accent-cyan/5 to-transparent">
          <p className="text-text-muted text-xs font-display uppercase tracking-wider mb-1">Referral Earned</p>
          <p className="font-display font-bold text-2xl sm:text-3xl text-accent-cyan">
            {formatNumber(userAccount?.totalReferralRewards ?? 0, 8)}
          </p>
          <p className="text-text-secondary text-xs mt-1">
            FBiT from referrals <UsdValue amount={userAccount?.totalReferralRewards ?? 0} priceUsd={fbitPriceUsd} />
          </p>
        </div>
        <div className="glass-card col-span-2 md:col-span-1 border border-brand-500/10 bg-linear-to-br from-brand-500/5 to-transparent">
          <p className="text-text-muted text-xs font-display uppercase tracking-wider mb-1">Team Size</p>
          <p className="font-display font-bold text-2xl sm:text-3xl text-brand-400">
            {effectiveTeamSize}
          </p>
          <p className="text-text-secondary text-xs mt-1">Members in your network</p>
        </div>
      </div>

      {/* Active Stakes */}
      <div className="glass-card">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-display font-semibold text-lg">Active Stakes</h3>
          <span className="text-xs text-text-muted font-display px-2 py-1 rounded-lg bg-surface-800/60 border border-white/5">
            {activeStakes.length} position{activeStakes.length !== 1 ? 's' : ''}
          </span>
        </div>

        {activeStakes.length === 0 ? (
          <div className="text-center py-12 text-text-muted">
            <div className="text-4xl mb-3 opacity-30">◈</div>
            <p className="text-sm">No active stakes — go to <span className="text-brand-400">Stake</span> to begin earning!</p>
          </div>
        ) : (
          <div className="space-y-3">
            {activeStakes.map((stake) => {
              const period = getLockPeriodInfo(stake.lockPeriodIndex);
              const pending = getLiveDisplay(stake);
              const daily = getDailyReward(stake.amount, liveApyBps);
              const isUnlocked = Date.now() / 1000 >= stake.unlockAt;
              const claimable = canClaimRewards(stake.lastClaimAt);
              const nextClaim = getNextClaimLabel(stake.lastClaimAt);

              const claimLoading    = loading[`${stake.id}-claim`];
              const compoundLoading = loading[`${stake.id}-compound`];
              const unstakeLoading  = loading[`${stake.id}-unstake`];
              const anyLoading      = claimLoading || compoundLoading || unstakeLoading;

              return (
                <div key={stake.id} className="rounded-xl bg-surface-800/50 border border-white/5 overflow-hidden">
                  {/* Lock banner */}
                  <div className={`flex items-center gap-2 px-4 py-2 text-xs font-display font-medium ${
                    isUnlocked
                      ? 'bg-brand-500/10 text-brand-400 border-b border-brand-500/10'
                      : 'bg-accent-purple/10 text-accent-purple border-b border-accent-purple/10'
                  }`}>
                    <span>{isUnlocked ? '🔓' : '🔒'}</span>
                    {isUnlocked ? 'Lock expired — tokens ready to unstake' : `Locked · ${getTimeRemaining(stake.unlockAt)} remaining`}
                  </div>

                  <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between p-4 gap-4">
                    {/* Left: stake info */}
                    <div className="flex items-center gap-3">
                      <div className={`w-10 h-10 rounded-xl flex items-center justify-center text-sm font-bold shrink-0 ${
                        isUnlocked ? 'bg-brand-500/20 text-brand-400' : 'bg-accent-purple/20 text-accent-purple'
                      }`}>
                        #{Number(stake.id) + 1}
                      </div>
                      <div>
                        <p className="font-display font-semibold">
                          {formatNumber(stake.amount)} FBiT{' '}
                          <UsdValue amount={stake.amount} priceUsd={fbitPriceUsd} className="text-xs font-normal" />
                        </p>
                        <p className="text-text-muted text-xs">{period.label} lock · {Math.round(liveApyBps / 100)}% APY (live)</p>
                        <p className="text-text-muted text-xs mt-0.5">
                          Per 6h: <span className="text-brand-400 font-mono">+{formatNumber(daily, 8)} FBiT</span>{' '}
                          <UsdValue amount={daily} priceUsd={fbitPriceUsd} />
                        </p>
                      </div>
                    </div>

                    {/* Right: reward + actions */}
                    <div className="flex flex-col sm:items-end gap-3 w-full sm:w-auto">
                      <div className="sm:text-right">
                        {/* Live ticking reward counter */}
                        <div className="flex items-center gap-1.5 sm:justify-end">
                          <span className="w-1.5 h-1.5 rounded-full bg-brand-400 animate-pulse shrink-0" />
                          <p className="text-brand-400 font-mono text-sm font-semibold tabular-nums">
                            +{formatNumber(pending, 8)} FBiT
                          </p>
                        </div>
                        <UsdValue amount={pending} priceUsd={fbitPriceUsd} className="text-[11px]" />
                        {claimable ? (
                          <p className="text-xs text-brand-400/70">Claim available now</p>
                        ) : (
                          <p className="text-xs text-text-muted">
                            Next claim <span className="text-accent-amber font-mono">{nextClaim}</span>
                          </p>
                        )}
                      </div>

                      {/* Action buttons */}
                      <div className="flex gap-2 flex-wrap">
                        <ActionButton
                          label={claimLoading ? 'Claiming…' : claimable ? 'Claim' : `Claim (${nextClaim})`}
                          disabled={!claimable || !!anyLoading || !!userAccount?.isBlocked}
                          loading={claimLoading}
                          onClick={() => handleClaim(stake.id)}
                          variant="brand"
                        />
                        <ActionButton
                          label={compoundLoading ? 'Compounding…' : claimable ? 'Compound' : `Compound (${nextClaim})`}
                          disabled={!claimable || !!anyLoading || !!userAccount?.isBlocked}
                          loading={compoundLoading}
                          onClick={() => handleCompound(stake.id)}
                          variant="cyan"
                        />
                        {isUnlocked ? (
                          <ActionButton
                            label={unstakeLoading ? 'Unstaking…' : 'Unstake'}
                            disabled={!!anyLoading}
                            loading={unstakeLoading}
                            onClick={() => handleUnstake(stake.id)}
                            variant="rose"
                          />
                        ) : (
                          <button type="button" disabled className="px-3 py-1.5 rounded-lg text-xs font-display font-medium bg-surface-900/50 text-text-muted border border-white/5 cursor-not-allowed opacity-40">
                            Locked
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Burn & PoS Emission */}
      <BurnEmissionPanel stats={platformStats} network={selectedNetwork} priceUsd={fbitPriceUsd} />

      {/* Team Target Bonus */}
      <TeamTargetBonusCard
        teamTotalStaked={effectiveTeamTotalStaked}
        teamSize={effectiveTeamSize}
        onChainBonusBps={userAccount?.currentTierBonusBps}
        liveTiers={platformStats.teamTiers as typeof TEAM_TARGET_TIERS[number][] | undefined}
        priceUsd={fbitPriceUsd}
      />

      {/* Daily Claim Info */}
      <div className="glass-card bg-linear-to-br from-brand-500/5 to-accent-cyan/5 border border-brand-500/10">
        <div className="flex items-start gap-4">
          <div className="w-10 h-10 rounded-xl bg-brand-500/20 flex items-center justify-center text-xl shrink-0">⏱</div>
          <div>
            <h4 className="font-display font-semibold text-sm mb-1">6-Hour Reward Claiming</h4>
            <p className="text-text-muted text-xs leading-relaxed">
              Rewards accrue every second based on your staked amount and APY. Claim once every{' '}
              <span className="text-brand-400 font-medium">6 hours</span> per stake, or use{' '}
              <span className="text-accent-cyan font-medium">Compound</span> to re-stake earnings and accelerate growth.
            </p>
          </div>
        </div>
      </div>

      {/* Transaction History */}
      {transactions.length > 0 && (
        <div className="glass-card">
          <div className="flex items-center justify-between mb-3">
            <h3 className="font-display font-semibold">Transaction History</h3>
            <button
              type="button"
              onClick={() => setShowHistory(v => !v)}
              className="text-xs text-text-muted hover:text-text-secondary font-display transition-colors"
            >
              {showHistory ? 'Hide ▲' : `Show ${transactions.length} ▼`}
            </button>
          </div>
          {showHistory && (
            <div className="space-y-2">
              {transactions.map(tx => (
                <div key={tx.id} className="flex items-center justify-between py-2.5 px-3 rounded-xl bg-surface-800/40 border border-white/5 text-sm">
                  <div className="flex items-center gap-2">
                    <span className={`w-6 h-6 rounded-md flex items-center justify-center text-xs ${
                      tx.type === 'stake'    ? 'bg-brand-500/20 text-brand-400' :
                      tx.type === 'claim'   ? 'bg-accent-cyan/20 text-accent-cyan' :
                      tx.type === 'compound'? 'bg-accent-purple/20 text-accent-purple' :
                      tx.type === 'unstake' ? 'bg-accent-rose/20 text-accent-rose' :
                      'bg-accent-amber/20 text-accent-amber'
                    }`}>
                      {tx.type === 'stake' ? '↓' : tx.type === 'claim' ? '↑' : tx.type === 'compound' ? '↻' : tx.type === 'unstake' ? '↩' : '⚙'}
                    </span>
                    <span className="text-text-secondary text-xs">{tx.label}</span>
                  </div>
                  <div className="text-right">
                    <p className="font-mono text-xs text-text-muted">{new Date(tx.timestamp).toLocaleTimeString()}</p>
                    <a
                      href={getExplorerTxUrl(tx.network, tx.txHash)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-mono text-[10px] text-brand-400/60 hover:text-brand-400 transition-colors"
                      title="View on explorer"
                    >
                      {tx.txHash.slice(0, 14)}… ↗
                    </a>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Sub-components ────────────────────────────────────────────────────────────

function ActionButton({
  label, disabled, loading, onClick, variant,
}: {
  label: string;
  disabled: boolean;
  loading?: boolean;
  onClick: () => void;
  variant: 'brand' | 'cyan' | 'rose';
}) {
  const colors = {
    brand: 'bg-brand-500/10 text-brand-400 border-brand-500/20 hover:bg-brand-500/20',
    cyan:  'bg-accent-cyan/10 text-accent-cyan border-accent-cyan/20 hover:bg-accent-cyan/20',
    rose:  'bg-accent-rose/10 text-accent-rose border-accent-rose/20 hover:bg-accent-rose/20',
  };
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`px-3 py-1.5 rounded-lg text-xs font-display font-medium border transition-all flex items-center gap-1 ${
        disabled
          ? 'bg-surface-900/50 text-text-muted border-white/5 cursor-not-allowed opacity-50'
          : colors[variant]
      }`}
    >
      {loading && (
        <svg className="animate-spin h-3 w-3" viewBox="0 0 24 24" fill="none">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
      )}
      {label}
    </button>
  );
}

// ─── Team Target Bonus Card ────────────────────────────────────────────────────

function TeamTargetBonusCard({ teamTotalStaked, teamSize, onChainBonusBps, liveTiers, priceUsd }: { teamTotalStaked: number; teamSize: number; onChainBonusBps?: number; liveTiers?: typeof TEAM_TARGET_TIERS[number][]; priceUsd: number | null }) {
  const tiers = liveTiers ?? TEAM_TARGET_TIERS;
  // Find current and next tier using on-chain values when available
  const activeTierIndex = (() => {
    for (let i = tiers.length - 1; i >= 0; i--) {
      if (teamTotalStaked >= tiers[i].minTeamStaked) return i;
    }
    return -1;
  })();

  const activeTier = activeTierIndex >= 0 ? tiers[activeTierIndex] : null;
  const nextTier   = activeTierIndex < tiers.length - 1
    ? tiers[activeTierIndex + 1]
    : null;

  const progress = nextTier
    ? Math.min(100, (teamTotalStaked / nextTier.minTeamStaked) * 100)
    : 100;

  type TierColor = typeof TEAM_TARGET_TIERS[number]['color'];

  const tierColorMap: Record<TierColor, string> = {
    amber:  'text-accent-amber',
    slate:  'text-slate-400',
    yellow: 'text-yellow-400',
    cyan:   'text-accent-cyan',
    purple: 'text-accent-purple',
    rose:   'text-accent-rose',
    green:  'text-emerald-400',
    blue:   'text-blue-400',
    gray:   'text-gray-400',
    brand:  'text-brand-400',
  };
  const tierBgMap: Record<TierColor, string> = {
    amber:  'bg-accent-amber/20',
    slate:  'bg-slate-400/20',
    yellow: 'bg-yellow-400/20',
    cyan:   'bg-accent-cyan/20',
    purple: 'bg-accent-purple/20',
    rose:   'bg-accent-rose/20',
    green:  'bg-emerald-400/20',
    blue:   'bg-blue-400/20',
    gray:   'bg-gray-400/20',
    brand:  'bg-brand-400/20',
  };
  const tierBarMap: Record<TierColor, string> = {
    amber:  'bg-accent-amber',
    slate:  'bg-slate-400',
    yellow: 'bg-yellow-400',
    cyan:   'bg-accent-cyan',
    purple: 'bg-accent-purple',
    rose:   'bg-accent-rose',
    green:  'bg-emerald-400',
    blue:   'bg-blue-400',
    gray:   'bg-gray-400',
    brand:  'bg-brand-400',
  };

  const barColor: string = nextTier ? tierBarMap[nextTier.color] : 'bg-brand-400';
  const progressStyle: React.CSSProperties = { width: `${progress}%` };

  return (
    <div className="glass-card bg-linear-to-br from-brand-500/5 to-accent-purple/5 border border-brand-500/10">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="font-display font-semibold text-lg">Team Target Bonus</h3>
          <p className="text-text-muted text-xs mt-0.5">
            Extra rewards based on your total team's staked FBiT
          </p>
        </div>
        {activeTier ? (
          <div className={`px-3 py-1.5 rounded-xl text-xs font-display font-bold border ${tierBgMap[activeTier.color]} ${tierColorMap[activeTier.color]} border-current/20`}>
            {activeTier.label} · +{onChainBonusBps !== undefined ? (onChainBonusBps / 100).toFixed(1) : activeTier.bonusPercentage}%
          </div>
        ) : (
          <div className="px-3 py-1.5 rounded-xl text-xs font-display font-medium bg-surface-800/60 text-text-muted border border-white/5">
            No Tier Yet
          </div>
        )}
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-2 gap-3 mb-4">
        <div className="rounded-xl bg-surface-800/40 border border-white/5 p-3">
          <p className="text-text-muted text-xs font-display uppercase tracking-wider mb-1">Team Staked</p>
          <p className="font-display font-bold text-lg">{formatNumber(teamTotalStaked)}</p>
          <p className="text-text-secondary text-xs mt-0.5">
            FBiT total <UsdValue amount={teamTotalStaked} priceUsd={priceUsd} />
          </p>
        </div>
        <div className="rounded-xl bg-surface-800/40 border border-white/5 p-3">
          <p className="text-text-muted text-xs font-display uppercase tracking-wider mb-1">Team Size</p>
          <p className="font-display font-bold text-lg">{formatNumber(teamSize, 0)}</p>
          <p className="text-text-secondary text-xs mt-0.5">Members</p>
        </div>
      </div>

      {/* Progress to next tier */}
      {nextTier && (
        <div className="mb-4">
          <div className="flex items-center justify-between text-xs font-display mb-1.5">
            <span className="text-text-muted">Progress to {nextTier.label}</span>
            <span className={`font-mono ${tierColorMap[nextTier.color]}`}>
              {formatNumber(teamTotalStaked)} / {formatNumber(nextTier.minTeamStaked)} FBiT
            </span>
          </div>
          <div className="flex justify-end">
            <UsdValue amount={teamTotalStaked} priceUsd={priceUsd} className="text-[10px]" />
          </div>
          <div className="h-2 rounded-full bg-surface-800 overflow-hidden">
            <div
              className={`h-full rounded-full transition-all duration-500 ${barColor}`}
              style={progressStyle}
            />
          </div>
          <p className="text-text-muted text-xs mt-1">
            Reach {nextTier.label} for <span className={`font-semibold ${tierColorMap[nextTier.color]}`}>+{nextTier.bonusPercentage}%</span> bonus on every reward
          </p>
        </div>
      )}

      {/* Auto-apply note */}
      {activeTier && (
        <div className="mb-4 px-3 py-2 rounded-xl bg-brand-500/5 border border-brand-500/10 flex items-center gap-2 text-xs text-text-muted">
          <span className="text-brand-400">✓</span>
          <span>
            Your <span className="text-brand-400 font-medium">
              {activeTier.label} +{onChainBonusBps !== undefined ? (onChainBonusBps / 100).toFixed(1) : activeTier.bonusPercentage}%
            </span> team bonus is applied automatically on every reward claim — no extra step needed.
            {onChainBonusBps !== undefined && (
              <span className="text-text-muted"> (verified on-chain)</span>
            )}
          </span>
        </div>
      )}

      {/* All 10 tiers grid */}
      <div className="grid grid-cols-5 sm:grid-cols-10 gap-1.5">
        {tiers.map((tier) => {
          const isActive  = activeTierIndex >= tier.tier - 1;
          const isCurrent = activeTierIndex === tier.tier - 1;
          return (
            <div
              key={tier.tier}
              title={`${tier.label}: ${formatNumber(tier.minTeamStaked)} FBiT → +${tier.bonusPercentage}%`}
              className={`rounded-lg p-1.5 text-center border transition-all ${
                isCurrent
                  ? `${tierBgMap[tier.color]} ${tierColorMap[tier.color]} border-current/30`
                  : isActive
                  ? 'bg-surface-800/60 border-white/10 text-text-secondary'
                  : 'bg-surface-800/30 border-white/5 text-text-muted opacity-50'
              }`}
            >
              <p className="text-[9px] font-display font-bold leading-tight">{tier.label}</p>
              <p className="text-[10px] font-mono font-semibold mt-0.5">+{tier.bonusPercentage}%</p>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function BurnEmissionPanel({ stats, network, priceUsd }: { stats: PlatformStats; network: string; priceUsd: number | null }) {
  const posApy = Math.round((stats.effectiveAPY || 1000) / 100);
  const feeRate = (stats.burnBps ?? 0) / 100;
  const colClass = 'md:grid-cols-5';

  return (
    <div className="glass-card bg-linear-to-r from-accent-rose/5 to-accent-amber/5 border border-accent-rose/10">
      <div className="flex items-center gap-2 mb-3">
        <span className="text-accent-rose text-lg">🔥</span>
        <h3 className="font-display font-semibold text-sm uppercase tracking-wider text-text-secondary">
          {stats.isRenounced ? 'Admin Fee & PoS Emission' : 'Burn & PoS Emission'}
        </h3>
      </div>
      <div className={`grid grid-cols-2 gap-4 ${colClass}`}>
        <div>
          <p className="text-text-muted text-xs font-display uppercase tracking-wider mb-1">Total Burned</p>
          <p className="font-display font-bold text-accent-rose text-lg sm:text-xl">{formatNumber(stats.totalBurned, 8)}</p>
          <p className="text-text-secondary text-xs mt-0.5">
            FBiT permanently destroyed <UsdValue amount={stats.totalBurned} priceUsd={priceUsd} />
          </p>
        </div>
        <div>
          <p className="text-text-muted text-xs font-display uppercase tracking-wider mb-1">Burn Rate</p>
          <p className="font-display font-bold text-accent-amber text-lg sm:text-xl">{feeRate}%</p>
          <p className="text-text-secondary text-xs mt-0.5">Burned from user reward on claim / compound</p>
        </div>
        <div>
          <p className="text-text-muted text-xs font-display uppercase tracking-wider mb-1">Annual Emission</p>
          <p className="font-display font-bold text-brand-400 text-lg sm:text-xl">{formatNumber(stats.annualEmission)}</p>
          <p className="text-text-secondary text-xs mt-0.5">
            FBiT / year <UsdValue amount={stats.annualEmission} priceUsd={priceUsd} />
          </p>
        </div>
        <div>
          <p className="text-text-muted text-xs font-display uppercase tracking-wider mb-1">Current APY</p>
          <p className="font-display font-bold text-lg sm:text-xl text-accent-cyan">
            {posApy}%
          </p>
          <p className="text-text-secondary text-xs mt-0.5">PoS · 10%–300% range</p>
        </div>
      </div>
    </div>
  );
}

function StatCard({ label, value, icon, accent, usdSub }: { label: string; value: string; icon: string; accent: string; usdSub?: React.ReactNode }) {
  const colors: Record<string, string> = {
    brand:  'from-brand-500/20 to-brand-500/5 text-brand-400 border-brand-500/10',
    purple: 'from-accent-purple/20 to-accent-purple/5 text-accent-purple border-accent-purple/10',
    cyan:   'from-accent-cyan/20 to-accent-cyan/5 text-accent-cyan border-accent-cyan/10',
    amber:  'from-accent-amber/20 to-accent-amber/5 text-accent-amber border-accent-amber/10',
  };
  return (
    <div className={`glass-card bg-linear-to-br ${colors[accent]} border`}>
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs text-text-muted font-display uppercase tracking-wider">{label}</span>
        <span className="text-lg opacity-50">{icon}</span>
      </div>
      <p className="font-display font-bold text-base sm:text-xl md:text-2xl truncate">{value}</p>
      {usdSub && <p className="text-[11px] mt-0.5">{usdSub}</p>}
    </div>
  );
}
