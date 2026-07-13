import "dotenv/config";
// Twilio IVR Navigator — structured pre-call payload
//
// Flow:
//   POST /start-call { "to": "+15551234567", "payload": { taxId, customerId, patientName, ... } }
//     -> payload is stored and bound to the CallSid when Twilio connects
//     -> /call-handler starts listening to the IVR
//     -> /gather-result receives each IVR prompt, looks up the payload, speaks or enters digits
//     -> loops until call ends or max steps reached
//
// Setup:
//   1. Set env vars: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER
//   2. Expose this server publicly (e.g. `npx ngrok http 3000`) and set PUBLIC_URL
//   3. npm run twilio-ivr

import { createServer } from "node:http";
import { URLSearchParams } from "node:url";
import { randomUUID } from "node:crypto";
import { parseIVRDigit } from "./ivr-parser.js";

const ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const FROM_NUMBER = process.env.TWILIO_PHONE_NUMBER;

if (!ACCOUNT_SID) console.warn("Missing TWILIO_ACCOUNT_SID");
if (!AUTH_TOKEN) console.warn("Missing TWILIO_AUTH_TOKEN");
if (!FROM_NUMBER) console.warn("Missing TWILIO_PHONE_NUMBER");
const PUBLIC_URL = (process.env.PUBLIC_URL ?? "http://localhost:3000").replace(/\/$/, "");
const PORT = Number(process.env.PORT ?? 3000);
const MAX_STEPS = Number(process.env.MAX_STEPS ?? 40);

// --- XML helper ---

function escapeXml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// --- TwiML builders ---

function twimlGather() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech" action="${PUBLIC_URL}/gather-result" timeout="10" speechTimeout="auto" language="en-US">
  </Gather>
  <Redirect method="POST">${PUBLIC_URL}/gather-result</Redirect>
</Response>`;
}

// Enter a multi-digit string (tax ID, member ID, fax number, single digit, etc.) via DTMF.
function twimlPlayDigitsAndGather(digits) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play digits="${escapeXml(digits)}"></Play>
  <Pause length="2"/>
  <Gather input="speech" action="${PUBLIC_URL}/gather-result" timeout="10" speechTimeout="auto" language="en-US">
  </Gather>
  <Redirect method="POST">${PUBLIC_URL}/gather-result</Redirect>
</Response>`;
}

// Speak a response aloud then resume listening.
function twimlSayAndGather(text) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">${escapeXml(text)}</Say>
  <Pause length="1"/>
  <Gather input="speech" action="${PUBLIC_URL}/gather-result" timeout="10" speechTimeout="auto" language="en-US">
  </Gather>
  <Redirect method="POST">${PUBLIC_URL}/gather-result</Redirect>
