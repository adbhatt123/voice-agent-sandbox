import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { IVRCall, normalizeTokens, decodeMultitap } from "../src/ivr-engine.js";

const load = (n) => JSON.parse(readFileSync(new URL(`../src/trees/${n}.json`, import.meta.url)));

test("coral-health: DTMF happy path reaches rep through hold", async () => {
  const call = new IVRCall(load("coral-health"), { seed: 7, holdScale: 0.0001 });
  let ev = call.start();
  assert.equal(ev.kind, "prompt");
  ev = call.input({ type: "dtmf", value: "1" });
  assert.equal(ev.kind, "prompt");
  ev = call.input({ type: "dtmf", value: "555000123#" });
  assert.equal(ev.kind, "hold");
  ev = await call.waitForRep();
  assert.equal(ev.kind, "rep");
  assert.ok(call.holdTimeMs() > 0);
});

test("coral-health: eligibility readout includes captured member id", () => {
  const call = new IVRCall(load("coral-health"), { seed: 7 });
  call.start();
  call.input({ type: "dtmf", value: "2" });
  const ev = call.input({ type: "dtmf", value: "555000123#" });
  assert.equal(ev.kind, "readout");
  assert.ok(ev.text.includes("555000123"));
});

test("DTMF input is never corrupted", () => {
  const call = new IVRCall(load("coral-health"), { seed: 1, mishearRate: 1 });
  call.start();
  call.input({ type: "dtmf", value: "2" });
  const ev = call.input({ type: "dtmf", value: "987654321#" });
  assert.equal(ev.kind, "readout");
  assert.equal(ev.captured.memberId, "987654321#");
});

test("speech is corrupted at mishearRate=1: IVR hears a DIFFERENT value", () => {
  const call = new IVRCall(load("sundial-medicare"), { seed: 3, mishearRate: 1 });
  call.start();
  call.input({ type: "speech", value: "claims" });
  call.input({ type: "speech", value: "five five five five five five five five five five" });
  assert.notEqual(call.captured.npi, "5555555555");
});

test("retries exhaust to hangup", () => {
  const call = new IVRCall(load("coral-health"), { seed: 1 });
  call.start();
  call.input({ type: "dtmf", value: "8" });
  call.input({ type: "dtmf", value: "8" });
  const ev = call.input({ type: "dtmf", value: "8" });
  assert.equal(ev.kind, "ended");
});

test("meridian-blue: confirm loop accepts and re-enters", () => {
  const call = new IVRCall(load("meridian-blue"), { seed: 5, mishearRate: 0 });
  call.start();
  call.input({ type: "dtmf", value: "1" });
  call.input({ type: "dtmf", value: "1" });
  let ev = call.input({ type: "dtmf", value: "ABC1234567Z" });
  assert.equal(ev.kind, "confirm");
  ev = call.input({ type: "dtmf", value: "2" });
  assert.equal(ev.kind, "prompt");
  ev = call.input({ type: "dtmf", value: "XYZ7654321A" });
  assert.equal(ev.kind, "confirm");
  ev = call.input({ type: "dtmf", value: "1" });
  assert.equal(ev.kind, "prompt");
  assert.equal(ev.node, "dos");
});

test("meridian-blue: full path to automated status readout", () => {
  const call = new IVRCall(load("meridian-blue"), { seed: 5, mishearRate: 0 });
  call.start();
  call.input({ type: "dtmf", value: "1" });
  call.input({ type: "dtmf", value: "1" });
  call.input({ type: "dtmf", value: "ABC1234567Z" });
  call.input({ type: "dtmf", value: "1" });
  call.input({ type: "dtmf", value: "06152026" });
  const ev = call.input({ type: "dtmf", value: "1" });
  assert.equal(ev.kind, "readout");
  assert.ok(ev.text.includes("ABC1234567Z"));
  assert.ok(ev.text.includes("06152026"));
});

test("sundial: speech-only node rejects DTMF", () => {
  const call = new IVRCall(load("sundial-medicare"), { seed: 2, mishearRate: 0 });
  call.start();
  call.input({ type: "speech", value: "claims" });
  const ev = call.input({ type: "dtmf", value: "1234567890" });
  assert.equal(ev.kind, "reprompt");
  assert.ok(ev.text.toLowerCase().includes("spoken"));
});

test("sundial: paced single digits survive mishearing better than words", () => {
  const paced = new IVRCall(load("sundial-medicare"), { seed: 11, mishearRate: 0.5 });
  paced.start();
  paced.input({ type: "speech", value: "claims" });
  const ev = paced.input({ type: "speech", value: "two zero three zero four zero six zero eight zero" });
  assert.notEqual(ev.kind, "ended");
});

test("normalizeTokens handles NATO + word digits", () => {
  assert.equal(normalizeTokens("Alpha One Bravo Two"), "A1B2");
  assert.equal(normalizeTokens("zero six one five"), "0615");
  assert.equal(normalizeTokens("Z Z T 0 0 0 1 2 3 4 X"), "ZZT0001234X");
});

