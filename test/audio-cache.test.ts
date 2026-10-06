import { test } from "node:test";
import assert from "node:assert/strict";
import { AudioCache } from "../src/tts/audio-cache.ts";
import { detectDtmf } from "../src/media/audio.ts";

const fakeSynth = async (text: string): Promise<Buffer> =>
  Buffer.from(`mulaw:${text.toLowerCase()}`);

test("warm pre-renders phrases and serves them case/space-insensitively", async () => {
  const cache = new AudioCache();
  const n = await cache.warm(fakeSynth, ["Yes", "Healthcare professional"]);
  assert.equal(n, 2);
  assert.ok(cache.hasSpeech("yes"));
  assert.ok(cache.hasSpeech("  YES "));
  assert.deepEqual(cache.getSpeech("Healthcare Professional"), Buffer.from("mulaw:healthcare professional"));
});

test("missing phrase returns undefined (caller falls back to live TTS)", () => {
  const cache = new AudioCache();
  assert.equal(cache.getSpeech("not warmed"), undefined);
});

test("a failing synth for one phrase does not abort the warm", async () => {
  const cache = new AudioCache();
  const flaky = async (t: string): Promise<Buffer> => {
    if (t === "No") throw new Error("tts down");
    return Buffer.from(t);
  };
  const n = await cache.warm(flaky, ["Yes", "No"]);
  assert.equal(n, 1);
  assert.ok(cache.hasSpeech("yes"));
  assert.ok(!cache.hasSpeech("no"));
});

test("getDtmf produces detectable tone audio and memoizes single digits", () => {
  const cache = new AudioCache();
  const a = cache.getDtmf("5");
  const b = cache.getDtmf("5");
  assert.equal(a, b, "single digit should be memoized (same buffer)");
  assert.equal(detectDtmf(a), "5");
  assert.equal(cache.size().dtmf, 1);
});
