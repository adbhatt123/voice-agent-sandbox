// @ts-check
/**
 * Skeleton agent for Granite Medicare IVR navigation.
 *
 * Run:  node src/my-agent.js
 *
 * Execution model:
 *   IVRCall is turn-based and synchronous — every call.input() returns the
 *   next event immediately. The loop below is the entire engine: receive an
 *   event, decide what to send, send it, repeat. No async, no streaming, no
 *   timers (holdScale handles that).
 *
 * To implement navigation, fill in the decide() function below.
 */

import { readFileSync } from "node:fs";
import { IVRCall } from "./ivr-engine.js";

// ---------------------------------------------------------------------------
// 1. Load the payer tree
//    The tree is the IVR's entire script: every node, prompt, and branch.
//    This is what you're navigating — read it to understand what the IVR
//    will ask and which inputs it accepts.
// ---------------------------------------------------------------------------

const tree = JSON.parse(
  readFileSync(new URL("./trees/granite-medicare.json", import.meta.url))
);

// ---------------------------------------------------------------------------
// 2. Instantiate the call
//
//    seed        — deterministic RNG; same seed → same mishearing every run.
//                  Change it to test different mishear patterns.
//    mishearRate — set to 0 while building; raise later to test resilience.
//    holdScale   — multiplier on hold timers. 0.01 = 1% of real hold time,
//                  so a 2-minute hold becomes 1.2 seconds in development.
// ---------------------------------------------------------------------------

const call = new IVRCall(tree, {
  seed: 1,
  mishearRate: 0,   // no speech corruption yet
  holdScale: 0.01,  // fast holds during development
});

// ---------------------------------------------------------------------------
// 3. Logging helpers
//    Every event the IVR emits and every input the agent sends is printed.
//    Direction: "IVR ←" for what you receive, "AGENT →" for what you send.
// ---------------------------------------------------------------------------

/**
 * @param {"IVR" | "AGENT"} who
 * @param {{ kind?: string, type?: string, text?: string, value?: string, node?: string }} item
 */
function logEvent(who, item) {
  const arrow  = who === "IVR" ? "←" : "→";
  const kind   = item.kind ?? item.type ?? "?";
  const text   = item.text ?? item.value ?? "";
  const where  = item.node ? ` [node: ${item.node}]` : "";
  console.log(`[${who} ${arrow}] (${kind})${where} "${text}"`);
}

/** Convenience: build a DTMF input object. */
function dtmf(value) {
  return { type: /** @type {"dtmf"} */ ("dtmf"), value: String(value) };
}

/**
 * Convenience: build a speech input object.
 * Prefer DTMF when the node accepts it — speech goes through the mishear filter.
 */
function speech(text) {
  return { type: /** @type {"speech"} */ ("speech"), value: text };
}

// ---------------------------------------------------------------------------
// 4. Decision function — THIS IS WHERE YOUR LOGIC LIVES.
//
//    Called once per event. Receives the full event object, must return an
//    input object.
//
//    What you have to work with:
//      ev.kind  — "prompt" | "reprompt" | "confirm" | "readout" (with followup)
//      ev.text  — the exact text the IVR just spoke
//      ev.node  — the nodeId in the tree (matches a key in tree.nodes)
//
//    What you return:
//      dtmf("1")            — press a key
//      dtmf("1234567890#")  — enter a digit string (# terminates capture)
//      dtmf("7w0w...")      — multitap encoding for PTAN letters
//      speech("claim status") — say a phrase (goes through mishear filter)
//
//    Decision approaches (pick one or combine):
//      A) Match on ev.node   — exact, brittle if tree changes
//      B) Match on ev.text   — keyword/substring search, more robust
//      C) Match on ev.kind   — handle "reprompt" generically (retry last input)
//
//    The tree reference above shows every node name and prompt text.
//    Read it to know exactly what ev.text will say at each step.
// ---------------------------------------------------------------------------

/**
 * @param {{ kind: string, text: string, node: string | null, [key: string]: unknown }} ev
 * @returns {{ type: "dtmf" | "speech", value: string }}
 */
