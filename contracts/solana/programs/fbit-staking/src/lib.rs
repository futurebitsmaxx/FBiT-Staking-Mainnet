use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer, Mint, Burn};

declare_id!("8AYv6AAqYxHzLxARsFRsqGSbhDuEmbnsGoLExpdcP4pp");

// ===== CONSTANTS =====
pub const MAX_REFERRAL_LEVELS: usize = 10;
pub const REFERRAL_PERCENTAGES: [u64; 10] = [25, 50, 125, 150, 200, 325, 350, 425, 550, 800];
pub const SECONDS_PER_DAY: i64 = 86400;
pub const CLAIM_INTERVAL: i64 = 21600;           // 6 hours (4 intervals/day)
pub const LOCK_PERIODS: [u64; 1] = [30];
pub const DEFAULT_APY: [u64; 1] = [1_000]; // 10% — PoS minimum
pub const PLATFORM_FEE_BPS:  u64 = 25;     // 0.25% — applies always, including after renouncement (routes to fee_recipient instead of authority)
pub const BURN_BPS:          u64 = 1000;   // 10% burn on every claim/compound (initialize()-only default; live burn_bps is force-set to CLAIM_BURN_BPS below, see claim_rewards/compound_rewards)

// ── Claim/compound-time recurring referral passive income (separate from the
// one-time 10-level referral paid on stake() — see REFERRAL_PERCENTAGES above).
// Reverse-weighted vs. the stake-time table: the direct referrer (level 1) earns
// the most here, tapering off through level 5; levels 6-10 earn nothing from this
// layer. Entirely carved out of the claiming user's own after-fee reward (never
// drawn from the reward pool beyond what a claim already costs it), so it cannot
// shorten the emission-reserve runway — it only changes how a claim's existing
// cost is split between {burn, referral, user}.
pub const CLAIM_REFERRAL_LEVELS: usize = 5;
pub const CLAIM_REFERRAL_BPS: [u64; CLAIM_REFERRAL_LEVELS] = [300, 250, 200, 150, 100]; // 3%, 2.5%, 2%, 1.5%, 1% = 10% max
pub const CLAIM_REFERRAL_TOTAL_BPS: u64 = 1000; // sum of CLAIM_REFERRAL_BPS — kept as a named constant for the leftover-share math
pub const CLAIM_BURN_BPS: u64 = 500; // 5% — the live burn_bps is force-set to this in claim_rewards/compound_rewards (set_burn_bps is permanently disabled post-renouncement)
pub const MAX_APY_BPS:       u64 = 30_000; // 300% max APY (safety ceiling)
pub const MIN_FUND_LAMPORTS:  u64 = 100_000_000;                      // 0.1 FBiT  (9 decimals)
pub const MAX_FUND_LAMPORTS:  u64 = 250_000_000 * 1_000_000_000;     // 250 M FBiT
pub const MIN_STAKE_LAMPORTS: u64 = 100_000_000;                      // 0.1 FBiT minimum per stake
pub const MAX_STAKE_LAMPORTS: u64 = 250_000_000 * 1_000_000_000;     // 250 M FBiT maximum per stake

// Default team target tier thresholds (9 decimals = multiply by 10^9).
// Bronze starts at 50K FBiT; Titan tops out at 100M FBiT (40% of the 250M fixed
// supply) — very ambitious, but reachable as reward emission and secondary-market
// circulation grow over time, unlike a naive 250M top tier which would require
// staking the entire fixed supply (impossible: liquidity + reserve alone already
// account for 247M of it, permanently outside user wallets).
// Tier 1: 50K tokens → 2%  …  Tier 10: 100M tokens → 10%
pub const DEFAULT_TEAM_MIN_STAKED: [u64; 10] = [
    50_000_u64      * 1_000_000_000,   //   50 K
    100_000_u64     * 1_000_000_000,   //  100 K
    250_000_u64     * 1_000_000_000,   //  250 K
    500_000_u64     * 1_000_000_000,   //  500 K
    1_000_000_u64   * 1_000_000_000,   //    1 M
    2_500_000_u64   * 1_000_000_000,   //    2.5 M
    5_000_000_u64   * 1_000_000_000,   //    5 M
    10_000_000_u64  * 1_000_000_000,   //   10 M
    20_000_000_u64  * 1_000_000_000,   //   20 M
    100_000_000_u64 * 1_000_000_000,   //  100 M
];
pub const DEFAULT_TEAM_BONUS_BPS: [u64; 10] = [200, 300, 400, 500, 600, 700, 750, 850, 900, 1000];

// Default per-level referral percentages in BPS (same as the original constants).
// Stored on Platform so admin can update them without redeploying the contract.
pub const DEFAULT_REFERRAL_PERCENTAGES: [u64; 10] = [25, 50, 125, 150, 200, 325, 350, 425, 550, 800];
// Maximum total referral BPS across all 10 levels combined (safety ceiling: 50% of staked amount).
pub const MAX_TOTAL_REFERRAL_BPS: u64 = 5_000;

// ===== HELPER =====

/// PoS dynamic APY in BPS: annual_emission / total_staked * 10_000, clamped 1000–30000 (10%–300%).
/// Falls back to `fallback_apy` when emission or total_staked is 0.
fn get_effective_apy_bps(platform: &Platform, fallback_apy: u64) -> u64 {
    if platform.annual_emission > 0 && platform.total_staked > 0 {
        let apy = (platform.annual_emission as u128)
            .saturating_mul(10_000)
            / (platform.total_staked as u128);
        (apy.max(1_000).min(30_000)) as u64
    } else {
        // Fallback is also clamped to PoS range (10%–300%)
        fallback_apy.max(1_000).min(30_000)
    }
}

/// Returns the bonus BPS for a user based on their stored team_total_staked.
fn get_team_bonus_bps(platform: &Platform, user_account: &UserAccount) -> u64 {
    let team_staked = user_account.team_total_staked;
    let mut i = 9usize;
    loop {
        if platform.team_tier_min_staked[i] > 0 && team_staked >= platform.team_tier_min_staked[i] {
            return platform.team_tier_bonus_bps[i];
        }
        if i == 0 { break; }
        i -= 1;
    }
    0
}

// ===== PROGRAM =====

#[program]
pub mod fbit_staking {
    use super::*;

    // ─────────────────────────────────────────────────────────────────────────────
    // PLATFORM
    // ─────────────────────────────────────────────────────────────────────────────

    pub fn initialize(ctx: Context<Initialize>, reward_rate: u64, referral_reward_rate: u64) -> Result<()> {
        let p = &mut ctx.accounts.platform;
        p.authority            = ctx.accounts.authority.key();
        p.reward_token_mint    = ctx.accounts.reward_token_mint.key();
        p.stake_token_mint     = ctx.accounts.stake_token_mint.key();
        p.reward_rate          = reward_rate;
        p.referral_reward_rate = referral_reward_rate;
        p.total_staked         = 0;
        p.total_users          = 0;
        p.reward_pool_balance  = 0;
        p.is_paused            = false;
        p.base_apy             = DEFAULT_APY;
        // Team Target Bonus tiers
        p.team_tier_min_staked = DEFAULT_TEAM_MIN_STAKED;
        p.team_tier_bonus_bps  = DEFAULT_TEAM_BONUS_BPS;
        p.bump                 = ctx.bumps.platform;
        p.total_burned         = 0;
        // halving_epoch / halving_start_time: unused — kept only for backward-compatible
        // account byte-layout with the currently deployed v1 program (see Platform struct).
        p.halving_epoch        = 0;
        p.halving_start_time   = Clock::get()?.unix_timestamp;
        // Renouncement (inactive at launch)
        p.is_renounced         = false;
        p.fee_recipient        = Pubkey::default();
        p.total_fees_collected = 0;
        // Auto-emission reserve
        p.total_reserve           = 0;
        p.total_emission_released = 0;
        p.emission_start_time     = 0;
        p.last_release_time       = 0;
        // Settable emission & burn rate
        p.annual_emission = 0;
        p.burn_bps        = BURN_BPS; // default 10%
        // Per-level referral percentages (updatable by admin)
        p.referral_percentages = DEFAULT_REFERRAL_PERCENTAGES;
        Ok(())
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // AUTO-EMISSION RESERVE
    // ─────────────────────────────────────────────────────────────────────────────

    /// Admin: deposit tokens into the long-term reserve vault.
    /// Starts the emission clock on first deposit.
    pub fn deposit_reserve(ctx: Context<DepositReserve>, amount: u64) -> Result<()> {
        require!(!ctx.accounts.platform.is_paused, StakingError::PlatformPaused);
        require!(ctx.accounts.authority.key() == ctx.accounts.platform.authority, StakingError::Unauthorized);
        require!(amount >= MIN_FUND_LAMPORTS, StakingError::BelowMinDeposit);
        require!(amount <= MAX_FUND_LAMPORTS, StakingError::AboveMaxDeposit);

        token::transfer(CpiContext::new(ctx.accounts.token_program.to_account_info(), Transfer {
            from:      ctx.accounts.funder_token_account.to_account_info(),
            to:        ctx.accounts.reserve_vault.to_account_info(),
            authority: ctx.accounts.authority.to_account_info(),
        }), amount)?;

        // Start emission clock on first deposit
        if ctx.accounts.platform.emission_start_time == 0 {
            let now = Clock::get()?.unix_timestamp;
            ctx.accounts.platform.emission_start_time = now;
            ctx.accounts.platform.last_release_time   = now;
        }

        ctx.accounts.platform.total_reserve =
            ctx.accounts.platform.total_reserve.checked_add(amount).unwrap();

        emit!(ReserveDeposited {
            authority:     ctx.accounts.authority.key(),
            amount,
            total_reserve: ctx.accounts.platform.total_reserve,
        });
        Ok(())
    }

    /// Permissionless: release accumulated emission from reserve into reward pool.
    /// Anyone can call — the math determines how much is available.
    ///
    /// Uses an INCREMENTAL clock (`last_release_time`) rather than measuring from
    /// `emission_start_time` on every call. This stays correct even if `annual_emission`
    /// is changed mid-flight (via `set_annual_emission`): applying the *current* rate
    /// retroactively across the *entire* elapsed history (the old formula) would compute
    /// a lower "should have released by now" total than what was already released under
    /// a higher prior rate — permanently blocking further releases. Measuring only the
    /// time since the last release avoids this: each call only ever applies the current
    /// rate to the time elapsed since it was last checked, regardless of how many rate
    /// changes happened in between.
    pub fn release_emission(ctx: Context<ReleaseEmission>) -> Result<()> {
        require!(!ctx.accounts.platform.is_paused, StakingError::PlatformPaused);

        let annual = ctx.accounts.platform.annual_emission;
        require!(annual > 0, StakingError::AnnualEmissionNotSet);
        require!(ctx.accounts.platform.emission_start_time > 0, StakingError::ReserveNotFunded);
        require!(ctx.accounts.platform.total_reserve > 0, StakingError::ReserveNotFunded);

        let now       = Clock::get()?.unix_timestamp;
        let elapsed   = (now - ctx.accounts.platform.last_release_time).max(0) as u64;
        let secs_year = 365u64 * 86_400;

        // Use u128 to prevent overflow: annual (up to 8e14) * elapsed (up to ~1e10)
        // = ~8e24 which exceeds u64::MAX (1.8e19).
        let release_amount: u64 = {
            let t = (annual as u128)
                .saturating_mul(elapsed as u128)
                .checked_div(secs_year as u128)
                .unwrap_or(u128::MAX);
            t.min(ctx.accounts.platform.total_reserve as u128) as u64
        };
        require!(release_amount > 0, StakingError::NoEmissionAvailable);

        let bump   = ctx.accounts.platform.bump;
        let seeds  = &[b"platform".as_ref(), &[bump]];
        let signer = &[&seeds[..]];

        token::transfer(CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from:      ctx.accounts.reserve_vault.to_account_info(),
                to:        ctx.accounts.reward_vault.to_account_info(),
                authority: ctx.accounts.platform.to_account_info(),
            },
            signer,
        ), release_amount)?;

