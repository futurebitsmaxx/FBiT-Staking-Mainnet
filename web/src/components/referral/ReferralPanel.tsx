'use client';

import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import toast from 'react-hot-toast';
import { useWallet } from '@/context/WalletContext';
import { useAppStore } from '@/lib/store';
import { useContract } from '@/hooks/useContract';
import {
  formatNumber,
  copyToClipboard,
  generateReferralLink,
  getTeamTargetTier,
  getNextTeamTargetTier,
} from '@/lib/utils';
import { REFERRAL_LEVELS, CLAIM_REFERRAL_LEVELS, TEAM_TARGET_TIERS } from '@/types';
import { getExplorerTxUrl } from '@/lib/config';
import UsdValue from '@/components/ui/UsdValue';
import { useTokenPrice } from '@/hooks/useTokenPrice';
import type { ReferralEntry, TxRecord } from '@/types';

const SHARE_TEXT = 'Join FutureBit Staking and earn dynamic Solana staking rewards with me — use my referral link:';

// Web share-intent URLs — no SDK needed, just plain links each platform exposes.
// Instagram has no equivalent web intent (it's a closed, app-only share surface),
// so it's handled separately via the OS-level Web Share API where available.
function buildShareUrls(link: string) {
  const encodedLink = encodeURIComponent(link);
  const encodedText = encodeURIComponent(SHARE_TEXT);
  return {
    x:        `https://twitter.com/intent/tweet?url=${encodedLink}&text=${encodedText}`,
    telegram: `https://t.me/share/url?url=${encodedLink}&text=${encodedText}`,
    whatsapp: `https://wa.me/?text=${encodeURIComponent(`${SHARE_TEXT} ${link}`)}`,
    facebook: `https://www.facebook.com/sharer/sharer.php?u=${encodedLink}`,
  };
}

function ShareButton({ href, label, title, children }: { href: string; label: string; title: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      title={title}
      aria-label={title}
      className="w-9 h-9 rounded-lg flex items-center justify-center bg-surface-900/60 border border-white/10 text-text-secondary hover:text-text-primary hover:border-white/20 hover:bg-surface-900 transition-all shrink-0"
    >
      {children}
      <span className="sr-only">{label}</span>
    </a>
  );
}

// ProgressBar sets width imperatively to avoid JSX inline-style linter warnings
function ProgressBar({ pct, className }: { pct: number; className: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.style.width = `${Math.min(100, Math.max(0, pct))}%`;
  }, [pct]);
  return <div ref={ref} className={`h-full rounded-full transition-all duration-500 ${className}`} />;
}

const POLL_INTERVAL_MS = 60_000;

const LEVEL_COLORS: Record<number, string> = {
  1:  'bg-brand-500/10 text-brand-400 border-brand-500/20',
  2:  'bg-accent-purple/10 text-accent-purple border-accent-purple/20',
  3:  'bg-accent-cyan/10 text-accent-cyan border-accent-cyan/20',
  4:  'bg-accent-cyan/10 text-accent-cyan border-accent-cyan/20',
  5:  'bg-accent-amber/10 text-accent-amber border-accent-amber/20',
  6:  'bg-accent-amber/10 text-accent-amber border-accent-amber/20',
  7:  'bg-accent-rose/10 text-accent-rose border-accent-rose/20',
  8:  'bg-accent-rose/10 text-accent-rose border-accent-rose/20',
  9:  'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
  10: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
};

