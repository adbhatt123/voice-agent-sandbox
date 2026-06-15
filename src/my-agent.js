// @ts-check
/**
 * Granite Medicare navigation agent.
 *
 * Run standalone:  node src/my-agent.js
 * Called by tests: import { runGraniteMission, runGraniteMissionRealtime } from "./my-agent.js"
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { IVRCall } from "./ivr-engine.js";
import { maskId } from "./phi-logger.js";

const tree = JSON.parse(
  readFileSync(new URL("./trees/granite-medicare.json", import.meta.url))
);

// ---------------------------------------------------------------------------
// Low-level helpers
// ---------------------------------------------------------------------------

/**
 * @param {"IVR" | "AGENT"} who
 * @param {{ kind?: string, type?: string, text?: string, value?: string, node?: string }} item
 */
function logEvent(who, item) {
  const arrow = who === "IVR" ? "←" : "→";
  const kind  = item.kind ?? item.type ?? "?";
  const raw   = item.text ?? item.value ?? "";
  // Mask credential values the agent sends; IVR text is what the IVR said (not our secret).
  const text  = who === "AGENT" ? maskId(raw) : raw.slice(0, 140);
  const where = item.node ? ` [node: ${item.node}]` : "";
  console.log(`[${who} ${arrow}] (${kind})${where} "${text}"`);
}

/** @returns {{ type: "dtmf", value: string }} */
function dtmf(value) {
  return { type: /** @type {"dtmf"} */ ("dtmf"), value: String(value) };
}

// ---------------------------------------------------------------------------
// PTAN multi-tap encoder  ("P01234" → "7w0w1w2222w3333w4444")
// ---------------------------------------------------------------------------

/** @param {string} ptan */
function encodePtan(ptan) {
  const LETTERS = { "2":"ABC","3":"DEF","4":"GHI","5":"JKL","6":"MNO","7":"PQRS","8":"TUV","9":"WXYZ" };
  /** @type {Record<string,string>} */
  const map = { "0":"0", "1":"1" };
  for (const [key, letters] of Object.entries(LETTERS)) {
    for (let i = 0; i < letters.length; i++) map[letters[i]] = key.repeat(i + 1);
    map[key] = key.repeat(letters.length + 1); // the digit itself on a lettered key
  }
  return ptan.toUpperCase().split("").map((/** @type {string} */ ch) => {
    if (!map[ch]) throw new Error(`Cannot encode PTAN character: ${ch}`);
    return map[ch];
  }).join("w");
}

// ---------------------------------------------------------------------------
// Readout parsers
// ---------------------------------------------------------------------------

/** "one two seven" → "127" */
function spokenDigitsToStr(/** @type {string} */ text) {
  /** @type {Record<string,string>} */
  const D = { zero:"0",oh:"0",one:"1",two:"2",three:"3",four:"4",five:"5",six:"6",seven:"7",eight:"8",nine:"9" };
  return text.trim().split(/\s+/).map((w) => D[w.toLowerCase()] ?? "").join("");
}

/** "one hundred twenty" → 120 */
function parseWordNumber(/** @type {string} */ text) {
  /** @type {Record<string,number>} */
  const ONES = { zero:0,oh:0,one:1,two:2,three:3,four:4,five:5,six:6,seven:7,eight:8,nine:9,ten:10,eleven:11,twelve:12,thirteen:13,fourteen:14,fifteen:15,sixteen:16,seventeen:17,eighteen:18,nineteen:19 };
  /** @type {Record<string,number>} */
  const TENS = { twenty:20,thirty:30,forty:40,fifty:50,sixty:60,seventy:70,eighty:80,ninety:90 };
  let total = 0, current = 0;
  for (const w of text.trim().toLowerCase().split(/\s+/)) {
    if (w === "hundred") current *= 100;
    else if (w === "thousand") { total += current * 1000; current = 0; }
    else if (TENS[w] !== undefined) current += TENS[w];
    else if (ONES[w] !== undefined) current += ONES[w];
  }
  return total + current;
}

/**
 * Parse the status readout text into a Casa-shaped result.
 * @param {string} text  raw IVR readout ("One claim on file..." or "No claim on file...")
 * @param {any} wi    current work item from fixture
 * @param {string[]} CALL_OUTCOMES  valid callOutcome values from fixture.writeback
 * @returns {any}
 */