        ctx.accounts.platform.total_reserve =
            ctx.accounts.platform.total_reserve.checked_sub(release_amount).unwrap();
        ctx.accounts.platform.total_emission_released =
            ctx.accounts.platform.total_emission_released.checked_add(release_amount).unwrap();
        ctx.accounts.platform.reward_pool_balance =
            ctx.accounts.platform.reward_pool_balance.checked_add(release_amount).unwrap();
        ctx.accounts.platform.last_release_time = now;

        emit!(EmissionReleased {
            amount:         release_amount,
            total_released: ctx.accounts.platform.total_emission_released,
            remaining:      ctx.accounts.platform.total_reserve,
        });
        Ok(())
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // POOL FUNDING
    // ─────────────────────────────────────────────────────────────────────────────

    pub fn fund_reward_pool(ctx: Context<FundRewardPool>, amount: u64) -> Result<()> {
        require!(!ctx.accounts.platform.is_paused, StakingError::PlatformPaused);
        require!(ctx.accounts.authority.key() == ctx.accounts.platform.authority, StakingError::Unauthorized);
        require!(amount >= MIN_FUND_LAMPORTS, StakingError::BelowMinDeposit);
        require!(amount <= MAX_FUND_LAMPORTS, StakingError::AboveMaxDeposit);

        token::transfer(CpiContext::new(ctx.accounts.token_program.to_account_info(), Transfer {
            from:      ctx.accounts.funder_token_account.to_account_info(),
            to:        ctx.accounts.reward_vault.to_account_info(),
            authority: ctx.accounts.authority.to_account_info(),
        }), amount)?;

        ctx.accounts.platform.reward_pool_balance =
            ctx.accounts.platform.reward_pool_balance.checked_add(amount).unwrap();

        emit!(RewardPoolFunded {
            authority: ctx.accounts.authority.key(), amount,
            total_pool: ctx.accounts.platform.reward_pool_balance,
        });
        Ok(())
    }

