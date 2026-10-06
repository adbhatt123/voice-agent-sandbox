/**
 * Planner contract. Concrete planners arrive in later phases:
 *   - cache/memory lookup (deterministic, no LLM)  [P5 wiring]
 *   - Claude planner for novel prompts             [P6]
 * P2 ships only the interface so the orchestrator can be built and tested
 * against a deterministic stub.
 *
 * A planner ALWAYS returns both a preferred and a fallback action (the
 * TTS-first / DTMF-fallback rule): preferred honours the prompt's inputMode,
 * fallback is the other modality so the executor can switch on repeated failure.
 */

import type { Action, SemanticState } from "./types.ts";
import type { PlanSource } from "./telemetry/latency.ts";

export type PlannerContext = {
  payerId: string;
  objective: string;
  payload: Record<string, string>;
  completedGoals: ReadonlySet<string>;
  /** True when this prompt meaning just repeated without progress (a retry). */
  isRetry: boolean;
  /** Meanings of recent COMMITTED turns (oldest first), for loop detection. */
  recentMeanings: readonly string[];
};

export type PlannerDecision = {
  preferred: Action;
  fallback: Action | null;
  source: PlanSource;
  goalCompleted: string | null;
  confidence: number;
};

export interface Planner {
  plan(
    state: SemanticState,
    ctx: PlannerContext,
  ): PlannerDecision | Promise<PlannerDecision>;
}
