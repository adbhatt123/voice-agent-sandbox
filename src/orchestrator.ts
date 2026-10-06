/**
 * Orchestrator — the turn loop.
 *
 * Wires an AudioTurnSource to the planner, executor, audio cache and latency
 * tracker. Written ONCE against the interface, so it runs identically over the
 * offline SimulatedSource (tests) and the live Twilio + Deepgram source (P4+).
 *
 * Responsibilities:
 *   - classify each partial transcript (StateTracker) and, when confident,
 *     speculatively plan + render a response ahead of endpoint (preemptive gen)
 *   - on endpoint, commit the speculative response if it still matches,
 *     otherwise plan fresh (cache > memory > LLM, via the injected planner)
 *   - executor: prefer the TTS-first action, switch to the DTMF fallback when a
 *     prompt meaning repeats (retry) — keeping execution deterministic
 *   - record goal completion and stamp latency at every stage
 */

import { analyze } from "./state-tracker.ts";
import type { AudioTurnSource, TurnSourceEvent, RenderedResponse } from "./media/turn-source.ts";
import type { Planner, PlannerContext, PlannerDecision } from "./planner.ts";
import type { Action } from "./types.ts";
import type { AudioCache } from "./tts/audio-cache.ts";
import { LatencyTracker } from "./telemetry/latency.ts";

export type Synth = (text: string) => Promise<Buffer>;

export type OrchestratorOptions = {
  source: AudioTurnSource;
  planner: Planner;
  cache: AudioCache;
  /** Live TTS for cache misses. Returns full mu-law buffer. */
  synth: Synth;
  payerId: string;
  objective: string;
  payload: Record<string, string>;
  /** Required goals; when all are completed we hang up. */
  requiredGoals?: readonly string[];
  /** Confidence at/above which we speculate on a partial transcript. */
  speculateThreshold?: number;
  now?: () => number;
  log?: (line: string) => void;
};

export type RunResult = {
  completedGoals: string[];
  turns: number;
  latency: LatencyTracker;
};

type Speculation = {
  meaning: string;
  decision: PlannerDecision;
  rendered: RenderedResponse;
};

export class Orchestrator {
  private readonly o: Required<Pick<OrchestratorOptions, "speculateThreshold" | "now" | "log" | "requiredGoals">> &
    OrchestratorOptions;
  private readonly latency: LatencyTracker;
  private readonly completedGoals = new Set<string>();

  private turnSeq = 0;
  private turnId = "";
  private sawPartial = false;
  private speculation: Speculation | null = null;

  // retry tracking: same meaning repeating without progress
  private lastMeaning: string | null = null;
  private retryOnMeaning = 0;

  // meanings of committed turns, for the planner's loop detection
  private readonly committedMeanings: string[] = [];

  constructor(opts: OrchestratorOptions) {
    this.o = {
      speculateThreshold: 0.7,
      now: () => Date.now(),
      log: () => {},
      requiredGoals: [],
      ...opts,
    };
    this.latency = new LatencyTracker(this.o.now);
  }

  run(): Promise<RunResult> {
    return new Promise((resolve) => {
      const unsub = this.o.source.onEvent((ev) => {
        void this.handle(ev, () => {
          unsub();
          resolve({
            completedGoals: [...this.completedGoals],
            turns: this.turnSeq,
            latency: this.latency,
          });
        });
      });
    });
  }

  private async handle(ev: TurnSourceEvent, done: () => void): Promise<void> {
    switch (ev.kind) {
      case "call-started":
        this.o.log(`[call] ${ev.payer ?? ""} ${ev.phone ?? ""}`.trim());
        return;

      case "speech-start":
        this.turnId = `t${++this.turnSeq}`;
        this.sawPartial = false;
        this.speculation = null;
        this.latency.startTurn(this.turnId);
        return;

      case "partial-transcript": {
        if (!this.sawPartial) {
          this.sawPartial = true;
          this.latency.mark(this.turnId, "firstPartial");
        }
        await this.maybeSpeculate(ev.text);
        return;
      }

      case "endpoint":
        await this.respondToEndpoint(ev.text);
        return;

      case "barge-in":
        this.o.log(`[turn ${this.turnId}] barge-in`);
        return;

      case "ended":
        this.o.log(`[call] ended: ${ev.reason}`);
        done();
        return;
    }
  }

  /** Preemptive generation: plan + render from a confident partial, hold it. */
  private async maybeSpeculate(partial: string): Promise<void> {
    const turnId = this.turnId; // capture: respond() can advance the turn re-entrantly
    const state = analyze(partial, false);
    if (state.promptMeaning === "unknown" || state.confidence < this.o.speculateThreshold) return;
    if (this.speculation?.meaning === state.promptMeaning) return; // already prepared

    const decision = await this.o.planner.plan(state, this.context(false));
    // Only hold a speculation we're confident in; menus/branches that need the
    // full prompt return low confidence and are (correctly) recomputed on endpoint.
    if (decision.confidence < this.o.speculateThreshold) return;
    const rendered = await this.render(turnId, decision.preferred);
    this.speculation = { meaning: state.promptMeaning, decision, rendered };
    this.o.log(`[turn ${turnId}] speculated ${state.promptMeaning}`);
  }