    /// Admin: withdraw tokens from the reward vault back to admin's token account.
    /// Used for emergency recovery or pre-launch corrections.
    /// Not allowed after ownership is renounced.
    pub fn refund_reward_pool(ctx: Context<RefundRewardPool>, amount: u64) -> Result<()> {
        require!(ctx.accounts.authority.key() == ctx.accounts.platform.authority, StakingError::Unauthorized);
        require!(!ctx.accounts.platform.is_renounced, StakingError::AlreadyRenounced);
        require!(amount > 0, StakingError::InvalidAmount);
        require!(ctx.accounts.platform.reward_pool_balance >= amount, StakingError::InsufficientRewardPool);

        let bump   = ctx.accounts.platform.bump;
        let seeds  = &[b"platform".as_ref(), &[bump]];
        let signer = &[&seeds[..]];

        token::transfer(CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from:      ctx.accounts.reward_vault.to_account_info(),
                to:        ctx.accounts.authority_token_account.to_account_info(),
                authority: ctx.accounts.platform.to_account_info(),
            },
            signer,
        ), amount)?;

        ctx.accounts.platform.reward_pool_balance =
            ctx.accounts.platform.reward_pool_balance.checked_sub(amount).unwrap();

        emit!(RewardPoolRefunded {
            authority:  ctx.accounts.authority.key(),
            amount,
            remaining:  ctx.accounts.platform.reward_pool_balance,
        });
        Ok(())
    }

    pub fn register_user(ctx: Context<RegisterUser>, referrer: Option<Pubkey>) -> Result<()> {
        require!(!ctx.accounts.platform.is_paused, StakingError::PlatformPaused);

        // Non-admin users MUST supply a referrer pubkey.
        let is_admin = ctx.accounts.owner.key() == ctx.accounts.platform.authority;
        let has_referrer = referrer.is_some();
        require!(has_referrer || is_admin, StakingError::ReferrerRequired);

        if let Some(ref_key) = referrer {
            require!(ref_key != ctx.accounts.owner.key(), StakingError::SelfReferral);

            // The referrer must be a real, already-active staker (total_staked > 0) —
            // enforces "only users who have staked can refer new users", and as a direct
            // consequence makes a circular referrer chain (A→B, B→A) impossible: a
            // referrer must have registered AND staked strictly before their referee
            // registers, so no cycle can ever close. This closes the self-dealing exploit
            // in stake()'s referral-chain walk, where an attacker could otherwise craft a
            // cyclic referrer graph and have their own stake pay referral rewards back to
            // themselves across alternating levels.
            let ref_ai = &ctx.accounts.referrer_account;
            // referrer_account must be the referrer's own UserAccount PDA — re-derive it
            // on-chain rather than trusting the caller. (Comparing ref_ai.key() directly
            // to ref_key was wrong: a PDA never equals the wallet pubkey it's derived
            // from, so that check failed unconditionally for every legitimate referral.)
            let (expected_ref_pda, _) = Pubkey::find_program_address(&[b"user", ref_key.as_ref()], ctx.program_id);
            require!(ref_ai.key() == expected_ref_pda, StakingError::ReferrerMismatch);
            require!(ref_ai.owner == ctx.program_id, StakingError::ReferrerNotActive);
            let data = ref_ai.try_borrow_data().map_err(|_| error!(StakingError::ReferrerNotActive))?;
            require!(data.len() > 8, StakingError::ReferrerNotActive);
            let mut slice: &[u8] = &data[8..];
            let referrer_user = UserAccount::deserialize(&mut slice)
                .map_err(|_| error!(StakingError::ReferrerNotActive))?;
            require!(referrer_user.owner == ref_key, StakingError::ReferrerMismatch);
            require!(referrer_user.total_staked > 0, StakingError::ReferrerNotActive);
        }

        let user = &mut ctx.accounts.user_account;
        user.owner                  = ctx.accounts.owner.key();
        user.total_staked           = 0;
        user.total_rewards_earned   = 0;
        user.total_referral_rewards = 0;
        user.referrer               = referrer;
        user.referral_count         = 0;
        user.is_blocked             = false;
        user.registered_at          = Clock::get()?.unix_timestamp;
        user.team_size              = 0;
        user.team_total_staked      = 0;
        user.stake_count            = 0;
        user.bump                   = ctx.bumps.user_account;

        ctx.accounts.platform.total_users =
            ctx.accounts.platform.total_users.checked_add(1).unwrap();

        emit!(UserRegistered { user: ctx.accounts.owner.key(), referrer, timestamp: Clock::get()?.unix_timestamp });
        Ok(())
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // STAKING  (1 % platform fee on every operation)
    // ─────────────────────────────────────────────────────────────────────────────

    pub fn stake<'info>(ctx: Context<'_, '_, '_, 'info, Stake<'info>>, amount: u64, lock_period_index: u8) -> Result<()> {
        require!(!ctx.accounts.platform.is_paused, StakingError::PlatformPaused);
        require!(!ctx.accounts.user_account.is_blocked, StakingError::UserBlocked);
        require!(amount >= MIN_STAKE_LAMPORTS, StakingError::BelowMinStake);
        require!(amount <= MAX_STAKE_LAMPORTS, StakingError::AboveMaxStake);
        require!((lock_period_index as usize) < 1, StakingError::InvalidLockPeriod);

        let now        = Clock::get()?.unix_timestamp;
        let lock_days  = LOCK_PERIODS[lock_period_index as usize];
        let unlock_at  = now + (lock_days as i64 * SECONDS_PER_DAY);
        // PoS: store current dynamic APY for display (actual reward uses live APY at claim time)
        let apy = get_effective_apy_bps(&ctx.accounts.platform, ctx.accounts.platform.base_apy[lock_period_index as usize]);
        let _referrer  = ctx.accounts.user_account.referrer;
        let ref_rate   = ctx.accounts.platform.referral_reward_rate;

        // Platform fee (0.25%) — applies always, whether renounced or not. Routes to
        // admin_stake_account, which resolves to the authority's ATA normally or
        // the fee_recipient's ATA after renouncement (see Stake account constraints).
        let fee           = amount.checked_mul(PLATFORM_FEE_BPS).unwrap().checked_div(10_000).unwrap();
        let staked_amount = amount.checked_sub(fee).unwrap();

        let tp = ctx.accounts.token_program.to_account_info();
        let user_ta = ctx.accounts.user_token_account.to_account_info();
        let owner_ai = ctx.accounts.owner.to_account_info();

        if fee > 0 {
            token::transfer(CpiContext::new(tp.clone(), Transfer {
                from: user_ta.clone(), to: ctx.accounts.admin_stake_account.to_account_info(), authority: owner_ai.clone(),
            }), fee)?;
            if ctx.accounts.platform.is_renounced {
                ctx.accounts.platform.total_fees_collected =
                    ctx.accounts.platform.total_fees_collected.checked_add(fee).unwrap();
            }
        }
        token::transfer(CpiContext::new(tp, Transfer {
            from: user_ta, to: ctx.accounts.stake_vault.to_account_info(), authority: owner_ai,
        }), staked_amount)?;

        let se = &mut ctx.accounts.stake_entry;
        se.owner             = ctx.accounts.owner.key();
        se.amount            = staked_amount;
        se.lock_period_index = lock_period_index;
        se.staked_at         = now;
        se.unlock_at         = unlock_at;
        se.last_claim_at     = now;
        se.total_claimed     = 0;
        se.is_active         = true;
        se.apy               = apy;
        se.stake_id          = ctx.accounts.user_account.stake_count;
        se.bump              = ctx.bumps.stake_entry;

        ctx.accounts.user_account.total_staked =
            ctx.accounts.user_account.total_staked.checked_add(staked_amount).unwrap();
        // Update this user's team_total_staked (will also be updated by admin crank for ancestors)
        ctx.accounts.user_account.team_total_staked =
            ctx.accounts.user_account.team_total_staked.checked_add(staked_amount).unwrap();
        ctx.accounts.platform.total_staked =
            ctx.accounts.platform.total_staked.checked_add(staked_amount).unwrap();
        ctx.accounts.user_account.stake_count =
            ctx.accounts.user_account.stake_count.checked_add(1).unwrap();

        // ── 10-level referral rewards via remaining_accounts ─────────────────────
        // remaining_accounts layout: pairs of [UserAccount PDA (mut), reward ATA (mut)]
        // pair index 0 = Level 1 (direct referrer), index 1 = Level 2, …, index 9 = Level 10.
        if !ctx.remaining_accounts.is_empty() && ref_rate > 0 {
            let remaining           = ctx.remaining_accounts;
            let mut cur_referrer    = ctx.accounts.user_account.referrer;
            let bump                = ctx.accounts.platform.bump;
            let seeds               = &[b"platform".as_ref(), &[bump]];
            let signer              = &[&seeds[..]];
            let reward_vault_ai     = ctx.accounts.reward_vault.to_account_info();
            let token_program_ai    = ctx.accounts.token_program.to_account_info();
            let platform_ai         = ctx.accounts.platform.to_account_info();
            // Pre-read reward mint for ATA verification (C1)
            let reward_mint_key     = ctx.accounts.reward_vault.mint;

            for level in 0..MAX_REFERRAL_LEVELS {
                let pair_start = level * 2;
                if pair_start + 1 >= remaining.len() { break; }
                let Some(expected_key) = cur_referrer else { break; };

                // Defense-in-depth: the staker must never appear in their own referral
                // chain. Unreachable in practice now that register_user requires a
                // referrer to already have staked (which makes any circular chain
                // impossible to construct in the first place) — kept as a cheap,
                // direct guard rather than relying solely on that invariant.
                if expected_key == ctx.accounts.owner.key() { break; }

                let ref_user_ai   = &remaining[pair_start];
                let ref_reward_ai = &remaining[pair_start + 1];

                // [H1] Verify UserAccount is owned by this program — prevents crafted accounts
                if ref_user_ai.owner != ctx.program_id { break; }

                // Read-only borrow to get owner/blocked/next-referrer (scoped — released before mut borrow)
                let (user_owner, is_blocked, next_ref): (Pubkey, bool, Option<Pubkey>) = {
                    let data = ref_user_ai.try_borrow_data()
                        .map_err(|_| error!(StakingError::Unauthorized))?;
                    let mut slice: &[u8] = &data[8..];
                    match UserAccount::deserialize(&mut slice) {
                        Ok(u) => (u.owner, u.is_blocked, u.referrer),
                        Err(_) => break,
                    }
                };

                // Verify the account matches the expected referrer BEFORE advancing the chain.
                // If the provided account doesn't match the expected on-chain referrer, abort the
                // entire chain walk — continuing with unverified data would let an attacker
                // inject a fake ancestor and steal rewards from legitimate referrers above it.
                if user_owner != expected_key {
                    break;
                }
                cur_referrer = next_ref;

                // Use stored per-level %; fall back to compile-time constant for legacy accounts (field = 0).
                let level_bps  = if ctx.accounts.platform.referral_percentages[level] > 0 {
                    ctx.accounts.platform.referral_percentages[level]
                } else {
                    REFERRAL_PERCENTAGES[level]
                };
                let ref_reward = staked_amount.checked_mul(level_bps).unwrap().checked_div(10_000).unwrap();
                let can_pay    = !is_blocked && ref_reward > 0 && ctx.accounts.platform.reward_pool_balance >= ref_reward;

                // [C1] Verify reward ATA — soft-checked, mirrors claim_rewards/compound_rewards'
                // ata_ok pattern below. A malformed/missing/mismatched ATA (e.g. the referrer
                // staked their full balance and their wallet auto-closed the resulting empty
                // ATA to reclaim rent) now skips just this level's payment instead of hard-
                // failing the staker's entire transaction with InvalidReferralATA — that bug
                // blocked every downstream stake whenever any single upline referrer's ATA was
                // temporarily gone, even though team_total_staked/team_size below don't depend
                // on payment at all and always should have gone through regardless.
                let ata_ok = can_pay && ref_reward_ai.owner == &token::ID && {
                    match ref_reward_ai.try_borrow_data() {
                        Ok(d) if d.len() >= 64 => {
                            let ata_mint: [u8; 32]  = d[0..32].try_into().unwrap();
                            let ata_owner: [u8; 32] = d[32..64].try_into().unwrap();
                            Pubkey::from(ata_mint) == reward_mint_key && Pubkey::from(ata_owner) == expected_key
                        }
                        _ => false,
                    }
                };
                let will_pay = can_pay && ata_ok;

                // Mutable update: team_total_staked (always) + total_referral_rewards (if paying)
                // Single write per ancestor — automatic team tracking.
                {
                    let mut data = ref_user_ai.try_borrow_mut_data()
                        .map_err(|_| error!(StakingError::Unauthorized))?;
                    let mut updated = {
                        let mut slice: &[u8] = &data[8..];
                        UserAccount::deserialize(&mut slice)
                            .map_err(|_| error!(StakingError::Unauthorized))?
                    };
                    updated.team_total_staked = updated.team_total_staked.saturating_add(staked_amount);
                    // On first stake: stake_count was already incremented to 1 before this loop,
                    // so stake_count == 1 means this is the user's very first stake.
                    if level == 0 && ctx.accounts.user_account.stake_count == 1 {
                        updated.referral_count = updated.referral_count.saturating_add(1);
                        updated.team_size      = updated.team_size.saturating_add(1);
                    }
                    if will_pay {
                        updated.total_referral_rewards = updated.total_referral_rewards
                            .checked_add(ref_reward).unwrap();
                    }
                    updated.serialize(&mut &mut data[8..])
                        .map_err(|_| error!(StakingError::Unauthorized))?;
                }

                if !will_pay { continue; }

                // Transfer reward_vault → referrer's reward ATA
                token::transfer(CpiContext::new_with_signer(
                    token_program_ai.clone(),
                    Transfer {
                        from:      reward_vault_ai.clone(),
                        to:        ref_reward_ai.clone(),
                        authority: platform_ai.clone(),
                    },
                    signer,
                ), ref_reward)?;

                ctx.accounts.platform.reward_pool_balance =
                    ctx.accounts.platform.reward_pool_balance.checked_sub(ref_reward).unwrap();

                emit!(ReferralReward {
                    staker:   ctx.accounts.owner.key(),
                    referrer: expected_key,
                    amount:   ref_reward,
                    level:    level as u8,
                });
            }
        }
        emit!(TokensStaked { user: ctx.accounts.owner.key(), amount: staked_amount, fee, lock_period: lock_days, unlock_at, apy });
        Ok(())
    }

    pub fn claim_rewards<'info>(ctx: Context<'_, '_, '_, 'info, ClaimRewards<'info>>, _stake_entry_id: u64) -> Result<()> {
        require!(!ctx.accounts.platform.is_paused, StakingError::PlatformPaused);
        require!(!ctx.accounts.user_account.is_blocked, StakingError::UserBlocked);
        require!(ctx.accounts.stake_entry.is_active, StakingError::StakeNotActive);

        let now     = Clock::get()?.unix_timestamp;
        let elapsed = now - ctx.accounts.stake_entry.last_claim_at;
        require!(elapsed >= CLAIM_INTERVAL, StakingError::ClaimTooEarly);

        let intervals    = elapsed as u64 / CLAIM_INTERVAL as u64;
        // Always use live PoS APY — dynamic, changes with total_staked in real time.
        let effective_apy = get_effective_apy_bps(
            &ctx.accounts.platform,
            ctx.accounts.platform.base_apy[ctx.accounts.stake_entry.lock_period_index as usize],
        );
        // Use u128 to avoid overflow: amount (≤5e14) * apy (≤30000) * intervals can exceed u64::MAX.
        let gross_reward: u64 = {
            let r = (ctx.accounts.stake_entry.amount as u128)
                .checked_mul(effective_apy as u128).unwrap()
                .checked_mul(intervals as u128).unwrap()
                .checked_div(1460u128 * 10_000).unwrap();
            r.min(u64::MAX as u128) as u64
        };

        require!(gross_reward > 0, StakingError::NoRewardsToClaim);

        // ── Team Target Bonus ──
        let team_bonus_bps = get_team_bonus_bps(&ctx.accounts.platform, &ctx.accounts.user_account);
        let team_bonus     = gross_reward.checked_mul(team_bonus_bps).unwrap().checked_div(10_000).unwrap();
        let total_gross    = gross_reward.checked_add(team_bonus).unwrap();

        // Platform fee (0.25%) — applies always, whether renounced or not. Routes to
        // admin_reward_account, which resolves to the authority's ATA normally or
        // the fee_recipient's ATA after renouncement (see ClaimRewards account constraints).
        let fee         = total_gross.checked_mul(PLATFORM_FEE_BPS).unwrap().checked_div(10_000).unwrap();
        let after_fee   = total_gross.checked_sub(fee).unwrap();

        // Live burn_bps is force-kept at CLAIM_BURN_BPS (5%) here — set_burn_bps is
        // permanently disabled post-renouncement, so this self-corrects the stored
        // field on every claim instead of letting it drift stale (see the v2.1
        // "displayed vs. actual burn rate" incident in the Changelog).
        if ctx.accounts.platform.burn_bps != CLAIM_BURN_BPS {
            ctx.accounts.platform.burn_bps = CLAIM_BURN_BPS;
        }
        let base_burn = after_fee.checked_mul(CLAIM_BURN_BPS).unwrap().checked_div(10_000).unwrap();

        let total_required = total_gross;
        require!(ctx.accounts.platform.reward_pool_balance >= total_required, StakingError::InsufficientRewardPool);

        let bump    = ctx.accounts.platform.bump;
        let seeds   = &[b"platform".as_ref(), &[bump]];
        let signer  = &[&seeds[..]];
        let tp      = ctx.accounts.token_program.to_account_info();
        let vault   = ctx.accounts.reward_vault.to_account_info();
        let plat_ai = ctx.accounts.platform.to_account_info();

        if fee > 0 {
            token::transfer(CpiContext::new_with_signer(tp.clone(), Transfer {
                from: vault.clone(), to: ctx.accounts.admin_reward_account.to_account_info(), authority: plat_ai.clone(),
            }, signer), fee)?;
            if ctx.accounts.platform.is_renounced {
                ctx.accounts.platform.total_fees_collected =
                    ctx.accounts.platform.total_fees_collected.checked_add(fee).unwrap();
                emit!(RenounceFeeCollected {
                    recipient:            ctx.accounts.platform.fee_recipient,
                    claimant:             ctx.accounts.owner.key(),
                    fee_amount:           fee,
                    total_fees_collected: ctx.accounts.platform.total_fees_collected,
                });
            }
        }

        // ── Claim-time recurring referral (levels 1-5, see CLAIM_REFERRAL_BPS) ──
        // Separate from the one-time stake-time referral (REFERRAL_PERCENTAGES) —
        // paid entirely out of THIS claim's own after-fee amount, never drawn from
        // the pool beyond what this claim already costs it (total_required above is
        // unchanged by this). remaining_accounts layout: pairs of
        // [UserAccount PDA (mut), reward ATA (mut)], pair 0 = level 1 (direct referrer).
        let mut referral_paid_amount: u64 = 0;
        let mut referral_paid_bps: u64 = 0;
        {
            let remaining        = ctx.remaining_accounts;
            let mut cur_referrer = ctx.accounts.user_account.referrer;
            let reward_mint_key  = ctx.accounts.reward_vault.mint;

            for level in 0..CLAIM_REFERRAL_LEVELS {
                let pair_start = level * 2;
                if pair_start + 1 >= remaining.len() { break; }
                let Some(expected_key) = cur_referrer else { break; };
                if expected_key == ctx.accounts.owner.key() { break; }

                let ref_user_ai   = &remaining[pair_start];
                let ref_reward_ai = &remaining[pair_start + 1];

                if ref_user_ai.owner != ctx.program_id { break; }

                let (user_owner, is_blocked, referrer_staked, next_ref): (Pubkey, bool, u64, Option<Pubkey>) = {
                    let data = ref_user_ai.try_borrow_data()
                        .map_err(|_| error!(StakingError::Unauthorized))?;
                    let mut slice: &[u8] = &data[8..];
                    match UserAccount::deserialize(&mut slice) {
                        Ok(u) => (u.owner, u.is_blocked, u.total_staked, u.referrer),
                        Err(_) => break,
                    }
                };

                // Verify identity BEFORE advancing the chain — same reasoning as stake()'s
                // referral walk: continuing with an unverified account would let an
                // attacker inject a fake ancestor. Once verified, advance regardless of
                // whether this level ends up actually payable (blocked/inactive/bad ATA
                // below don't invalidate the verified chain for deeper levels).
                if user_owner != expected_key { break; }
                cur_referrer = next_ref;

                let level_bps    = CLAIM_REFERRAL_BPS[level];
                let level_amount = after_fee.checked_mul(level_bps).unwrap().checked_div(10_000).unwrap();
                // "Active" mirrors the stake-time referral rule (register_user):
                // a referrer must already have staked to keep earning here too.
                let can_pay = !is_blocked && referrer_staked > 0 && level_amount > 0;
                if !can_pay { continue; }

                if ref_reward_ai.owner != &token::ID { continue; }
                let ata_ok = {
                    let ata_data = match ref_reward_ai.try_borrow_data() { Ok(d) => d, Err(_) => continue };
                    if ata_data.len() < 64 { false } else {
                        let ata_mint: [u8; 32]  = ata_data[0..32].try_into().unwrap();
                        let ata_owner: [u8; 32] = ata_data[32..64].try_into().unwrap();
                        Pubkey::from(ata_mint) == reward_mint_key && Pubkey::from(ata_owner) == expected_key
                    }
                };
                if !ata_ok { continue; } // malformed/mismatched ATA — this level's share stays unpaid, not an error

                token::transfer(CpiContext::new_with_signer(
                    tp.clone(),
                    Transfer { from: vault.clone(), to: ref_reward_ai.clone(), authority: plat_ai.clone() },
                    signer,
                ), level_amount)?;

                {
                    let mut data = ref_user_ai.try_borrow_mut_data()
                        .map_err(|_| error!(StakingError::Unauthorized))?;
                    let mut updated = {
                        let mut slice: &[u8] = &data[8..];
                        UserAccount::deserialize(&mut slice).map_err(|_| error!(StakingError::Unauthorized))?
                    };
                    updated.total_referral_rewards = updated.total_referral_rewards.checked_add(level_amount).unwrap();
                    updated.serialize(&mut &mut data[8..]).map_err(|_| error!(StakingError::Unauthorized))?;
                }

                referral_paid_amount = referral_paid_amount.checked_add(level_amount).unwrap();
                referral_paid_bps    = referral_paid_bps.checked_add(level_bps).unwrap();
                emit!(ClaimReferralPaid { claimant: ctx.accounts.owner.key(), referrer: expected_key, level: level as u8, amount: level_amount });
            }
        }

        // Any level that wasn't paid (chain too short, blocked/inactive referrer, no
        // referrer at all, or a malformed ATA) has its share split 50/50 between extra
        // burn and the claiming user — it never silently reverts to the user in full,
        // and it never inflates what the reward pool has to fund.
        let unpaid_bps    = CLAIM_REFERRAL_TOTAL_BPS.checked_sub(referral_paid_bps).unwrap();
        let unpaid_amount = after_fee.checked_mul(unpaid_bps).unwrap().checked_div(10_000).unwrap();
        let burn_extra    = unpaid_amount.checked_div(2).unwrap();
        let burn_amount   = base_burn.checked_add(burn_extra).unwrap();
        let user_reward   = after_fee
            .checked_sub(burn_amount).unwrap()
            .checked_sub(referral_paid_amount).unwrap();

        token::transfer(CpiContext::new_with_signer(tp.clone(), Transfer {
            from: vault.clone(), to: ctx.accounts.user_token_account.to_account_info(), authority: plat_ai.clone(),
        }, signer), user_reward)?;

        // Burn 1:1 equivalent from the reward vault
        token::burn(CpiContext::new_with_signer(tp, Burn {
            mint:      ctx.accounts.reward_token_mint.to_account_info(),
            from:      vault,
            authority: plat_ai,
        }, signer), burn_amount)?;

        ctx.accounts.stake_entry.last_claim_at = now;
        ctx.accounts.stake_entry.total_claimed =
            ctx.accounts.stake_entry.total_claimed.checked_add(user_reward).unwrap();
        ctx.accounts.user_account.total_rewards_earned =
            ctx.accounts.user_account.total_rewards_earned.checked_add(user_reward).unwrap();
        ctx.accounts.platform.reward_pool_balance =
            ctx.accounts.platform.reward_pool_balance.checked_sub(total_required).unwrap();
        ctx.accounts.platform.total_burned =
            ctx.accounts.platform.total_burned.checked_add(burn_amount).unwrap();

        if team_bonus > 0 {
            emit!(TeamBonusApplied { user: ctx.accounts.owner.key(), bonus_amount: team_bonus });
        }
        emit!(TokensBurned { user: ctx.accounts.owner.key(), burn_amount, total_burned: ctx.accounts.platform.total_burned });
        emit!(RewardsClaimed { user: ctx.accounts.owner.key(), amount: user_reward, fee, timestamp: now });
        Ok(())
    }

    pub fn compound_rewards<'info>(ctx: Context<'_, '_, '_, 'info, CompoundRewards<'info>>) -> Result<()> {
        require!(!ctx.accounts.platform.is_paused, StakingError::PlatformPaused);
        require!(!ctx.accounts.user_account.is_blocked, StakingError::UserBlocked);
        require!(ctx.accounts.stake_entry.is_active, StakingError::StakeNotActive);

        let now     = Clock::get()?.unix_timestamp;
        let elapsed = now - ctx.accounts.stake_entry.last_claim_at;
        require!(elapsed >= CLAIM_INTERVAL, StakingError::ClaimTooEarly);

        let intervals    = elapsed as u64 / CLAIM_INTERVAL as u64;
        // Always use live PoS APY — dynamic, changes with total_staked in real time.
        let effective_apy = get_effective_apy_bps(
            &ctx.accounts.platform,
            ctx.accounts.platform.base_apy[ctx.accounts.stake_entry.lock_period_index as usize],
        );
        // Use u128 to avoid overflow: amount (≤5e14) * apy (≤30000) * intervals can exceed u64::MAX.
        let gross_reward: u64 = {
            let r = (ctx.accounts.stake_entry.amount as u128)
                .checked_mul(effective_apy as u128).unwrap()
                .checked_mul(intervals as u128).unwrap()
                .checked_div(1460u128 * 10_000).unwrap();
            r.min(u64::MAX as u128) as u64
        };

        require!(gross_reward > 0, StakingError::NoRewardsToClaim);

        // ── Team Target Bonus ──
        let team_bonus_bps = get_team_bonus_bps(&ctx.accounts.platform, &ctx.accounts.user_account);
        let team_bonus     = gross_reward.checked_mul(team_bonus_bps).unwrap().checked_div(10_000).unwrap();
        let total_gross    = gross_reward.checked_add(team_bonus).unwrap();

        // Platform fee (0.25%) — applies always, whether renounced or not. Routes to
        // admin_reward_account, which resolves to the authority's ATA normally or
        // the fee_recipient's ATA after renouncement (see CompoundRewards account constraints).
        let fee             = total_gross.checked_mul(PLATFORM_FEE_BPS).unwrap().checked_div(10_000).unwrap();
        let after_fee       = total_gross.checked_sub(fee).unwrap();

        // Live burn_bps is force-kept at CLAIM_BURN_BPS (5%) — see claim_rewards for why.
        if ctx.accounts.platform.burn_bps != CLAIM_BURN_BPS {
            ctx.accounts.platform.burn_bps = CLAIM_BURN_BPS;
        }
        let base_burn = after_fee.checked_mul(CLAIM_BURN_BPS).unwrap().checked_div(10_000).unwrap();

        let total_required = total_gross;
        require!(
            ctx.accounts.platform.reward_pool_balance >= total_required,
            StakingError::InsufficientRewardPool
        );

        let bump    = ctx.accounts.platform.bump;
        let seeds   = &[b"platform".as_ref(), &[bump]];
        let signer  = &[&seeds[..]];
        let tp      = ctx.accounts.token_program.to_account_info();
        let vault   = ctx.accounts.reward_vault.to_account_info();
        let plat_ai = ctx.accounts.platform.to_account_info();

        if fee > 0 {
            token::transfer(CpiContext::new_with_signer(tp.clone(), Transfer {
                from: vault.clone(), to: ctx.accounts.admin_reward_account.to_account_info(), authority: plat_ai.clone(),
            }, signer), fee)?;
            if ctx.accounts.platform.is_renounced {
                ctx.accounts.platform.total_fees_collected =
                    ctx.accounts.platform.total_fees_collected.checked_add(fee).unwrap();
                emit!(RenounceFeeCollected {
                    recipient:            ctx.accounts.platform.fee_recipient,
                    claimant:             ctx.accounts.owner.key(),
                    fee_amount:           fee,
                    total_fees_collected: ctx.accounts.platform.total_fees_collected,
                });
            }
        }

        // ── Claim-time recurring referral (levels 1-5) — see claim_rewards for the
        // full explanation; identical logic, mirrored here since compound_rewards
        // has its own separate account list / remaining_accounts.
        let mut referral_paid_amount: u64 = 0;
        let mut referral_paid_bps: u64 = 0;
        {
            let remaining        = ctx.remaining_accounts;
            let mut cur_referrer = ctx.accounts.user_account.referrer;
            let reward_mint_key  = ctx.accounts.reward_vault.mint;

            for level in 0..CLAIM_REFERRAL_LEVELS {
                let pair_start = level * 2;
                if pair_start + 1 >= remaining.len() { break; }
                let Some(expected_key) = cur_referrer else { break; };
                if expected_key == ctx.accounts.owner.key() { break; }

                let ref_user_ai   = &remaining[pair_start];
                let ref_reward_ai = &remaining[pair_start + 1];

                if ref_user_ai.owner != ctx.program_id { break; }

                let (user_owner, is_blocked, referrer_staked, next_ref): (Pubkey, bool, u64, Option<Pubkey>) = {
                    let data = ref_user_ai.try_borrow_data()
                        .map_err(|_| error!(StakingError::Unauthorized))?;
                    let mut slice: &[u8] = &data[8..];
                    match UserAccount::deserialize(&mut slice) {
                        Ok(u) => (u.owner, u.is_blocked, u.total_staked, u.referrer),
                        Err(_) => break,
                    }
                };

                if user_owner != expected_key { break; }
                cur_referrer = next_ref;

                let level_bps    = CLAIM_REFERRAL_BPS[level];
                let level_amount = after_fee.checked_mul(level_bps).unwrap().checked_div(10_000).unwrap();
                let can_pay = !is_blocked && referrer_staked > 0 && level_amount > 0;
                if !can_pay { continue; }

                if ref_reward_ai.owner != &token::ID { continue; }
                let ata_ok = {
                    let ata_data = match ref_reward_ai.try_borrow_data() { Ok(d) => d, Err(_) => continue };
                    if ata_data.len() < 64 { false } else {
                        let ata_mint: [u8; 32]  = ata_data[0..32].try_into().unwrap();
                        let ata_owner: [u8; 32] = ata_data[32..64].try_into().unwrap();
                        Pubkey::from(ata_mint) == reward_mint_key && Pubkey::from(ata_owner) == expected_key
                    }
                };
                if !ata_ok { continue; }

                token::transfer(CpiContext::new_with_signer(
                    tp.clone(),
                    Transfer { from: vault.clone(), to: ref_reward_ai.clone(), authority: plat_ai.clone() },
                    signer,
                ), level_amount)?;

                {
                    let mut data = ref_user_ai.try_borrow_mut_data()
                        .map_err(|_| error!(StakingError::Unauthorized))?;
                    let mut updated = {
                        let mut slice: &[u8] = &data[8..];
                        UserAccount::deserialize(&mut slice).map_err(|_| error!(StakingError::Unauthorized))?
                    };
                    updated.total_referral_rewards = updated.total_referral_rewards.checked_add(level_amount).unwrap();
                    updated.serialize(&mut &mut data[8..]).map_err(|_| error!(StakingError::Unauthorized))?;
                }

                referral_paid_amount = referral_paid_amount.checked_add(level_amount).unwrap();
                referral_paid_bps    = referral_paid_bps.checked_add(level_bps).unwrap();
                emit!(ClaimReferralPaid { claimant: ctx.accounts.owner.key(), referrer: expected_key, level: level as u8, amount: level_amount });
            }
        }

        let unpaid_bps       = CLAIM_REFERRAL_TOTAL_BPS.checked_sub(referral_paid_bps).unwrap();
        let unpaid_amount    = after_fee.checked_mul(unpaid_bps).unwrap().checked_div(10_000).unwrap();
        let burn_extra       = unpaid_amount.checked_div(2).unwrap();
        let burn_amount      = base_burn.checked_add(burn_extra).unwrap();
        let compound_amount  = after_fee
            .checked_sub(burn_amount).unwrap()
            .checked_sub(referral_paid_amount).unwrap();

        // Burn 1:1 equivalent from the reward vault
        token::burn(CpiContext::new_with_signer(tp, Burn {
            mint:      ctx.accounts.reward_token_mint.to_account_info(),
            from:      vault,
            authority: plat_ai,
        }, signer), burn_amount)?;

        ctx.accounts.platform.reward_pool_balance =
            ctx.accounts.platform.reward_pool_balance.checked_sub(total_required).unwrap();
        ctx.accounts.platform.total_burned =
            ctx.accounts.platform.total_burned.checked_add(burn_amount).unwrap();
        ctx.accounts.platform.total_staked =
            ctx.accounts.platform.total_staked.checked_add(compound_amount).unwrap();

        ctx.accounts.stake_entry.amount =
            ctx.accounts.stake_entry.amount.checked_add(compound_amount).unwrap();
        ctx.accounts.stake_entry.last_claim_at = now;

        ctx.accounts.user_account.total_staked =
            ctx.accounts.user_account.total_staked.checked_add(compound_amount).unwrap();
        ctx.accounts.user_account.team_total_staked =
            ctx.accounts.user_account.team_total_staked.checked_add(compound_amount).unwrap();
        ctx.accounts.user_account.total_rewards_earned =
            ctx.accounts.user_account.total_rewards_earned.checked_add(compound_amount).unwrap();

        if team_bonus > 0 {
            emit!(TeamBonusApplied { user: ctx.accounts.owner.key(), bonus_amount: team_bonus });
        }
        emit!(TokensBurned { user: ctx.accounts.owner.key(), burn_amount, total_burned: ctx.accounts.platform.total_burned });
        emit!(RewardsCompounded {
            user: ctx.accounts.owner.key(), amount: compound_amount, fee,
            new_stake: ctx.accounts.stake_entry.amount, timestamp: now,
        });
        Ok(())
    }

    pub fn unstake<'info>(ctx: Context<'_, '_, '_, 'info, Unstake<'info>>) -> Result<()> {
        require!(!ctx.accounts.platform.is_paused, StakingError::PlatformPaused);
        require!(ctx.accounts.stake_entry.is_active, StakingError::StakeNotActive);
        let now = Clock::get()?.unix_timestamp;
        require!(now >= ctx.accounts.stake_entry.unlock_at, StakingError::LockPeriodActive);

        let amount      = ctx.accounts.stake_entry.amount;
        // Platform fee (0.25%) — applies always, whether renounced or not. Routes to
        // admin_stake_account, which resolves to the authority's ATA normally or
        // the fee_recipient's ATA after renouncement (see Unstake account constraints).
        let fee         = amount.checked_mul(PLATFORM_FEE_BPS).unwrap().checked_div(10_000).unwrap();
        let user_amount = amount.checked_sub(fee).unwrap();

        let bump    = ctx.accounts.platform.bump;
        let seeds   = &[b"platform".as_ref(), &[bump]];
        let signer  = &[&seeds[..]];
        let tp      = ctx.accounts.token_program.to_account_info();
        let vault   = ctx.accounts.stake_vault.to_account_info();
        let plat_ai = ctx.accounts.platform.to_account_info();

        if fee > 0 {
            token::transfer(CpiContext::new_with_signer(tp.clone(), Transfer {
                from: vault.clone(), to: ctx.accounts.admin_stake_account.to_account_info(), authority: plat_ai.clone(),
            }, signer), fee)?;
            if ctx.accounts.platform.is_renounced {
                ctx.accounts.platform.total_fees_collected =
                    ctx.accounts.platform.total_fees_collected.checked_add(fee).unwrap();
            }
        }
        token::transfer(CpiContext::new_with_signer(tp, Transfer {
            from: vault, to: ctx.accounts.user_token_account.to_account_info(), authority: plat_ai,
        }, signer), user_amount)?;

        ctx.accounts.stake_entry.is_active = false;
        ctx.accounts.user_account.total_staked =
            ctx.accounts.user_account.total_staked.checked_sub(amount).unwrap();
        // Reduce own team_total_staked
        ctx.accounts.user_account.team_total_staked =
            ctx.accounts.user_account.team_total_staked.saturating_sub(amount);
        ctx.accounts.platform.total_staked =
            ctx.accounts.platform.total_staked.checked_sub(amount).unwrap();

        // ── Decrement ancestors' team_total_staked to mirror stake()'s unconditional
        // credit (see the referral loop in stake()) — otherwise a downline's
        // team_total_staked contribution would stay credited to every upline forever,
        // even after the downline fully unstakes. remaining_accounts layout: one
        // UserAccount PDA per level (no reward ATA needed — nothing is transferred
        // here, only a counter is corrected). Identity is verified against the live
        // on-chain `.referrer` chain exactly like stake()'s walk, so a caller cannot
        // target an arbitrary account — only their own true upline chain is touched.
        // Optional: an empty remaining_accounts list simply skips this correction
        // (unstake() still succeeds), so older clients remain compatible.
        if !ctx.remaining_accounts.is_empty() {
            let remaining        = ctx.remaining_accounts;
            let mut cur_referrer = ctx.accounts.user_account.referrer;
            let staker_key       = ctx.accounts.owner.key();

            for level in 0..MAX_REFERRAL_LEVELS {
                if level >= remaining.len() { break; }
                let Some(expected_key) = cur_referrer else { break; };
                if expected_key == staker_key { break; }

                let ref_user_ai = &remaining[level];
                if ref_user_ai.owner != ctx.program_id { break; }

                let (user_owner, next_ref): (Pubkey, Option<Pubkey>) = {
                    let data = ref_user_ai.try_borrow_data()
                        .map_err(|_| error!(StakingError::Unauthorized))?;
                    let mut slice: &[u8] = &data[8..];
                    match UserAccount::deserialize(&mut slice) {
                        Ok(u) => (u.owner, u.referrer),
                        Err(_) => break,
                    }
                };

                if user_owner != expected_key { break; }
                cur_referrer = next_ref;

                let mut data = ref_user_ai.try_borrow_mut_data()
                    .map_err(|_| error!(StakingError::Unauthorized))?;
                let mut updated = {
                    let mut slice: &[u8] = &data[8..];
                    UserAccount::deserialize(&mut slice)
                        .map_err(|_| error!(StakingError::Unauthorized))?
                };
                updated.team_total_staked = updated.team_total_staked.saturating_sub(amount);
                updated.serialize(&mut &mut data[8..])
                    .map_err(|_| error!(StakingError::Unauthorized))?;
            }
        }

        emit!(TokensUnstaked { user: ctx.accounts.owner.key(), amount: user_amount, fee, timestamp: now });
        Ok(())
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // ADMIN
    // ─────────────────────────────────────────────────────────────────────────────

    pub fn set_annual_emission(ctx: Context<AdminAction>, annual_emission: u64) -> Result<()> {
        require!(ctx.accounts.authority.key() == ctx.accounts.platform.authority, StakingError::Unauthorized);
        require!(annual_emission > 0, StakingError::InvalidAmount);
        ctx.accounts.platform.annual_emission = annual_emission;
        emit!(AnnualEmissionUpdated { annual_emission });
        Ok(())
    }

    pub fn set_burn_bps(ctx: Context<AdminAction>, burn_bps: u64) -> Result<()> {
        require!(ctx.accounts.authority.key() == ctx.accounts.platform.authority, StakingError::Unauthorized);
        require!(burn_bps <= 5000, StakingError::BurnBpsTooHigh);
        ctx.accounts.platform.burn_bps = burn_bps;
        emit!(BurnBpsUpdated { burn_bps });
        Ok(())
    }

    /// Admin: update per-level referral percentages (in BPS).
    /// Total across all 10 levels must not exceed MAX_TOTAL_REFERRAL_BPS (50%).
    pub fn set_referral_percentages(ctx: Context<AdminAction>, percentages: [u64; 10]) -> Result<()> {
        require!(ctx.accounts.authority.key() == ctx.accounts.platform.authority, StakingError::Unauthorized);
        let total: u64 = percentages.iter().sum();
        require!(total <= MAX_TOTAL_REFERRAL_BPS, StakingError::ReferralPercentagesTooHigh);
        ctx.accounts.platform.referral_percentages = percentages;
        emit!(ReferralPercentagesUpdated { percentages });
        Ok(())
    }

    pub fn set_referral_reward_rate(ctx: Context<AdminAction>, new_rate: u64) -> Result<()> {
        require!(ctx.accounts.authority.key() == ctx.accounts.platform.authority, StakingError::Unauthorized);
        ctx.accounts.platform.referral_reward_rate = new_rate;
        emit!(ReferralRateUpdated { new_rate });
        Ok(())
    }

    /// Admin: point the platform at a different stake/reward token mint.
    /// Existing vaults stay bound to their original mint (SPL token accounts can't be
    /// re-pointed) — callers must supply freshly created vaults for the new mint via
    /// the accounts passed into stake/claim/etc. after this call.
    pub fn set_token_mints(ctx: Context<AdminAction>, new_stake_mint: Pubkey, new_reward_mint: Pubkey) -> Result<()> {
        require!(ctx.accounts.authority.key() == ctx.accounts.platform.authority, StakingError::Unauthorized);
        ctx.accounts.platform.stake_token_mint  = new_stake_mint;
        ctx.accounts.platform.reward_token_mint = new_reward_mint;
        emit!(TokenMintsUpdated { stake_token_mint: new_stake_mint, reward_token_mint: new_reward_mint });
        Ok(())
    }

    /// Admin-only, one-time-use after `set_token_mints`: zero out the accumulated
    /// financial counters that were denominated in the OLD mint's tokens/decimals.
    /// `set_token_mints` only repoints the mint pubkeys — it does not (and must
    /// not) move any tokens, so these counters are left stale, no longer matching
    /// the real balance of the freshly created (empty) vaults for the new mint.
    /// Left in place, they would corrupt `release_emission`/`claim_rewards` math
    /// (e.g. treating an empty new reserve vault as if it still held the old
    /// reserve balance). Does NOT touch identity/config fields (authority, mints,
    /// rates, team tiers, referral percentages, total_users, is_renounced) —
    /// only resets accumulated stats that are meaningless across a mint change.
    pub fn reset_platform_stats(ctx: Context<AdminAction>) -> Result<()> {
        require!(ctx.accounts.authority.key() == ctx.accounts.platform.authority, StakingError::Unauthorized);
        let p = &mut ctx.accounts.platform;
        p.total_staked             = 0;
        p.reward_pool_balance      = 0;
        p.total_burned             = 0;
        p.total_reserve            = 0;
        p.total_emission_released  = 0;
        p.emission_start_time      = 0;
        p.last_release_time        = 0;
        emit!(PlatformStatsReset { authority: ctx.accounts.authority.key() });
        Ok(())
    }

    /// Admin-only cleanup: burns the ENTIRE balance of a stale token vault still owned
    /// by the Platform PDA — e.g. the old reserve/stake/reward vault left behind by a
    /// token migration (`set_token_mints`), which repoints the platform's mint pubkeys
    /// but never moves the old vaults' balances. Hard-blocked by the account constraints
    /// from ever touching a vault denominated in the CURRENT stake/reward mint — this can
    /// only destroy tokens that are already orphaned relative to the live platform config,
    /// never live user/reserve funds. Closes the vault afterward, returning its
    /// rent-exempt SOL to the admin.
    pub fn burn_stale_vault(ctx: Context<BurnStaleVault>) -> Result<()> {
        require!(ctx.accounts.authority.key() == ctx.accounts.platform.authority, StakingError::Unauthorized);
        let amount = ctx.accounts.stale_vault.amount;
        require!(amount > 0, StakingError::InvalidAmount);

        let bump   = ctx.accounts.platform.bump;
        let seeds  = &[b"platform".as_ref(), &[bump]];
        let signer = &[&seeds[..]];

        token::burn(CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Burn {
                mint:      ctx.accounts.stale_mint.to_account_info(),
                from:      ctx.accounts.stale_vault.to_account_info(),
                authority: ctx.accounts.platform.to_account_info(),
            },
            signer,
        ), amount)?;

        token::close_account(CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            token::CloseAccount {
                account:     ctx.accounts.stale_vault.to_account_info(),
                destination: ctx.accounts.authority.to_account_info(),
                authority:   ctx.accounts.platform.to_account_info(),
            },
            signer,
        ))?;

        emit!(StaleVaultBurned {
            vault:  ctx.accounts.stale_vault.key(),
            mint:   ctx.accounts.stale_mint.key(),
            amount,
        });
        Ok(())
    }

    /// Admin-only cleanup: force-marks a stale (pre-migration) StakeEntry inactive
    /// without moving any tokens. For StakeEntry records whose backing vault no
    /// longer matches the platform's current stake_token_mint (orphaned by
    /// `set_token_mints`) — these can never be resolved through the normal
    /// `unstake()` path since its vault-mint constraint now points at the new
    /// mint. Pair with `burn_stale_vault` for the orphaned vault that actually
    /// held these entries' tokens.
    pub fn void_stale_stake(ctx: Context<AdminStakeAction>) -> Result<()> {
        require!(ctx.accounts.authority.key() == ctx.accounts.platform.authority, StakingError::Unauthorized);
        require!(ctx.accounts.stake_entry.is_active, StakingError::StakeNotActive);
        ctx.accounts.stake_entry.is_active = false;
        emit!(StaleStakeVoided {
            stake_entry: ctx.accounts.stake_entry.key(),
            owner:       ctx.accounts.stake_entry.owner,
            amount:      ctx.accounts.stake_entry.amount,
        });
        Ok(())
    }

    /// Admin-only, one-time cleanup after the mint migration: zeroes a user's stale
    /// accumulated stats (staked/earned/referral/team totals) left over from the
    /// retired pre-migration token, giving them a clean slate under the new mint.
    /// Leaves identity fields (owner, referrer, is_blocked, registered_at) and
    /// `stake_count` (a monotonic PDA-seed counter — resetting it would risk
    /// colliding with an already-existing StakeEntry PDA on the user's next stake)
    /// untouched.
    pub fn reset_user_account(ctx: Context<AdminUserAction>) -> Result<()> {
        require!(ctx.accounts.authority.key() == ctx.accounts.platform.authority, StakingError::Unauthorized);
        let u = &mut ctx.accounts.user_account;
        u.total_staked           = 0;
        u.total_rewards_earned   = 0;
        u.total_referral_rewards = 0;
        u.referral_count         = 0;
        u.team_size              = 0;
        u.team_total_staked      = 0;
        // Also clear the referrer link itself — a full fresh-start reset, not just
        // the accumulated stats. Future stakes from this account pay no upline
        // referral commission until the user registers a new referrer (registration
        // is one-time, so in practice this account simply has no referrer going
        // forward — matches the "wipe everything" intent this was run for).
        u.referrer = None;
        emit!(UserAccountReset { user: u.owner });
        Ok(())
    }

    /// Admin-only cleanup: closes an empty UserAccount PDA, reclaiming its
    /// rent-exempt SOL to the admin and decrementing platform.total_users so the
    /// count reflects reality again. Requires total_staked == 0 as a safety
    /// check — refuses to close an account that still has real value tied to it.
    pub fn close_user_account(ctx: Context<CloseUserAccount>) -> Result<()> {
        require!(ctx.accounts.authority.key() == ctx.accounts.platform.authority, StakingError::Unauthorized);
        require!(ctx.accounts.user_account.total_staked == 0, StakingError::InvalidAmount);
        ctx.accounts.platform.total_users = ctx.accounts.platform.total_users.saturating_sub(1);
        emit!(UserAccountClosed { user: ctx.accounts.user_account.owner });
        Ok(())
    }

    /// Admin-only cleanup: closes an inactive StakeEntry PDA, reclaiming its
    /// rent-exempt SOL to the admin. Requires is_active == false — refuses to
    /// close a stake that's still live (real principal a user could still
    /// unstake). Closing (rather than just voiding) also removes the historical
    /// `total_claimed` figure that voiding alone leaves behind, which was still
    /// being summed into wallet-level "Total Claimed" displays after a reset.
    pub fn close_stake_entry(ctx: Context<CloseStakeEntry>) -> Result<()> {
        require!(ctx.accounts.authority.key() == ctx.accounts.platform.authority, StakingError::Unauthorized);
        require!(!ctx.accounts.stake_entry.is_active, StakingError::StakeNotActive);
        emit!(StakeEntryClosed {
            stake_entry: ctx.accounts.stake_entry.key(),
            owner:       ctx.accounts.stake_entry.owner,
        });
        Ok(())
    }

    pub fn block_user(ctx: Context<AdminUserAction>) -> Result<()> {
        require!(ctx.accounts.authority.key() == ctx.accounts.platform.authority, StakingError::Unauthorized);
        ctx.accounts.user_account.is_blocked = true;
        emit!(UserBlocked { user: ctx.accounts.user_account.owner });
        Ok(())
    }

    pub fn unblock_user(ctx: Context<AdminUserAction>) -> Result<()> {
        require!(ctx.accounts.authority.key() == ctx.accounts.platform.authority, StakingError::Unauthorized);
        ctx.accounts.user_account.is_blocked = false;
        emit!(UserUnblocked { user: ctx.accounts.user_account.owner });
        Ok(())
    }

    pub fn toggle_pause(ctx: Context<AdminAction>) -> Result<()> {
        require!(ctx.accounts.authority.key() == ctx.accounts.platform.authority, StakingError::Unauthorized);
        ctx.accounts.platform.is_paused = !ctx.accounts.platform.is_paused;
        emit!(PlatformPauseToggled { is_paused: ctx.accounts.platform.is_paused });
        Ok(())
    }

    pub fn set_lock_period_apy(ctx: Context<AdminAction>, index: u8, apy: u64) -> Result<()> {
        require!(ctx.accounts.authority.key() == ctx.accounts.platform.authority, StakingError::Unauthorized);
        require!((index as usize) < 1, StakingError::InvalidLockPeriod);
        require!(apy <= MAX_APY_BPS, StakingError::APYTooHigh);
        ctx.accounts.platform.base_apy[index as usize] = apy;
        emit!(LockPeriodAPYUpdated { index, apy });
        Ok(())
    }

    pub fn set_batch_apy(ctx: Context<AdminAction>, apy_values: [u64; 1]) -> Result<()> {
        require!(ctx.accounts.authority.key() == ctx.accounts.platform.authority, StakingError::Unauthorized);
        for apy in apy_values.iter() {
            require!(*apy <= MAX_APY_BPS, StakingError::APYTooHigh);
        }
        ctx.accounts.platform.base_apy = apy_values;
        for (i, apy) in apy_values.iter().enumerate() {
            emit!(LockPeriodAPYUpdated { index: i as u8, apy: *apy });
        }
        Ok(())
    }

    /// Update a single Team Target Bonus tier (index 0–9).
    pub fn set_team_target_tier(ctx: Context<AdminAction>, index: u8, min_team_staked: u64, bonus_bps: u64) -> Result<()> {
        require!(ctx.accounts.authority.key() == ctx.accounts.platform.authority, StakingError::Unauthorized);
        require!((index as usize) < 10, StakingError::InvalidTierIndex);
        require!(bonus_bps <= 1000, StakingError::TeamBonusTooHigh);   // max 10 %
        ctx.accounts.platform.team_tier_min_staked[index as usize] = min_team_staked;
        ctx.accounts.platform.team_tier_bonus_bps[index as usize]  = bonus_bps;
        emit!(TeamTargetTierUpdated { index, min_team_staked, bonus_bps });
        Ok(())
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // OWNERSHIP
    // ─────────────────────────────────────────────────────────────────────────────

    /// Permanently renounce admin ownership in exchange for a perpetual 25 % passive fee.
    /// - The caller (current authority) becomes `fee_recipient` and loses all admin privileges.
    /// - `platform.authority` is zeroed out so all `AdminAction` checks fail going forward.
    /// - Every subsequent claim / compound sends 25 % of gross reward to `fee_recipient` from pool.
    /// - The 1 % platform fee on all operations is waived after renouncement.
    /// - Irreversible.
    pub fn renounce_ownership(ctx: Context<RenounceOwnership>) -> Result<()> {
        let p = &mut ctx.accounts.platform;
        require!(ctx.accounts.authority.key() == p.authority, StakingError::Unauthorized);
        require!(!p.is_renounced, StakingError::AlreadyRenounced);
        let former_owner = p.authority;
        p.fee_recipient  = former_owner;
        p.is_renounced   = true;
        p.authority      = Pubkey::default(); // zeroes out admin access
        emit!(OwnershipRenounced {
            former_owner,
            timestamp: Clock::get()?.unix_timestamp,
        });
        Ok(())
    }

    /// Admin / indexer crank: set a user's team_size and team_total_staked.
    /// Called after on-chain stake / unstake events are processed off-chain.
    pub fn update_user_team_stats(ctx: Context<AdminUserAction>, team_size: u64, team_total_staked: u64) -> Result<()> {
        require!(ctx.accounts.authority.key() == ctx.accounts.platform.authority, StakingError::Unauthorized);
        ctx.accounts.user_account.team_size         = team_size;
        ctx.accounts.user_account.team_total_staked = team_total_staked;
        emit!(UserTeamStatsUpdated {
            user: ctx.accounts.user_account.owner,
            team_size,
            team_total_staked,
        });
        Ok(())
    }

    /// One-time migration: write the canonical PDA bump into platform.bump.
    /// The initial deployment omitted p.bump = ctx.bumps.platform in initialize,
    /// leaving bump=0 in every existing platform account. After this call,
    /// all `bump = platform.bump` constraints resolve to the correct PDA.
    pub fn fix_bump(ctx: Context<FixBump>) -> Result<()> {
        require!(
            ctx.accounts.authority.key() == ctx.accounts.platform.authority,
            StakingError::Unauthorized
        );
        ctx.accounts.platform.bump = ctx.bumps.platform;
        Ok(())
    }
}