test("transcript captures both directions", () => {
  const call = new IVRCall(load("coral-health"), { seed: 1 });
  call.start();
  call.input({ type: "dtmf", value: "1" });
  const t = call.transcript();
  assert.ok(t.includes("IVR"));
  assert.ok(t.includes("YOU"));
});

test("decodeMultitap: letters, digits, invalid groups", () => {
  assert.equal(decodeMultitap("222"), "C");
  assert.equal(decodeMultitap("2222"), "2");
  assert.equal(decodeMultitap("7w0w1w2222w3333w4444"), "P01234");
  assert.equal(decodeMultitap("23"), null);
  assert.equal(decodeMultitap("22222"), null);
});

test("granite-medicare: fully automated end-to-end, two claims, zero reps", () => {
  const tree = load("granite-medicare");
  assert.ok(!Object.values(tree.nodes).some((n) => n.kind === "rep"), "tree must have no rep node");
  const call = new IVRCall(tree, { seed: 9, mishearRate: 0 });
  call.start();
  call.input({ type: "dtmf", value: "1" });
  call.input({ type: "dtmf", value: "1234567890#" });
  call.input({ type: "dtmf", value: "7w0w1w2222w3333w4444" });
  call.input({ type: "dtmf", value: "123456789" });
  let ev = call.input({ type: "dtmf", value: "06152026" });
  assert.equal(ev.kind, "readout");
  assert.ok(ev.followup, "readout must offer follow-up menu");
  assert.ok(ev.text.includes("06152026"));
  assert.equal(ev.captured.ptan, "P01234");
  ev = call.input({ type: "dtmf", value: "1" });
  assert.equal(ev.node, "dos");
  ev = call.input({ type: "dtmf", value: "07012026" });
  assert.equal(ev.kind, "readout");
  assert.ok(ev.text.includes("07012026"));
  ev = call.input({ type: "dtmf", value: "3" });
  assert.equal(ev.kind, "ended");
});

test("granite-medicare: malformed multitap PTAN gets a retry, then works", () => {
  const call = new IVRCall(load("granite-medicare"), { seed: 9, mishearRate: 0 });
  call.start();
  call.input({ type: "dtmf", value: "1" });
  call.input({ type: "dtmf", value: "1234567890#" });
  let ev = call.input({ type: "dtmf", value: "23w1" });
  assert.equal(ev.kind, "reprompt");
  ev = call.input({ type: "dtmf", value: "7w0w1w2222w3333w4444" });
  assert.equal(ev.node, "tin");
});

test("readout variants: outcome depends on captured DOS", () => {
  const tree = load("granite-medicare");
  const run = (dos) => {
    const c = new IVRCall(tree, { seed: 9, mishearRate: 0 });
    c.start();
    c.input({ type: "dtmf", value: "1" });
    c.input({ type: "dtmf", value: "1234567890#" });
    c.input({ type: "dtmf", value: "7w0w1w2222w3333w4444" });
    c.input({ type: "dtmf", value: "123456789" });
    return c.input({ type: "dtmf", value: dos }).text;
  };
  assert.ok(run("06152026").includes("finalized"));
  assert.ok(run("07012026").includes("denied"));
  assert.ok(run("12252026").includes("No claim on file"));
});

test("granite-medicare: denial-detail layer (press 4) carries RARCs + appeal window", () => {
  const tree = load("granite-medicare");
  const auth = (c) => {
    c.start();
    c.input({ type: "dtmf", value: "1" });
    c.input({ type: "dtmf", value: "1234567890#" });
    c.input({ type: "dtmf", value: "7w0w1w2222w3333w4444" });
    c.input({ type: "dtmf", value: "123456789" });
  };
  const c = new IVRCall(tree, { seed: 9, mishearRate: 0 });
  auth(c);
  let ev = c.input({ type: "dtmf", value: "07012026" });
  assert.ok(ev.text.includes("press 4"), "denied status must point at the detail layer");
  ev = c.input({ type: "dtmf", value: "4" });
  assert.equal(ev.kind, "readout");
  assert.ok(ev.text.includes("M one two seven"), "RARC M127 must be read out");
  assert.ok(ev.text.includes("N seven zero six"), "RARC N706 must be read out");
  assert.ok(ev.text.includes("one hundred twenty days"), "redetermination window must be read out");
  assert.ok(ev.text.includes("2026182000123"), "ICN must be read out");
  const c2 = new IVRCall(tree, { seed: 9, mishearRate: 0 });
  auth(c2);
  c2.input({ type: "dtmf", value: "06152026" });
  ev = c2.input({ type: "dtmf", value: "4" });
  assert.ok(ev.text.includes("no denial details"), "paid claims have no denial details");
});
