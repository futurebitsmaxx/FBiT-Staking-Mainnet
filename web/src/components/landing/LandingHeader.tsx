'use client';

import React, { useEffect, useRef, useState } from 'react';
import Link from 'next/link';

const NAV_LINKS = [
  { href: '#stats',      label: 'Stats' },
  { href: '#exchanges',  label: 'Trade' },
  { href: '#token',      label: 'Token' },
  { href: '#rewards',    label: 'Rewards' },
  { href: '#tokenomics', label: 'Tokenomics' },
  { href: '#security',   label: 'Security' },
  { href: '#roadmap',    label: 'Roadmap' },
  { href: '#features',   label: 'How It Works' },
  { href: '#faq',        label: 'FAQ' },
];

const WHITEPAPER_URL   = 'https://github.com/futurebitsmaxx/FBiT-Staking-Mainnet/blob/main/WHITEPAPER.md';
const BROCHURE_URL     = '/brochure.pdf';
const INCOME_GUIDE_URL = '/referral-income-guide.pdf';
const VISION_URL       = '/vision-community.pdf';
const TOKEN_WP_URL     = '/fbit-token-whitepaper.pdf';
const FBIT_MINT        = '5uJ8rkiqEs5uzERCqVw9a1eC6BkP54MZAF3D229dyoME';
const VERIFY_URL       = `https://solscan.io/token/${FBIT_MINT}`;

// Secondary/utility links — consolidated into a single "Resources" dropdown
// instead of sitting inline in the header, which got cluttered as more of
// these were added over time.
const RESOURCE_LINKS = [
  { href: '/trust',         label: 'Trust',           icon: '✅', external: false, accent: false },
  { href: VERIFY_URL,       label: 'Verify Token',    icon: '🛡', external: true,  accent: true },
  { href: '/guide',         label: 'Guide',           icon: '📖', external: false, accent: false },
  { href: INCOME_GUIDE_URL, label: 'Income Guide',    icon: '💰', external: true,  accent: false, download: true },
  { href: WHITEPAPER_URL,   label: 'Staking Whitepaper', icon: '📄', external: true,  accent: false },
  { href: TOKEN_WP_URL,     label: 'Token Whitepaper', icon: '🪙', external: true,  accent: false, download: true },
  { href: BROCHURE_URL,     label: 'Brochure',        icon: '📑', external: true,  accent: false, download: true },
  { href: VISION_URL,       label: 'Vision & Community', icon: '🌱', external: true, accent: false, download: true },
];

function ResourcesDropdown() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClickOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, [open]);

  return (
    <div ref={ref} className="relative hidden xl:block">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 text-sm font-display text-text-secondary hover:text-text-primary hover:bg-white/5 rounded-lg px-3 py-2 transition-all"
      >
        Resources
        <span className={`text-[10px] transition-transform duration-200 ${open ? 'rotate-180' : ''}`}>▾</span>
      </button>

      {/* Always rendered (not conditionally mounted) so these links exist in the
          server-rendered HTML for crawlers even before any click — only visibility
          is toggled by `open`. A conditionally-*mounted* menu (`{open && <div>}`)
          means the <a> tags never appear in the DOM at all until a user interacts,
          which search crawlers don't simulate — they'd never discover /trust or
          /guide through this menu, only via whatever's already in the sitemap. */}
      <div
        className={`absolute right-0 top-full mt-2 w-52 glass-card p-1.5 transition-all duration-150 ${
          open ? 'opacity-100 visible' : 'opacity-0 invisible pointer-events-none'
        }`}
      >
        {RESOURCE_LINKS.map((item) => (
            <a
              key={item.label}
              href={item.href}
              target={item.external ? '_blank' : undefined}
              rel={item.external ? 'noopener noreferrer' : undefined}
              download={item.download}
              onClick={() => setOpen(false)}
              className={`flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-sm font-display transition-all ${
                item.accent
                  ? 'text-[#9945FF] hover:bg-[#9945FF]/10 hover:text-[#14F195]'
                  : 'text-text-secondary hover:text-text-primary hover:bg-white/5'
              }`}
            >
              <span>{item.icon}</span> {item.label}
            </a>
          ))}
        </div>
    </div>
  );
}

