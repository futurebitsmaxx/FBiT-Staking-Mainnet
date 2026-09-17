/**
 * Layer 8 — Claude AI Bot Assessment Endpoint
 *
 * Called only for borderline sessions (TF.js ML probability 0.20 – 0.80)
 * where simple rules and the local classifier are uncertain.
 *
 * Claude receives the full session context and returns a structured risk
 * assessment with reasoning — giving the system explainable, nuanced
 * decisions that purely rule-based systems miss.
 *
 * Response is kept short (max_tokens 200) to stay fast and cheap.
 * Fails open: on any error the endpoint returns risk=low so that a
 * downstream API outage never locks out legitimate users.
 */

import { NextRequest, NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { isAllowedOrigin } from '@/lib/security';

export const runtime    = 'nodejs';
export const maxDuration = 10;

// .trim() strips a trailing \r\n Vercel can append when an env var is set via
// the dashboard on Windows (see web/src/lib/config.ts for the same pattern) —
// an untrimmed key fails Anthropic's auth with no useful client-side signal.
const client = new Anthropic({ apiKey: (process.env.ANTHROPIC_API_KEY ?? '').trim() });

// ── Simple in-process rate limiter (10 req / min per IP) ──────────────────────
// Caveat: this Map lives in a single warm function instance. Serverless platforms
// can run several instances concurrently (each with its own empty Map), so a
// distributed caller can exceed the per-IP limit by fanning out across instances.
// The global cap below bounds the worst case per-instance regardless.
const _rl = new Map<string, { count: number; reset: number }>();
function checkRateLimit(ip: string): boolean {
  const now  = Date.now();
  const slot = _rl.get(ip);
  if (!slot || now > slot.reset) {
    _rl.set(ip, { count: 1, reset: now + 60_000 });
    return true;
  }
  if (slot.count >= 10) return false;
  slot.count++;
  return true;
}

// ── Global cap across ALL callers on this instance (bounds worst-case Anthropic
// spend even when per-IP tracking is bypassed via distributed/multi-instance abuse) ──
let _globalCount = 0;
let _globalReset = Date.now() + 60_000;
const GLOBAL_LIMIT_PER_MIN = 200;
function checkGlobalRateLimit(): boolean {
  const now = Date.now();
  if (now > _globalReset) { _globalCount = 0; _globalReset = now + 60_000; }
  if (_globalCount >= GLOBAL_LIMIT_PER_MIN) return false;
  _globalCount++;
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Request / response types
// ─────────────────────────────────────────────────────────────────────────────

interface AssessRequest {
  signals:       string[];
  fpScore:       number;   // 0–100
  humanScore:    number;   // 0–100
  mlProbability: number;   // 0–1
  behavior: {
    mouseMovements: number;
    mouseDistance:  number;
    clicks:         number;
    keystrokes:     number;
    scrolls:        number;
    sessionAgeMs:   number;
  };
  abusive: boolean;
}

interface AssessResponse {
  risk:       'low' | 'medium' | 'high' | 'blocked';
  confidence: number;   // 0–1
  reasoning:  string;
  flags:      string[];
}

const VALID_RISKS = new Set(['low', 'medium', 'high', 'blocked']);

// ─────────────────────────────────────────────────────────────────────────────
// Handler
// ─────────────────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  // ── Rate limit ──────────────────────────────────────────────────────────────
  if (!checkGlobalRateLimit()) {
    return NextResponse.json<AssessResponse>(failSuspicious('global_rate_limited'), { status: 429 });
  }
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0].trim() ?? 'unknown';
  if (!checkRateLimit(ip)) {
    // Exceeding 10 req/min from one IP is itself a bot-like signal — a legitimate
    // single session never needs this many assessments. Do NOT fail open here:
    // an attacker could otherwise deliberately blow through the rate limit to
    // guarantee a "low risk" verdict every time. Fail toward suspicion instead.
    return NextResponse.json<AssessResponse>(failSuspicious('rate_limited'), { status: 429 });
  }

  // ── Origin check (skip when no allowed origins configured) ─────────────────
  if (!isAllowedOrigin(req.headers.get('origin') ?? '', process.env.NEXT_PUBLIC_SITE_URL)) {
    // Same reasoning — a spoofed/mismatched origin on this endpoint is far more
    // likely to be a probing script than a real browser session.
    return NextResponse.json<AssessResponse>(failSuspicious('bad_origin'), { status: 403 });
  }

  // Parse the body in its own try/catch: invalid JSON is attacker-controlled
  // (a real browser client always sends well-formed JSON), so it must fail
  // toward suspicion, not fall through to the genuine-outage fail-open path below.
  let body: Partial<AssessRequest>;
  try {
    body = (await req.json()) as Partial<AssessRequest>;
  } catch {
    return NextResponse.json<AssessResponse>(failSuspicious('invalid_json'), { status: 400 });
  }

  if (typeof body.fpScore !== 'number' || typeof body.humanScore !== 'number') {
    // Malformed request shape — real clients always send well-formed bodies;
    // this is more consistent with a script probing the endpoint.
    return NextResponse.json<AssessResponse>(failSuspicious('malformed_request'), { status: 400 });
  }

  try {

    const b   = body.behavior ?? { mouseMovements:0, mouseDistance:0, clicks:0, keystrokes:0, scrolls:0, sessionAgeMs:0 };
    const ageS = Math.round((b.sessionAgeMs ?? 0) / 1000);

    // Sanitize signals — strip newlines and any chars that could break prompt structure
    const safeSignals = (body.signals ?? [])
      .map(s => String(s).replace(/[\r\n\t=]/g, ' ').slice(0, 80))
      .slice(0, 20);

    const prompt = `You are a bot-detection classifier for FBiT, a DeFi staking platform. Analyze this browser session and classify it.

== Session Data ==
Fingerprint signals : ${safeSignals.join(', ') || 'none'}
Fingerprint score   : ${body.fpScore}/100  (higher = more bot-like)
Behavioral score    : ${body.humanScore}/100  (higher = more human-like)
ML bot probability  : ${((body.mlProbability ?? 0.5) * 100).toFixed(1)}%

Interaction events:
  Mouse movements : ${b.mouseMovements} (${b.mouseDistance}px total)
  Clicks          : ${b.clicks}
  Keystrokes      : ${b.keystrokes}
  Scroll events   : ${b.scrolls}
  Session age     : ${ageS}s
Abuse pattern     : ${body.abusive ? 'YES — rapid cycling detected' : 'no'}

== Task ==
Classify the risk level. Consider:
- webdriver / playwright / puppeteer signals are near-definitive bot markers.
- Zero mouse movement + zero scrolls for > 10 s is suspicious.
- Very short session age before a transaction attempt is suspicious.
- Missing plugins alone is weak signal on mobile or hardened browsers.
- Fail toward "low" when evidence is ambiguous — never block real users.

Respond with ONLY this JSON (no markdown, no explanation outside it):
{"risk":"low","confidence":0.0,"reasoning":"one sentence max 120 chars","flags":["signal"]}`;

    const message = await client.messages.create({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 220,
      system:     'You are a precise bot-detection classifier. Output ONLY valid JSON matching the exact schema. Never wrap in markdown.',
      messages:   [{ role: 'user', content: prompt }],
    });

    const raw  = (message.content[0] as { type: string; text: string }).text.trim();
    // Strip accidental markdown fences
    const json = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    const parsed = JSON.parse(json) as AssessResponse;

    if (!VALID_RISKS.has(parsed.risk) || typeof parsed.confidence !== 'number') {
      throw new Error('Invalid Claude response schema');
    }

    // Clamp confidence
    parsed.confidence = Math.max(0, Math.min(1, parsed.confidence));

    return NextResponse.json<AssessResponse>(parsed);
  } catch (err) {
    console.error('[bot-assess]', err instanceof Error ? err.message : err);
    // Fail open — never block users due to API errors
    return NextResponse.json<AssessResponse>(failOpen());
  }
}

// Genuine infrastructure failure (Anthropic API outage, malformed model response) —
// never penalize a real user for something on our end going wrong.
function failOpen(): AssessResponse {
  return { risk: 'low', confidence: 0, reasoning: 'Assessment unavailable — defaulting to safe.', flags: [] };
}

// A failure condition that is itself attacker-controllable (rate limit, bad origin,
// invalid/malformed request). Fails toward "medium" instead of "low" so a bot can't
// force a guaranteed-safe verdict just by tripping one of these checks.
function failSuspicious(reason: string): AssessResponse {
  return { risk: 'medium', confidence: 0.3, reasoning: 'Request failed a basic validation check.', flags: [reason] };
}
