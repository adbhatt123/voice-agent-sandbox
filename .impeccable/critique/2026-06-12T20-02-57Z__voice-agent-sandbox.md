---
target: voice-agent-sandbox (web UI + engine + mission)
total_score: 28
p0_count: 0
p1_count: 1
timestamp: 2026-06-12T20-02-57Z
slug: voice-agent-sandbox
note: produced by Claude following the impeccable critique format; the impeccable package itself is not installed in this repo (zero-dependency constraint)
---
## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 3 | State chip + hold progress + live captured panel are strong; what the IVR "heard" for misheard speech only surfaces at confirm/reprompt, never proactively |
| 2 | Match System / Real World | 3 | Phone metaphor, keypad letters, IVR diction all land. "Seed" was dev jargon (tooltip added this pass) |
| 3 | User Control and Freedom | 2 | No undo on sent input (intentional fidelity to real calls, but unstated); no per-prompt "repeat" outside Granite's loop; Hang up exists |
| 4 | Consistency and Standards | 3 | One token set, mono = machine data everywhere, chips consistent across panels and feed |
| 5 | Error Prevention | 2 | Pattern validation + click-to-load + auto multi-tap prevent the worst typos, but Dial during a live call silently killed it (FIXED this pass: confirm dialog) |
| 6 | Recognition Rather Than Recall | 3 | Fixture data lives beside the dialer; keypad prints letters; node path visible. Multi-tap rule still requires reading the prompt once |
| 7 | Flexibility and Efficiency | 3 | Keyboard entry, click-to-load, sliders, and an HTTP API for scripted use; no in-UI call replay (API covers it) |
| 8 | Aesthetic and Minimalist Design | 3 | Clean, flat, tokened; right rail is dense but organized; single ♦ dingbat now aria-hidden |
| 9 | Error Recovery | 3 | Reprompts explain, hangups state cause, ended banner says how to retry with same seed; API errors are explanatory JSON (409 on bad /rep added this pass) |
| 10 | Help and Documentation | 3 | In-UI hints, README, mission doc now linked from the fixture panel; no onboarding tour (acceptable for a dev tool) |
| **Total** | | **28/40** | **Good — polish-level issues remain** |

---

## Anti-Patterns Verdict

**Does this look AI-generated?**

**LLM assessment**: It was AI-generated; mostly it does not read that way. The three-pane layout is purpose-built for the task (payers/settings, call, evidence), colors are a single hex token set rather than ad-hoc framework utilities, and there is no emoji-in-badge or side-stripe scaffolding. The one prototype tell is architectural: a single ~750-line HTML file with inline CSS and one module script. For a zero-dependency teaching sandbox that is a feature (the intern can read all of it); in a product it would be the first refactor.

**Deterministic scan (web/index.html, src/cli.js):**
- 0× side-stripe (`border-l-2`/`borderLeft`)
- 0× gray-on-color (`text-slate-*`/`text-gray-*` on colored fills)
- 0× emoji; 1× decorative dingbat (♦ difficulty stars) — now `aria-hidden`

---

## Overall Impression

The sandbox does the hard thing well: it teaches by consequence (mishearing punishes speech, multi-tap makes the phonetic library feel necessary, the unseen-DOS test anticipates hardcoding) and keeps a 1:1 contract with the production platform so the work ports. The UI is honest about being an instrument panel, not a product. Remaining gaps are polish and small-screen behavior, not concept.

---

## What's Working

1. **Fixture-beside-dialer.** The Casa-shaped work-item cards next to the keypad collapse the recall burden to zero and quietly teach the production schema.
2. **The mishearing asymmetry.** DTMF never corrupts, speech does — the brief's central lesson is enforced by physics, not prose.
3. **Deliverables as skipped tests.** 15 pending tests that activate as the intern implements is a self-grading curriculum.

---

## Priority Issues

**[P1] Dial during a live call silently destroyed it** — FIXED this pass
- Why it matters: one stray click mid-Granite-run threw away an authenticated three-claim call with no warning.
- Fix applied: confirm dialog when dialing over an active call.

**[P2] Sub-980px viewports lose both rails entirely**
- Why it matters: on a 13" laptop with the editor split-screened, the fixture panel (and therefore the mission data) is unreachable; the media query hides rather than stacks.
- Fix: stack panels vertically below 980px instead of `display:none`.
- **Suggested command**: $impeccable polish responsive-stacking

**[P2] Misheard speech is only visible after the fact**
- Why it matters: the captured panel updates, but the moment of corruption (said "five", heard "nine") is the teachable instant; surfacing a "heard as" diff bubble would make the lesson explicit.
- Fix: engine already logs heard values; render an IVR-side "heard: …" annotation on speech inputs.
- **Suggested command**: $impeccable craft heard-as-diff

**[P3] Engine exposes `_ended` to server and UI**
- Why it matters: underscore-private state consumed externally; fine today, brittle as the intern extends the engine.
- Fix: add `isEnded()` and migrate call sites.

---

## Persona Red Flags

**Julia (intern, primary user)**: small-laptop split-screen hides the fixture panel (P2 above). Otherwise the path from "clone" to "first rep reached" is under five minutes and self-documenting.

**Adarsh (reviewer)**: wants to demo this to advisors quickly — `npm run web` + click-to-load fixture values makes the Granite Run demoable in ~90 seconds with zero memorization. No flag.

**Future maintainer**: tree configs are data and the README documents every node kind; the single-file UI is the only thing that will resist growth.
