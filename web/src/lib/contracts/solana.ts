'use client';

/**
 * Solana FBiTStaking Anchor contract service
 *
 * Stake entry PDA is seeded with [b"stake", owner_pubkey, stakeId_le_bytes].
 * stakeId = user_account.stake_count at the time of staking (monotonic counter).
 * The `stakeId` stored in StakeEntry lets the client re-derive the PDA for
 * claim / compound / unstake.
 *
 * All public methods throw on error — callers should catch.
 * Amount parameters are in token units (not lamports).
 */

import { Connection, PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY, Transaction, TransactionInstruction, VersionedTransaction } from '@solana/web3.js';
import { AnchorProvider, Program, BN, utils as anchorUtils } from '@coral-xyz/anchor';
import { TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { IDL } from './idl';
import { NETWORK_CONFIG } from '@/lib/config';
import { appKitModal, solanaWalletProvider, connectedSolanaAddress } from '@/lib/reown';
import type { PlatformStats, StakeEntry, UserAccount, ReferralInfo } from '@/types';

// Anchor discriminators: sha256("account:<Name>")[0..8] and sha256("global:<name>")[0..8]
// Computed offline — deterministic from names in the deployed program.
const ACCOUNT_DISCRIMINATORS: Record<string, number[]> = {
  Platform:    [77,  92, 204,  58, 187,  98,  91,  12],
  UserAccount: [211,  33, 136,  16, 186, 110, 242, 127],
  StakeEntry:  [187, 127,   9,  35, 155,  68,  86,  40],
};
// Instruction discriminators: sha256("global:<rust_snake_case_name>")[0..8]
// Old Anchor IDLs show camelCase names but programs use snake_case for hashing.
const IX_DISCRIMINATORS: Record<string, number[]> = {
  initialize:            [175, 175, 109,  31,  13, 152, 155, 237],
  fundRewardPool:        [ 85,  49, 108, 245, 204,  70, 243,   3],
  refundRewardPool:      [154, 132, 175,  20, 219, 145,  93, 120],
  depositReserve:        [187,  75, 224,  96, 122, 233, 220, 121],
  releaseEmission:       [248, 103, 174,  57,  15,  35, 227,  38],
  registerUser:          [  2, 241, 150, 223,  99, 214, 116,  97],
  stake:                 [206, 176, 202,  18, 200, 209, 179, 108],
  claimRewards:          [  4, 144, 132,  71, 116,  23, 151,  80],
  compoundRewards:       [254, 191, 226, 120,  82, 115,   5,  87],
  unstake:               [ 90,  95, 107,  42, 205, 124,  50, 225],
  setRewardRate:         [253, 201, 190,  20,  48,  38, 120,  34],
  setReferralRewardRate: [ 95,  48, 184,  35, 217, 109, 160, 125],
  blockUser:             [ 10, 164, 178,   6, 231, 175, 185, 191],
  unblockUser:           [216, 208, 128,  98,  74, 210,  18, 114],
  togglePause:           [238, 237, 206,  27, 255,  95, 123, 229],
  setAnnualEmission:     [ 23, 188,  62,  60, 159,  23, 116, 166],
  setBurnBps:            [226, 172, 145, 206, 238,  25,  16, 103],
  setTeamTargetTier:          [ 88, 230, 208,   7,  32, 138, 239,   4],
  setReferralPercentages:     [230,  34, 112, 247,  80, 147, 223,  93],
  setBatchApy:                [109,  76,  87, 205, 176, 242, 123,  34],
  renounceOwnership:     [ 19, 143,  91,  79,  34, 168, 174, 125],
  updateUserTeamStats:   [137, 242, 244, 142, 224,  98, 192, 229],
  setLockPeriodApy:      [129,  70, 210,  21,  87, 145, 193, 150],
  fixBump:               [ 55, 162,  45, 211, 135, 185,  66, 103],
};

// Event discriminators: sha256("event:<Name>")[0..8]. Used to pull the exact,
// contract-computed net amount and burn amount out of a confirmed claim/compound
// transaction's logs — see fetchClaimResultFromTx below. Computing these
// client-side instead (fee % + burn % + referral %) would require re-deriving
// which referral levels actually got paid, which only the contract can
// determine authoritatively (see lib.rs's claim_rewards/compound_rewards).
const EVENT_DISCRIMINATORS: Record<string, number[]> = {
  RewardsClaimed:    [75,  98,  88,  18, 219, 112,  88, 121],
  RewardsCompounded: [145, 86,  94,  94, 103, 143, 189,  95],
  TokensBurned:      [230, 255,  34, 113, 226,  53, 227,   9],
};

function decodeEventFromLogs(logs: string[], eventName: keyof typeof EVENT_DISCRIMINATORS): Buffer | null {
  const wantDisc = Buffer.from(EVENT_DISCRIMINATORS[eventName]);
  for (const log of logs) {
    if (!log.startsWith('Program data: ')) continue;
    const raw = Buffer.from(log.slice('Program data: '.length), 'base64');
    if (raw.length >= 8 && raw.subarray(0, 8).equals(wantDisc)) return raw;
  }
  return null;
}

// Reads a just-confirmed claim/compound transaction's logs and extracts the
// exact net amount (RewardsClaimed/RewardsCompounded.amount, after platform
// fee, burn, and the claim-time referral cut) and burn amount (TokensBurned.
// burn_amount) the contract actually computed — not client-side estimates.
// Falls back to `fallbackReward`/`null` if parsing fails for any reason, so a
// transient RPC hiccup never breaks the UI.
async function fetchClaimResultFromTx(
  connection: Connection,
  txHash: string,
  eventName: 'RewardsClaimed' | 'RewardsCompounded',
  fallbackReward: number,
): Promise<{ netAmount: number; burnAmount: number | null }> {
  try {
    const tx = await connection.getTransaction(txHash, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
    const logs = tx?.meta?.logMessages ?? [];

    const rewardEvent = decodeEventFromLogs(logs, eventName);
    // Both events: [discriminator(8), user: Pubkey(32), amount: u64(8), ...more fields]
    const netAmount = rewardEvent ? Number(rewardEvent.readBigUInt64LE(8 + 32)) / SCALE : fallbackReward;

    const burnEvent = decodeEventFromLogs(logs, 'TokensBurned');
    // TokensBurned: [discriminator(8), user: Pubkey(32), burn_amount: u64(8), total_burned: u64(8)]
    const burnAmount = burnEvent ? Number(burnEvent.readBigUInt64LE(8 + 32)) / SCALE : null;

    return { netAmount, burnAmount };
  } catch {
    return { netAmount: fallbackReward, burnAmount: null };
  }
}

/**
 * Patch an old-format Anchor IDL for compatibility with Anchor 0.32:
 *  1. "publicKey" type string → "pubkey"       (borsh coder expects lowercase)
 *  2. isMut/isSigner → writable/signer          (new account descriptor format)
 *  3. Move account struct defs into idl.types   (0.32 reads types from types[], not accounts[])
 *  4. Convert idl.accounts to {name, discriminator} (0.32 new account format)
 *  5. Inject idl.address                         (0.32 reads programId from here)
 */
function patchIdl(rawIdl: any, programAddress: string): any {
  // Step 1 — replace "publicKey" type strings globally
  const patched = JSON.parse(
    JSON.stringify(rawIdl).replace(/:"publicKey"/g, ':"pubkey"')
  );

  // Step 2 — convert instruction account descriptors
  function fixIxAccounts(accounts: any[]): any[] {
    return accounts.map((acc: any) => {
      if (Array.isArray(acc.accounts)) {
        return { name: acc.name, accounts: fixIxAccounts(acc.accounts) };
      }
      const out: any = { name: acc.name };
      if (acc.isMut    || acc.writable) out.writable = true;
      if (acc.isSigner || acc.signer)   out.signer   = true;
      if (acc.optional || acc.isOptional) out.optional  = true;
      if (acc.address)                  out.address   = acc.address;
      if (acc.pda)                      out.pda       = acc.pda;
      if (acc.relations)                out.relations = acc.relations;
      return out;
    });
  }
  if (patched.instructions) {
    patched.instructions = patched.instructions.map((ix: any) => {
      const disc = ix.discriminator ?? IX_DISCRIMINATORS[ix.name] ?? [];

      return {
        ...ix,
        accounts: fixIxAccounts(ix.accounts ?? []),
        // Inject instruction discriminator — required by Anchor 0.32 BorshInstructionCoder
        discriminator: disc,
      };
    });
  }

  // Steps 3 & 4 — split old accounts[] into types[] + slim accounts[]
  // Old format: accounts[i] = { name, type: { kind:'struct', fields:[...] } }
  // New format: accounts[i] = { name, discriminator:[8 bytes] }
  //             types[i]    = { name, type: { kind:'struct', fields:[...] } }
  if (Array.isArray(patched.accounts) && patched.accounts.length > 0) {
    const oldAccounts: any[] = patched.accounts;
    const existingTypes: any[] = patched.types ?? [];

    const newTypes: any[] = [...existingTypes];
    const newAccounts: any[] = [];

    for (const acc of oldAccounts) {
      if (acc.type) {
        // Old format — extract struct def into types[]
        newTypes.push({ name: acc.name, type: acc.type });
        newAccounts.push({
          name: acc.name,
          discriminator: ACCOUNT_DISCRIMINATORS[acc.name] ?? [0,0,0,0,0,0,0,0],
        });
      } else {
        // Already new format — keep as-is, just ensure discriminator exists
        newAccounts.push({
          ...acc,
          discriminator: acc.discriminator ?? ACCOUNT_DISCRIMINATORS[acc.name] ?? [0,0,0,0,0,0,0,0],
        });
        if (!existingTypes.find((t: any) => t.name === acc.name)) {
          // No type entry yet — skip (won't be decodable but won't crash)
        }
      }
    }

    patched.accounts = newAccounts;
    patched.types    = newTypes;
  }

  // Step 5 — inject program address
  patched.address = programAddress;
  return patched;
}

function getProgramId(): PublicKey {
  const addr = NETWORK_CONFIG.solana.contractAddress;
  if (!addr) throw new Error('Solana program ID not configured. Set NEXT_PUBLIC_SOLANA_PROGRAM_ID in your .env.local');
  return new PublicKey(addr);
}
const DECIMALS   = 9;
const SCALE      = 10 ** DECIMALS;

// Referral commission percentages in BPS — fallback only. Mirrors the LIVE
// on-chain Platform.referral_percentages (verified 2026-08-21), not the
// contract's DEFAULT_REFERRAL_PERCENTAGES constant (30% total) — an admin
// changed this on-chain post-deploy to a lower, evenly-stepped curve (17.75%
// total). Index 0 = Level 1 (direct), index 9 = Level 10.
const REFERRAL_BPS = [25, 50, 125, 150, 175, 200, 225, 250, 275, 300] as const;

// Cache for program.account.userAccount.all() — expires after 2 minutes.
// Shared across all callers (bfsReferralTree + solanaGetReferralInfo) so a
// burst of concurrent polls only hits the RPC once.
let _allUserAccountsCache: { data: any[]; ts: number } | null = null;
const ALL_ACCOUNTS_CACHE_MS = 120_000;
let _allUserAccountsInflight: Promise<any[]> | null = null;

async function getAllUserAccounts(): Promise<any[]> {
  const now = Date.now();
  if (_allUserAccountsCache && now - _allUserAccountsCache.ts < ALL_ACCOUNTS_CACHE_MS) {
    return _allUserAccountsCache.data;
  }
  // Deduplicate concurrent fetches — if one is already in flight, wait for it.
  if (_allUserAccountsInflight) return _allUserAccountsInflight;
  const program = getReadOnlyProgram();
  const inflight: Promise<any[]> = (program.account as any).userAccount.all().then((data: any[]) => {
    _allUserAccountsCache = { data, ts: Date.now() };
    _allUserAccountsInflight = null;
    return data;
  }).catch((err: unknown) => {
    _allUserAccountsInflight = null;
    throw err;
  });
  _allUserAccountsInflight = inflight;
  return inflight;
}

// Fast, cached lookup for chain-walking: owner pubkey (base58) -> that owner's
// on-chain `.referrer` field. A referrer is set once at registration and can
// never change afterward, so building this map from the same 2-minute-cached
// bulk fetch used elsewhere (getAllUserAccounts) carries zero staleness risk
// for chain *topology* — unlike fields such as totalStaked that change often.
// Used to replace up to 10 sequential per-level RPC round-trips (one fetch per
// ancestor, needed before the next level's PDA could even be derived) with a
// single bulk fetch — cuts several seconds of pre-signature latency on stake/
// claim/compound/unstake for users with a deep referral chain.
async function getReferrerMap(): Promise<Map<string, PublicKey | null>> {
  const allDecoded: any[] = await getAllUserAccounts();
  const map = new Map<string, PublicKey | null>();
  for (const item of allDecoded) {
    try {
      map.set(item.account.owner.toBase58(), item.account.referrer ?? null);
    } catch { /* skip malformed */ }
  }
  return map;
}

function toLamports(amount: number): BN {
  return new BN(Math.floor(amount * SCALE));
}
function fromLamports(n: BN | number): number {
  return (typeof n === 'number' ? n : n.toNumber()) / SCALE;
}

// ── PDA derivations ────────────────────────────────────────────────────────────

export function platformPda(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from('platform')], getProgramId());
}

