/**
 * StateTracker — pure transcript -> SemanticState classifier.
 *
 * Deterministic and fast: it runs on every partial transcript (many times per
 * turn) without touching the LLM. It answers "what is the IVR asking?" and "how
 * does it want to be answered?", never "what should we say?" (that's the
 * planner). Keeping this separate is what lets us classify on partials and plan
 * speculatively before the prompt even finishes.
 *
 * Replaces the brittle keyword cascade in the legacy getIVRResponse(): same
 * signals, but it yields a meaning + input mode instead of jumping straight to
 * an answer, so the planner can reason about goals and ordering.
 */

import type { SemanticState, InputMode } from "./types.ts";

type Rule = {
  id: string;
  re: RegExp;
  inputMode: InputMode;
  goalSignal?: string;
};

// Order matters: earlier rules win ties. More specific patterns go first.
// Readouts and confirmations are matched BEFORE menus so a prompt that merely
// mentions "claim status" as a menu option isn't mistaken for a claim result.
const RULES: readonly Rule[] = [
  { id: "fax_sent_confirmation", re: /fax.*(sent|confirm|success)|sent to fax|information.*fax/i, inputMode: "speech_preferred", goalSignal: "fax_confirmed" },
  // Readout = an actual claim RESULT, identified by outcome/amount cues — never
  // by the bare words "claim status" (that's a menu option, handled below).
  { id: "claim_readout", re: /finalized|denied as|paid amount|in process|was received|internal control number|allow .*\bdays\b|claim.*(approved|processed|adjudicat)/i, inputMode: "speech_preferred", goalSignal: "claim_status_received" },
  // Optional / dead-end prompts the bot must NOT act on. Survey first so a
  // "press star for survey" line is never treated as a menu choice.
  { id: "satisfaction_survey", re: /satisfaction survey|brief survey|quality survey|take (a|an|our) survey|complete a survey|stay on the line.*survey|survey.*after (the|this) call/i, inputMode: "speech_preferred" },
  // Wrong branch we may have landed in. Detecting these lets the planner steer
  // back to the main menu instead of looping (holiday closures, office hours).
  { id: "wrong_branch", re: /holiday (closure|closures|hours|schedule)|holiday.*closed|we are currently closed|office.*(is |are )?closed|office hours are/i, inputMode: "dtmf_capture" },
  // Gating prompt that is not itself the goal menu.
  { id: "florida_provider_prompt", re: /(calling )?from florida|florida provider|for florida|florida medicare/i, inputMode: "dtmf_capture" },
  { id: "fax_number_request", re: /fax.?(number|num|#)/i, inputMode: "dtmf_capture" },
  { id: "fax_delivery_option", re: /\bfax\b/i, inputMode: "speech_preferred" },
  { id: "provider_npi_request", re: /\bnpi\b|national provider|ten.?digit provider|10.?digit provider/i, inputMode: "dtmf_capture" },
  { id: "provider_ptan_request", re: /\bptan\b|\bp ?tan\b|p\.?t\.?a\.?n/i, inputMode: "dtmf_capture" },
  { id: "provider_tin_request", re: /tax.?id|tax identification|federal.?tax|9.?digit/i, inputMode: "dtmf_capture" },
  { id: "professional_prompt", re: /healthcare professional|medical professional|are you a provider/i, inputMode: "speech_preferred" },
  { id: "caller_name_request", re: /first and last name|say and spell|who (am|are) (i|we) (speaking|talking)|who is calling/i, inputMode: "speech_preferred" },
  { id: "company_name_request", re: /company.?name|practice.?name|organization.?name|calling from/i, inputMode: "speech_preferred" },
  { id: "member_id_request", re: /member.?(id|number)|subscriber.?(id|number)|customer.?(id|number)/i, inputMode: "dtmf_capture" },
  { id: "dob_request", re: /date of birth|birth.?date|d\.?o\.?b|\bborn\b/i, inputMode: "speech_preferred" },
  { id: "dos_request", re: /date of service/i, inputMode: "dtmf_capture" },
  { id: "coverage_type_menu", re: /type of (coverage|plan|benefit)|medical.*(pharmacy|vision)|pharmacy.*medical/i, inputMode: "speech_preferred" },
  { id: "confirmation_readback", re: /you (said|entered|provided|gave)|did you say|on file is|we have.*on file/i, inputMode: "speech_preferred" },
  { id: "confirmation_yes_no", re: /is (that|this) (correct|right)|correct\?|please confirm|press.?1.*(confirm|correct)|press 1 to confirm/i, inputMode: "speech_preferred" },
  // A menu listing selectable options. Matched as a generic "menu" so the
  // planner parses the options and chooses by GOAL — not by the first key heard.
  { id: "menu", re: /(general information|claim status|claims?|appeals?|reopenings?|eligibility|benefits|prior auth)\b.*\b(press|say|enter)\b|\b(press|say|enter)\b.*(general information|claim status|claims?|appeals?|reopenings?|eligibility|benefits|prior auth)/i, inputMode: "dtmf_capture" },
  { id: "service_menu", re: /for providers|main menu/i, inputMode: "speech_preferred" },
  // Informational general-info branch (no selectable claim option) — a likely
  // wrong turn; the planner treats it like a branch to escape.
  { id: "general_info", re: /general information/i, inputMode: "dtmf_capture" },
  { id: "opening_greeting", re: /how (may|can) (i|we) (help|assist)|what.*(can|may) (i|we) (do|help)/i, inputMode: "speech_preferred" },
];

/**
 * Collapse runs of spelled-out single letters into one token, so prompts/ASR
 * that say "member I D" or "N P I" match the same rules as "member ID" / "NPI".
 * Real STT is inconsistent about this; the IVR simulator always spells.
 */
function collapseSpelledLetters(t: string): string {
  return t.replace(/\b[a-z](?:[ .]+[a-z]\b)+/gi, (m) => m.replace(/[ .]/g, ""));
}

/**
 * Classify a transcript. `final` slightly boosts confidence (an endpointed
 * utterance is more trustworthy than a mid-stream partial).
 */
export function analyze(transcript: string, final = false): SemanticState {
  const raw = transcript ?? "";
  const t = collapseSpelledLetters(raw.toLowerCase().trim());

  for (const rule of RULES) {
    if (rule.re.test(t)) {
      // Longer matched transcripts are more reliable; finals get a bump.
      const lengthConf = Math.min(0.9, 0.45 + t.length / 200);
      return {
        promptMeaning: rule.id,
        inputMode: rule.inputMode,
        confidence: Math.min(0.99, lengthConf + (final ? 0.1 : 0)),
        goalSignal: rule.goalSignal ?? null,
        rawTranscript: raw,
      };
    }
  }

  return {
    promptMeaning: "unknown",
    inputMode: "speech_preferred",
    confidence: final ? 0.2 : 0.1,
    goalSignal: null,
    rawTranscript: raw,
  };
}