// ===== ACCOUNT STRUCTS =====

#[account]
pub struct Platform {
    // ── Core fields (same byte-order as deployed v1) ──────────────────────────
    pub authority:            Pubkey,
    pub reward_token_mint:    Pubkey,
    pub stake_token_mint:     Pubkey,
    pub reward_rate:          u64,
    pub referral_reward_rate: u64,
    pub total_staked:         u64,
    pub total_users:          u64,
    pub reward_pool_balance:  u64,
    pub is_paused:            bool,
    pub base_apy:             [u64; 1],
    pub team_tier_min_staked: [u64; 10],
    pub team_tier_bonus_bps:  [u64; 10],
    pub total_burned:         u64,
    // Unused — the halving mechanic was removed. Kept for backward-compatible
    // account byte-layout with the currently deployed v1 program; do not repurpose.
    pub halving_epoch:        u64,
    pub halving_start_time:   i64,
    pub is_renounced:         bool,
    pub fee_recipient:        Pubkey,
    pub total_fees_collected: u64,
    pub bump:                 u8,   // ← kept LAST among v1 fields (backward-compat)
    // ── v2 fields (read as 0 from existing accounts; 600-byte space has room) ─
    pub total_reserve:           u64,
    pub total_emission_released: u64,
    pub emission_start_time:     i64,
    pub annual_emission:         u64,
    pub burn_bps:                u64,
    // ── v3 field (reads as [0;10] from existing accounts; falls back to compile-time const) ──
    pub referral_percentages:    [u64; 10],
    // ── v4 field: incremental emission-release clock (see release_emission) ──
    pub last_release_time:       i64,
}
// space: 8 disc + 371 (v1) + 40 (v2) + 80 (v3 referral_percentages) + 8 (v4) = 507 — fits in 600
pub const PLATFORM_SPACE: usize = 600;