function userPda(owner: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from('user'), owner.toBuffer()], getProgramId());
}

function stakeEntryPda(owner: PublicKey, stakeId: number): [PublicKey, number] {
  const id = new BN(stakeId);
  return PublicKey.findProgramAddressSync(
    [Buffer.from('stake'), owner.toBuffer(), id.toArrayLike(Buffer, 'le', 8)],
    getProgramId()
  );
}

// ── Provider / Program helpers ─────────────────────────────────────────────────

/**
 * Returns the Reown-connected Solana wallet provider.
 *
 * Priority:
 * 1. AppKit subscribeProviders result — covers WalletConnect wallets (Binance, etc.)
 *    and browser-extension wallets routed through AppKit (Phantom, Solflare).
 * 2. Window-injected extension whose publicKey matches the connected address —
 *    covers Phantom/Solflare when AppKit provider isn't yet available.
 * 3. Any connected window extension (legacy fallback, no AppKit).
 */
export function getSolanaWallet(): any {
  if (appKitModal) {
    // Layer 1: provider from AppKit (WalletConnect wallets like Binance, or Phantom via AppKit)
    if (solanaWalletProvider?.publicKey) return solanaWalletProvider;

    // Layer 2: browser extension whose address matches the Reown-connected address
    // (handles Phantom/Solflare connected via AppKit before subscribeProviders fires)
    if (connectedSolanaAddress) {
      const w = (window as any);
      const candidates = [w.solana, w.solflare, w.backpack, w.jupiter];
      const matched = candidates.find(
        c => c?.isConnected && c?.publicKey &&
             c.publicKey.toString() === connectedSolanaAddress
      );
      if (matched) return matched;
    }

    throw new Error(
      'Solana wallet not connected. To use Solana staking with Binance Wallet: ' +
      'open the connect modal, select Binance, then choose your Solana account in the Binance app.'
    );
  }
  // Layer 3: no AppKit — any connected window extension (legacy)
  const w = (window as any);
  const candidates = [w.solana, w.solflare, w.backpack, w.jupiter];
  const wallet = candidates.find(c => c?.isConnected && c?.publicKey);
  if (!wallet?.publicKey) throw new Error('Solana wallet not connected.');
  return wallet;
}

// Translates low-level WalletConnect errors into user-friendly Solana messages.
// "no active chain" is thrown by the WC Universal Provider when Binance Web3 Wallet
// is connected via WalletConnect but the Solana chain isn't in the approved session.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function wrapSolanaSign(fn: () => Promise<any>): Promise<any> {
  return fn().catch((err: any) => {
    const msg = String(err?.message ?? err ?? '').toLowerCase();
    if (msg.includes('no active chain') || msg.includes('no chain') || msg.includes('chain not found')) {
      throw new Error(
        'Solana session is not active. Please disconnect your wallet, reconnect, ' +
        'and choose the Solana network in the Binance app.'
      );
    }
    throw err;
  });
}

function getProvider(): AnchorProvider {
  const wallet = getSolanaWallet();
  const connection = getRpcConnection();
  // Re-wrap publicKey using our local @solana/web3.js PublicKey so Anchor 0.32's
  // internal isPubkey()/_bn check doesn't fail on Phantom's bundled version.
  // Sign methods are wrapped to translate "no active chain" (WalletConnect error when
  // Binance is connected as EVM and Solana chain isn't in the approved WC namespace).
  const anchorWallet = {
    publicKey:           new PublicKey(wallet.publicKey.toBytes()),
    signTransaction:     (tx: any)    => wrapSolanaSign(() => wallet.signTransaction(tx)),
    signAllTransactions: (txs: any[]) => wrapSolanaSign(() => wallet.signAllTransactions(txs)),
  };
  return new AnchorProvider(connection, anchorWallet as any, { commitment: 'confirmed' });
}

function getProgram(): Program {
  const idl = patchIdl(IDL, getProgramId().toBase58());
  return new (Program as any)(idl, getProvider()) as Program;
}

export function getOwner(): PublicKey {
  const wallet = getSolanaWallet();
  return new PublicKey(wallet.publicKey.toString());
}

/**
 * Stake vault = ATA( stakeMint, platformPDA ).
 * If NEXT_PUBLIC_SOLANA_STAKE_VAULT is set in env it takes priority (custom vaults).
 * Otherwise the address is derived automatically — no env var required.
 */
function getStakeVault(): PublicKey {
  const envAddr = NETWORK_CONFIG.solana.stakeVaultAddress;
  if (envAddr && envAddr.length > 10 && !envAddr.toUpperCase().startsWith('YOUR_')) {
    return new PublicKey(envAddr);
  }
  const [platPda] = platformPda();
  const stakeMint = new PublicKey(NETWORK_CONFIG.solana.stakeTokenAddress);
  return ata(stakeMint, platPda);
}

/**
 * Reward vault = ATA( rewardMint, platformPDA ).
 * If NEXT_PUBLIC_SOLANA_REWARD_VAULT is set in env it takes priority.
 * Otherwise derived automatically.
 */
function getRewardVault(): PublicKey {
  const envAddr = NETWORK_CONFIG.solana.rewardVaultAddress;
  if (envAddr && envAddr.length > 10 && !envAddr.toUpperCase().startsWith('YOUR_')) {
    return new PublicKey(envAddr);
  }
  const [platPda] = platformPda();
  const rewardMint = new PublicKey(NETWORK_CONFIG.solana.rewardTokenAddress);
  return ata(rewardMint, platPda);
}

/**
 * Reserve vault = separate ATA( rewardMint, platformPDA ) for the long-term emission reserve.
 * If NEXT_PUBLIC_SOLANA_RESERVE_VAULT is set in env it takes priority.
 * Otherwise derived automatically (uses the same mint, different seed — but since ATA is
 * deterministic per (mint, owner), a custom vault address MUST be set in env to separate it
 * from the reward vault. Without env var, falls back to same address as reward vault, which
 * is acceptable only for single-vault deployments.
 */
function getReserveVault(): PublicKey {
  const envAddr = NETWORK_CONFIG.solana.reserveVaultAddress;
  if (envAddr && envAddr.length > 10 && !envAddr.toUpperCase().startsWith('YOUR_')) {
    return new PublicKey(envAddr);
  }
  // Fallback: same as reward vault (single-vault mode — reserve and reward share one vault)
  return getRewardVault();
}

