/**
 * Multi-layer security utilities for FBiT Staking.
 *
 * Layers:
 *  1. Rate limiting     — burst-spam prevention per action key
 *  2. Input sanitization — XSS / injection stripping
 *  3. Address validation — strict format checks (Solana)
 *  4. Amount validation  — NaN, negative, overflow, precision guards
 *  5. Error sanitization — never leak internal stack traces to users
 *  6. Limits             — hard caps on stake/reward amounts
 */

// ── 1. Rate Limiter ────────────────────────────────────────────────────────────

interface RateLimiterOptions {
  maxCalls: number;
  windowMs: number;
}

const DEFAULT_OPTIONS: RateLimiterOptions = { maxCalls: 3, windowMs: 30_000 };
const _callLog: Map<string, number[]> = new Map();

/**
 * Returns true if the action is allowed under the rate limit.
 * Call before any on-chain write. Returns false → show error toast.
 */
export function checkRateLimit(
  key: string,
  opts: RateLimiterOptions = DEFAULT_OPTIONS
): boolean {
  const now = Date.now();
  const log = (_callLog.get(key) ?? []).filter(t => now - t < opts.windowMs);
  if (log.length >= opts.maxCalls) return false;
  log.push(now);
  _callLog.set(key, log);
  return true;
}

export function resetRateLimit(key: string): void {
  _callLog.delete(key);
}

// ── 1b. Server-route origin allowlist ──────────────────────────────────────────

/**
 * Strips scheme, path, and stray whitespace/escape artifacts so config values
 * like "https://example.com", "example.com", or "example.com\n" all normalize
 * to the same bare hostname for comparison.
 */
function normalizeHost(value: string): string {
  return value
    .replace(/\\[nr]/g, '')          // literal backslash-n / backslash-r artifacts
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/.*$/, '');
}

/**
 * Checks a request's Origin header against a comma-separated allowlist (e.g. from
 * NEXT_PUBLIC_SITE_URL). Compares bare hostnames so entries work whether or not
 * they include a scheme. Returns true (allow) if the allowlist is empty.
 */
export function isAllowedOrigin(originHeader: string, allowlistEnv: string | undefined): boolean {
  const allowedHosts = (allowlistEnv ?? '').split(',').map(normalizeHost).filter(Boolean);
  if (allowedHosts.length === 0) return true;

  let originHost: string;
  try {
    originHost = new URL(originHeader).hostname;
  } catch {
    originHost = normalizeHost(originHeader);
  }
  if (!originHost) return false;

  return allowedHosts.some(h => originHost === h || originHost.endsWith(`.${h}`));
}

// ── 2. Input Sanitization ──────────────────────────────────────────────────────

/**
 * Strip HTML tags, JS URL schemes, data: URLs, and inline event handlers.
 * Prevents stored-XSS if any value is rendered via innerHTML.
 *
 * Runs to a fixed point (repeats until the output stops changing) rather than a
 * single pass — a single pass can be bypassed with nested/malformed markup like
 * `<<script>script>` (stripping the inner tag once leaves a live `<script>` tag).
 */
export function sanitizeText(value: string): string {
  let prev = value;
  let current = value;
  // True fixed-point loop, not a bounded pass count: each pass can only ever
  // remove characters (never add any), so the string strictly shrinks or the
  // loop exits — bounded by the input length, can't run away. A capped pass
  // count (the previous approach) could leave an incompletely-sanitized
  // residue on a crafted input needing more passes than the cap allowed,
  // e.g. stripping one "javascript:" out of "javascriptjavascript::" splices
  // the remaining fragments back into a fresh "javascript:" match.
  do {
    prev = current;
    current = prev
      .replace(/<[^>]*>/g, '')         // strip HTML tags
      .replace(/javascript\s*:/gi, '') // strip js: URL scheme
      .replace(/on\w+\s*=/gi, '')      // strip onerror=, onclick=, etc.
      .replace(/data\s*:/gi, '')       // strip data: URLs
      .replace(/vbscript\s*:/gi, '');  // strip vbscript: URL scheme
  } while (current !== prev);
  return current.trim();
}

// ── 3. Address Validation ──────────────────────────────────────────────────────

/** Solana address: base58, 32–44 chars */
export function isValidSolanaAddress(addr: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(addr.trim());
}

export function isValidWalletAddress(addr: string): boolean {
  return isValidSolanaAddress(addr);
}

/** Solana SPL token mint address (same format as wallet) */
export function isValidSolanaMint(mint: string): boolean {
  return isValidSolanaAddress(mint);
}

// ── 4. Amount Validation ───────────────────────────────────────────────────────

/** Maximum single stake — 250 million FBiT */
export const MAX_STAKE_AMOUNT = 250_000_000;

/** Minimum single stake — 0.1 FBiT */
export const MIN_STAKE_AMOUNT = 0.1;

/**
 * Returns true when amount is a finite positive number within allowed range
 * and with at most maxDecimals decimal places.
 */
export function isValidAmount(amount: number, maxDecimals = 9): boolean {
  if (!Number.isFinite(amount) || amount <= 0) return false;
  if (amount < MIN_STAKE_AMOUNT || amount > MAX_STAKE_AMOUNT) return false;
  const str = amount.toString();
  const dot = str.indexOf('.');
  if (dot === -1) return true;
  return str.length - dot - 1 <= maxDecimals;
}

/** Validate a raw token amount (before decimals scaling) — must be positive bigint-safe integer */
export function isValidRawAmount(raw: bigint): boolean {
  return raw > 0n && raw <= BigInt(MAX_STAKE_AMOUNT) * 1_000_000_000n;
}

// ── 5. BPS Validation ─────────────────────────────────────────────────────────