export default function ReferralPanel() {
  const { address, solanaAddress } = useWallet();
  const { getWalletData, selectedNetwork } = useAppStore();
  const contract = useContract();
  const { pairs: pricePairs } = useTokenPrice();
  const fbitPriceUsd = pricePairs[0]?.priceUsd ? Number(pricePairs[0].priceUsd) : null;

  const [copied, setCopied]           = useState(false);
  const [activeView, setActiveView]   = useState<'overview' | 'levels' | 'team' | 'history'>('overview');
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [lastSyncAt, setLastSyncAt]   = useState<Date | null>(null);
  const prevReferralCount             = useRef<number>(0);

  // On-chain history state
  const [onChainRefHistory, setOnChainRefHistory] = useState<TxRecord[]>([]);
  const [fullReferralTree, setFullReferralTree]   = useState<ReferralEntry[]>([]);
  const [isFetchingChain, setIsFetchingChain]     = useState(false);
  const [hasFetchedChain, setHasFetchedChain]     = useState(false);

  // ── Look up any wallet's public staking/team stats (all on-chain data — a
  // wallet's UserAccount is publicly readable by anyone via Solscan or direct
  // RPC anyway, so this exposes nothing that isn't already public) ────────────
  const [lookupInput, setLookupInput]     = useState('');
  const [lookupLoading, setLookupLoading] = useState(false);
  const [lookupError, setLookupError]     = useState<string | null>(null);
  const [lookupResult, setLookupResult]   = useState<{
    address: string; totalStaked: number; teamSize: number;
    directReferrals: number; referrer: string | null; registeredAt: number;
  } | null>(null);

  const handleLookup = useCallback(async () => {
    const addr = lookupInput.trim();
    setLookupError(null);
    setLookupResult(null);
    const { isValidSolanaAddress } = await import('@/lib/security');
    if (!isValidSolanaAddress(addr)) {
      setLookupError('Enter a valid Solana wallet address');
      return;
    }
    setLookupLoading(true);
    try {
      const solana = await import('@/lib/contracts/solana');
      const [account, refInfo] = await Promise.all([
        solana.solanaGetUserAccount(addr),
        solana.solanaGetReferralInfo(addr),
      ]);
      if (!account) {
        setLookupError('This wallet has not registered on FBiT Staking yet');
        return;
      }
      setLookupResult({
        address:         addr,
        totalStaked:     account.totalStaked,
        teamSize:        Math.max(account.teamSize, refInfo?.fullNetworkSize ?? 0),
        directReferrals: Math.max(account.referralCount, refInfo?.totalReferrals ?? 0),
        referrer:        account.referrer,
        registeredAt:    account.registeredAt,
      });
    } catch {
      setLookupError('Failed to fetch on-chain data — please try again');
    } finally {
      setLookupLoading(false);
    }
  }, [lookupInput]);

  const syncReferralData = useCallback(async (): Promise<boolean> => {
    if (!address) return false;
    setIsRefreshing(true);
    try {
      // referralPercentages/teamTiers (live on-chain config, used below) live on
      // platformStats — this panel never fetched it itself, relying on some other
      // component (e.g. Dashboard) having already synced it in the same session.
      // Opened directly, it silently fell back to the static REFERRAL_LEVELS /
      // TEAM_TARGET_TIERS constants instead of the real current on-chain values.
      await Promise.allSettled([contract.syncUserData(), contract.syncPlatformStats()]);
      setLastSyncAt(new Date());
      setIsRefreshing(false);
      return true;
    } catch {
      setIsRefreshing(false);
      return false;
    }
  }, [address, contract]);

  // Initial sync + auto-poll every 30s (lightweight — L1 only)
  useEffect(() => {
    if (!address) return;
    void syncReferralData();
    const id = setInterval(() => syncReferralData(), POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [address, selectedNetwork, syncReferralData]);

  const walletData      = getWalletData();
  const referralInfo    = walletData?.referralInfo;
  const userAccount     = walletData?.userAccount;
  const teamTotalStaked = userAccount?.teamTotalStaked ?? 0;
  const teamSizeVal     = userAccount?.teamSize ?? 0;

  // Detect new referrals
  useEffect(() => {
    const count = referralInfo?.totalReferrals ?? 0;
    if (prevReferralCount.current > 0 && count > prevReferralCount.current) {
      const diff = count - prevReferralCount.current;
      toast.success(`+${diff} new referral${diff > 1 ? 's' : ''}! Your network is growing.`);
    }
    prevReferralCount.current = count;
  }, [referralInfo?.totalReferrals]);

  // ── On-chain full refresh ────────────────────────────────────────────────────
  const handleRefreshFromChain = useCallback(async () => {
    if (!address) return;
    const solAddr = solanaAddress ?? address;

    setIsFetchingChain(true);
    try {
      let anySucceeded = false;
      if (solAddr) {
        const [histRes, treeRes] = await Promise.allSettled([
          import('@/lib/contracts/solana').then(m => m.solanaGetReferralOnChainHistory(solAddr)),
          import('@/lib/contracts/solana').then(m => m.solanaGetFullReferralTree(solAddr)),
        ]);
        if (histRes.status === 'fulfilled') { setOnChainRefHistory(histRes.value); anySucceeded = true; }
        if (treeRes.status === 'fulfilled') { setFullReferralTree(treeRes.value);  anySucceeded = true; }
      }
      if (anySucceeded) {
        setHasFetchedChain(true);
        toast.success('On-chain referral data loaded');
      } else {
        toast.error('Failed to load on-chain referral data — please try again');
      }
    } catch {
      toast.error('Unexpected error loading referral data');
    } finally {
      setIsFetchingChain(false);
    }
  }, [address, solanaAddress]);

  // Referral tree: auto-poll now returns all L1–L10 levels via BFS.
  // fullReferralTree (manual "Refresh from Chain") overrides only when fetched and non-empty.
  const displayedTree: ReferralEntry[] = useMemo(() => {
    if (hasFetchedChain && fullReferralTree.length > 0) return fullReferralTree;
    return (referralInfo?.referrals ?? []).map(r => ({ ...r, level: r.level || 1 }));
  }, [hasFetchedChain, fullReferralTree, referralInfo?.referrals]);

  // Local referral txns from Zustand store
  const localRefTxs = useMemo(
    () => (walletData?.transactions ?? []).filter(t => t.type === 'referral'),
    [walletData?.transactions]
  );

  // Merged: on-chain + local, deduped by txHash
  const allRefTxs = useMemo(() => {
    const seen = new Set<string>();
    const merged: TxRecord[] = [];
    for (const tx of [...onChainRefHistory, ...localRefTxs]) {
      const key = tx.txHash && tx.txHash !== 'local' ? tx.txHash : tx.id;
      if (!seen.has(String(key))) {
        seen.add(String(key));
        merged.push(tx);
      }
    }
    return merged.sort((a, b) => b.timestamp - a.timestamp);
  }, [onChainRefHistory, localRefTxs]);

  const chainAddress = solanaAddress ?? address;
  const referralLink    = chainAddress ? generateReferralLink(chainAddress) : '';
  const myReferrer      = userAccount?.referrer ?? null;
  // Must be fullNetworkSize (unbounded depth), not referrals.length (capped at the
  // 10 reward-eligible levels) — a downline chain can run deeper than that.
  const networkTotal    = referralInfo?.fullNetworkSize ?? 0;
  // On-chain UserAccount.referral_count only increments inside stake()'s referral
  // loop, and only on a referral's very first stake — if that particular stake's
  // remaining_accounts was ever built incorrectly (client bug, RPC hiccup walking
  // the chain), this field silently undercounts forever after, with no way to
  // self-correct. The BFS-computed Level 1 count (every account whose `referrer`
  // field points at this wallet, scanned directly) doesn't depend on that at all —
  // it's ground truth. Same bug class already fixed for teamSize below; take the
  // higher of the two so a stale/undercounted on-chain field can never show a
  // smaller number than what's independently provable on-chain.
  const bfsDirectCount  = referralInfo?.referrals.filter(r => r.level === 1).length ?? 0;
  const totalReferrals  = Math.max(referralInfo?.totalReferrals ?? 0, bfsDirectCount); // L1 direct count
  // The authoritative figure is the on-chain total_referral_rewards — it reflects
  // what was actually paid out at the BPS rates in effect at each stake. The
  // per-row "estimate" (stakedAmount × current level%) is only a projection —
  // it drifts from reality whenever a downline's stake changed since being paid,
  // or admin has since adjusted the referral percentages — so it must never be
  // preferred over real on-chain data, only stand in when none is available yet.
  const calculatedCommission = displayedTree.reduce((s, r) => s + r.rewardEarned, 0);
  const authoritativeRewards = userAccount?.totalReferralRewards ?? referralInfo?.totalReferralRewards;
  const totalRewards    = authoritativeRewards !== undefined ? authoritativeRewards : calculatedCommission;
  // Must be fullNetworkActiveCount (unbounded depth), not a filter over
  // `referrals` (capped at the 10 reward-eligible levels) — same depth-cap bug
  // as Team Size/networkTotal above.
  const activeReferrals = referralInfo?.fullNetworkActiveCount ?? 0;
  // Use BFS network count as fallback when on-chain team_size is 0.
  // team_size is only updated inside the referral loop (requires remaining_accounts at stake time);
  // if that was missed for early stakes, BFS gives the correct count.
  const teamSize        = Math.max(teamSizeVal, networkTotal);

  const liveReferralPct = useAppStore(s => s.platformStats.referralPercentages);
  // Build live referral levels: use on-chain values when available, fall back to REFERRAL_LEVELS constants.
  const activeLevels = liveReferralPct && liveReferralPct.length === 10
    ? liveReferralPct.map((bps, i) => ({ level: i + 1, percentage: bps / 100 }))
    : REFERRAL_LEVELS;

  const liveTiers = useAppStore(s => s.platformStats.teamTiers) as typeof TEAM_TARGET_TIERS[number][] | undefined;
  const activeTierList = liveTiers ?? TEAM_TARGET_TIERS;
  const currentTier = getTeamTargetTier(teamSize, teamTotalStaked, liveTiers);
  const nextTier    = getNextTeamTargetTier(teamSize, teamTotalStaked, liveTiers);

  const handleCopy = async () => {
    const ok = await copyToClipboard(referralLink);
    if (ok) {
      setCopied(true);
      toast.success('Referral link copied!');
      setTimeout(() => setCopied(false), 2000);
    }
  };

  // Instagram has no web share-intent URL (posting/DM is app-only) — use the OS
  // share sheet where available (mobile browsers list Instagram as a target
  // automatically when the app is installed), otherwise fall back to copying
  // the link with instructions, since that's the only thing that works everywhere.
  const handleInstagramShare = async () => {
    if (typeof navigator !== 'undefined' && navigator.share) {
      try {
        await navigator.share({ title: 'FutureBit Staking', text: SHARE_TEXT, url: referralLink });
        return;
      } catch {
        // user cancelled the share sheet — fall through to nothing further
        return;
      }
    }
    const ok = await copyToClipboard(referralLink);
    if (ok) toast.success('Link copied! Paste it into your Instagram bio or story.');
  };

  const handleRefresh = async () => {
    const ok = await syncReferralData();
    if (ok) toast.success('Referral data refreshed!');
    else toast.error('Failed to refresh — check your connection');
  };

  if (!address) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[50vh] text-center px-4">
        <div className="w-16 h-16 rounded-2xl bg-linear-to-br from-accent-purple/20 to-brand-500/20 flex items-center justify-center mb-4 animate-float">
          <span className="text-3xl">◎</span>
        </div>
        <h2 className="font-display text-2xl font-bold mb-2">Referral Network</h2>
        <p className="text-text-secondary max-w-sm">
          Connect your wallet to access your referral link and earn commissions across 10 levels.
        </p>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto space-y-6 animate-fade-in">
      {/* Referral Link */}
      <div className="glass-card bg-linear-to-br from-accent-purple/5 to-brand-500/5">
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-display font-semibold text-lg">Your Referral Link</h3>
          <div className="flex items-center gap-2">
            {lastSyncAt && (
              <span className="text-[10px] text-text-muted font-mono">
                Updated {lastSyncAt.toLocaleTimeString()}
              </span>
            )}
            <button
              type="button"
              onClick={handleRefresh}
              disabled={isRefreshing}
              title="Refresh referral data"
              className="w-7 h-7 rounded-lg flex items-center justify-center text-text-muted hover:text-text-primary hover:bg-white/5 transition-all disabled:opacity-40"
            >
              <span className={`text-sm ${isRefreshing ? 'animate-spin' : ''}`}>↻</span>
            </button>
          </div>
        </div>
        <div className="flex flex-col sm:flex-row gap-3">
          <div className="flex-1 px-4 py-3 rounded-xl bg-surface-900/80 border border-white/5 font-mono text-sm text-text-secondary truncate">
            {referralLink}
          </div>
          <button
            type="button"
            onClick={handleCopy}
            className={`px-6 py-3 rounded-xl font-display font-semibold text-sm transition-all duration-300 whitespace-nowrap ${
              copied
                ? 'bg-brand-500/20 text-brand-400 border border-brand-500/30'
                : 'btn-primary'
            }`}
          >
            {copied ? '✓ Copied!' : 'Copy Link'}
          </button>
        </div>
        <div className="flex items-center gap-2 mt-4">
          <span className="text-text-muted text-[11px] font-display uppercase tracking-wider mr-1">Share</span>
          {(() => {
            const shareUrls = buildShareUrls(referralLink);
            return (
              <>
                <ShareButton href={shareUrls.x} title="Share on X (Twitter)" label="Share on X">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                    <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
                  </svg>
                </ShareButton>
                <ShareButton href={shareUrls.telegram} title="Share on Telegram" label="Share on Telegram">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                    <path d="M22.05 3.42 2.9 10.83c-1.3.52-1.29 1.24-.24 1.56l4.9 1.53 1.9 5.83c.23.63.4.88.82.88.43 0 .62-.2.84-.42l2.02-1.94 4.2 3.1c.77.43 1.33.2 1.53-.72l2.77-13.05c.3-1.14-.42-1.65-1.6-1.18ZM8.6 14.4l9.1-5.74c.44-.27.85-.13.51.17l-7.6 6.86-.29 3.1z" />
                  </svg>
                </ShareButton>
                <ShareButton href={shareUrls.whatsapp} title="Share on WhatsApp" label="Share on WhatsApp">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                    <path d="M12.02 2C6.5 2 2 6.48 2 12c0 1.85.5 3.58 1.36 5.07L2 22l5.1-1.33A9.96 9.96 0 0 0 12.02 22C17.5 22 22 17.52 22 12S17.5 2 12.02 2Zm5.85 14.24c-.25.7-1.45 1.34-2 1.42-.53.08-1.19.11-1.92-.12-.44-.14-1.01-.32-1.74-.63-3.06-1.32-5.06-4.4-5.21-4.6-.15-.2-1.25-1.66-1.25-3.17 0-1.5.79-2.24 1.07-2.55.28-.3.6-.38.8-.38.2 0 .4 0 .58.01.19.01.44-.07.68.53.25.6.85 2.1.92 2.25.08.15.13.33.02.53-.1.2-.15.32-.3.5-.15.18-.31.4-.44.53-.15.15-.3.32-.13.62.17.3.75 1.25 1.62 2.02 1.12 1 2.06 1.32 2.36 1.47.3.15.48.13.65-.08.18-.2.75-.87.95-1.17.2-.3.4-.25.67-.15.28.1 1.77.83 2.07.99.3.15.5.22.57.35.08.13.08.75-.17 1.45Z" />
                  </svg>
                </ShareButton>
                <ShareButton href={shareUrls.facebook} title="Share on Facebook" label="Share on Facebook">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                    <path d="M22 12.06C22 6.5 17.52 2 12 2S2 6.5 2 12.06c0 5.02 3.66 9.18 8.44 9.94v-7.03H7.9v-2.91h2.54V9.85c0-2.51 1.49-3.9 3.77-3.9 1.09 0 2.24.2 2.24.2v2.46h-1.26c-1.24 0-1.63.77-1.63 1.56v1.87h2.77l-.44 2.91h-2.33V22c4.78-.76 8.44-4.92 8.44-9.94Z" />
                  </svg>
                </ShareButton>
                <button
                  type="button"
                  onClick={handleInstagramShare}
                  title="Share on Instagram"
                  aria-label="Share on Instagram"
                  className="w-9 h-9 rounded-lg flex items-center justify-center bg-surface-900/60 border border-white/10 text-text-secondary hover:text-text-primary hover:border-white/20 hover:bg-surface-900 transition-all shrink-0"
                >
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                    <path d="M12 2c-2.72 0-3.06.01-4.12.06-1.06.05-1.79.22-2.43.47a4.9 4.9 0 0 0-1.77 1.15A4.9 4.9 0 0 0 2.53 5.45c-.25.64-.42 1.37-.47 2.43C2 8.94 2 9.28 2 12s.01 3.06.06 4.12c.05 1.06.22 1.79.47 2.43a4.9 4.9 0 0 0 1.15 1.77c.5.51 1.1.9 1.77 1.15.64.25 1.37.42 2.43.47C8.94 22 9.28 22 12 22s3.06-.01 4.12-.06c1.06-.05 1.79-.22 2.43-.47a4.9 4.9 0 0 0 1.77-1.15 4.9 4.9 0 0 0 1.15-1.77c.25-.64.42-1.37.47-2.43.05-1.06.06-1.4.06-4.12s-.01-3.06-.06-4.12c-.05-1.06-.22-1.79-.47-2.43a4.9 4.9 0 0 0-1.15-1.77A4.9 4.9 0 0 0 18.55.53c-.64-.25-1.37-.42-2.43-.47C15.06 2.01 14.72 2 12 2Zm0 1.8c2.67 0 2.99.01 4.04.06.98.04 1.5.2 1.86.34.47.18.8.4 1.15.75.35.35.57.68.75 1.15.14.36.3.88.34 1.86.05 1.05.06 1.37.06 4.04s-.01 2.99-.06 4.04c-.04.98-.2 1.5-.34 1.86-.18.47-.4.8-.75 1.15-.35.35-.68.57-1.15.75-.36.14-.88.3-1.86.34-1.05.05-1.37.06-4.04.06s-2.99-.01-4.04-.06c-.98-.04-1.5-.2-1.86-.34a3.1 3.1 0 0 1-1.15-.75 3.1 3.1 0 0 1-.75-1.15c-.14-.36-.3-.88-.34-1.86-.05-1.05-.06-1.37-.06-4.04s.01-2.99.06-4.04c.04-.98.2-1.5.34-1.86.18-.47.4-.8.75-1.15.35-.35.68-.57 1.15-.75.36-.14.88-.3 1.86-.34C9.01 3.81 9.33 3.8 12 3.8Zm0 3.06a5.14 5.14 0 1 0 0 10.28 5.14 5.14 0 0 0 0-10.28Zm0 8.48a3.34 3.34 0 1 1 0-6.68 3.34 3.34 0 0 1 0 6.68Zm5.34-8.68a1.2 1.2 0 1 1-2.4 0 1.2 1.2 0 0 1 2.4 0Z" />
                  </svg>
                </button>
              </>
            );
          })()}
        </div>
        <p className="text-text-muted text-xs mt-3">
          Share this link to earn commissions when your referrals stake tokens — up to 10 levels deep!
          {isRefreshing && <span className="ml-2 text-brand-400 animate-pulse">Syncing...</span>}
        </p>
      </div>

      {/* Referred-by banner — only shown when we know who registered this wallet */}
      {myReferrer && (
        <div className="glass-card flex items-center gap-3 py-3 px-4 border border-accent-purple/20 bg-accent-purple/5">
          <span className="text-accent-purple text-lg shrink-0">◈</span>
          <div className="min-w-0">
            <p className="text-[10px] font-display uppercase tracking-wider text-text-muted">Referred by</p>
            <p className="font-mono text-xs text-text-primary truncate" title={myReferrer}>{myReferrer}</p>
          </div>
        </div>
      )}

      {/* Wallet Lookup — check anyone's (upline, downline, or any wallet's) public
          staking/team stats. All fields here are publicly readable on-chain
          already (e.g. via Solscan), so this exposes nothing new. */}
      <div className="glass-card">
        <p className="text-text-muted text-xs font-display uppercase tracking-wider mb-2">Look Up Any Wallet</p>
        <div className="flex gap-2">
          <input
            type="text"
            value={lookupInput}
            onChange={(e) => setLookupInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void handleLookup(); }}
            placeholder="Paste a Solana wallet address..."
            className="flex-1 min-w-0 bg-surface-900/60 border border-white/10 rounded-lg px-3 py-2 text-xs font-mono text-text-primary placeholder:text-text-muted focus:outline-none focus:border-brand-500/40"
          />
          <button
            type="button"
            onClick={() => void handleLookup()}
            disabled={lookupLoading || !lookupInput.trim()}
            className="px-4 py-2 rounded-lg font-display text-xs font-semibold bg-brand-500/15 text-brand-400 border border-brand-500/30 hover:bg-brand-500/25 transition-all disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
          >
            {lookupLoading ? 'Searching...' : 'Search'}
          </button>
        </div>

        {lookupError && (
          <p className="text-red-400 text-xs mt-2">{lookupError}</p>
        )}

        {lookupResult && (
          <div className="mt-3 pt-3 border-t border-white/5">
            <p className="font-mono text-[11px] text-text-muted truncate mb-2" title={lookupResult.address}>
              {lookupResult.address}
            </p>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              <div className="bg-surface-900/40 rounded-lg p-2 text-center">
                <p className="text-text-muted text-[10px] font-display uppercase tracking-wider">Staked</p>
                <p className="font-display font-bold text-sm mt-0.5 text-brand-400">{formatNumber(lookupResult.totalStaked)}</p>
              </div>
              <div className="bg-surface-900/40 rounded-lg p-2 text-center">
                <p className="text-text-muted text-[10px] font-display uppercase tracking-wider">Team Size</p>
                <p className="font-display font-bold text-sm mt-0.5 text-accent-amber">{lookupResult.teamSize}</p>
              </div>
              <div className="bg-surface-900/40 rounded-lg p-2 text-center">
                <p className="text-text-muted text-[10px] font-display uppercase tracking-wider">Direct Refs</p>
                <p className="font-display font-bold text-sm mt-0.5 text-accent-cyan">{lookupResult.directReferrals}</p>
              </div>
              <div className="bg-surface-900/40 rounded-lg p-2 text-center">
                <p className="text-text-muted text-[10px] font-display uppercase tracking-wider">Joined</p>
                <p className="font-display font-bold text-sm mt-0.5">
                  {lookupResult.registeredAt > 0 ? new Date(lookupResult.registeredAt * 1000).toLocaleDateString() : '—'}
                </p>
              </div>
            </div>
            {lookupResult.referrer && (
              <p className="text-text-muted text-[11px] mt-2 truncate" title={lookupResult.referrer}>
                Referred by: <span className="font-mono text-text-secondary">{lookupResult.referrer}</span>
              </p>
            )}
          </div>
        )}
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="glass-card text-center">
          <p className="text-text-muted text-xs font-display uppercase tracking-wider">Direct (L1)</p>
          <p className="font-display font-bold text-2xl mt-1 gradient-text">{totalReferrals}</p>
          {networkTotal > totalReferrals && (
            <p className="text-text-muted text-[10px] mt-0.5">{networkTotal} total network</p>
          )}
        </div>
        <div className="glass-card text-center">
          <p className="text-text-muted text-xs font-display uppercase tracking-wider">Active</p>
          <p className="font-display font-bold text-2xl mt-1 text-brand-400">{activeReferrals}</p>
          {networkTotal > 0 && activeReferrals < networkTotal && (
            <p className="text-text-muted text-[10px] mt-0.5">of {networkTotal} in network</p>
          )}
        </div>
        <div className="glass-card text-center" title="Includes both the one-time stake referral commission and the recurring claim/compound referral — the table below's 'Est. Earned' column only estimates the first of the two, so summing it won't match this total">
          <p className="text-text-muted text-xs font-display uppercase tracking-wider">Total Earned</p>
          <p className="font-display font-bold text-2xl mt-1 text-accent-cyan">{formatNumber(totalRewards, 8)}</p>
          <UsdValue amount={totalRewards} priceUsd={fbitPriceUsd} className="text-[11px]" />
        </div>
        <div className="glass-card text-center">
          <p className="text-text-muted text-xs font-display uppercase tracking-wider">Team Size</p>
          <p className="font-display font-bold text-2xl mt-1 text-accent-amber">
            {teamSize > 0 ? teamSize : '—'}
          </p>
          {teamSize === 0 && (
            <p className="text-text-muted text-[10px] mt-0.5">awaiting sync</p>
          )}
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 p-1 rounded-xl bg-surface-800/50 border border-white/5 overflow-x-auto">
        {(['overview', 'levels', 'team', 'history'] as const).map((tab) => (
          <button
            type="button"
            key={tab}
            onClick={() => setActiveView(tab)}
            className={`flex-1 py-2.5 rounded-lg font-display text-sm font-medium transition-all whitespace-nowrap px-3 ${
              activeView === tab
                ? 'bg-brand-500/10 text-brand-400 shadow-sm'
                : 'text-text-muted hover:text-text-secondary'
            }`}
          >
            {tab === 'team' ? 'Team Bonus' : tab.charAt(0).toUpperCase() + tab.slice(1)}
          </button>
        ))}
      </div>

      {/* ── Overview ── */}
      {activeView === 'overview' && (
        <div className="space-y-4">
          {/* Full referral network — all L1–L10 levels, auto-refreshed every 30s */}
          <div className="glass-card">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-display font-semibold">
                Your Referral Network
                {displayedTree.length > 0 && (
                  <span className="ml-2 text-xs text-text-muted font-normal">
                    ({displayedTree.length} member{displayedTree.length !== 1 ? 's' : ''} · {activeReferrals} staking)
                  </span>
                )}
              </h3>
              {isRefreshing && <span className="text-[10px] text-brand-400 animate-pulse">Syncing…</span>}
            </div>

            {displayedTree.length === 0 && totalReferrals === 0 ? (
              <p className="text-center py-6 text-text-muted text-sm">
                No referrals yet. Share your link to get started!
              </p>
            ) : displayedTree.length === 0 && totalReferrals > 0 ? (
              <div className="text-center py-6">
                {isRefreshing ? (
                  <p className="text-text-muted text-sm animate-pulse">Loading referral accounts…</p>
                ) : (
                  <>
                    <p className="text-text-muted text-sm">{totalReferrals} referral{totalReferrals !== 1 ? 's' : ''} registered — details unavailable</p>
                    <button type="button" onClick={handleRefresh} className="mt-2 text-xs text-brand-400 hover:text-brand-300 font-display transition-colors">
                      Retry ↻
                    </button>
                  </>
                )}
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-text-muted text-xs font-display uppercase tracking-wider border-b border-white/5">
                      <th className="text-left pb-3 pl-3">Wallet</th>
                      <th className="text-center pb-3">Lv</th>
                      <th className="text-center pb-3">Status</th>
                      <th className="text-right pb-3">Staked</th>
                      <th className="text-right pb-3" title="How many people this member has directly referred">Referred</th>
                      <th className="text-right pb-3" title="Estimated one-time stake commission only, from this referral's current stake — not a record of what was actually paid, and doesn't include the separate recurring claim/compound referral (see Total Earned above)">Est. Earned</th>
                      <th className="text-right pb-3 pr-3 hidden sm:table-cell">Joined</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/5">
                    {displayedTree.map((entry) => (
                      <tr key={`${entry.address}-${entry.level}`} className="hover:bg-white/2 transition-colors">
                        <td className="py-3 pl-3 font-mono text-xs text-text-secondary" title={entry.address}>
                          {entry.address.slice(0, 6)}…{entry.address.slice(-4)}
                        </td>
                        <td className="py-3 text-center">
                          <span className={`text-[10px] px-1.5 py-0.5 rounded font-bold border ${LEVEL_COLORS[entry.level] ?? LEVEL_COLORS[10]}`}>
                            L{entry.level}
                          </span>
                        </td>
                        <td className="py-3 text-center">
                          {entry.stakedAmount > 0
                            ? <span className="text-[11px] px-2 py-0.5 rounded-full bg-brand-500/20 text-brand-400 border border-brand-500/30">Active</span>
                            : <span className="text-[11px] px-2 py-0.5 rounded-full bg-surface-700/50 text-text-muted border border-white/10">Registered</span>
                          }
                        </td>
                        <td className="py-3 text-right font-mono text-xs">
                          {entry.stakedAmount > 0
                            ? <span className="text-brand-400">
                                {formatNumber(entry.stakedAmount)} FBiT{' '}
                                <UsdValue amount={entry.stakedAmount} priceUsd={fbitPriceUsd} className="text-[10px]" />
                              </span>
                            : <span className="text-text-muted">—</span>
                          }
                        </td>
                        <td className="py-3 text-right font-mono text-xs">
                          {entry.directReferrals > 0
                            ? <span className="text-text-secondary">{entry.directReferrals}</span>
                            : <span className="text-text-muted">—</span>
                          }
                        </td>
                        <td className="py-3 text-right font-mono text-xs">
                          {entry.rewardEarned > 0
                            ? <span className="text-accent-cyan">
                                {formatNumber(entry.rewardEarned)} FBiT{' '}
                                <UsdValue amount={entry.rewardEarned} priceUsd={fbitPriceUsd} className="text-[10px]" />
                              </span>
                            : <span className="text-text-muted">—</span>
                          }
                        </td>
                        <td className="py-3 text-right pr-3 text-xs text-text-muted hidden sm:table-cell">
                          {entry.registeredAt > 0
                            ? new Date(entry.registeredAt * 1000).toLocaleDateString()
                            : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {displayedTree.some(r => r.stakedAmount === 0) && (
              <p className="text-[11px] text-text-muted mt-3 pt-3 border-t border-white/5">
                Referral rewards and Team Size credit are earned when your referrals stake FBiT tokens.
              </p>
            )}
          </div>

          {/* How It Works */}
          <div className="glass-card">
            <h3 className="font-display font-semibold mb-4">How It Works</h3>
            <div className="space-y-3">
              {[
                { n: 1, color: 'bg-brand-500/20 text-brand-400',        title: 'Share Your Link',       body: 'Copy your unique referral link and share it with friends and community.' },
                { n: 2, color: 'bg-accent-purple/20 text-accent-purple', title: 'They Stake',            body: 'When someone registers through your link and stakes tokens, you earn commissions.' },
                { n: 3, color: 'bg-accent-cyan/20 text-accent-cyan',     title: 'Earn 10 Levels Deep',   body: 'Earn from referrals up to 10 levels deep. The deeper the network, the higher the rewards!' },
              ].map(({ n, color, title, body }) => (
                <div key={n} className="flex items-start gap-4 p-3 rounded-xl bg-surface-800/30">
                  <div className={`w-8 h-8 rounded-lg ${color} flex items-center justify-center font-display font-bold text-sm shrink-0`}>{n}</div>
                  <div>
                    <p className="font-display font-medium text-sm">{title}</p>
                    <p className="text-text-muted text-xs mt-0.5">{body}</p>
                  </div>
                </div>
              ))}
            </div>
            {currentTier && (
              <div className="mt-4 pt-4 border-t border-white/5 flex items-center justify-between">
                <div>
                  <p className="text-xs text-text-muted">Active Team Bonus</p>
                  <p className="font-display font-bold text-brand-400">+{currentTier.bonusPercentage}% ({currentTier.label})</p>
                </div>
                <button type="button" onClick={() => setActiveView('team')} className="text-xs text-text-muted hover:text-text-secondary font-display transition-colors">
                  View tiers →
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Levels ── */}
      {activeView === 'levels' && (
        <div className="space-y-4">
          <div className="glass-card">
            <div className="flex items-center justify-between mb-1 flex-wrap gap-2">
              <h3 className="font-display font-semibold">One-Time Stake Referral</h3>
              {isRefreshing && <span className="text-[10px] text-brand-400 animate-pulse">Syncing…</span>}
            </div>
            <p className="text-[11px] text-text-muted mb-4">Paid once, the instant a referral first stakes — up to 10 levels deep.</p>
            <div className="space-y-2">
              {(() => {
                const maxPct   = Math.max(...activeLevels.map(l => l.percentage));
                const totalPct = activeLevels.reduce((s, l) => s + l.percentage, 0);
                return (
                  <>
                    {activeLevels.map((level) => {
                      const countAtLevel  = displayedTree.filter(r => r.level === level.level).length;
                      const activeAtLevel = displayedTree.filter(r => r.level === level.level && r.stakedAmount > 0).length;
                      return (
                        <div key={level.level} className="flex items-center justify-between p-3 rounded-xl bg-surface-800/30 hover:bg-surface-800/50 transition-colors">
                          <div className="flex items-center gap-3">
                            <div className={`w-8 h-8 rounded-lg flex items-center justify-center text-xs font-bold ${
                              level.level <= 3  ? 'bg-brand-500/20 text-brand-400' :
                              level.level <= 6  ? 'bg-accent-purple/20 text-accent-purple' :
                              level.level <= 8  ? 'bg-accent-cyan/20 text-accent-cyan' :
                              'bg-accent-amber/20 text-accent-amber'
                            }`}>L{level.level}</div>
                            <div>
                              <span className="font-display text-sm block">Level {level.level}</span>
                              <span className="text-[11px] text-text-muted">
                                {countAtLevel === 0
                                  ? 'No referrals'
                                  : `${countAtLevel} referral${countAtLevel !== 1 ? 's' : ''}${activeAtLevel > 0 ? ` · ${activeAtLevel} staking` : ''}`}
                              </span>
                            </div>
                          </div>
                          <div className="flex items-center gap-4">
                            <div className="w-28 h-2 rounded-full bg-surface-900 overflow-hidden">
                              <ProgressBar pct={(level.percentage / maxPct) * 100} className="bg-linear-to-r from-brand-500 to-accent-cyan" />
                            </div>
                            <span className="font-mono text-sm text-brand-400 w-14 text-right">{level.percentage}%</span>
                          </div>
                        </div>
                      );
                    })}
                    <div className="mt-4 pt-4 border-t border-white/5 flex justify-between text-sm">
                      <span className="text-text-muted">Total (one-time, all 10 levels)</span>
                      <span className="font-mono text-brand-400 font-bold">{totalPct}%</span>
                    </div>
                  </>
                );
              })()}
            </div>
          </div>

          <div className="glass-card">
            <h3 className="font-display font-semibold mb-1">Recurring Claim Referral</h3>
            <p className="text-[11px] text-text-muted mb-4">Paid every time a referral claims or compounds — levels 1-5 only, carved out of their own reward, on top of the one-time layer above.</p>
            <div className="space-y-2">
              {(() => {
                const maxPct   = Math.max(...CLAIM_REFERRAL_LEVELS.map(l => l.percentage));
                const totalPct = CLAIM_REFERRAL_LEVELS.reduce((s, l) => s + l.percentage, 0);
                return (
                  <>
                    {CLAIM_REFERRAL_LEVELS.map((level) => {
                      const countAtLevel  = displayedTree.filter(r => r.level === level.level).length;
                      const activeAtLevel = displayedTree.filter(r => r.level === level.level && r.stakedAmount > 0).length;
                      return (
                        <div key={level.level} className="flex items-center justify-between p-3 rounded-xl bg-surface-800/30 hover:bg-surface-800/50 transition-colors">
                          <div className="flex items-center gap-3">
                            <div className="w-8 h-8 rounded-lg flex items-center justify-center text-xs font-bold bg-brand-500/20 text-brand-400">
                              L{level.level}
                            </div>
                            <div>
                              <span className="font-display text-sm block">Level {level.level}</span>
                              <span className="text-[11px] text-text-muted">
                                {countAtLevel === 0
                                  ? 'No referrals'
                                  : `${countAtLevel} referral${countAtLevel !== 1 ? 's' : ''}${activeAtLevel > 0 ? ` · ${activeAtLevel} staking` : ''}`}
                              </span>
                            </div>
                          </div>
                          <div className="flex items-center gap-4">
                            <div className="w-28 h-2 rounded-full bg-surface-900 overflow-hidden">
                              <ProgressBar pct={(level.percentage / maxPct) * 100} className="bg-linear-to-r from-brand-500 to-accent-cyan" />
                            </div>
                            <span className="font-mono text-sm text-brand-400 w-14 text-right">{level.percentage}%</span>
                          </div>
                        </div>
                      );
                    })}
                    <div className="mt-4 pt-4 border-t border-white/5 flex justify-between text-sm">
                      <span className="text-text-muted">Total (recurring, levels 1-5)</span>
                      <span className="font-mono text-brand-400 font-bold">{totalPct}%</span>
                    </div>
                  </>
                );
              })()}
            </div>
          </div>
        </div>
      )}

      {/* ── Team Bonus ── */}
      {activeView === 'team' && (
        <div className="space-y-4">
          <div className={`glass-card border ${
            currentTier
              ? 'bg-linear-to-br from-accent-purple/10 to-brand-500/10 border-accent-purple/20'
              : 'bg-surface-800/30 border-white/5'
          }`}>
            <div className="flex items-center justify-between flex-wrap gap-3">
              <div>
                <p className="text-text-muted text-xs font-display uppercase tracking-wider mb-1">Your Current Tier</p>
                {currentTier ? (
                  <p className="font-display font-bold text-xl gradient-text">{currentTier.label} — +{currentTier.bonusPercentage}% Bonus</p>
                ) : (
                  <p className="font-display font-bold text-xl text-text-secondary">No Tier Yet</p>
                )}
              </div>
              <div className="text-right">
                <p className="text-text-muted text-xs mb-1">Team Size · Team Staked</p>
                <p className="font-mono text-sm">
                  <span className="text-brand-400">{teamSize}</span>
                  <span className="text-text-muted"> members · </span>
                  <span className="text-accent-cyan">{formatNumber(teamTotalStaked)}</span>
                  <span className="text-text-muted"> FBiT</span>
                </p>
                <UsdValue amount={teamTotalStaked} priceUsd={fbitPriceUsd} className="text-[11px]" />
              </div>
            </div>
            {nextTier && (
              <div className="mt-4 pt-4 border-t border-white/5">
                <p className="text-text-muted text-xs mb-2">
                  Progress to <span className="text-brand-400 font-medium">{nextTier.label} (+{nextTier.bonusPercentage}%)</span>
                </p>
                <div className="grid grid-cols-1 gap-3">
                  {[{ label: 'Team Staked', cur: teamTotalStaked, max: nextTier.minTeamStaked }].map(({ label, cur, max }) => (
                    <div key={label}>
                      <div className="flex justify-between text-xs mb-1">
                        <span className="text-text-muted">{label}</span>
                        <span className="font-mono text-text-secondary">{formatNumber(cur)} / {formatNumber(max)}</span>
                      </div>
                      <div className="h-1.5 rounded-full bg-surface-900 overflow-hidden">
                        <ProgressBar pct={(cur / max) * 100} className="bg-linear-to-r from-accent-cyan to-brand-500" />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          <div className="glass-card">
            <h3 className="font-display font-semibold mb-4">10-Tier Team Target Bonus</h3>
            <p className="text-text-muted text-xs mb-4">
              Grow your team's total staked FBiT to unlock a permanent bonus applied on top of every staking reward claim.
            </p>
            <div className="space-y-3">
              {activeTierList.map((tier) => {
                const isActive   = currentTier?.tier === tier.tier;
                const isUnlocked = currentTier ? currentTier.tier >= tier.tier : false;
                const colMap: Record<string, string> = {
                  amber:  'bg-accent-amber/20 text-accent-amber border-accent-amber/20',
                  slate:  'bg-surface-700/60 text-text-secondary border-white/10',
                  yellow: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/20',
                  cyan:   'bg-accent-cyan/20 text-accent-cyan border-accent-cyan/20',
                  purple: 'bg-accent-purple/20 text-accent-purple border-accent-purple/20',
                  rose:   'bg-accent-rose/20 text-accent-rose border-accent-rose/20',
                  green:  'bg-emerald-400/20 text-emerald-400 border-emerald-400/20',
                  blue:   'bg-blue-400/20 text-blue-400 border-blue-400/20',
                  gray:   'bg-gray-400/20 text-gray-400 border-gray-400/20',
                  brand:  'bg-brand-500/20 text-brand-400 border-brand-500/20',
                };
                return (
                  <div key={tier.tier} className={`flex items-center justify-between p-3 rounded-xl border transition-colors ${
                    isActive   ? 'bg-brand-500/10 border-brand-500/30' :
                    isUnlocked ? 'bg-surface-800/50 border-white/10' :
                    'bg-surface-800/20 border-white/5 opacity-60'
                  }`}>
                    <div className="flex items-center gap-3">
                      <div className={`px-2.5 py-1 rounded-lg text-xs font-bold border ${colMap[tier.color]}`}>T{tier.tier}</div>
                      <div>
                        <p className="font-display font-medium text-sm flex items-center gap-2">
                          {tier.label}
                          {isActive   && <span className="text-xs text-brand-400 font-normal">(Active)</span>}
                          {isUnlocked && !isActive && <span className="text-xs text-text-muted">✓</span>}
                        </p>
                        <p className="text-text-muted text-xs mt-0.5">{formatNumber(tier.minTeamStaked)} FBiT staked</p>
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <p className={`font-display font-bold text-lg ${isUnlocked ? 'text-brand-400' : 'text-text-muted'}`}>+{tier.bonusPercentage}%</p>
                      <p className="text-text-muted text-xs">bonus</p>
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="mt-4 pt-4 border-t border-white/5 flex justify-between text-sm">
              <span className="text-text-muted">Max bonus ({activeTierList[activeTierList.length - 1]?.label ?? 'Titan'})</span>
              <span className="font-mono text-brand-400 font-bold">
                +{activeTierList[activeTierList.length - 1]?.bonusPercentage ?? 10}%
              </span>
            </div>
          </div>
        </div>
      )}

      {/* ── History ── */}
      {activeView === 'history' && (
        <div className="space-y-4">

          {/* ── Referral Reward Transactions ── */}
          <div className="glass-card">
            <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
              <div>
                <h3 className="font-display font-semibold">
                  Referral Reward History
                  {allRefTxs.length > 0 && (
                    <span className="ml-2 text-xs text-text-muted font-normal">({allRefTxs.length} records)</span>
                  )}
                </h3>
                <p className="text-text-muted text-xs mt-0.5">
                  On-chain transactions where your referrals staked and you received a reward
                  {onChainRefHistory.length >= 200 && (
                    <span className="ml-1 text-accent-amber">· showing last 200 only</span>
                  )}
                </p>
              </div>
              <button
                type="button"
                onClick={handleRefreshFromChain}
                disabled={isFetchingChain}
                className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-display font-semibold border border-brand-500/30 text-brand-400 hover:bg-brand-500/10 transition-all disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
              >
                {isFetchingChain ? (
                  <><span className="animate-spin text-xs">◌</span> Fetching...</>
                ) : (
                  <>⟳ Refresh from Chain</>
                )}
              </button>
            </div>

            {allRefTxs.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-10 text-center">
                <div className="text-4xl mb-3 opacity-20">◎</div>
                {hasFetchedChain ? (
                  <>
                    <p className="font-display font-medium text-text-secondary">No referral rewards found on-chain</p>
                    <p className="text-text-muted text-xs mt-1">Rewards appear here when your referrals stake FBiT</p>
                  </>
                ) : (
                  <>
                    <p className="font-display font-medium text-text-secondary">Load your on-chain referral history</p>
                    <p className="text-text-muted text-xs mt-1">Click <span className="text-brand-400">Refresh from Chain</span> to scan the last 200 transactions</p>
                  </>
                )}
              </div>
            ) : (
              <div className="space-y-2">
                {allRefTxs.map(tx => {
                  const explorerUrl = getExplorerTxUrl(tx.network, tx.txHash);
                  return (
                    <div key={tx.id} className="flex items-center gap-3 py-3 px-3 rounded-xl bg-surface-800/40 border border-white/5 hover:border-white/10 transition-all">
                      <div className="w-8 h-8 rounded-xl flex items-center justify-center text-sm font-bold shrink-0 bg-accent-amber/20 text-accent-amber border border-accent-amber/30">
                        ◎
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-xs font-display font-semibold text-accent-amber">Referral Reward</p>
                        <p className="text-text-muted text-[11px] truncate mt-0.5">{tx.label}</p>
                      </div>
                      <div className="text-right shrink-0">
                        <p className="font-mono text-sm font-semibold text-accent-amber">+{formatNumber(tx.amount, 8)}</p>
                        <p className="text-text-muted text-[10px]">
                          FBiT <UsdValue amount={tx.amount} priceUsd={fbitPriceUsd} />
                        </p>
                      </div>
                      <div className="text-right shrink-0 hidden sm:block">
                        <p className="text-text-secondary text-xs">
                          {new Date(tx.timestamp).toLocaleDateString(undefined, { day: '2-digit', month: 'short' })}
                        </p>
                        <p className="text-text-muted text-[10px]">
                          {new Date(tx.timestamp).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
                        </p>
                      </div>
                      {tx.txHash && tx.txHash !== 'local' && (
                        <a
                          href={explorerUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          title="View on explorer"
                          className="shrink-0 w-7 h-7 flex items-center justify-center rounded-lg hover:bg-white/5 text-text-muted hover:text-brand-400 transition-colors"
                        >
                          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                            <path d="M2 10L10 2M10 2H5M10 2V7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                          </svg>
                        </a>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* ── Referral Network Tree ── */}
          <div className="glass-card">
            <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
              <div>
                <h3 className="font-display font-semibold">
                  Referral Network
                  {displayedTree.length > 0 && (
                    <span className="ml-2 text-xs text-text-muted font-normal">
                      ({displayedTree.length} across all levels)
                    </span>
                  )}
                </h3>
              </div>
              {displayedTree.length > 0 && (
                <div className="flex gap-2 flex-wrap">
                  {Array.from(new Set(displayedTree.map(r => r.level))).sort((a, b) => a - b).map(lvl => (
                    <span key={lvl} className={`text-[10px] px-2 py-0.5 rounded-full border font-mono ${LEVEL_COLORS[lvl] ?? 'bg-surface-700 text-text-muted border-white/10'}`}>
                      L{lvl}: {displayedTree.filter(r => r.level === lvl).length}
                    </span>
                  ))}
                </div>
              )}
            </div>

            {displayedTree.length === 0 ? (
              <p className="text-center py-8 text-text-muted text-sm">
                No referrals yet. Share your link to get started!
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-text-muted text-xs font-display uppercase tracking-wider">
                      <th className="text-left pb-3 pl-3">User</th>
                      <th className="text-center pb-3">Level</th>
                      <th className="text-right pb-3">Staked</th>
                      <th className="text-right pb-3 pr-3">Joined</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/5">
                    {displayedTree.map((entry) => (
                      <tr key={`${entry.address}-${entry.level}`} className="hover:bg-white/2 transition-colors">
                        <td className="py-3 pl-3 font-mono text-xs text-text-secondary" title={entry.address}>
                          {entry.address.slice(0, 6)}...{entry.address.slice(-4)}
                        </td>
                        <td className="py-3 text-center">
                          <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium border ${LEVEL_COLORS[entry.level] ?? 'bg-surface-700 text-text-muted border-white/10'}`}>
                            L{entry.level}
                          </span>
                        </td>
                        <td className="py-3 text-right font-mono text-xs">
                          {entry.stakedAmount > 0
                            ? <span className="text-brand-400">
                                {formatNumber(entry.stakedAmount)} FBiT{' '}
                                <UsdValue amount={entry.stakedAmount} priceUsd={fbitPriceUsd} className="text-[10px]" />
                              </span>
                            : <span className="text-text-muted">—</span>
                          }
                        </td>
                        <td className="py-3 text-right pr-3 text-xs text-text-muted">
                          {entry.registeredAt > 0
                            ? new Date(entry.registeredAt * 1000).toLocaleDateString()
                            : '—'
                          }
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {hasFetchedChain && fullReferralTree.length === 0 && displayedTree.length === 0 && (
              <p className="text-center py-4 text-text-muted text-xs">
                No referrals found across all 10 levels on-chain.
              </p>
            )}
          </div>

          {/* Total from on-chain */}
          {(totalRewards > 0 || displayedTree.length > 0) && (
            <div className="glass-card bg-linear-to-r from-accent-amber/5 to-brand-500/5 border border-accent-amber/10">
              <div className="flex items-center justify-between flex-wrap gap-3">
                <div>
                  <p className="text-text-muted text-xs font-display uppercase tracking-wider mb-1">Total Referral Rewards (on-chain)</p>
                  <p className="font-display font-bold text-2xl text-accent-amber">{formatNumber(totalRewards, 8)} FBiT</p>
                  <UsdValue amount={totalRewards} priceUsd={fbitPriceUsd} className="text-[11px]" />
                </div>
                <div className="text-right">
                  <p className="text-text-muted text-xs mb-1">Network Depth</p>
                  <p className="font-display font-bold text-brand-400">
                    {displayedTree.length > 0
                      ? `${Math.max(...displayedTree.map(r => r.level))} level${Math.max(...displayedTree.map(r => r.level)) !== 1 ? 's' : ''}`
                      : '—'}
                  </p>
                </div>
              </div>
              <p className="text-text-muted text-[11px] mt-3">
                Total from <span className="text-accent-amber font-mono">{userAccount?.totalReferralRewards !== undefined ? 'on-chain' : 'local'} UserAccount</span>. Reward transaction history shows last 200 on-chain events.
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
