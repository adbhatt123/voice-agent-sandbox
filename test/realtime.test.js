// Virtual-dialer mode: time, silence, and barge-in are real here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { RealtimeCall } from "../src/realtime.js";
import { startServer } from "../src/server.js";

const load = (n) => JSON.parse(readFileSync(new URL(`../src/trees/${n}.json`, import.meta.url)));
const FAST = { timeScale: 0.004, seed: 9, mishearRate: 0, debug: true };
const STRICT = { timeScale: 0.004, seed: 9, mishearRate: 0 };

function recorder(rc) {
  const evs = [];
  rc.onEvent((e) => evs.push(e));
  return evs;
}
function waitFor(rc, kind, pred = () => true, ms = 8000) {
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`timed out waiting for ${kind}`)), ms);
    const off = rc.onEvent((e) => { if (e.kind === kind && pred(e)) { clearTimeout(t); off(); res(e); } });
  });
}

test("realtime: prompts arrive as paced chunks, not atomically", async () => {
  const rc = new RealtimeCall(load("granite-medicare"), FAST);
  const evs = recorder(rc);
  rc.start();
  await waitFor(rc, "speech-end");
  const chunks = evs.filter((e) => e.kind === "speech-chunk");
  assert.ok(chunks.length >= 3, `greeting+menu should stream in several chunks, got ${chunks.length}`);
  const spread = evs.at(-1).at - evs[0].at;
  assert.ok(spread > 5, "chunks must be spread over time, not instantaneous");
  rc.hangup();
});

test("realtime: silence is punished — reprompt, then hangup", async () => {
  const rc = new RealtimeCall(load("granite-medicare"), FAST);
  rc.start();
  await waitFor(rc, "speech-end");
  // say nothing, ever
  await waitFor(rc, "timeout");
  const rePrompt = await waitFor(rc, "speech-end", (e) => e.sourceKind === "reprompt");
  assert.ok(rePrompt.fullText.toLowerCase().includes("are you still there"));
  const ended = await waitFor(rc, "ended", () => true, 15000);
  assert.ok(ended, "persistent silence must end the call");
});

test("realtime: barge-in cuts the prompt short, input still lands", async () => {
  const rc = new RealtimeCall(load("granite-medicare"), FAST);
  const evs = recorder(rc);
  rc.start();
  await waitFor(rc, "speech-chunk");           // IVR is mid-greeting
  rc.sendInput({ type: "dtmf", value: "1" });  // cut through
  assert.ok(evs.some((e) => e.kind === "barge-in"), "barge-in event must fire");
  const next = await waitFor(rc, "speech-end");
  assert.equal(next.node, "npi", "barged-in input must still route the menu");
  rc.hangup();
});

test("realtime: full Granite happy path driven by events", async () => {
  const rc = new RealtimeCall(load("granite-medicare"), FAST);
  rc.start();
  const answers = { root: "1", npi: "1234567890#", ptan: "7w0w1w2222w3333w4444", tin: "123456789", dos: "06152026" };
  rc.onEvent((e) => {
    if (e.kind !== "speech-end") return;
    if (e.sourceKind === "readout") return rc.sendInput({ type: "dtmf", value: "3" });
    const a = answers[e.node];
    if (a) rc.sendInput({ type: "dtmf", value: a });
  });
  const readout = await waitFor(rc, "speech-end", (e) => e.sourceKind === "readout");
  assert.ok(readout.fullText.includes("finalized"));
  assert.ok(readout.fullText.includes("2026166000456"), "ICN must be in the streamed readout");
  await waitFor(rc, "ended");
});

test("realtime: hold trees reach the warm-transfer point", async () => {
  const rc = new RealtimeCall(load("coral-health"), { ...FAST, holdScale: 0.0001 });
  rc.start();
  rc.onEvent((e) => {
    if (e.kind !== "speech-end") return;
    if (e.node === "root") rc.sendInput({ type: "dtmf", value: "1" });
    if (e.node === "claims-id") rc.sendInput({ type: "dtmf", value: "555000123#" });
  });
  const endedP = waitFor(rc, "ended");
  const rep = await waitFor(rc, "rep");
  assert.ok(rep.text.length > 0);
  await endedP;
});

