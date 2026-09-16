import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // 'export' removed — API routes (bot-assess + future server functions) require
  // a Node.js runtime. Vercel handles hybrid static+serverless natively.
  trailingSlash: true,
  images: { unoptimized: true },

  turbopack: {
    root: __dirname,
  },

  devIndicators: {
    position: 'bottom-right',
  },

  // Clickjacking / MIME-sniffing protection — important for a wallet-connect dApp,
  // where framing the page invisibly could trick a user into approving a malicious
  // transaction.
  //
  // CSP is shipped as Content-Security-Policy-**Report-Only** deliberately, not
  // enforced: Reown AppKit's wallet modal (WalletConnect relay/verify), Jupiter,
  // Solana RPC, and GeckoTerminal's embedded widget all load cross-origin
  // resources that are easy to get subtly wrong. Report-Only mode blocks
  // NOTHING — it only logs would-be violations to the browser console — so
  // this is zero-risk to ship. Watch the console across the app (connect
  // wallet, stake, swap, view the price widget) for a few days; once no
  // unexpected violations show up, flip the header key below to the enforcing
  // `Content-Security-Policy` and remove this comment.
  async headers() {
    const csp = [
      "default-src 'self'",
      // 'unsafe-eval'/'wasm-unsafe-eval': required by @solana/web3.js and wallet
      // adapter WASM; 'unsafe-inline': Next.js inline bootstrap scripts.
      "script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' https://www.googletagmanager.com https://www.google-analytics.com",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' data: https://fonts.gstatic.com",
      // Broad https: for images — IPFS-hosted token logos come from many
      // rotating gateway hosts with no practical fixed list.
      "img-src 'self' data: blob: https:",
      "connect-src 'self' https://api.mainnet-beta.solana.com https://mainnet.helius-rpc.com https://*.helius-rpc.com https://lite-api.jup.ag https://api.geckoterminal.com https://api.dexscreener.com https://www.google-analytics.com https://analytics.google.com https://stats.g.doubleclick.net wss://relay.walletconnect.com https://relay.walletconnect.com https://pulse.walletconnect.org https://api.web3modal.org https://explorer-api.walletconnect.com https://verify.walletconnect.com https://*.walletconnect.com https://*.walletconnect.org",
      "frame-src 'self' https://www.geckoterminal.com https://verify.walletconnect.com https://verify.walletconnect.org",
      "frame-ancestors 'none'",
      "object-src 'none'",
      "base-uri 'self'",
    ].join('; ');

    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
          { key: 'Content-Security-Policy-Report-Only', value: csp },
        ],
      },
    ];
  },

  // Keep webpack config for `next build --webpack` and dev fallback
  webpack: (config) => {
    config.resolve.fallback = {
      fs: false,
      os: false,
      path: false,
      crypto: false,
      net: false,
      tls: false,
      stream: false,
      http: false,
      https: false,
      zlib: false,
    };
    return config;
  },
};

export default nextConfig;