  private async respondToEndpoint(finalText: string): Promise<void> {
    // Capture the turn id up front: source.respond() below synchronously drives
    // the simulator into the NEXT turn (mutating this.turnId), so every stamp
    // and log for THIS turn must use the captured id.
    const turnId = this.turnId;
    this.latency.mark(turnId, "endpoint");
    this.latency.mark(turnId, "finalTranscript");

    const state = analyze(finalText, true);
    if (state.goalSignal) this.completeGoal(state.goalSignal);

    // retry detection drives preferred -> fallback
    if (state.promptMeaning === this.lastMeaning) this.retryOnMeaning++;
    else {
      this.retryOnMeaning = 0;
      this.lastMeaning = state.promptMeaning;
    }
    const isRetry = this.retryOnMeaning > 0;

    let decision: PlannerDecision;
    let rendered: RenderedResponse;

    const specHit =
      !isRetry && this.speculation && this.speculation.meaning === state.promptMeaning;

    if (specHit && this.speculation) {
      decision = this.speculation.decision;
      rendered = this.speculation.rendered;
      this.latency.setPlanSource(turnId, "speculative-hit");
    } else {
      this.latency.mark(turnId, "planStart");
      decision = await this.o.planner.plan(state, this.context(isRetry));
      this.latency.mark(turnId, "planResolved");
      this.latency.setPlanSource(turnId, decision.source);
      const action = this.executorAction(decision, isRetry);
      rendered = await this.render(turnId, action);
    }
    this.speculation = null;

    if (decision.goalCompleted) this.completeGoal(decision.goalCompleted);

    const action = rendered.action;
    this.o.log(
      `[turn ${turnId}] ${state.promptMeaning} -> ${describe(action)}` +
        ` (${this.latency.get(turnId)?.planSource})`,
    );

    if (action.type === "wait") {
      // Do nothing this turn — keep listening (e.g. optional survey prompt).
    } else if (action.type === "hangup") {
      if (!this.o.source.isEnded()) this.o.source.hangup();
    } else {
      this.latency.mark(turnId, "firstFrameToTwilio");
      this.o.source.respond(rendered);
      this.latency.mark(turnId, "playbackComplete");
    }

    // Record the committed meaning AFTER planning (so context excluded the
    // current turn) — this feeds the planner's loop detection next turn.
    this.committedMeanings.push(state.promptMeaning);

    if (this.goalsSatisfied() && !this.o.source.isEnded()) {
      this.o.source.hangup();
    }
  }

  /** Pick preferred normally; on a repeated prompt, fall back to the other modality. */
  private executorAction(decision: PlannerDecision, isRetry: boolean): Action {
    if (isRetry && decision.fallback) return decision.fallback;
    return decision.preferred;
  }

  private async render(turnId: string, action: Action): Promise<RenderedResponse> {
    if (action.type === "dtmf") {
      return { action, audio: this.o.cache.getDtmf(action.digits) };
    }
    if (action.type !== "speech") {
      // wait / hangup carry no audio.
      return { action, audio: Buffer.alloc(0) };
    }
    const cached = this.o.cache.getSpeech(action.text);
    if (cached) return { action, audio: cached };
    this.latency.mark(turnId, "ttsRequest");
    const audio = await this.o.synth(action.text);
    this.latency.mark(turnId, "firstAudioByte");
    return { action, audio };
  }

  private context(isRetry: boolean): PlannerContext {
    return {
      payerId: this.o.payerId,
      objective: this.o.objective,
      payload: this.o.payload,
      completedGoals: this.completedGoals,
      isRetry,
      recentMeanings: this.committedMeanings.slice(-6),
    };
  }

  private completeGoal(goal: string): void {
    if (!this.completedGoals.has(goal)) {
      this.completedGoals.add(goal);
      this.o.log(`[goal] ${goal}`);
    }
  }

  private goalsSatisfied(): boolean {
    return (
      this.o.requiredGoals.length > 0 &&
      this.o.requiredGoals.every((g) => this.completedGoals.has(g))
    );
  }
}

function describe(action: Action): string {
  switch (action.type) {
    case "dtmf":
      return `press ${action.digits}`;
    case "speech":
      return `say "${action.text}"`;
    case "wait":
      return `wait (${action.reason ?? "no action"})`;
    case "hangup":
      return `hangup (${action.reason})`;
  }
}
