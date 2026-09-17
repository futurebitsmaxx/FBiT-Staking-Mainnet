'use client';

import React, { useState, useEffect, useRef } from 'react';
import Link from 'next/link';
import toast from 'react-hot-toast';
import { useWallet } from '@/context/WalletContext';
import { useAppStore } from '@/lib/store';
import { shortenAddress } from '@/lib/utils';
import { sanitizeErrorMessage } from '@/lib/security';

function isValidSolanaAddress(addr: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(addr);
}

type GateView = 'choose' | 'referral';

function ReferralGateModal({
  savedReferral,
  onConfirm,
  onDismiss,
  onSkip,
}: {
  savedReferral?: string;
  onConfirm: (referralAddress: string) => void;
  onDismiss: () => void;
  onSkip: () => void;
}) {
  // If a saved referral exists, jump straight to the input view pre-filled
  const [view, setView] = useState<GateView>(savedReferral ? 'referral' : 'choose');
  const [input, setInput] = useState(savedReferral ?? '');
  const [error, setError] = useState('');

  const trimmed = input.trim();
  const networkLabel = 'Solana';
  const placeholder   = 'Solana wallet address (base58)';
  const validate      = (v: string) => isValidSolanaAddress(v);
  const valid = validate(trimmed);
  const wrongFormat = 'Enter a valid Solana address (base58 format).';

  const handleSubmit = () => {
    if (!trimmed) { setError('Referral address is required.'); return; }
    if (!valid)   { setError(wrongFormat); return; }
    setError('');
    onConfirm(trimmed);
  };

  return (
    <div className="fixed inset-0 z-100 flex items-center justify-center bg-black/70 backdrop-blur-sm px-4">
      <div className="glass rounded-2xl border border-brand-500/20 w-full max-w-md p-6 animate-slide-up shadow-2xl">

        {/* ── Modal header ── */}
        <div className="flex items-center gap-3 mb-5">
          <div className="w-10 h-10 rounded-xl bg-linear-to-br from-brand-500/30 to-accent-cyan/30 flex items-center justify-center text-xl shrink-0">
            ◎
          </div>
          <div className="flex-1">
            <h2 className="font-display font-bold text-lg leading-tight">Connect Wallet</h2>
            <p className="text-text-muted text-xs">FBiT Staking — choose how to join</p>
          </div>
          <button type="button" onClick={onDismiss}
            className="text-text-muted hover:text-text-secondary transition-colors p-1"
            title="Back to Home"
          >✕</button>
        </div>

        {/* ── VIEW: choose path ── */}
        {view === 'choose' && (
          <div className="space-y-3">
            {/* Option 1 — I have a referral */}
            <button
              type="button"
              onClick={() => setView('referral')}
              className="w-full text-left p-4 rounded-xl border border-brand-500/30 bg-brand-500/5 hover:bg-brand-500/10 hover:border-brand-500/50 transition-all duration-200 group"
            >
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-display font-semibold text-sm text-brand-400 mb-0.5">
                    I have a referral ID
                  </p>
                  <p className="text-text-muted text-xs">
                    Enter a referral address from an existing member
                  </p>
                </div>
                <span className="text-brand-400 text-lg group-hover:translate-x-0.5 transition-transform">→</span>
              </div>
            </button>

            {/* Divider */}
            <div className="flex items-center gap-3 py-1">
              <div className="flex-1 border-t border-white/10" />
              <span className="text-text-muted text-xs font-display">OR</span>
              <div className="flex-1 border-t border-white/10" />
            </div>

            {/* Option 2 — Already a member */}
            <button
              type="button"
              onClick={onSkip}
              className="w-full text-left p-4 rounded-xl border border-white/10 bg-surface-800/40 hover:border-accent-cyan/30 hover:bg-accent-cyan/5 transition-all duration-200 group"
            >
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-display font-semibold text-sm text-text-primary mb-0.5">
                    I'm already a member
                  </p>
                  <p className="text-text-muted text-xs">
                    Connect directly — no referral required
                  </p>
                </div>
                <span className="text-text-muted text-lg group-hover:translate-x-0.5 transition-transform">→</span>
              </div>
            </button>

            <button type="button" onClick={onDismiss}
              className="w-full text-center text-text-muted hover:text-text-secondary text-xs pt-2 transition-colors">
              ← Back to Home
            </button>
          </div>
        )}

        {/* ── VIEW: referral input ── */}
        {view === 'referral' && (
          <>
            {savedReferral && validate(savedReferral) && (
              <div className="mb-4 px-3 py-2 rounded-lg bg-brand-500/10 border border-brand-500/20 flex items-center gap-2">
                <span className="text-brand-400 text-xs">✓</span>
                <p className="text-brand-400 text-xs">
                  Saved referral auto-filled — you can connect directly
                </p>
              </div>
            )}

            <div className="mb-4">
              <label className="text-xs text-text-muted font-display uppercase tracking-wider mb-2 block">
                {networkLabel} Referral Wallet Address
              </label>
              <input
                type="text"
                value={input}
                onChange={e => { setInput(e.target.value); setError(''); }}
                onKeyDown={e => e.key === 'Enter' && handleSubmit()}
                placeholder={placeholder}
                className="input-field w-full font-mono text-sm"
                autoFocus
                spellCheck={false}
              />
              {error && <p className="text-accent-rose text-xs mt-1.5">{error}</p>}
              {trimmed && !error && (
                <p className={`text-xs mt-1.5 ${valid ? 'text-brand-400' : 'text-accent-amber'}`}>
                  {valid ? `✓ Valid ${networkLabel} address` : `Invalid — must be a ${networkLabel} address`}
                </p>
              )}
            </div>

            <button
              type="button"
              onClick={handleSubmit}
              disabled={!valid}
              className={`w-full py-3 rounded-xl font-display font-bold text-sm transition-all duration-300 ${
                valid ? 'btn-primary' : 'bg-surface-700 text-text-muted cursor-not-allowed'
              }`}
            >
              Connect Wallet
            </button>

            <div className="flex items-center justify-between mt-3">
              <button type="button" onClick={() => setView('choose')}
                className="text-text-muted hover:text-text-secondary text-xs transition-colors">
                ← Back
              </button>
              <button type="button" onClick={onDismiss}
                className="text-text-muted hover:text-text-secondary text-xs transition-colors">
                Cancel
              </button>
            </div>
          </>
        )}

      </div>
    </div>
  );
}

