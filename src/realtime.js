// @ts-check
/**
 * RealtimeCall — the "virtual dialer" layer. Wraps the turn-based IVRCall in
 * TIME, which is what separates a phone call from a chatbot:
 *
 *   - prompts are "spoken" in word chunks at a speaking rate (you cannot read
 *     the whole prompt instantly; your agent parses a stream)
 *   - after a prompt ends, an input timeout arms; silence gets a reprompt,
 *     repeated silence gets a hangup (engine.timeoutInput)
 *   - DTMF/speech sent while the IVR is talking BARGES IN: remaining chunks
 *     are cancelled, exactly like DTMF cut-through on a real line
 *   - events arrive when the IVR decides, not as responses to your requests
 *
 * This is the same event model as a telephony media stream (Twilio etc.):
 * subscribe to events, send input whenever you want, the clock is real.
 *
 * Options:
 *   timeScale       1 = realistic; 0.02 makes tests fast (default 1)
 *   debug           true exposes fullText on speech-end. OFF BY DEFAULT on
 *                   purpose: your agent must assemble meaning from chunks,
 *                   like real streaming ASR. Don't build against debug.
 *   wpm             IVR speaking rate, words per minute (default 165)
 *   inputTimeoutMs  silence allowed after a prompt ends (default 6000, scaled)
 *   ...plus all IVRCall options (seed, mishearRate, holdScale)
 *
 * Event kinds emitted (superset of engine kinds):
 *   call-started | speech-start | speech-chunk | speech-end | barge-in |
 *   timeout | hold | rep | readout | ended
 */
import { IVRCall } from "./ivr-engine.js";

export class RealtimeCall {
  constructor(tree, opts = {}) {
    this.timeScale = opts.timeScale ?? 1;
    this.wpm = opts.wpm ?? 165;
    this.inputTimeoutMs = opts.inputTimeoutMs ?? 6000;
    this.debug = !!opts.debug;
    this._stats = { wordsHeard: 0, bargeIns: 0, timeouts: 0, startedAt: Date.now() };
    this.call = new IVRCall(tree, { ...opts, holdScale: (opts.holdScale ?? 1) * this.timeScale });
    this.listeners = [];
    this.events = [];          // full history, for replay/SSE catch-up
    this._timers = new Set();
    this._speaking = false;
    this._pendingChunks = [];
    this._done = false;
    this._epoch = 0;   // bumped on every caller input; kills stale timers/continuations
  }

  /** Subscribe to events; immediately receives nothing (use .events for history). */
  onEvent(fn) { this.listeners.push(fn); return () => { this.listeners = this.listeners.filter((l) => l !== fn); }; }

  start() {
    this._emit({ kind: "call-started", payer: this.call.tree.payer, phone: this.call.tree.phone });
    const ev = this.call.start();
    this._speakEvent({ ...ev, text: `${this.call.tree.greeting} ${ev.text}` });
  }

  /**
   * Send caller input AT ANY TIME. If the IVR is mid-prompt this is a barge-in.
   * Returns nothing: the response arrives as events, like a real call.
   */
  sendInput(inp) {
    if (this._done) return;
    this._epoch++;
    if (this._speaking) {
      this._cancelSpeech();
      this._stats.bargeIns++;
      this._emit({ kind: "barge-in", interrupted: true });
    }
    this._clearTimers();
    const ev = this.call.input(inp);
    this._speakEvent(ev);
  }

  hangup() { this._finish({ kind: "ended", text: "Caller hung up." }); }

  /** Efficiency metrics: a streaming agent hears fewer words (barge-in). */
  stats() { return { ...this._stats, durationMs: Date.now() - this._stats.startedAt }; }

  /** Public call-state accessor; do not reach for _done. */
  isEnded() { return this._done; }

  // ---------- internals ----------

  _speakEvent(ev) {
    if (this._done) return;
    if (ev.kind === "ended") return this._finishAfterSpeech(ev);
    if (ev.kind === "hold") {
      this._emit({ kind: "hold", text: ev.text, resolveAfterMs: ev.resolveAfterMs });
      this.call.waitForRep().then((rep) => {
        if (this._done) return;
        this._emit({ kind: "rep", text: rep.text, answeredAfterMs: rep.answeredAfterMs });
        this._finish({ kind: "ended", text: "Warm-transfer point reached. Realtime call complete." });
      });
      return;
    }
    // prompts, reprompts, confirms, readouts: speak them in time
    const expectsInput = ev.kind !== "readout" || !!ev.followup;
    const text = ev.followup ? `${ev.text} ${ev.followup}` : ev.text;
    this._speak(text, ev, () => {
      if (ev.kind === "readout" && !ev.followup) return this._finish({ kind: "ended", text: "Call ended after readout." });
      if (expectsInput) this._armTimeout();
    });
  }

  _speak(text, sourceEv, onDone) {
    const epoch = this._epoch;
    const words = text.split(/\s+/).filter(Boolean);
    const msPerWord = (60000 / this.wpm) * this.timeScale;
    const CHUNK = 4;
    this._speaking = true;
    const startEv = { kind: "speech-start", sourceKind: sourceEv.kind };
    if (this.debug) startEv.node = sourceEv.node;     // real ASR gives you words, not node ids
    this._emit(startEv);
    let i = 0;
    const sendChunk = () => {
      if (this._done || !this._speaking || this._epoch !== epoch) return;
      const chunk = words.slice(i, i + CHUNK);
      i += CHUNK;
      this._stats.wordsHeard += chunk.length;
      this._emit({ kind: "speech-chunk", text: chunk.join(" ") });
      // a listener may have barged in SYNCHRONOUSLY during that emit; if so,
      // this prompt is dead and must not schedule anything further
      if (this._done || this._epoch !== epoch) return;
      if (i < words.length) {
        this._after(chunk.length * msPerWord, sendChunk);
      } else {
        this._after(chunk.length * msPerWord, () => {
          if (this._done || this._epoch !== epoch) return;  // stale completion
          this._speaking = false;
          const endEv = { kind: "speech-end", sourceKind: sourceEv.kind };
          if (this.debug) { endEv.fullText = text; endEv.node = sourceEv.node; endEv.captured = sourceEv.captured; }
          this._emit(endEv);
          if (this._epoch === epoch) onDone();   // listener may have responded during the emit
        });
      }
    };
    sendChunk();
  }

  _armTimeout() {
    this._after(this.inputTimeoutMs * this.timeScale, () => {
      const ev = this.call.timeoutInput();
      this._stats.timeouts++;
      this._emit({ kind: "timeout", text: "(silence)" });
      this._speakEvent(ev);
    });
  }

  _cancelSpeech() { this._speaking = false; this._clearTimers(); }
  _after(ms, fn) { const t = setTimeout(() => { this._timers.delete(t); fn(); }, Math.max(1, ms)); this._timers.add(t); }
  _clearTimers() { for (const t of this._timers) clearTimeout(t); this._timers.clear(); }

  _finishAfterSpeech(ev) {
    this._speak(ev.text, ev, () => this._finish({ kind: "ended", text: ev.text }));
  }
  _finish(ev) {
    if (this._done) return;
    this._done = true;
    this._clearTimers();
    this._emit(ev);
  }

  _emit(ev) {
    const stamped = { ...ev, at: Date.now() };
    this.events.push(stamped);
    for (const fn of this.listeners) fn(stamped);
  }
}
