/**
 * DeterministicPlanner — goal- and state-driven planning, no keyword grabbing.
 *
 * The core fix for the Medicare navigation bug: every menu decision is made by
 * (1) parsing the menu's options, (2) scoring each option's LABEL against the
 * caller's goal, and (3) pressing the winning option's key. It never presses the
 * first digit it hears. Optional prompts (surveys) are ignored, and wrong-branch
 * loops (holiday closures / general information) are detected and escaped, or the
 * call is aborted once recovery clearly isn't working.
 *
 * Pure function of (state, ctx): the only "memory" it uses is ctx.recentMeanings
 * (committed turns), so it is safe to call speculatively on partials.
 */

import type { Planner, PlannerContext, PlannerDecision } from "./planner.ts";
import type { Action, SemanticState } from "./types.ts";
import { parseMenuOptions, type MenuOption } from "./menu-parser.ts";

const dtmf = (digits: string): Action => ({ type: "dtmf", digits });
const speech = (text: string): Action => ({ type: "speech", text });
const wait = (reason: string): Action => ({ type: "wait", reason });
const hangup = (reason: string): Action => ({ type: "hangup", reason });

/** Meanings that mean "we are in the wrong place." */
const BRANCH_MEANINGS = new Set(["wrong_branch", "general_info"]);
/** Abort once we've been in a wrong branch this many times (incl. current). */
const ABORT_AT = 3;

export class DeterministicPlanner implements Planner {
  plan(state: SemanticState, ctx: PlannerContext): PlannerDecision {
    const meaning = state.promptMeaning;

    if (meaning === "satisfaction_survey") {
      // Optional dead-end: do nothing, keep listening for the real prompt.
      return decide(wait("optional survey"), null, 0.95);
    }

    if (BRANCH_MEANINGS.has(meaning)) {
      return this.recoverOrAbort(state, ctx);
    }

    if (meaning === "florida_provider_prompt") {
      const opts = parseMenuOptions(state.rawTranscript);
      const fl = opts.find((o) => /florida/.test(o.label));
      return decide(dtmf(fl?.key ?? "1"), speech("yes"), 0.9);
    }

    if (meaning === "menu" || meaning === "service_menu") {
      return this.chooseFromMenu(state, ctx);
    }

    return this.fieldResponse(meaning, ctx);
  }

  /** Pick the menu option whose label best matches the goal; recover if none. */
  private chooseFromMenu(state: SemanticState, ctx: PlannerContext): PlannerDecision {
    const opts = parseMenuOptions(state.rawTranscript);
    if (opts.length === 0) return this.recoverOrAbort(state, ctx);

    const scored = opts
      .map((o) => ({ o, score: scoreOption(o, ctx.objective) }))
      .sort((a, b) => b.score - a.score);
    const best = scored[0]!;

    if (best.score <= 0) {
      // No option advances the goal — we're in the wrong menu (e.g. only
      // general information / eligibility offered). Treat as a wrong branch.
      return this.recoverOrAbort(state, ctx);
    }
    return decide(dtmf(best.o.key), speech(goalPhrase(ctx.objective)), 0.9);
  }

  /** Steer back to the main menu, or give up if we keep landing wrong. */
  private recoverOrAbort(state: SemanticState, ctx: PlannerContext): PlannerDecision {
    const branchCount =
      (BRANCH_MEANINGS.has(state.promptMeaning) ? 1 : 0) +
      ctx.recentMeanings.filter((m) => BRANCH_MEANINGS.has(m)).length;

    if (branchCount >= ABORT_AT) {
      return decide(
        hangup("stuck in wrong-branch / general-information loop"),
        null,
        0.6,
      );
    }

    // Prefer an explicit "return to main menu" option if the prompt offers one.
    const ret = parseMenuOptions(state.rawTranscript).find((o) =>
      /main menu|previous menu|return|go back|start over/.test(o.label),
    );
    // Otherwise fall back to the common Medicare escapes: star, then 8.
    return decide(dtmf(ret?.key ?? "*"), dtmf("8"), 0.5);
  }

