# Voice Agent Sandbox

A self-contained testing environment for the payer-call automation project
(see "Payer Call Automation: Implementation Brief"). Zero dependencies, zero
PHI, zero real phone calls. Runs anywhere with Node 18+.

```bash
npm test            # run all sandbox tests
npm run call        # interactive: YOU are the agent, navigate a fake payer IVR
npm run demo        # watch the example agent navigate a tree programmatically
```

## Setup (step by step)

Prerequisites: Node 18 or newer (`node --version` to check; install from
nodejs.org if needed) and git. Nothing else — the sandbox has zero npm
dependencies, so there is no `npm install` step.

1. Get the repo link from Adarsh. The sandbox lives in its own standalone
   repository (you do not need, and will not get, access to the Casa
   platform codebase).

2. Clone it:

   ```bash
   git clone https://github.com/adbhatt123/voice-agent-sandbox.git voice-agent-sandbox
   cd voice-agent-sandbox
   ```

3. Verify your environment. Expected: 15 pass, 0 fail, 11 skipped (the
   skips are the phonetic library — your deliverable):

   ```bash
   npm test
   ```

4. Smoke-test the simulator:

   ```bash
   npm run demo    # watch the example agent reach a rep
   npm run call    # now you try, by hand
   ```

5. Develop on a branch in this repo (or copy the folder into your existing
   voiceAgent repo if you prefer — everything is relative paths, it works
   from any location). Push your phonetic library and agent work as PRs so
   Adarsh can review.

6. Updates to the simulator (new trees, engine fixes) arrive as commits to
   main: `git pull origin main` and rebase your branch.

Day one goal: reach a live "rep" on all three payers using only `npm run
call`. If you can't beat the tree by hand, your agent won't either.

## Why a sandbox

You cannot develop IVR navigation against real payers: calls cost biller
goodwill, trees punish errors with hangups, and every test would push real
PHI through systems we haven't vetted. So the sandbox inverts it: a
configurable fake payer that behaves like the real ones (deep menus, retries,
mishearing your speech, long holds), driven by synthetic data only.

The design rule, from the brief, that this sandbox enforces mechanically:
**the bot does the waiting, the human does the judgment.** The simulator ends
at "rep answered." There is intentionally no simulated rep conversation: the
moment a rep answers, your job is warm transfer, not chat.

## What is provided vs. what you build

PROVIDED (the environment):

| Piece | File | What it does |
|---|---|---|
| IVR engine | `src/ivr-engine.js` | Generic state machine that plays any tree config: menus, data capture, confirmation loops, hold, rep, readout, hangup |
| Fictional payer trees | `src/trees/*.json` | 3 fake payers of increasing difficulty (see below). Trees are DATA, matching Layer 1 of the brief |
| Mishearing model | built into engine | Spoken digits/letters get corrupted with seeded randomness. DTMF never does. You will rediscover the brief's "prefer DTMF" rule yourself within an hour |
| PHI-style logger | `src/phi-logger.js` | Masking logger + `scanForLeaks()`. Even synthetic IDs must be masked in logs; the habit is the point |
| Interactive CLI | `src/cli.js` | Play the IVR by hand to learn a tree before automating it (this is your Week 1-2 "shadow the phone tree" exercise, minus the phone) |
| Example agent | `src/agent-example.js` | A deliberately naive agent showing the engine API. It fails on harder trees; that's your starting line |

YOU BUILD (the deliverables, per the brief):

| Deliverable | Where | Definition of done |
|---|---|---|
| Phonetic/dialing library (Layer 2) | implement `src/phonetic.js` | All tests in `test/phonetic.test.js` pass (they currently skip as "pending"). Pure functions, no I/O |
| Navigation agent (Layer 1) | your code, imports the engine | Reaches `rep` or `readout` on all 3 trees, including mishearing recovery and the confirmation loop, with zero leaked identifiers in its logs |
| Hold/transfer logic (Layer 3) | your code | Detects `hold` state, "bridges" (callback) the instant `rep` fires; measure synthetic biller-seconds saved |

## The three fictional payers

All payer names, phone numbers, member IDs, and patients are FICTIONAL.
Never put real PHI in this sandbox, including in test fixtures.

