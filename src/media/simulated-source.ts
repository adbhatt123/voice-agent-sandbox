/**
 * SimulatedSource — AudioTurnSource backed by the existing RealtimeCall engine.
 *
 * This is the offline test harness: it turns the simulator's word-chunk speech
 * model into the same partial/endpoint stream a real STT produces, and feeds our
 * responses back as typed input (the simulator wants {type,value}, not audio).
 * Lets the entire orchestrator + planner + latency stack run under `node --test`
 * with no phone, no Deepgram, no TTS account.
 *
 * Start ordering: construct, subscribe (orchestrator.run()), THEN call start()
 * so the subscriber sees call-started/speech-start.
 */

import { RealtimeCall } from "../realtime.js";
import type { AudioTurnSource, TurnSourceEvent, RenderedResponse } from "./turn-source.ts";

type Listener = (ev: TurnSourceEvent) => void;

export class SimulatedSource implements AudioTurnSource {
  private readonly rc: RealtimeCall;
  private listeners: Listener[] = [];
  private partial = "";
  private ended = false;

  constructor(tree: unknown, opts: Record<string, unknown> = {}) {
    // mishearRate 0 by default here: P2 tests the control flow, not ASR noise.
    this.rc = new RealtimeCall(tree, { mishearRate: 0, ...opts });
    this.rc.onEvent((ev: { kind: string; text?: string; payer?: string; phone?: string }) =>
      this.translate(ev),
    );
  }

  start(): void {
    this.rc.start();
  }

  onEvent(fn: Listener): () => void {
    this.listeners.push(fn);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== fn);
    };
  }

  respond(response: RenderedResponse): void {
    if (this.ended) return;
    const a = response.action;
    // The simulator consumes the structured action; the rendered audio is what
    // the REAL Twilio source would stream. We exercise rendering for latency
    // stamps regardless, then drive the engine with typed input.
    switch (a.type) {
      case "dtmf":
        this.rc.sendInput({ type: "dtmf", value: a.digits });
        return;
      case "speech":
        this.rc.sendInput({ type: "speech", value: a.text });
        return;
      case "hangup":
        this.hangup();
        return;
      case "wait":
        // Send nothing; let the IVR continue (or time out) on its own.
        return;
    }
  }

  clear(): void {
    /* no buffered outbound audio in the simulator */
  }

  hangup(): void {
    if (!this.ended) this.rc.hangup();
  }

  isEnded(): boolean {
    return this.ended || this.rc.isEnded();
  }

  private translate(ev: { kind: string; text?: string; payer?: string; phone?: string }): void {
    switch (ev.kind) {
      case "call-started":
        this.emit({ kind: "call-started", payer: ev.payer, phone: ev.phone });
        return;
      case "speech-start":
        this.partial = "";
        this.emit({ kind: "speech-start" });
        return;
      case "speech-chunk":
        this.partial = this.partial ? `${this.partial} ${ev.text}` : (ev.text ?? "");
        this.emit({ kind: "partial-transcript", text: this.partial });
        return;
      case "speech-end":
        this.emit({ kind: "endpoint", text: this.partial });
        return;
      case "barge-in":
        this.emit({ kind: "barge-in" });
        return;
      case "rep":
        this.finish("representative answered");
        return;
      case "ended":
        this.finish(ev.text ?? "call ended");
        return;
      // hold / timeout: not surfaced to the orchestrator in P2
    }
  }

  private finish(reason: string): void {
    if (this.ended) return;
    this.ended = true;
    this.emit({ kind: "ended", reason });
  }

  private emit(ev: TurnSourceEvent): void {
    for (const fn of this.listeners) fn(ev);
  }
}