</Response>`;
}

// --- IVR response logic ---
// Matches the IVR transcript against known prompt patterns and returns the right action.
// Returns { type: 'dtmf', value: '...' } | { type: 'speech', text: '...' } | null

// Inter-digit pacing for DTMF sequences — each 'w' = 0.5s pause.
// Prevents fast-dial dropping digits on IVRs that open the input window slowly.
function pacedDtmf(digits, terminator = "#") {
  return String(digits).split("").join("w") + terminator;
}

function getIVRResponse(transcript, payload) {
  const t = transcript.toLowerCase().trim();

  // ID readback: "the ID you entered", "was the ID", "if the ID" — press 1 immediately
  if (/id you entered|was the id|if the id/.test(t)) {
    return { type: "dtmf", value: "1" };
  }

  // Field readback: IVR echoing back a submitted value — press 1 if keypad indicated, otherwise say "yes"
  // Catches: "the date of birth you gave", "you entered 109968206", "did you say Gina", etc.
  if (/you (said|entered|provided|gave)|did you say|on file is|we have.*on file/.test(t)) {
    if (/press.?1/.test(t)) return { type: "dtmf", value: "1" };
    return { type: "speech", text: "yes" };
  }

  // Any other confirmation prompt — say "yes"
  if (/is (that|this) (correct|right)|correct\?|is that right|say yes|please confirm|press.?1.?(to |if )?(confirm|correct)|if (that|this) is correct/.test(t)) {
    return { type: "speech", text: "yes" };
  }

  // Tax ID / NPI / provider number (9-digit)
  if (/tax.?id|provider.?(tax|number|id)|npi|federal.?tax|9.?digit/.test(t)) {
    return { type: "dtmf", value: payload.taxId };
  }

  // Opening greeting
  if (/how (may|can) (i|we) (help|assist)|what.*(can|may) (i|we) (do|help)/.test(t)) {
    return { type: "speech", text: "Claim information" };
  }

  // Customer / Member ID or SSN
  if (/customer.?(id|number)|member.?(id|number)|ssn|social.?security/.test(t)) {
    return { type: "dtmf", value: payload.customerId };
  }

  // Date of birth — checked before patient name to avoid "member's date of birth" misfiring
  if (/date of birth|birth.?date|d\.?o\.?b|\bborn\b/.test(t)) {
    return { type: "speech", text: payload.dateOfBirth };
  }

  // Caller identity — who the agent/rep is (not the patient)
  // Catches: "say and spell your first and last name", "who am I speaking with", "who is calling"
  if (/say and spell|first and last name|who (am|are) (i|we) (speaking|talking)|who is calling|know who i.?m talking|i.?m speaking with/.test(t)) {
    return { type: "speech", text: payload.callerNameSpoken };
  }

  // Company / practice / organization name
  if (/\bcompany\b|company.?name|practice.?name|organization.?name|office.?name|group.?name|name of (your|the) (company|practice|organization|office|group)|calling from/.test(t)) {
    return { type: "speech", text: payload.companyNameSpoken };
  }

  // Patient name readback confirmation — IVR echoing the patient's name back for verification
  if (payload.patientName && t.includes(payload.patientName.toLowerCase())) {
    if (/press.?1/.test(t)) return { type: "dtmf", value: "1" };
    return { type: "speech", text: "yes" };
  }

  // Patient / member name — who the call is about
  if (/calling about|patient.?name|member.?name|who.*(calling|inquir)|name of (the )?member/.test(t)) {
    return { type: "speech", text: payload.patientName };
  }

  // Coverage type menu (medical / pharmacy / vision / mental health / substance abuse)
  if (/type of (coverage|plan|benefit)|(medical|pharmacy|vision|mental).*(pharmacy|vision|mental|medical)/.test(t)) {
    return { type: "speech", text: payload.coverageType };
  }

  // Date of service
  if (/date of service/.test(t)) {
    return { type: "speech", text: payload.dateOfService };
  }

  // Mailing address menu selection — must come before parseIVRDigit fallback, which would
  // otherwise grab the first digit in the menu (claim status = 1) instead of mailing address.
  // Uses "N for mailing" pattern to find the right digit regardless of menu order.
  if (/mailing.?(address|addr)/.test(t)) {
    const m = t.match(/(\d)\s*for\s+mailing|mailing.{0,30}?(\d)/);
    if (m) return { type: "dtmf", value: m[1] ?? m[2] };
    return { type: "speech", text: "mailing address" };
  }

  // Fax number readback confirmation — IVR echoing back the digits we entered.
  // Verbal "yes" is unreliable here; always press 1 to confirm.
  // Detected by fax + a digit string in the same transcript (the readback).
  if (/\bfax\b/.test(t) && /\d{3}/.test(t) && !/fax.?(number|num|#)/.test(t)) {
    return { type: "dtmf", value: "1" };
  }

  // Fax delivery selection — choose fax when the IVR presents delivery method options
  // Extracts whichever digit maps to fax in the menu; falls back to saying "yes" for yes/no prompts.
  // Must come before the fax number handler to avoid false matches on "fax number" prompts.
  if (/\bfax\b/.test(t) && !/fax.?(number|num|#)/.test(t)) {
    const m = t.match(/(\d)\s*(?:for\s+)?fax|fax[^.]*?(\d)/);
    if (m) return { type: "dtmf", value: m[1] ?? m[2] };
    return { type: "speech", text: "fax" };
  }

  // Fax number — enter with inter-digit pacing and # terminator
  if (/fax.?(number|num|#)/.test(t)) {
    return { type: "dtmf", value: pacedDtmf(payload.faxNumber) };
  }

  // Callback number
  if (/call.?back.?(number|num|#)|return.?(call|number)|phone.?(number|num)|number.*(reach|contact|call you)/.test(t)) {
    return { type: "dtmf", value: payload.callbackNumber };
  }

  // Fallback: existing DTMF digit parser ("press 1", "press one", etc.)
  const digit = parseIVRDigit(transcript);
  if (digit) return { type: "dtmf", value: digit };

  return null;
}

// --- State machine ---

const PHASE = {
  INIT:         'INIT',
  GREETING:     'GREETING',
  TAX_ID:       'TAX_ID',
  CALLER_ID:    'CALLER_ID',
  MEMBER_ID:    'MEMBER_ID',
  DOB:          'DOB',
  COVERAGE:     'COVERAGE',
  MAILING:      'MAILING',
  FAX_DELIVERY: 'FAX_DELIVERY',
  FAX_NUMBER:   'FAX_NUMBER',
  CONFIRMING:   'CONFIRMING',
  COMPLETE:     'COMPLETE',
};

const OUTCOME = {
  FAX_CONFIRMED:          'FAX_CONFIRMED',
  FAILED_FAX:             'FAILED_FAX',
  NEEDS_HUMAN:            'NEEDS_HUMAN',
  INCOMPLETE_INFORMATION: 'INCOMPLETE_INFORMATION',
  MAX_STEPS_REACHED:      'MAX_STEPS_REACHED',
};

// Maps a transcript to the phase it represents.
function detectPhase(t) {
  if (/how (may|can) (i|we) (help|assist)/.test(t))                              return PHASE.GREETING;
  if (/tax.?id|npi|federal.?tax|9.?digit/.test(t))                               return PHASE.TAX_ID;
  if (/say and spell|first and last name|who.*(speaking|calling|talking)/.test(t)) return PHASE.CALLER_ID;
  if (/customer.?(id|number)|member.?(id|number)|ssn|social.?security/.test(t))  return PHASE.MEMBER_ID;
  if (/date of birth|birth.?date|d\.?o\.?b|\bborn\b/.test(t))                   return PHASE.DOB;
  if (/type of (coverage|plan)|medical.*pharmacy|pharmacy.*medical/.test(t))     return PHASE.COVERAGE;
  if (/mailing.?(address|addr)/.test(t))                                         return PHASE.MAILING;
  if (/\bfax\b/.test(t) && !/fax.?(number|num|#)/.test(t))                      return PHASE.FAX_DELIVERY;
  if (/fax.?(number|num|#)/.test(t))                                             return PHASE.FAX_NUMBER;
  if (/you (said|entered|provided|gave)|did you say|is (that|this) (correct|right)|correct\?/.test(t)) return PHASE.CONFIRMING;
  return null;
}

// Detects successful fax confirmation from IVR transcript.
function isFaxConfirmed(t) {
  return /fax.*(sent|confirm|submit|success|on (its|the) way)|sent to fax|fax.*received|information.*fax/i.test(t);
}

function makeCallState() {
  return {
    phase:      PHASE.INIT,
    history:    [],           // [{ phase, transcript, action }]
    retries:    { fax: 0 },
    lastAction: null,
    outcome:    null,
  };
}

// --- Twilio REST: initiate outbound call ---

async function initiateCall(toNumber, token) {
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
    }
  );
  const data = await res.json();
  if (!res.ok) throw new Error(data.message ?? JSON.stringify(data));
  return data;
}

// --- Per-call stores (in-memory) ---

const pendingPayloads = new Map(); // callToken  -> payload (pre-connect)
const callPayload    = new Map(); // callSid    -> payload (live call)
const stepCounter    = new Map(); // callSid    -> step number
const callStateMap   = new Map(); // callSid    -> state object

function bumpStep(callSid) {
  const n = (stepCounter.get(callSid) ?? 0) + 1;
  stepCounter.set(callSid, n);
  return n;
}

function getOrInitState(callSid) {
  if (!callStateMap.has(callSid)) callStateMap.set(callSid, makeCallState());
  return callStateMap.get(callSid);
}

function transitionPhase(state, newPhase, callSid) {
  if (newPhase && newPhase !== state.phase) {
    console.log(`[${callSid}] [STATE] ${state.phase} → ${newPhase}`);
    state.phase = newPhase;
  }
}

function cleanupCall(callSid) {
  callPayload.delete(callSid);
  stepCounter.delete(callSid);
  callStateMap.delete(callSid);
}

// --- HTTP helpers ---

async function readFormBody(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return new URLSearchParams(raw);
}

async function readJsonBody(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return JSON.parse(raw);
}

function send(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

function sendXml(res, xml) {
  res.writeHead(200, { "Content-Type": "text/xml; charset=utf-8" });
  res.end(xml);
}

// --- HTTP server ---

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;

  try {
    // Kick off a call with a structured pre-call payload
    if (req.method === "POST" && path === "/start-call") {
      const body = await readJsonBody(req);
      if (!body.to) return send(res, 400, { error: "missing 'to' phone number" });

      const token = randomUUID();
      pendingPayloads.set(token, body.payload ?? {});

      const call = await initiateCall(body.to, token);
      console.log(`[twilio] call initiated: ${call.sid} -> ${body.to}`);
      console.log(`[twilio] payload:`, body.payload);
      return send(res, 201, { callSid: call.sid, status: call.status });
    }

    // Twilio webhook: call connected — bind payload to CallSid
    if (path === "/call-handler") {
      const params = await readFormBody(req);
      const callSid = params.get("CallSid") ?? "unknown";
      const token = url.searchParams.get("token");

      if (token && pendingPayloads.has(token)) {
        callPayload.set(callSid, pendingPayloads.get(token));
        pendingPayloads.delete(token);
        console.log(`[${callSid}] payload bound`);
      }

      stepCounter.delete(callSid);
      callStateMap.set(callSid, makeCallState()); // fresh state for this call
      console.log(`[${callSid}] call connected, starting IVR gather`);
      return sendXml(res, twimlGather());
    }

    // Twilio webhook: speech recognition result (or timeout)
    if (path === "/gather-result") {
      const params   = await readFormBody(req);
      const callSid  = params.get("CallSid") ?? "unknown";
      const transcript = params.get("SpeechResult") ?? "";
      const confidence = params.get("Confidence") ?? "0";
      const step     = bumpStep(callSid);
      const payload  = callPayload.get(callSid) ?? {};
      const state    = getOrInitState(callSid);
      const t        = transcript.toLowerCase().trim();

      if (transcript) {
        console.log(`[HUMAN SCRIPT] IVR: ${transcript}`);
        console.log(`[${callSid}] step=${step} confidence=${confidence}`);
      } else {
        console.log(`[${callSid}] step=${step} (no speech / timeout)`);
      }

      // Detect completion: IVR confirmed fax was sent
      if (transcript && isFaxConfirmed(t)) {
        state.outcome = OUTCOME.FAX_CONFIRMED;
        state.phase   = PHASE.COMPLETE;
        console.log(`[${callSid}] [STATE] → COMPLETE outcome=${OUTCOME.FAX_CONFIRMED}`);
        res.writeHead(200, { "Content-Type": "text/xml" });
        return res.end(`<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`);
      }

      // Max steps guard
      if (step > MAX_STEPS) {
        state.outcome = OUTCOME.MAX_STEPS_REACHED;
        console.log(`[${callSid}] [STATE] max steps → ${OUTCOME.MAX_STEPS_REACHED}`);
        res.writeHead(200, { "Content-Type": "text/xml" });
        return res.end(`<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`);
      }

      // Detect and transition phase
      const detectedPhase = transcript ? detectPhase(t) : null;
      if (detectedPhase && detectedPhase !== PHASE.CONFIRMING) {
        transitionPhase(state, detectedPhase, callSid);
      }

      // Fax number retry tracking — if we're re-entering the fax number it's a retry
      if (detectedPhase === PHASE.FAX_NUMBER && state.lastAction?.type === "dtmf") {
        state.retries.fax++;
        console.log(`[${callSid}] [STATE] fax retry #${state.retries.fax}`);
        if (state.retries.fax >= 2) {
          state.outcome = OUTCOME.FAILED_FAX;
          console.log(`[${callSid}] [STATE] fax failed after ${state.retries.fax} attempts → ${OUTCOME.FAILED_FAX}`);
          // Hang up — downstream system should flag for human follow-up
          res.writeHead(200, { "Content-Type": "text/xml" });
          return res.end(`<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`);
        }
      }

      // Determine action
      const action = getIVRResponse(transcript, payload);

      // Record action and log
      if (action) {
        state.lastAction = action;
        state.history.push({ phase: state.phase, transcript: transcript.slice(0, 80), action });
      }

      console.log(`[${callSid}] [STATE] phase=${state.phase} retries=${JSON.stringify(state.retries)} outcome=${state.outcome ?? 'pending'}`);

      if (action) {
        if (action.type === "dtmf") {
          console.log(`[HUMAN SCRIPT] BOT ACTION: Press ${action.value}`);
          return sendXml(res, twimlPlayDigitsAndGather(action.value));
        }
        if (action.type === "speech") {
          console.log(`[HUMAN SCRIPT] BOT ACTION: Say "${action.text}"`);
          return sendXml(res, twimlSayAndGather(action.text));
        }
      }

      return sendXml(res, twimlGather());
    }

    // Twilio status callback: log final outcome and clean up
    if (path === "/call-status") {
      const params = await readFormBody(req);
      const callSid = params.get("CallSid") ?? "unknown";
      const status  = params.get("CallStatus") ?? "";
      if (["completed", "failed", "busy", "no-answer", "canceled"].includes(status)) {
        const state   = callStateMap.get(callSid);
        const outcome = state?.outcome ?? OUTCOME.INCOMPLETE_INFORMATION;
        const phase   = state?.phase   ?? PHASE.INIT;
        console.log(`[${callSid}] [STATE] FINAL phase=${phase} outcome=${outcome} twilio=${status}`);
        cleanupCall(callSid);
      }
      res.writeHead(204);
      return res.end();
    }

    send(res, 404, { error: "unknown route" });
  } catch (e) {
    console.error(e);
    send(res, 500, { error: String(e.message) });
  }
});

server.listen(PORT, () => {
  console.log(`Twilio IVR Navigator  ->  http://localhost:${PORT}`);
  console.log(`PUBLIC_URL: ${PUBLIC_URL}`);
  console.log(`From:       ${FROM_NUMBER ?? "(not set)"}`);
  console.log(`\nTo start a call:`);
  console.log(`  curl -X POST http://localhost:${PORT}/start-call \\`);
  console.log(`       -H 'Content-Type: application/json' \\`);
  console.log(`       -d '{"to":"+15551234567","payload":{"taxId":"990495714","customerId":"109968206","callerNameSpoken":"Ruby. R U B Y.","companyNameSpoken":"Ruby RCM. That is R U B Y. R C M.","patientName":"Gina","dateOfBirth":"January 1, 1990","coverageType":"medical","dateOfService":"October 6, 2025","faxNumber":"7862282230","callbackNumber":"2526594994"}}'`);
});
