import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Orchestrator } from "../src/orchestrator.ts";
import { SimulatedSource } from "../src/media/simulated-source.ts";
import { AudioCache } from "../src/tts/audio-cache.ts";
import { DeterministicPlanner } from "../src/planner-deterministic.ts";

const tree = JSON.parse(
  readFileSync(new URL("../src/trees/meridian-blue.json", import.meta.url), "utf8"),
);

// The real goal-driven planner — no per-test hardcoding of menu positions.
const planner = new DeterministicPlanner();

test("navigates meridian-blue to claim status by goals, offline", async () => {
  const source = new SimulatedSource(tree, { timeScale: 0.05, seed: 7 });

  const cache = new AudioCache();
  await cache.warm(async (t) => Buffer.from(t), ["Yes"]); // "yes" served from cache

  const orch = new Orchestrator({
    source,
    planner,
    cache,
    synth: async (t) => Buffer.from(`tts:${t}`),
    payerId: "+15550142",
    objective: "claim_status",
    payload: { memberId: "ABC1234567X", dos: "06152026" },
    requiredGoals: ["claim_status_received"],
    speculateThreshold: 0.7,
  });

  const runP = orch.run();
  source.start();
  const result = await runP;

  // The objective goal was reached without any payer-specific hardcoding.
  assert.ok(
    result.completedGoals.includes("claim_status_received"),
    `goal not reached; completed: ${result.completedGoals.join(",")}`,
  );

  // Every turn produced a latency trace with a plan source.
  const summary = result.latency.summary();
  assert.equal(summary.turns, result.turns);
  assert.ok(result.turns >= 5, `expected several turns, got ${result.turns}`);
  assert.equal(typeof summary.responseLatency.p50, "number");

  // Preemptive generation fired: long prompts cleared the speculate threshold,
  // so at least one turn committed a speculative response on endpoint.
  assert.ok(
    (summary.bySource["speculative-hit"] ?? 0) >= 1,
    `expected a speculative-hit; sources: ${JSON.stringify(summary.bySource)}`,
  );
});

test("speech->dtmf fallback engages when a confirm prompt repeats", async () => {
  // Meridian's member-id capture has confirm:true; the sim's confirm node only
  // accepts DTMF, so our preferred speech "yes" is rejected and the prompt
  // repeats — the orchestrator must switch to the DTMF fallback to proceed.
  const source = new SimulatedSource(tree, { timeScale: 0.05, seed: 7 });
  const cache = new AudioCache();
  const orch = new Orchestrator({
    source,
    planner,
    cache,
    synth: async (t) => Buffer.from(t),
    payerId: "+15550142",
    objective: "claim_status",
    payload: { memberId: "ABC1234567X", dos: "06152026" },
    requiredGoals: ["claim_status_received"],
  });
  const runP = orch.run();
  source.start();
  const result = await runP;
  // If the fallback had not engaged, the confirm would loop and the claim
  // readout would never be reached.
  assert.ok(result.completedGoals.includes("claim_status_received"));
});
