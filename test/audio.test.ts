import { test } from "node:test";
import assert from "node:assert/strict";
import {
  pcm16ToMulaw,
  mulawToPcm16,
  encodeMulaw,
  decodeMulaw,
  frameMulaw,
  dtmfTone,
  dtmfSequence,
  detectDtmf,
  FRAME_BYTES,
  MULAW_SILENCE,
} from "../src/media/audio.ts";

test("mu-law round-trips within quantization tolerance", () => {
  // mu-law is 8-bit lossy; error grows with amplitude but stays bounded.
  let maxRelErr = 0;
  for (let s = -32000; s <= 32000; s += 250) {
    const back = mulawToPcm16(pcm16ToMulaw(s));
    const err = Math.abs(back - s);
    const rel = err / (Math.abs(s) + 256);
    maxRelErr = Math.max(maxRelErr, rel);
  }
  assert.ok(maxRelErr < 0.2, `max relative error ${maxRelErr} too high`);
});

test("PCM 0 encodes to mu-law silence", () => {
  assert.equal(pcm16ToMulaw(0), MULAW_SILENCE);
});

test("encode/decode buffers preserve length", () => {
  const pcm = Int16Array.from([0, 100, -100, 5000, -5000, 32000, -32000]);
  const enc = encodeMulaw(pcm);
  assert.equal(enc.length, pcm.length);
  assert.equal(decodeMulaw(enc).length, pcm.length);
});

test("framing pads the final frame to full length with silence", () => {
  const buf = Buffer.alloc(FRAME_BYTES + 40, 0x00);
  const frames = frameMulaw(buf);
  assert.equal(frames.length, 2);
  assert.equal(frames[0]!.length, FRAME_BYTES);
  assert.equal(frames[1]!.length, FRAME_BYTES);
  // tail padding is silence
  assert.equal(frames[1]![FRAME_BYTES - 1], MULAW_SILENCE);
});

test("synthesized DTMF tones are detected back as the right digit", () => {
  for (const d of "0123456789*#") {
    const tone = dtmfTone(d, 120);
    assert.equal(detectDtmf(tone), d, `digit ${d} not recovered`);
  }
});

test("silence is not detected as a DTMF digit", () => {
  assert.equal(detectDtmf(Buffer.alloc(160, MULAW_SILENCE)), null);
});

test("dtmfSequence concatenates tones for each digit", () => {
  const seq = dtmfSequence("19#", 120, 40);
  // 3 tones * 120ms + 3 gaps * 40ms = 480ms @ 8kHz = 3840 bytes
  assert.equal(seq.length, Math.round(8000 * 0.48));
});

test("dtmfTone rejects non-DTMF characters", () => {
  assert.throws(() => dtmfTone("A"));
});
