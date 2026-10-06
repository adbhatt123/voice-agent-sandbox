/**
 * Pre-rendered audio cache.
 *
 * Two kinds of entries, both stored as ready-to-stream mu-law buffers:
 *   1. Common spoken phrases ("Yes", "Healthcare professional", "Claim
 *      information", "Medical", spelled digits...) synthesized once at boot.
 *   2. DTMF tones for 0-9 # *, generated locally (never via TTS).
 *
 * A cache hit means a turn responds with ZERO TTS latency — frames go straight
 * to Twilio on endpoint. The synth function is injected so this module is fully
 * testable without a TTS vendor; in production it's the Cartesia streaming
 * client collected into a single buffer.
 */

import { dtmfSequence } from "../media/audio.ts";

/** Synthesizes text to a complete mu-law 8k buffer. Injected (Cartesia in prod). */
export type Synth = (text: string) => Promise<Buffer>;

/** Phrases worth warming. Extend per-payer as memory reveals common prompts. */
export const COMMON_PHRASES: readonly string[] = [
  "Yes",
  "No",
  "Healthcare professional",
  "Claim information",
  "Claim status",
  "Medical",
  "Pharmacy",
  "Eligibility",
  "Representative",
  "Provider",
];

function normalize(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

export class AudioCache {
  private readonly speech = new Map<string, Buffer>();
  private readonly dtmf = new Map<string, Buffer>();

  /** Pre-synthesize the given phrases. Failures are skipped, not fatal. */
  async warm(synth: Synth, phrases: readonly string[] = COMMON_PHRASES): Promise<number> {
    let warmed = 0;
    await Promise.all(
      phrases.map(async (p) => {
        try {
          this.speech.set(normalize(p), await synth(p));
          warmed++;
        } catch {
          /* a missing warm entry just means a live TTS call later */
        }
      }),
    );
    return warmed;
  }

  hasSpeech(text: string): boolean {
    return this.speech.has(normalize(text));
  }

  getSpeech(text: string): Buffer | undefined {
    return this.speech.get(normalize(text));
  }

  /** Manually seed a speech entry (e.g. learned per-payer phrase). */
  setSpeech(text: string, audio: Buffer): void {
    this.speech.set(normalize(text), audio);
  }

  /**
   * Get DTMF audio for a digit string, generating and memoizing on first use.
   * Single digits are cached; multi-digit sequences are generated on demand
   * (the per-digit tones underneath are effectively constant work).
   */
  getDtmf(digits: string): Buffer {
    const cached = this.dtmf.get(digits);
    if (cached) return cached;
    const audio = dtmfSequence(digits);
    if (digits.length <= 1) this.dtmf.set(digits, audio);
    return audio;
  }

  size(): { speech: number; dtmf: number } {
    return { speech: this.speech.size, dtmf: this.dtmf.size };
  }
}
