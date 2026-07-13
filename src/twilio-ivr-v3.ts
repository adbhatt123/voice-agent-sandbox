import "dotenv/config";
// Twilio IVR Navigator v3 — goal-based planner over the classic <Gather> flow.
//
// Same endpoints and TwiML shape as src/twilio-ivr.js (/start-call,
// /call-handler, /gather-result, /call-status), but the decision logic is
// replaced: instead of parseIVRDigit grabbing the first "press N" it hears, each
// transcript is classified by StateTracker and routed to the DeterministicPlanner
// — the same decision core covered by the Medicare tests (test/medicare-planner).
//
// Why not the streaming Orchestrator class here? That one drives the Media
// Streams pipeline (persistent event loop, async audio, "wait" = keep the stream
// open). A <Gather> webhook is request/response: every POST must return exactly
// one TwiML document. So this file reuses the tested StateTracker + planner and
// reproduces the orchestrator's per-call bookkeeping (preferred->fallback on
// retry, goal tracking, recentMeanings loop detection) synchronously per turn.
//
// Setup is identical to v1:
//   1. env: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER, PUBLIC_URL
//   2. expose publicly (e.g. npx ngrok http 3000), set PUBLIC_URL
//   3. npm run twilio-v3

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { URLSearchParams } from "node:url";
import { randomUUID } from "node:crypto";

import { analyze } from "./state-tracker.ts";
import { DeterministicPlanner } from "./planner-deterministic.ts";
import type { Action } from "./types.ts";
import type { PlannerContext, PlannerDecision } from "./planner.ts";

const ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const FROM_NUMBER = process.env.TWILIO_PHONE_NUMBER;

if (!ACCOUNT_SID) console.warn("Missing TWILIO_ACCOUNT_SID");
if (!AUTH_TOKEN) console.warn("Missing TWILIO_AUTH_TOKEN");
if (!FROM_NUMBER) console.warn("Missing TWILIO_PHONE_NUMBER");

const PUBLIC_URL = (process.env.PUBLIC_URL ?? "http://localhost:3000").replace(/\/$/, "");
const PORT = Number(process.env.PORT ?? 3000);
const MAX_STEPS = Number(process.env.MAX_STEPS ?? 40);

// Required goals per objective; when all are met we hang up. Mirrors the
// requiredGoals the orchestrator uses, so live behavior matches the tests.
const REQUIRED_GOALS: Record<string, readonly string[]> = {
  claim_status: ["claim_status_received"],
  request_fax: ["claim_status_received", "fax_confirmed"],
  eligibility: ["eligibility_received"],
};

// --- TwiML (identical structure to src/twilio-ivr.js) ---

function escapeXml(str: string): string {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function twimlGather(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech" action="${PUBLIC_URL}/gather-result" timeout="10" speechTimeout="auto" language="en-US">
  </Gather>
  <Redirect method="POST">${PUBLIC_URL}/gather-result</Redirect>
</Response>`;
}

function twimlPlayDigitsAndGather(digits: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play digits="${escapeXml(digits)}"></Play>
  <Pause length="2"/>
  <Gather input="speech" action="${PUBLIC_URL}/gather-result" timeout="10" speechTimeout="auto" language="en-US">
  </Gather>
  <Redirect method="POST">${PUBLIC_URL}/gather-result</Redirect>
</Response>`;
}

function twimlSayAndGather(text: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">${escapeXml(text)}</Say>
  <Pause length="1"/>
  <Gather input="speech" action="${PUBLIC_URL}/gather-result" timeout="10" speechTimeout="auto" language="en-US">
  </Gather>
  <Redirect method="POST">${PUBLIC_URL}/gather-result</Redirect>
</Response>`;
}

const TWIML_HANGUP = `<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`;

// --- Twilio REST: initiate outbound call (copied from v1) ---

async function initiateCall(toNumber: string, token: string): Promise<{ sid: string; status: string }> {
  if (!ACCOUNT_SID || !AUTH_TOKEN || !FROM_NUMBER) {
    throw new Error("Missing TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, or TWILIO_PHONE_NUMBER env vars.");
  }
  const body = new URLSearchParams({
    To: toNumber,
    From: FROM_NUMBER,
    Url: `${PUBLIC_URL}/call-handler?token=${token}`,
    Method: "POST",
    StatusCallback: `${PUBLIC_URL}/call-status`,
    StatusCallbackMethod: "POST",
  });
  const credentials = Buffer.from(`${ACCOUNT_SID}:${AUTH_TOKEN}`).toString("base64");
  const res = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT_SID}/Calls.json`,
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${credentials}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    },
  );
  const data = (await res.json()) as { sid?: string; status?: string; message?: string };
  if (!res.ok) throw new Error(data.message ?? JSON.stringify(data));
  return { sid: data.sid ?? "unknown", status: data.status ?? "unknown" };
}

