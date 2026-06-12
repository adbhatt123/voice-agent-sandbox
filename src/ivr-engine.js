// @ts-check
/**
 * Generic IVR simulator engine. Plays any tree config (see src/trees/).
 * Node kinds: menu | capture | confirm | hold | rep | readout | hangup
 * Zero dependencies. Deterministic via seeded RNG.
 */

/** Seeded PRNG (mulberry32) so mishearing is reproducible in tests. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SPEECH_CONFUSIONS = {
  // classic ASR confusions: the reason the brief tells you to prefer DTMF
  "5": ["9", "1"], "9": ["5"], "1": ["7"], "7": ["1"],
  "FIVE": ["NINE"], "NINE": ["FIVE"], "ONE": ["SEVEN"], "SEVEN": ["ONE"],
  "ZERO": ["OH"], "EIGHT": ["A"], "A": ["EIGHT", "K"],
  "B": ["D", "E", "P"], "D": ["B", "T"], "M": ["N"], "N": ["M"],
  "S": ["F"], "F": ["S"], "Z": ["C"], "C": ["Z"],
  "FIFTEEN": ["FIFTY"], "FIFTY": ["FIFTEEN"],
  "THIRTEEN": ["THIRTY"], "THIRTY": ["THIRTEEN"],
};

export class IVRCall {
  /**
   * @param {object} tree - payer tree config (parsed JSON)
   * @param {object} [opts]
   * @param {number} [opts.seed=1] - RNG seed (mishearing, hold duration)
   * @param {number} [opts.holdScale=1] - multiply hold durations (0.01 for tests)
   * @param {number} [opts.mishearRate=0.12] - per-token speech corruption probability
   */
  constructor(tree, opts = {}) {
    this.tree = tree;
    this.rng = mulberry32(opts.seed ?? 1);
    this.holdScale = opts.holdScale ?? 1;
    this.mishearRate = opts.mishearRate ?? 0.12;
    this.nodeId = null;
    this.retries = 0;
    this.captured = {};        // values the IVR "heard", keyed by capture type
    this._pendingConfirm = null;
    this._log = [];
    this._ended = false;
    this._repResolvers = [];
    this._startedAt = Date.now();
    this._holdMs = 0;          // synthetic seconds-on-hold metric
  }

  /** Start the call: greeting + root node prompt. */
  start() {
    this._say(`[greeting] ${this.tree.greeting}`);
    return this._enter(this.tree.root ?? "root");
  }

  /**
   * Send caller input to the current node.
   * @param {{type:"dtmf"|"speech", value:string}} inp
   * @returns {object} next event { kind, text, ... }
   */
  input(inp) {
    if (this._ended) return this._ev("ended", "Call already ended.");
    if (this.nodeId === "__confirm__") {
      this._log.push({ t: Date.now(), dir: "caller", type: inp.type, value: inp.value });
      return this._handleConfirm(null, inp);
    }
    const node = this.tree.nodes[this.nodeId];
    if (!node) return this._hangup("Internal: bad node");
    this._log.push({ t: Date.now(), dir: "caller", type: inp.type, value: inp.value });

    if (node.kind === "menu") return this._handleMenu(node, inp);
    if (node.kind === "capture") return this._handleCapture(node, inp);
    if (node.kind === "confirm") return this._handleConfirm(node, inp);
    if (node.kind === "hold") return this._ev("hold", "Please continue to hold.", { resolveAfterMs: this._holdRemaining });
    return this._ev("prompt", node.prompt ?? "...");
  }

  /** Resolves when the rep "answers" (only valid while in a hold node). */
  waitForRep() {
    if (this._ended) return Promise.resolve(this._ev("ended", "Call already ended."));
    return new Promise((res) => this._repResolvers.push(res));
  }

  /** Full call log: prompts heard + inputs sent (for debugging + leak scans). */
  transcript() {
    return this._log.map((l) => `${l.dir === "ivr" ? "IVR " : "YOU "} ${l.type ?? ""} ${l.value ?? l.text}`).join("\n");
  }

  /** Synthetic metric: ms the caller spent "on hold" (scaled). */
  holdTimeMs() { return this._holdMs; }

  // ---------- internals ----------

  _handleMenu(node, inp) {
    const key = `${inp.type}:${inp.value}`.toLowerCase();
    const next = node.inputs[key];
    if (next) { this.retries = 0; return this._enter(next); }
    return this._retry(node);
  }

  _handleCapture(node, inp) {
    if (node.via && !node.via.includes(inp.type)) {
      return this._ev("reprompt", node.rejectText ?? `Please use ${node.via.join(" or ")}.`);
    }
    const heard = inp.type === "speech" ? this._mishear(inp.value) : inp.value;
    const normalized = normalizeTokens(heard);
    if (node.pattern && !new RegExp(node.pattern).test(normalized)) {
      return this._retry(node, node.invalidText ?? "That entry is not valid.");
    }
    this.captured[node.capture] = normalized;
    this.retries = 0;
    if (node.confirm) {
      this._pendingConfirm = { capture: node.capture, returnTo: this.nodeId, next: node.next };
      this.nodeId = "__confirm__";
      const spoken = normalized.split("").join(" ");
      return this._ev("confirm", `I heard ${spoken}. Press 1 to confirm, 2 to re-enter.`);
    }
    return this._enter(node.next);
  }

  _handleConfirm(_node, inp) {
    const pc = this._pendingConfirm;
    if (!pc) return this._hangup("Internal: confirm without pending");
    if (inp.type === "dtmf" && inp.value === "1") {
      this._pendingConfirm = null;
      return this._enter(pc.next);
    }
    if (inp.type === "dtmf" && inp.value === "2") {
      delete this.captured[pc.capture];
      this._pendingConfirm = null;
      return this._enter(pc.returnTo);
    }
    return this._retry({ prompt: "Press 1 to confirm, 2 to re-enter.", maxRetries: 2, onFail: "hangup" });
  }

  _enter(nodeId) {
    const node = this.tree.nodes[nodeId];
    if (!node) return this._hangup(`Internal: unknown node ${nodeId}`);
    this.nodeId = nodeId;

    if (node.kind === "hold") {
      const min = node.minMs ?? 120000, max = node.maxMs ?? 900000;
      const ms = Math.round((min + this.rng() * (max - min)) * this.holdScale);
      this._holdRemaining = ms;
      this._holdMs += ms;
      this._say(node.prompt ?? "Please hold for the next available representative.");
      setTimeout(() => {
        if (this._ended) return;
        this._enterRep(node.next ?? "rep");
      }, ms);
      return this._ev("hold", node.prompt ?? "Please hold.", { resolveAfterMs: ms });
    }
    if (node.kind === "rep") return this._enterRepNow(node);
    if (node.kind === "readout") {
      const text = renderTemplate(node.template, this.captured);
      this._say(text);
      this._ended = true;
      return this._ev("readout", text, { captured: { ...this.captured } });
    }
    if (node.kind === "hangup") return this._hangup(node.prompt ?? "Goodbye.");
    this._say(node.prompt);
    return this._ev(node.kind === "confirm" ? "confirm" : "prompt", node.prompt);
  }

  _enterRep(nodeId) {
    const node = this.tree.nodes[nodeId] ?? { kind: "rep", prompt: "This is the provider services team, how can I help you?" };
    const ev = this._enterRepNow(node);
    for (const res of this._repResolvers.splice(0)) res(ev);
  }

  _enterRepNow(node) {
    this._say(node.prompt ?? "Representative here.");
    this._ended = true;
    return this._ev("rep", node.prompt ?? "Representative here.", {
      answeredAfterMs: this._holdMs,
    });
  }

  _retry(node, msg) {
    this.retries++;
    const max = node.maxRetries ?? 2;
    if (this.retries > max) {
      return this._hangup(node.failText ?? "We are unable to process your request. Goodbye.");
    }
    return this._ev("reprompt", msg ?? node.retryPrompt ?? node.prompt ?? "Sorry, I didn't get that.");
  }

  _mishear(speech) {
    // token-level corruption; DTMF never passes through here
    return speech.trim().split(/\s+/).map((tok) => {
      const up = tok.toUpperCase();
      const opts = SPEECH_CONFUSIONS[up];
      if (opts && this.rng() < this.mishearRate) {
        return opts[Math.floor(this.rng() * opts.length)];
      }
      return up;
    }).join(" ");
  }

  _say(text) { this._log.push({ t: Date.now(), dir: "ivr", text }); }

  _ev(kind, text, extra = {}) {
    if (kind !== "hold") this._log.push({ t: Date.now(), dir: "ivr", type: kind, value: text });
    return { kind, text, node: this.nodeId, ...extra };
  }

  _hangup(text) {
    this._say(text);
    this._ended = true;
    return this._ev("ended", text);
  }
}

