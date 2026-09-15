'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import { useAppStore } from '@/lib/store';
import { NETWORK_CONFIG } from '@/lib/config';
import { useWallet } from '@/context/WalletContext';
import { useTokenPrice } from '@/hooks/useTokenPrice';
import { formatNumber } from '@/lib/utils';
import { checkRateLimit, sanitizeErrorMessage } from '@/lib/security';
import {
  jupiterGetQuote,
  jupiterExecuteSwap,
  solanaGetSolBalance,
  solanaGetTokenBalance,
  type JupiterQuote,
} from '@/lib/contracts/solana';
import TokenPriceWidget from '@/components/market/TokenPriceWidget';

const SOL_MINT     = 'So11111111111111111111111111111111111111112';
const SOL_DECIMALS = 9;
const FBIT_DECIMALS = 9;
const SLIPPAGE_OPTIONS = [50, 100, 300]; // bps: 0.5% / 1% / 3%
const QUOTE_DEBOUNCE_MS = 500;

function toRawAmount(amount: string, decimals: number): string {
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) return '0';
  return Math.floor(n * 10 ** decimals).toString();
}

function fromRawAmount(raw: string, decimals: number): number {
  return Number(raw) / 10 ** decimals;
}

function PriceChart() {
  const { pairs } = useTokenPrice();
  const poolAddress = pairs[0]?.pairAddress;

  if (!poolAddress) {
    return (
      <div className="glass-card flex items-center justify-center h-100 text-text-muted text-sm">
        Chart unavailable — no liquidity pool found yet.
      </div>
    );
  }

  return (
    <div className="glass-card p-0 overflow-hidden h-100 lg:h-full">
      <iframe
        title="FBiT price chart"
        src={`https://www.geckoterminal.com/solana/pools/${poolAddress}?embed=1&info=0&swaps=0`}
        className="w-full h-full border-0"
        allow="clipboard-write"
      />
    </div>
  );
}