function decide(ev) {
  // TODO: inspect ev.kind, ev.text, and/or ev.node, then return an input.
  //
  // Starter examples (remove these and replace with real logic):
  //
  //   if (ev.node === "root")  return dtmf("1");           // press 1 for claim status
  //   if (ev.node === "npi")   return dtmf("1234567890#"); // 10-digit NPI + pound
  //   if (ev.node === "ptan")  return dtmf("7w...");       // multitap-encoded PTAN
  //   if (ev.node === "tin")   return dtmf("123456789");   // 9-digit TIN
  //   if (ev.node === "dos")   return dtmf("06152026");    // 8-digit date MMDDYYYY
  //
  // Reprompts mean the IVR rejected your last input. Handle them explicitly
  // or fall through to your normal logic — the node is the same as before.
  //
  //   if (ev.kind === "reprompt") { /* retry or adjust */ }
  //
  // Confirm nodes ask you to press 1 to confirm or 2 to re-enter:
  //
  //   if (ev.kind === "confirm") return dtmf("1");
  //
  // After a readout with a followup menu, the event kind is "readout"
  // and ev.followup contains the next prompt text. The node has already
  // advanced to the followup menu — decide what to press there.

  throw new Error(
    `decide() not implemented for (${ev.kind}) at node "${ev.node}": "${ev.text}"`
  );
}

// ---------------------------------------------------------------------------
// 5. Main event loop
//
//    IVRCall is synchronous and turn-based:
//      call.start()      → fires the greeting + root prompt, returns first event
//      call.input(inp)   → sends your response, returns the next event
//      call.isEnded()    → true once the IVR hangs up or transfers
//
//    Terminal event kinds that end the loop:
//      "ended"   — IVR hung up (max retries, hangup node, or readout with no followup)
//      "rep"     — warm transfer; a representative answered (hold trees only)
//      "readout" — without ev.followup; the IVR read out the result and is done
//                  (Granite ends with readout → "again" menu, so followup is set here)
//
//    Recoverable event kinds that need a response:
//      "prompt"    — standard menu or capture prompt
//      "reprompt"  — IVR didn't accept the last input; same node, try again
//      "confirm"   — IVR is reading back what it heard; press 1 or 2
//      "readout"   — with ev.followup; status was read, a menu follows
// ---------------------------------------------------------------------------

console.log(`\n=== Granite Medicare agent starting ===`);
console.log(`Tree: ${tree.payer}`);
console.log(`Nodes: ${Object.keys(tree.nodes).join(", ")}\n`);

// Start the call — returns the first event (greeting has already been logged
// internally; ev.text is the root menu prompt).
let ev = call.start();
logEvent("IVR", ev);

while (!call.isEnded()) {
  // Terminal: IVR ended the call or transferred to a rep — nothing to send.
  if (ev.kind === "ended") {
    console.log("\n=== IVR ended the call ===");
    break;
  }

  if (ev.kind === "rep") {
    console.log("\n=== Warm transfer: rep answered ===");
    console.log(`Hold duration: ${call.holdTimeMs()}ms`);
    break;
  }

  // Terminal readout — no followup menu, call is logically done.
  if (ev.kind === "readout" && !ev.followup) {
    console.log("\n=== Readout complete, call ending ===");
    break;
  }

  // Hold: the IVR put you on hold. waitForRep() resolves when the rep picks
  // up (the hold timer fires internally). Nothing to send during hold.
  if (ev.kind === "hold") {
    console.log(`\n[AGENT] On hold for ~${ev.resolveAfterMs}ms (scaled)...`);
    ev = await call.waitForRep();
    logEvent("IVR", ev);
    continue;
  }

  // All other events (prompt, reprompt, confirm, readout-with-followup)
  // require a response from decide().
  const inp = decide(ev);
  logEvent("AGENT", { kind: inp.type, text: inp.value, node: ev.node });

  ev = call.input(inp);
  logEvent("IVR", ev);
}

// ---------------------------------------------------------------------------
// 6. Post-call inspection
//    call.captured holds every value the IVR accepted — the raw outputs of
//    your navigation. This is what a real agent would parse for claim results.
// ---------------------------------------------------------------------------

console.log("\n--- captured values ---");
console.log(call.captured);

console.log("\n--- full transcript ---");
console.log(call.transcript());
