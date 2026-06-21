// Twilio IVR Navigator — MVP
//
// Flow:
//   POST /start-call { "to": "+15551234567" }
//     -> Twilio dials the payer
//     -> /call-handler returns TwiML to start gathering IVR speech
//     -> /gather-result receives transcript, parses it, presses the right digit
//     -> loops until call ends or max steps reached
//
// Setup:
//   1. Set env vars: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER
//   2. Expose this server publicly (e.g. `npx ngrok http 3000`) and set PUBLIC_URL
//   3. npm run twilio-ivr

import { createServer } from "node:http";
import { URLSearchParams } from "node:url";
import { parseIVRDigit } from "./ivr-parser.js";

const ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const FROM_NUMBER = process.env.TWILIO_PHONE_NUMBER;

if (!ACCOUNT_SID) console.warn("Missing TWILIO_ACCOUNT_SID");
if (!AUTH_TOKEN) console.warn("Missing TWILIO_AUTH_TOKEN");
if (!FROM_NUMBER) console.warn("Missing TWILIO_PHONE_NUMBER");
const PUBLIC_URL = (process.env.PUBLIC_URL ?? "http://localhost:3000").replace(/\/$/, "");
const PORT = Number(process.env.PORT ?? 3000);
const MAX_STEPS = Number(process.env.MAX_STEPS ?? 20); // guard against infinite loops

// --- TwiML builders ---

function twimlGather() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech" action="${PUBLIC_URL}/gather-result" timeout="10" speechTimeout="auto" language="en-US">
  </Gather>
  <Redirect method="POST">${PUBLIC_URL}/gather-result</Redirect>
</Response>`;
}

// Press a DTMF digit, pause briefly, then gather the next IVR prompt.
function twimlPressAndGather(digit) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play digits="${digit}"></Play>
  <Pause length="2"/>
  <Gather input="speech" action="${PUBLIC_URL}/gather-result" timeout="10" speechTimeout="auto" language="en-US">
  </Gather>
  <Redirect method="POST">${PUBLIC_URL}/gather-result</Redirect>
</Response>`;
}

// --- Twilio REST: initiate outbound call ---

async function initiateCall(toNumber) {
  if (!ACCOUNT_SID || !AUTH_TOKEN || !FROM_NUMBER) {
    throw new Error("Missing TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, or TWILIO_PHONE_NUMBER env vars.");
  }
  const body = new URLSearchParams({
    To: toNumber,
    From: FROM_NUMBER,
    Url: `${PUBLIC_URL}/call-handler`,
    Method: "POST",
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

// --- Per-call step counter (in-memory, keyed by CallSid) ---
const stepCounter = new Map();

function getStep(callSid) {
  return stepCounter.get(callSid) ?? 0;
}

function bumpStep(callSid) {
  const n = (stepCounter.get(callSid) ?? 0) + 1;
  stepCounter.set(callSid, n);
  return n;
}

// --- HTTP server ---

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

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;

  try {
    // Kick off a call
    if (req.method === "POST" && path === "/start-call") {
      const body = await readJsonBody(req);
      if (!body.to) return send(res, 400, { error: "missing 'to' phone number" });
      const call = await initiateCall(body.to);
      console.log(`[twilio] call initiated: ${call.sid} -> ${body.to}`);
      return send(res, 201, { callSid: call.sid, status: call.status });
    }

    // Twilio webhook: call just connected — start listening
    if (path === "/call-handler") {
      const params = await readFormBody(req);
      const callSid = params.get("CallSid") ?? "unknown";
      stepCounter.delete(callSid); // reset on fresh call
      console.log(`[${callSid}] call connected, starting IVR gather`);
      return sendXml(res, twimlGather());
    }

    // Twilio webhook: speech recognition result (or timeout)
    if (path === "/gather-result") {
      const params = await readFormBody(req);
      const callSid = params.get("CallSid") ?? "unknown";
      const transcript = params.get("SpeechResult") ?? "";
      const confidence = params.get("Confidence") ?? "0";
      const step = bumpStep(callSid);

      if (transcript) {
        console.log(`[${callSid}] step=${step} transcript="${transcript}" confidence=${confidence}`);
      } else {
        console.log(`[${callSid}] step=${step} (no speech / timeout)`);
      }

      // Safety: hang up if we've looped too many times
      if (step > MAX_STEPS) {
        console.log(`[${callSid}] max steps reached, hanging up`);
        res.writeHead(200, { "Content-Type": "text/xml" });
        return res.end(`<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`);
      }

      const digit = parseIVRDigit(transcript);
      if (digit) {
        console.log(`[${callSid}] pressing ${digit}`);
        return sendXml(res, twimlPressAndGather(digit));
      }

      // No instruction found — keep listening
      return sendXml(res, twimlGather());
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
  console.log(`       -d '{"to":"+15551234567"}'`);
});
