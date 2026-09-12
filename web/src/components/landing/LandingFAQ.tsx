'use client';

import React, { useState } from 'react';
import Reveal from './Reveal';

// Keep this copy in sync with the FAQPage structured data in web/src/app/layout.tsx —
// same questions, same answers, so the visible page and the SEO schema agree.
const FAQS = [
  {
    q: 'What is FBiT token?',
    a: 'FBiT is the native utility token of the FutureBit staking platform. It is a Solana SPL token used for staking to earn dynamic Proof-of-Stake rewards.',
  },
  {
    q: 'How much APY can I earn staking FBiT?',
    a: 'FBiT staking offers a dynamic APY — up to 300% — that adjusts automatically based on total tokens staked. When fewer tokens are staked, APY increases; as more is staked, it decreases toward a 10% floor. Check the Live Stats section above for the current rate.',
  },
  {
    q: 'Which blockchain does FBiT Staking run on?',
    a: 'FBiT Staking runs on Solana Mainnet — stake FBiT using Phantom, Solflare, or any Solana wallet.',
  },
  {
    q: 'What is the referral commission in FBiT staking?',
    a: 'FBiT Staking has two referral layers, both paid automatically on-chain. A one-time 10-level commission (up to 17.75% total) pays out the moment your referral first stakes: Level 1: 0.25%, Level 2: 0.5%, Level 3: 1.25%, up to Level 10: 3%. A separate recurring commission (up to 10% total, levels 1-5 only) pays out again every time your referral claims or compounds — Level 1: 3%, Level 2: 2.5%, Level 3: 2%, Level 4: 1.5%, Level 5: 1%.',
  },
  {
    q: 'Is FBiT staking safe?',
    a: 'FBiT Staking is non-custodial — your tokens never leave your wallet. The smart contracts are open-source and verifiable on Solana Explorer. No KYC or personal data is required.',
  },
  {
    q: 'Is FutureBit Staking the same company as FutureBit (Apollo Bitcoin miners)?',
    a: 'No. FutureBit Staking (ticker FBiT) at futurebit.in is an independent Solana DeFi staking protocol and is not affiliated with FutureBit LLC, the maker of Apollo Bitcoin mining hardware. The two are separate, unrelated projects that happen to share a similar name.',
  },
  {
    q: 'What makes FutureBit Staking unique?',
    a: "Both the FBiT mint authority and the platform's admin authority are permanently renounced on-chain — no team backdoor, everything independently verifiable. On top of that, FBiT pays referral income on two separate layers (a one-time 10-level bonus, plus a recurring commission on every claim/compound to active referrers) and uses a fully dynamic APY that auto-adjusts with total staked to stay sustainable.",
  },
  {
    q: 'What is the history of FutureBit Staking?',
    a: "The smart contract launched on Solana Mainnet on May 7, 2026. On August 5, 2026, the project completed a Consolidation and Security phase — migrating to a fixed-supply v2 token, locking or burning 100% of liquidity, completing an independent security review, and permanently renouncing platform ownership. It's now in its Market Expansion phase.",
  },
  {
    q: 'What can FBiT be used for?',
    a: 'FBiT can be staked for dynamic PoS rewards, used to earn two-layer referral income and Team Target Bonuses, deposited as single-sided SOL liquidity to earn trading fees, or simply held and traded on Solana DEXs — with a governance role planned as the protocol matures.',
  },
];

export default function LandingFAQ() {
  const [openIndex, setOpenIndex] = useState<number | null>(0);

  return (
    <section id="faq" className="max-w-3xl mx-auto px-4 sm:px-6 py-12 sm:py-16">
      <Reveal>
        <div className="text-center mb-8">
          <h2 className="gradient-text font-display font-extrabold text-3xl sm:text-4xl mb-2">Frequently Asked Questions</h2>
        </div>
      </Reveal>

      <div className="space-y-3">
        {FAQS.map((item, i) => {
          const isOpen = openIndex === i;
          return (
            <Reveal key={item.q} delay={i * 60}>
              <div className="glass-card p-0 overflow-hidden">
                <button
                  type="button"
                  onClick={() => setOpenIndex(isOpen ? null : i)}
                  className="w-full flex items-center justify-between gap-4 px-5 py-4 text-left"
                >
                  <span className="font-display font-bold text-base sm:text-lg">{item.q}</span>
                  <span className={`text-brand-400 text-lg shrink-0 transition-transform duration-200 ${isOpen ? 'rotate-45' : ''}`}>
                    +
                  </span>
                </button>
                {isOpen && (
                  <div className="px-5 pb-4 animate-fade-in">
                    <p className="text-text-muted text-sm leading-relaxed">{item.a}</p>
                  </div>
                )}
              </div>
            </Reveal>
          );
        })}
      </div>
    </section>
  );
}
