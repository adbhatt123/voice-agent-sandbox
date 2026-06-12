// The Granite Run — agentic grading. Skips until src/my-agent.js exists.
// Fixture and result contract mirror the Casa platform 1:1 (see the fixture's
// "schema" field). Results are graded as if they were about to be POSTed to
// the Call Payer flow's payer_contact note endpoint.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const fixture = JSON.parse(readFileSync(new URL("../missions/granite-run.json", import.meta.url)));
const CALL_OUTCOMES = fixture.writeback.CALL_OUTCOMES;
const agentPath = new URL("../src/my-agent.js", import.meta.url);

function gradeResult(got, wi) {
  assert.ok(got, `missing result for work item ${wi.id}`);
  assert.equal(got.encounterId, wi.encounterId, `result must key back to the encounter (Casa notes are encounter-scoped)`);
  assert.equal(got.parsed?.status, wi.expectedCallOutcome.status, `wrong parsed.status for claim ${wi.encounter.claimNumber}`);
  assert.equal(got.parsed?.reasonCode ?? null, wi.expectedCallOutcome.reasonCode, `wrong parsed.reasonCode for claim ${wi.encounter.claimNumber}`);
  const pc = got.payerContact;
  assert.ok(pc, `result must include payerContact (PayerContactData shape, ready for the notes endpoint)`);
  assert.ok(CALL_OUTCOMES.includes(pc.callOutcome), `payerContact.callOutcome "${pc.callOutcome}" must be one of CALL_OUTCOMES`);
  assert.equal(pc.callOutcome, wi.expectedCallOutcome.callOutcome, `wrong callOutcome mapping for claim ${wi.encounter.claimNumber}`);
  assert.ok(typeof pc.notes === "string" && pc.notes.length > 0, `payerContact.notes must carry the readout evidence`);
  assert.ok(typeof pc.interactionId === "string" && pc.interactionId.length > 0, `payerContact.interactionId required (use a call reference)`);
  if (wi.expectedCallOutcome.icn) {
    assert.equal(got.parsed?.icn, wi.expectedCallOutcome.icn, `wrong/missing ICN for claim ${wi.encounter.claimNumber} (it is read out; capture it)`);
  }
  if (wi.expectedCallOutcome.remarkCodes) {
    assert.deepEqual([...(got.parsed?.remarkCodes ?? [])].sort(), [...wi.expectedCallOutcome.remarkCodes].sort(),
      `denied claims require the remark codes from the denial-details readout (press 4). The CARC alone is not why we call.`);
    assert.equal(got.parsed?.appealDeadlineDays, wi.expectedCallOutcome.appealDeadlineDays, `capture the redetermination window`);
  }
}

test("mission: the Granite Run (one call, Casa-shaped writeback per work item)", async (t) => {
  if (!existsSync(fileURLToPath(agentPath))) {
    return t.skip("pending: create src/my-agent.js (see missions/granite-run.md)");
  }
  const { runGraniteMission } = await import(agentPath);
  assert.equal(typeof runGraniteMission, "function", "must export runGraniteMission");

  const results = await runGraniteMission(structuredClone(fixture));
  assert.ok(Array.isArray(results), "must return an array of results");
  const byWi = Object.fromEntries(results.map((r) => [r.workItemId, r]));
  for (const wi of fixture.workItems) gradeResult(byWi[wi.id], wi);
});

test("mission: no hardcoding — unseen DOS must come back not_found / Other", async (t) => {
  if (!existsSync(fileURLToPath(agentPath))) {
    return t.skip("pending: create src/my-agent.js (see missions/granite-run.md)");
  }
  const { runGraniteMission } = await import(agentPath);
  const fx = structuredClone(fixture);
  fx.workItems = [{
    id: "wi_fake_gr999",
    encounterId: "cmfake99granite0909zzzz99",
    type: "NO_RESPONSE",
    denialCode: null,
    billedAmount: 9640.0,
    status: "new",
    priorityTier: "standard",
    encounter: {
      id: "cmfake99granite0909zzzz99",
      patientName: "B. Okonkwo",
      dos: "2026-09-09",
      drug: "Vedolizumab",
      jCode: "J3380",
      primaryPayer: "Granite Medicare Part B (FICTIONAL)",
      claimNumber: "889999",
      totalBilled: 9640.0,
      daysInAR: 41,
    },
    dosDtmf: "09092026",
    expectedCallOutcome: { status: "not_found", reasonCode: null, callOutcome: "Other" },
  }];
  const results = await runGraniteMission(fx);
  assert.equal(results.length, 1);
  gradeResult(results[0], fx.workItems[0]);
});

// ---- Phase 3: the same mission, but time is real (virtual dialer) ----
// Skips until src/my-agent.js exports runGraniteMissionRealtime(fixture, createCall).
// The TEST owns call creation, so one-call-per-run and word-budget are
// enforced, not honor system. fullText is off: chunks are all you get.
import { RealtimeCall } from "../src/realtime.js";

const WORD_BUDGET = 400; // listen-everything baseline is 486; readouts alone are ~300.
                         // Staying under budget requires barge-in on navigation
                         // prompts while still hearing readouts in full.

test("mission: Granite Run in REALTIME (streaming, barge-in, word budget)", async (t) => {
  if (!existsSync(fileURLToPath(agentPath))) {
    return t.skip("pending: create src/my-agent.js (see missions/granite-run.md)");
  }
  const mod = await import(agentPath);
  if (typeof mod.runGraniteMissionRealtime !== "function") {
    return t.skip("pending: export runGraniteMissionRealtime(fixture, createCall) for phase 3");
  }
  const tree = JSON.parse(readFileSync(new URL("../src/trees/granite-medicare.json", import.meta.url)));
  const made = [];
  const createCall = () => {
    const rc = new RealtimeCall(tree, { timeScale: 0.004, seed: 9, mishearRate: 0 });
    made.push(rc);
    return rc;
  };
  const results = await mod.runGraniteMissionRealtime(structuredClone(fixture), createCall);

  assert.equal(made.length, 1, "ONE call per run — enforced here, not honor system");
  const stats = made[0].stats();
  assert.equal(stats.timeouts, 0, "a streaming agent never sits silent into a timeout");
  assert.ok(stats.wordsHeard <= WORD_BUDGET,
    `heard ${stats.wordsHeard} words; budget is ${WORD_BUDGET}. Waiting for every prompt to finish is a chatbot habit — barge in once you know the menu.`);
  assert.ok(stats.bargeIns >= 2, "the budget is only reachable with real barge-ins");

  const byWi = Object.fromEntries(results.map((r) => [r.workItemId, r]));
  for (const wi of fixture.workItems) gradeResult(byWi[wi.id], wi);
});
