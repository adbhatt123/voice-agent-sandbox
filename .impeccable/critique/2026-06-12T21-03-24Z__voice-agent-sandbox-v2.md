---
target: voice-agent-sandbox (full system: engine, realtime, web UI, agent runner, mission)
total_score: 35
p0_count: 0
p1_count: 0
timestamp: 2026-06-12T21-03-24Z
slug: voice-agent-sandbox-v2
supersedes: 2026-06-12T20-02-57Z__voice-agent-sandbox.md (scored 28/40 before realtime mode, agent runner, tabs, fixture panel, denial depth, and fresh-eyes QA)
note: Claude following the impeccable critique format; the impeccable package is not installed here (zero-dependency constraint)
---
## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 3 | State chip, silence countdown, words-heard metric, verdict cards, "input not recognized" labels. Remaining gap: what the IVR misheard still only surfaces at confirm/reprompt, not at the moment of corruption |
| 2 | Match System / Real World | 4 | Keypad letters, multi-tap with pauses, layered denial readouts (CARC -> press 4 -> RARCs/ICN/appeal window), silence punished, barge-in cut-through. The simulator now teaches real payer behavior rather than approximating it |
| 3 | User Control and Freedom | 3 | Confirm-before-redial, hangup, esc closes docs. No undo on sent input (deliberate call fidelity); no per-prompt repeat outside Granite's loop |
| 4 | Consistency and Standards | 3 | One token set; chips/banners/labels consistent across human dialing and agent spectating; tab metaphor matches v1/v2 scoping |
| 5 | Error Prevention | 3 | Click-to-load fixture values, auto multi-tap encoding, explanatory retry prompts, friendly 404/409s, dial-over-live confirm |
| 6 | Recognition Rather Than Recall | 4 | Casa-shaped work items beside the dialer, README and mission readable in-app, keypad prints letters, multi-tap explained where the example lives |
| 7 | Flexibility and Efficiency | 4 | Three agent transports (import / REST / SSE), web agent-runner with cache-busted reload, seed replay, speed slider, keyboard everything |
| 8 | Aesthetic and Minimalist Design | 3 | Clean and flat; right rail and dock are dense but organized; verdict card matches the system's voice |
| 9 | Error Recovery | 4 | Didactic failure copy throughout ("The CARC alone is not why we call"), agent-crash banner, recoverable friendly errors verified by independent QA |
| 10 | Help and Documentation | 4 | Docs surfaced in-app; counts verified accurate by fresh-clone QA; architecture note (navigate live, parse offline) preempts the predictable LLM mistake |
| **Total** | | **35/40** | **Strong — remaining issues are polish and code health** |

## Anti-Patterns Verdict

**Deterministic scan:** 0 side-stripes, 0 gray-on-color, 0 emoji in UI (one aria-hidden ♦ difficulty glyph; a ✓ glyph WAS rendered in verdict-card notes — removed in this pass; the PASS mark already carries the meaning).

**Does this look AI-generated?** Less than before. The interaction model (spectate-your-own-agent, silence bars, barge-in markers) is purpose-built and has no template ancestor. The one growing architectural tell: web/index.html is now ~590 lines of single-file UI. Fine for a teaching sandbox; first refactor if this ever grows another tab.

## Movement since the 28/40 critique

- FIXED [P1 then]: dial-over-live-call silent destruction (confirm dialog).
- FIXED: seed jargon (tooltip), ♦ screen-reader noise, no in-UI mission link.
- NEW SINCE, raising scores: realtime dialer with humane 12s input window, agent runner + verdict cards, Full/Semi IVR tabs, Casa-shaped fixture panel, denial-detail layer, in-app docs, three QA-found bugs fixed (perpetual-red suite, metadata leak, terminator echo).
- STILL OPEN [P2]: sub-980px viewports hide both rails instead of stacking (fixture data unreachable on a split-screen 13" laptop).
- STILL OPEN [P2]: no "heard as" diff at the moment of mishearing — the single best teaching moment remains implicit.
- WORSE, NOW P2 (was P3): private-state coupling — server and web UI reach into `call._ended` / `rc._done` / `rt.call.captured` in six places. Add `isEnded()` / `captured()` accessors before Julia extends the engine.

## Persona Red Flags

**Julia**: small-laptop rail hiding is the only onboarding hazard left; everything else was validated end-to-end by a fresh-eyes agent run.
**Adarsh (demo)**: Run-my-agent at slow speed is now the best 60-second demo in the repo. No flag.
**Future maintainer**: single-file UI and private-state reaches are the debt; both cheap to pay now, expensive after her PRs start landing.