#[account]
pub struct UserAccount {
    pub owner:                  Pubkey,
    pub total_staked:           u64,
    pub total_rewards_earned:   u64,
    pub total_referral_rewards: u64,
    pub referrer:               Option<Pubkey>,
    pub referral_count:         u64,
    pub is_blocked:             bool,
    pub registered_at:          i64,
    pub team_size:              u64,
    pub team_total_staked:      u64,
    pub stake_count:            u64,  // monotonic counter — used as stake PDA seed (prevents same-block collision)
    pub bump:                   u8,
}
// space: 8 + 32 + 8+8+8 + 33 + 8 + 1 + 8 + 8+8+8 + 1 = 139
pub const USER_ACCOUNT_SPACE: usize = 152;   // +13 bytes safety padding

#[account]
pub struct StakeEntry {
    pub owner:             Pubkey,
    pub amount:            u64,
    pub lock_period_index: u8,
    pub staked_at:         i64,
    pub unlock_at:         i64,
    pub last_claim_at:     i64,
    pub total_claimed:     u64,
    pub is_active:         bool,
    pub apy:               u64,
    pub stake_id:          u64,  // stored so claim/compound/unstake can re-derive the PDA seed
    pub bump:              u8,
}

// ===== CONTEXT STRUCTS =====

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(init, payer = authority, space = PLATFORM_SPACE, seeds = [b"platform"], bump)]
    pub platform:          Account<'info, Platform>,
    #[account(mut)]
    pub authority:         Signer<'info>,
    pub reward_token_mint: Account<'info, Mint>,
    pub stake_token_mint:  Account<'info, Mint>,
    pub system_program:    Program<'info, System>,
    pub token_program:     Program<'info, Token>,
    pub rent:              Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct FundRewardPool<'info> {
    #[account(mut, seeds = [b"platform"], bump = platform.bump)]
    pub platform:             Account<'info, Platform>,
    #[account(mut)]
    pub authority:            Signer<'info>,
    #[account(mut,
        constraint = funder_token_account.mint == platform.reward_token_mint @ StakingError::InvalidMint)]
    pub funder_token_account: Account<'info, TokenAccount>,
    #[account(mut,
        associated_token::mint      = platform.reward_token_mint,
        associated_token::authority = platform)]
    pub reward_vault:         Account<'info, TokenAccount>,
    pub token_program:        Program<'info, Token>,
}

