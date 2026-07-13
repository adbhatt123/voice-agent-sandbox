/** Shared types for the streaming voice stack. */

/** How the IVR wants this turn answered — drives TTS-first vs DTMF. */
export type InputMode = "speech_preferred" | "dtmf_capture" | "dtmf_only";

/** A deterministic response the executor can perform. */
export type Action =
  | { type: "speech"; text: string }
  | { type: "dtmf"; digits: string }
  /** Do nothing this turn — e.g. an optional survey prompt; keep listening. */
  | { type: "wait"; reason?: string }
  /** Give up on this call (wrong-branch loop we can't escape, etc.). */
  | { type: "hangup"; reason: string };

/** What the current IVR prompt means, derived from (partial) transcript. */
export type SemanticState = {
  promptMeaning: string;
  inputMode: InputMode;
  confidence: number; // classifier confidence 0..1
  goalSignal: string | null; // a goal this prompt indicates is now complete
  rawTranscript: string;
};