function SwapForm() {
  const { solanaAddress } = useWallet();
  const fbitMint = NETWORK_CONFIG.solana.stakeTokenAddress;

  // false = SOL -> FBiT, true = FBiT -> SOL
  const [reversed, setReversed] = useState(false);
  const [amount, setAmount] = useState('');
  const [slippageBps, setSlippageBps] = useState(SLIPPAGE_OPTIONS[0]);
  const [quote, setQuote] = useState<JupiterQuote | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [swapping, setSwapping] = useState(false);
  const [solBalance, setSolBalance] = useState(0);
  const [fbitBalance, setFbitBalance] = useState(0);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestIdRef = useRef(0);

  const inputMint    = reversed ? fbitMint : SOL_MINT;
  const outputMint   = reversed ? SOL_MINT : fbitMint;
  const inputSymbol  = reversed ? 'FBiT' : 'SOL';
  const outputSymbol = reversed ? 'SOL'  : 'FBiT';
  const inputDecimals  = reversed ? FBIT_DECIMALS : SOL_DECIMALS;
  const outputDecimals = reversed ? SOL_DECIMALS  : FBIT_DECIMALS;
  const inputBalance  = reversed ? fbitBalance : solBalance;

  const refreshBalances = useCallback(async () => {
    if (!solanaAddress) { setSolBalance(0); setFbitBalance(0); return; }
    const [sol, fbit] = await Promise.all([
      solanaGetSolBalance(solanaAddress),
      solanaGetTokenBalance(solanaAddress),
    ]);
    setSolBalance(sol);
    setFbitBalance(fbit);
  }, [solanaAddress]);

  useEffect(() => { refreshBalances(); }, [refreshBalances]);

  // Debounced quote fetch whenever amount/direction/slippage changes.
  useEffect(() => {
    setQuote(null);
    const n = Number(amount);
    if (!Number.isFinite(n) || n <= 0) return;

    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      const reqId = ++requestIdRef.current;
      setQuoting(true);
      try {
        const raw = toRawAmount(amount, inputDecimals);
        const q = await jupiterGetQuote(inputMint, outputMint, raw, slippageBps);
        if (reqId === requestIdRef.current) setQuote(q);
      } catch (err) {
        if (reqId === requestIdRef.current) {
          setQuote(null);
          toast.error(sanitizeErrorMessage(err));
        }
      } finally {
        if (reqId === requestIdRef.current) setQuoting(false);
      }
    }, QUOTE_DEBOUNCE_MS);

    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [amount, inputMint, outputMint, slippageBps]);

  const outputAmount = quote ? fromRawAmount(quote.outAmountRaw, outputDecimals) : null;
  const highImpact = (quote?.priceImpactPct ?? 0) > 3;

  const handleFlip = () => {
    setReversed(r => !r);
    setAmount('');
    setQuote(null);
  };

  const handleMax = () => {
    // Leave a small SOL buffer for network fees when swapping native SOL.
    const bal = reversed ? fbitBalance : Math.max(0, solBalance - 0.01);
    setAmount(bal > 0 ? String(bal) : '');
  };

  const handleSwap = async () => {
    if (!solanaAddress) { toast.error('Connect your Solana wallet first.'); return; }
    if (!quote) { toast.error('Get a quote first.'); return; }
    if (!checkRateLimit('jupiter-swap', { maxCalls: 3, windowMs: 60_000 })) {
      toast.error('Too many swap attempts. Please wait a minute.');
      return;
    }

    setSwapping(true);
    const toastId = toast.loading(`Swapping ${amount} ${inputSymbol} → ${outputSymbol}…`);
    try {
      const { txHash } = await jupiterExecuteSwap(quote);
      toast.success(`✓ Swapped! Received ~${formatNumber(outputAmount ?? 0, 4)} ${outputSymbol}`, { id: toastId });
      console.info('[swap] tx:', txHash);
      setAmount('');
      setQuote(null);
      refreshBalances();
    } catch (err) {
      toast.error(sanitizeErrorMessage(err), { id: toastId });
    } finally {
      setSwapping(false);
    }
  };

  const insufficientBalance = Number(amount) > inputBalance;

  return (
    <div className="w-full max-w-105 space-y-3">
      {/* Slippage */}
      <div className="flex items-center justify-between text-xs">
        <span className="text-text-muted">Slippage</span>
        <div className="flex gap-1.5">
          {SLIPPAGE_OPTIONS.map(bps => (
            <button
              key={bps}
              type="button"
              onClick={() => setSlippageBps(bps)}
              className={`px-2 py-1 rounded-lg font-mono transition-colors ${
                slippageBps === bps
                  ? 'bg-brand-500/20 text-brand-400 border border-brand-500/30'
                  : 'bg-surface-800/60 text-text-muted border border-white/5 hover:text-text-secondary'
              }`}
            >
              {(bps / 100).toFixed(bps % 100 === 0 ? 0 : 1)}%
            </button>
          ))}
        </div>
      </div>

      {/* From */}
      <div className="rounded-xl bg-surface-800/60 border border-white/5 p-3">
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-xs text-text-muted">From</span>
          <button type="button" onClick={handleMax} className="text-[11px] text-brand-400 hover:text-brand-300 font-mono">
            Balance: {formatNumber(inputBalance, 4)} {inputSymbol} · MAX
          </button>
        </div>
        <div className="flex items-center gap-2">
          <input
            type="number"
            inputMode="decimal"
            min="0"
            value={amount}
            onChange={e => setAmount(e.target.value)}
            placeholder="0.0"
            className="flex-1 bg-transparent text-xl font-mono font-semibold outline-none min-w-0"
          />
          <span className="font-display font-semibold text-sm shrink-0">{inputSymbol}</span>
        </div>
      </div>

      {/* Flip */}
      <div className="flex justify-center -my-1.5 relative z-10">
        <button
          type="button"
          onClick={handleFlip}
          title="Reverse direction"
          className="w-8 h-8 rounded-lg bg-surface-900 border border-white/10 flex items-center justify-center text-text-secondary hover:text-brand-400 hover:border-brand-500/30 transition-colors"
        >
          ⇅
        </button>
      </div>

      {/* To */}
      <div className="rounded-xl bg-surface-800/60 border border-white/5 p-3">
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-xs text-text-muted">To (estimated)</span>
          <span className="text-[11px] text-text-muted font-mono">
            Balance: {formatNumber(reversed ? solBalance : fbitBalance, 4)} {outputSymbol}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="flex-1 text-xl font-mono font-semibold min-w-0 truncate text-text-primary">
            {quoting ? '…' : outputAmount !== null ? formatNumber(outputAmount, 6) : '0.0'}
          </span>
          <span className="font-display font-semibold text-sm shrink-0">{outputSymbol}</span>
        </div>
      </div>

      {/* Quote details */}
      {quote && (
        <div className="text-xs text-text-muted space-y-1 px-1">
          <div className="flex justify-between">
            <span>Price impact</span>
            <span className={highImpact ? 'text-accent-rose font-semibold' : ''}>
              {quote.priceImpactPct.toFixed(2)}%
            </span>
          </div>
          <div className="flex justify-between">
            <span>Slippage tolerance</span>
            <span>{(slippageBps / 100).toFixed(slippageBps % 100 === 0 ? 0 : 1)}%</span>
          </div>
        </div>
      )}
      {highImpact && (
        <p className="text-[11px] text-accent-rose px-1">
          ⚠ High price impact — this pool has thin liquidity. Consider a smaller amount.
        </p>
      )}

      {!solanaAddress ? (
        <p className="text-center text-sm text-text-muted py-2">Connect your Solana wallet to swap.</p>
      ) : (
        <button
          type="button"
          onClick={handleSwap}
          disabled={!quote || quoting || swapping || insufficientBalance || Number(amount) <= 0}
          className="w-full py-3 rounded-xl font-display font-semibold text-sm bg-brand-500 text-surface-900 hover:bg-brand-400 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          {swapping ? 'Swapping…' : insufficientBalance ? 'Insufficient balance' : quoting ? 'Fetching quote…' : 'Swap'}
        </button>
      )}

      <p className="text-[10px] text-text-muted text-center">
        Routed via Jupiter — best price across all Solana DEXs.
      </p>
    </div>
  );
}

export default function SwapPanel() {
  const { selectedNetwork } = useAppStore();

  if (selectedNetwork !== 'solana') {
    return (
      <div className="glass-card text-center py-16">
        <p className="font-display font-semibold text-lg mb-2">Swap is available on Solana only</p>
        <p className="text-text-muted text-sm">
          Jupiter aggregates Solana DEX liquidity — switch to the Solana network from the header to swap FBiT.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_420px] gap-4">
        <PriceChart />
        <div className="glass-card p-4 flex justify-center">
          <SwapForm />
        </div>
      </div>
      <TokenPriceWidget />
    </div>
  );
}