/** Derive the ATA for `owner` and `mint` — works synchronously via Anchor utils */
export function ata(mint: PublicKey, owner: PublicKey): PublicKey {
  const [address] = PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  return address;
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Initialize the Platform PDA — must be called ONCE by admin before any other
 * instruction (depositReserve, stake, etc.) can work. Creates the on-chain
 * Platform account that all other instructions reference.
 */
export async function solanaInitializePlatform(
  rewardRate        = 100,
  referralRewardRate = 500
): Promise<{ txHash: string }> {
  const program   = getProgram();
  const authority = getOwner();
  const [platPda] = platformPda();

  const rewardTokenMint = new PublicKey(NETWORK_CONFIG.solana.rewardTokenAddress);
  const stakeTokenMint  = new PublicKey(NETWORK_CONFIG.solana.stakeTokenAddress);

  console.log('[initializePlatform] accounts:', {
    platform:       platPda.toBase58(),
    authority:      authority.toBase58(),
    rewardTokenMint: rewardTokenMint.toBase58(),
    stakeTokenMint:  stakeTokenMint.toBase58(),
  });

  const tx = await (program.methods as any)
    .initialize(new BN(rewardRate), new BN(referralRewardRate))
    .accounts({
      platform:       platPda,
      authority,
      rewardTokenMint,
      stakeTokenMint,
      systemProgram:  SystemProgram.programId,
      tokenProgram:   TOKEN_PROGRAM_ID,
      rent:           SYSVAR_RENT_PUBKEY,
    })
    .rpc();

  return { txHash: tx };
}

/**
 * Returns true if the Platform PDA exists on-chain (initialize was called).
 * Returns false if the program is deployed but not yet initialized.
 */
export async function solanaIsPlatformInitialized(): Promise<boolean> {
  try {
    const program = getReadOnlyProgram();
    const [pda]   = platformPda();
    console.log('[isPlatformInitialized] fetching PDA:', pda.toBase58());
    const result = await (program.account as any).platform.fetch(pda);
    console.log('[isPlatformInitialized] fetch OK → true, bump=', result.bump?.toString?.() ?? result.bump);
    return true;
  } catch (err: any) {
    console.warn('[isPlatformInitialized] fetch FAILED → false:', err?.message ?? err);
    return false;
  }
}

/**
 * Reads the Platform account directly via raw bytes instead of Anchor's
 * program.account.platform.fetch(). The installed @coral-xyz/anchor client
 * (0.32.x) uses a newer IDL type-schema than this project's hand-written IDL
 * (web/src/idl/fbit_staking.ts) — any Option<Pubkey> field (e.g. registerUser's
 * `referrer` arg) throws "Cannot use 'in' operator to search for 'option' in
 * publicKey" the moment `new Program(idl, provider)` runs, before any fetch
 * even happens. getReadOnlyProgram() is unusable for this reason (same issue
 * StakeEntry fetching already works around below — see its comment).
 *
 * Layout (offsets after the 8-byte discriminator), matching the Platform
 * struct in contracts/solana/programs/fbit-staking/src/lib.rs:
 *   8   authority             Pubkey (32)
 *   40  reward_token_mint     Pubkey (32)
 *   72  stake_token_mint      Pubkey (32)
 *   104 reward_rate           u64 (8)
 *   112 referral_reward_rate  u64 (8)
 *   120 total_staked          u64 (8)
 *   128 total_users           u64 (8)
 *   136 reward_pool_balance   u64 (8)
 *   144 is_paused             bool (1)
 *   145 base_apy[1]           u64[1] (8)
 *   153 team_tier_min_staked  u64[10] (80)
 *   233 team_tier_bonus_bps   u64[10] (80)
 *   313 total_burned          u64 (8)
 *   321 halving_epoch         u64 (8)  — unused, kept for backward compat
 *   329 halving_start_time    i64 (8)  — unused, kept for backward compat
 *   337 is_renounced          bool (1)
 *   338 fee_recipient         Pubkey (32)
 *   370 total_fees_collected  u64 (8)
 *   378 bump                  u8 (1)
 *   379 total_reserve         u64 (8)
 *   387 total_emission_released u64 (8)
 *   395 emission_start_time   i64 (8)
 *   403 annual_emission       u64 (8)
 *   411 burn_bps              u64 (8)
 *   419 referral_percentages  u64[10] (80)
 *   499 last_release_time     i64 (8)
 */
export async function solanaFetchPlatformStats(): Promise<PlatformStats | null> {
  try {
    const connection = getRpcConnection();
    const [pda] = platformPda();
    const info = await connection.getAccountInfo(pda);
    if (!info) return null;
    const d = info.data;

    const u64 = (off: number) => d.readBigUInt64LE(off);
    const i64 = (off: number) => d.readBigInt64LE(off);
    const u64ToNum = (off: number) => Number(u64(off));
    const toFBiT = (off: number) => Number(u64(off)) / Number(SCALE);

    const totalStakedRaw     = u64(120);
    const annualEmissionRaw  = u64(403);
    const totalReserve       = toFBiT(379);
    const totalEmissionReleased = toFBiT(387);
    const emissionStartTime  = Number(i64(395));
    const lastReleaseTimeRaw = i64(499);
    const lastReleaseTime    = lastReleaseTimeRaw !== 0n ? Number(lastReleaseTimeRaw) : emissionStartTime;
    const annualEmission     = toFBiT(403);
    const totalStaked        = toFBiT(120);

    // Live dynamic APY: annualEmission / totalStaked × 10000 (bps), same formula as on-chain.
    // Falls back to baseApy[0] when emission or total_staked is zero.
    const baseApy0 = u64ToNum(145);
    let effectiveAPY = Math.min(30_000, Math.max(1_000, baseApy0 || 1_000));
    if (annualEmissionRaw > 0n && totalStakedRaw > 0n) {
      const raw = (annualEmissionRaw * 10_000n) / totalStakedRaw;
      effectiveAPY = Math.min(30_000, Math.max(1_000, Number(raw)));
    }

    // Calculate releasable emission: proportional to elapsed time since the LAST
    // release, not since emission_start_time — stays correct even if annual_emission
    // changes mid-flight (see release_emission's doc comment in lib.rs).
    let releasableEmission = 0;
    if (annualEmission > 0 && emissionStartTime > 0 && totalReserve > 0) {
      const now         = Math.floor(Date.now() / 1000);
      const elapsed     = Math.max(0, now - lastReleaseTime);
      const secondsYear = 365 * 24 * 3600;
      releasableEmission = Math.max(0, Math.min(totalReserve, annualEmission * (elapsed / secondsYear)));
    }

    // Team tiers: merge static labels/colors with live minStaked/bonusBps
    const { TEAM_TARGET_TIERS: STATIC_TIERS } = await import('@/types');
    const teamTiers: import('@/types').PlatformStats['teamTiers'] = STATIC_TIERS.map((t, i) => {
      const minTeamStaked = toFBiT(153 + i * 8);
      const bonusBps      = u64ToNum(233 + i * 8);
      return {
        tier: t.tier, label: t.label, color: t.color,
        minTeamStaked: minTeamStaked || t.minTeamStaked,
        bonusBps:      bonusBps || t.bonusBps,
        bonusPercentage: (bonusBps || t.bonusBps) / 100,
      };
    });

    const referralPercentages = Array.from({ length: 10 }, (_, i) => u64ToNum(419 + i * 8));

    return {
      totalStaked,
      totalUsers:            u64ToNum(128),
      rewardPoolBalance:     toFBiT(136),
      rewardRate:            u64ToNum(104),
      referralRewardRate:    u64ToNum(112),
      isPaused:              d[144] === 1,
      totalBurned:           toFBiT(313),
      annualEmission,
      burnBps:               u64ToNum(411),
      effectiveAPY,
      isRenounced:           d[337] === 1,
      feeRecipient:          new PublicKey(d.subarray(338, 370)).toBase58(),
      totalFeesCollected:    toFBiT(370),
      totalReserve,
      emissionStartTime,
      totalEmissionReleased,
      releasableEmission,
      teamTiers,
      referralPercentages: referralPercentages.some(v => v > 0) ? referralPercentages : undefined,
    };
  } catch (err) {
    console.warn('[solanaFetchPlatformStats] failed:', err);
    return null;
  }
}

export async function solanaIsRegistered(owner: PublicKey): Promise<boolean> {
  try {
    const program = getReadOnlyProgram();
    const [pda] = userPda(owner);
    await (program.account as any).userAccount.fetch(pda);
    return true;
  } catch (err: any) {
    const msg = String(err?.message ?? '');
    // "Account does not exist" = PDA not initialized → user not registered
    if (msg.includes('does not exist') || msg.includes('has no data') || msg.includes('Account not found')) {
      return false;
    }
    // Any other error (network, RPC timeout) — rethrow so callers don't silently re-register
    throw err;
  }
}

export async function solanaRegisterUser(referrer?: string): Promise<{ txHash: string }> {
  const wallet    = getSolanaWallet();
  const program   = getProgram();
  const owner     = getOwner();
  const [platPda] = platformPda();
  const [userAccPda] = userPda(owner);
  const programId = getProgramId();

  let referrerPubkey: PublicKey | null = null;

  if (referrer) {
    try {
      referrerPubkey = new PublicKey(referrer);
      if (referrerPubkey.equals(owner)) throw new Error('Cannot use your own wallet as referrer.');
      const [referrerPda] = userPda(referrerPubkey);
      let referrerData: any;
      try {
        referrerData = await (program.account as any).userAccount.fetch(referrerPda);
      } catch {
        throw new Error('Referrer wallet is not yet registered on the platform. Please use a valid referral link.');
      }
      // Referrer must have staked at least once — mirrors the on-chain check in
      // register_user (also what closes the circular-referrer exploit at the root:
      // a referrer must have registered AND staked strictly before their referee
      // registers, so no A→B→A cycle can ever be constructed).
      const referrerStaked = referrerData.totalStaked ? new BN(referrerData.totalStaked.toString()) : new BN(0);
      if (referrerStaked.isZero()) {
        throw new Error('This referral link is not active yet — the referrer needs to stake at least once before their link can be used.');
      }
    } catch (err: any) {
      throw err;
    }
  } else {
    // No referrer — only admin can register without one.
    // Rethrow all errors so a network failure never silently allows non-admin
    // registration without a referrer.
    const platformData: any = await (program.account as any).platform.fetch(platPda);
    const isAdmin = owner.equals(new PublicKey(platformData.authority.toString()));
    if (!isAdmin) {
      throw new Error('A referral link is required to register. Please open the site from a valid referral link.');
    }
  }

  // Build instruction manually — Anchor 0.32 client issues; program has 4 fixed accounts.
  const disc = Buffer.from(IX_DISCRIMINATORS.registerUser);
  // Borsh encode referrer: Option<Pubkey> → [0] for None, [1, ...32 bytes] for Some
  const refArg = referrerPubkey
    ? Buffer.concat([Buffer.from([1]), Buffer.from(referrerPubkey.toBytes())])
    : Buffer.from([0]);
  const data = Buffer.concat([disc, refArg]);

  // referrer_account: the referrer's own UserAccount PDA (validated on-chain when
  // referrer is Some). When there's no referrer (admin-only registration), the contract
  // never reads this account, so the caller's own not-yet-created PDA is passed as a
  // harmless placeholder.
  const referrerAccPda = referrerPubkey ? userPda(referrerPubkey)[0] : userAccPda;

  const keys = [
    { pubkey: platPda,                 isSigner: false, isWritable: true  },
    { pubkey: userAccPda,              isSigner: false, isWritable: true  },
    { pubkey: referrerAccPda,          isSigner: false, isWritable: false },
    { pubkey: owner,                   isSigner: true,  isWritable: true  },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ];

  const instruction = new TransactionInstruction({ keys, programId, data });

  const connection = getRpcConnection();
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  const legacyTx = new Transaction({ feePayer: owner, recentBlockhash: blockhash });
  legacyTx.add(instruction);

  const signedTx = await wrapSolanaSign(() => wallet.signTransaction(legacyTx));
  const txHash = await connection.sendRawTransaction(signedTx.serialize(), {
    skipPreflight: false,
    preflightCommitment: 'confirmed',
  });
  await connection.confirmTransaction({ signature: txHash, blockhash, lastValidBlockHeight }, 'confirmed');

  return { txHash };
}

export async function solanaStake(
  amount: number,
  referrer?: string
): Promise<{ txHash: string; stakeIndex: number }> {
  if (!amount || amount < 1) throw new Error('Minimum stake is 1 FBiT.');
  const program  = getProgram();
  const owner    = getOwner();
  const [platPda] = platformPda();
  const [userAccPda] = userPda(owner);

  // Auto-register
  const registered = await solanaIsRegistered(owner);
  if (!registered) {
    await solanaRegisterUser(referrer);
  }

  // stakeId = UserAccount.stakeCount (monotonic counter, incremented by contract on each stake).
  const stakeMint    = new PublicKey(NETWORK_CONFIG.solana.stakeTokenAddress);
  const rewardMint   = new PublicKey(NETWORK_CONFIG.solana.rewardTokenAddress);
  const userTokenAcc = ata(stakeMint, owner);
  const stakeVault   = getStakeVault();
  const rewardVault  = getRewardVault();

  // stakeId = current stakeCount on-chain — MUST succeed or we'd derive wrong PDA
  let stakeId = 0;
  try {
    const userAccData: any = await (program.account as any).userAccount.fetch(userAccPda);
    stakeId = userAccData.stakeCount ? userAccData.stakeCount.toNumber() : 0;
  } catch (e) {
    throw new Error(`Failed to fetch user stake count — please retry. (${(e as Error).message})`);
  }

  // adminStakeAccount — the authority's ATA normally, or the fee_recipient's ATA
  // after renouncement (mirrors the on-chain constraint in the Stake accounts
  // struct — see solanaClaimRewards/solanaCompoundRewards for the same pattern).
  // MUST succeed or stake goes to wrong account / fails the on-chain constraint.
  let adminStakeAccount: import('@solana/web3.js').PublicKey;
  try {
    const [pda] = platformPda();
    const platformData: any = await (program.account as any).platform.fetch(pda);
    if (platformData.isRenounced && platformData.feeRecipient) {
      const feeRecipientKey = new PublicKey(platformData.feeRecipient.toString());
      adminStakeAccount = ata(stakeMint, feeRecipientKey);
    } else {
      const authorityKey = new PublicKey(platformData.authority.toString());
      adminStakeAccount = ata(stakeMint, authorityKey);
    }
  } catch (e) {
    throw new Error(`Failed to fetch platform authority — please retry. (${(e as Error).message})`);
  }

  const [stakeEntryAccPda] = stakeEntryPda(owner, stakeId);

  // Build remaining_accounts: walk the referral chain up to 10 levels.
  // Each level contributes 2 accounts: [UserAccount PDA (writable), reward ATA (writable)].
  // ATAs are always canonically derived via ata(rewardMint, referrerPubkey) — never user-supplied.
  const remainingAccounts: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[] = [];
  try {
    // The staker's own account already has referrer stored on-chain (set during registerUser).
    const userAccData: any = await (program.account as any).userAccount.fetch(userAccPda);
    let currentReferrerKey: PublicKey | null = userAccData.referrer
      ? new PublicKey(userAccData.referrer.toString())
      : null;

    // Cycle detection: track seen pubkeys to prevent infinite loops in corrupted chains
    const seenKeys = new Set<string>([owner.toBase58()]);
    // Level 1's referrer was just fetched fresh above (unavoidable — the staker
    // may have only just registered, possibly too recently for the cache below
    // to know about them). Every level after that reads the same cached bulk
    // map instead of a fresh per-level fetch — see getReferrerMap's comment.
    const referrerMap = await getReferrerMap();

    for (let lvl = 0; lvl < 10 && currentReferrerKey !== null; lvl++) {
      const keyStr = currentReferrerKey.toBase58();
      if (seenKeys.has(keyStr)) break; // cycle detected — stop walking
      seenKeys.add(keyStr);

      const [referrerUserPda] = userPda(currentReferrerKey);
      const referrerRewardAta = ata(rewardMint, currentReferrerKey);

      remainingAccounts.push(
        { pubkey: referrerUserPda, isSigner: false, isWritable: true },
        { pubkey: referrerRewardAta, isSigner: false, isWritable: true },
      );

      // Next ancestor's key, from the cached map — no RPC round-trip per level.
      const nextRef = referrerMap.get(keyStr);
      currentReferrerKey = nextRef ? nextRef : null;
    }
  } catch {
    // Chain fetch failed — proceed without referral rewards (safe degradation)
  }

  const tx = await (program.methods as any)
    .stake(toLamports(amount), 0)
    .accounts({
      platform:         platPda,
      userAccount:      userAccPda,
      stakeEntry:       stakeEntryAccPda,
      userTokenAccount: userTokenAcc,
      stakeVault,
      adminStakeAccount,
      rewardVault,
      owner,
      tokenProgram:     TOKEN_PROGRAM_ID,
      systemProgram:    SystemProgram.programId,
    })
    .remainingAccounts(remainingAccounts)
    .rpc();

  // stakeId is the stake_count fetched before sending the tx — deterministic PDA seed.
  // Store it so claim/compound/unstake can re-derive the correct PDA.
  return { txHash: tx, stakeIndex: stakeId };
}

// Returns a releaseEmission TransactionInstruction if the reserve has ≥1 FBiT
// ready to release right now, otherwise null. Accepts already-fetched platform
// data to avoid an extra RPC call (pass null to fetch internally as fallback).
async function buildReleaseIxIfReady(program: any, platformData?: any): Promise<import('@solana/web3.js').TransactionInstruction | null> {
  try {
    const [platPda] = platformPda();
    const platform: any = platformData ?? await (program.account as any).platform.fetch(platPda);
    const annual   = platform.annualEmission  ? Number(new BN(platform.annualEmission.toString()))  : 0;
    const reserve  = platform.totalReserve    ? Number(new BN(platform.totalReserve.toString()))    : 0;
    const start    = platform.emissionStartTime ? Number(platform.emissionStartTime) : 0;
    // Incremental clock — mirrors the on-chain formula (rate-change-safe: only applies the
    // current rate to time elapsed since the last release, never retroactively to the
    // full reserve-funded history). lastReleaseTime falls back to emissionStartTime for
    // any account fetched before this field existed.
    const lastRelease = platform.lastReleaseTime ? Number(platform.lastReleaseTime) : start;
    if (annual === 0 || reserve === 0 || start === 0) return null;
    const elapsed     = Math.max(0, Math.floor(Date.now() / 1000) - lastRelease);
    const releasable  = Math.max(0, Math.min(reserve, annual * (elapsed / (365 * 24 * 3600))));
    if (releasable < SCALE) return null;
    return await (program.methods as any)
      .releaseEmission()
      .accounts({
        platform:     platPda,
        reserveVault: getReserveVault(),
        rewardVault:  getRewardVault(),
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();
  } catch {
    return null;
  }
}

const CLAIM_REFERRAL_LEVELS = 5;

// Builds remaining_accounts for the claim/compound-time recurring referral (levels
// 1-5, separate from the 10-level one-time stake referral) — pairs of
// [UserAccount PDA (mut), reward ATA (mut)], pair 0 = level 1 (direct referrer).
// Mirrors solanaStake's chain-walk, capped at CLAIM_REFERRAL_LEVELS instead of 10.
// Best-effort: any failure just means fewer/no levels get paid on-chain (the
// contract treats missing levels as "unpaid", not an error — see lib.rs).
async function buildClaimReferralRemainingAccounts(
  program: any,
  userAccPda: PublicKey,
  ownerKey: PublicKey,
  rewardMint: PublicKey,
): Promise<{ pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[]> {
  const remainingAccounts: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[] = [];
  try {
    const userAccData: any = await program.account.userAccount.fetch(userAccPda);
    let currentReferrerKey: PublicKey | null = userAccData.referrer
      ? new PublicKey(userAccData.referrer.toString())
      : null;
    const seenKeys = new Set<string>([ownerKey.toBase58()]);
    const referrerMap = await getReferrerMap();

    for (let lvl = 0; lvl < CLAIM_REFERRAL_LEVELS && currentReferrerKey !== null; lvl++) {
      const keyStr = currentReferrerKey.toBase58();
      if (seenKeys.has(keyStr)) break;
      seenKeys.add(keyStr);

      const [referrerUserPda] = userPda(currentReferrerKey);
      const referrerRewardAta = ata(rewardMint, currentReferrerKey);
      remainingAccounts.push(
        { pubkey: referrerUserPda, isSigner: false, isWritable: true },
        { pubkey: referrerRewardAta, isSigner: false, isWritable: true },
      );

      const nextRef = referrerMap.get(keyStr);
      currentReferrerKey = nextRef ? nextRef : null;
    }
  } catch {
    // Chain fetch failed — proceed without the claim-referral layer (safe degradation,
    // same as solanaStake's equivalent chain walk).
  }
  return remainingAccounts;
}

// Ancestor chain for unstake()'s team_total_staked correction — one UserAccount
// PDA per level (no reward ATA needed, nothing is transferred; the contract only
// decrements a counter). Mirrors solanaStake's chain walk, up to all 10 levels
// since stake() credits team_total_staked to every one of them unconditionally.
async function buildUnstakeAncestorRemainingAccounts(
  program: any,
  userAccPda: PublicKey,
  ownerKey: PublicKey,
): Promise<{ pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[]> {
  const remainingAccounts: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[] = [];
  try {
    const userAccData: any = await program.account.userAccount.fetch(userAccPda);
    let currentReferrerKey: PublicKey | null = userAccData.referrer
      ? new PublicKey(userAccData.referrer.toString())
      : null;
    const seenKeys = new Set<string>([ownerKey.toBase58()]);
    const referrerMap = await getReferrerMap();

    for (let lvl = 0; lvl < 10 && currentReferrerKey !== null; lvl++) {
      const keyStr = currentReferrerKey.toBase58();
      if (seenKeys.has(keyStr)) break;
      seenKeys.add(keyStr);

      const [referrerUserPda] = userPda(currentReferrerKey);
      remainingAccounts.push({ pubkey: referrerUserPda, isSigner: false, isWritable: true });

      const nextRef = referrerMap.get(keyStr);
      currentReferrerKey = nextRef ? nextRef : null;
    }
  } catch {
    // Chain fetch failed — proceed without the correction (safe degradation,
    // same as solanaStake's equivalent chain walk); unstake() itself still succeeds.
  }
  return remainingAccounts;
}

export async function solanaClaimRewards(
  stakeId: number | string,
  _stakedAt: number
): Promise<{ txHash: string; reward: number; burned: number | null }> {
  const program  = getProgram();
  const owner    = getOwner();
  const [platPda] = platformPda();
  const [userAccPda] = userPda(owner);
  const [stakeEntryAccPda] = stakeEntryPda(owner, Number(stakeId));

  // Fetch platform once — required to correctly resolve the admin/fee-recipient
  // accounts below, so unlike the reward preview this is NOT best-effort: if it
  // fails we abort before building a transaction, rather than silently defaulting
  // to the wrong accounts and letting the signed tx revert on-chain.
  const fetchedPlatform: any = await (program.account as any).platform.fetch(platPda);

  // Read pending reward using live APY (dynamic PoS — not locked at stake time).
  // Best-effort: a failure here only affects the displayed preview, not the tx.
  let reward = 0;
  try {
    const entry: any = await (program.account as any).stakeEntry.fetch(stakeEntryAccPda);
    const now = Math.floor(Date.now() / 1000);
    const intervals = Math.floor((now - entry.lastClaimAt.toNumber()) / 21600);
    // Live dynamic APY = emission / totalStaked (same as contract)
    let liveApy = 1_000;
    if (fetchedPlatform.annualEmission && fetchedPlatform.totalStaked) {
      const emBN = new BN(fetchedPlatform.annualEmission.toString());
      const stBN = new BN(fetchedPlatform.totalStaked.toString());
      if (emBN.gtn(0) && stBN.gtn(0)) {
        const raw = emBN.muln(10_000).div(stBN).toNumber();
        liveApy = Math.min(30_000, Math.max(1_000, raw));
      } else {
        liveApy = Math.min(30_000, Math.max(1_000,
          fetchedPlatform.baseApy ? Number(fetchedPlatform.baseApy[0]) : 1_000
        ));
      }
    }
    reward = fromLamports(entry.amount) * liveApy * intervals / (1460 * 10_000);
  } catch {}

  const rewardMint = new PublicKey(NETWORK_CONFIG.solana.rewardTokenAddress);
  const userTokenAcc = ata(rewardMint, owner);
  const rewardVault  = getRewardVault();

  // Resolve the admin/fee-recipient account (0.25% fee) from the platform state
  // fetched above — the authority's ATA normally, or the fee_recipient's ATA
  // after renouncement (the fee still applies post-renounce).
  let adminRewardAccount = userTokenAcc; // fallback
  if (fetchedPlatform.isRenounced && fetchedPlatform.feeRecipient) {
    const feeRecipientKey = new PublicKey(fetchedPlatform.feeRecipient.toString());
    adminRewardAccount = ata(rewardMint, feeRecipientKey);
  } else {
    const authorityKey = new PublicKey(fetchedPlatform.authority.toString());
    adminRewardAccount = ata(rewardMint, authorityKey);
  }

  // Bundle releaseEmission as a pre-instruction so reward pool is topped up
  // in the same transaction — no extra wallet popup needed.
  // Pass already-fetched platform to avoid an extra RPC call that could fail silently.
  const releaseIx = await buildReleaseIxIfReady(program, fetchedPlatform);

  // Claim-time recurring referral (levels 1-5) — see buildClaimReferralRemainingAccounts.
  const claimReferralAccounts = await buildClaimReferralRemainingAccounts(program, userAccPda, owner, rewardMint);

  const tx = await (program.methods as any)
    .claimRewards(new BN(Number(stakeId)))
    .accounts({
      platform:                   platPda,
      userAccount:                userAccPda,
      stakeEntry:                 stakeEntryAccPda,
      userTokenAccount:           userTokenAcc,
      rewardVault,
      adminRewardAccount,
      rewardTokenMint:            rewardMint,
      owner,
      tokenProgram:               TOKEN_PROGRAM_ID,
    })
    .remainingAccounts(claimReferralAccounts)
    .preInstructions(releaseIx ? [releaseIx] : [])
    .rpc();

  // The pre-tx `reward` above is only a gross estimate — pull the exact net
  // amount (post fee, burn, and claim-referral cut) and burn amount from the
  // confirmed transaction's own events instead of trying to replicate that
  // math client-side (see fetchClaimResultFromTx).
  const { netAmount, burnAmount } = await fetchClaimResultFromTx(getRpcConnection(), tx, 'RewardsClaimed', reward);

  return { txHash: tx, reward: netAmount, burned: burnAmount };
}

export async function solanaCompoundRewards(
  stakeId: number | string,
  _stakedAt: number
): Promise<{ txHash: string; reward: number; burned: number | null }> {
  const program  = getProgram();
  const owner    = getOwner();
  const [platPda] = platformPda();
  const [userAccPda] = userPda(owner);
  const [stakeEntryAccPda] = stakeEntryPda(owner, Number(stakeId));

  // Fetch platform once — required to correctly resolve the admin/fee-recipient
  // accounts below, so unlike the reward preview this is NOT best-effort: if it
  // fails we abort before building a transaction, rather than silently defaulting
  // to the wrong accounts and letting the signed tx revert on-chain.
  const fetchedPlatform: any = await (program.account as any).platform.fetch(platPda);

  // Read pending reward using live APY. Best-effort: a failure here only
  // affects the displayed preview, not the tx.
  let reward = 0;
  try {
    const entry: any = await (program.account as any).stakeEntry.fetch(stakeEntryAccPda);
    const now = Math.floor(Date.now() / 1000);
    const intervals = Math.floor((now - entry.lastClaimAt.toNumber()) / 21600);
    let liveApy = 1_000;
    if (fetchedPlatform.annualEmission && fetchedPlatform.totalStaked) {
      const emBN = new BN(fetchedPlatform.annualEmission.toString());
      const stBN = new BN(fetchedPlatform.totalStaked.toString());
      if (emBN.gtn(0) && stBN.gtn(0)) {
        const raw = emBN.muln(10_000).div(stBN).toNumber();
        liveApy = Math.min(30_000, Math.max(1_000, raw));
      } else {
        liveApy = Math.min(30_000, Math.max(1_000,
          fetchedPlatform.baseApy ? Number(fetchedPlatform.baseApy[0]) : 1_000
        ));
      }
    }
    reward = fromLamports(entry.amount) * liveApy * intervals / (1460 * 10_000);
  } catch {}

  const rewardMint  = new PublicKey(NETWORK_CONFIG.solana.rewardTokenAddress);
  const rewardVault = getRewardVault();

  // Resolve the admin/fee-recipient account (0.25% fee) from the platform state
  // fetched above — the authority's ATA normally, or the fee_recipient's ATA
  // after renouncement (the fee still applies post-renounce).
  let adminRewardAccount = ata(rewardMint, owner); // fallback
  if (fetchedPlatform.isRenounced && fetchedPlatform.feeRecipient) {
    const feeRecipientKey = new PublicKey(fetchedPlatform.feeRecipient.toString());
    adminRewardAccount = ata(rewardMint, feeRecipientKey);
  } else {
    const authorityKey = new PublicKey(fetchedPlatform.authority.toString());
    adminRewardAccount = ata(rewardMint, authorityKey);
  }

  // Pass already-fetched platform to avoid an extra RPC call that could fail silently.
  const releaseIx = await buildReleaseIxIfReady(program, fetchedPlatform);

  // Claim-time recurring referral (levels 1-5) — see buildClaimReferralRemainingAccounts.
  const claimReferralAccounts = await buildClaimReferralRemainingAccounts(program, userAccPda, owner, rewardMint);

  const tx = await (program.methods as any)
    .compoundRewards()
    .accounts({
      platform:                  platPda,
      userAccount:               userAccPda,
      stakeEntry:                stakeEntryAccPda,
      rewardVault,
      adminRewardAccount,
      rewardTokenMint:           rewardMint,
      owner,
      tokenProgram:              TOKEN_PROGRAM_ID,
    })
    .remainingAccounts(claimReferralAccounts)
    .preInstructions(releaseIx ? [releaseIx] : [])
    .rpc();

  // See solanaClaimRewards — pull the exact net compound amount and burn
  // amount from the confirmed transaction's own events rather than estimating.
  const { netAmount, burnAmount } = await fetchClaimResultFromTx(getRpcConnection(), tx, 'RewardsCompounded', reward);

  return { txHash: tx, reward: netAmount, burned: burnAmount };
}

export async function solanaUnstake(stakeId: number): Promise<{ txHash: string }> {
  const program  = getProgram();
  const owner    = getOwner();
  const [platPda] = platformPda();
  const [userAccPda] = userPda(owner);
  const [stakeEntryAccPda] = stakeEntryPda(owner, stakeId);

  const stakeMint    = new PublicKey(NETWORK_CONFIG.solana.stakeTokenAddress);
  const userTokenAcc = ata(stakeMint, owner);
  const stakeVault   = getStakeVault();

  // Pre-flight: check unlock_at before broadcasting
  try {
    const entryData: any = await (program.account as any).stakeEntry.fetch(stakeEntryAccPda);
    const unlockAt = Number(entryData.unlockAt);
    const now = Math.floor(Date.now() / 1000);
    if (unlockAt > now) {
      const secsLeft = unlockAt - now;
      const daysLeft = Math.ceil(secsLeft / 86400);
      const unlockDate = new Date(unlockAt * 1000).toLocaleDateString();
      throw new Error(`Stake is still locked. Unlocks in ${daysLeft} day(s) on ${unlockDate}.`);
    }
  } catch (e: any) {
    if (e.message?.includes('locked')) throw e;
    // If account fetch fails, let the contract handle it
  }

  // adminStakeAccount — the authority's ATA normally, or the fee_recipient's ATA
  // after renouncement (mirrors the on-chain constraint in the Unstake accounts
  // struct — see solanaStake/solanaClaimRewards/solanaCompoundRewards for the
  // same pattern). MUST succeed or unstake fails the on-chain constraint.
  let adminStakeAccount: PublicKey;
  try {
    const platformData: any = await (program.account as any).platform.fetch(platPda);
    if (platformData.isRenounced && platformData.feeRecipient) {
      const feeRecipientKey = new PublicKey(platformData.feeRecipient.toString());
      adminStakeAccount = ata(stakeMint, feeRecipientKey);
    } else {
      const authorityKey = new PublicKey(platformData.authority.toString());
      adminStakeAccount = ata(stakeMint, authorityKey);
    }
  } catch (e) {
    throw new Error(`Failed to fetch platform authority — please retry. (${(e as Error).message})`);
  }

  // Ancestor chain — lets the contract correct every upline's team_total_staked
  // for the amount this unstake removes (see buildUnstakeAncestorRemainingAccounts).
  const remainingAccounts = await buildUnstakeAncestorRemainingAccounts(program, userAccPda, owner);

  const tx = await (program.methods as any)
    .unstake()
    .accounts({
      platform:         platPda,
      userAccount:      userAccPda,
      stakeEntry:       stakeEntryAccPda,
      userTokenAccount: userTokenAcc,
      stakeVault,
      adminStakeAccount,
      owner,
      tokenProgram:     TOKEN_PROGRAM_ID,
    })
    .remainingAccounts(remainingAccounts)
    .rpc();

  return { txHash: tx };
}

// ── Admin ──────────────────────────────────────────────────────────────────────

export async function solanaFundRewardPool(amount: number): Promise<{ txHash: string }> {
  if (amount < 0.1)         throw new Error('Minimum deposit is 0.1 FBiT');
  if (amount > 250_000_000) throw new Error('Maximum deposit is 250,000,000 FBiT (250M)');
  const program  = getProgram();
  const owner    = getOwner();
  const [platPda] = platformPda();

  const rewardMint   = new PublicKey(NETWORK_CONFIG.solana.rewardTokenAddress);
  const funderTokenAcc = ata(rewardMint, owner);
  const rewardVault  = getRewardVault();

  const tx = await (program.methods as any)
    .fundRewardPool(toLamports(amount))
    .accounts({
      platform:           platPda,
      authority:          owner,
      funderTokenAccount: funderTokenAcc,
      rewardVault,
      tokenProgram:       TOKEN_PROGRAM_ID,
    })
    .rpc();

  return { txHash: tx };
}

export async function solanaRefundRewardPool(amount: number): Promise<{ txHash: string }> {
  if (amount < 1) throw new Error('Minimum refund is 1 FBiT');
  const program   = getProgram();
  const authority = getOwner();
  const [platPda] = platformPda();

  const rewardMint          = new PublicKey(NETWORK_CONFIG.solana.rewardTokenAddress);
  const authorityTokenAccount = ata(rewardMint, authority);
  const rewardVault         = getRewardVault();

  const tx = await (program.methods as any)
    .refundRewardPool(toLamports(amount))
    .accounts({
      platform:               platPda,
      authority,
      authorityTokenAccount,
      rewardVault,
      tokenProgram:           TOKEN_PROGRAM_ID,
    })
    .rpc();

  return { txHash: tx };
}

/**
 * One-time fix for deployments where initialize() forgot to store platform.bump.
 * Calls fix_bump instruction which sets platform.bump = ctx.bumps.platform (canonical 253).
 * After this, all instructions that use bump = platform.bump will work correctly.
 * Safe to call multiple times — only changes bump if it is wrong.
 */
export async function solanaFixBump(): Promise<{ txHash: string }> {
  const wallet    = getSolanaWallet();
  const authority = getOwner();
  const [platPda] = platformPda();
  const programId = getProgramId();

  const disc = Buffer.from(IX_DISCRIMINATORS.fixBump);

  const keys = [
    { pubkey: platPda,   isSigner: false, isWritable: true },
    { pubkey: authority, isSigner: true,  isWritable: false },
  ];

  const instruction = new TransactionInstruction({ keys, programId, data: disc });

  const connection = getRpcConnection();
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  const legacyTx = new Transaction({ feePayer: authority, recentBlockhash: blockhash });
  legacyTx.add(instruction);

  const signedTx = await wrapSolanaSign(() => wallet.signTransaction(legacyTx));

  let txHash: string;
  try {
    txHash = await connection.sendRawTransaction(signedTx.serialize(), {
      skipPreflight: false,
      preflightCommitment: 'confirmed',
    });
  } catch (sendErr: any) {
    console.error('[fixBump] sendRawTransaction error:', sendErr?.message ?? sendErr);
    if (sendErr?.logs) console.error('[fixBump] simulation logs:', sendErr.logs);
    throw sendErr;
  }

  await connection.confirmTransaction({ signature: txHash, blockhash, lastValidBlockHeight }, 'confirmed');
  return { txHash };
}

export async function solanaDepositReserve(amount: number): Promise<{ txHash: string }> {
  if (amount < 0.1) throw new Error('Minimum deposit is 0.1 FBiT');

  const wallet     = getSolanaWallet();
  const authority  = getOwner();
  const [platPda]  = platformPda();
  const programId  = getProgramId();

  const rewardMint         = new PublicKey(NETWORK_CONFIG.solana.rewardTokenAddress);
  const funderTokenAccount = ata(rewardMint, authority);
  const reserveVault       = getReserveVault();

  // Diagnostic: scan raw Platform account bytes for embedded Pubkeys.
  // This reveals whether the program stores reserve_vault / reward_vault etc. in the Platform struct.
  try {
    const conn     = getRpcConnection();
    const platInfo = await conn.getAccountInfo(platPda);
    if (platInfo) {
      const bytes = platInfo.data;
      console.log('[depositReserve] Platform raw bytes len:', bytes.length);
      const knownKeys: Record<string, string> = {
        [authority.toBase58()]:                'admin_authority',
        [rewardMint.toBase58()]:               'fbit_mint',
        [reserveVault.toBase58()]:             'env_reserve_vault',
        [ata(rewardMint, platPda).toBase58()]: 'std_ata(fbit,platPda)',
        [funderTokenAccount.toBase58()]:       'funder_ata',
      };
      for (let off = 8; off + 32 <= bytes.length; off++) {
        try {
          const key = new PublicKey(Uint8Array.from(bytes.subarray(off, off + 32))).toBase58();
          if (knownKeys[key]) console.log(`[depositReserve] Platform[${off}] = ${knownKeys[key]}`);
        } catch { /* skip invalid pubkey bytes */ }
      }
    }
  } catch (diagErr) {
    console.warn('[depositReserve] diagnostic scan error:', diagErr);
  }

  // Build instruction manually (bypassing Anchor 0.32 client entirely).
  // disc = sha256("global:deposit_reserve")[0..8]
  const disc      = Buffer.from([187, 75, 224, 96, 122, 233, 220, 121]);
  const amountBuf = toLamports(amount).toArrayLike(Buffer, 'le', 8);
  const instrData = Buffer.concat([disc, amountBuf]);

  const keys = [
    { pubkey: platPda,             isSigner: false, isWritable: true  },
    { pubkey: authority,           isSigner: true,  isWritable: true  },
    { pubkey: funderTokenAccount,  isSigner: false, isWritable: true  },
    { pubkey: reserveVault,        isSigner: false, isWritable: true  },
    { pubkey: TOKEN_PROGRAM_ID,    isSigner: false, isWritable: false },
  ];

  console.log('[depositReserve] RAW tx accounts:', {
    platform:           platPda.toBase58(),
    authority:          authority.toBase58(),
    funderTokenAccount: funderTokenAccount.toBase58(),
    reserveVault:       reserveVault.toBase58(),
    tokenProgram:       TOKEN_PROGRAM_ID.toBase58(),
    amountLamports:     toLamports(amount).toString(),
    disc:               Array.from(disc),
  });

  const instruction = new TransactionInstruction({ keys, programId, data: instrData });

  const connection = getRpcConnection();
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  const legacyTx = new Transaction({ feePayer: authority, recentBlockhash: blockhash });
  legacyTx.add(instruction);

  const signedTx = await wrapSolanaSign(() => wallet.signTransaction(legacyTx));

  let txHash: string;
  try {
    txHash = await connection.sendRawTransaction(signedTx.serialize(), {
      skipPreflight: false,
      preflightCommitment: 'confirmed',
    });
  } catch (sendErr: any) {
    // Surface simulation logs so the exact on-chain error is visible in the console
    console.error('[depositReserve] sendRawTransaction error:', sendErr?.message ?? sendErr);
    if (sendErr?.logs) console.error('[depositReserve] simulation logs:', sendErr.logs);
    throw sendErr;
  }

  await connection.confirmTransaction({ signature: txHash, blockhash, lastValidBlockHeight }, 'confirmed');
  return { txHash };
}

export async function solanaReleaseEmission(): Promise<{ txHash: string }> {
  const program   = getProgram();
  const [platPda] = platformPda();

  // Pre-check: verify that emission is actually available before spending SOL on tx fees.
  // Mirrors the on-chain releasable = min(reserve, annual × elapsed-since-last-release) calculation.
  try {
    const platform: any = await (program.account as any).platform.fetch(platPda);
    const annualEmission = platform.annualEmission ? new BN(platform.annualEmission.toString()).toNumber() : 0;
    const totalReserve   = platform.totalReserve   ? new BN(platform.totalReserve.toString()).toNumber()   : 0;
    if (annualEmission === 0) throw new Error('Annual emission is not configured yet. Set annual emission first.');
    if (totalReserve   === 0) throw new Error('Reserve vault is empty. Deposit tokens first.');
    const emissionStart    = platform.emissionStartTime ? Number(platform.emissionStartTime) : 0;
    const lastRelease      = platform.lastReleaseTime ? Number(platform.lastReleaseTime) : emissionStart;
    if (emissionStart > 0) {
      const elapsed    = Math.max(0, Math.floor(Date.now() / 1000) - lastRelease);
      const releasable = Math.max(0, Math.min(totalReserve, annualEmission * (elapsed / (365 * 24 * 3600))));
      if (releasable < SCALE) throw new Error('No emission available to release yet — wait for more time to accrue.');
    }
  } catch (err: any) {
    // Only block when we computed "nothing to release"; let other errors through (RPC issues etc.)
    if (err?.message?.includes('emission') || err?.message?.includes('Reserve') || err?.message?.includes('No emission')) throw err;
  }

  const reserveVault = getReserveVault();
  const rewardVault  = getRewardVault();

  const tx = await (program.methods as any)
    .releaseEmission()
    .accounts({
      platform:     platPda,
      reserveVault,
      rewardVault,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();

  return { txHash: tx };
}

export async function solanaSetRewardRate(rate: number): Promise<{ txHash: string }> {
  const program  = getProgram();
  const owner    = getOwner();
  const [platPda] = platformPda();
  const tx = await (program.methods as any).setRewardRate(new BN(rate))
    .accounts({ platform: platPda, authority: owner }).rpc();
  return { txHash: tx };
}

export async function solanaSetReferralRewardRate(rate: number): Promise<{ txHash: string }> {
  const program  = getProgram();
  const owner    = getOwner();
  const [platPda] = platformPda();
  const tx = await (program.methods as any).setReferralRewardRate(new BN(rate))
    .accounts({ platform: platPda, authority: owner }).rpc();
  return { txHash: tx };
}

export async function solanaSetReferralPercentages(
  percentages: [number, number, number, number, number, number, number, number, number, number]
): Promise<{ txHash: string }> {
  const program   = getProgram();
  const owner     = getOwner();
  const [platPda] = platformPda();
  const bpsValues = percentages.map((p) => new BN(p));
  const tx = await (program.methods as any).setReferralPercentages(bpsValues)
    .accounts({ platform: platPda, authority: owner }).rpc();
  return { txHash: tx };
}

export async function solanaBlockUser(userAddress: string): Promise<{ txHash: string }> {
  let targetKey: PublicKey;
  try { targetKey = new PublicKey(userAddress); } catch { throw new Error('Invalid Solana address'); }
  const program  = getProgram();
  const owner    = getOwner();
  const [platPda] = platformPda();
  const [targetPda] = userPda(targetKey);
  const tx = await (program.methods as any).blockUser()
    .accounts({ platform: platPda, userAccount: targetPda, authority: owner }).rpc();
  return { txHash: tx };
}

export async function solanaUnblockUser(userAddress: string): Promise<{ txHash: string }> {
  let targetKey: PublicKey;
  try { targetKey = new PublicKey(userAddress); } catch { throw new Error('Invalid Solana address'); }
  const program  = getProgram();
  const owner    = getOwner();
  const [platPda] = platformPda();
  const [targetPda] = userPda(targetKey);
  const tx = await (program.methods as any).unblockUser()
    .accounts({ platform: platPda, userAccount: targetPda, authority: owner }).rpc();
  return { txHash: tx };
}

export interface BlockedUserSummary {
  address: string;
  totalStaked: number;
}

/**
 * Scans every UserAccount PDA on the program (raw getProgramAccounts + manual
 * binary parsing, same approach as solanaGetUserStakes) and returns the ones
 * with isBlocked = true. No backend/indexer exists, so this is the only way
 * to enumerate blocked users — one RPC call, filtered client-side.
 *
 * Binary layout (offsets after 8-byte discriminator):
 *   8–39  : owner (Pubkey, 32 bytes)
 *   40–47 : total_staked (u64 LE)
 *   48–55 : total_rewards_earned (u64 LE)
 *   56–63 : total_referral_rewards (u64 LE)
 *   64    : referrer Option tag (0 = None, 1 = Some) — variable-length field
 *   [65–96 if Some] : referrer Pubkey
 *   next 8: referral_count (u64 LE)
 *   next 1: is_blocked (bool)
 */
export async function solanaGetBlockedUsers(): Promise<BlockedUserSummary[]> {
  try {
    const connection = getRpcConnection();
    const programId  = getProgramId();
    // Server-side discriminator filter — without this, getProgramAccounts returns
    // every account owned by the program (Platform + every UserAccount + every
    // StakeEntry, which usually outnumbers users several-to-one). That single
    // unfiltered call was heavy enough to trip the RPC's rate limit on its own.
    const discriminatorB58 = anchorUtils.bytes.bs58.encode(Buffer.from(ACCOUNT_DISCRIMINATORS.UserAccount));
    const rawAccounts = await connection.getProgramAccounts(programId, {
      filters: [{ memcmp: { offset: 0, bytes: discriminatorB58 } }],
    });

    const blocked: BlockedUserSummary[] = [];
    for (const { account } of rawAccounts) {
      try {
        const bytes = account.data instanceof Uint8Array
          ? account.data
          : new Uint8Array(account.data as unknown as ArrayBuffer);
        if (bytes.length < 74) continue;
        if (!ACCOUNT_DISCRIMINATORS.UserAccount.every((b, i) => bytes[i] === b)) continue;

        const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
        const owner       = new PublicKey(bytes.slice(8, 40)).toBase58();
        const totalStaked = new BN(dv.getBigUint64(40, true).toString());

        let offset = 64;
        const hasReferrer = bytes[offset] === 1;
        offset += 1 + (hasReferrer ? 32 : 0);
        offset += 8; // referral_count
        if (offset >= bytes.length) continue;
        const isBlocked = bytes[offset] === 1;

        if (isBlocked) blocked.push({ address: owner, totalStaked: fromLamports(totalStaked) });
      } catch { /* skip individual parse failures */ }
    }
    return blocked;
  } catch (err) {
    console.error('[solanaGetBlockedUsers] error:', err);
    return [];
  }
}

export async function solanaTogglePause(): Promise<{ txHash: string }> {
  const program  = getProgram();
  const owner    = getOwner();
  const [platPda] = platformPda();
  const tx = await (program.methods as any).togglePause()
    .accounts({ platform: platPda, authority: owner }).rpc();
  return { txHash: tx };
}

export async function solanaSetAnnualEmission(annualEmission: number): Promise<{ txHash: string }> {
  const program   = getProgram();
  const authority = getOwner();
  const [platPda] = platformPda();
  const tx = await (program.methods as any)
    .setAnnualEmission(toLamports(annualEmission))
    .accounts({ platform: platPda, authority })
    .rpc();
  return { txHash: tx };
}

export async function solanaSetBurnBps(burnBps: number): Promise<{ txHash: string }> {
  if (burnBps > 5000) throw new Error('burnBps exceeds maximum (5000 = 50%)');
  const program   = getProgram();
  const authority = getOwner();
  const [platPda] = platformPda();
  const tx = await (program.methods as any)
    .setBurnBps(new BN(burnBps))
    .accounts({ platform: platPda, authority })
    .rpc();
  return { txHash: tx };
}

/**
 * Update a Team Target Bonus tier.
 * @param index          Tier index 0–9
 * @param minTeamStaked  Minimum team total staked in token units (not lamports)
 * @param bonusBps       Bonus in basis points (max 1000 = 10 %)
 */
export async function solanaSetTeamTargetTier(
  index: number,
  minTeamStaked: number,
  bonusBps: number
): Promise<{ txHash: string }> {
  const program   = getProgram();
  const owner     = getOwner();
  const [platPda] = platformPda();
  const tx = await (program.methods as any)
    .setTeamTargetTier(index, toLamports(minTeamStaked), new BN(bonusBps))
    .accounts({ platform: platPda, authority: owner })
    .rpc();
  return { txHash: tx };
}

/**
 * Set the fallback base APY for the single lock period (index 0).
 * Only applies when annual_emission is 0 — PoS emission overrides this.
 * apyBps: basis points (e.g. 6000 = 60%)
 */
export async function solanaSetBatchApy(apyBps: number): Promise<{ txHash: string }> {
  if (apyBps < 1_000 || apyBps > 30_000) throw new Error('Base APY must be 1000–30000 BPS (10%–300%)');
  const program   = getProgram();
  const owner     = getOwner();
  const [platPda] = platformPda();
  const tx = await (program.methods as any)
    .setBatchApy([new BN(apyBps)])
    .accounts({ platform: platPda, authority: owner })
    .rpc();
  return { txHash: tx };
}

/**
 * Permanently renounce ownership. Only callable by current authority.
 * After this call, all admin functions are locked and a 25% passive fee
 * is paid to the former owner on every claim/compound.
 */
export async function solanaRenounceOwnership(): Promise<{ txHash: string }> {
  const program   = getProgram();
  const authority = getOwner();
  const [platPda] = platformPda();
  const tx = await (program.methods as any)
    .renounceOwnership()
    .accounts({ platform: platPda, authority })
    .rpc();
  return { txHash: tx };
}


// ── Read-only helpers ──────────────────────────────────────────────────────────

/** Returns a read-only Anchor program instance (no wallet signer required). */
// Use the same Helius RPC configured for writes — publicnode.com doesn't support
// getProgramAccounts with filters, which breaks stake fetching.
const READ_RPC = NETWORK_CONFIG.solana.rpcUrl;

// Rate limiter — prevents 429s on the Helius free tier (10 RPS cap).
// A pure concurrency cap (e.g. "max 5 in flight") does NOT bound requests/sec:
// if 5 fast requests each resolve in ~50ms, the queue can still dispatch well
// over 10/sec. This instead spaces every dispatched request at least ~120ms
// apart (≈8/sec ceiling), regardless of how many are queued or how fast they
// resolve — the actual constraint the RPC provider enforces.
const _RPC_MIN_INTERVAL_MS = 120;
const _rpcQueue: Array<() => void> = [];
let _rpcTimer: ReturnType<typeof setTimeout> | null = null;
let _rpcLastDispatch = 0;

function _rpcPump(): void {
  if (_rpcTimer || _rpcQueue.length === 0) return;
  const wait = Math.max(0, _rpcLastDispatch + _RPC_MIN_INTERVAL_MS - Date.now());
  _rpcTimer = setTimeout(() => {
    _rpcTimer = null;
    _rpcLastDispatch = Date.now();
    _rpcQueue.shift()?.();
    _rpcPump();
  }, wait);
}

function rpcFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    _rpcQueue.push(() => fetch(input, init).then(resolve, reject));
    _rpcPump();
  });
}

export function getRpcConnection(): Connection {
  return new Connection(READ_RPC, { commitment: 'confirmed', fetch: rpcFetch });
}

function getReadOnlyProgram(): Program {
  const connection = getRpcConnection();
  const noopWallet = {
    publicKey: new PublicKey('11111111111111111111111111111111'),
    signTransaction: async (tx: any) => tx,
    signAllTransactions: async (txs: any[]) => txs,
  };
  const provider = new AnchorProvider(connection, noopWallet as any, { commitment: 'confirmed' });
  const idl = patchIdl(IDL, getProgramId().toBase58());
  return new (Program as any)(idl, provider) as Program;
}

/**
 * Fetch all active StakeEntry accounts for a given owner.
 * Uses raw getProgramAccounts + manual binary parsing to avoid any
 * Anchor IDL deserializer failures (IDL version mismatches, BorshCoder errors, etc).
 *
 * Binary layout (offsets after 8-byte discriminator):
 *   8–39  : owner (Pubkey, 32 bytes)
 *   40–47 : amount (u64 LE)
 *   48    : lock_period_index (u8)
 *   49–56 : staked_at (i64 LE)
 *   57–64 : unlock_at (i64 LE)
 *   65–72 : last_claim_at (i64 LE)
 *   73–80 : total_claimed (u64 LE)
 *   81    : is_active (bool)
 *   82–89 : apy (u64 LE)
 *   90–97 : stake_id (u64 LE) — only in 99-byte accounts
 *   98    : bump (u8)  — offset 90 in 91-byte accounts
 */
export async function solanaGetUserStakes(ownerAddress: string): Promise<StakeEntry[] | null> {
  try {
    const owner      = new PublicKey(ownerAddress);
    const connection = getRpcConnection();
    const programId  = getProgramId();

    const rawAccounts = await connection.getProgramAccounts(programId, {
      filters: [{ memcmp: { offset: 8, bytes: owner.toBase58() } }],
    });

    console.info(`[solanaGetUserStakes] raw scan: ${rawAccounts.length} owner-matched accounts`);

    const stakes: StakeEntry[] = [];
    for (const { account } of rawAccounts) {
      try {
        // Use Uint8Array + DataView — Buffer.readBigUInt64LE is not available in browser polyfills
        const bytes = account.data instanceof Uint8Array
          ? account.data
          : new Uint8Array(account.data as unknown as ArrayBuffer);
        const len = bytes.length;
        if (len < 91) continue;

        // Verify StakeEntry discriminator
        if (!ACCOUNT_DISCRIMINATORS.StakeEntry.every((b, i) => bytes[i] === b)) continue;

        const dv           = new DataView(bytes.buffer, bytes.byteOffset, len);
        const amount       = new BN(dv.getBigUint64(40, true).toString());
        const lockPeriodIdx = bytes[48];
        const stakedAt     = Number(dv.getBigInt64(49, true));
        const unlockAt     = Number(dv.getBigInt64(57, true));
        const lastClaimAt  = Number(dv.getBigInt64(65, true));
        const totalClaimed = new BN(dv.getBigUint64(73, true).toString());
        const isActive     = bytes[81] === 1;
        const apy          = Number(dv.getBigUint64(82, true));
        const stakeId      = len >= 99 ? Number(dv.getBigUint64(90, true)) : stakedAt;

        stakes.push({
          id:              stakeId,
          amount:          fromLamports(amount),
          lockPeriodIndex: lockPeriodIdx,
          stakedAt,
          unlockAt,
          lastClaimAt,
          totalClaimed:    fromLamports(totalClaimed),
          isActive,
          apy,
        });
      } catch (parseErr) {
        console.warn('[solanaGetUserStakes] parse error for one account:', parseErr);
      }
    }

    console.info(`[solanaGetUserStakes] parsed ${stakes.length} stakes (active + inactive)`);
    return stakes;
  } catch (err) {
    console.error('[solanaGetUserStakes] error:', err);
    return null;
  }
}

// Raw JSON-RPC helper — bypasses @solana/web3.js Connection to avoid URL
// manipulation issues with the Next.js dev proxy (trailingSlash redirect).
// 8-second timeout per endpoint so a hanging gateway (e.g. 504) doesn't block the fallback chain.
async function rpcCall(endpoint: string, method: string, params: unknown[]): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const res = await rpcFetch(endpoint, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal:  controller.signal,
    });
    if (!res.ok) throw new Error(`RPC ${res.status}`);
    const json = await res.json();
    if (json.error) throw new Error(json.error.message ?? 'RPC error');
    return json.result;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch the FBiT SPL token balance for a wallet address.
 *
 * Strategy: compute the Associated Token Account (ATA) directly and call
 * getTokenAccountBalance — a single targeted lookup that is faster and less
 * rate-limited than a full getTokenAccountsByOwner scan.
 * Falls back through multiple RPC endpoints with an 8 s timeout each.
 * Returns 0 if the wallet has no ATA for this mint or all endpoints fail.
 */
export async function solanaGetTokenBalance(ownerAddress: string): Promise<number> {
  if (!ownerAddress || ownerAddress.startsWith('0x')) return 0;
  const stakeTokenAddr = NETWORK_CONFIG.solana.stakeTokenAddress;
  if (!stakeTokenAddr || stakeTokenAddr.length < 10 || stakeTokenAddr.toUpperCase().startsWith('YOUR_')) return 0;

  let owner: PublicKey, mint: PublicKey;
  try {
    owner = new PublicKey(ownerAddress);
    mint  = new PublicKey(stakeTokenAddr);
  } catch { return 0; }

  // Derive ATA — deterministic, no RPC call needed
  const ataAddress = ata(mint, owner).toBase58();

  const endpoints = [
    READ_RPC,                               // publicnode (primary)
    'https://api.mainnet-beta.solana.com',  // Solana Foundation fallback
    NETWORK_CONFIG.solana.rpcUrl,           // custom RPC from env (deduped if same as above)
  ].filter((u, i, a) => u && a.indexOf(u) === i);

  for (const rpc of endpoints) {
    try {
      const result = await rpcCall(rpc, 'getTokenAccountBalance', [ataAddress]);
      // result.value.uiAmount is null if account has 0 balance; treat as 0
      return result?.value?.uiAmount ?? 0;
    } catch {
      // account not found or RPC error — try next endpoint
    }
  }
  return 0;
}

/** Native SOL balance (in SOL, not lamports) for the swap widget's "from" balance display. */
export async function solanaGetSolBalance(ownerAddress: string): Promise<number> {
  if (!ownerAddress || ownerAddress.startsWith('0x')) return 0;
  try {
    const owner = new PublicKey(ownerAddress);
    const lamports = await getRpcConnection().getBalance(owner, 'confirmed');
    return lamports / 1_000_000_000;
  } catch {
    return 0;
  }
}

export async function solanaGetUserAccount(ownerAddress: string): Promise<UserAccount | null> {
  try {
    const program = getReadOnlyProgram();
    const owner = new PublicKey(ownerAddress);
    const [pda] = userPda(owner);
    const acc = await (program.account as any).userAccount.fetch(pda);
    const teamTotalStaked = acc.teamTotalStaked ? fromLamports(acc.teamTotalStaked) : 0;

    // Derive current team bonus tier from the on-chain platform data (teamTierMinStaked/teamTierBonusBps).
    // Falls back to the hardcoded TEAM_TARGET_TIERS constants when the platform fetch fails.
    let currentTierBonusBps = 0;
    try {
      const [platPda] = platformPda();
      const platform: any = await (getReadOnlyProgram().account as any).platform.fetch(platPda);
      if (platform.teamTierMinStaked && platform.teamTierBonusBps) {
        for (let i = platform.teamTierMinStaked.length - 1; i >= 0; i--) {
          if (platform.teamTierMinStaked[i] != null && teamTotalStaked >= fromLamports(platform.teamTierMinStaked[i])) {
            currentTierBonusBps = Number(platform.teamTierBonusBps[i]);
            break;
          }
        }
      } else {
        const { TEAM_TARGET_TIERS: tiers } = await import('@/types');
        for (let i = tiers.length - 1; i >= 0; i--) {
          if (teamTotalStaked >= tiers[i].minTeamStaked) { currentTierBonusBps = tiers[i].bonusBps; break; }
        }
      }
    } catch {
      const { TEAM_TARGET_TIERS: tiers } = await import('@/types');
      for (let i = tiers.length - 1; i >= 0; i--) {
        if (teamTotalStaked >= tiers[i].minTeamStaked) { currentTierBonusBps = tiers[i].bonusBps; break; }
      }
    }

    return {
      address:              ownerAddress,
      totalStaked:          fromLamports(acc.totalStaked),
      totalRewardsEarned:   fromLamports(acc.totalRewardsEarned),
      totalReferralRewards: fromLamports(acc.totalReferralRewards),
      referrer:             acc.referrer ? acc.referrer.toBase58() : null,
      referralCount:        acc.referralCount.toNumber(),
      teamSize:             acc.teamSize    ? acc.teamSize.toNumber()          : 0,
      teamTotalStaked,
      isBlocked:            acc.isBlocked,
      registeredAt:         acc.registeredAt.toNumber(),
      currentTierBonusBps,
    };
  } catch {
    return null;
  }
}

// Shared BFS helper: fetches all UserAccount PDAs once, builds a referrer→children
// map, then walks L1–L10 from ownerAddress. Returns all ReferralEntry records.
// liveBps: on-chain referral percentages in BPS — falls back to REFERRAL_BPS constants.
async function bfsReferralTree(ownerAddress: string, liveBps?: number[]): Promise<import('@/types').ReferralEntry[]> {
  const bpsArray = (liveBps && liveBps.length === 10) ? liveBps : [...REFERRAL_BPS];

  // Use cached/deduped fetch — avoids hammering RPC when multiple components poll.
  const allDecoded: any[] = await getAllUserAccounts();

  // Build referrerKey → [{address, staked, registeredAt}] map
  type ChildMeta = { address: string; staked: number; registeredAt: number };
  const referrerMap = new Map<string, ChildMeta[]>();

  for (const item of allDecoded) {
    try {
      const ref: PublicKey | null = item.account.referrer ?? null;
      if (!ref) continue;
      const referrerKey  = ref.toBase58();
      const ownerKey     = item.account.owner.toBase58();
      const staked       = fromLamports(item.account.totalStaked);
      const registeredAt = item.account.registeredAt?.toNumber?.() ?? 0;
      if (!referrerMap.has(referrerKey)) referrerMap.set(referrerKey, []);
      referrerMap.get(referrerKey)!.push({ address: ownerKey, staked, registeredAt });
    } catch { /* skip malformed */ }
  }

  // BFS from ownerAddress through up to 10 levels
  const result: import('@/types').ReferralEntry[] = [];
  const seen = new Set<string>([ownerAddress]);
  let currentLevel: string[] = [ownerAddress];

  for (let level = 1; level <= 10 && currentLevel.length > 0; level++) {
    const nextLevel: string[] = [];
    for (const parentKey of currentLevel) {
      for (const child of referrerMap.get(parentKey) ?? []) {
        if (seen.has(child.address)) continue;
        seen.add(child.address);
        nextLevel.push(child.address);
        result.push({
          address:      child.address,
          level,
          stakedAmount: child.staked,
          rewardEarned: child.staked * bpsArray[level - 1] / 10_000,
          registeredAt: child.registeredAt,
          directReferrals: (referrerMap.get(child.address) ?? []).length,
        });
      }
    }
    currentLevel = nextLevel;
  }

  return result;
}

export async function solanaGetReferralInfo(ownerAddress: string): Promise<ReferralInfo | null> {
  try {
    const program    = getReadOnlyProgram();
    const owner      = new PublicKey(ownerAddress);
    const [pda]      = userPda(owner);
    const acc        = await (program.account as any).userAccount.fetch(pda);
    const totalReferrals       = acc.referralCount.toNumber();
    const totalReferralRewards = fromLamports(acc.totalReferralRewards);

    // Fetch live referral percentages from platform — use for reward calculations
    // so the displayed rewards reflect admin-updated on-chain BPS values.
    let liveBps: number[] | undefined;
    try {
      const [platPda] = platformPda();
      const platform: any = await (program.account as any).platform.fetch(platPda);
      if (Array.isArray(platform.referralPercentages) && platform.referralPercentages.length === 10) {
        const parsed = platform.referralPercentages.map((v: any) => Number(v.toString()));
        if (parsed.some((v: number) => v > 0)) liveBps = parsed;
      }
    } catch { /* use fallback */ }

    // Fetch all UserAccount PDAs once via Anchor's own decoder — avoids hardcoded
    // byte offsets (the deployed account is 152 bytes; the IDL predicted 139).
    // Run BFS inline so the auto-poll already returns all L1–L10 levels.
    const connection = getRpcConnection();
    const programId  = getProgramId();
    let referrals: import('@/types').ReferralEntry[] = [];
    try {
      const allDecoded: any[] = await getAllUserAccounts();

      // Build referrerKey → [{address, staked, registeredAt}] map from decoded data
      type ChildMeta = { address: string; staked: number; registeredAt: number };
      const referrerMap = new Map<string, ChildMeta[]>();
      for (const item of allDecoded) {
        try {
          const ref: PublicKey | null = item.account.referrer ?? null;
          if (!ref) continue;
          const referrerKey  = ref.toBase58();
          const ownerKey     = item.account.owner.toBase58();
          const staked       = fromLamports(item.account.totalStaked);
          const registeredAt = item.account.registeredAt?.toNumber?.() ?? 0;
          if (!referrerMap.has(referrerKey)) referrerMap.set(referrerKey, []);
          referrerMap.get(referrerKey)!.push({ address: ownerKey, staked, registeredAt });
        } catch { /* skip */ }
      }

      // BFS from ownerAddress through up to 10 levels
      const seen = new Set<string>([ownerAddress]);
      let currentLevel: string[] = [ownerAddress];
      for (let level = 1; level <= 10 && currentLevel.length > 0; level++) {
        const nextLevel: string[] = [];
        for (const parentKey of currentLevel) {
          for (const child of referrerMap.get(parentKey) ?? []) {
            if (seen.has(child.address)) continue;
            seen.add(child.address);
            nextLevel.push(child.address);
            referrals.push({
              address:      child.address,
              level,
              stakedAmount: child.staked,
              rewardEarned: child.staked * (liveBps ? liveBps[level - 1] : REFERRAL_BPS[level - 1]) / 10_000,
              registeredAt: child.registeredAt,
              directReferrals: (referrerMap.get(child.address) ?? []).length,
            });
          }
        }
        currentLevel = nextLevel;
      }
    } catch {
      // Fallback: memcmp L1-only scan if Anchor all() fails
      const rawL1 = await connection.getProgramAccounts(programId, {
        filters: [{ memcmp: { offset: 65, bytes: owner.toBase58() } }],
      });
      const userAccDisc = Buffer.from(ACCOUNT_DISCRIMINATORS.UserAccount);
      referrals = rawL1.flatMap(({ account }) => {
        try {
          const raw = Buffer.from(account.data);
          if (!raw.subarray(0, 8).equals(userAccDisc)) return [];
          const slice = raw.subarray(8);
          const childKey     = new PublicKey(Uint8Array.from(slice.subarray(0, 32))).toBase58();
          const staked       = Number(slice.readBigUInt64LE(32)) / SCALE;
          const registeredAt = Number(slice.readBigInt64LE(98));
          return [{ address: childKey, level: 1, stakedAmount: staked, rewardEarned: 0, registeredAt, directReferrals: 0 }];
        } catch { return []; }
      });
    }

    // Direct referrals = L1 only; totalReferrals is the on-chain count or scan count
    const directCount = referrals.filter(r => r.level === 1).length;
    return {
      totalReferrals:       Math.max(totalReferrals, directCount),
      totalReferralRewards,
      referralLink: '',
      referrals,
      chain:        [],
    };
  } catch {
    return null;
  }
}

/**
 * Full multi-level referral tree for a wallet (L1–L10).
 * Uses a single getProgramAccounts call + BFS — no N+1 queries.
 */
export async function solanaGetFullReferralTree(ownerAddress: string): Promise<import('@/types').ReferralEntry[]> {
  let liveBps: number[] | undefined;
  try {
    const program = getReadOnlyProgram();
    const [platPda] = platformPda();
    const platform: any = await (program.account as any).platform.fetch(platPda);
    if (Array.isArray(platform.referralPercentages) && platform.referralPercentages.length === 10) {
      const parsed = platform.referralPercentages.map((v: any) => Number(v.toString()));
      if (parsed.some((v: number) => v > 0)) liveBps = parsed;
    }
  } catch { /* use fallback */ }
  return bfsReferralTree(ownerAddress, liveBps);
}

/**
 * Admin / crank: update a user's team_size and team_total_staked on-chain.
 * Called after indexing stake/unstake events.
 */
export async function solanaUpdateUserTeamStats(
  userAddress: string,
  teamSize: number,
  teamTotalStaked: number
): Promise<{ txHash: string }> {
  const program   = getProgram();
  const owner     = getOwner();
  const [platPda] = platformPda();
  const targetKey = new PublicKey(userAddress);
  const [targetPda] = userPda(targetKey);
  const tx = await (program.methods as any)
    .updateUserTeamStats(new BN(teamSize), toLamports(teamTotalStaked))
    .accounts({ platform: platPda, userAccount: targetPda, authority: owner })
    .rpc();
  return { txHash: tx };
}

// ── On-chain history ───────────────────────────────────────────────────────────

// Anchor logs instruction names as the CamelCase IDL name: "Instruction: ClaimRewards" etc.
const INSTRUCTION_TYPE_MAP: Record<string, import('@/types').TxRecord['type']> = {
  'Instruction: Stake':          'stake',
  'Instruction: ClaimRewards':   'claim',
  'Instruction: CompoundRewards': 'compound',
  'Instruction: Unstake':        'unstake',
};

/**
 * Fetch on-chain activity for a wallet from the Solana staking program.
 * Looks up signatures for the user's PDA (involved in all staking txns).
 * Returns TxRecord[] sorted newest-first.
 */
export async function solanaGetOnChainHistory(address: string): Promise<import('@/types').TxRecord[]> {
  const programAddr = NETWORK_CONFIG.solana.contractAddress;
  if (!programAddr || programAddr.toUpperCase().startsWith('YOUR_')) return [];

  try {
    const connection = getRpcConnection();
    const owner = new PublicKey(address);
    const [userAccPda] = userPda(owner);

    const sigs = await connection.getSignaturesForAddress(userAccPda, { limit: 100 });
    const validSigs = sigs.filter(s => !s.err);
    const records: import('@/types').TxRecord[] = [];

    // Batched RPC calls (chunks of 50) instead of one getParsedTransaction per
    // signature — firing up to 100 individual requests at once used to trip
    // the RPC provider's rate limit.
    const CHUNK = 50;
    const txs: (Awaited<ReturnType<typeof connection.getParsedTransactions>>[number])[] = [];
    for (let i = 0; i < validSigs.length; i += CHUNK) {
      const slice = validSigs.slice(i, i + CHUNK);
      try {
        const res = await connection.getParsedTransactions(
          slice.map(s => s.signature),
          { maxSupportedTransactionVersion: 0, commitment: 'confirmed' },
        );
        txs.push(...res);
      } catch {
        txs.push(...slice.map(() => null));
      }
    }

    validSigs.forEach((sig, i) => {
      try {
        const tx = txs[i];
        if (!tx) return;

          const logs: string[] = tx.meta?.logMessages ?? [];
          const ts = (sig.blockTime ?? 0) * 1000;

          let type: import('@/types').TxRecord['type'] | null = null;
          for (const log of logs) {
            for (const [key, val] of Object.entries(INSTRUCTION_TYPE_MAP)) {
              if (log.includes(key)) { type = val; break; }
            }
            if (type) break;
          }
          if (!type) return;

          // Determine the token amount involved in this tx.
          let amount = 0;
          const preBalances  = tx.meta?.preTokenBalances  ?? [];
          const postBalances = tx.meta?.postTokenBalances ?? [];
          const stakeMint  = NETWORK_CONFIG.solana.stakeTokenAddress;
          const rewardMint = NETWORK_CONFIG.solana.rewardTokenAddress || stakeMint;

          if (type === 'stake' || type === 'unstake') {
            // Stake/unstake: user's stake-token wallet ATA changes
            const pre  = preBalances.find(b => b.mint === stakeMint && b.owner === address);
            const post = postBalances.find(b => b.mint === stakeMint && b.owner === address);
            amount = Math.abs((post?.uiTokenAmount?.uiAmount ?? 0) - (pre?.uiTokenAmount?.uiAmount ?? 0));
          } else if (type === 'claim') {
            // Claim: reward_vault → user's reward-token ATA.
            // Pre-balance may be missing (ATA created on first claim) — treat as 0.
            const pre  = preBalances.find(b => b.mint === rewardMint && b.owner === address);
            const post = postBalances.find(b => b.mint === rewardMint && b.owner === address);
            amount = Math.max(0, (post?.uiTokenAmount?.uiAmount ?? 0) - (pre?.uiTokenAmount?.uiAmount ?? 0));
            // If reward mint = stake mint and nothing found, try stake mint explicitly
            if (amount === 0 && rewardMint !== stakeMint) {
              const preS  = preBalances.find(b => b.mint === stakeMint && b.owner === address);
              const postS = postBalances.find(b => b.mint === stakeMint && b.owner === address);
              amount = Math.max(0, (postS?.uiTokenAmount?.uiAmount ?? 0) - (preS?.uiTokenAmount?.uiAmount ?? 0));
            }
          }
          // compound: no token reaches user wallet — amount stays 0;
          // the compound_amount is pure on-chain accounting (stake_entry.amount += compound_amount).

          const labelMap: Record<string, string> = {
            stake:    'Staked FBiT on Solana',
            claim:    'Claimed rewards on Solana',
            compound: 'Compounded rewards on Solana',
            unstake:  'Unstaked FBiT on Solana',
          };

          records.push({
            id: `sol-${sig.signature}`,
            type,
            label: labelMap[type],
            amount,
            txHash: sig.signature,
            timestamp: ts,
            status: 'success',
            network: 'solana',
          });
      } catch {
        // skip individual tx parse failures
      }
    });

    return records.sort((a, b) => b.timestamp - a.timestamp);
  } catch {
    return [];
  }
}

/**
 * Scan the user's UserAccount PDA for transactions where someone else staked
 * and our ATA received a referral reward payout.
 * Returns TxRecord[] of type 'referral', sorted newest-first.
 */
export async function solanaGetReferralOnChainHistory(
  address: string
): Promise<import('@/types').TxRecord[]> {
  const programAddr = NETWORK_CONFIG.solana.contractAddress;
  if (!programAddr || programAddr.toUpperCase().startsWith('YOUR_')) return [];
  const rewardMint = NETWORK_CONFIG.solana.rewardTokenAddress;
  if (!rewardMint || rewardMint.toUpperCase().startsWith('YOUR_')) return [];
  try {
    const connection = getRpcConnection();
    const owner      = new PublicKey(address);
    const [accPda]   = userPda(owner);

    // Scan the last 200 signatures touching our UserAccount PDA.
    // When a referee stakes, our UserAccount PDA is passed as remaining_accounts
    // so it appears in this signature list — that's how we detect referral events.
    const sigs = await connection.getSignaturesForAddress(accPda, { limit: 200 });
    const validSigs = sigs.filter(s => !s.err);
    const records: import('@/types').TxRecord[] = [];

    // Batched RPC calls (chunks of 50) instead of one getParsedTransaction per
    // signature — up to 200 individual requests used to trip the RPC rate limit.
    const BATCH = 50;
    const txs: (Awaited<ReturnType<typeof connection.getParsedTransactions>>[number])[] = [];
    for (let i = 0; i < validSigs.length; i += BATCH) {
      const slice = validSigs.slice(i, i + BATCH);
      try {
        const res = await connection.getParsedTransactions(
          slice.map(s => s.signature),
          { maxSupportedTransactionVersion: 0, commitment: 'confirmed' },
        );
        txs.push(...res);
      } catch {
        txs.push(...slice.map(() => null));
      }
    }

    validSigs.forEach((sig, i) => {
      try {
        const tx = txs[i];
        if (!tx) return;

            const logs: string[] = tx.meta?.logMessages ?? [];
            // Only stake instructions distribute referral rewards
            if (!logs.some(l => l.includes('Instruction: Stake'))) return;

            // The fee-payer of the transaction is the staker
            const msg    = tx.transaction.message as any;
            const payerPubkey = msg.accountKeys?.[0]?.pubkey;
            const payer: string = typeof payerPubkey === 'string'
              ? payerPubkey
              : payerPubkey?.toBase58?.() ?? '';
            // Skip our own stake transactions — only other wallets staking triggers referral pay
            if (!payer || payer === address) return;

            // Measure change in our reward-mint ATA balance
            const preAmt  = (tx.meta?.preTokenBalances  ?? [])
              .find(b => b.mint === rewardMint && b.owner === address)
              ?.uiTokenAmount.uiAmount ?? 0;
            const postAmt = (tx.meta?.postTokenBalances ?? [])
              .find(b => b.mint === rewardMint && b.owner === address)
              ?.uiTokenAmount.uiAmount ?? 0;

            const diff = postAmt - preAmt;
            if (diff <= 0) return; // no referral credit in this tx

            records.push({
              id:        `sol-ref-${sig.signature}`,
              type:      'referral',
              label:     `Referral reward — ${payer.slice(0, 6)}...${payer.slice(-4)} staked`,
              amount:    diff,
              txHash:    sig.signature,
              timestamp: (sig.blockTime ?? 0) * 1000,
              status:    'success',
              network:   'solana',
            });
      } catch { /* skip individual parse failures */ }
    });

    return records.sort((a, b) => b.timestamp - a.timestamp);
  } catch {
    return [];
  }
}

// ── Custom Jupiter Swap (Quote API + Swap API, no embedded widget) ────────────
//
// Uses Jupiter's public REST API directly instead of the Jupiter Terminal
// script/iframe: a plain fetch() for a quote, another fetch() to build the
// transaction, then the same wallet-signing path as the rest of this file
// (getSolanaWallet / wrapSolanaSign) to sign and broadcast it.

// quote-api.jup.ag (v6) was retired — Jupiter's free-tier API now lives at lite-api.jup.ag.
const JUPITER_QUOTE_API = 'https://lite-api.jup.ag/swap/v1/quote';
const JUPITER_SWAP_API  = 'https://lite-api.jup.ag/swap/v1/swap';

// ── Platform fee (Jupiter Referral Program — referral.jup.ag) ─────────────────
// Earns 1% of every swap. Referral Account: 4NNtPCmZyHyWhBfizg5qsTmkwDjjFD7NSJNb741WCdoj
// Fee accounts are PDAs derived per-mint from that referral account (seeds:
// ["referral_ata", referralAccount, mint] under REFER4ZgmyYx9c6He5XfaTMiGfdLwRnkV4RPp9t9iF3) —
// each must be created once via contracts/solana/scripts/init-jupiter-fee-account.ts before
// it can receive fees for a given mint. If the FBiT mint changes again in the future, a new
// entry must be derived + initialized here.
const JUPITER_PLATFORM_FEE_BPS = 100; // 1%
const JUPITER_FEE_ACCOUNTS: Record<string, string> = {
  '5uJ8rkiqEs5uzERCqVw9a1eC6BkP54MZAF3D229dyoME': '13hrwob6eBoMfdvQbTEJpAqqm3kKtLuhuZqc9EtM1KcE', // FBiT
  'So11111111111111111111111111111111111111112': '4aaKboEE2EsD46BR8wBhCuoLpnBiW2WcJNsUM3mx6bbB', // SOL
};

export interface JupiterQuote {
  inputMint:      string;
  outputMint:     string;
  inAmountRaw:    string;   // smallest-unit integer string
  outAmountRaw:   string;   // smallest-unit integer string
  priceImpactPct: number;
  slippageBps:    number;
  raw: unknown; // full quote response — passed back to the swap endpoint as-is
}

/** Fetch a swap quote. `amountRaw` is the input amount in the token's smallest unit (integer string). */
export async function jupiterGetQuote(
  inputMint: string,
  outputMint: string,
  amountRaw: string,
  slippageBps = 50,
): Promise<JupiterQuote> {
  const params = new URLSearchParams({
    inputMint, outputMint, amount: amountRaw,
    slippageBps: String(slippageBps),
  });
  // Only request a platform fee when we have a matching fee account for the output mint —
  // Jupiter requires the /swap call to supply a feeAccount whenever the quote had one.
  if (JUPITER_FEE_ACCOUNTS[outputMint]) {
    params.set('platformFeeBps', String(JUPITER_PLATFORM_FEE_BPS));
  }
  const res = await fetch(`${JUPITER_QUOTE_API}?${params.toString()}`);
  const data = await res.json().catch(() => null);
  if (!res.ok || !data || data.error) {
    if (data?.errorCode === 'TOKEN_NOT_TRADABLE') {
      throw new Error(
        'This swap route is not available on Jupiter right now — please try again in a moment.'
      );
    }
    throw new Error(data?.error ?? 'No swap route found for this pair/amount.');
  }
  return {
    inputMint, outputMint,
    inAmountRaw:    String(data.inAmount),
    outAmountRaw:   String(data.outAmount),
    priceImpactPct: Number(data.priceImpactPct ?? 0),
    slippageBps,
    raw: data,
  };
}

/** Build, sign, and broadcast the swap transaction for a previously-fetched quote. */
export async function jupiterExecuteSwap(quote: JupiterQuote): Promise<{ txHash: string }> {
  const owner      = getOwner();
  const wallet     = getSolanaWallet();
  const connection = getRpcConnection();

  const feeAccount = JUPITER_FEE_ACCOUNTS[quote.outputMint];

  const swapRes = await fetch(JUPITER_SWAP_API, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      quoteResponse:              quote.raw,
      userPublicKey:              owner.toBase58(),
      wrapAndUnwrapSol:           true,
      dynamicComputeUnitLimit:    true,
      prioritizationFeeLamports:  'auto',
      ...(feeAccount ? { feeAccount } : {}),
    }),
  });
  const swapData = await swapRes.json().catch(() => null);
  if (!swapRes.ok || !swapData?.swapTransaction) {
    throw new Error(swapData?.error ?? 'Failed to build swap transaction. Please try again.');
  }

  const txBytes = Uint8Array.from(atob(swapData.swapTransaction), c => c.charCodeAt(0));
  const tx = VersionedTransaction.deserialize(txBytes);

  const signedTx: VersionedTransaction = await wrapSolanaSign(() => wallet.signTransaction(tx));
  const rawTx = signedTx.serialize();

  const signature = await connection.sendRawTransaction(rawTx, { skipPreflight: false, maxRetries: 3 });
  await connection.confirmTransaction(signature, 'confirmed');

  return { txHash: signature };
}