export default function Header() {
  const { connect, disconnect, address, isConnecting, solanaReferrer, setSolanaReferrer } = useWallet();
  const {
    selectedNetwork, activeTab, setActiveTab, isAdmin, walletAddress, walletStates,
    connectGateOpen, setConnectGateOpen,
  } = useAppStore();
  const currentReferrer = solanaReferrer;
  const walletKey = walletAddress ? `${selectedNetwork}:${walletAddress}` : null;
  const referralCount = walletKey
    ? (walletStates[walletKey]?.referralInfo?.totalReferrals ?? walletStates[walletKey]?.userAccount?.referralCount ?? 0)
    : 0;
  const [showWalletMenu, setShowWalletMenu] = useState(false);
  const [showMobileMenu, setShowMobileMenu] = useState(false);

  // Tracks whether the pending connect was the "already a member" (skip-referral) path
  const isDirectConnectRef = useRef(false);

  // Close modals once address is set; if direct-connect, verify on-chain registration
  useEffect(() => {
    if (!address) return;
    setShowWalletMenu(false);

    if (!isDirectConnectRef.current) {
      setConnectGateOpen(false);
      return;
    }
    // "Already a member" path — check on-chain registration
    isDirectConnectRef.current = false;
    // Admin wallet bypasses registration check
    if (isAdmin) {
      setConnectGateOpen(false);
      return;
    }
    const verify = async () => {
      let registered = false;
      try {
        const [{ solanaIsRegistered }, { PublicKey }] = await Promise.all([
          import('@/lib/contracts/solana'),
          import('@solana/web3.js'),
        ]);
        registered = await solanaIsRegistered(new PublicKey(address));
      } catch {}
      if (registered) {
        setConnectGateOpen(false);
      } else {
        disconnect();
        toast.error('You\'re not yet registered. Please enter a referral address to join FBiT Staking.');
        setTimeout(() => setConnectGateOpen(true), 400);
      }
    };
    void verify();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address]);

  const navItems = [
    { id: 'dashboard', label: 'Dashboard', icon: '◈' },
    { id: 'swap',      label: 'Swap',      icon: '⇄' },
    { id: 'liquidity', label: 'Liquidity', icon: '💧' },
    { id: 'stake',     label: 'Stake',     icon: '⬡' },
    { id: 'referral',  label: 'Referral',  icon: '◎' },
    { id: 'calculator', label: 'Calculator', icon: '🧮' },
    { id: 'history',   label: 'History',   icon: '📋' },
    ...(isAdmin ? [{ id: 'admin', label: 'Admin', icon: '⚙' }] : []),
  ];

  const handleConnect = () => {
    setConnectGateOpen(true);
  };

  const handleReferralConfirmed = async (referralAddress: string) => {
    setSolanaReferrer(referralAddress);
    setConnectGateOpen(false);
    try {
      await connect('reown');
    } catch (err: any) {
      toast.error(sanitizeErrorMessage(err));
    }
  };

  // "Already a member" path — connects without referral and verifies on-chain
  const handleConnectDirect = async () => {
    setConnectGateOpen(false);
    isDirectConnectRef.current = true;
    try {
      await connect('reown');
    } catch (err: any) {
      isDirectConnectRef.current = false;
      toast.error(sanitizeErrorMessage(err));
    }
  };

  return (
    <>
    {connectGateOpen && (
      <ReferralGateModal
        savedReferral={currentReferrer ?? undefined}
        onConfirm={handleReferralConfirmed}
        onDismiss={() => setConnectGateOpen(false)}
        onSkip={handleConnectDirect}
      />
    )}
    <header className="sticky top-0 z-50 glass border-b border-white/5">
      <div className="max-w-7xl mx-auto px-4 sm:px-6">
        <div className="flex items-center justify-between h-16 sm:h-20">
          {/* Logo */}
          <Link href="/" className="flex items-center gap-3">
            <div className="relative inline-flex shrink-0">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/logo.png" alt="FBiT logo" className="w-9 h-9 rounded-full object-cover" />
              <span className="absolute -top-0.5 -right-0.5 w-3.5 h-3.5 rounded-full bg-brand-500 border-2 border-surface-900 animate-pulse" />
            </div>
            <div className="hidden sm:block">
              <h1 className="font-display font-bold text-lg leading-tight bg-linear-to-r from-accent-purple to-brand-500 bg-clip-text text-transparent">FutureBit</h1>
              <p className="text-[10px] text-text-secondary font-mono tracking-wider uppercase">Solana Protocol</p>
            </div>
          </Link>

          {/* Desktop Nav — hidden until a wallet is connected */}
          <nav className="hidden md:flex items-center gap-1">
            {address && navItems.map((item) => (
              <button
                type="button"
                key={item.id}
                onClick={() => setActiveTab(item.id)}
                className={`px-4 py-2 rounded-lg font-display text-sm transition-all duration-200 flex items-center gap-2 relative ${
                  activeTab === item.id
                    ? 'bg-brand-500/10 text-brand-400 border border-brand-500/20'
                    : 'text-text-secondary hover:text-text-primary hover:bg-white/5'
                }`}
              >
                <span className="text-xs">{item.icon}</span>
                {item.label}
                {item.id === 'referral' && referralCount > 0 && (
                  <span className="ml-0.5 px-1.5 py-0.5 rounded-full text-[10px] font-bold bg-accent-purple/20 text-accent-purple border border-accent-purple/30 leading-none">
                    {referralCount}
                  </span>
                )}
              </button>
            ))}
          </nav>

          {/* Right side */}
          <div className="flex items-center gap-3">
            {/* Wallet */}
            {address ? (
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setShowWalletMenu(!showWalletMenu)}
                  className="flex items-center gap-2 px-3 sm:px-4 py-2 rounded-xl bg-surface-800 border border-white/10 hover:border-brand-500/30 transition-all"
                >
                  <div className="w-2 h-2 rounded-full bg-brand-500 animate-pulse" />
                  <span className="font-mono text-xs sm:text-sm">{shortenAddress(address)}</span>
                </button>
                {showWalletMenu && (
                  <div className="absolute right-0 top-full mt-2 glass rounded-xl p-2 min-w-45 animate-slide-up">
                    <button
                      type="button"
                      onClick={() => {
                        navigator.clipboard.writeText(address);
                        toast.success('Address copied!');
                        setShowWalletMenu(false);
                      }}
                      className="w-full px-4 py-2.5 text-left text-sm text-text-secondary hover:bg-white/5 rounded-lg transition-colors"
                    >
                      Copy Address
                    </button>
                    <button
                      type="button"
                      onClick={() => { disconnect(); setShowWalletMenu(false); }}
                      className="w-full px-4 py-2.5 text-left text-sm text-accent-rose hover:bg-accent-rose/10 rounded-lg transition-colors"
                    >
                      Disconnect
                    </button>
                  </div>
                )}
              </div>
            ) : (
              <button
                type="button"
                onClick={handleConnect}
                disabled={isConnecting}
                className="btn-primary text-xs sm:text-sm px-4 sm:px-6 py-2 sm:py-2.5"
              >
                {isConnecting ? 'Connecting...' : 'Connect'}
              </button>
            )}

            {/* Back to home — icon only, far right */}
            <Link
              href="/"
              title="Back to Home"
              className="flex items-center justify-center w-9 h-9 rounded-lg text-text-secondary hover:text-brand-400 hover:bg-white/5 transition-colors shrink-0"
            >
              <span className="text-lg leading-none">🏠</span>
            </Link>

            {/* Mobile menu toggle */}
            <button
              type="button"
              title="Toggle menu"
              onClick={() => setShowMobileMenu(!showMobileMenu)}
              className="md:hidden p-2 rounded-lg hover:bg-white/5 transition-colors"
            >
              <div className="w-5 h-4 flex flex-col justify-between">
                <span className={`block h-0.5 bg-text-secondary transition-all ${showMobileMenu ? 'rotate-45 translate-y-1.75' : ''}`} />
                <span className={`block h-0.5 bg-text-secondary transition-all ${showMobileMenu ? 'opacity-0' : ''}`} />
                <span className={`block h-0.5 bg-text-secondary transition-all ${showMobileMenu ? '-rotate-45 -translate-y-1.75' : ''}`} />
              </div>
            </button>
          </div>
        </div>

        {/* Mobile Nav */}
        {showMobileMenu && (
          <nav className="md:hidden pb-4 animate-slide-up">
            <div className="flex flex-col gap-1">
              {address && navItems.map((item) => (
                <button
                  type="button"
                  key={item.id}
                  onClick={() => { setActiveTab(item.id); setShowMobileMenu(false); }}
                  className={`px-4 py-3 rounded-xl font-display text-sm text-left transition-all flex items-center gap-3 ${
                    activeTab === item.id
                      ? 'bg-brand-500/10 text-brand-400 border border-brand-500/20'
                      : 'text-text-secondary hover:text-text-primary hover:bg-white/5'
                  }`}
                >
                  <span>{item.icon}</span>
                  {item.label}
                  {item.id === 'referral' && referralCount > 0 && (
                    <span className="ml-auto px-2 py-0.5 rounded-full text-[10px] font-bold bg-accent-purple/20 text-accent-purple border border-accent-purple/30">
                      {referralCount}
                    </span>
                  )}
                </button>
              ))}
            </div>
          </nav>
        )}
      </div>
    </header>
    </>
  );
}
