// The Granite Run — agentic grading. Skips until src/my-agent.js exists.
// Fixture is Casa-workbench shaped (see missions/granite-run.json "schema").
// See missions/granite-run.md for the mission spec.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const fixture = JSON.parse(readFileSync(new URL("../missions/granite-run.json", import.meta.url)));
const agentPath = new URL("../src/my-agent.js", import.meta.url);

test("mission: the Granite Run (one call, all work items, Casa-shaped results)", async (t) => {
  if (!existsSync(fileURLToPath(agentPath))) {
    return t.skip("pending: create src/my-agent.js (see missions/granite-run.md)");
  }
  const { runGraniteMission } = await import(agentPath);
  assert.equal(typeof runGraniteMission, "function", "must export runGraniteMission");

  const results = await runGraniteMission(structuredClone(fixture));
  assert.ok(Array.isArray(results), "must return an array of results");

  const byEnc = Object.fromEntries(results.map((r) => [r.encounterId, r]));
  for (const wi of fixture.workItems) {
    const got = byEnc[wi.encounterId];
    assert.ok(got, `missing result for encounter ${wi.encounterId} (results must be keyed back to the encounter, like a Casa writeback)`);
    assert.equal(got.dos, wi.dos, `dos must echo the work item's ISO date for ${wi.encounterId}`);
    assert.equal(got.status, wi.expectedCallOutcome.status, `wrong status for claim ${wi.claimNumber}`);
    assert.equal(got.reasonCode ?? null, wi.expectedCallOutcome.reasonCode, `wrong reasonCode for claim ${wi.claimNumber}`);
  }
});

test("mission: no hardcoding — unseen DOS must come back not_found", async (t) => {
  if (!existsSync(fileURLToPath(agentPath))) {
    return t.skip("pending: create src/my-agent.js (see missions/granite-run.md)");
  }
  const { runGraniteMission } = await import(agentPath);
  const fx = structuredClone(fixture);
  fx.workItems = [{
    workItemId: "wi_fake_gr999",
    encounterId: "cmfake99granite0909zzzz99",
    claimNumber: "889999",
    patient: { name: "B. Okonkwo", dobMasked: "**/**/1971" },
    payer: { name: "Granite Medicare Part B (FICTIONAL)", planType: "Medicare B" },
    drug: { name: "Vedolizumab", jCode: "J3380", units: 300 },
    dos: "2026-09-09",
    dosDtmf: "09092026",
    billed: 9640.0,
    classification: "no_response",
    nextAction: "payer_call_status",
  }];
  const results = await runGraniteMission(fx);
  assert.equal(results.length, 1);
  assert.equal(results[0].encounterId, "cmfake99granite0909zzzz99");
  assert.equal(results[0].status, "not_found");
});
