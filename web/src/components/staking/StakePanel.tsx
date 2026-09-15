'use client';

import React, { useState, useMemo, useEffect, useCallback } from 'react';
import toast from 'react-hot-toast';
import { useWallet } from '@/context/WalletContext';
import { useAppStore } from '@/lib/store';
import { formatNumber } from '@/lib/utils';
import { LOCK_PERIOD, StakeEntry } from '@/types';
import { useContract } from '@/hooks/useContract';
import { checkRateLimit, sanitizeErrorMessage, MAX_STAKE_AMOUNT, MIN_STAKE_AMOUNT } from '@/lib/security';
import ContractSetupNotice from '@/components/ui/ContractSetupNotice';
import UsdValue from '@/components/ui/UsdValue';
import { useTokenPrice } from '@/hooks/useTokenPrice';
import { solanaGetTokenBalance } from '@/lib/contracts/solana';

export default function StakePanel() {
  const { address, solanaAddress, solanaReferrer } = useWallet();
  const { selectedNetwork, getWalletData, addStake, addTransaction, loadOnChainData } = useAppStore();
  const contract = useContract();
  const { pairs: pricePairs } = useTokenPrice();
  const fbitPriceUsd = pricePairs[0]?.priceUsd ? Number(pricePairs[0].priceUsd) : null;

  const [amount, setAmount] = useState('');
  const [isStaking, setIsStaking] = useState(false);
  const [tokenBalance, setTokenBalance] = useState(0);
  const [effectiveAPYBps, setEffectiveAPYBps] = useState(1000); // basis points, fetched live from chain (1000–30000 = 10%–300%)

  // Direct balance fetch — uses chain-specific address so balance always shows correctly
  const fetchTokenBalance = useCallback(async () => {
    if (!address) return;
    try {
      const addr = solanaAddress ?? address;
      const bal  = addr ? await solanaGetTokenBalance(addr) : 0;
      setTokenBalance(bal);
      loadOnChainData(address, { tokenBalance: bal });
    } catch {}
  }, [address, solanaAddress, loadOnChainData]);

  useEffect(() => {
    if (!address) { setTokenBalance(0); return; }
    fetchTokenBalance();
    const id = setInterval(fetchTokenBalance, 30_000);
    return () => clearInterval(id);
  }, [address, fetchTokenBalance]);

  // Sync effectiveAPY from store (populated by syncPlatformStats on mount/network-switch)
  const storeAPY = useAppStore(s => s.platformStats.effectiveAPY);
  useEffect(() => {
    if (storeAPY && storeAPY > 0) setEffectiveAPYBps(storeAPY);
  }, [storeAPY]);

  // Whole-percent value for display only — calculations below use the raw bps
  // value so the reward estimate matches the Dashboard's live accrual exactly.
  const effectiveAPY = Math.round(effectiveAPYBps / 100);

  // Keep platform stats fresh
  useEffect(() => {
    if (!address) return;
    void contract.syncPlatformStats().catch(() => {});
    const id = setInterval(() => void contract.syncPlatformStats().catch(() => {}), 60_000);
    return () => clearInterval(id);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address, selectedNetwork]);

  const walletData = getWalletData();
  const existingStakes = walletData?.stakes ?? [];
  const stakeAmount = parseFloat(amount) || 0;

  // Use contract-fetched limits when available, fall back to security.ts constants
  const platformStats = useAppStore(s => s.platformStats);
  const effectiveMin  = platformStats.minStakeAmount  ?? MIN_STAKE_AMOUNT;
  const effectiveMax  = platformStats.maxStakePerUser ?? MAX_STAKE_AMOUNT;
  const lockDays      = platformStats.lockPeriodDays  ?? LOCK_PERIOD.days;

  const estimatedRewards = useMemo(() => {
    const apy = effectiveAPYBps / 10000;
    const perInterval = (stakeAmount * apy) / 1460;
    return {
      perInterval,
      daily: perInterval * 4,
      total: perInterval * 4 * lockDays,
    };
  }, [stakeAmount, effectiveAPYBps, lockDays]);

  const handleStake = async () => {
    if (!stakeAmount || stakeAmount <= 0 || stakeAmount > tokenBalance) return;
    if (stakeAmount < effectiveMin) {
      toast.error(`Minimum stake is ${effectiveMin.toLocaleString()} FBiT.`);
      return;
    }
    if (stakeAmount > effectiveMax) {
      toast.error(`Maximum stake is ${effectiveMax.toLocaleString()} FBiT.`);
      return;
    }
    if (!checkRateLimit('stake', { maxCalls: 3, windowMs: 120_000 })) {
      toast.error('Too many stake attempts. Please wait 2 minutes.');
      return;
    }
    setIsStaking(true);

    const toastId = toast.loading(`Staking ${formatNumber(stakeAmount)} FBiT…`);
    try {
      let txHash: string;
      let stakedAt = Math.floor(Date.now() / 1000);

      if (!contract.isLive) throw new Error('Contract not configured. Set up your deployment addresses to execute on-chain transactions.');
      const rawReferrer = solanaReferrer;
      // Validate referrer matches the base58 Solana format before sending
      const isSolRef = rawReferrer && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(rawReferrer);
      const referrer = isSolRef ? rawReferrer : undefined;
      const result = await contract.stake(stakeAmount, referrer ?? undefined);
      txHash = result.txHash;
      // stakeIndex is the monotonic on-chain stakeId (0, 1, 2…).
      // stakedAt is kept as local Unix timestamp for display only.
      const stakeEntryId = result.stakeIndex ?? existingStakes.length;
      contract.syncPlatformStats().catch(() => {});

      const newStake: StakeEntry = {
        id: stakeEntryId,
        amount: stakeAmount,
        lockPeriodIndex: 0,
        stakedAt,
        unlockAt: stakedAt + lockDays * 86400,
        lastClaimAt: stakedAt,
        totalClaimed: 0,
        isActive: true,
        apy: effectiveAPYBps,
      };

      addStake(newStake);
      addTransaction({
        id: Date.now().toString(),
        type: 'stake',
        label: `Staked ${formatNumber(stakeAmount)} FBiT · 30 Days`,
        amount: stakeAmount,
        txHash,
        timestamp: Date.now(),
        status: 'success',
        network: selectedNetwork,
      });

      // Immediately update referrer's local count (same-browser testing + instant feedback)
      if (referrer) {
        const { walletStates } = useAppStore.getState();
        const refData = walletStates[`${selectedNetwork}:${referrer}`];
        if (refData) {
          const prevCount = refData.referralInfo?.totalReferrals ?? refData.userAccount?.referralCount ?? 0;
          loadOnChainData(referrer, {
            referralInfo: {
              totalReferrals:       prevCount + 1,
              totalReferralRewards: refData.referralInfo?.totalReferralRewards ?? 0,
              referralLink:         refData.referralInfo?.referralLink ?? '',
              referrals: [
                ...(refData.referralInfo?.referrals ?? []),
                { address: address!, level: 1, stakedAmount: stakeAmount, rewardEarned: 0, registeredAt: Math.floor(Date.now() / 1000), directReferrals: 0 },
              ],
              chain: refData.referralInfo?.chain ?? [],
              fullNetworkSize: (refData.referralInfo?.fullNetworkSize ?? 0) + 1,
            },
            userAccount: refData.userAccount
              ? { ...refData.userAccount, referralCount: (refData.userAccount.referralCount ?? 0) + 1 }
              : undefined,
          });
        }
      }

      // Refresh on-chain balance and confirmed stake list after TX lands
      void contract.syncUserData().catch(() => {});
      void fetchTokenBalance();

      toast.success(`✓ Successfully staked ${formatNumber(stakeAmount)} FBiT!`, { id: toastId });
      const activeReferrer = solanaReferrer;
      if (activeReferrer) {
        setTimeout(() => {
          toast(`Referral credited to ${activeReferrer.slice(0, 6)}…${activeReferrer.slice(-4)}`, {
            icon: '◎',
            duration: 4000,
          });
        }, 800);
      }
      setAmount('');
    } catch (err: any) {
      toast.error(sanitizeErrorMessage(err), { id: toastId });
    } finally {
      setIsStaking(false);
    }
  };

  if (!address) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[50vh] text-center px-4">
        <div className="w-16 h-16 rounded-2xl bg-linear-to-br from-brand-500/20 to-accent-cyan/20 flex items-center justify-center mb-4 animate-float">
          <span className="text-3xl">⬡</span>
        </div>
        <h2 className="font-display text-2xl font-bold mb-2">Connect to Stake</h2>
        <p className="text-text-secondary max-w-sm">Connect your wallet to start staking FBiT tokens and earning rewards.</p>
      </div>
    );
  }

  const isBlocked = walletData?.userAccount?.isBlocked ?? false;

  return (
    <div className="max-w-2xl mx-auto space-y-6 animate-fade-in">
      {/* Blocked account banner */}
      {isBlocked && (
        <div className="glass-card border border-accent-rose/40 bg-accent-rose/5 flex items-center gap-3 p-4">
          <span className="text-accent-rose text-xl shrink-0">🚫</span>
          <div>
            <p className="font-display font-semibold text-accent-rose text-sm">Account Blocked</p>
            <p className="text-text-muted text-xs mt-0.5">Your wallet has been blocked. Staking is disabled. Contact support if you believe this is an error.</p>
          </div>
        </div>
      )}

      {/* Contract setup notice — hidden when contract is live */}
      <ContractSetupNotice />

      {/* Referral Banner */}
      {solanaReferrer && (() => {
        const ref = solanaReferrer;
        return (
          <div className="glass-card bg-linear-to-r from-accent-purple/10 to-brand-500/10 border border-accent-purple/20">
            <div className="flex items-center gap-3">
              <span className="text-xl">🎉</span>
              <div>
                <p className="font-display font-semibold text-sm">
                  Referred by {ref.slice(0, 8)}…{ref.slice(-4)}
                </p>
                <p className="text-text-muted text-xs">Your referrer will earn commissions on your stakes!</p>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Amount + Lock Period */}
      <div className="glass-card">
        <h3 className="font-display font-semibold text-lg mb-4">Stake FBiT Tokens</h3>

        <div className="space-y-5">
          {/* Amount Input */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-sm text-text-secondary font-display">Amount</label>
              <span className="text-xs text-text-muted">
                Balance: <span className="text-brand-400 font-mono">{formatNumber(tokenBalance)}</span> FBiT{' '}
                <UsdValue amount={tokenBalance} priceUsd={fbitPriceUsd} />
              </span>
            </div>
            <div className="relative">
              <input
                type="number"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="0.00"
                min="0"
                className="input-field pr-28 text-lg font-mono"
              />
              <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => setAmount(Math.floor(tokenBalance * 0.25).toString())}
                  className="px-2 py-1 rounded-md text-xs font-display bg-white/5 hover:bg-white/10 text-text-secondary transition-colors"
                >
                  25%
                </button>
                <button
                  type="button"
                  onClick={() => setAmount(Math.floor(tokenBalance * 0.5).toString())}
                  className="px-2 py-1 rounded-md text-xs font-display bg-white/5 hover:bg-white/10 text-text-secondary transition-colors"
                >
                  50%
                </button>
                <button
                  type="button"
                  onClick={() => setAmount(Math.floor(tokenBalance).toString())}
                  className="px-2 py-1 rounded-md text-xs font-display bg-brand-500/10 hover:bg-brand-500/20 text-brand-400 transition-colors"
                >
                  MAX
                </button>
              </div>
            </div>
            <p className="text-text-muted text-[11px] mt-1">
              Min: <span className="text-text-secondary">{effectiveMin.toLocaleString()} FBiT</span>
              {' · '}Max: <span className="text-text-secondary">{effectiveMax.toLocaleString()} FBiT</span>
            </p>
            {stakeAmount > 0 && stakeAmount < effectiveMin && (
              <p className="text-accent-rose text-xs mt-1">Minimum stake is {effectiveMin.toLocaleString()} FBiT</p>
            )}
            {stakeAmount > effectiveMax && (
              <p className="text-accent-rose text-xs mt-1">Maximum stake is {effectiveMax.toLocaleString()} FBiT</p>
            )}
            {stakeAmount > tokenBalance && stakeAmount > 0 && stakeAmount <= effectiveMax && (
              <p className="text-accent-rose text-xs mt-1">Insufficient balance</p>
            )}
          </div>

          {/* Lock Period — fixed 30 days, live supply-based APY */}
          <div className="flex items-center justify-between p-4 rounded-xl bg-brand-500/5 border border-brand-500/20">
            <div>
              <p className="text-xs text-text-muted font-display uppercase tracking-wider mb-0.5">Lock Period</p>
              <p className="font-display font-bold text-text-primary">{lockDays} Days</p>
            </div>
            <div className="text-right">
              <p className="text-xs text-text-muted font-display uppercase tracking-wider mb-0.5">Current APY</p>
              <p className="font-display font-bold text-brand-400 text-lg">{effectiveAPY}%</p>
              <p className="text-[10px] text-text-muted">PoS · 10%–300%</p>
              <p className="text-[10px] text-accent-amber">Dynamic PoS · updates live</p>
            </div>
          </div>
        </div>
      </div>

      {/* Reward Estimation */}
      {stakeAmount >= effectiveMin && stakeAmount <= tokenBalance && stakeAmount <= effectiveMax && (
        <div className="glass-card animate-slide-up">
          <h4 className="font-display font-semibold text-sm text-text-secondary uppercase tracking-wider mb-3">
            Estimated Rewards
          </h4>
          <div className="grid grid-cols-3 gap-4 mb-4">
            <div>
              <p className="text-text-muted text-xs mb-1">Per 6h</p>
              <p className="font-mono text-brand-400 font-semibold">{formatNumber(estimatedRewards.perInterval)}</p>
              <p className="text-text-muted text-[10px]">
                FBiT / interval <UsdValue amount={estimatedRewards.perInterval} priceUsd={fbitPriceUsd} />
              </p>
            </div>
            <div>
              <p className="text-text-muted text-xs mb-1">Daily</p>
              <p className="font-mono text-brand-400 font-semibold">{formatNumber(estimatedRewards.daily)}</p>
              <p className="text-text-muted text-[10px]">
                FBiT / day <UsdValue amount={estimatedRewards.daily} priceUsd={fbitPriceUsd} />
              </p>
            </div>
            <div>
              <p className="text-text-muted text-xs mb-1">Total ({lockDays} Days)</p>
              <p className="font-mono text-brand-400 font-semibold">{formatNumber(estimatedRewards.total)}</p>
              <p className="text-text-muted text-[10px]">
                FBiT total <UsdValue amount={estimatedRewards.total} priceUsd={fbitPriceUsd} />
              </p>
            </div>
          </div>
          <div className="pt-3 border-t border-white/5 space-y-1.5">
            {[
              ['Lock Period', `${lockDays} Days`],
              ['APY', `${effectiveAPY}% (PoS, 10%–300%)`],
              ['Network', 'Solana'],
              ['Unlock Date', new Date(Date.now() + lockDays * 86400000).toLocaleDateString()],
            ].map(([k, v]) => (
              <div key={k} className="flex items-center justify-between text-xs">
                <span className="text-text-muted">{k}</span>
                <span className="font-mono text-text-secondary">{v}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Stake Button */}
      <button
        type="button"
        onClick={handleStake}
        disabled={isBlocked || isStaking || stakeAmount <= 0 || stakeAmount < effectiveMin || stakeAmount > effectiveMax || stakeAmount > tokenBalance}
        className={`w-full py-4 rounded-xl font-display font-bold text-lg transition-all duration-300 ${
          isBlocked || isStaking || stakeAmount <= 0 || stakeAmount < effectiveMin || stakeAmount > effectiveMax || stakeAmount > tokenBalance
            ? 'bg-surface-700 text-text-muted cursor-not-allowed'
            : 'btn-primary'
        }`}
      >
        {isStaking ? (
          <span className="flex items-center justify-center gap-2">
            <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
            Staking…
          </span>
        ) : stakeAmount > tokenBalance ? (
          'Insufficient Balance'
        ) : stakeAmount > effectiveMax ? (
          `Exceeds Maximum (${formatNumber(effectiveMax)} FBiT)`
        ) : stakeAmount > 0 && stakeAmount < effectiveMin ? (
          `Minimum Stake is ${effectiveMin.toLocaleString()} FBiT`
        ) : stakeAmount <= 0 ? (
          'Enter an Amount'
        ) : (
          `Stake ${formatNumber(stakeAmount)} FBiT · ${lockDays} Days`
        )}
      </button>

      {/* Info note */}
      <p className="text-center text-xs text-text-muted">
        Tokens will be locked for <span className="text-text-secondary">{lockDays} days</span> until{' '}
        <span className="text-text-secondary font-mono">
          {new Date(Date.now() + lockDays * 86400000).toLocaleDateString()}
        </span>. Early withdrawal is not possible.
      </p>
    </div>
  );
}
