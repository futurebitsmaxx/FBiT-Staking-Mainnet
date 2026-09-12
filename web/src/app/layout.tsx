import '@/styles/globals.css';
import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import Script from 'next/script';
import ExtensionErrorSuppressor from '@/components/ExtensionErrorSuppressor';
import DataMigration from '@/components/DataMigration';
import { warnMissingEnv } from '@/lib/security';
import AdsManager from '@/components/ads/AdsManager';
import SupportChat from '@/components/chat/SupportChat';

warnMissingEnv();

const BASE_URL = 'https://futurebit.in';

// ── Google Analytics 4 — replace G-XXXXXXXXXX with your real Measurement ID ──
const GA_ID = 'G-3B36D0CW8F';

// ── Schema.org structured data ────────────────────────────────────────────────
const structuredData = {
  '@context': 'https://schema.org',
  '@graph': [
    {
      '@type': 'Organization',
      '@id': `${BASE_URL}/#organization`,
      name: 'FutureBit Staking',
      alternateName: ['FBiT Staking', 'FBiT'],
      url: BASE_URL,
      description: 'FutureBit Staking (FBiT) is an independent Solana DeFi staking protocol at futurebit.in.',
      disambiguatingDescription:
        'Not affiliated with FutureBit LLC, the maker of Apollo Bitcoin mining hardware. FutureBit Staking is a separate, unrelated Solana blockchain staking project that shares a similar name by coincidence only.',
      knowsAbout: ['Solana', 'DeFi staking', 'Cryptocurrency', 'Blockchain'],
      logo: {
        '@type': 'ImageObject',
        url: `${BASE_URL}/favicon.svg`,
      },
      sameAs: [
        'https://x.com/FUTURBIT',
        'https://t.me/FutureBit_Community',
        'https://github.com/futurebitsmaxx/FBiT-Staking-Mainnet',
      ],
    },
    {
      '@type': 'WebSite',
      '@id': `${BASE_URL}/#website`,
      url: BASE_URL,
      name: 'FutureBit Staking',
      alternateName: 'FBiT Staking',
      description: 'FBiT token staking platform on Solana',
      publisher: { '@id': `${BASE_URL}/#organization` },
    },
    {
      '@type': 'WebApplication',
      '@id': `${BASE_URL}/#app`,
      name: 'FutureBit Staking Platform',
      url: BASE_URL,
      applicationCategory: 'FinanceApplication',
      operatingSystem: 'Web Browser',
      description:
        'Stake FBiT tokens on Solana. Earn dynamic PoS APY (up to 300%, adjusts automatically with total staked) with 10-level referral commissions. Non-custodial, no KYC.',
      offers: {
        '@type': 'Offer',
        description: 'Stake FBiT and earn dynamic APY up to 300%',
        price: '0',
        priceCurrency: 'USD',
      },
      featureList: [
        'Dynamic PoS APY (up to 300%)',
        '10-Level Referral System',
        '5% Burn Mechanism',
        'Team Target Bonuses',
        'Built on Solana',
        'Non-Custodial',
        'No KYC Required',
      ],
    },
    {
      '@type': 'FAQPage',
      mainEntity: [
        {
          '@type': 'Question',
          name: 'What is FBiT token?',
          acceptedAnswer: {
            '@type': 'Answer',
            text: 'FBiT is the native utility token of the FutureBit staking platform. It is a Solana SPL token used for staking to earn dynamic Proof-of-Stake rewards.',
          },
        },
        {
          '@type': 'Question',
          name: 'How much APY can I earn staking FBiT?',
          acceptedAnswer: {
            '@type': 'Answer',
            text: 'FBiT staking offers a dynamic APY of up to 300% that adjusts automatically based on total tokens staked — when fewer tokens are staked, APY increases, and vice versa, down to a 10% floor. Check the Live Stats section on the home page for the current rate.',
          },
        },
        {
          '@type': 'Question',
          name: 'Which blockchain does FutureBit Staking run on?',
          acceptedAnswer: {
            '@type': 'Answer',
            text: 'FutureBit Staking runs on Solana Mainnet — stake FBiT tokens using Phantom, Solflare, or any Solana wallet.',
          },
        },
        {
          '@type': 'Question',
          name: 'What is the referral commission in FBiT staking?',
          acceptedAnswer: {
            '@type': 'Answer',
            text: 'FutureBit Staking has two referral layers, both paid automatically on-chain. A one-time 10-level commission (up to 17.75% total) pays out the moment your referral first stakes: Level 1: 0.25%, Level 2: 0.5%, Level 3: 1.25%, up to Level 10: 3%. A separate recurring commission (up to 10% total, levels 1-5 only) pays out again every time your referral claims or compounds: Level 1: 3%, Level 2: 2.5%, Level 3: 2%, Level 4: 1.5%, Level 5: 1%.',
          },
        },
        {
          '@type': 'Question',
          name: 'Is FBiT staking safe?',
          acceptedAnswer: {
            '@type': 'Answer',
            text: 'FutureBit Staking is non-custodial — your tokens never leave your wallet. The smart contracts are open-source and verifiable on Solana Explorer. No KYC or personal data is required.',
          },
        },
        {
          '@type': 'Question',
          name: 'Is FutureBit Staking the same company as FutureBit (Apollo Bitcoin miners)?',
          acceptedAnswer: {
            '@type': 'Answer',
            text: 'No. FutureBit Staking (ticker FBiT) at futurebit.in is an independent Solana DeFi staking protocol and is not affiliated with FutureBit LLC, the maker of Apollo Bitcoin mining hardware. The two are separate, unrelated projects that happen to share a similar name.',
          },
        },
        {
          '@type': 'Question',
          name: 'What makes FutureBit Staking unique?',
          acceptedAnswer: {
            '@type': 'Answer',
            text: "Both the FBiT mint authority and the platform's admin authority are permanently renounced on-chain — no team backdoor, everything independently verifiable. On top of that, FBiT pays referral income on two separate layers (a one-time 10-level bonus, plus a recurring commission on every claim/compound to active referrers) and uses a fully dynamic APY that auto-adjusts with total staked to stay sustainable.",
          },
        },
        {
          '@type': 'Question',
          name: 'What is the history of FutureBit Staking?',
          acceptedAnswer: {
            '@type': 'Answer',
            text: "The smart contract launched on Solana Mainnet on May 7, 2026. On August 5, 2026, the project completed a Consolidation and Security phase — migrating to a fixed-supply v2 token, locking or burning 100% of liquidity, completing an independent security review, and permanently renouncing platform ownership. It's now in its Market Expansion phase.",
          },
        },
        {
          '@type': 'Question',
          name: 'What can FBiT be used for?',
          acceptedAnswer: {
            '@type': 'Answer',
            text: 'FBiT can be staked for dynamic PoS rewards, used to earn two-layer referral income and Team Target Bonuses, deposited as single-sided SOL liquidity to earn trading fees, or simply held and traded on Solana DEXs — with a governance role planned as the protocol matures.',
          },
        },
      ],
    },
  ],
};

