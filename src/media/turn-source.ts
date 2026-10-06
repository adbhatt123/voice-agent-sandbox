/**
 * AudioTurnSource — the seam that makes the streaming stack testable offline.
 *
 * It emits the same event vocabulary a Twilio Media Stream + Deepgram produces
 * (which is, not coincidentally, what realtime.js already simulates), and it
 * accepts our response. The orchestrator is written ONCE against this interface:
 *
 *   - TwilioMediaSource  (P4): real WS + Deepgram behind it
 *   - SimulatedSource    (P2): adapter over the existing RealtimeCall engine
 *
 * Outbound is expressed as BOTH a structured Action and rendered audio. The real
 * source streams the audio frames; the simulated source consumes the Action
 * (the simulator wants typed input, not waveforms). Each picks what it needs, so
 * the orchestrator stays identical across both.
 */

import type { Action } from "../types.ts";

export type TurnSourceEvent =
  | { kind: "call-started"; payer?: string; phone?: string }
  | { kind: "speech-start" }
  /** Growing best-guess transcript of the prompt currently being spoken. */
  | { kind: "partial-transcript"; text: string }
  /** Endpoint/turn detected: the prompt is finished, respond now. */
  | { kind: "endpoint"; text: string }
  /** Our outbound audio was cut short because the far end started talking. */
  | { kind: "barge-in" }
  /** Far end pressed a key (rare inbound; mostly we send these). */
  | { kind: "dtmf"; digit: string }
  | { kind: "ended"; reason: string };

export type RenderedResponse = {
  action: Action;
  /** Ready-to-stream mu-law 8k audio for `action` (may be empty for sim). */
  audio: Buffer;
};

export interface AudioTurnSource {
  /** Subscribe to events. Returns an unsubscribe function. */
  onEvent(fn: (ev: TurnSourceEvent) => void): () => void;
  /** Deliver our response. Real source streams audio; sim consumes the action. */
  respond(response: RenderedResponse): void;
  /** Flush any buffered outbound audio (barge-in / abandon current response). */
  clear(): void;
  hangup(): void;
  isEnded(): boolean;
}
