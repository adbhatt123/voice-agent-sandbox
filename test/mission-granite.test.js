// The Granite Run — agentic grading. Skips until src/my-agent.js exists.
// See missions/granite-run.md for the mission spec.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const fixture = JSON.parse(readFileSync(new URL("../missions/granite-run.json", import.meta.url)));
const agentPath = new URL("../src/my-agent.js", import.meta.url);

test("mission: the Granite Run (one call, all claims, structured results)", async (t) => {
  if (!existsSync(fileURLToPath(agentPath))) {
    return t.skip("pending: create src/my-agent.js (see missions/granite-run.md)");
  }
  const { runGraniteMission } = await import(agentPath);
  assert.equal(typeof runGraniteMission, "function", "must export runGraniteMission");

  const results = await runGraniteMission(structuredClone(fixture));
  assert.ok(Array.isArray(results), "must return an array of results");

  const byDos = Object.fromEntries(results.map((r) => [r.dos, r]));
  for (const exp of fixture.expected) {
    const got = byDos[exp.dos];
    assert.ok(got, `missing result for DOS ${exp.dos}`);
    assert.equal(got.status, exp.status, `wrong status for DOS ${exp.dos}`);
    assert.equal(got.reasonCode ?? null, exp.reasonCode, `wrong reasonCode for DOS ${exp.dos}`);
  }
});

test("mission: no hardcoding — unseen DOS must come back not_found", async (t) => {
  if (!existsSync(fileURLToPath(agentPath))) {
    return t.skip("pending: create src/my-agent.js (see missions/granite-run.md)");
  }
  const { runGraniteMission } = await import(agentPath);
  const fx = structuredClone(fixture);
  fx.claims = [{ dos: "09092026" }];
  fx.expected = undefined;
  const results = await runGraniteMission(fx);
  assert.equal(results.length, 1);
  assert.equal(results[0].dos, "09092026");
  assert.equal(results[0].status, "not_found");
});
