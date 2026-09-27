/**
 * Multi-Layer Bot Management System — FBiT Staking
 *
 * Layer 1 · Browser Fingerprinting   — WebDriver / headless tool detection
 * Layer 2 · Behavioral Analysis      — mouse, keyboard, scroll humanness scoring
 * Layer 3 · Sliding-Window Limiter   — per-action burst prevention
 * Layer 4 · Logic Abuse Guard        — rapid-cycling & repeated-failure detection
 * Layer 5 · PoW Challenge            — SubtleCrypto SHA-256 proof-of-work
 * Layer 6 · Session Risk Engine      — unified scoring & action gating
 * Layer 7 · TF.js ML Classifier      — neural network bot probability (lazy loaded)
 * Layer 8 · Claude AI Agent          — deep contextual analysis for borderline sessions
 */

// ─────────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────────

export type RiskLevel = 'low' | 'medium' | 'high' | 'blocked';

export interface BotAssessment {
  riskLevel: RiskLevel;
  /** 0 = safe, 100 = definite bot */
  score: number;
  signals: string[];
  requiresChallenge: boolean;
  blocked: boolean;
  /** Set after Layer 7 runs */
  mlProbability?: number;
  /** Set after Layer 8 runs */
  claudeRisk?: RiskLevel;
  claudeReasoning?: string;
}

export interface PowChallenge {
  challenge: string;
  difficulty: number;
}

export interface PowSolution {
  nonce: number;
  hash: string;
}

export interface ActionResult {
  allowed: boolean;
  reason?: string;
  requiresChallenge?: boolean;
  retryAfterMs?: number;
}

/** Feature vector fed to the TF.js model (Layer 7). */
export interface BehaviorFeatures {
  hasAutomation:   number;   // 0 | 1
  fpScoreNorm:     number;   // 0–1  (fingerprint score / 100)
  humanScoreInv:   number;   // 0–1  (1 - humanScore/100)
  moveRegularity:  number;   // 0–1  (1 - velocityCV; high = too regular = bot)
  clickRegularity: number;   // 0–1  (1 - clickIntervalCV; high = too regular = bot)
  moveSparse:      number;   // 0–1  (few movements relative to session age)
  actionTooFast:   number;   // 0 | 1  (1 if action attempted < 3 s after load)
}

// ─────────────────────────────────────────────────────────────────────────────
// Layer 1 · Browser Fingerprinting
// ─────────────────────────────────────────────────────────────────────────────

function runFingerprint(): { score: number; signals: string[]; hasAuto: boolean } {
  if (typeof window === 'undefined') return { score: 0, signals: [], hasAuto: false };

  const signals: string[] = [];
  let score = 0;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const nav = navigator as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const win = window as any;

  // Automation tool markers
  if (nav.webdriver)                                                           { signals.push('webdriver');           score += 40; }
  if (win.__playwright || win.__pwInitScripts || win.__pw_manual_tests_handle) { signals.push('playwright');          score += 50; }
  if (win.__puppeteer_evaluation_script__ || win._puppeteer)                   { signals.push('puppeteer');           score += 50; }
  if (win.Cypress)                                                             { signals.push('cypress');             score += 30; }
  if (win._selenium || win.__selenium_evaluate ||
      document.documentElement.getAttribute('webdriver'))                      { signals.push('selenium');            score += 40; }
  if (win.callPhantom || win._phantom)                                         { signals.push('phantomjs');           score += 50; }
  if (win.__nightmare)                                                         { signals.push('nightmare');           score += 50; }

  // User-agent anomalies
  const ua: string = (nav.userAgent as string) ?? '';
  if (!ua)                                { signals.push('no-ua');                  score += 25; }
  else if (ua.includes('HeadlessChrome')) { signals.push('headless-chrome-ua');     score += 50; }
  else if (ua.includes('PhantomJS'))      { signals.push('phantomjs-ua');           score += 50; }

  // Missing browser features
  if (!nav.plugins || nav.plugins.length === 0)     { signals.push('no-plugins');   score += 12; }
  if (!nav.languages || nav.languages.length === 0) { signals.push('no-languages'); score += 10; }

  // Screen anomalies
  if (screen.width === 0 || screen.height === 0)          { signals.push('zero-screen');             score += 30; }
  else if (screen.width === 800 && screen.height === 600) { signals.push('headless-default-screen');  score += 15; }

  // Canvas API
  try {
    const c = document.createElement('canvas');
    const ctx = c.getContext('2d');
    if (!ctx) { signals.push('no-canvas-2d'); score += 15; }
    else {
      ctx.fillStyle = '#ff0000';
      ctx.fillRect(0, 0, 1, 1);
      const px = ctx.getImageData(0, 0, 1, 1).data;
      if (px[0] !== 255 || px[3] !== 255) { signals.push('canvas-anomaly'); score += 10; }
    }
  } catch { signals.push('canvas-error'); score += 15; }

  // WebGL software renderer
  try {
    const gl = document.createElement('canvas').getContext('webgl');
    if (gl) {
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      if (ext) {
        const renderer = gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) as string;
        if (/SwiftShader|llvmpipe|Mesa|VMware/i.test(renderer)) {
          signals.push('software-renderer'); score += 20;
        }
      }
    }
  } catch { /* not conclusive */ }

  // AudioContext
  if (!(win.AudioContext || win.webkitAudioContext)) { signals.push('no-audio-ctx'); score += 8; }

  const hasAuto = signals.some(s =>
    ['webdriver','playwright','puppeteer','selenium','phantomjs','nightmare','cypress',
     'headless-chrome-ua','phantomjs-ua'].includes(s)
  );

  return { score: Math.min(score, 100), signals, hasAuto };
}