function parseStatusReadout(text, wi, CALL_OUTCOMES) {
  const t = text.toLowerCase();
  let status, callOutcome, /** @type {string|null} */ reasonCode = null, /** @type {string|null} */ icn = null;

  if (t.includes("no claim on file")) {
    status = "not_found"; callOutcome = "Other";
  } else if (t.includes("claim status: finalized")) {
    status = "finalized"; callOutcome = "Paid - Pending";
  } else if (t.includes("claim status: denied")) {
    status = "denied"; callOutcome = "Denied";
  } else {
    status = "not_found"; callOutcome = "Other";
  }

  const icnMatch = text.match(/internal control number (\d+)/i);
  if (icnMatch) icn = icnMatch[1];

  // "Reason code: C O dash one six" → "CO-16"
  const rcMatch = text.match(/reason code[:\s]+([A-Z])\s+([A-Z])\s+dash\s+([\w\s]+?)(?=[,.]|$)/i);
  if (rcMatch) {
    const prefix = rcMatch[1].toUpperCase() + rcMatch[2].toUpperCase();
    const numStr = spokenDigitsToStr(rcMatch[3].trim());
    if (numStr) reasonCode = `${prefix}-${numStr}`;
  }

  return {
    workItemId: wi.id,
    encounterId: wi.encounterId,
    parsed: { status, reasonCode, icn },
    payerContact: {
      callOutcome,
      notes: text,
      interactionId: `granite-${wi.id}-${Date.now()}`,
    },
  };
}

/**
 * Parse a denial-detail readout and augment the pending result in-place.
 * "Remark code M one two seven" → "M127"; "within one hundred twenty days" → 120
 * @param {string} text
 * @param {any} result  pending result object (mutated)
 */
function parseDenialDetail(text, result) {
  const remarkRe = /remark code ([A-Z])\s+((?:(?:zero|one|two|three|four|five|six|seven|eight|nine|oh)\s*)+)/gi;
  const remarkCodes = [];
  for (const m of text.matchAll(remarkRe)) {
    const digits = spokenDigitsToStr(m[2]);
    if (digits) remarkCodes.push(`${m[1].toUpperCase()}${digits}`);
  }
  if (remarkCodes.length > 0) result.parsed.remarkCodes = remarkCodes;

  const appealMatch = text.match(/within\s+([\w\s]+?)\s+days/i);
  if (appealMatch) result.parsed.appealDeadlineDays = parseWordNumber(appealMatch[1]);

  result.payerContact.notes += "\n" + text;
}

// ---------------------------------------------------------------------------
// Phase 2 — turn-based IVRCall
// ---------------------------------------------------------------------------

/**
 * @param {any} fixture  missions/granite-run.json
 * @returns {Promise<any[]>}
 */
export async function runGraniteMission(fixture) {
  const { provider, workItems, writeback } = fixture;
  const CALL_OUTCOMES = writeback.CALL_OUTCOMES;

  const call = new IVRCall(tree, { seed: 1, mishearRate: 0, holdScale: 0.01 });

  /** @type {any[]} */ const results = [];
  let wiIdx = 0;
  /** @type {any} */ let pendingResult = null;
  let awaitDenial = false;

  function navigate(/** @type {any} */ ev) {
    const node = ev.node;
    if (node === "root")  return dtmf("1");
    if (node === "npi")   return dtmf(provider.npi + "#");
    if (node === "ptan")  return dtmf(encodePtan(provider.ptan));
    if (node === "tin")   return dtmf(provider.tin);
    if (node === "dos")   return dtmf(workItems[wiIdx].dosDtmf);
    if (node === "again") {
      if (awaitDenial)                   { awaitDenial = false; return dtmf("4"); }
      if (wiIdx + 1 < workItems.length)  { wiIdx++;             return dtmf("1"); }
      return dtmf("3");
    }
    throw new Error(`navigate: unhandled node "${node}" (${ev.kind})`);
  }

  console.log(`\n=== Granite Medicare agent (turn-based) — ${workItems.length} work item(s) ===`);

  let ev = /** @type {any} */ (call.start());
  logEvent("IVR", ev);

  while (!call.isEnded()) {
    if (ev.kind === "ended" || ev.kind === "rep") break;

    if (ev.kind === "readout") {
      const wi = workItems[wiIdx];
      if (/^denial details/i.test(ev.text)) {
        parseDenialDetail(ev.text, pendingResult);
        results.push(pendingResult);
        pendingResult = null;
      } else {
        pendingResult = parseStatusReadout(ev.text, wi, CALL_OUTCOMES);
        // Press 4 only when the IVR itself says remark codes are available
        if (pendingResult.parsed.status === "denied" && /press 4/i.test(ev.text)) {
          awaitDenial = true;
        } else {
          results.push(pendingResult);
          pendingResult = null;
        }
      }
      logEvent("IVR", { kind: "readout", text: ev.text, node: ev.node });
      if (!ev.followup) break;
      // ev.node is already "again" — fall through to navigate
    }

    const inp = navigate(ev);
    logEvent("AGENT", { kind: inp.type, text: inp.value });
    ev = call.input(inp);
    logEvent("IVR", ev);
  }

  console.log(`\n--- results (${results.length}) ---`);
  for (const r of /** @type {any[]} */ (results)) {
    console.log(JSON.stringify({ workItemId: r.workItemId, status: r.parsed.status, callOutcome: r.payerContact.callOutcome }));
  }

  return results;
}

// ---------------------------------------------------------------------------
// Phase 3 — RealtimeCall (streaming + barge-in)
// ---------------------------------------------------------------------------

