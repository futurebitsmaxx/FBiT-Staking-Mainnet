'use client';

import { useState, useCallback, useEffect } from 'react';
import {
  getBotGuard,
  setChallengeRequiredCallback,
  type BotAssessment,
  type RiskLevel,
} from '@/lib/botManagement';

export interface BotGuardHook {
  assessment: BotAssessment;
  /** true when the challenge modal should be shown */
  challengeNeeded: boolean;
  /** risk level at the moment the challenge was triggered */
  challengeRiskLevel: 'medium' | 'high' | null;
  /** Call when the user successfully completes the challenge */
  onChallengeSolved(): void;
  /** Call when the user dismisses the challenge modal */
  onChallengeDismissed(): void;
}

export function useBotGuard(): BotGuardHook {
  const guard = getBotGuard();
  const [assessment,      setAssessment]      = useState<BotAssessment>(() => guard.assess());
  const [challengeNeeded, setChallengeNeeded] = useState(false);
  const [triggerRisk,     setTriggerRisk]     = useState<RiskLevel | null>(null);

  // Wire singleton callback so BotGuard can open the modal from anywhere
  // (including from inside a useContract callback).
  useEffect(() => {
    setChallengeRequiredCallback(() => {
      const a = guard.assess();
      setTriggerRisk(a.riskLevel as RiskLevel);
      setChallengeNeeded(true);
    });
    return () => setChallengeRequiredCallback(null);
  }, [guard]);

  // Run Layer 7 (TF.js) + Layer 8 (Claude), then every 30s. assessFull() is
  // non-blocking — it updates cached state and the next assess() call picks
  // it up automatically.
  //
  // The first run is delayed a few seconds rather than fired at mount: a
  // fresh page load has zero accumulated mouse/click/scroll signal for
  // *any* visitor yet, genuine or not, so assessFull()'s clean-session skip
  // could never trigger on an immediate first call — every single visitor
  // would always pay the 1.1MB TF.js download on page load regardless of
  // how the delayed checks turn out. Waiting first gives real users time to
  // naturally generate that signal, so ordinary sessions actually get to
  // skip it; a session that's still untouched after the delay reads exactly
  // like automation and still gets the full check.
  useEffect(() => {
    let cancelled = false;

    const run = async () => {
      if (cancelled) return;
      const full = await guard.assessFull();
      if (!cancelled) setAssessment(full);
    };

    const initialTimer = setTimeout(run, 4_000);
    const id = setInterval(run, 30_000);
    return () => { cancelled = true; clearTimeout(initialTimer); clearInterval(id); };
  }, [guard]);

  // Lightweight sync refresh every 5 s (captures behavioral score changes)
  useEffect(() => {
    const id = setInterval(() => setAssessment(guard.assess()), 5_000);
    return () => clearInterval(id);
  }, [guard]);

  const onChallengeSolved = useCallback(() => {
    guard.markSolved();
    setChallengeNeeded(false);
    setTriggerRisk(null);
    setAssessment(guard.assess());
  }, [guard]);

  const onChallengeDismissed = useCallback(() => {
    setChallengeNeeded(false);
    setTriggerRisk(null);
  }, []);

  const challengeRiskLevel: 'medium' | 'high' | null =
    triggerRisk === 'high'   ? 'high'   :
    triggerRisk === 'medium' ? 'medium' :
    null;

  return {
    assessment,
    challengeNeeded,
    challengeRiskLevel,
    onChallengeSolved,
    onChallengeDismissed,
  };
}