#[derive(Accounts)]
pub struct RefundRewardPool<'info> {
    #[account(mut, seeds = [b"platform"], bump = platform.bump)]
    pub platform:                  Account<'info, Platform>,
    pub authority:                 Signer<'info>,
    #[account(mut,
        constraint = authority_token_account.owner == authority.key() @ StakingError::InvalidUserAccount,
        constraint = authority_token_account.mint  == platform.reward_token_mint @ StakingError::InvalidMint)]
    pub authority_token_account:   Account<'info, TokenAccount>,
    #[account(mut,
        associated_token::mint      = platform.reward_token_mint,
        associated_token::authority = platform)]
    pub reward_vault:              Account<'info, TokenAccount>,
    pub token_program:             Program<'info, Token>,
}

#[derive(Accounts)]
pub struct DepositReserve<'info> {
    #[account(mut, seeds = [b"platform"], bump = platform.bump)]
    pub platform:             Account<'info, Platform>,
    #[account(mut)]
    pub authority:            Signer<'info>,
    #[account(mut,
        constraint = funder_token_account.mint == platform.reward_token_mint @ StakingError::InvalidMint)]
    pub funder_token_account: Account<'info, TokenAccount>,
    #[account(mut,
        associated_token::mint      = platform.reward_token_mint,
        associated_token::authority = platform)]
    pub reserve_vault:        Account<'info, TokenAccount>,
    pub token_program:        Program<'info, Token>,
}

