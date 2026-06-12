// Agent Call API: drive a full Granite Medicare run over HTTP, like an
// external agent (any language) would.
import { test } from "node:test";
import assert from "node:assert/strict";
import { startServer } from "../src/server.js";

test("call API: end-to-end Granite run over HTTP with variant readouts", async (t) => {
  const server = await startServer(0);
  t.after(() => server.close());
  const base = `http://localhost:${server.address().port}`;
  const j = async (r) => { assert.ok(r.ok || r.status === 201, `${r.status}`); return r.json(); };
  const post = (p, body) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  const { trees } = await j(await fetch(base + "/api/trees"));
  const granite = trees.find((x) => x.id === "granite-medicare");
  assert.ok(granite?.endToEnd, "granite must be flagged endToEnd");

  const { callId, event: first } = await j(await post("/api/calls", { tree: "granite-medicare", seed: 7, mishearRate: 0 }));
  assert.equal(first.kind, "prompt");

  const input = async (type, value) => (await j(await post(`/api/calls/${callId}/input`, { type, value }))).event;
  await input("dtmf", "1");
  await input("dtmf", "1234567890#");
  await input("dtmf", "7w0w1w2222w3333w4444");
  await input("dtmf", "123456789");

  let ev = await input("dtmf", "06152026");
  assert.equal(ev.kind, "readout");
  assert.ok(ev.text.includes("finalized"));

  await input("dtmf", "1");
  ev = await input("dtmf", "07012026");
  assert.ok(ev.text.includes("denied"), "second DOS must read out the denied variant");
  assert.ok(ev.text.includes("C O dash one six"));

  await input("dtmf", "1");
  ev = await input("dtmf", "08012026");
  assert.ok(ev.text.includes("No claim on file"));

  ev = await input("dtmf", "3");
  assert.equal(ev.kind, "ended");

  const state = await j(await fetch(`${base}/api/calls/${callId}`));
  assert.equal(state.ended, true);
  assert.equal(state.captured.ptan, "P01234");
  assert.ok(state.transcript.includes("IVR"));
});

test("call API: rejects unknown tree and bad input", async (t) => {
  const server = await startServer(0);
  t.after(() => server.close());
  const base = `http://localhost:${server.address().port}`;
  const bad = await fetch(base + "/api/calls", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tree: "../etc/passwd" }) });
  assert.equal(bad.status, 400);
  const missing = await fetch(base + "/api/calls/00000000-0000-0000-0000-000000000000");
  assert.equal(missing.status, 404);
});
