# Mission: The Granite Run

This is the benchmark for our v1 production scope: a fully automated,
end-to-end claim-status call against a Medicare-style self-service IVR.
You will complete it twice — first by hand, then with an agent. Same
inputs, same acceptance criteria, both times.

Fixture: `granite-run.json`. Every field name is copied from the Casa
platform verbatim, so solving this in the sandbox ports 1:1 into Casa's
existing "Call Payer" flow:

| Sandbox fixture | Casa source of truth |
|---|---|
| `workItems[].id, encounterId, type, denialCode, billedAmount, status, priorityTier` | `WorkItem` model (prisma/schema.prisma); `type` values: DENIAL, NO_RESPONSE, UNDERPAYMENT, ... |
| `workItems[].encounter.{patientName, dos, drug, jCode, primaryPayer, claimNumber, totalBilled, daysInAR}` | `ArEncounter` model (flat fields, exact names; `dos` is "YYYY-MM-DD") |
| `provider.{npi, ptan, tin}` | practice-level settings (not on the encounter) |
| result `payerContact` | `PayerContactData` (payer-contact-modal.tsx): interactionId, repName, callOutcome, expectedResolutionDate, promisedPaymentAmount, notes, pushToWeinfuse |
| result delivery | `POST /api/ar/workbench/items/{workItemId}/notes` with `noteType: "payer_contact"`, metadata = PayerContactData (see handlePayerContact in the work-item page) |
| dialed phone number | `lookupPayerPhone(encounter.primaryPayer)` from src/lib/payer-phone-directory |

`callOutcome` must be one of Casa's CALL_OUTCOMES (listed in the fixture's
`writeback` block). `dosDtmf` is the only sandbox-only convenience field.
Results key to `encounterId` because in Casa every call outcome becomes an
ENCOUNTER-scoped note, never a patient-scoped one.

## Phase 1 — manual

1. `npm run web`, dial Granite Medicare Part B.
2. Authenticate with the fixture's NPI, PTAN (multi-tap!), and TIN.
3. Pull status for all three work items IN ONE CALL (use the
   "another date of service" loop — redialing is a fail). The web UI's
   test-data panel shows each work item the way the Casa workbench would.
4. Write down, for each work item: status (finalized / denied / not_found)
   and reason code if any. FOR DENIED CLAIMS, the status readout is not
   enough — press 4 for denial details and capture the remark codes (RARCs),
   the missing documentation, the ICN, and the redetermination window.
   The CARC (CO-16) is on the remit already; the detail layer is the reason
   the call exists.
5. Check yourself against each work item's `expectedCallOutcome`. All three right,
   one call, zero hangups = phase 1 complete.

What you should notice: the readouts are free text. Your ears parsed them.
Phase 2 is teaching software to do the same thing.

## Phase 2 — agentic

Create `src/my-agent.js` exporting:

```js
export async function runGraniteMission(fixture) {
  // dial granite-medicare (import the engine, or POST to the Call API),
  // authenticate with fixture.provider, loop fixture.workItems (use
  // wi.dosDtmf on the keypad), parse each readout, hang up.
  return fixture.workItems.map((wi) => ({
    workItemId: wi.id,
    encounterId: wi.encounterId,            // Casa notes are encounter-scoped
    parsed: { status: "finalized", reasonCode: null },  // from the readout
    payerContact: {                          // PayerContactData, 1:1 with Casa
      interactionId: "IVR-99011",            // call reference (check #, etc.)
      repName: "Granite IVR (automated)",
      callOutcome: "Paid - Pending",         // must be a Casa CALL_OUTCOMES value
      expectedResolutionDate: "",
      promisedPaymentAmount: "",
      notes: "<verbatim readout text>",      // evidence trail
      pushToWeinfuse: false,
    },
  }));
}
```

In production the same object becomes the body of Casa's payer_contact
note POST — the grading here checks the exact shape the modal submits.

The moment that file exists, `npm test` stops skipping
`test/mission-granite.test.js` and grades you: results must match the
fixture's `expected` exactly, from one call.

Rules:
- One call per run. (Honor system in the sandbox; production transport
  enforces it. Redialing per-claim defeats the entire economics.)
- No hardcoding the expected outputs (the test also runs a DOS your
  fixture has never seen and checks you report it as `not_found`).
- Statuses are parsed from readout TEXT. Keyword matching is fine for v1;
  that is genuinely how assisted-readout parsing starts.

For denied work items the grader also requires `parsed.icn`,
`parsed.remarkCodes`, and `parsed.appealDeadlineDays` — all of which only
exist in the denial-details readout (press 4). An agent that stops at the
status readout fails the denied claim.

ARCHITECTURE NOTE (read before reaching for an LLM): the realtime grader's
clock is deliberately too fast for a model call on every turn. That is not
an obstacle, it is the correct production shape: IVR NAVIGATION is a
deterministic state machine (prompt pattern -> keypress, milliseconds);
LLM-style parsing, if you want it, belongs AFTER the call, on the saved
transcript, where latency is free. Navigate live, parse offline.

Stretch goals (not graded): parse paid amount and check number from the
spoken-word amounts; parse `missingDocumentation` into structured form;
survive `mishearRate > 0` with retries.

## Phase 3 — realtime (the graduation pass)

Same mission, but through `RealtimeCall` (the virtual dialer): prompts
stream in chunks at speaking pace, `fullText` does not exist (assemble the
chunks), silence times out, and waiting politely for every prompt blows the
word budget. Export:

```js
export async function runGraniteMissionRealtime(fixture, createCall) {
  const call = createCall();   // the GRADER constructs the call: one per run, enforced
  // subscribe with call.onEvent, act on streamed chunks, barge in when you
  // already know the menu, never sit silent into a timeout.
  return results;              // same shape as phase 2
}
```

Graded automatically: one call (enforced), zero timeouts, at least 2
barge-ins, and `wordsHeard <= 400` (the listen-to-everything baseline is
486; the readouts you genuinely need are ~300 of them). The budget is the
point: an agent that waits for speech-end on every prompt is a chatbot
with a phone number.

## Why this mission is the v1 product

A biller spends real minutes per claim doing exactly this run. On a line
with no human rep, full automation has zero warm-transfer ethics and zero
payer-rep friction — it is pure Layer 4. If your agent clears this mission
in the sandbox, the remaining production work is transport (real telephony
+ ASR), not logic.
