import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'About FutureBit Staking (FBiT)',
  description: 'FutureBit Staking (FBiT) is an independent Solana DeFi staking protocol at futurebit.in — not affiliated with FutureBit LLC, the maker of Apollo Bitcoin mining hardware.',
  keywords: ['what is FutureBit Staking', 'FutureBit Staking FBiT', 'FBiT token about', 'FutureBit Staking vs FutureBit LLC'],
  alternates: { canonical: '/about/' },
};

export default function AboutPage() {
  return (
    <div className="min-h-screen" style={{ background: 'var(--surface-dark)', color: 'var(--text-primary)' }}>
      {/* Header */}
      <header style={{ borderBottom: '1px solid rgba(255,255,255,0.06)', padding: '16px 24px' }}>
        <div style={{ maxWidth: 900, margin: '0 auto', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <Link href="/" style={{ display: 'flex', alignItems: 'center', gap: 10, textDecoration: 'none' }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/logo.png" alt="FBiT logo" style={{ width: 36, height: 36, borderRadius: 10, objectFit: 'cover' }} />
            <span style={{ fontWeight: 700, fontSize: 18, color: '#f1f5f9' }}>FBiT Staking</span>
          </Link>
          <Link href="/app" style={{
            padding: '8px 20px', borderRadius: 8,
            background: 'rgba(0,230,118,0.1)', border: '1px solid rgba(0,230,118,0.2)',
            color: '#00E676', textDecoration: 'none', fontSize: 14, fontWeight: 500,
          }}>
            Launch App
          </Link>
        </div>
      </header>

      {/* Content */}
      <main style={{ maxWidth: 860, margin: '0 auto', padding: '60px 24px' }}>
        <h1 style={{ fontSize: 42, fontWeight: 800, marginBottom: 12, background: 'linear-gradient(135deg,#fff,#94a3b8)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
          About FutureBit Staking
        </h1>
        <p style={{ color: '#00E676', fontSize: 15, marginBottom: 24, fontWeight: 500 }}>
          Solana DeFi Staking Platform
        </p>
        <p style={{ color: 'var(--text-secondary)', fontSize: 14, lineHeight: 1.7, marginBottom: 48, padding: '14px 18px', borderRadius: 10, border: '1px solid rgba(255,255,255,0.08)', background: 'rgba(255,255,255,0.03)' }}>
          <b style={{ color: '#f1f5f9' }}>Not affiliated with FutureBit LLC.</b> FutureBit Staking (ticker FBiT) at futurebit.in is an independent
          Solana DeFi protocol. It is a separate, unrelated project from FutureBit LLC, the maker of Apollo Bitcoin
          mining hardware — the two share a similar name by coincidence only.
        </p>

        <Section title="Who We Are">
          FutureBit Staking is a decentralized finance project built to bring transparent, high-yield staking to everyday crypto users.
          We launched the FBiT token on Solana — a fast, low-fee blockchain.
          Our mission is to make passive crypto income accessible without KYC, without custodians, and without complexity.
        </Section>

        <Section title="What We Do">
          FBiT Staking is a non-custodial staking platform where users lock FBiT on Solana to earn dynamic
          Proof-of-Stake rewards. The smart contract runs fully on-chain — we never hold your tokens. Every stake, unstake, and reward
          claim is a verifiable blockchain transaction.
        </Section>

        <Section title="What Makes Us Unique">
          Most staking platforms ask you to trust the team. We built FutureBit Staking so belief is unnecessary — every claim we
          make is something you can verify yourself, on-chain, in seconds. Both the FBiT mint authority and the platform&apos;s
          admin authority are permanently renounced — no team backdoor, no ability to change the rules later. On top of that
          transparency, FBiT pays referral commissions on two separate layers (a one-time bonus across 10 levels when someone
          first stakes, plus a recurring commission on every claim or compound to active referrers, levels 1-5) — real, ongoing
          passive income for people who genuinely grow the community, not just a one-time payout. APY is fully dynamic, automatically
          adjusting with total staked, so rewards stay sustainable instead of promising a fixed number the protocol can&apos;t back.
        </Section>

        <Section title="Our History">
          FutureBit Staking&apos;s smart contract launched on Solana Mainnet on <b style={{ color: '#f1f5f9' }}>May 7, 2026</b>,
          going live with dynamic Proof-of-Stake staking, a 10-level referral system, Team Target Bonuses, and a deflationary burn
          mechanism from day one. On <b style={{ color: '#f1f5f9' }}>August 5, 2026</b>, the project completed a deliberate
          Consolidation and Security phase: FBiT was migrated to a fixed-supply v2 token of 250,000,000, with mint authority
          permanently renounced, 100% of protocol liquidity locked or burned, and an independent smart-contract security review
          completed — identifying and fixing critical issues before they could be exploited. Platform ownership was also
          permanently renounced on-chain shortly after. The project is now in its Market Expansion phase, growing DEX liquidity,
          community, and data-provider visibility. Every date and claim here is independently verifiable on-chain.
        </Section>

        <Section title="Our Technology">
          <ul style={{ paddingLeft: 20, lineHeight: 2, color: 'var(--text-secondary)' }}>
            <li><b style={{ color: '#f1f5f9' }}>Solana Smart Contract</b> — written in Rust using the Anchor framework. Deployed on Solana Mainnet.</li>
            <li><b style={{ color: '#f1f5f9' }}>10-Level Referral System</b> — on-chain referral commissions auto-distributed to up to 10 levels of referrers on every new stake, plus a separate recurring commission to levels 1-5 on every claim/compound.</li>
            <li><b style={{ color: '#f1f5f9' }}>Dynamic APY</b> — reward rate adjusts automatically based on total tokens staked (up to 300%).</li>
            <li><b style={{ color: '#f1f5f9' }}>5% Burn Mechanism</b> — a portion of every claim/compound reward is burned to reduce supply and increase token value over time.</li>
          </ul>
        </Section>

        <Section title="FBiT Token">
          <ul style={{ paddingLeft: 20, lineHeight: 2, color: 'var(--text-secondary)' }}>
            <li><b style={{ color: '#f1f5f9' }}>Name:</b> Future Bit Token</li>
            <li><b style={{ color: '#f1f5f9' }}>Symbol:</b> FBiT</li>
            <li><b style={{ color: '#f1f5f9' }}>Network:</b> Solana (SPL Token)</li>
            <li><b style={{ color: '#f1f5f9' }}>Solana Mint:</b> 5uJ8rkiqEs5uzERCqVw9a1eC6BkP54MZAF3D229dyoME</li>
          </ul>
        </Section>

        <Section title="What FBiT Can Be Used For">
          <ul style={{ paddingLeft: 20, lineHeight: 2, color: 'var(--text-secondary)' }}>
            <li><b style={{ color: '#f1f5f9' }}>Staking</b> — lock FBiT to earn dynamic Proof-of-Stake rewards (10%-300% APY), funded by a dedicated emission reserve rather than new buyers&apos; capital.</li>
            <li><b style={{ color: '#f1f5f9' }}>Referral income</b> — earn on two separate layers: a one-time 10-level commission when someone first stakes, plus a recurring commission on every claim/compound from active referrals (levels 1-5).</li>
            <li><b style={{ color: '#f1f5f9' }}>Team Target Bonuses</b> — extra APY based on your entire downline network&apos;s combined stake, not just direct referrals.</li>
            <li><b style={{ color: '#f1f5f9' }}>Liquidity provision</b> — deposit single-sided SOL into the live FBiT/SOL pool and earn real trading fees, no FBiT needed upfront.</li>
            <li><b style={{ color: '#f1f5f9' }}>Open market trading</b> — FBiT trades freely on Solana DEXs, no permission or lock-up required just to hold or exchange it.</li>
            <li><b style={{ color: '#f1f5f9' }}>Future governance</b> — as the protocol matures, FBiT is planned to gain a governance role for active holders.</li>
          </ul>
        </Section>

        <Section title="Our Vision">
          We believe decentralized finance should be simple, fair, and open. FutureBit Staking is building a community-powered ecosystem where
          everyone — from first-time investors to experienced DeFi users — can earn real rewards by participating in the network.
          The 10-level referral system means that as you grow your network, you earn more — creating a sustainable, viral growth model.
        </Section>

        <Section title="Contact & Community">
          <ul style={{ paddingLeft: 20, lineHeight: 2, color: 'var(--text-secondary)' }}>
            <li><b style={{ color: '#f1f5f9' }}>Website:</b> <a href="https://futurebit.in" style={{ color: '#00E676' }}>futurebit.in</a></li>
            <li><b style={{ color: '#f1f5f9' }}>Twitter/X:</b> <a href="https://x.com/FUTURBIT" style={{ color: '#00E676' }}>@FUTURBIT</a></li>
            <li><b style={{ color: '#f1f5f9' }}>Telegram:</b> <a href="https://t.me/FutureBit_Community" style={{ color: '#00E676' }}>t.me/FutureBit_Community</a></li>
            <li><b style={{ color: '#f1f5f9' }}>GitHub:</b> <a href="https://github.com/futurebitsmaxx/FBiT-Staking-Mainnet" style={{ color: '#00E676' }}>FBiT-Staking-Mainnet</a></li>
          </ul>
        </Section>

        {/* Footer links */}
        <div style={{ marginTop: 64, paddingTop: 32, borderTop: '1px solid rgba(255,255,255,0.06)', display: 'flex', gap: 24, flexWrap: 'wrap' }}>
          <Link href="/terms" style={{ color: '#64748b', textDecoration: 'none', fontSize: 14 }}>Terms & Conditions</Link>
          <Link href="/privacy" style={{ color: '#64748b', textDecoration: 'none', fontSize: 14 }}>Privacy Policy</Link>
          <Link href="/app" style={{ color: '#64748b', textDecoration: 'none', fontSize: 14 }}>Launch App</Link>
        </div>
      </main>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 44 }}>
      <h2 style={{ fontSize: 22, fontWeight: 700, color: '#f1f5f9', marginBottom: 14, display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ width: 4, height: 22, background: '#00E676', borderRadius: 2, display: 'inline-block' }} />
        {title}
      </h2>
      <div style={{ fontSize: 15, lineHeight: 1.85, color: 'var(--text-secondary)' }}>{children}</div>
    </div>
  );
}