export const metadata: Metadata = {
  metadataBase: new URL(BASE_URL),

  // Site-wide default canonical — critical because referral links append
  // `?ref=<wallet>` to the homepage URL (see generateReferralLink in utils.ts).
  // Without this, Google sees every shared referral link as a distinct URL for
  // the same content, which is a common cause of "Discovered/Crawled - currently
  // not indexed" in Search Console. Each page below overrides this with its own
  // clean canonical; this is just the fallback for anything that doesn't.
  alternates: { canonical: '/' },

  title: {
    default: 'FutureBit Staking (FBiT) — Earn Dynamic APY on Solana',
    template: '%s | FutureBit Staking',
  },
  description:
    'Stake FBiT tokens on Solana. Earn dynamic Proof-of-Stake APY up to 300%, build a 10-level referral network, and get Team Target Bonuses. Non-custodial, open-source, no KYC.',

  // Note: Google itself ignores this tag entirely for ranking (has since ~2009)
  // — real ranking signal comes from title tags, on-page content/headings, and
  // backlinks, not this list. Kept clean and relevant anyway since a few smaller
  // engines still weight it lightly, and duplicate/near-duplicate entries only
  // waste that little signal there is.
  keywords: [
    // Brand
    'FutureBit Staking', 'FBiT staking', 'FBiT token', 'stake FBiT',
    // Category / high-intent
    'Solana staking platform', 'Solana DeFi staking', 'crypto staking platform',
    'non-custodial staking', 'stake and earn crypto', 'passive crypto income',
    'best Solana staking platform', 'high APY staking',
    // Feature-specific long-tail
    'dynamic APY staking Solana', '10 level referral crypto', 'crypto referral program',
    'deflationary token burn staking', 'no KYC crypto staking',
    // Geo
    'crypto passive income India', 'Solana staking India',
  ],

  authors: [{ name: 'FutureBit Staking', url: BASE_URL }],
  creator: 'FutureBit Staking',
  publisher: 'FutureBit Staking',

  openGraph: {
    type: 'website',
    url: BASE_URL,
    siteName: 'FutureBit Staking',
    title: 'FutureBit Staking (FBiT) — Earn Dynamic APY on Solana',
    description:
      'Stake FBiT on Solana. Dynamic APY up to 300%, 10-level referrals, deflationary burn. Non-custodial & open-source.',
    images: [
      {
        url: `${BASE_URL}/opengraph-image`,
        width: 1200,
        height: 630,
        alt: 'FutureBit Staking — Solana DeFi Platform',
      },
    ],
    locale: 'en_US',
  },

  twitter: {
    card: 'summary_large_image',
    site: '@FUTURBIT',
    creator: '@FUTURBIT',
    title: 'FutureBit Staking (FBiT) — Earn Dynamic APY on Solana',
    description:
      'Stake FBiT on Solana. Dynamic APY up to 300%, 10-level referrals, deflationary burn.',
    images: [`${BASE_URL}/opengraph-image`],
  },

  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      'max-snippet': -1,
      'max-image-preview': 'large',
      'max-video-preview': -1,
    },
  },

  icons: {
    icon: '/favicon.svg',
    shortcut: '/favicon.svg',
    apple: '/favicon.svg',
  },

  verification: {
    google: [
      'BxzT8iTO3x-tAefZfNaA4H9Z0JC8edGS61YFWRw4ca4',
      '9luXnlk5ESpDm2a3zgJGB5URsqbPkzQIkysnpSzq49g',
    ],
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
};