/**
 * Navigate Granite Medicare using the realtime (streaming) API.
 *
 * Chunk strategy:
 *   Navigation prompts  → barge-in as soon as matchNavigation() fires on partial buffer
 *   Readout sessions    → accumulate chunks; barge-in the moment "for another date"
 *                         appears (again-menu has started, status text is complete)
 *
 * @param {any}      fixture     missions/granite-run.json
 * @param {function} createCall  () => RealtimeCall  (factory provided by test)
 * @returns {Promise<any[]>}
 */
export async function runGraniteMissionRealtime(fixture, createCall) {
  const { provider, workItems, writeback } = fixture;
  const CALL_OUTCOMES = writeback.CALL_OUTCOMES;
  const rc = createCall(); // test enforces made.length === 1

  return new Promise((resolve, reject) => {
    let buffer     = "";    // accumulated speech-chunk text for the current utterance
    let sourceKind = "";    // sourceKind from speech-start (not on speech-chunk)
    let responded  = false; // true after barge-in so speech-end doesn't double-fire

    /** @type {any[]} */ const results = [];
    let wiIdx = 0;
    /** @type {any} */ let pendingResult = null;
    let awaitDenial = false;

    /** Match a navigation prompt from partial or full buffer text. */
    function matchNavigation(/** @type {string} */ text) {
      const t = text.toLowerCase();
      if (t.includes("claim status"))       return dtmf("1");
      if (t.includes("n p i"))              return dtmf(provider.npi + "#");
      if (t.includes("p tan"))              return dtmf(encodePtan(provider.ptan));
      if (t.includes("tax identification")) return dtmf(provider.tin);
      if (t.includes("date of service") && t.includes("month")) return dtmf(workItems[wiIdx].dosDtmf);
      return null;
    }

    /**
     * Parse a completed readout buffer and return the DTMF for the "again" menu.
     * Called either on barge-in (partial buffer up to "for another date") or on speech-end.
     */
    function handleReadout(/** @type {string} */ statusText) {
      const wi = workItems[wiIdx];
      if (/^denial details/i.test(statusText)) {
        parseDenialDetail(statusText, pendingResult);
        results.push(pendingResult);
        pendingResult = null;
      } else {
        pendingResult = parseStatusReadout(statusText, wi, CALL_OUTCOMES);
        if (pendingResult.parsed.status === "denied" && /press 4/i.test(statusText)) {
          awaitDenial = true;
        } else {
          results.push(pendingResult);
          pendingResult = null;
        }
      }
      if (awaitDenial)                   { awaitDenial = false; return dtmf("4"); }
      if (wiIdx + 1 < workItems.length)  { wiIdx++;             return dtmf("1"); }
      return dtmf("3");
    }

    rc.onEvent((/** @type {any} */ ev) => {
      try {
        if (ev.kind === "speech-start") {
          buffer     = "";
          sourceKind = ev.sourceKind;
          responded  = false;
          return;
        }

        if (ev.kind === "speech-chunk") {
          buffer += (buffer ? " " : "") + ev.text;

          if (responded) return; // already sent for this utterance

          if (sourceKind === "readout") {
            // Barge-in the instant the "again" menu starts — status text is complete.
            const againIdx = buffer.toLowerCase().indexOf("for another date");
            if (againIdx >= 0) {
              const statusText = buffer.slice(0, againIdx).trim();
              const inp = handleReadout(statusText);
              responded = true;
              buffer    = "";
              rc.sendInput(inp);
            }
          } else {
            const inp = matchNavigation(buffer);
            if (inp) {
              responded = true;
              buffer    = "";
              rc.sendInput(inp);
            }
          }
          return;
        }

        if (ev.kind === "speech-end") {
          if (responded) {
            buffer    = "";
            responded = false;
            return;
          }
          // Fallback: barge-in fired late or not at all (very short prompts)
          if (sourceKind === "readout") {
            const t        = buffer.toLowerCase();
            const againIdx = t.indexOf("for another date");
            const statusText = againIdx >= 0 ? buffer.slice(0, againIdx).trim() : buffer;
            const inp = handleReadout(statusText);
            buffer = "";
            rc.sendInput(inp);
          } else {
            const inp = matchNavigation(buffer);
            buffer = "";
            if (inp) rc.sendInput(inp);
          }
          return;
        }

        if (ev.kind === "ended" || ev.kind === "rep") {
          resolve(results);
        }
      } catch (err) {
        reject(err);
      }
    });

    console.log(`\n=== Granite Medicare agent (realtime) — ${workItems.length} work item(s) ===`);
    rc.start();
  });
}

// ---------------------------------------------------------------------------
// CLI entry point — only runs when executed directly, not on import
// ---------------------------------------------------------------------------

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const fixture = JSON.parse(
    readFileSync(new URL("../missions/granite-run.json", import.meta.url), "utf-8")
  );
  runGraniteMission(fixture).catch(console.error);
}