test("realtime over SSE: stream replays history and delivers live events", async (t) => {
  const server = await startServer(0);
  t.after(() => server.close());
  const base = `http://localhost:${server.address().port}`;
  const created = await (await fetch(base + "/api/rt/calls", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ tree: "granite-medicare", ...FAST }),
  })).json();
  assert.ok(created.callId);

  const resp = await fetch(base + created.stream);
  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let buf = "", kinds = [];
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    for (const line of buf.split("\n\n").slice(0, -1)) {
      const m = line.match(/^data: (.*)$/m);
      if (m) kinds.push(JSON.parse(m[1]).kind);
    }
    buf = buf.split("\n\n").at(-1);
    if (kinds.includes("speech-end") && !kinds.includes("__sent__")) {
      kinds.push("__sent__");
      await fetch(`${base}/api/rt/calls/${created.callId}/input`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "dtmf", value: "1" }),
      });
    }
    if (kinds.filter((k) => k === "speech-end").length >= 2) break;
  }
  assert.ok(kinds.includes("call-started"));
  assert.ok(kinds.includes("speech-chunk"));
  assert.ok(kinds.filter((k) => k === "speech-end").length >= 2, "stream must deliver the post-input prompt too");
  await fetch(`${base}/api/rt/calls/${created.callId}/hangup`, { method: "POST" });
});

test("realtime: fullText is withheld by default — chunks are the only source", async () => {
  const rc = new RealtimeCall(load("granite-medicare"), STRICT);
  const evs = recorder(rc);
  rc.start();
  const end = await waitFor(rc, "speech-end");
  assert.equal(end.fullText, undefined, "no fullText without debug: assemble the chunks");
  const assembled = evs.filter((e) => e.kind === "speech-chunk").map((e) => e.text).join(" ");
  assert.ok(assembled.includes("claim status"), "chunks must reconstruct the prompt");
  rc.hangup();
});

test("realtime: stats reward barge-in (fewer words heard)", async () => {
  const run = async (bargeIn) => {
    const rc = new RealtimeCall(load("granite-medicare"), STRICT);
    rc.start();
    if (bargeIn) {
      await waitFor(rc, "speech-chunk");
      rc.sendInput({ type: "dtmf", value: "1" });
    } else {
      await waitFor(rc, "speech-end");
      rc.sendInput({ type: "dtmf", value: "1" });
    }
    await waitFor(rc, "speech-end", (e) => e.node === "npi");
    const s = rc.stats();
    rc.hangup();
    return s;
  };
  const patient = await run(false);
  const eager = await run(true);
  assert.ok(eager.wordsHeard < patient.wordsHeard, "barging in must reduce words heard");
  assert.equal(eager.bargeIns, 1);
});

test("realtime: synchronous barge-in from inside a chunk listener cannot stall the call", async () => {
  const rc = new RealtimeCall(load("granite-medicare"), STRICT);
  const evs = recorder(rc);
  // barge in the instant we see each prompt's identifying chunk (re-entrant)
  rc.onEvent((e) => {
    if (e.kind !== "speech-chunk") return;
    if (/press 1 or/.test(e.text)) rc.sendInput({ type: "dtmf", value: "1" });
    else if (/provider N P/.test(e.text)) rc.sendInput({ type: "dtmf", value: "1234567890#" });
  });
  rc.start();
  const end = await waitFor(rc, "speech-end", (e) => e.node === "ptan");
  assert.ok(end, "must reach the PTAN prompt cleanly");
  const nodes = evs.filter((e) => e.kind === "speech-end").map((e) => e.node);
  assert.ok(!nodes.includes("root") && !nodes.includes("npi"), "barged-in prompts must NOT emit stale speech-ends");
  rc.hangup();
});