1. `coral-health.json` — shallow tree, DTMF-only, forgiving retries. Start here.
2. `meridian-blue.json` — deeper tree, requires member ID + date of service
   capture, has a confirmation read-back loop ("press 1 to confirm"), punishes
   two bad entries with a hangup.
3. `sundial-medicare.json` — speech-required nodes (DTMF rejected on some
   prompts, so mishearing is unavoidable: your phonetic pacing matters),
   random hold before rep, and an IVR status readout branch (Layer 4) whose
   text your agent should capture and parse.

## Engine API (60-second tour)

```js
import { readFileSync } from "node:fs";
import { IVRCall } from "./src/ivr-engine.js";
const tree = JSON.parse(readFileSync("./src/trees/coral-health.json", "utf8"));

const call = new IVRCall(tree, { seed: 42, holdScale: 0.01 });
let ev = call.start();                      // { kind:"prompt", text:"..." }
ev = call.input({ type: "dtmf", value: "1" });
ev = call.input({ type: "speech", value: "Z Z T zero zero zero ..." });
// kinds: prompt | reprompt | confirm | hold | rep | readout | ended
if (ev.kind === "hold") ev = await call.waitForRep();  // resolves on "rep"
console.log(call.transcript());             // full call log for debugging
```

`seed` makes mishearing deterministic for tests. `holdScale` shrinks hold
times (1.0 = realistic minutes, 0.01 = test speed).

## PHI ground rules (synthetic or not)

- Synthetic identifiers only; the leak scanner treats them as if real.
- Mask in every log line: `maskId("ZZT0001234X") -> "*******234X"`.
- Prefer DTMF for identifier entry; speech only where a tree demands it.
- Before any REAL telephony vendor touches this project: HIPAA-eligible,
  BAA signed, recording-consent rules checked. None of that applies inside
  this sandbox because nothing real flows through it; all of it applies the
  day you dial a real payer.

## Telephony: deliberately not in here (and what you'll use later)

There is no Twilio, no SIP, no audio in this sandbox. That is a design
decision, not a gap: vendor selection is an open question in the brief and
is gated on a signed BAA; PHI must never flow through unvetted
infrastructure; and IVR logic is better developed against a deterministic
simulator than against per-minute phone calls that punish every bug with a
20-minute redial.

The engine API is shaped like a call-control SDK on purpose:

| Sandbox | Real telephony equivalent |
|---|---|
| `start()` / `prompt` events | call connected / ASR transcript of IVR audio |
| `input({type:"dtmf"})` | `sendDigits()` |
| `input({type:"speech"})` | TTS `say()` |
| `hold` event / `waitForRep()` | hold-music detection / human-voice detection |
| `rep` event | warm-transfer trigger (bridge the biller) |

Recommended pattern: define a thin `CallTransport` interface in your agent
(startCall, sendDtmf, say, onEvent). The simulator is its first
implementation; the week 7-8 vendor prototype is the second. Your tree
configs, phonetic library, and navigation logic should not change at all.

Vendor candidates to evaluate WITH Adarsh before any real call (every one
of these requires a signed BAA first; verify current HIPAA status
yourself, it changes): Twilio Programmable Voice (HIPAA-eligible products
under BAA), Telnyx, Amazon Connect. Higher-level voice-AI platforms
(Retell, Vapi, Bland) advertise HIPAA tiers; scrutinize where audio and
transcripts are stored before trusting that. Check state recording-consent
rules before recording anything.

Stack expectations for your agent code: plain Node/JavaScript (or
TypeScript if you prefer) matching this sandbox; Node 18+; no frameworks
required. Add dependencies only when you reach the vendor prototype.

## Path to production (not in this sandbox)

Layer 0 comes first in the real system: a claim only becomes a call after
276/277 and portal channels are exhausted. The production stack swaps this
engine's `input()`/events for a telephony vendor's call-control API and the
mishearing model for real ASR, but your tree configs, phonetic library, and
navigation logic carry over unchanged. That is the point of the sandbox.

## Suggested order (maps to the brief's weekly roadmap)

1. `npm run call` until you can reach a rep on all 3 trees by hand.
2. Implement `phonetic.js` until the test suite is green (Weeks 3-4).
3. Write your agent against coral-health, then meridian-blue (Weeks 5-6).
4. Beat sundial-medicare: mishearing recovery + hold + readout parse (Weeks 7-8).
5. Wire your agent's logs through `phi-logger` and keep `scanForLeaks` clean.