// ─────────────────────────────────────────────────────────────────────────────
// Layer 2 · Behavioral Analysis (enhanced with velocity & click-timing data)
// ─────────────────────────────────────────────────────────────────────────────

class BehaviorTracker {
  private moves     = 0;
  private distance  = 0;
  private lastX     = 0;
  private lastY     = 0;
  private lastMoveMs= 0;
  private keys      = 0;
  private scrolls   = 0;
  private clicks    = 0;
  private startMs   = Date.now();
  private running   = false;

  // Raw data for ML feature extraction
  private velocities: number[]  = [];   // px/ms samples
  private clickTs:    number[]  = [];   // click timestamps

  private onMove = (e: MouseEvent) => {
    const now = Date.now();
    const dx  = e.clientX - this.lastX;
    const dy  = e.clientY - this.lastY;
    const dist = Math.sqrt(dx * dx + dy * dy);

    if (this.lastMoveMs > 0 && now > this.lastMoveMs && dist > 0) {
      const v = dist / (now - this.lastMoveMs);
      if (v < 10) this.velocities.push(v);   // filter teleport glitches
    }

    this.lastMoveMs = now;
    this.distance  += dist;
    this.lastX      = e.clientX;
    this.lastY      = e.clientY;
    this.moves++;
  };

  private onKey    = () => { this.keys++;                       };
  private onScroll = () => { this.scrolls++;                    };
  private onClick  = () => { this.clickTs.push(Date.now()); this.clicks++; };

  start() {
    if (this.running || typeof window === 'undefined') return;
    this.running = true;
    document.addEventListener('mousemove', this.onMove,   { passive: true });
    document.addEventListener('keydown',   this.onKey,    { passive: true });
    document.addEventListener('scroll',    this.onScroll, { passive: true });
    document.addEventListener('click',     this.onClick,  { passive: true });
  }

  stop() {
    if (!this.running) return;
    document.removeEventListener('mousemove', this.onMove);
    document.removeEventListener('keydown',   this.onKey);
    document.removeEventListener('scroll',    this.onScroll);
    document.removeEventListener('click',     this.onClick);
    this.running = false;
  }

  /** 0 = bot-like · 100 = clearly human */
  humanScore(): number {
    let s = 0;
    if      (this.moves > 20) s += 30;
    else if (this.moves > 5)  s += 15;
    else if (this.moves > 0)  s += 5;

    if      (this.distance > 500) s += 20;
    else if (this.distance > 100) s += 10;

    if      (this.clicks > 3) s += 15;
    else if (this.clicks > 0) s += 8;

    if      (this.scrolls > 2) s += 10;
    else if (this.scrolls > 0) s += 5;

    if (this.keys > 3) s += 10;

    const ageMs = Date.now() - this.startMs;
    if      (ageMs > 15_000) s += 15;
    else if (ageMs > 5_000)  s += 8;

    return Math.min(s, 100);
  }

  /** Plain metrics for the Claude API payload. */
  getMetrics() {
    return {
      mouseMovements: this.moves,
      mouseDistance:  Math.round(this.distance),
      clicks:         this.clicks,
      keystrokes:     this.keys,
      scrolls:        this.scrolls,
      sessionAgeMs:   Date.now() - this.startMs,
    };
  }

