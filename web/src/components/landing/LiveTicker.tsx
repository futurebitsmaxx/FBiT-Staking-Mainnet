'use client';

import React, { useEffect, useState } from 'react';
import { useTokenPrice } from '@/hooks/useTokenPrice';
import { NETWORK_CONFIG } from '@/lib/config';

const TOTAL_SUPPLY = 250_000_000;
// Every visitor on the highest-traffic page hits this — and it shares the
// same rate-limited RPC key that stake/claim/compound/referral depend on.
// Holder count doesn't meaningfully change minute to minute, so 60s was pure
// waste against that shared quota; 5 minutes is still fresh enough to feel live.
const HOLDERS_REFRESH_MS = 300_000;

function formatPrice(n: number): string {
  return n < 0.01 ? `$${n.toPrecision(3)}` : `$${n.toFixed(4)}`;
}

function formatCompactUsd(n: number): string {
  return `$${new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 }).format(n)}`;
}

function formatCompactNumber(n: number): string {
  return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(n);
}

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <span className="flex items-center gap-2 shrink-0">
      <span className="text-text-muted tracking-wider">{label}</span>
      <span className="text-text-primary font-semibold">{children}</span>
    </span>
  );
}

function PriceChange({ pct }: { pct: number }) {
  const isPos = pct >= 0;
  return (
    <span className={isPos ? 'text-brand-400' : 'text-accent-rose'}>
      {isPos ? '▲' : '▼'} {Math.abs(pct).toFixed(2)}%
    </span>
  );
}

/** Total SPL token accounts for the FBiT mint, via Helius's `getTokenAccounts`
 *  DAS extension (only available when NEXT_PUBLIC_HELIUS_API_KEY is set — falls
 *  back to hidden rather than erroring if the configured RPC doesn't support it).
 *  `result.total` is just the page size, not a grand total, so accounts are
 *  actually counted page by page via `cursor` (capped at 5 pages / 5000 accounts —
 *  fine for now, and avoids an unbounded loop if the holder base grows a lot). */
function useHolderCount(): number | null {
  const [count, setCount] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      const mint = NETWORK_CONFIG.solana.stakeTokenAddress;
      if (!mint) return;
      try {
        let total = 0;
        let cursor: string | undefined;
        for (let page = 0; page < 5; page++) {
          const res = await fetch(NETWORK_CONFIG.solana.rpcUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: 'holders',
              method: 'getTokenAccounts',
              params: { mint, limit: 1000, cursor },
            }),
          });
          if (!res.ok) break;
          const json = await res.json();
          const accounts = json?.result?.token_accounts;
          if (!Array.isArray(accounts) || accounts.length === 0) break;
          total += accounts.length;
          cursor = json?.result?.cursor;
          if (accounts.length < 1000 || !cursor) break;
        }
        if (!cancelled && total > 0) setCount(total);
      } catch {
        /* silently hidden — not every RPC provider supports this method */
      }
    }

    load();
    const timer = setInterval(load, HOLDERS_REFRESH_MS);
    return () => { cancelled = true; clearInterval(timer); };
  }, []);

  return count;
}

/** Sticky bottom live-stats bar for the marketing homepage — price/24h/mcap/liquidity
 *  from the same GeckoTerminal-backed hook already used for the Stake/Swap tabs, plus
 *  a holder count from Helius. */
export default function LiveTicker() {
  const { pairs, isLoading, source } = useTokenPrice();
  const holders = useHolderCount();
  const pair = pairs[0];

  const price     = pair ? parseFloat(pair.priceUsd) : null;
  // The on-chain fallback source can't derive a real 24h change from a single
  // snapshot — it hardcodes 0, which would otherwise render as a confident-looking
  // "▲ 0.00%" instead of the "we don't know yet" it actually means.
  const change    = pair && source === 'geckoterminal' ? pair.priceChange24h : null;
  const liquidity = pair ? pair.liquidityUsd : null;
  const marketCap = price != null ? price * TOTAL_SUPPLY : null;

  return (
    <div
      className="fixed bottom-0 inset-x-0 z-40 border-t border-white/10 backdrop-blur-md"
      style={{ background: 'rgba(5, 5, 5, 0.95)' }}
    >
      <div className="max-w-7xl mx-auto px-4 sm:px-6 h-14 flex items-center justify-center gap-6 sm:gap-10 overflow-x-auto text-sm sm:text-base font-mono">
        <span className="flex items-center gap-2 shrink-0">
          <span className="w-2 h-2 rounded-full bg-brand-400 animate-pulse" />
          <span className="text-brand-400 font-display font-bold tracking-wider">LIVE</span>
        </span>

        <Stat label="MCAP">{marketCap != null ? formatCompactUsd(marketCap) : (isLoading ? '···' : '—')}</Stat>
        <Stat label="24H">{change != null ? <PriceChange pct={change} /> : (isLoading ? '···' : '—')}</Stat>
        <Stat label="PRICE">{price != null ? formatPrice(price) : (isLoading ? '···' : '—')}</Stat>
        <Stat label="LIQ">{liquidity != null ? formatCompactUsd(liquidity) : (isLoading ? '···' : '—')}</Stat>
        {holders != null && <Stat label="HOLDERS">{formatCompactNumber(holders)}</Stat>}
      </div>
    </div>
  );
}