#[derive(Accounts)]
pub struct ReleaseEmission<'info> {
    #[account(mut, seeds = [b"platform"], bump = platform.bump)]
    pub platform:     Account<'info, Platform>,
    #[account(mut,
        associated_token::mint      = platform.reward_token_mint,
        associated_token::authority = platform)]
    pub reserve_vault: Account<'info, TokenAccount>,
    #[account(mut,
        associated_token::mint      = platform.reward_token_mint,
        associated_token::authority = platform)]
    pub reward_vault:  Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct RegisterUser<'info> {
    #[account(mut, seeds = [b"platform"], bump = platform.bump)]
    pub platform:     Account<'info, Platform>,
    #[account(init, payer = owner, space = USER_ACCOUNT_SPACE,
        seeds = [b"user", owner.key().as_ref()], bump)]
    pub user_account: Account<'info, UserAccount>,
    /// CHECK: manually validated in the handler only when the `referrer` instruction
    /// arg is Some — must be the referrer's own UserAccount PDA, owned by this program,
    /// with total_staked > 0 (an already-active staker). Ignored entirely when referrer
    /// is None (admin-only registration) — any account (e.g. a placeholder) may be
    /// passed in that case since it is never read.
    pub referrer_account: UncheckedAccount<'info>,
    #[account(mut)]
    pub owner:        Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Stake<'info> {
    #[account(mut, seeds = [b"platform"], bump = platform.bump)]
    pub platform:           Box<Account<'info, Platform>>,
    #[account(mut, seeds = [b"user", owner.key().as_ref()], bump = user_account.bump)]
    pub user_account:       Box<Account<'info, UserAccount>>,
    #[account(init, payer = owner, space = 8+32+8+1+8+8+8+8+1+8+8+1,
        seeds = [b"stake", owner.key().as_ref(), &user_account.stake_count.to_le_bytes()], bump)]
    pub stake_entry:        Box<Account<'info, StakeEntry>>,
    #[account(mut,
        constraint = user_token_account.owner == owner.key() @ StakingError::InvalidUserAccount,
        constraint = user_token_account.mint  == platform.stake_token_mint @ StakingError::InvalidMint)]
    pub user_token_account: Box<Account<'info, TokenAccount>>,
    #[account(mut,
        associated_token::mint      = platform.stake_token_mint,
        associated_token::authority = platform)]
    pub stake_vault:        Box<Account<'info, TokenAccount>>,
    /// Receives the 0.25% platform fee — the authority's ATA normally, or the
    /// fee_recipient's ATA after renouncement (fee still applies post-renounce).
    #[account(mut,
        constraint = (
            (platform.is_renounced  && admin_stake_account.owner == platform.fee_recipient) ||
            (!platform.is_renounced && admin_stake_account.owner == platform.authority)
        ) @ StakingError::InvalidAdminAccount,
        constraint = admin_stake_account.mint  == platform.stake_token_mint @ StakingError::InvalidMint)]
    pub admin_stake_account: Box<Account<'info, TokenAccount>>,
    /// Reward vault — pays multi-level referral rewards on stake (via remaining_accounts).
    #[account(mut,
        associated_token::mint      = platform.reward_token_mint,
        associated_token::authority = platform)]
    pub reward_vault: Box<Account<'info, TokenAccount>>,
    #[account(mut)]
    pub owner:              Signer<'info>,
    pub token_program:      Program<'info, Token>,
    pub system_program:     Program<'info, System>,
    // remaining_accounts: pairs of [UserAccount PDA (mut), reward ATA (mut)] — up to 10 levels
}

#[derive(Accounts)]
pub struct ClaimRewards<'info> {
    #[account(mut, seeds = [b"platform"], bump = platform.bump)]
    pub platform:            Box<Account<'info, Platform>>,
    #[account(mut, seeds = [b"user", owner.key().as_ref()], bump = user_account.bump)]
    pub user_account:        Box<Account<'info, UserAccount>>,
    // PDA seed verification: proves this entry was created via stake() for this owner
    #[account(mut,
        seeds = [b"stake", owner.key().as_ref(), &stake_entry.stake_id.to_le_bytes()],
        bump = stake_entry.bump,
        has_one = owner @ StakingError::InvalidUserAccount)]
    pub stake_entry:         Box<Account<'info, StakeEntry>>,
    #[account(mut,
        constraint = user_token_account.owner == owner.key() @ StakingError::InvalidUserAccount,
        constraint = user_token_account.mint  == platform.reward_token_mint @ StakingError::InvalidMint)]
    pub user_token_account:  Box<Account<'info, TokenAccount>>,
    #[account(mut,
        associated_token::mint      = platform.reward_token_mint,
        associated_token::authority = platform)]
    pub reward_vault:        Box<Account<'info, TokenAccount>>,
    /// Receives the 0.25% platform fee — the authority's ATA normally, or the
    /// fee_recipient's ATA after renouncement (fee still applies post-renounce).
    #[account(mut,
        constraint = (
            (platform.is_renounced  && admin_reward_account.owner == platform.fee_recipient) ||
            (!platform.is_renounced && admin_reward_account.owner == platform.authority)
        ) @ StakingError::InvalidAdminAccount,
        constraint = admin_reward_account.mint == platform.reward_token_mint @ StakingError::InvalidMint)]
    pub admin_reward_account:          Box<Account<'info, TokenAccount>>,
    /// Reward token mint — required for the 1:1 burn CPI
    #[account(mut, constraint = reward_token_mint.key() == platform.reward_token_mint @ StakingError::InvalidMint)]
    pub reward_token_mint:             Box<Account<'info, Mint>>,
    pub owner:               Signer<'info>,
    pub token_program:       Program<'info, Token>,
}

#[derive(Accounts)]
pub struct CompoundRewards<'info> {
    #[account(mut, seeds = [b"platform"], bump = platform.bump)]
    pub platform:             Box<Account<'info, Platform>>,
    #[account(mut, seeds = [b"user", owner.key().as_ref()], bump = user_account.bump)]
    pub user_account:         Box<Account<'info, UserAccount>>,
    #[account(mut,
        seeds = [b"stake", owner.key().as_ref(), &stake_entry.stake_id.to_le_bytes()],
        bump = stake_entry.bump,
        has_one = owner @ StakingError::InvalidUserAccount)]
    pub stake_entry:          Box<Account<'info, StakeEntry>>,
    #[account(mut,
        associated_token::mint      = platform.reward_token_mint,
        associated_token::authority = platform)]
    pub reward_vault:         Box<Account<'info, TokenAccount>>,
    /// Receives the 0.25% platform fee — the authority's ATA normally, or the
    /// fee_recipient's ATA after renouncement (fee still applies post-renounce).
    #[account(mut,
        constraint = (
            (platform.is_renounced  && admin_reward_account.owner == platform.fee_recipient) ||
            (!platform.is_renounced && admin_reward_account.owner == platform.authority)
        ) @ StakingError::InvalidAdminAccount,
        constraint = admin_reward_account.mint == platform.reward_token_mint @ StakingError::InvalidMint)]
    pub admin_reward_account:          Box<Account<'info, TokenAccount>>,
    /// Reward token mint — required for the 1:1 burn CPI
    #[account(mut, constraint = reward_token_mint.key() == platform.reward_token_mint @ StakingError::InvalidMint)]
    pub reward_token_mint:             Box<Account<'info, Mint>>,
    pub owner:                Signer<'info>,
    pub token_program:        Program<'info, Token>,
}