const suppressExtensionErrors = `(function(){
  function isExt(s){return s&&(s.includes('chrome-extension://')||s.includes('moz-extension://'));}
  var MSGS=['Origin not allowed','Extension context invalidated'];
  function isExtErr(r){if(!r)return false;var s=r.stack||'';var m=r.message||String(r);return isExt(s)||MSGS.some(function(x){return m.includes(x);});}
  window.addEventListener('unhandledrejection',function(e){if(isExtErr(e.reason)){e.preventDefault();e.stopImmediatePropagation();}},true);
  window.addEventListener('error',function(e){if(isExt(e.filename||'')||isExtErr(e.error)){e.preventDefault();e.stopImmediatePropagation();}},true);
  var _ce=console.error.bind(console);
  console.error=function(){var a=Array.prototype.slice.call(arguments).map(function(x){return typeof x==='string'?x:(x&&(x.stack||x.message))||String(x);}).join(' ');if(isExt(a)||MSGS.some(function(m){return a.includes(m);}))return;_ce.apply(console,arguments);};
})();`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        {/* Fonts as <link> tags (not a CSS @import) so the browser can fetch
            them in parallel with the main stylesheet instead of waiting to
            parse it first — see the comment in globals.css. */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700;800&family=DM+Sans:ital,wght@0,400;0,500;0,700;1,400&family=JetBrains+Mono:wght@400;500;600&display=swap"
        />

        <script dangerouslySetInnerHTML={{ __html: suppressExtensionErrors }} />

        {/* Schema.org Structured Data */}
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData) }}
        />
      </head>
      <body className="antialiased">

        {/* Google Analytics 4 */}
        <Script
          src={`https://www.googletagmanager.com/gtag/js?id=${GA_ID}`}
          strategy="afterInteractive"
        />
        <Script id="ga4-init" strategy="afterInteractive">
          {`
            window.dataLayer = window.dataLayer || [];
            function gtag(){dataLayer.push(arguments);}
            gtag('js', new Date());
            gtag('config', '${GA_ID}', {
              page_path: window.location.pathname,
              anonymize_ip: true
            });
          `}
        </Script>

        <AdsManager />
        <ExtensionErrorSuppressor />
        <DataMigration />
        <div className="bg-mesh fixed inset-0" />
        <div className="grid-pattern fixed inset-0" />
        <div className="relative z-10 min-h-screen">
          {children}
        </div>
        <SupportChat />
      </body>
    </html>
  );
}
