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