#[derive(Accounts)]
pub struct Unstake<'info> {
    #[account(mut, seeds = [b"platform"], bump = platform.bump)]
    pub platform:            Box<Account<'info, Platform>>,
    #[account(mut, seeds = [b"user", owner.key().as_ref()], bump = user_account.bump)]
    pub user_account:        Box<Account<'info, UserAccount>>,
    #[account(mut,
        seeds = [b"stake", owner.key().as_ref(), &stake_entry.stake_id.to_le_bytes()],
        bump = stake_entry.bump,
        has_one = owner @ StakingError::InvalidUserAccount)]
    pub stake_entry:         Box<Account<'info, StakeEntry>>,
    #[account(mut,
        constraint = user_token_account.owner == owner.key() @ StakingError::InvalidUserAccount,
        constraint = user_token_account.mint  == platform.stake_token_mint @ StakingError::InvalidMint)]
    pub user_token_account:  Box<Account<'info, TokenAccount>>,
    #[account(mut,
        associated_token::mint      = platform.stake_token_mint,
        associated_token::authority = platform)]
    pub stake_vault:         Box<Account<'info, TokenAccount>>,
    /// Receives the 0.25% platform fee — the authority's ATA normally, or the
    /// fee_recipient's ATA after renouncement (fee still applies post-renounce).
    #[account(mut,
        constraint = (
            (platform.is_renounced  && admin_stake_account.owner == platform.fee_recipient) ||
            (!platform.is_renounced && admin_stake_account.owner == platform.authority)
        ) @ StakingError::InvalidAdminAccount,
        constraint = admin_stake_account.mint  == platform.stake_token_mint @ StakingError::InvalidMint)]
    pub admin_stake_account: Box<Account<'info, TokenAccount>>,
    pub owner:               Signer<'info>,
    pub token_program:       Program<'info, Token>,
}

#[derive(Accounts)]
pub struct RenounceOwnership<'info> {
    #[account(mut, seeds = [b"platform"], bump = platform.bump)]
    pub platform:  Account<'info, Platform>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct AdminAction<'info> {
    #[account(mut, seeds = [b"platform"], bump = platform.bump)]
    pub platform:  Account<'info, Platform>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct BurnStaleVault<'info> {
    #[account(seeds = [b"platform"], bump = platform.bump)]
    pub platform:  Account<'info, Platform>,
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(mut,
        constraint = stale_vault.owner == platform.key() @ StakingError::InvalidVault,
        constraint = stale_vault.mint  != platform.stake_token_mint  @ StakingError::InvalidMint,
        constraint = stale_vault.mint  != platform.reward_token_mint @ StakingError::InvalidMint)]
    pub stale_vault: Account<'info, TokenAccount>,
    #[account(mut, address = stale_vault.mint)]
    pub stale_mint:  Account<'info, Mint>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct AdminStakeAction<'info> {
    #[account(seeds = [b"platform"], bump = platform.bump)]
    pub platform:     Account<'info, Platform>,
    #[account(mut)]
    pub stake_entry:  Account<'info, StakeEntry>,
    pub authority:    Signer<'info>,
}

#[derive(Accounts)]
pub struct AdminUserAction<'info> {
    #[account(seeds = [b"platform"], bump = platform.bump)]
    pub platform:     Account<'info, Platform>,
    #[account(mut)]
    pub user_account: Account<'info, UserAccount>,
    pub authority:    Signer<'info>,
}

#[derive(Accounts)]
pub struct CloseUserAccount<'info> {
    #[account(mut, seeds = [b"platform"], bump = platform.bump)]
    pub platform:     Account<'info, Platform>,
    #[account(mut, close = authority)]
    pub user_account: Account<'info, UserAccount>,
    #[account(mut)]
    pub authority:    Signer<'info>,
}

#[derive(Accounts)]
pub struct CloseStakeEntry<'info> {
    #[account(seeds = [b"platform"], bump = platform.bump)]
    pub platform:    Account<'info, Platform>,
    #[account(mut, close = authority)]
    pub stake_entry: Account<'info, StakeEntry>,
    #[account(mut)]
    pub authority:   Signer<'info>,
}

/// Used only by fix_bump — uses canonical `bump` (not stored platform.bump) so
/// the seeds constraint passes even when platform.bump == 0.
#[derive(Accounts)]
pub struct FixBump<'info> {
    #[account(mut, seeds = [b"platform"], bump)]
    pub platform:  Account<'info, Platform>,
    pub authority: Signer<'info>,
}

// ===== EVENTS =====

#[event] pub struct RewardPoolFunded       { pub authority: Pubkey, pub amount: u64, pub total_pool: u64 }
#[event] pub struct RewardPoolRefunded     { pub authority: Pubkey, pub amount: u64, pub remaining: u64 }
#[event] pub struct ReserveDeposited       { pub authority: Pubkey, pub amount: u64, pub total_reserve: u64 }
#[event] pub struct EmissionReleased       { pub amount: u64, pub total_released: u64, pub remaining: u64 }
#[event] pub struct AnnualEmissionUpdated  { pub annual_emission: u64 }
#[event] pub struct BurnBpsUpdated         { pub burn_bps: u64 }
#[event] pub struct UserRegistered         { pub user: Pubkey, pub referrer: Option<Pubkey>, pub timestamp: i64 }
#[event] pub struct TokensStaked           { pub user: Pubkey, pub amount: u64, pub fee: u64, pub lock_period: u64, pub unlock_at: i64, pub apy: u64 }
#[event] pub struct RewardsClaimed         { pub user: Pubkey, pub amount: u64, pub fee: u64, pub timestamp: i64 }
#[event] pub struct RewardsCompounded      { pub user: Pubkey, pub amount: u64, pub fee: u64, pub new_stake: u64, pub timestamp: i64 }
#[event] pub struct TokensUnstaked         { pub user: Pubkey, pub amount: u64, pub fee: u64, pub timestamp: i64 }
#[event] pub struct ReferralReward         { pub staker: Pubkey, pub referrer: Pubkey, pub amount: u64, pub level: u8 }
#[event] pub struct ClaimReferralPaid      { pub claimant: Pubkey, pub referrer: Pubkey, pub level: u8, pub amount: u64 }
#[event] pub struct ReferralRateUpdated    { pub new_rate: u64 }
#[event] pub struct LockPeriodAPYUpdated   { pub index: u8, pub apy: u64 }
#[event] pub struct UserBlocked            { pub user: Pubkey }
#[event] pub struct UserUnblocked          { pub user: Pubkey }
#[event] pub struct PlatformPauseToggled   { pub is_paused: bool }
#[event] pub struct TeamTargetTierUpdated  { pub index: u8, pub min_team_staked: u64, pub bonus_bps: u64 }
#[event] pub struct TeamBonusApplied       { pub user: Pubkey, pub bonus_amount: u64 }
#[event] pub struct UserTeamStatsUpdated   { pub user: Pubkey, pub team_size: u64, pub team_total_staked: u64 }
#[event] pub struct TokensBurned           { pub user: Pubkey, pub burn_amount: u64, pub total_burned: u64 }
#[event] pub struct OwnershipRenounced     { pub former_owner: Pubkey, pub timestamp: i64 }
#[event] pub struct RenounceFeeCollected       { pub recipient: Pubkey, pub claimant: Pubkey, pub fee_amount: u64, pub total_fees_collected: u64 }
#[event] pub struct ReferralPercentagesUpdated { pub percentages: [u64; 10] }
#[event] pub struct TokenMintsUpdated      { pub stake_token_mint: Pubkey, pub reward_token_mint: Pubkey }
#[event] pub struct PlatformStatsReset     { pub authority: Pubkey }
#[event] pub struct StaleVaultBurned       { pub vault: Pubkey, pub mint: Pubkey, pub amount: u64 }
#[event] pub struct StaleStakeVoided       { pub stake_entry: Pubkey, pub owner: Pubkey, pub amount: u64 }
#[event] pub struct UserAccountReset       { pub user: Pubkey }
#[event] pub struct UserAccountClosed      { pub user: Pubkey }
#[event] pub struct StakeEntryClosed       { pub stake_entry: Pubkey, pub owner: Pubkey }

// ===== ERRORS =====

#[error_code]
pub enum StakingError {
    #[msg("Platform is paused")]                          PlatformPaused,
    #[msg("Unauthorized")]                                Unauthorized,
    #[msg("Invalid amount")]                              InvalidAmount,
    #[msg("Invalid lock period")]                         InvalidLockPeriod,
    #[msg("Lock period is still active")]                 LockPeriodActive,
    #[msg("Stake is not active")]                         StakeNotActive,
    #[msg("No rewards to claim")]                         NoRewardsToClaim,
    #[msg("Insufficient reward pool")]                    InsufficientRewardPool,
    #[msg("Claim too early - wait 6 hours")]              ClaimTooEarly,
    #[msg("User is blocked")]                             UserBlocked,
    #[msg("Overflow error")]                              OverflowError,
    #[msg("Invalid admin fee account")]                   InvalidAdminAccount,
    #[msg("Invalid token mint")]                          InvalidMint,
    #[msg("Invalid tier index (0-9)")]                    InvalidTierIndex,
    #[msg("Team bonus BPS exceeds maximum")]              TeamBonusTooHigh,
    // Security additions
    #[msg("Cannot refer yourself")]                       SelfReferral,
    #[msg("Referrer account does not match referrer key")] ReferrerMismatch,
    #[msg("Invalid vault account")]                       InvalidVault,
    #[msg("Invalid user token account")]                  InvalidUserAccount,
    #[msg("APY exceeds maximum allowed value")]           APYTooHigh,
    #[msg("Ownership has already been renounced")]        AlreadyRenounced,
    #[msg("Fee recipient token account does not match")]  InvalidFeeRecipient,
    #[msg("Deposit amount below minimum (0.1 FBiT)")]     BelowMinDeposit,
    #[msg("Deposit amount above maximum (250 M FBiT)")]   AboveMaxDeposit,
    #[msg("Reserve vault not funded yet")]                ReserveNotFunded,
    #[msg("No emission available to release yet")]        NoEmissionAvailable,
    #[msg("Annual emission not configured")]              AnnualEmissionNotSet,
    #[msg("Burn BPS exceeds maximum (5000 = 50%)")]       BurnBpsTooHigh,
    #[msg("Stake amount is below minimum (0.1 FBiT)")]    BelowMinStake,
    #[msg("Stake amount exceeds maximum (250M FBiT)")]    AboveMaxStake,
    #[msg("Invalid referral token account")]               InvalidReferralATA,
    #[msg("A valid referrer is required to register")]     ReferrerRequired,
    #[msg("Total referral BPS exceeds 50% maximum")]       ReferralPercentagesTooHigh,
    #[msg("Referrer must have an active stake before their link can be used")] ReferrerNotActive,
}
