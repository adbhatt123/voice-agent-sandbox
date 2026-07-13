/**
 * Per-turn latency instrumentation.
 *
 * A "turn" is one IVR-prompt -> our-response cycle. We stamp every stage so the
 * monitor can show a waterfall and you can see exactly which stage dominates:
 * STT first-token lag, endpoint detection lag, planning, TTS time-to-first-byte,
 * or outbound network.
 *
 * Clock is injectable so tests are deterministic. Pure, no I/O.
 */

export type PlanSource = "cache" | "memory" | "llm" | "speculative-hit";

/** The stages we stamp, in roughly causal order. */
export type Stage =
  | "ivrSpeechStart"
  | "firstPartial"
  | "endpoint"
  | "finalTranscript"
  | "planStart"
  | "planResolved"
  | "ttsRequest"
  | "firstAudioByte"
  | "firstFrameToTwilio"
  | "playbackComplete";

export type TurnTrace = {
  turnId: string;
  stamps: Partial<Record<Stage, number>>;
  planSource?: PlanSource;
};

/** Latencies derived from a trace's stamps. Undefined where stamps are missing. */
export type TurnMetrics = {
  turnId: string;
  planSource?: PlanSource;
  sttLag?: number; // speech start -> first partial
  endpointLag?: number; // last partial activity -> endpoint detected
  planTime?: number; // planStart -> planResolved
  ttsTtfb?: number; // ttsRequest -> firstAudioByte
  outboundNetwork?: number; // firstAudioByte -> firstFrameToTwilio
  responseLatency?: number; // endpoint -> firstFrameToTwilio (the number that matters)
  playbackTime?: number; // firstFrameToTwilio -> playbackComplete
  totalTurn?: number; // ivrSpeechStart -> playbackComplete
};

const diff = (a?: number, b?: number): number | undefined =>
  a === undefined || b === undefined ? undefined : b - a;

export class LatencyTracker {
  private readonly now: () => number;
  private readonly traces = new Map<string, TurnTrace>();
  private order: string[] = [];

  constructor(now: () => number = () => Date.now()) {
    this.now = now;
  }

  /** Begin a turn; stamps ivrSpeechStart. */
  startTurn(turnId: string): TurnTrace {
    const trace: TurnTrace = { turnId, stamps: {} };
    this.traces.set(turnId, trace);
    this.order.push(turnId);
    this.mark(turnId, "ivrSpeechStart");
    return trace;
  }

  /** Stamp a stage. First write wins for a given stage (ignores duplicate signals). */
  mark(turnId: string, stage: Stage, ts: number = this.now()): void {
    const trace = this.traces.get(turnId);
    if (!trace) return;
    if (trace.stamps[stage] === undefined) trace.stamps[stage] = ts;
  }

  setPlanSource(turnId: string, source: PlanSource): void {
    const trace = this.traces.get(turnId);
    if (trace) trace.planSource = source;
  }

  get(turnId: string): TurnTrace | undefined {
    return this.traces.get(turnId);
  }

  metrics(turnId: string): TurnMetrics | undefined {
    const t = this.traces.get(turnId);
    if (!t) return undefined;
    const s = t.stamps;
    return {
      turnId,
      planSource: t.planSource,
      sttLag: diff(s.ivrSpeechStart, s.firstPartial),
      endpointLag: diff(s.firstPartial, s.endpoint),
      planTime: diff(s.planStart, s.planResolved),
      ttsTtfb: diff(s.ttsRequest, s.firstAudioByte),
      outboundNetwork: diff(s.firstAudioByte, s.firstFrameToTwilio),
      responseLatency: diff(s.endpoint, s.firstFrameToTwilio),
      playbackTime: diff(s.firstFrameToTwilio, s.playbackComplete),
      totalTurn: diff(s.ivrSpeechStart, s.playbackComplete),
    };
  }

  allMetrics(): TurnMetrics[] {
    return this.order.map((id) => this.metrics(id)!).filter(Boolean);
  }

  /** Aggregate view for the monitor: count + p50/p95 of the headline metrics. */
  summary(): {
    turns: number;
    bySource: Record<string, number>;
    responseLatency: { p50?: number; p95?: number };
    planTime: { p50?: number; p95?: number };
    ttsTtfb: { p50?: number; p95?: number };
  } {
    const all = this.allMetrics();
    const bySource: Record<string, number> = {};
    for (const m of all) {
      const key = m.planSource ?? "unknown";
      bySource[key] = (bySource[key] ?? 0) + 1;
    }
    const pct = (key: keyof TurnMetrics) => {
      const xs = all
        .map((m) => m[key])
        .filter((v): v is number => typeof v === "number")
        .sort((a, b) => a - b);
      const at = (p: number) =>
        xs.length ? xs[Math.min(xs.length - 1, Math.floor(p * xs.length))] : undefined;
      return { p50: at(0.5), p95: at(0.95) };
    };
    return {
      turns: all.length,
      bySource,
      responseLatency: pct("responseLatency"),
      planTime: pct("planTime"),
      ttsTtfb: pct("ttsTtfb"),
    };
  }
}
