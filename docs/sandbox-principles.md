# Sandbox design principles — research notes and self-assessment

June 2026. Researched before building realtime mode; update if the field moves.

## What good agent environments do (gym-style literature)

From ResearchGym, NeMo Gym, and RL-environment design writing: a credible
agent environment has (1) a clean step/observe interface, (2) seeded
determinism so failures replay exactly, (3) automatic verification separate
from the environment, (4) clear Task / Environment / Solver / Evaluator
separation, (5) parametric difficulty, and (6) resistance to reward hacking
(the agent must not be able to score without doing the task).

## What voice-agent test platforms simulate (Hamming, Coval, Bluejay, Pipecat, ivr-tester)

The commercial and OSS voice-testing world converges on a checklist of the
things that break voice agents and therefore must exist in any simulator:
interruptions/barge-in (DTMF cut-through), silence and input timeouts,
unexpected input, long holds, mishearing/ASR error, scripted scenarios run
in parallel, full transcripts, and latency/completion metrics. Connection
is via API/WebSocket shaped like a telephony transport.

## Scorecard for this sandbox

| Principle | Status |
|---|---|
| Step/observe interface | YES — `input() -> event`, and HTTP Call API |
| Seeded determinism | YES — mulberry32 seed; same seed = same mishearing |
| Automatic verification | YES — mission tests grade the agent; anti-hardcoding test |
| Task/Env/Solver/Eval separation | YES — fixture / engine / my-agent.js / test files |
| Parametric difficulty | YES — mishearRate, holdScale, 4 trees, timeScale |
| Reward-hack resistance | PARTIAL — unseen-DOS test, denial-detail requirement; one-call rule is honor-system |
| Barge-in / cut-through | YES (realtime mode) |
| Silence & input timeouts | YES (realtime mode; engine.timeoutInput) |
| Streaming observation | YES (realtime mode; paced speech chunks) |
| Holds | YES (both modes) |
| Mishearing | YES (both modes) |
| Real audio / ASR | NO — deliberate; arrives with the telephony vendor |
| Parallel scenario runs | YES — engine is cheap; tests already run concurrently |

## Turn-based vs realtime: why both exist

The turn-based mode (`IVRCall`, `/api/calls`) is a chatbot-shaped
abstraction: the IVR waits forever and prompts arrive atomically. It is the
right first rung — debuggable, deterministic, instant. But it cannot
express the three things that make phone calls hard: time, silence, and
interruption.

The realtime mode (`RealtimeCall`, `/api/rt/calls`, SSE) adds exactly
those, nothing else: prompts stream in word chunks at a speaking rate
(default 165 wpm), an input timeout arms when the prompt ends (silence gets
"Are you still there?", repeated silence gets a hangup), and input sent
mid-prompt barges in like DTMF cut-through. `timeScale` keeps tests fast
and demos realistic. The event model (subscribe to a stream, post inputs
whenever) is deliberately the shape of a telephony media-stream API, so the
production swap is transport-only.

Progression for the agent: pass the Granite Run turn-based first, then pass
it again under realtime with `timeScale: 1`. Same mission, same grader
shape; the second pass proves the agent handles time, not just trees.

## Sources

- https://hamming.ai/ and https://hamming.ai/blog/voice-agent-testing-platforms-comparison-2025
- https://getbluejay.ai/resources/ivr-testing-complete-guide
- https://docs.pipecat.ai/pipecat/fundamentals/evaluations/overview
- https://github.com/MakingChatbots/ivr-tester
- https://webrtc.ventures/2025/07/how-to-automate-voice-ai-agent-testing-evaluation-with-coval/
- https://arxiv.org/pdf/2602.15112 (ResearchGym)
- https://github.com/NVIDIA-NeMo/Gym
- https://toloka.ai/blog/inside-the-rl-gym-reinforcement-learning-environments-explained/