// --- Per-call planning session (the orchestrator's bookkeeping, sync per turn) ---

const planner = new DeterministicPlanner();

type PendingCall = { payload: Record<string, string>; objective: string };

class CallSession {
  private readonly payload: Record<string, string>;
  private readonly objective: string;
  private readonly requiredGoals: readonly string[];
  private readonly payerId: string;

  private readonly completedGoals = new Set<string>();
  private readonly committedMeanings: string[] = [];
  private lastMeaning: string | null = null;
  private retryOnMeaning = 0;
  private step = 0;

  constructor(payerId: string, pending: PendingCall) {
    this.payerId = payerId;
    this.payload = pending.payload;
    this.objective = pending.objective;
    this.requiredGoals = REQUIRED_GOALS[pending.objective] ?? REQUIRED_GOALS.claim_status!;
  }

  /** Turn a single IVR transcript into the next TwiML response. */
  handle(transcript: string): string {
    this.step++;
    if (this.step > MAX_STEPS) {
      console.log(`[${this.payerId}] max steps reached -> hangup`);
      return TWIML_HANGUP;
    }

    const state = analyze(transcript, true);
    if (state.goalSignal) this.completeGoal(state.goalSignal);

    // retry detection: same meaning repeating drives preferred -> fallback
    if (state.promptMeaning === this.lastMeaning) this.retryOnMeaning++;
    else {
      this.retryOnMeaning = 0;
      this.lastMeaning = state.promptMeaning;
    }
    const isRetry = this.retryOnMeaning > 0;

    const ctx: PlannerContext = {
      payerId: this.payerId,
      objective: this.objective,
      payload: this.payload,
      completedGoals: this.completedGoals,
      isRetry,
      recentMeanings: this.committedMeanings.slice(-6), // excludes current turn
    };

    const decision = planner.plan(state, ctx) as PlannerDecision;
    if (decision.goalCompleted) this.completeGoal(decision.goalCompleted);

    const action = isRetry && decision.fallback ? decision.fallback : decision.preferred;
    this.committedMeanings.push(state.promptMeaning);

    console.log(
      `[${this.payerId}] step=${this.step} "${transcript.slice(0, 80)}" ` +
        `=> ${state.promptMeaning} -> ${describe(action)}`,
    );

    // Objective met -> end the call.
    if (this.goalsSatisfied()) return TWIML_HANGUP;

    switch (action.type) {
      case "dtmf":
        return twimlPlayDigitsAndGather(action.digits);
      case "speech":
        return twimlSayAndGather(action.text);
      case "hangup":
        return TWIML_HANGUP;
      case "wait":
        // Optional/unknown prompt: say nothing, keep listening for the real one.
        return twimlGather();
    }
  }

  private completeGoal(goal: string): void {
    if (!this.completedGoals.has(goal)) {
      this.completedGoals.add(goal);
      console.log(`[${this.payerId}] goal completed: ${goal}`);
    }
  }

  private goalsSatisfied(): boolean {
    return this.requiredGoals.length > 0 && this.requiredGoals.every((g) => this.completedGoals.has(g));
  }
}

/** Mask multi-digit DTMF in logs (single keys are menu choices, safe to show). */
function describe(action: Action): string {
  switch (action.type) {
    case "dtmf":
      return action.digits.length <= 2 ? `press ${action.digits}` : "press [redacted]";
    case "speech":
      return `say "${action.text}"`;
    case "wait":
      return `wait (${action.reason ?? "no action"})`;
    case "hangup":
      return `hangup (${action.reason})`;
  }
}

// --- Per-call stores ---