/** Normalize spoken/keyed tokens into a compact identifier string. */
export function normalizeTokens(raw) {
  const WORD_DIGITS = {
    ZERO: "0", OH: "0", ONE: "1", TWO: "2", THREE: "3", FOUR: "4",
    FIVE: "5", SIX: "6", SEVEN: "7", EIGHT: "8", NINE: "9",
  };
  const NATO = {
    ALPHA: "A", BRAVO: "B", CHARLIE: "C", DELTA: "D", ECHO: "E", FOXTROT: "F",
    GOLF: "G", HOTEL: "H", INDIA: "I", JULIETT: "J", JULIET: "J", KILO: "K",
    LIMA: "L", MIKE: "M", NOVEMBER: "N", OSCAR: "O", PAPA: "P", QUEBEC: "Q",
    ROMEO: "R", SIERRA: "S", TANGO: "T", UNIFORM: "U", VICTOR: "V",
    WHISKEY: "W", XRAY: "X", YANKEE: "Y", ZULU: "Z",
  };
  return raw.trim().split(/\s+/).map((tok) => {
    const up = tok.toUpperCase().replace(/[^A-Z0-9#*]/g, "");
    if (WORD_DIGITS[up]) return WORD_DIGITS[up];
    if (NATO[up]) return NATO[up];
    return up;
  }).join("");
}

function renderTemplate(tpl, vars) {
  return tpl.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? `{${k}}`);
}