/** Basis points: integer 0–10000 */
export function isValidBps(bps: number): boolean {
  return Number.isInteger(bps) && bps >= 0 && bps <= 10_000;
}

/** Team bonus BPS: integer 1–1000 (max 10%) */
export function isValidBonusBps(bps: number): boolean {
  return Number.isInteger(bps) && bps >= 1 && bps <= 1_000;
}

// ── 6. Error Sanitization ──────────────────────────────────────────────────────

/** Patterns in error messages that should never reach the user */
const _SENSITIVE_PATTERNS = [
  /0x[0-9a-fA-F]{40,}/g,          // raw EVM addresses in errors
  /private.?key/gi,
  /secret/gi,
  /mnemonic/gi,
  /seed.?phrase/gi,
  /Error: [A-Z_]{10,}/g,           // internal enum-style error codes
  /at\s+\w+\s+\([^)]+\)/g,        // stack trace frames
];

/**
 * Return a safe, user-facing error message.
 * Strips stack traces, private keys, internal codes, and raw addresses.
 */
export function sanitizeErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);

  // Passthrough known user-friendly messages (contract-configured checks etc.)
  if (raw.includes('Contract not configured')) return raw;
  if (raw.includes('Too many')) return raw;
  if (raw.includes('Rate limit')) return raw;

  // Wallet rejection — user cancelled on their device
  if (
    raw.toLowerCase().includes('user rejected') ||
    raw.toLowerCase().includes('user denied') ||
    raw.includes('ACTION_REJECTED') ||
    raw.includes('rejected the request') ||
    raw.includes('rejected transaction') ||
    raw.includes('Request rejected') ||
    raw.includes('Rejected by user') ||
    raw.includes('Transaction was rejected')
  ) return 'Transaction cancelled — rejected by wallet.';

  // Phantom dApp security block — domain flagged by Phantom's security system
  if (
    raw.toLowerCase().includes('request blocked') ||
    raw.toLowerCase().includes('dapp could be malicious') ||
    raw.toLowerCase().includes('blocked this request') ||
    raw.toLowerCase().includes('phantom has blocked')
  ) return 'Transaction blocked by Phantom security. Click "Proceed anyway" in Phantom, or contact review@phantom.com to whitelist this dApp.';

  // Insufficient gas funds
  if (
    raw.toLowerCase().includes('insufficient funds') ||
    raw.toLowerCase().includes('insufficient gas') ||
    raw.includes('InsufficientFunds')
  ) return 'Insufficient SOL for network fees. Please add SOL to your wallet and try again.';

  // Network / RPC errors
  if (
    raw.toLowerCase().includes('network error') ||
    raw.toLowerCase().includes('networkerror') ||
    raw.includes('could not connect') ||
    raw.includes('failed to fetch') ||
    raw.includes('connection refused')
  ) return 'Network error — please check your connection and try again.';

  // Solana contract error passthroughs
  if (raw.includes('Stake amount is below minimum')) return 'Minimum stake is 0.1 FBiT.';
  if (raw.includes('Stake amount exceeds maximum')) return 'Maximum stake is 250,000,000 FBiT.';
  if (raw.includes('Invalid referral token account')) return 'Invalid referral account. Please try again.';
  if (raw.includes('BelowMinStake')) return 'Minimum stake is 0.1 FBiT.';
  if (raw.includes('AboveMaxStake')) return 'Maximum stake is 250,000,000 FBiT.';
  if (raw.includes('InvalidReferralATA')) return 'Invalid referral account. Please try again.';
  if (raw.includes('pool fully reserved for pending')) return 'Cannot withdraw: reward pool is fully reserved for pending user rewards.';
  if (raw.includes('Cooldown') || raw.includes('cooldown') || raw.includes('claim interval') || raw.includes('Claim interval')) return 'Claim cooldown not met — please wait until the 6h interval has passed.';
  if (raw.includes('Insufficient reward') || raw.includes('insufficient reward')) return 'Reward pool has insufficient balance. Please try again later.';
  if (raw.includes('User is blocked') || raw.includes('user is blocked')) return 'This wallet has been blocked from claiming.';
  if (raw.includes('referral link is required') || raw.includes('required to register')) return raw;
  if (raw.includes('Referrer wallet is not yet registered')) return raw;
  if (raw.includes('A valid referrer is required') || raw.includes('ReferrerRequired')) return 'A referral link is required to register. Please open the site from a valid referral link.';
  if (raw.includes('No reward') || raw.includes('no reward') || raw.includes('Nothing to claim')) return 'No claimable reward yet. Rewards accrue every 6 hours.';
  if (raw.includes('Paused') || raw.includes('paused') || raw.includes('pausable')) return 'The staking contract is paused. Please try again later.';

  let safe = raw;
  for (const pattern of _SENSITIVE_PATTERNS) {
    safe = safe.replace(pattern, '[redacted]');
  }

  // Collapse to first sentence — stack frames come after newlines
  safe = safe.split('\n')[0].trim();

  // Cap length
  if (safe.length > 120) safe = safe.slice(0, 117) + '…';

  return safe || 'An unexpected error occurred. Please try again.';
}

// ── 7. Environment Guard ───────────────────────────────────────────────────────

/**
 * Warn in the console (dev-only) if critical env vars are missing.
 * Never throws — just logs so the app still loads.
 */
export function warnMissingEnv(): void {
  if (typeof window === 'undefined') return;
  const required = [
    'NEXT_PUBLIC_REOWN_PROJECT_ID',
    'NEXT_PUBLIC_SOLANA_STAKE_TOKEN_MINT',
  ];
  for (const key of required) {
    const val = process.env[key];
    if (!val || val.startsWith('YOUR_')) {
      console.warn(`[FBiT Security] Missing env var: ${key}`);
    }
  }
}
