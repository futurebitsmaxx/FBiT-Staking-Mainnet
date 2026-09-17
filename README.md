# FBiT Staking — Solana DApp

A production-ready, decentralized staking platform for the **FBiT token** on **Solana**. The platform implements Proof-of-Stake (PoS) APY, a 10-level referral commission system, a Team Target Bonus program, a deflationary burn mechanism, and an automated emission reserve — all governed by an on-chain Anchor smart contract.

**Live Demo:** [https://futurebit.in](https://futurebit.in)

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [How It Works — Complete Flow](#2-how-it-works--complete-flow)
3. [Reward & Fee System](#3-reward--fee-system)
4. [10-Level Referral System](#4-10-level-referral-system)
5. [Team Target Bonus](#5-team-target-bonus)
6. [Burn & PoS Emission System](#6-burn--pos-emission-system)
7. [Ownership Renouncement](#7-ownership-renouncement)
8. [Admin Panel](#8-admin-panel)
9. [Smart Contract](#9-smart-contract)
10. [Frontend Architecture](#10-frontend-architecture)
11. [Security System](#11-security-system)
12. [Project Structure](#12-project-structure)
13. [Environment Variables](#13-environment-variables)
14. [Deployment Guide](#14-deployment-guide)
15. [Technology Stack](#15-technology-stack)
16. [Token & Contract Addresses](#16-token--contract-addresses)
17. [Changelog](#17-changelog)

---

## 1. Project Overview

FBiT Staking is a fully on-chain staking DApp where users lock FBiT tokens for **30 days** and earn rewards. The APY is not fixed — it adjusts automatically based on how many tokens are currently staked (Proof-of-Stake model). As more users stake, the APY decreases; as users unstake, the APY rises. The system is designed to be fully autonomous: the admin deposited the full token reserve and **renounced ownership on-chain** (see [Section 7](#7-ownership-renouncement)) — the contract now runs indefinitely with no admin able to change any parameter, ever.

### Core Highlights

| Feature | Details |
|---------|---------|
| Lock Period | 30 days (fixed) |
| Claim Interval | Every 6 hours (4 intervals/day) |
| APY Range | 10% – 300% (auto-adjusting, PoS) |
| Burn Rate | 5% base (of the after-fee reward amount) + up to another 5% from any unpaid claim-referral levels — see the new Claim Referral row below (locked permanently, self-corrected in code — `set_burn_bps` is disabled post-renouncement) |
| Referral Levels | 10 levels deep (one-time, on stake) |
| Referral Total | 17.75% distributed across all 10 levels on stake (live on-chain config, confirmed current; contract's compile-time default is 30% and only applies if this is ever unset) |
| Claim Referral (v2.7) | A *separate* recurring referral layer paid on every claim/compound — levels 1-5 only, 3%/2.5%/2%/1.5%/1% (10% max), carved out of that claim's own after-fee amount, not the pool — see Section 3 |
| Team Bonus | Up to +10% on top of staking rewards |
| Network | Solana Mainnet |
| Platform Fee | 0.25% on all operations, routed to `feeRecipient` now that ownership is renounced (see Section 3) |
| AI Support Chat | Claude-powered widget answering platform FAQs (`/api/support-chat`) |

---

## 2. How It Works — Complete Flow

### Step 1 — Connect Wallet
Users connect their Solana wallet (Phantom, Solflare, Backpack, or any Wallet Standard-compliant wallet) via **Reown AppKit**.

### Step 2 — Register with a Referral Link (Optional)
Before staking, a user can click a referral link (`?ref=<address>`). This stores the referrer on-chain and credits all 10 levels of the referral chain when the user stakes. **The referrer must already have an active stake themselves** (`total_staked > 0`) for their link to work — this is a deliberate security requirement (see the v2.4/v2.6 Changelog entries) that also makes a circular referral chain impossible to construct.

### Step 3 — Stake FBiT Tokens
1. User enters an amount of FBiT tokens.
2. Smart contract deducts a **0.25% platform fee** (routed to `feeRecipient`, the former admin's address — ownership is already renounced on this deployment, see Section 7).
3. Remaining tokens are locked for **30 days**.
4. The contract records the effective APY at stake time for display.
5. The referral chain (up to 10 levels) immediately receives commissions from the reward pool.

### Step 4 — Earn Rewards
Rewards accumulate every **6 hours** (4 intervals/day). Formula:

```
grossReward = stakedAmount × effectiveAPY × intervals / (1,460 × 10,000)

Where:
  effectiveAPY = clamp(ANNUAL_EMISSION × 10,000 / totalStaked, 1_000, 30_000)
                 MIN_APY_BPS = 1,000 (10% floor)   MAX_APY_BPS = 30,000 (300% ceiling)
  intervals    = seconds elapsed / 21,600 (each interval = 6 hours)
  1,460        = total 6-hour intervals in one year (4 × 365)
```

The APY self-adjusts in real time:
- More stakers → lower APY (reward pie splits among more people)
- Fewer stakers → higher APY (each person gets a larger share)

### Step 5 — Claim or Compound Rewards
Every 6 hours the user can:

- **Claim**: Receive net FBiT reward to their wallet
- **Compound**: Re-stake the net reward, increasing their stake (and future earnings)

In both cases, the burn mechanism applies (see Section 3).

### Step 6 — Unstake After 30 Days
Once the lock period expires, the user calls Unstake. The contract:
1. Deducts the same 0.25% fee from the principal (this applies whether ownership is renounced or not — it just routes to `feeRecipient` post-renouncement instead of the admin wallet, see Section 3).
2. Transfers the remaining principal back to the user.

---

## 3. Reward & Fee System

The 0.25% platform fee applies identically on **every** operation (stake, claim, compound, unstake) whether ownership is renounced or not — renouncing only changes *where* it's sent (see below). There is no separate, larger fee that appears after renouncement — an earlier design had one (a 25%-of-gross cut funded from the pool), but it was simplified away in v2.1 in favor of just keeping the platform fee flowing, permanently, to whichever address is entitled to it.

Burn and the new claim-referral layer (v2.7) only apply to **claim** and **compound** — stake and unstake only ever pay the 0.25% fee.

```
Claim / Compound Gross Reward (R)
    │
    ├─ 0.25% Platform Fee  ───────→ Admin wallet (pre-renounce) / feeRecipient (post-renounce)
    │
    └─ 99.75% After Fee (A)
            │
            ├─ 5% Base Burn (A × 5%)  ─────────────────→ Burned on-chain 🔥
            │
            ├─ Up to 10% Claim Referral, levels 1-5 ──→ Referrer wallets (3%/2.5%/2%/1.5%/1%)
            │     (whatever isn't actually paid — no referrer, inactive, blocked,
            │      or a bad ATA — splits 50/50 into extra burn + back to the user)
            │
            └─ Remainder ──────────────────────────────→ User wallet ✅
                (85% of A with a full active 5-level chain, up to 90% of A with none)
```

> **Note:** Ownership on this deployment **has already been renounced** — the platform fee that used to go to the admin wallet now flows permanently to `feeRecipient` (the former admin's address, frozen in at the moment of renouncing) on every operation. It is not a separate pool-funded income stream — it's the exact same fee, just re-routed. The claim-referral layer (see [Section 4](#4-10-level-referral-system)) is entirely separate from this fee and from the one-time stake-time referral — it's carved out of the claiming user's own after-fee reward, never drawn from the pool beyond what that claim already costs it.

### Team Bonus
If the user qualifies for a Team Target Tier (see Section 5), the bonus is added on top of the gross reward before any deductions:

```
totalGross = grossReward + teamBonus
```

---

## 4. 10-Level Referral System

When user A refers user B (and B stakes), users in the referral chain up to 10 levels above B each instantly receive a commission **directly from the reward pool**:

| Level | Commission | Who Receives |
|-------|-----------|-------------|
| 1 | 0.25% | Direct referrer (person who referred the staker) |
| 2 | 0.50% | Referrer's referrer |
| 3 | 1.25% | Level 3 upline |
| 4 | 1.50% | Level 4 upline |
| 5 | 1.75% | Level 5 upline |
| 6 | 2.00% | Level 6 upline |
| 7 | 2.25% | Level 7 upline |
| 8 | 2.50% | Level 8 upline |
| 9 | 2.75% | Level 9 upline |
| 10 | 3.00% | Level 10 upline |
| **Total** | **17.75%** | Distributed instantly on stake (contract default is 30% — an admin lowered this on-chain post-deploy) |

Referral commissions are paid **immediately** when the downstream user stakes — no waiting for claims.

### Claim Referral (v2.7) — a second, separate recurring layer

Independent of the one-time table above, **every claim and compound** also pays the claiming user's referral chain up to 5 levels — funded entirely out of that claim's own after-fee reward, not the pool:

| Level | Commission | Who Receives |
|-------|-----------|-------------|
| 1 | 3.00% | Direct referrer |
| 2 | 2.50% | Referrer's referrer |
| 3 | 2.00% | Level 3 upline |
| 4 | 1.50% | Level 4 upline |
| 5 | 1.00% | Level 5 upline |
| 6-10 | — | Not paid on this layer |
| **Total (max)** | **10.00%** | Only actually paid to levels whose referrer exists, has staked at least once, isn't blocked, and has a valid reward token account |

Any level that can't be paid has its share split 50/50 between extra burn and the claiming user — see [Section 3](#3-reward--fee-system) for the full math and the (slightly unintuitive) consequence that a user with **no** referrer keeps *more* of their own claim than one with a full active 5-level chain above them.

### Referral Link Format
```
https://yourdomain.com/?ref=<wallet_address>
```

---

## 5. Team Target Bonus

On top of base staking rewards, users who build large teams earn an additional bonus multiplier. The bonus is based on the **total FBiT staked by all downline members** (up to 10 referral levels deep):

| Tier | Label | Min Team Staked | Bonus |
|------|-------|----------------|-------|
| 1 | Bronze | 50,000 FBiT | +2% |
| 2 | Silver | 100,000 FBiT | +3% |
| 3 | Gold | 250,000 FBiT | +4% |
| 4 | Platinum | 500,000 FBiT | +5% |
| 5 | Diamond | 1,000,000 FBiT | +6% |
| 6 | Ruby | 2,500,000 FBiT | +7% |
| 7 | Emerald | 5,000,000 FBiT | +7.5% |
| 8 | Sapphire | 10,000,000 FBiT | +8.5% |
| 9 | Obsidian | 20,000,000 FBiT | +9% |
| 10 | Titan | 100,000,000 FBiT | +10% |

The bonus applies automatically on every claim or compound — no user action required.

---

## 6. Burn & PoS Emission System

### Reward Burn (5%–10% per Claim/Compound)
Every time a user claims or compounds, **5% of their after-fee reward is always permanently burned** via an on-chain SPL token burn instruction, with **up to another 5%** burned on top if part of the claim-referral chain (Section 4) can't be paid — that unpaid share splits 50/50 between extra burn and being returned to the user. This is deflationary — it reduces the total circulating supply over time.

- The burn comes from the **user's share** — the reward pool does not pay extra for this.
- `set_burn_bps` is **permanently disabled** — the 5% base rate is fixed in code, not admin-adjustable. (It was admin-adjustable pre-v2.7; that capability no longer exists.)

### Automated Annual Emission Reserve
The contract includes a long-term **emission reserve** system:

1. **Admin deposits** into the reserve allocation (initially 120,000,000 FBiT, topped up to 229,830,026 FBiT as of August 2026).
2. The contract **automatically releases** `ANNUAL_EMISSION` tokens per year from the reserve into the active reward pool.
3. Target: **12,000,000 FBiT/year** → an approximately 19-year nominal runway at the current reserve size.
4. The emission release is triggered automatically on every claim/compound — no cron job needed.

### PoS APY Formula
```
effectiveAPY (bps) = clamp(
    ANNUAL_EMISSION × 10,000 / totalStaked,
    1_000, 30_000
)

MIN_APY_BPS = 1,000 (10% floor)   MAX_APY_BPS = 30,000 (300% ceiling)
```

When no one is staking: APY sits at the 300% ceiling (attracts stakers).
As more tokens are staked: APY decreases automatically toward the 10% floor.

---

## 7. Ownership Renouncement

The admin can call **Renounce Ownership** from the Admin Panel. This is a **one-way, irreversible action** — and **it has already been called on this deployment**: `Platform.is_renounced` is `true` on-chain, and `Platform.authority` is permanently zeroed out.

| Before Renounce | After Renounce (current state) |
|----------------|----------------|
| 0.25% fee on all operations → admin wallet | Same 0.25% fee → `feeRecipient` (the former admin's address, frozen in at the moment of renouncing) |
| Admin can pause/unpause, block users, etc. | No admin — every `AdminAction`-gated instruction fails permanently (there is no key that can ever sign as the zeroed authority again) |
| Admin can fund reward pool, set rates | Cannot change any parameter, ever |
| Admin can set annual emission | Emission rate locked forever at whatever it was set to |

The former admin's address does **not** get any special extra income beyond that same 0.25% fee — it's the identical fee that always applied, just re-routed to `feeRecipient` instead of `authority` once `is_renounced` is true (see [Section 3](#3-reward--fee-system)). All of the admin's actual admin *powers* (pausing, blocking users, changing rates, funding the pool, adjusting emission) are gone permanently; only the passive fee-routing target survives.

> Before renouncing, the checklist that was followed was:
> - Deposit the full reserve allocation (`depositReserve`)
> - Set the desired annual emission (`setAnnualEmission`)
> - Configure all Team Target Tiers correctly
> - Ensure the reward pool has sufficient balance

---

## 8. Admin Panel

The Admin Panel is accessible only to wallet addresses whose SHA-256 hash is listed in `NEXT_PUBLIC_ADMIN_ADDRESS_HASHES`. Since ownership has already been renounced on this deployment, every action below is on-chain-disabled and the panel now renders as a read-only **"Fee Recipient Panel"** instead — all buttons are permanently greyed out (`is_renounced` disables them client-side, and the contract itself would reject any of them regardless). The sections below describe what the panel controlled *before* renouncing, for reference:

### Reward Pool Management
| Action | Description |
|--------|-------------|
| Fund Reward Pool | Directly add tokens to the active reward pool |
| Deposit Reserve | Deposit tokens into the long-term emission reserve |
| Release Emission | Manually trigger release of pending reserve emission (this one instruction stayed permissionless and still runs automatically, bundled into user transactions — see Section 6) |

### Platform Parameters
| Action | Description |
|--------|-------------|
| Set Referral Percentages | Adjust each of the 10 referral levels' commission % |
| Set Annual Emission | Set tokens distributed per year (drives PoS APY) |
| Set Burn % | Set the burn rate on claims (0–50%, in basis points) |
| Set Token Mints | Repoint the platform at a new stake/reward SPL mint (migration tool) |

### Team Target Tiers
Admin could update all 10 Team Target Tiers on-chain — minimum team staked threshold and bonus percentage for each tier.

### User Management (cleanup tools, not exposed in the UI)
`block_user`, `unblock_user`, and `toggle_pause` still exist as contract instructions (see Section 9) but their controls were deliberately removed from the Admin Panel UI — they're callable directly if ever needed, just not surfaced as buttons. `void_stale_stake`, `reset_user_account`, `close_user_account`, and `close_stake_entry` are one-off cleanup instructions used during the v2.0/v2.1 migration (see Changelog) and aren't exposed in the UI either.

### Ownership Renouncement
Already exercised on this deployment — permanently transferred the contract to a trustless, admin-free operation mode. See Section 7.

---

## 9. Smart Contract

### Solana Contract — Anchor/Rust

**Location:** `contracts/solana/programs/fbit-staking/`

Built with the Anchor framework for Solana. Uses PDAs (Program Derived Addresses) for trustless account management.

**Program Instructions** (all 30, current as of v2.6 — grouped by who can call them):

User-facing:

- `register_user` — Create a UserAccount PDA for new users (requires an already-active referrer's PDA, or admin bootstrap — see Section 4)
- `stake` — Stake FBiT SPL tokens, pays the 10-level referral chain via `remaining_accounts`
- `claim_rewards` — Claim accumulated rewards
- `compound_rewards` — Compound rewards back into stake
- `unstake` — Withdraw principal after the 30-day lock period
- `release_emission` — Permissionless; tops up the reward pool from the reserve (bundled automatically into the above four)

Admin-gated (`AdminAction`/`AdminUserAction` — all permanently disabled now that ownership is renounced):

- `initialize` — One-time: set up the platform PDA
- `fund_reward_pool` / `deposit_reserve` / `refund_reward_pool` — Move tokens into/out of the active pool or long-term reserve
- `set_annual_emission` / `set_burn_bps` / `set_referral_percentages` / `set_referral_reward_rate` — Tune emission, burn, and referral parameters
- `set_lock_period_apy` / `set_batch_apy` / `set_team_target_tier` — Tune APY and Team Target Bonus tiers
- `set_token_mints` — Repoint the platform at a new stake/reward mint (used for the v2.0 migration)
- `block_user` / `unblock_user` / `toggle_pause` — User/platform controls (contract instructions still exist; their Admin Panel UI controls were deliberately removed — see Section 8)
- `update_user_team_stats` / `reset_user_account` / `reset_platform_stats` — Manual data-correction tools
- `void_stale_stake` / `burn_stale_vault` / `close_user_account` / `close_stake_entry` — One-off cleanup instructions used during the v2.0/v2.1 mint migration
- `fix_bump` — One-off PDA-bump repair utility
- `renounce_ownership` — One-way: the instruction that was actually called to reach the current state

**Accounts:**
- `Platform` PDA — global state (total staked, pool balance, rates, etc.)
- `UserAccount` PDA — per-user state (stakes, referrals, team stats)
- `StakeEntry` PDA — individual stake record
- Vault token accounts — hold staked FBiT and reward FBiT

---

## 10. Frontend Architecture

**Location:** `web/`

Built with **Next.js 16** (App Router, Turbopack) + **TypeScript** + **Tailwind CSS v4**.

### Pages
| Route | Component | Description |
|-------|-----------|-------------|
| `/` | `page.tsx` | Marketing landing page — live stats, tokenomics, security, roadmap, FAQ |
| `/app` | `app/page.tsx` | Staking dashboard (Dashboard / Swap / Stake / Liquidity / Referral / Calculator / History / Admin tabs) |
| `/guide` | `guide/page.tsx` | Step-by-step staking tutorial with real screenshots |
| `/trust` | `trust/page.tsx` | Live on-chain verification page — protocol stats and a wallet-lookup tool, no login required |
| `/launch` | `launch/page.tsx` | Mainnet-launch celebration/countdown page |
| `/about` | `about/page.tsx` | About FBiT Staking (SEO landing content) |
| `/terms` | `terms/page.tsx` | Terms of Service |
| `/privacy` | `privacy/page.tsx` | Privacy Policy |
| `/export-data` | `export-data/page.tsx` | User data export tool |
| `/api/bot-assess` | route handler | Claude-based bot-detection risk assessment (server-side) |
| `/api/support-chat` | route handler | Claude-powered support chat backend (server-side) |
| `/opengraph-image` | route handler | Dynamically generated OG share image |

### Components

#### `web/src/components/staking/`
| File | Purpose |
|------|---------|
| `Dashboard.tsx` | Main view: Active Stakes list, Burn & PoS panel, Team Bonus panel, Transaction History |
| `StakePanel.tsx` | Stake form: amount input, APY display, reward estimation, stake button |
| `StakingCalculator.tsx` / `CalculatorPanel.tsx` | Claim-only vs. compound reward projection (no wallet needed) |

#### `web/src/components/liquidity/`
| File | Purpose |
|------|---------|
| `LiquidityPanel.tsx` | Root of the Liquidity tab — the single-sided SOL deposit + auto-lock feature (see `lib/contracts/liquidity.ts`) |
| `DepositPanel.tsx` | SOL amount input, live split/quote preview, lock-type selection (tier-based + Permanent) |
| `MyPositions.tsx` | Per-position view: locked value, lock type, unlock countdown, Claim/Compound/Withdraw |
| `LiquidityRiskNotice.tsx` | Honest impermanent-loss/market-risk disclosure |

#### `web/src/components/trust/`
| File | Purpose |
|------|---------|
| `TrustPage.tsx` | `/trust` — live on-chain stats + a wallet-lookup tool to verify any address's real staking history |

#### `web/src/components/launch/`
| File | Purpose |
|------|---------|
| `LaunchCelebration.tsx` | `/launch` — mainnet-launch countdown/celebration page |

#### `web/src/components/admin/`
| File | Purpose |
|------|---------|
| `AdminPanel.tsx` | Admin control panel — reads as a read-only "Fee Recipient Panel" now that ownership is renounced (all actions permanently disabled); see Section 8 |

#### `web/src/components/history/`
| File | Purpose |
|------|---------|
| `HistoryPanel.tsx` | Complete activity history: on-chain + local tx records, summary stats, chain refresh |

#### `web/src/components/referral/`
| File | Purpose |
|------|---------|
| `ReferralPanel.tsx` | Referral link generator, referral stats, commission history |

#### `web/src/components/market/`
| File | Purpose |
|------|---------|
| `TokenPriceWidget.tsx` | Live FBiT price and market data |
| `SwapPanel.tsx` | SOL ↔ FBiT swap UI built on Jupiter's Quote/Swap API, with a live GeckoTerminal price chart |

#### `web/src/components/chat/`
| File | Purpose |
|------|---------|
| `SupportChat.tsx` | Floating AI support-chat widget (Claude Haiku via `/api/support-chat`) |

#### `web/src/components/ui/`
| File | Purpose |
|------|---------|
| `ContractSetupNotice.tsx` | Warning banner when `.env.local` contract addresses are not set |

### Hooks
| Hook | Purpose |
|------|---------|
| `useContract.ts` | Unified contract interface, backed by Solana |
| `useSolanaStaking.ts` | All Solana on-chain reads/writes via `@solana/web3.js` + Anchor IDL |
| `useTokenPrice.ts` | Fetches live FBiT price, first from on-chain pool reserves, falling back to GeckoTerminal |
| `useTokenLogo.ts` | Resolves token logo URL |
| `useBotGuard.ts` | Client-side hook wrapping `/api/bot-assess` risk checks |

### State Management
Zustand store (`web/src/lib/store.ts`) with localStorage persistence:
- `walletStates` — per-wallet stakes, transactions, balances, referral info
- `platformStats` — total staked, APY, burn rate, pool balance, emission data

Store key: `fbit-staking-v6` (versioned to force fresh state on breaking changes).

### Context
`WalletContext.tsx` — Solana wallet connection state (via Reown AppKit):
- `address` / `solanaAddress` — active wallet address
- `solanaReferrer` — referrer from URL param

### Contract Interface (`useContract.ts`)
All buttons in the UI call through this single hook:

```typescript
contract.stake(amount, referrer?)           // Stake tokens
contract.claimRewards(stakeId, stakedAt)    // Claim rewards
contract.compoundRewards(stakeId, stakedAt) // Compound rewards
contract.unstake(stakeId, stakedAt)         // Unstake after lock
contract.syncUserData()                     // Refresh user's on-chain data
contract.syncPlatformStats()                // Refresh platform stats
contract.fundRewardPool(amount)             // Admin: fund pool (permanently disabled — renounced)
contract.blockUser(address)                 // Admin: block user (permanently disabled — renounced)
contract.renounceOwnership()                // Admin: renounce ownership (already used — one-way)
// ... and more. `setRewardRate` also exists on this hook but is dead code — the matching
// `set_reward_rate` contract instruction was removed in v2.1 (see Changelog); calling it
// would fail on-chain even independent of the renouncement.
```

---

## 11. Security System

**Location:** `web/src/lib/security.ts`

### Rate Limiting
Every on-chain write is protected by a client-side rate limiter:

| Action | Limit |
|--------|-------|
| Stake | 3 attempts per 2 minutes |
| Claim / Compound | 5 attempts per minute |
| Admin actions | 3 attempts per minute per action |

```typescript
if (!checkRateLimit('stake', { maxCalls: 3, windowMs: 120_000 })) {
  toast.error('Too many attempts. Please wait.');
  return;
}
```

### Input Validation
```typescript
isValidSolanaAddress(addr)   // base58, 32–44 chars
isValidWalletAddress(addr)   // Solana address (base58)
isValidAmount(amount)        // finite, positive, max 9 decimals
isValidBps(bps)              // integer 0–10,000
isValidBonusBps(bps)         // integer 1–1,000
sanitizeText(value)          // strips HTML/script tags (XSS prevention)
```

### Smart Contract Security
- **PDA-based account validation**: strict owner/seed/signer checks on every instruction (Anchor)
- **Checked arithmetic**: overflow/underflow protection throughout reward, emission, and burn calculations
- **Access Control**: authority checks on all admin instructions — now permanently unsatisfiable, since ownership has been renounced (see Section 7)
- **Emergency Pause**: existed to instantly halt all user-facing operations if needed; permanently unusable now for the same reason
- **Lock Period Enforcement**: unstake reverts if called before `unlockAt`

---

## 12. Project Structure

```
FBiT-Staking/
│
├── contracts/
│   └── solana/                         # Solana Anchor program
│       ├── programs/fbit-staking/      # Rust source code
│       ├── scripts/
│       │   ├── initialize.ts           # Initialize platform PDA
│       │   ├── migrate-token.ts        # Point program at a new stake/reward mint
│       │   ├── set-annual-emission.ts  # Set the emission target
│       │   └── update-team-tiers.ts    # Update tiers on-chain
│       ├── target/idl/                 # Auto-generated IDL (after build)
│       ├── Anchor.toml                 # Anchor config (mainnet)
│       └── Cargo.toml
│
└── web/                                # Next.js frontend
    ├── src/
    │   ├── app/
    │   │   ├── layout.tsx              # Root layout with providers
    │   │   ├── page.tsx                # Marketing landing page
    │   │   ├── app/page.tsx            # Staking dashboard
    │   │   ├── guide/page.tsx          # Staking tutorial
    │   │   ├── trust/page.tsx          # Live on-chain verification page
    │   │   └── launch/page.tsx         # Mainnet-launch celebration page
    │   ├── components/
    │   │   ├── landing/                # Landing page sections (Hero, Stats, Tokenomics, ...)
    │   │   ├── layout/                 # Header, navigation
    │   │   ├── staking/
    │   │   │   ├── Dashboard.tsx       # Active stakes, burn panel, history
    │   │   │   └── StakePanel.tsx      # Stake form
    │   │   ├── liquidity/
    │   │   │   ├── LiquidityPanel.tsx  # Single-sided SOL liquidity tab
    │   │   │   ├── DepositPanel.tsx    # Deposit form + lock-tier picker
    │   │   │   └── MyPositions.tsx     # Claim/Compound/Withdraw per position
    │   │   ├── admin/
    │   │   │   └── AdminPanel.tsx      # Admin control panel (read-only now — ownership renounced)
    │   │   ├── referral/
    │   │   │   └── ReferralPanel.tsx   # Referral link & stats
    │   │   ├── market/
    │   │   │   ├── TokenPriceWidget.tsx # FBiT price widget
    │   │   │   └── SwapPanel.tsx       # SOL/FBiT swap via Jupiter
    │   │   ├── trust/
    │   │   │   └── TrustPage.tsx       # Live stats + wallet-lookup verification tool
    │   │   └── ui/
    │   │       └── ContractSetupNotice.tsx # Setup guidance banner
    │   ├── context/
    │   │   └── WalletContext.tsx       # Wallet state
    │   ├── hooks/
    │   │   ├── useContract.ts          # Unified contract interface
    │   │   └── useSolanaStaking.ts     # Solana reads/writes
    │   ├── lib/
    │   │   ├── config.ts               # Network configuration
    │   │   ├── store.ts                # Zustand global state (v6)
    │   │   ├── security.ts             # Rate limiting & validation
    │   │   ├── utils.ts                # Formatting helpers
    │   │   ├── reown.ts                # WalletConnect/Reown setup
    │   │   └── contracts/
    │   │       ├── solana.ts           # Staking contract helpers
    │   │       └── liquidity.ts        # Meteora DAMM v2 / Jupiter liquidity helpers
    │   ├── providers/
    │   │   └── AppKitProvider.tsx      # Reown AppKit wallet provider
    │   ├── idl/
    │   │   └── fbit_staking.ts         # Anchor IDL (TypeScript)
    │   ├── types/
    │   │   └── index.ts                # All TypeScript interfaces
    │   └── styles/
    │       └── globals.css             # Tailwind + custom CSS variables
    ├── .env.local                      # Active environment (gitignored)
    ├── .env.mainnet.example            # Mainnet env template
    ├── next.config.mjs
    ├── tailwind.config.js
    └── package.json
```

---

## 13. Environment Variables

All frontend configuration lives in `web/.env.local`:

```bash
# ===== ADMIN ACCESS =====
# SHA-256 hex digest(s) of the admin wallet address(es) — comma-separated. Never the
# raw address, so it can't be read directly out of the public JS bundle. Generate with:
#   node -e "console.log(require('crypto').createHash('sha256').update('YOUR_ADDRESS').digest('hex'))"
NEXT_PUBLIC_ADMIN_ADDRESS_HASHES=<sha256_hex_digest>

# ===== SITE URL =====
# Bare domain (no scheme/subdomain), used by isAllowedOrigin() to allowlist requests to
# /api/support-chat and /api/bot-assess. Must be the current production domain — a stale
# value here silently breaks AI chat and bot detection for real visitors (see v2.5 Changelog).
NEXT_PUBLIC_SITE_URL=futurebit.in

# ===== REOWN (WalletConnect) =====
NEXT_PUBLIC_REOWN_PROJECT_ID=<your_project_id>

# ===== SOLANA MAINNET =====
NEXT_PUBLIC_SOLANA_RPC_URL=https://solana-rpc.publicnode.com
NEXT_PUBLIC_HELIUS_API_KEY=<optional_helius_key>   # Better rate limits than the public RPC
NEXT_PUBLIC_SOLANA_PROGRAM_ID=<deployed_anchor_program_id>     # ⚠ Required
NEXT_PUBLIC_SOLANA_STAKE_TOKEN_MINT=5uJ8rkiqEs5uzERCqVw9a1eC6BkP54MZAF3D229dyoME
NEXT_PUBLIC_SOLANA_REWARD_TOKEN_MINT=5uJ8rkiqEs5uzERCqVw9a1eC6BkP54MZAF3D229dyoME
NEXT_PUBLIC_SOLANA_STAKE_VAULT=   # Optional — auto-derived from Program ID
NEXT_PUBLIC_SOLANA_REWARD_VAULT=  # Optional — auto-derived from Program ID
NEXT_PUBLIC_SOLANA_RESERVE_VAULT= # Optional — auto-derived from Program ID
```

> **Note:** The app shows a `ContractSetupNotice` warning until `PROGRAM_ID` is filled in. All staking buttons are disabled until the contract is configured. `NEXT_PUBLIC_SITE_URL` is separate from the contract config and is easy to forget after a domain change — env vars aren't part of a git deploy, they have to be updated directly in the hosting platform (see the v2.5 and v1.7 Changelog entries for two real incidents caused by exactly this).

---

## 14. Deployment Guide

### Prerequisites

| Tool | Version | Purpose |
|------|---------|---------|
| Node.js | 18+ | Frontend |
| Rust | stable | Solana program compilation |
| Anchor CLI | 0.29+ | Solana framework |
| Solana CLI | 1.18+ | Wallet + deployment |

---

### A. Deploy Solana Program

```bash
cd contracts/solana
npm install

# Set Solana CLI to mainnet
solana config set --url https://api.mainnet-beta.solana.com

# Build the Anchor program
anchor build

# Deploy to Solana Mainnet
anchor deploy --provider.cluster mainnet

# The output shows: "Program Id: <PROGRAM_ID>"
# Copy it into web/.env.local:
# NEXT_PUBLIC_SOLANA_PROGRAM_ID=<PROGRAM_ID>

# Also update Anchor.toml:
# [programs.mainnet]
# fbit_staking = "<PROGRAM_ID>"

# Initialize the platform PDA (run once after deploy)
npx ts-node scripts/initialize.ts
```

---

### B. Run the Frontend

```bash
cd web
npm install

# Copy and fill in your env
cp .env.mainnet.example .env.local
# Edit .env.local: add PROGRAM_ID

# Development server
npm run dev
# → http://localhost:3000

# Production build
npm run build
npm start
```

---

### C. Post-Deployment Checklist

- [ ] Solana program deployed and initialized
- [ ] `.env.local` has the deployed Program ID
- [ ] Admin panel accessible from admin wallet
- [ ] Deposit reward reserve: Admin → `depositReserve` with the reserve allocation
- [ ] Set annual emission: Admin → `setAnnualEmission`
- [ ] Configure Team Target Tiers: Admin → Sync All Tiers
- [ ] Fund active reward pool if needed: Admin → `fundRewardPool`
- [ ] Test stake / claim / compound / unstake end-to-end
- [ ] Renounce ownership when ready (irreversible!)

---

## 15. Technology Stack

| Layer | Technology |
|-------|-----------|
| Solana Contract | Rust + Anchor Framework 0.29 |
| Frontend Framework | Next.js 16 (App Router, Turbopack) |
| Language | TypeScript |
| Styling | Tailwind CSS v4 |
| State Management | Zustand v5 (with localStorage persistence) |
| AI | `@anthropic-ai/sdk` (Claude Haiku) — bot detection + support chat |
| Solana SDK | `@solana/web3.js`, `@solana/spl-token`, `@coral-xyz/anchor` |
| Wallet Connection | Reown AppKit (formerly WalletConnect) |
| Supported Wallets | Phantom, Solflare, Backpack, Binance Web3 Wallet |
| Toast Notifications | `react-hot-toast` |
| Deployment | Vercel / any Node.js host |

---

## 16. Token & Contract Addresses

### FBiT Token — Solana Mainnet
```
5uJ8rkiqEs5uzERCqVw9a1eC6BkP54MZAF3D229dyoME
```
[View on Solana Explorer](https://explorer.solana.com/address/5uJ8rkiqEs5uzERCqVw9a1eC6BkP54MZAF3D229dyoME)

### FBiT Staking Program — Solana Mainnet
```
8AYv6AAqYxHzLxARsFRsqGSbhDuEmbnsGoLExpdcP4pp
```
[View on Solana Explorer](https://explorer.solana.com/address/8AYv6AAqYxHzLxARsFRsqGSbhDuEmbnsGoLExpdcP4pp)

---

## 17. Changelog

### v2.10 — September 2026

**Critical contract fix, deployed to mainnet.** `stake()`'s referral-payment loop used a hard `require!()` on a referrer's reward ATA — if any single upline referrer's ATA was missing or invalid (e.g. they staked their full balance and their wallet auto-closed the resulting empty ATA to reclaim rent), the *entire* downstream stake transaction failed, not just that one level's payment. `claim_rewards`/`compound_rewards` already handled this correctly via a soft `if !ata_ok { continue; }` pattern; `stake()`'s loop now mirrors it (`can_pay && ata_ok → will_pay`). `team_total_staked`/`team_size`/`referral_count` still update unconditionally either way, since they never depended on payment succeeding. Deployed via the program's upgrade authority; verified byte-for-byte — dumped the live on-chain program and confirmed its content matches the local build exactly (SHA-256 match on the first 471,840 bytes; the deployed account's extra bytes are just upgrade-headroom zero padding).

**Referral on-chain history was only detecting one of the two referral layers.** `solanaGetReferralOnChainHistory()` hard-filtered on `Instruction: Stake` in transaction logs, so the Referral tab's "on-chain activity" only ever surfaced the one-time 10-level referral. The recurring claim/compound-time referral (added in v2.7) pays out on every `claim_rewards`/`compound_rewards` call too, and once a downline is actively claiming this is the dominant source of referral income — but those transactions log `Instruction: ClaimRewards`/`Instruction: CompoundRewards`, not `Instruction: Stake`, so they were silently skipped, leaving the activity feed looking mostly empty even for wallets earning real referral income. Fixed to detect all three instruction types and label each record with its real source.

**Full system security audit, prompted by a fund-theft-risk review request:**
- Re-verified every fund-moving contract instruction's account constraints (`associated_token::mint`/`authority` pinning, owner/mint checks on user token accounts, PDA seed verification) — all correctly scoped, no vault-substitution or account-confusion vector found.
- Verified the entire git history (not just the current tree) for ever-committed secrets — clean. One early-commit `.env.mainnet` file was found in history, but it contained only public wallet addresses and WalletConnect project IDs, not real secrets.
- Found `ADMIN_PASS`/`SESSION_SECRET` had hardcoded fallback defaults in a *separate* side-project (`futurebit-airdrop`, a dormant token-distribution admin panel with its own hot-wallet private key in `ADMIN_WALLET_SECRET_KEY` and no server-side cap on distribution amount) — the real production secrets were correctly set on Vercel so the fallback was never actively exploited, but the defaults were visible in that project's public GitHub repo. Since the project was confirmed no longer needed, it was fully decommissioned: Vercel deployment removed, GitHub repository deleted. (That project also referenced only the old pre-migration FBiT mint, so even a worst-case compromise would never have touched the current live token.)
- Fixed `ANTHROPIC_API_KEY` in this project's own `/api/bot-assess` and `/api/support-chat` routes — found unprotected against the same trailing-`\r\n`-on-Vercel issue that `config.ts`/`reown.ts` already guard against for the Solana/Reown env vars (their existing `.trim()` calls document the exact cause: Vercel can append a stray `\r\n` when a var is set via the dashboard on Windows).

### v2.9 — September 2026

**Team Size / Active Referrals / Team Target Bonus were all silently undercounting for networks deeper than 10 levels.** Traced to the same root cause: the Referral panel and Dashboard computed these three stats from a BFS walk capped at 10 levels — matching the on-chain reward-payment depth, but wrongly reused for stats that should have no depth limit. Verified on-chain for the platform's root referral wallet (73 total registered users): Team Size was showing 38 instead of the true 72; Active Referrals showed 37 instead of 70; Team Target Bonus's underlying team-stake figure showed 15,733 FBiT instead of the true 24,245 FBiT (self-stake + full unbounded downline — on-chain `team_total_staked` credits both the staker's own account and every ancestor, unlike `team_size`, which only ever counts descendants; an earlier pass at this fix missed that asymmetry and undercounted by exactly the wallet's own stake before being corrected). Added `ReferralInfo.fullNetworkSize` / `fullNetworkActiveCount` / `fullNetworkTotalStaked`, all computed via one additional unbounded-depth walk over the already-cached account list (no extra RPC calls), and switched Dashboard/ReferralPanel to use them instead of the capped values.

**New feature: "Look Up Any Wallet"** in the Referral tab — paste any Solana address (a referrer, a downline member, or any other wallet) to see its public on-chain staking/team stats (total staked, team size, direct referrals, referrer, registration date). All fields were already publicly readable via Solscan; this just surfaces them in one place. Reuses the existing per-address-capable `solanaGetUserAccount`/`solanaGetReferralInfo` functions — no new on-chain calls.

**Security hardening, prompted by GitHub CodeQL and a CertiK Skynet website scan:**
- Dismissed two stale CodeQL "incomplete multi-character sanitization" alerts on `sanitizeText()` as false positives — the function already runs its replace-chain inside a `do…while` fixed-point loop (verified against nested-tag bypass patterns), which CodeQL's static check doesn't recognize as closing the gap it flags.
- Added a `Content-Security-Policy` header in **Report-Only** mode (`next.config.mjs`) — addresses CertiK's "Missing Content Security Policy" finding without any risk of breaking wallet-connect: Report-Only blocks nothing, it only logs would-be violations to the browser console. Once a few days of manual testing show no unexpected violations, the header flips to enforcing.
- Removed the Coinzilla/Adcash ad-placement integration entirely (`AdsManager.tsx`, `adConfig.ts`, the `NEXT_PUBLIC_ADS_*` env vars, and their CSP allowlist entries) — simplifies the CSP surface and removes two rotating-subdomain ad networks from the trust boundary.
- Merged three Dependabot dependency-update PRs (`@solana/web3.js` 1.98.4→1.99.0, `autoprefixer` 10.5.4→10.5.5, `@anthropic-ai/sdk` 0.123.0→0.124.0) — all minor/patch, CodeQL-clean, Vercel-build-clean.

**New content:** added "What Makes Us Unique," "Our History" (on-chain-verified launch/migration dates), and "What FBiT Can Be Used For" sections to the About page and matching short-form FAQ entries (synced into the `FAQPage` JSON-LD) — content that CoinGecko's listing form asks for but was previously missing from the site itself.

### v2.8 — September 2026

**Critical security fixes, following an independent smart-contract security review.** A full audit (independent multi-pass review with cross-verification) of the v2.7 contract found and fixed two real, exploitable issues, both deployed to mainnet the same day and verified live:

- **Critical — vault substitution.** `stake_vault`/`reward_vault`/`reserve_vault` across `stake`, `unstake`, `claim_rewards`, `compound_rewards`, `release_emission`, `fund_reward_pool`, `refund_reward_pool`, and `deposit_reserve` were validated only by loose `owner == platform.key()` / `mint == platform.X_token_mint` checks — not pinned to one canonical address, and `Platform` stored no vault pubkeys to compare against. Since any freshly-created SPL token account can declare an arbitrary PDA as its `owner` field with no cooperation from that PDA, an attacker could substitute a decoy vault they control, diverting `release_emission`'s permissionless reserve→reward transfer or draining the real shared vault via `stake`/`unstake` account substitution. Fixed by switching every vault field to Anchor's `associated_token::mint`/`associated_token::authority` constraint (cryptographically pinning it to the canonical ATA) instead of the loose checks — required no migration, since the real live vaults already are that exact ATA. Verified live via `simulateTransaction`: the correct vault still succeeds, a substituted vault now fails with `ConstraintTokenOwner`.
- **High — permanent, farmable Team Target Bonus inflation.** `stake()` unconditionally credits every referral-chain ancestor's `team_total_staked` (up to 10 levels), but `unstake()` only ever decremented the unstaking user's own figure — an ancestor's inflated `team_total_staked` (and the reward-pool-funded bonus APY it grants) stayed permanently stuck after a downline fully unstaked, and the only correction path (`update_user_team_stats`) is admin-gated and permanently uncallable post-renouncement. A self-contained attack (two wallets, referrer + referral, stake then fully unstake) could farm a permanent bonus tier for ~0.5% of fully-recovered capital. Fixed by walking the same identity-verified referrer chain in `unstake()` (via `remaining_accounts`, optional/backward-compatible) to decrement every verified ancestor by the unstaked amount — mirrors `stake()`'s existing walk and security checks exactly. Client (`solana.ts`) updated to build and pass this chain on every `unstake()` call.
- Contract's on-chain bytecode independently verified against the GitHub source: pulled the live program via `solana program dump`, rebuilt from the exact deployed commit, and confirmed a byte-for-byte SHA-256 match. Documented on `/trust` with the exact reproduction steps, since the public "Verified Build" badge (Solscan/SolanaFM/Explorer) isn't achievable yet — the shared OtterSec/Ellipsis Labs verification registry only has Docker images up to `solana-cli 1.18.16` and this program was built with `3.1.15`, not yet published there.

**Frontend/backend swept for drift from the v2.7 contract change**, beyond what shipped with v2.7 itself:
- Referral panel's "Levels" tab only ever showed the one-time 10-level referral — the newer recurring claim-referral layer (levels 1-5) never appeared there at all. Split into two clearly-labeled sections, one per layer, each with its own per-level breakdown and subtotal.
- Deleted `useSolanaStaking.ts` — an unused, orphaned hook (no importers anywhere) with its own separate, stale `unstake`/`claimRewards`/`compoundRewards` implementations that never received any contract-side fixes, including the `remaining_accounts` security fix above.
- Several stale "1% fee" / "10% burn" references cleaned up in doc comments, the homepage FAQ, and its matching JSON-LD structured data (the FAQ answer only described the one-time referral layer and never mentioned the newer recurring one).
- Brochure PDF (`/brochure.pdf`) rebuilt with current v2.7 figures (0.25% fee, 5% base burn, both referral layers) and a new dedicated Claim Referral page.

**Liquidity feature: "My Positions" showed 0 claimable fees despite real accrued fees.** `solanaLiquidityGetUserPositions()` read `feeAPending`/`feeBPending` directly off the position account — a checkpoint only written at the position's last on-chain interaction, not a live value, so any untouched position showed 0/0 regardless of real trading fees earned since. Switched to `@meteora-ag/cp-amm-sdk`'s `getUnClaimLpFee(poolState, positionState)`, which computes the true live unclaimed fee the same way Meteora's own UI does. Verified directly against mainnet: the position from the original bug report was showing 0/0 while actually holding 259.77 FBiT and 0.024 SOL in real unclaimed fees.

**SEO overhaul**, prompted by Google Search Console showing several pages stuck on "Discovered/Crawled — currently not indexed":
- No page anywhere set a canonical URL. Critical for the homepage specifically, since every referral link is `futurebit.in/?ref=<wallet>` (one distinct URL per referrer, all identical content) — added `alternates.canonical` site-wide and per-page.
- `/trust` and `/guide` had *zero* crawlable internal links — their only links lived inside the header's "Resources" dropdown, which was conditionally *mounted* (`{open && <div>}`) rather than CSS-hidden, so those `<a>` tags never existed in the DOM until a user clicked to open the menu. Search crawlers don't simulate clicks. Fixed by always rendering the dropdown's links (toggling only visibility via CSS), plus added direct links in the homepage footer.
- Google was ranking the older, higher-authority FutureBit LLC (Bitcoin mining hardware) for brand-name searches. The About page — likely Google's primary signal for "who is this entity" — referred to the company as bare "FutureBit" throughout and never once distinguished it from FutureBit LLC (the homepage FAQ had this disclaimer, the About page didn't). Updated all copy to consistently say "FutureBit Staking," added a prominent always-visible disclaimer box, and added Schema.org's purpose-built `disambiguatingDescription` field to the Organization JSON-LD.
- Homepage's live 24h price-change stat was showing a hardcoded "▲ 0.00%" from the on-chain price fallback (which can't derive a real 24h change from one snapshot) instead of indicating the figure was unknown — now shows "—" unless the data genuinely came from GeckoTerminal. Same fix applied to `TokenPriceWidget` and `LaunchCelebration`.
- Cleaned up and expanded `keywords` metadata (deduplicated, organized by intent), and wove target search phrases into on-page H1s/copy where they read naturally (homepage H1, Guide page, Trust page subhead).

**New features:**
- Social share buttons (X, Telegram, WhatsApp, Facebook, Instagram) on the referral link card — standard web share-intent URLs for the first four; Instagram has no web share-intent URL, so it uses the OS-level Web Share API where available, falling back to copy-link with instructions.
- Live FBiT price now shown directly in the landing page's Token Details card (top-right of the identity strip), same price feed the ticker already used.
- Referral panel's Overview table now shows how many people each network member has personally referred (a new "Referred" column), computed from the same ground-truth referrer→children map the BFS tree walk already builds — not the on-chain `referral_count` field, which can silently under-count (same reasoning as the earlier Direct (L1) stat fix).
- New 6-page "Referral & Team Income Guide" PDF for team builders/promoters, explaining all three passive-income layers (one-time 10-level referral, recurring 5-level claim referral, Team Target Bonus) in detail with worked examples and an FAQ — linked from the header's Resources dropdown.

**Roadmap**: Phase 2 (Consolidation & Security) marked complete — fixed-supply FBiT v2, 100% liquidity locked/burned, this session's independent security review, and documentation all done. Phase 3 (Market Expansion) now current. Synced across the landing page, `WHITEPAPER.md`, and the brochure PDF.

### v2.7 — September 2026

**New feature: recurring claim/compound-time referral passive income (levels 1-5).** On top of the existing one-time, stake-time 10-level referral (Section 4, unchanged), every `claim_rewards`/`compound_rewards` now also pays the claiming user's direct referral chain up to 5 levels: 3%, 2.5%, 2%, 1.5%, 1% (10% max total) of that claim's own after-fee amount. This is entirely carved out of the claim's existing cost — the reward pool is charged exactly the same `total_gross` as before, so it cannot shorten the emission-reserve runway; it only changes how a claim's cost is split between {burn, referral, user}. Designed and specified interactively with the project owner over several rounds to land on final numbers that keep the split sustainable while giving real, recurring passive income to referrers and team leaders.

- **Platform fee cut from 1% to 0.25%.** Applies everywhere `PLATFORM_FEE_BPS` is used (stake, claim, compound, unstake) — a straightforward reduction in what `feeRecipient` collects, in exchange for making room for the new referral layer.
- **Burn cut from 10% to 5% (base).** `set_burn_bps` is permanently disabled post-renouncement, so the live `burn_bps` field is now force-corrected to 5% at the top of every `claim_rewards`/`compound_rewards` call instead — same self-healing pattern the v2.1 Changelog entry already established for exactly this class of "displayed vs. actual" drift.
- **Unfilled referral levels split 50/50, never silently absorbed.** If a level's referrer doesn't exist, isn't active (hasn't staked — mirrors the register_user rule), is blocked, or supplies a malformed reward ATA, that level's share is split: half added to burn, half returned to the claiming user — rather than either reverting the whole claim or quietly handing the user 100% of it. A concrete consequence worth knowing: a user with **no** referrer nets *more* of their own claim (90% of after-fee) than a user with a full 5-level **active** chain above them (85%) — since an unpaid level only returns half its share, while a paid level's share leaves entirely.
- Chain-walk security mirrors the stake-time referral loop exactly: each level's identity is verified via the on-chain `UserAccount.referrer` link before advancing, and a broken/mismatched link stops the walk (deeper levels can't be trusted past that point) — but a *validly identified* level that simply can't be paid (blocked, inactive, bad ATA) doesn't stop the walk for levels beyond it, since the chain identity is already confirmed independent of payability.
- Deployed to mainnet via `solana program extend` (+10,240 bytes) then `solana program deploy`, and verified with a direct `simulateTransaction` call before closing out: for a no-referrer account, the emitted `TokensBurned`/`RewardsClaimed` events confirmed exactly 0.25% fee and the user netting exactly 90% of the after-fee amount (10% total burn, 0% referral, no referrer to pay) — math matched the hand-derived formula precisely.

### v2.6 — September 2026

**Critical fix: referral registration was completely broken for every new user.** The v2.4 referral-cycle-exploit fix added an on-chain check requiring `register_user`'s new `referrer_account` to match the referrer's wallet key — but the check compared the account's own address (a PDA) directly against the referrer's raw wallet pubkey (`require!(ref_ai.key() == ref_key, ...)`), two values that can never be equal by construction. This meant the check failed unconditionally for every legitimate referral, blocking all new referred registrations (and therefore staking, since staking auto-registers first) since that fix went live — found after a user reported a referred wallet stuck on "Failed to simulate transaction." Root-caused by reproducing the exact failure via a direct mainnet `simulateTransaction` call (confirmed `AnchorError: ReferrerMismatch`), fixed by re-deriving the referrer's PDA on-chain (`Pubkey::find_program_address`) and comparing against that instead of the raw wallet key. Deployed to mainnet via `solana program deploy` (no `program extend` needed — new binary was smaller than the currently allocated space) and confirmed fixed with another direct `simulateTransaction` call before closing it out.

### v2.5 — August 2026

**New feature: single-sided SOL Liquidity provision with size-based auto-lock.** Added a full "Liquidity" tab to the `/app` dashboard letting anyone deepen the real FBiT/SOL trading pool using only SOL — no FBiT needed upfront. On deposit, half the SOL is swapped to FBiT via the existing Jupiter integration and both halves are added as a locked position on the live Meteora DAMM v2 pool; on withdraw, the FBiT leg is swapped back to SOL so the user only ever handles SOL going in and out. Built entirely as a client-side orchestration layer composing Jupiter's swap API with Meteora's own already-audited DAMM v2 instructions (`@meteora-ag/cp-amm-sdk`) — no new on-chain program, so no new custody surface for user funds.

- **Deposit-size-based lock schedule** (Permanent is always available as an alternative at any size): 1–10 SOL → 12 months, 10–50 → 24 months, 50–100 → 36 months, 100–250 → 48 months, 250–500 → 60 months, 500+ → 72 months. The UI auto-corrects the selected lock option if a typed amount crosses a tier boundary, and Permanent locks require typing "PERMANENT" to confirm before submitting — irreversible by design (Meteora's own `permanentLockPosition`, not custom logic).
- **Flat SOL platform fees**: 0.2 SOL on deposit, 0.5 SOL on withdrawal (both disclosed in the UI before confirming), on top of the existing 1% Jupiter Referral Program fee that already applies to the swap leg in either direction.
- **My Positions** panel shows locked value, lock type, unlock countdown, and claimable trading fees per position, with one-click Claim and Compound (claim + immediately re-add as liquidity in a single transaction).
- Found and fixed two real bugs during this build before it ever touched a real position: `liquidity.ts`'s fee routing didn't account for the staking contract's renounce-ownership state (would have sent fees to a stale authority instead of `fee_recipient` post-renouncement), and the vesting-unlock countdown read `cliffPoint` from the wrong field path (Meteora nests it under `innerVesting.cliffPoint`, not a direct field) — would have shown `NaN` for every timed position's countdown.

**On-chain price/liquidity display fixed — was silently showing a stale, wrong price.** The landing page's live price widget fell back to a search-based GeckoTerminal query whenever the pinned pool's own price came back as `0.0` (a falsy value in the existing filter, even though `0.0` legitimately meant "real pool, just not yet indexed with trades") — surfacing a stale $0.5103 price and $0 liquidity from a different, nearly-empty pool instead of the real pool's numbers. Fixed by computing price and liquidity directly from the pool's on-chain vault balances (SOL/USD sourced from GeckoTerminal's dedicated SOL price endpoint, which is reliable) as the first attempt, ahead of the GeckoTerminal pool-search chain, which remains only as a fallback. Verified live: price corrected from $0.5103 to $0.1062, liquidity from $0 to $35.15K, market cap from $127.58M to $26.54M.

**Full-system security review — two more real issues found and fixed proactively**, beyond the Liquidity-feature bugs above:

- `NEXT_PUBLIC_SITE_URL` in the Vercel production environment was still pointing at the pre-migration `stake.futurebit.in` domain, causing the origin-allowlist check (`isAllowedOrigin()`) to reject legitimate requests from the actual primary domain (`futurebit.in` and `www.`) — silently breaking the AI support chat and bot-detection API for most real visitors. Fixed by updating the env var to the bare `futurebit.in` (its subdomain-match logic then covers all three domains) and redeploying.
- Mobile wallet connections were failing intermittently — root-caused to `Cross-Origin-Opener-Policy`/`Cross-Origin-Resource-Policy` headers in `vercel.json` that broke the WalletConnect/OAuth popup flow (a documented class of issue; `next.config.mjs` already deliberately avoids any CSP-adjacent header for this exact reason, but `vercel.json` had added them independently). Removed both headers.
- Binance Web3 Wallet's in-app DApp browser has its own known failure mode: it injects a Wallet Standard Solana provider directly, but the connect modal's featured WalletConnect entry (also labeled "Binance") tried to deep-link back out to relaunch the app the user was already inside. Added detection for this environment (`isInsideBinanceAppBrowser()`) that removes the conflicting featured entry and shows a toast guiding the user to the auto-detected "Installed" wallet instead. Confirmed fixed by the user on a real device.

**Reserve topped up 110,000,000 FBiT, tokenomics resynced everywhere.** The emission reserve was funded with an additional 110,000,000 FBiT (bringing it to 229,830,025.87 FBiT, ~19-year runway at the current 12,000,000/year emission rate), and every tokenomics display — landing page allocation chart, whitepaper (overview, §7.1, §11.5, §13.2, §13.3), and this README — was updated to the resulting 91.9% Staking Reserve / 8.1% Liquidity split.

**Smaller fixes**: added the missing "How It Works" nav link on the landing page header; made the About/Terms/Privacy page headers use the real FBiT logo instead of a generic gradient icon; added X and Telegram social links to the landing page footer (Telegram handle corrected to `@FutureBit_Community` after verification).

### v2.4 — August 2026

**Fixed a critical referral self-dealing exploit and added the "referrer must have staked" rule.** An internal security review of the full contract found that `register_user` accepted any pubkey as `referrer` with no on-chain check that it belonged to a real, existing account — so two colluding wallets could register with each other as referrer (`A→B`, `B→A`), forming a 2-node cycle. Because `stake()`'s referral-chain walk had no cycle guard, staking from either wallet would then alternate through the cycle across all 10 referral levels, paying the staker's own wallets back the vast majority of the referral percentage (up to ~29% of every stake) straight out of the shared reward pool — a direct fund-drain, plus it inflated `team_total_staked` enough to fake Team Target Bonus tiers. Fixed at the root: `register_user` now takes a `referrer_account` and requires it to be the referrer's own UserAccount PDA with `total_staked > 0` — the referrer must have registered *and* staked before their link can onboard anyone, which makes a cycle temporally impossible to construct (a referrer must always precede their referee). Added a matching defense-in-depth guard in `stake()`'s referral loop (breaks if the staker ever appears in their own chain) and a new `ReferrerNotActive` error. Updated `solanaRegisterUser` (client) to validate this ahead of time with a friendly error message, and the IDL to document the new account. Deployed to mainnet via `solana program extend` (+10,240 bytes) followed by `solana program deploy`.

### v2.3 — August 2026

**Deployed the last pending cleanup instructions and fully retired stale accounts.** `close_user_account`/`close_stake_entry` (written and build-verified back in v2.1, deferred only for lack of SOL in the admin wallet — cosmetic only, no security impact) were upgraded to mainnet (no `solana program extend` needed this time — allocated program space already covered the new binary) and run against every account on-chain via two new scripts, `close-user-accounts.ts` and `close-stake-entries.ts`. Closed all 16 empty UserAccount PDAs and all 29 inactive StakeEntry accounts left over from the pre-migration cleanup, reclaiming their rent to the admin wallet. `Platform.total_users` now accurately reads 1 (the admin's own still-active account) instead of the stale 17.

### v2.2 — August 2026

**Referral commission mismatch fixed — frontend/docs said 30%, live contract pays 17.75%.** Queried the mainnet Platform account's `referral_percentages` field directly and found it no longer matches the contract's `DEFAULT_REFERRAL_PERCENTAGES` (30% total) set at `initialize()` — at some point an admin called `set_referral_percentages` to a lower, evenly-stepped curve (0.25% → 3.00% per level, 17.75% total) that was never reflected outside the app's own live-data-aware components. The in-app Referral tab was already correct (it fetches live `Platform.referralPercentages` and only falls back to a static constant when that fetch fails), but the landing page's Rewards section, both FAQ copies (visible + structured data), Features grid, Terms page, AI support chat's system prompt, the marketing PDF, the whitepaper, and this README's own reference tables all still quoted the old 30% figure and per-level breakdown. Updated every one of them to 17.75%, and updated the two fallback constants (`REFERRAL_LEVELS` in `types/index.ts`, `REFERRAL_BPS` in `lib/contracts/solana.ts`) so the safety-net values match reality too, not just the always-correct live path.

### v2.1 — August 2026

**Critical security fix — orphaned pre-migration stakes could drain the reserve.** After the v2.0 mint migration, 19 StakeEntry accounts created under the *old* mint were still `is_active = true` with their lock periods long expired. `unstake()`/`claim_rewards()`/`compound_rewards()` only validate that the supplied vault matches the platform's *current* mint — they never check which mint an entry was originally staked under — so any of those 19 entries could call `unstake()` against the new shared stake/reward/reserve vault and receive real new-mint FBiT they never deposited under the new mint. The platform was paused immediately as a stopgap the moment this was found, then fully resolved:

- **Three new admin instructions**, all hard-scoped to never touch live funds: `burn_stale_vault` (burns and closes a vault only if its mint differs from *both* the current stake and reward mint — cannot target the live vault), `void_stale_stake` (force-deactivates a StakeEntry without moving tokens), `reset_user_account` (zeroes a UserAccount's accumulated stats and referrer link)
- **Cleanup executed on mainnet**: burned 228,334,553 orphaned old-mint FBiT from the old reserve vault and closed it; voided all 19 stale StakeEntry accounts; reset all 17 registered UserAccounts to a clean slate (stats and referrer links)
- **`close_user_account`** added afterward to fully retire the now-empty UserAccount PDAs (reclaiming rent, decrementing `total_users`) rather than leaving zeroed-but-still-registered accounts behind
- The platform was unpaused once the exploit path was fully closed and verified — normal staking/claiming/unstaking/compounding is live again. A follow-up pass also cleared the `referrer` link on all 17 test accounts (not just their stats) for a genuinely clean slate; two more cosmetic-only cleanup instructions (`close_user_account`, `close_stake_entry` — retire the now-empty accounts and reclaim their rent) are written and build-verified but not yet deployed, with no security impact either way

**Renounce-ownership fee simplified.** The separate 25%-of-gross fee paid to `fee_recipient` after renouncement is gone. The same 1% platform fee that always applied on stake/unstake/claim/compound now just keeps applying after renouncement too — it routes to `fee_recipient` instead of the former authority, rather than being waived in favor of a bigger one-off cut. Removes an entire extra transfer and required account (`fee_recipient_token_account`) from claim/compound.

**Dead code removed**: `set_reward_rate`/`reward_rate` was never read by any reward calculation (rewards are driven by `annual_emission`/`total_staked` via `get_effective_apy_bps`, not this field) — the setter instruction was removed and its Admin Panel UI replaced with an honest explanation. `referral_reward_rate`'s Admin Panel control was similarly rebuilt as a plain ON/OFF toggle — the contract only checks whether it's zero or non-zero to gate the whole 10-level referral system; the specific numeric value it held was never meaningful.

**Frontend bug hunt — several panels never synced live data on their own.** Dashboard and the Stake tab already fetched fresh on-chain platform stats on mount; Admin Panel, Referral Panel, and the Calculator tab did not — they only ever showed real numbers after some *other* tab's sync call happened to run first in the same session, otherwise silently showing zero/default values (Reserve, Annual Emission, Releasable Now, live referral percentages, and team tiers all affected). All three now sync on mount and on a refresh interval, matching the existing Dashboard/Stake pattern.

**Root cause of the recurring "shows 0 instead of the real value" reports**: `networkPlatformStats` was being persisted to `localStorage` via Zustand's `persist` middleware. A stale cached number — from an older contract deploy, an old on-chain config, or simply a background sync that failed silently — would sit there looking authoritative indefinitely instead of being replaced by a fresh fetch. Stopped persisting it entirely; every page load now starts from neutral defaults and gets corrected by a live fetch within moments, closing the whole class of bug (this had separately caused wrong Min/Max stake limits, a stale Annual Emission figure, and a stale Total Burned figure, all fixed piecemeal before the root cause was found).

**On-chain burn rate corrected to match the frontend's displayed 10%** — a client-side "migration" workaround had been silently overriding a genuine on-chain `burn_bps` of 2,500 (25%) to display 1,000 (10%) instead, meaning users were told 10% while 25% of their reward was actually being burned on every claim. Fixed on-chain via `set_burn_bps(1000)` rather than making the display honest about the wrong value.

**IDL/contract drift fixed**: the frontend's hand-written IDL still said "Claim too early - wait 12 hours" for an error the contract actually enforces at 6 hours (`CLAIM_INTERVAL = 21600`) — a leftover from an earlier contract version.

**Deployment/tooling notes**: Vercel's production environment variables for the Solana mint/vault addresses were 95 days stale (still pointing at the pre-migration mint) despite the app code being current — env vars aren't part of a git deploy and have to be updated separately. Also hit and resolved a stale-build-cache Vercel deployment failure, and a Solana protocol quirk where extending a program's on-chain size requires a minimum 10,240-byte increment per `solana program extend` call (the `anchor upgrade` CLI doesn't request this automatically when the actual size delta is smaller).

### v2.0 — August 2026

**Platform is now Solana-only** across the contract, frontend, and documentation.

- **Solana mainnet migration executed** — the staking program was upgraded in place (same Program ID, `8AYv6AAqYxHzLxARsFRsqGSbhDuEmbnsGoLExpdcP4pp`) to a new fixed-supply FBiT SPL mint (9 decimals, 250,000,000 supply, mint authority renounced); the 120,000,000 FBiT emission reserve was funded, the annual emission rate was set to 12,000,000 FBiT/year, and all 10 Team Target Bonus tiers were pushed on-chain
- **Critical fix: emission release could freeze permanently** — `release_emission` computed "tokens releasable so far" by applying the *current* annual emission rate across the *entire* elapsed time since the reserve was first funded. Any future rate change (e.g. via `set_annual_emission`, or the now-removed halving) would retroactively undercut that total below what had already been released, permanently reverting every subsequent release call. Fixed by tracking an incremental `last_release_time` instead — each call only ever applies the current rate to time elapsed since the last release
- **New `reset_platform_stats` admin instruction** — a token-mint migration repoints the mint pubkeys but was leaving `total_staked`, `total_reserve`, `reward_pool_balance`, `total_burned`, and the emission clock as stale numbers denominated in the old mint's tokens/decimals; this instruction gives a clean, one-time reset after a migration so those counters can't corrupt reward-pool and emission math against the new (empty) vaults
- **Halving mechanic removed** — `trigger_halving` and the automatic 4-year base-APY/emission halving are gone; annual emission is admin-adjustable via `set_annual_emission` only. The now-unused `halving_epoch`/`halving_start_time` fields are kept in the account layout (backward-compatible byte offsets) but are otherwise inert
- **Team Target Bonus tiers rescaled** — Bronze now starts at 50,000 FBiT (was 2,500 after an earlier rescale, originally 50,000 FBiT pre-decimal-migration); Titan tops out at 100,000,000 FBiT / 40% of supply (previous top tiers of 500M–1B FBiT were mathematically unreachable against the 250M fixed supply)
- **Solana build hygiene** — `overflow-checks = true` and the `idl-build` feature are now required for a clean `anchor build`, matching current Anchor CLI expectations
- **New marketing landing page** at `/` — live protocol stats, token info, tokenomics breakdown, security/trust section, roadmap, 10-level referral and Team Target Bonus tables, FAQ, and a Canvas-based particle-globe hero animation; the original tabbed dashboard moved to `/app`. Added a step-by-step staking tutorial at `/guide`
- **Admin login hint removed** — the visible "⚙ Admin Login" button and confirmation modal are gone; admin status now auto-detects silently whenever any wallet connects through the normal Connect flow (this already worked under the hood — the separate admin path was redundant, and it was the only place an admin backdoor was hinted at)
- **Admin address hashed, not stored raw** — `NEXT_PUBLIC_ADMIN_ADDRESS_HASHES` (SHA-256 digests) replaces `NEXT_PUBLIC_ADMIN_ADDRESSES`, so the admin wallet can no longer be read directly out of the public JS bundle
- **Bot-assess fail-open bypass closed** — rate-limit, bad-origin, and malformed-request failures on `/api/bot-assess` now return `risk: "medium"` instead of the old blanket `risk: "low"`, so a bot can't force a guaranteed-safe verdict by deliberately tripping one of those checks; genuine Anthropic API outages still fail open so real users are never blocked. Added a global per-instance rate cap to both AI API routes as a backstop against distributed abuse
- **`sanitizeText` nested-tag bypass fixed** — HTML-stripping now runs to a fixed point instead of a single pass, closing a bypass via malformed markup like `<<script>script>`
- **Dependency vulnerability patches** — `uuid`, `axios`, and `image-size` pinned via `overrides` to resolve a High-severity buffer-overflow CVE in the Solana RPC client chain and several Axios/image-size advisories (37 → 15 remaining locally, all in unreachable/low-risk transitive paths)
- **Brand simplified to "FutureBit"** across the site (was "Future Bit (FBiT) Staking Mainnet")
- **Buttons restyled** to Solana's official purple → green gradient (`#9945FF` → `#14F195`)

### v1.7 — July 2026

- **AI Support Chat** — New floating widget (`web/src/components/chat/SupportChat.tsx`) backed by a rate-limited `/api/support-chat` route using Claude Haiku, scoped strictly to platform facts (APY, referrals, safety)
- **New static pages** — `/about`, `/terms`, `/privacy`, linked from the footer
- **Ad placements** — Coinzilla/Adcash integration (`AdsManager.tsx`) driven entirely by `NEXT_PUBLIC_ADS_*` env vars; the Admin Panel's Ads tab is a read-only status view (there is no backend database, so a live in-panel toggle would only ever affect the admin's own browser via `localStorage`, never real visitors — this was in fact a live bug, fixed this cycle)
- **SEO overhaul** — full metadata, sitemap, robots.txt, Schema.org structured data (Organization/WebSite/WebApp/FAQ), Google Search Console verification, dynamic OG image
- **New brand logo** — header and footer updated
- **Wallet connect fix** — `@reown/appkit`, `-adapter-ethers`, and `-adapter-solana` were resolving to two different versions (1.8.19 vs 1.8.21) because npm couldn't dedupe them, so the Solana adapter ran against a separate copy of AppKit's internal connection state than the rest of the app — this produced Phantom's "Connection declined — a previous request is still active" error on every connect attempt. Pinned all three to `1.8.21` with an override. Also removed a redundant, manually-registered Phantom/Solflare adapter that competed with AppKit's own Wallet Standard auto-detection for the same installed extension.
- **Production origin-check bug** — `NEXT_PUBLIC_SITE_URL` in Vercel was malformed (bare hostname plus a stray literal `\n`), so the Origin-allowlist check in `/api/bot-assess` silently 403'd every real request in production — meaning the Claude bot-detection layer had likely never actually run in production (it fails open, so this went unnoticed). Added `isAllowedOrigin()` in `lib/security.ts` which normalizes hostnames regardless of scheme/formatting.
- **Unsolicited wallet signature fix** — the auto-halving check in `syncPlatformStats()` called `triggerHalving()` for *any* connected wallet once a halving became due, prompting a surprise signature request for ordinary visitors; now gated to admin wallets only
- **Stake amount precision fixes** — the Stake page's MAX/25%/50% quick-fill buttons used `toFixed(0)` which could round *up* past the actual wallet balance (now `Math.floor`); the reward estimate used a double-rounded whole-percent APY instead of the raw basis-points value, causing it to diverge from the Dashboard's live figures
- **Referral level off-by-one** — the on-chain history feed displayed the contract's 0-based `ReferralReward` level index verbatim while the rest of the app is 1-based, showing every referral one level lower than actual
- **Admin emission cap mismatch** — the Annual Emission input capped at 1,000,000 FBiT while the on-chain contract allows a much higher ceiling, so the built-in APY calculator's own quick-fill values were sometimes rejected by the form that generated them
- **Dependency vulnerability patches** — resolved a critical `shell-quote` CRLF injection and several high/moderate advisories (`@babel/core`, `form-data`, `ws`) across the web app and contract tooling via `npm audit fix`
- **Corrected referral total in SEO/FAQ content and the support chat** — was incorrectly stated as 15.75%; the real total across all 10 levels is 30%
- **Known limitation (not fixed — flagged for a deliberate decision):** the contract checks the per-user stake cap only against each individual `stake()` call, never the user's cumulative `total_staked`. A user can bypass the intended ceiling by splitting a large stake across multiple calls. Fixing this requires a new contract version and a migration plan for existing stakers — out of scope for a routine patch on a live mainnet contract holding real funds.
- **New Swap tab** (`SwapPanel`) — custom SOL ↔ FBiT swap UI built directly on Jupiter's Quote/Swap API, with a live GeckoTerminal price chart alongside it
- **New Staking Calculator tab** — projects claim-only vs compound rewards for a chosen amount/APY/duration, no wallet connection required
- **New `UsdValue` component** — live "~ $X" estimate shown next to FBiT amounts across Dashboard, Stake, History, Referral, Admin, and the calculator
- **Admin panel: Blocked Users list** — count + per-address Unblock button (via a discriminator-filtered `getProgramAccounts` scan); the Ads Management tab was removed
- **Nav reordered and code-split** — Dashboard → Swap → Stake → Referral → Calculator → History; every tab now loads via `next/dynamic` so switching tabs only pulls in that tab's JS
- **Referral persistence fix** — referrer resolution no longer gets wiped out by a malformed `?ref=` URL param
- **Claim/compound fee-recipient fallback fix** — a failed platform-state fetch now aborts before signing instead of silently defaulting the fee recipient to the user's own wallet
- **Solana RPC rate-limiting storm fix** — history fetchers now batch `getParsedTransactions` (chunks of 50) instead of 100–200 individual calls, and space queued RPC requests ~120ms apart, eliminating repeated 429s from the Helius free tier
- **Price feed fix** — the confirmed-correct FBiT/SOL pool is now pinned to the front of the price list regardless of liquidity ranking
- **Dependency updates** — `@reown/appkit` + adapters, React, Tailwind, Recharts, Zustand and others bumped to latest compatible versions
- **Support contact email** updated to `contact@futurebit.in` across Terms, Privacy Policy, and [SECURITY.md](SECURITY.md)

---

## License

MIT — Free to use, modify, and distribute.

---

*Built for the FBiT ecosystem on Solana. Autonomous, deflationary, non-custodial.*
