import { test } from "node:test";
import assert from "node:assert/strict";
import { analyze } from "../src/state-tracker.ts";
import { DeterministicPlanner } from "../src/planner-deterministic.ts";
import type { PlannerContext } from "../src/planner.ts";

const planner = new DeterministicPlanner();

function ctx(overrides: Partial<PlannerContext> = {}): PlannerContext {
  return {
    payerId: "+15550199",
    objective: "claim_status",
    payload: {},
    completedGoals: new Set(),
    isRetry: false,
    recentMeanings: [],
    ...overrides,
  };
}

// --- 1. Survey prompt -> no action ---

test("optional satisfaction survey is ignored (wait, never presses star)", () => {
  const state = analyze("Press star for satisfaction survey.", true);
  assert.equal(state.promptMeaning, "satisfaction_survey");

  const d = planner.plan(state, ctx());
  assert.equal(d.preferred.type, "wait");
  // Crucially NOT a keypress on the survey's star.
  assert.notEqual(d.preferred.type, "dtmf");
});

// --- 2. Main Medicare menu -> press 2 (claim status, not general info) ---

test("main menu chooses claim status over general information", () => {
  const state = analyze(
    "General information, press 1. Claim status, appeal, or reopening, press 2.",
    true,
  );
  assert.equal(state.promptMeaning, "menu");

  const d = planner.plan(state, ctx());
  assert.equal(d.preferred.type, "dtmf");
  assert.equal(d.preferred.type === "dtmf" && d.preferred.digits, "2");
});

test("claim status / appeal / reopening submenu -> press 2", () => {
  const state = analyze(
    "For general inquiries press 1. For claim status, appeal, or reopening, press 2. For eligibility press 3.",
    true,
  );
  const d = planner.plan(state, ctx());
  assert.equal(d.preferred.type === "dtmf" && d.preferred.digits, "2");
});

test("digit follows the LABEL, not the position: claim status on 3 -> press 3", () => {
  // If the payer puts claim status on a different key, we must follow the label.
  const state = analyze(
    "General information press 1. Eligibility press 2. Claim status press 3.",
    true,
  );
  const d = planner.plan(state, ctx());
  assert.equal(d.preferred.type === "dtmf" && d.preferred.digits, "3");
});

test("never selects general information for a claim-status goal", () => {
  const state = analyze("For general information press 1. For claims press 2.", true);
  const d = planner.plan(state, ctx());
  assert.ok(d.preferred.type === "dtmf" && d.preferred.digits !== "1");
});

// --- Florida gating prompt ---

test("Florida provider prompt -> press 1", () => {
  const state = analyze(
    "If you are calling from Florida, press 1. For all other states, press 2.",
    true,
  );
  assert.equal(state.promptMeaning, "florida_provider_prompt");
  const d = planner.plan(state, ctx());
  assert.equal(d.preferred.type === "dtmf" && d.preferred.digits, "1");
});

// --- 3. Holiday closure / wrong-branch loop -> recover or abort ---

test("holiday closure branch recovers via the offered main-menu key", () => {
  const state = analyze(
    "You have reached holiday closures. To return to the main menu, press 8.",
    true,
  );
  assert.equal(state.promptMeaning, "wrong_branch");

  const d = planner.plan(state, ctx({ recentMeanings: [] }));
  assert.equal(d.preferred.type === "dtmf" && d.preferred.digits, "8");
});

test("wrong branch with no offered escape falls back to star", () => {
  const state = analyze("We are currently closed for the holiday. Goodbye.", true);
  assert.equal(state.promptMeaning, "wrong_branch");

  const d = planner.plan(state, ctx());
  assert.equal(d.preferred.type === "dtmf" && d.preferred.digits, "*");
  assert.equal(d.fallback?.type === "dtmf" && d.fallback.digits, "8");
});

test("repeated wrong branch / general-info loop aborts the call", () => {
  const state = analyze("Holiday closures continue. Press 8 to return.", true);
  // We've already bounced through the wrong branch repeatedly.
  const d = planner.plan(
    state,
    ctx({ recentMeanings: ["general_info", "wrong_branch", "general_info"] }),
  );
  assert.equal(d.preferred.type, "hangup");
});

test("a general-info menu offering no claim option is treated as a wrong branch", () => {
  // Lands in general info; the only options are unrelated -> recover, don't loop.
  const state = analyze(
    "General information. For office hours press 1. For mailing address press 2.",
    true,
  );
  const d = planner.plan(state, ctx());
  assert.ok(
    d.preferred.type === "dtmf" || d.preferred.type === "hangup",
    "should recover or abort, not select an unrelated option",
  );
  // Must not have selected one of the unrelated general-info options.
  if (d.preferred.type === "dtmf") {
    assert.ok(["*", "8"].includes(d.preferred.digits));
  }
});