  /** Capture / confirmation / informational prompts answered from the payload. */
  private fieldResponse(meaning: string, ctx: PlannerContext): PlannerDecision {
    const p = ctx.payload;
    switch (meaning) {
      case "provider_npi_request":
        return field(dtmf(p.npi ?? ""), speech(spell(p.npi)), p.npi);
      case "provider_ptan_request":
        return field(dtmf(p.ptan ?? ""), null, p.ptan);
      case "provider_tin_request":
        return field(dtmf(p.taxId ?? ""), speech(spell(p.taxId)), p.taxId);
      case "member_id_request":
        // Member IDs are often alphanumeric — speak first, keypad as fallback.
        return field(speech(p.memberId ?? ""), dtmf(p.memberId ?? ""), p.memberId);
      case "dos_request":
        return field(dtmf(p.dos ?? ""), speech(p.dos ?? ""), p.dos);
      case "dob_request":
        return field(speech(p.dateOfBirth ?? ""), null, p.dateOfBirth);
      case "caller_name_request":
        return field(speech(p.callerNameSpoken ?? ""), null, p.callerNameSpoken);
      case "company_name_request":
        return field(speech(p.companyNameSpoken ?? ""), null, p.companyNameSpoken);
      case "coverage_type_menu":
        return field(speech(p.coverageType ?? "medical"), null, p.coverageType ?? "medical");
      case "professional_prompt":
        return decide(speech("yes"), dtmf("1"), 0.9);
      case "confirmation_yes_no":
      case "confirmation_readback":
        return decide(speech("yes"), dtmf("1"), 0.9);
      case "fax_number_request":
        return field(dtmf(p.faxNumber ?? ""), null, p.faxNumber);
      case "fax_delivery_option":
        return decide(speech("fax"), dtmf("1"), 0.7);
      case "opening_greeting":
        return decide(speech(goalPhrase(ctx.objective)), null, 0.8);
      case "claim_readout":
        return decide(wait("claim status received"), null, 0.9, "claim_status_received");
      case "fax_sent_confirmation":
        return decide(wait("fax confirmed"), null, 0.9, "fax_confirmed");
      default:
        // Unknown prompt: don't guess a keypress. Stay silent and listen.
        return decide(wait(`unhandled meaning: ${meaning}`), null, 0.3);
    }
  }
}

function decide(
  preferred: Action,
  fallback: Action | null,
  confidence: number,
  goalCompleted: string | null = null,
): PlannerDecision {
  return { preferred, fallback, source: "memory", goalCompleted, confidence };
}

/** Build a field decision; if the value is missing, wait rather than send junk. */
function field(preferred: Action, fallback: Action | null, value: string | undefined): PlannerDecision {
  if (!value) return decide(wait("missing payload field"), null, 0.3);
  return decide(preferred, fallback, 0.9);
}

/** Spell digits for the speech fallback, e.g. "1234" -> "1 2 3 4". */
function spell(value: string | undefined): string {
  return (value ?? "").split("").join(" ");
}

function goalPhrase(objective: string): string {
  switch (objective) {
    case "eligibility":
      return "eligibility";
    case "request_fax":
    case "claim_status":
    default:
      return "claim status";
  }
}

/**
 * Score a menu option's label for how well it advances the objective.
 * Positive = pursue, negative = avoid, the largest wins. Tuned for claim-status
 * goals on Medicare-style menus (general information vs claim status / appeals).
 */
function scoreOption(opt: MenuOption, objective: string): number {
  const l = opt.label;

  // Hard avoids regardless of goal.
  if (/survey|holiday|closure|closed|espanol|spanish/.test(l)) return -1000;

  if (objective === "eligibility") {
    if (/eligibility|benefits|coverage/.test(l)) return 60;
    if (/general information|member|subscriber/.test(l)) return -100;
    return 0;
  }

  // Default: claim-status / fax objectives.
  if (/general information|general info/.test(l)) return -100;
  if (/member|subscriber|patient|beneficiary/.test(l)) return -50;
  if (/credential/.test(l)) return -40;
  if (/eligibility|benefits/.test(l)) return -30;
  if (/prior auth|authorization|precert/.test(l)) return -20;

  let s = 0;
  if (/claim/.test(l)) s += 40;
  if (/status/.test(l)) s += 30;
  if (/appeal|reopening|redetermination/.test(l)) s += 20;
  if (/provider/.test(l)) s += 15; // helps at a provider-vs-member fork
  if (/representative|agent|operator/.test(l)) s -= 5; // prefer automated path
  return s;
}
