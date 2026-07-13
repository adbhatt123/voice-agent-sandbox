import { test } from "node:test";
import assert from "node:assert/strict";
import { LatencyTracker } from "../src/telemetry/latency.ts";

/** A controllable clock so derived latencies are exact. */
function fakeClock() {
  let t = 0;
  return { now: () => t, set: (v: number) => (t = v) };
}

test("derives stage latencies from stamps", () => {
  const clk = fakeClock();
  const lt = new LatencyTracker(clk.now);

  clk.set(0);
  lt.startTurn("t1"); // ivrSpeechStart = 0
  clk.set(100);
  lt.mark("t1", "firstPartial");
  clk.set(900);
  lt.mark("t1", "endpoint");
  lt.mark("t1", "finalTranscript");
  clk.set(905);
  lt.mark("t1", "planStart");
  clk.set(965);
  lt.mark("t1", "planResolved");
  lt.setPlanSource("t1", "llm");
  clk.set(966);
  lt.mark("t1", "ttsRequest");
  clk.set(1086);
  lt.mark("t1", "firstAudioByte");
  clk.set(1090);
  lt.mark("t1", "firstFrameToTwilio");
  clk.set(1500);
  lt.mark("t1", "playbackComplete");

  const m = lt.metrics("t1")!;
  assert.equal(m.sttLag, 100);
  assert.equal(m.endpointLag, 800);
  assert.equal(m.planTime, 60);
  assert.equal(m.ttsTtfb, 120);
  assert.equal(m.outboundNetwork, 4);
  assert.equal(m.responseLatency, 190); // endpoint(900) -> firstFrameToTwilio(1090)
  assert.equal(m.totalTurn, 1500);
  assert.equal(m.planSource, "llm");
});

test("first stamp wins; duplicate signals ignored", () => {
  const clk = fakeClock();
  const lt = new LatencyTracker(clk.now);
  clk.set(0);
  lt.startTurn("t1");
  clk.set(50);
  lt.mark("t1", "endpoint");
  clk.set(70);
  lt.mark("t1", "endpoint"); // ignored
  assert.equal(lt.get("t1")!.stamps.endpoint, 50);
});

test("missing stamps yield undefined metrics, not NaN", () => {
  const lt = new LatencyTracker(() => 0);
  lt.startTurn("t1");
  const m = lt.metrics("t1")!;
  assert.equal(m.ttsTtfb, undefined);
  assert.equal(m.responseLatency, undefined);
});

test("summary aggregates count and plan-source mix", () => {
  const clk = fakeClock();
  const lt = new LatencyTracker(clk.now);
  for (const [id, src, t] of [
    ["a", "cache", 10],
    ["b", "llm", 200],
    ["c", "speculative-hit", 5],
  ] as const) {
    clk.set(0);
    lt.startTurn(id);
    lt.mark(id, "endpoint", 0);
    lt.mark(id, "firstFrameToTwilio", t);
    lt.setPlanSource(id, src);
  }
  const s = lt.summary();
  assert.equal(s.turns, 3);
  assert.equal(s.bySource["cache"], 1);
  assert.equal(s.bySource["llm"], 1);
  assert.equal(s.bySource["speculative-hit"], 1);
  assert.equal(typeof s.responseLatency.p50, "number");
});