  /** Feature vector for the TF.js classifier. */
  getMLFeatures(fpScore: number, hasAuto: boolean, firstActionMs: number): BehaviorFeatures {
    const ageMs      = Date.now() - this.startMs;
    const velCV      = this.cv(this.velocities);
    const intervals  = this.clickTs.slice(1).map((t, i) => t - this.clickTs[i]);
    const clkCV      = this.cv(intervals);

    return {
      hasAutomation:   hasAuto ? 1 : 0,
      fpScoreNorm:     fpScore / 100,
      humanScoreInv:   1 - this.humanScore() / 100,
      moveRegularity:  1 - Math.min(velCV, 1),    // low CV = regular = bot-like
      clickRegularity: 1 - Math.min(clkCV, 1),    // low CV = regular = bot-like
      moveSparse:      this.moves < 5 && ageMs > 5_000
                         ? 1
                         : Math.max(0, 1 - this.moves / 20),
      actionTooFast:   firstActionMs > 0 && firstActionMs < 3_000 ? 1 : 0,
    };
  }

  // ── stats helpers ──────────────────────────────────────────────────────────

  private cv(arr: number[]): number {
    if (arr.length < 3) return 0.5;   // too few samples → uncertain
    const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
    if (mean === 0) return 0;
    const variance = arr.reduce((a, b) => a + (b - mean) ** 2, 0) / arr.length;
    return Math.sqrt(variance) / mean;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Layer 3 · Sliding-Window Rate Limiter
// ─────────────────────────────────────────────────────────────────────────────

class SlidingLimiter {
  private windows = new Map<string, number[]>();

  constructor(private windowMs: number, private max: number) {}

  check(key: string): { allowed: boolean; retryAfterMs: number } {
    const now = Date.now();
    const cut = now - this.windowMs;
    const ts  = (this.windows.get(key) ?? []).filter(t => t > cut);
    if (ts.length >= this.max) {
      return { allowed: false, retryAfterMs: ts[0] + this.windowMs - now };
    }
    ts.push(now);
    this.windows.set(key, ts);
    return { allowed: true, retryAfterMs: 0 };
  }

  reset(key: string) { this.windows.delete(key); }
}

const ACTION_WINDOWS: Record<string, { windowMs: number; max: number }> = {
  stake:    { windowMs:  60_000, max: 3 },
  unstake:  { windowMs:  60_000, max: 3 },
  claim:    { windowMs: 120_000, max: 2 },
  compound: { windowMs: 120_000, max: 2 },
  register: { windowMs: 300_000, max: 2 },
  connect:  { windowMs:  60_000, max: 8 },
  rpcRead:  { windowMs:  10_000, max: 30 },
};

// ─────────────────────────────────────────────────────────────────────────────
// Layer 4 · Logic Abuse Guard
// ─────────────────────────────────────────────────────────────────────────────

class AbuseGuard {
  private log:   { action: string; ts: number }[] = [];
  private fails: Record<string, number>            = {};

  record(action: string) {
    const now = Date.now();
    this.log.push({ action, ts: now });
    this.log = this.log.filter(e => now - e.ts < 300_000);
  }

  recordFailure(action: string) {
    this.fails[action] = (this.fails[action] ?? 0) + 1;
  }

  isAbusive(): boolean {
    for (const n of Object.values(this.fails)) {
      if (n >= 5) return true;
    }
    const tail = this.log.slice(-6).map(e => e.action);
    let alt = 0;
    for (let i = 1; i < tail.length; i++) {
      if (
        (tail[i-1] === 'claim' && tail[i] === 'compound') ||
        (tail[i-1] === 'compound' && tail[i] === 'claim')
      ) alt++;
    }
    return alt >= 4;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Layer 5 · PoW Challenge  (SubtleCrypto SHA-256)
// ─────────────────────────────────────────────────────────────────────────────

export function makePowChallenge(difficulty = 14): PowChallenge {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const challenge = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
  return { challenge, difficulty };
}

export async function solvePow(
  pow: PowChallenge,
  onProgress?: (pct: number) => void,
): Promise<PowSolution> {
  const enc     = new TextEncoder();
  const maxIter = 4_000_000;
  for (let nonce = 0; nonce < maxIter; nonce++) {
    const buf  = await crypto.subtle.digest('SHA-256', enc.encode(`${pow.challenge}:${nonce}`));
    const view = new DataView(buf);
    if ((view.getUint32(0, false) >>> (32 - pow.difficulty)) === 0) {
      const hash = Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
      return { nonce, hash };
    }
    if (onProgress && nonce % 20_000 === 0) onProgress(Math.min(95, (nonce / maxIter) * 100));
  }
  throw new Error('PoW: nonce space exhausted');
}

export async function verifyPow(pow: PowChallenge, sol: PowSolution): Promise<boolean> {
  const enc  = new TextEncoder();
  const buf  = await crypto.subtle.digest('SHA-256', enc.encode(`${pow.challenge}:${sol.nonce}`));
  const view = new DataView(buf);
  if ((view.getUint32(0, false) >>> (32 - pow.difficulty)) !== 0) return false;
  const hash = Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
  return hash === sol.hash;
}

// ─────────────────────────────────────────────────────────────────────────────
// Singleton challenge callback (wired by useBotGuard hook)
// ─────────────────────────────────────────────────────────────────────────────

let _onChallengeRequired: (() => void) | null = null;
export function setChallengeRequiredCallback(cb: (() => void) | null) {
  _onChallengeRequired = cb;
}

// ─────────────────────────────────────────────────────────────────────────────
// Layer 6 + 7 + 8 · Session Risk Engine (BotGuard)
// ─────────────────────────────────────────────────────────────────────────────

export class BotGuard {
  private fp       = runFingerprint();
  private behavior = new BehaviorTracker();
  private limiters = new Map(
    Object.entries(ACTION_WINDOWS).map(([k, cfg]) => [k, new SlidingLimiter(cfg.windowMs, cfg.max)])
  );
  private abuse    = new AbuseGuard();
  private _solved  = false;
  private _pow: PowChallenge | null = null;

  private _startMs         = Date.now();
  private _firstActionMs: number | null = null;

  // Cached AI layer results
  private _mlScore:         number   | null = null;
  private _claudeRisk:      RiskLevel | null = null;
  private _claudeConfidence = 0;
  private _claudeReasoning  = '';
  private _fullRunning      = false;   // prevent concurrent assessFull() calls

  constructor() { this.behavior.start(); }

  // ── Layer 6: sync risk assessment ─────────────────────────────────────────

  assess(): BotAssessment {
    const fpScore = this.fp.score;
    const humanS  = this.behavior.humanScore();
    const abusive = this.abuse.isAbusive();

    let score = fpScore;
    if      (humanS < 15) score += 20;
    else if (humanS < 30) score += 10;
    if (abusive)          score += 25;

    // Layer 7 contribution (weighted 40% when available)
    if (this._mlScore !== null) {
      score = score * 0.6 + this._mlScore * 100 * 0.4;
    }

    // Layer 8 contribution (blended by confidence when available)
    if (this._claudeRisk && this._claudeConfidence > 0.5) {
      const claudeScore: Record<RiskLevel, number> = { blocked: 90, high: 60, medium: 28, low: 8 };
      const blend = this._claudeConfidence * 0.45;
      score = score * (1 - blend) + claudeScore[this._claudeRisk] * blend;
    }

    score = Math.min(100, score);

    let riskLevel: RiskLevel;
    if      (score >= 65 || fpScore >= 50)   riskLevel = 'blocked';
    else if (score >= 35 || abusive)         riskLevel = 'high';
    else if (score >= 15 || humanS < 15)     riskLevel = 'medium';
    else                                     riskLevel = 'low';

    // Claude can upgrade risk level (never downgrade below sync level)
    if (this._claudeRisk && this._claudeConfidence > 0.7) {
      const ORDER: RiskLevel[] = ['low','medium','high','blocked'];
      if (ORDER.indexOf(this._claudeRisk) > ORDER.indexOf(riskLevel)) {
        riskLevel = this._claudeRisk;
      }
    }

    const requiresChallenge =
      (riskLevel === 'medium' || riskLevel === 'high') && !this._solved;

    return {
      riskLevel,
      score,
      signals:          this.fp.signals,
      requiresChallenge,
      blocked:          riskLevel === 'blocked',
      mlProbability:    this._mlScore ?? undefined,
      claudeRisk:       this._claudeRisk ?? undefined,
      claudeReasoning:  this._claudeReasoning || undefined,
    };
  }

  // ── Layer 7 + 8: async full assessment ────────────────────────────────────

  async assessFull(): Promise<BotAssessment> {
    if (this._fullRunning) return this.assess();

    // Skip the 1.1MB TF.js chunk entirely for sessions Layers 1–6 already
    // read as clearly clean: near-zero fingerprint risk, real accumulated
    // interaction (humanScore only crosses this from actual mouse/click/
    // scroll activity — idle time alone caps out at 15), and no abuse flags.
    // Every other session — including a fresh page load with no interaction
    // yet, which is exactly what a headless/automated visitor looks like —
    // still gets the full ML + Claude treatment, so detection strength for
    // anything actually suspicious is unchanged.
    const clearlyClean =
      this.fp.score < 10 && this.behavior.humanScore() >= 30 && !this.abuse.isAbusive();
    if (clearlyClean) return this.assess();

    this._fullRunning = true;

    try {
      // Layer 7 — TF.js (lazy loaded)
      const { predictBotProbability } = await import('@/lib/mlBotClassifier');
      const features = this.behavior.getMLFeatures(
        this.fp.score,
        this.fp.hasAuto,
        this._firstActionMs ?? 0,
      );
      this._mlScore = await predictBotProbability(features);

      // Layer 8 — Claude (only for borderline sessions, skip obvious bots/humans)
      const uncertain   = this._mlScore > 0.20 && this._mlScore < 0.80;
      const notClearBot = this.fp.score < 50;

      if (uncertain && notClearBot) {
        try {
          const res = await fetch('/api/bot-assess', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              signals:       this.fp.signals,
              fpScore:       this.fp.score,
              humanScore:    this.behavior.humanScore(),
              mlProbability: this._mlScore,
              behavior:      this.behavior.getMetrics(),
              abusive:       this.abuse.isAbusive(),
            }),
            signal: AbortSignal.timeout(6_000),
          });
          if (res.ok) {
            const r = await res.json() as {
              risk: RiskLevel; confidence: number; reasoning: string;
            };
            this._claudeRisk       = r.risk;
            this._claudeConfidence = r.confidence ?? 0;
            this._claudeReasoning  = r.reasoning  ?? '';
          }
        } catch { /* Claude unavailable — fail open */ }
      }

      // Online learning: teach TF.js from high-confidence fingerprint signal
      if (this.fp.hasAuto && this.fp.score >= 80) {
        const { learnFromOutcome } = await import('@/lib/mlBotClassifier');
        learnFromOutcome(features, true).catch(() => {});
      }
    } catch { /* non-critical */ }

    this._fullRunning = false;
    return this.assess();
  }

  // ── Action gating ──────────────────────────────────────────────────────────

  canPerformAction(actionType: string): ActionResult {
    // Track first action time for ML feature
    if (this._firstActionMs === null) {
      this._firstActionMs = Date.now() - this._startMs;
    }

    const { blocked, requiresChallenge, riskLevel } = this.assess();

    if (blocked) {
      return {
        allowed: false,
        reason:  'Automated activity detected. Please use a standard browser.',
      };
    }

    if (requiresChallenge) {
      _onChallengeRequired?.();
      return {
        allowed:            false,
        requiresChallenge:  true,
        reason: riskLevel === 'high'
          ? 'Suspicious session detected — please complete the security verification.'
          : 'Please complete the quick security check to continue.',
      };
    }

    const limiter = this.limiters.get(actionType);
    if (limiter) {
      const { allowed, retryAfterMs } = limiter.check(actionType);
      if (!allowed) {
        const secs = Math.ceil(retryAfterMs / 1000);
        return {
          allowed:        false,
          reason:         `Too many ${actionType} requests — please wait ${secs}s.`,
          retryAfterMs,
        };
      }
    }

    this.abuse.record(actionType);
    return { allowed: true };
  }

  recordFailure(actionType: string) { this.abuse.recordFailure(actionType); }

  // ── PoW ───────────────────────────────────────────────────────────────────

  get challengeSolved() { return this._solved; }

  newChallenge(): PowChallenge {
    const { riskLevel } = this.assess();
    this._pow = makePowChallenge(riskLevel === 'high' ? 16 : 14);
    return this._pow;
  }

  async solveAndVerify(onProgress?: (pct: number) => void): Promise<boolean> {
    if (!this._pow) this._pow = this.newChallenge();
    try {
      const sol   = await solvePow(this._pow, onProgress);
      const valid = await verifyPow(this._pow, sol);
      if (valid) {
        this._solved = true;
        // Teach TF.js: this was a human
        this._teachHuman().catch(() => {});
      }
      return valid;
    } catch { return false; }
  }

  markSolved() {
    this._solved = true;
    this._teachHuman().catch(() => {});
  }

  private async _teachHuman(): Promise<void> {
    try {
      const { learnFromOutcome } = await import('@/lib/mlBotClassifier');
      const features = this.behavior.getMLFeatures(
        this.fp.score, this.fp.hasAuto, this._firstActionMs ?? 0,
      );
      await learnFromOutcome(features, false);
    } catch { /* non-critical */ }
  }

  destroy() { this.behavior.stop(); }
}

// ─────────────────────────────────────────────────────────────────────────────
// Singleton
// ─────────────────────────────────────────────────────────────────────────────

let _singleton: BotGuard | null = null;

export function getBotGuard(): BotGuard {
  if (typeof window === 'undefined') return new BotGuard();
  if (!_singleton) _singleton = new BotGuard();
  return _singleton;
}