export default function LandingHeader() {
  const [showMobileMenu, setShowMobileMenu] = useState(false);

  return (
    <header
      className="sticky top-0 z-50 border-b border-white/5"
      style={{ background: 'rgba(5, 5, 5, 0.75)', backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)' }}
    >
      <div className="max-w-7xl mx-auto px-4 sm:px-6">
        <div className="flex items-center justify-between h-16 sm:h-20">
          {/* Logo — links home from any page that reuses this header (e.g. /guide) */}
          <Link href="/" className="flex items-center gap-3">
            <div className="relative inline-flex shrink-0">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/logo.png" alt="FBiT logo" className="w-9 h-9 rounded-full object-cover" />
              <span className="absolute -top-0.5 -right-0.5 w-3.5 h-3.5 rounded-full bg-brand-500 border-2 border-surface-900 animate-pulse" />
            </div>
            <div className="hidden sm:block">
              <h1 className="font-display font-bold text-lg leading-tight">FutureBit</h1>
              <p className="text-[10px] text-text-secondary font-mono tracking-wider uppercase">Solana Protocol</p>
            </div>
          </Link>

          {/* Desktop Nav — full row only at xl; below that everything moves into the
              hamburger menu, so the Resources dropdown can't overflow. */}
          <nav className="hidden xl:flex items-center gap-0.5">
            {NAV_LINKS.map((item) => (
              <a
                key={item.href}
                href={item.href}
                className="px-3 py-2 rounded-lg font-display text-sm text-text-secondary hover:text-text-primary hover:bg-white/5 transition-all duration-200"
              >
                {item.label}
              </a>
            ))}
          </nav>

          {/* Right side */}
          <div className="flex items-center gap-2">
            <Link
              href="/launch"
              className="hidden lg:inline-flex items-center gap-1.5 text-xs font-display font-bold uppercase tracking-wider px-3 py-1.5 rounded-full bg-brand-500/15 text-brand-400 border border-brand-500/30 hover:bg-brand-500/25 transition-all"
            >
              🎉 We're Live
            </Link>
            <ResourcesDropdown />
            <Link href="/app" className="btn-primary text-xs sm:text-sm px-4 sm:px-6 py-2 sm:py-2.5">
              Launch App
            </Link>

            {/* Menu toggle — covers everything below xl */}
            <button
              type="button"
              title="Toggle menu"
              onClick={() => setShowMobileMenu(!showMobileMenu)}
              className="xl:hidden p-2 rounded-lg hover:bg-white/5 transition-colors"
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
          <nav className="xl:hidden pb-4 animate-slide-up">
            <div className="flex flex-col gap-1">
              <Link
                href="/launch"
                onClick={() => setShowMobileMenu(false)}
                className="px-4 py-3 rounded-xl font-display font-bold text-sm text-brand-400 bg-brand-500/10 hover:bg-brand-500/15 transition-all flex items-center gap-2 mb-1"
              >
                🎉 We're Live
              </Link>
              {NAV_LINKS.map((item) => (
                <a
                  key={item.href}
                  href={item.href}
                  onClick={() => setShowMobileMenu(false)}
                  className="px-4 py-3 rounded-xl font-display text-sm text-text-secondary hover:text-text-primary hover:bg-white/5 transition-all"
                >
                  {item.label}
                </a>
              ))}
              <div className="my-2 border-t border-white/10" />
              {RESOURCE_LINKS.map((item) => (
                <a
                  key={item.label}
                  href={item.href}
                  target={item.external ? '_blank' : undefined}
                  rel={item.external ? 'noopener noreferrer' : undefined}
                  download={item.download}
                  onClick={() => setShowMobileMenu(false)}
                  className={`px-4 py-3 rounded-xl font-display text-sm transition-all flex items-center gap-2 ${
                    item.accent
                      ? 'text-[#9945FF] hover:bg-[#9945FF]/10'
                      : 'text-text-secondary hover:text-text-primary hover:bg-white/5'
                  }`}
                >
                  <span>{item.icon}</span> {item.label}
                </a>
              ))}
            </div>
          </nav>
        )}
      </div>
    </header>
  );
}
