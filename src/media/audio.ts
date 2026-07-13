/**
 * Telephony audio primitives for Twilio Media Streams.
 *
 * Twilio sends/receives audio as base64 G.711 mu-law (PCMU), 8 kHz, mono, in
 * 20 ms frames (160 samples = 160 bytes). Everything here works in that domain
 * so the rest of the stack never has to think about resampling. Deepgram STT in
 * (mulaw 8k) and Cartesia TTS out (raw mulaw 8k) both speak this format too, so
 * there is no transcode glue on the hot path.
 *
 * Zero dependencies, pure functions — fully unit-testable offline.
 */

export const SAMPLE_RATE = 8000;
export const FRAME_MS = 20;
export const SAMPLES_PER_FRAME = (SAMPLE_RATE * FRAME_MS) / 1000; // 160
export const FRAME_BYTES = SAMPLES_PER_FRAME; // 1 byte/sample in mu-law
export const MULAW_SILENCE = 0xff; // encoded value of PCM 0

// --- G.711 mu-law codec (CCITT, full 16-bit PCM range) ---

const MULAW_BIAS = 0x84; // 132
const MULAW_CLIP = 32635;

/** Segment exponent for the top byte of a biased magnitude (0..7). */
function exponentOf(byte: number): number {
  if (byte < 2) return 0;
  if (byte < 4) return 1;
  if (byte < 8) return 2;
  if (byte < 16) return 3;
  if (byte < 32) return 4;
  if (byte < 64) return 5;
  if (byte < 128) return 6;
  return 7;
}

/** Encode one PCM16 sample (-32768..32767) to an 8-bit mu-law value. */
export function pcm16ToMulaw(sample: number): number {
  const sign = (sample >> 8) & 0x80;
  if (sign !== 0) sample = -sample;
  if (sample > MULAW_CLIP) sample = MULAW_CLIP;
  sample += MULAW_BIAS;

  const exponent = exponentOf((sample >> 7) & 0xff);
  const mantissa = (sample >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

/** Decode one 8-bit mu-law value back to a PCM16 sample. */
export function mulawToPcm16(mulaw: number): number {
  mulaw = ~mulaw & 0xff;
  const sign = mulaw & 0x80;
  const exponent = (mulaw >> 4) & 0x07;
  const mantissa = mulaw & 0x0f;
  const sample = (((mantissa << 3) + MULAW_BIAS) << exponent) - MULAW_BIAS;
  return sign !== 0 ? -sample : sample;
}

/** Encode a PCM16 buffer to mu-law bytes. */
export function encodeMulaw(pcm: Int16Array): Buffer {
  const out = Buffer.allocUnsafe(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = pcm16ToMulaw(pcm[i] ?? 0);
  return out;
}

/** Decode mu-law bytes to a PCM16 buffer. */
export function decodeMulaw(mulaw: Buffer): Int16Array {
  const out = new Int16Array(mulaw.length);
  for (let i = 0; i < mulaw.length; i++) out[i] = mulawToPcm16(mulaw[i] ?? MULAW_SILENCE);
  return out;
}

/**
 * Split a mu-law buffer into fixed-size frames (default 20 ms / 160 bytes).
 * The final frame is padded with mu-law silence so every frame is full-length —
 * Twilio expects consistent frame sizes on the outbound stream.
 */
export function frameMulaw(mulaw: Buffer, frameBytes: number = FRAME_BYTES): Buffer[] {
  const frames: Buffer[] = [];
  for (let off = 0; off < mulaw.length; off += frameBytes) {
    const slice = mulaw.subarray(off, off + frameBytes);
    if (slice.length === frameBytes) {
      frames.push(Buffer.from(slice));
    } else {
      const padded = Buffer.alloc(frameBytes, MULAW_SILENCE);
      slice.copy(padded);
      frames.push(padded);
    }
  }
  return frames;
}

// --- DTMF tone synthesis ---
// Generated directly (not via TTS) so keypad entry is deterministic and instant.

const DTMF_FREQS: Record<string, [number, number]> = {
  "1": [697, 1209], "2": [697, 1336], "3": [697, 1477],
  "4": [770, 1209], "5": [770, 1336], "6": [770, 1477],
  "7": [852, 1209], "8": [852, 1336], "9": [852, 1477],
  "*": [941, 1209], "0": [941, 1336], "#": [941, 1477],
};

const LOW_GROUP = [697, 770, 852, 941];
const HIGH_GROUP = [1209, 1336, 1477];

/** Synthesize a single DTMF digit as a mu-law buffer. */
export function dtmfTone(digit: string, ms = 200, amplitude = 0.3): Buffer {
  const pair = DTMF_FREQS[digit];
  if (!pair) throw new Error(`not a DTMF digit: ${JSON.stringify(digit)}`);
  const [low, high] = pair;
  const n = Math.round((SAMPLE_RATE * ms) / 1000);
  const pcm = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SAMPLE_RATE;
    const s = (Math.sin(2 * Math.PI * low * t) + Math.sin(2 * Math.PI * high * t)) / 2;
    pcm[i] = Math.max(-1, Math.min(1, s * amplitude)) * 32767;
  }
  return encodeMulaw(pcm);
}

/**
 * Synthesize a DTMF sequence (e.g. "1234#") with inter-digit silence gaps.
 * Mirrors the `pacedDtmf` intent from the legacy server: slow enough that IVRs
 * with slow input windows don't drop digits.
 */
export function dtmfSequence(digits: string, toneMs = 200, gapMs = 80): Buffer {
  const gap = Buffer.alloc(Math.round((SAMPLE_RATE * gapMs) / 1000), MULAW_SILENCE);
  const parts: Buffer[] = [];
  for (const d of digits) {
    if (d in DTMF_FREQS) {
      parts.push(dtmfTone(d, toneMs));
      parts.push(gap);
    }
  }
  return Buffer.concat(parts);
}

// --- DTMF detection (Goertzel) ---
// Used to verify synthesized tones in tests and to let the simulated turn
// source "hear" DTMF the orchestrator emits, with no real telephony.

function goertzelPower(pcm: Int16Array, freq: number): number {
  const k = Math.round((pcm.length * freq) / SAMPLE_RATE);
  const w = (2 * Math.PI * k) / pcm.length;
  const coeff = 2 * Math.cos(w);
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < pcm.length; i++) {
    const s0 = (pcm[i] ?? 0) + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return s1 * s1 + s2 * s2 - coeff * s1 * s2;
}

/** Detect which DTMF digit (if any) a mu-law buffer encodes. */
export function detectDtmf(mulaw: Buffer): string | null {
  if (mulaw.length < 80) return null;
  const pcm = decodeMulaw(mulaw);

  const strongest = (group: number[]) =>
    group
      .map((f) => ({ f, p: goertzelPower(pcm, f) }))
      .sort((a, b) => b.p - a.p)[0]!;

  const low = strongest(LOW_GROUP);
  const high = strongest(HIGH_GROUP);

  // Reject buffers that are basically silence / not two clean tones.
  const noiseFloor = pcm.length * 1e4;
  if (low.p < noiseFloor || high.p < noiseFloor) return null;

  for (const [digit, [l, h]] of Object.entries(DTMF_FREQS)) {
    if (l === low.f && h === high.f) return digit;
  }
  return null;
}
