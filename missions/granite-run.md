# Mission: The Granite Run

This is the benchmark for our v1 production scope: a fully automated,
end-to-end claim-status call against a Medicare-style self-service IVR.
You will complete it twice — first by hand, then with an agent. Same
inputs, same acceptance criteria, both times.

Fixture: `granite-run.json` — one synthetic provider and three WORK ITEMS
shaped exactly like the Casa AR workbench hands them to a biller (same
field names: workItemId, encounterId, claimNumber, patient, payer, drug
with J-code and units, dos, billed, classification, nextAction). The data
is fake; the schema is the production contract. When this agent moves to
Casa, the input shape does not change — only the data source does. Results
key back to `encounterId`, because in Casa every call outcome becomes an
ENCOUNTER-scoped note, never a patient-scoped one.

## Phase 1 — manual (week 1-2)

1. `npm run web`, dial Granite Medicare Part B.
2. Authenticate with the fixture's NPI, PTAN (multi-tap!), and TIN.
3. Pull status for all three work items IN ONE CALL (use the
   "another date of service" loop — redialing is a fail). The web UI's
   test-data panel shows each work item the way the Casa workbench would.
4. Write down, for each work item: status (finalized / denied / not_found)
   and reason code if any.
5. Check yourself against each work item's `expectedCallOutcome`. All three right,
   one call, zero hangups = phase 1 complete.

What you should notice: the readouts are free text. Your ears parsed them.
Phase 2 is teaching software to do the same thing.

## Phase 2 — agentic (weeks 5-8)

Create `src/my-agent.js` exporting:

```js
export async function runGraniteMission(fixture) {
  // dial granite-medicare (import the engine, or POST to the Call API),
  // authenticate with fixture.provider, loop fixture.workItems (use
  // wi.dosDtmf on the keypad), parse each readout, hang up.
  return fixture.workItems.map((wi) => ({
    encounterId: wi.encounterId,          // writeback key (Casa note target)
    dos: wi.dos,                          // ISO, echoed from the work item
    status: "finalized",                  // parsed from the readout
    reasonCode: null,                     // e.g. "CO-16" when denied
  }));
}
```

The moment that file exists, `npm test` stops skipping
`test/mission-granite.test.js` and grades you: results must match the
fixture's `expected` exactly, from one call.

Rules:
- One call per run. The test counts calls.
- No hardcoding the expected outputs (the test also runs a DOS your
  fixture has never seen and checks you report it as `not_found`).
- Statuses are parsed from readout TEXT. Keyword matching is fine for v1;
  that is genuinely how assisted-readout parsing starts.

Stretch goals (not graded): parse paid amount and check number from the
spoken-word amounts; survive `mishearRate > 0` with retries.

## Why this mission is the v1 product

A biller spends real minutes per claim doing exactly this run. On a line
with no human rep, full automation has zero warm-transfer ethics and zero
payer-rep friction — it is pure Layer 4. If your agent clears this mission
in the sandbox, the remaining production work is transport (real telephony
+ ASR), not logic.