const pendingPayloads = new Map<string, PendingCall>(); // token   -> payload (pre-connect)
const sessions = new Map<string, CallSession>(); // callSid -> live session

// --- HTTP helpers (from v1) ---

async function readFormBody(req: IncomingMessage): Promise<URLSearchParams> {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return new URLSearchParams(raw);
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

function send(res: ServerResponse, status: number, obj: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

function sendXml(res: ServerResponse, xml: string): void {
  res.writeHead(200, { "Content-Type": "text/xml; charset=utf-8" });
  res.end(xml);
}

/** Coerce a free-form payload object into the string map the planner expects. */
function toStringMap(obj: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (obj && typeof obj === "object") {
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (v !== null && v !== undefined) out[k] = String(v);
    }
  }
  return out;
}

// --- HTTP server ---

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const path = url.pathname;

  try {
    // Kick off a call with a structured pre-call payload + objective.
    if (req.method === "POST" && path === "/start-call") {
      const body = await readJsonBody(req);
      if (!body.to) return send(res, 400, { error: "missing 'to' phone number" });

      const payloadSrc = (body.payload as Record<string, unknown>) ?? {};
      const objective =
        (typeof body.objective === "string" && body.objective) ||
        (typeof payloadSrc.objective === "string" && payloadSrc.objective) ||
        "claim_status";

      const token = randomUUID();
      pendingPayloads.set(token, { payload: toStringMap(payloadSrc), objective });

      const call = await initiateCall(String(body.to), token);
      console.log(`[twilio] call initiated: ${call.sid} -> ${body.to} (objective=${objective})`);
      return send(res, 201, { callSid: call.sid, status: call.status });
    }

    // Twilio webhook: call connected — bind payload to CallSid, start a session.
    if (path === "/call-handler") {
      const params = await readFormBody(req);
      const callSid = params.get("CallSid") ?? "unknown";
      const token = url.searchParams.get("token");

      const pending =
        (token && pendingPayloads.get(token)) || { payload: {}, objective: "claim_status" };
      if (token) pendingPayloads.delete(token);

      sessions.set(callSid, new CallSession(callSid, pending));
      console.log(`[${callSid}] call connected (objective=${pending.objective}), listening`);
      return sendXml(res, twimlGather());
    }

    // Twilio webhook: speech recognition result (or timeout).
    if (path === "/gather-result") {
      const params = await readFormBody(req);
      const callSid = params.get("CallSid") ?? "unknown";
      const transcript = params.get("SpeechResult") ?? "";

      // Late/unknown call: start a default session so we still navigate.
      let session = sessions.get(callSid);
      if (!session) {
        session = new CallSession(callSid, { payload: {}, objective: "claim_status" });
        sessions.set(callSid, session);
      }

      if (!transcript) {
        // No speech detected — keep listening rather than guessing.
        return sendXml(res, twimlGather());
      }

      return sendXml(res, session.handle(transcript));
    }

    // Twilio status callback: clean up.
    if (path === "/call-status") {
      const params = await readFormBody(req);
      const callSid = params.get("CallSid") ?? "unknown";
      const status = params.get("CallStatus") ?? "";
      if (["completed", "failed", "busy", "no-answer", "canceled"].includes(status)) {
        console.log(`[${callSid}] final twilio status=${status}, cleaning up`);
        sessions.delete(callSid);
      }
      res.writeHead(204);
      return res.end();
    }

    send(res, 404, { error: "unknown route" });
  } catch (e) {
    console.error(e);
    send(res, 500, { error: String((e as Error).message) });
  }
});

server.listen(PORT, () => {
  console.log(`Twilio IVR Navigator v3 (goal-based)  ->  http://localhost:${PORT}`);
  console.log(`PUBLIC_URL: ${PUBLIC_URL}`);
  console.log(`From:       ${FROM_NUMBER ?? "(not set)"}`);
  console.log(`\nTo start a call:`);
  console.log(`  curl -X POST http://localhost:${PORT}/start-call \\`);
  console.log(`       -H 'Content-Type: application/json' \\`);
  console.log(
    `       -d '{"to":"+15551234567","objective":"claim_status","payload":{"npi":"1234567890","taxId":"990495714","memberId":"109968206","dos":"10062025","faxNumber":"7862282230"}}'`,
  );
});
