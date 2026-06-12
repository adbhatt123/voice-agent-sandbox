// Zero-dependency server: web UI + the agent-facing Call API.
// Usage: npm run web  ->  http://localhost:4321
//
// CALL API (for agents, any language — shaped like a telephony vendor API):
//   GET  /api/trees                      list payers
//   POST /api/calls                      { tree, seed?, mishearRate?, holdScale? } -> { callId, event }
//   POST /api/calls/:id/input           { type: "dtmf"|"speech", value } -> { event }
//   GET  /api/calls/:id                  { ended, captured, holdTimeMs, transcript }
//   GET  /api/calls/:id/rep              long-poll: resolves when the rep answers (hold trees)
// Events are exactly the engine's: prompt|reprompt|confirm|hold|rep|readout|ended.
//
// REALTIME "VIRTUAL DIALER" MODE (SSE; time, timeouts, and barge-in are real):
//   POST /api/rt/calls                   { tree, seed?, timeScale?, wpm?, inputTimeoutMs?, mishearRate? }
//   GET  /api/rt/calls/:id/events        Server-Sent Events stream (speech chunks, timeouts, etc.)
//   POST /api/rt/calls/:id/input         barge-in capable; reply arrives on the stream
//   POST /api/rt/calls/:id/hangup
import { createServer } from "node:http";
import { readFile, readdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { IVRCall } from "./ivr-engine.js";
import { RealtimeCall } from "./realtime.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

const calls = new Map(); // callId -> { call, tree }
const rtCalls = new Map(); // callId -> RealtimeCall (virtual dialer mode)
const MAX_CALLS = 200;

function loadTree(name) {
  if (!/^[a-z0-9-]+$/.test(name)) return null;
  try { return JSON.parse(readFileSync(join(ROOT, "src/trees", `${name}.json`), "utf8")); }
  catch { return null; }
}

async function readBody(req) {
  let data = "";
  for await (const chunk of req) { data += chunk; if (data.length > 65536) throw new Error("body too large"); }
  return data ? JSON.parse(data) : {};
}

function send(res, code, obj) {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}

async function handleApi(req, res, path) {
  if (req.method === "GET" && path === "/api/trees") {
    const files = (await readdir(join(ROOT, "src/trees"))).filter((f) => f.endsWith(".json"));
    const list = files.map((f) => {
      const t = loadTree(f.replace(".json", ""));
      return { id: f.replace(".json", ""), payer: t.payer, phone: t.phone, difficulty: t.difficulty, endToEnd: !!t.endToEnd };
    });
    return send(res, 200, { trees: list });
  }

  if (req.method === "POST" && path === "/api/calls") {
    const body = await readBody(req);
    const tree = loadTree(body.tree ?? "");
    if (!tree) return send(res, 400, { error: `unknown tree '${body.tree}'. GET /api/trees for options.` });
    if (calls.size >= MAX_CALLS) calls.delete(calls.keys().next().value);
    const call = new IVRCall(tree, {
      seed: body.seed ?? 1,
      mishearRate: body.mishearRate ?? 0.12,
      holdScale: body.holdScale ?? 0.002,
    });
    const callId = randomUUID();
    calls.set(callId, { call, tree });
    const event = call.start();
    return send(res, 201, { callId, payer: tree.payer, event });
  }

  // ---- realtime (virtual dialer) mode: SSE event stream + async input ----
  if (req.method === "POST" && path === "/api/rt/calls") {
    const body = await readBody(req);
    const tree = loadTree(body.tree ?? "");
    if (!tree) return send(res, 400, { error: `unknown tree '${body.tree}'. GET /api/trees for options.` });
    if (rtCalls.size >= MAX_CALLS) rtCalls.delete(rtCalls.keys().next().value);
    const rc = new RealtimeCall(tree, body);
    const callId = randomUUID();
    rtCalls.set(callId, rc);
    rc.start();
    return send(res, 201, { callId, payer: tree.payer, stream: `/api/rt/calls/${callId}/events` });
  }
  const rtm = path.match(/^\/api\/rt\/calls\/([0-9a-f-]+)(\/events|\/input|\/hangup)?$/);
  if (rtm) {
    const rc = rtCalls.get(rtm[1]);
    if (!rc) return send(res, 404, { error: "no such realtime call" });
    if (req.method === "GET" && rtm[2] === "/events") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      const write = (ev) => res.write(`data: ${JSON.stringify(ev)}\n\n`);
      for (const ev of rc.events) write(ev);            // replay history
      const unsub = rc.onEvent((ev) => { write(ev); if (ev.kind === "ended") res.end(); });
      req.on("close", unsub);
      if (rc.events.some((e) => e.kind === "ended")) res.end();
      return;
    }
    if (req.method === "POST" && rtm[2] === "/input") {
      const body = await readBody(req);
      if (!body.type || body.value === undefined) return send(res, 400, { error: "need { type: 'dtmf'|'speech', value }" });
      rc.sendInput({ type: body.type, value: String(body.value) });
      return send(res, 202, { accepted: true, note: "response arrives on the event stream, like a real call" });
    }
    if (req.method === "POST" && rtm[2] === "/hangup") { rc.hangup(); return send(res, 200, { ended: true }); }
  }

  const m = path.match(/^\/api\/calls\/([0-9a-f-]+)(\/input|\/rep)?$/);
  if (m) {
    const entry = calls.get(m[1]);
    if (!entry) return send(res, 404, { error: "no such call" });
    const { call } = entry;

    if (req.method === "POST" && m[2] === "/input") {
      const body = await readBody(req);
      if (!body.type || body.value === undefined) return send(res, 400, { error: "need { type: 'dtmf'|'speech', value }" });
      const event = call.input({ type: body.type, value: String(body.value) });
      return send(res, 200, { event });
    }
    if (req.method === "GET" && m[2] === "/rep") {
      const node = call.tree.nodes[call.nodeId];
      if (!call._ended && node?.kind !== "hold") {
        return send(res, 409, { error: "call is not on hold; /rep only resolves from a hold state" });
      }
      const event = await call.waitForRep();
      return send(res, 200, { event });
    }
    if (req.method === "GET" && !m[2]) {
      return send(res, 200, {
        ended: call._ended,
        node: call.nodeId,
        captured: call.captured,
        holdTimeMs: call.holdTimeMs(),
        transcript: call.transcript(),
      });
    }
  }
  return send(res, 404, { error: "unknown API route" });
}

export function startServer(port = 0) {
  const server = createServer(async (req, res) => {
    try {
      const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
      if (path.startsWith("/api/")) return await handleApi(req, res, path);
      let p = path === "/" ? "/web/index.html" : path;
      const file = normalize(join(ROOT, p));
      if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end("forbidden"); }
      const body = await readFile(file);
      res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
      res.end(body);
    } catch (e) {
      if (e instanceof SyntaxError) return send(res, 400, { error: "invalid JSON body" });
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
    }
  });
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = process.env.PORT || 4321;
  startServer(port).then(() => {
    console.log(`Voice Agent Sandbox web UI  -> http://localhost:${port}`);
    console.log(`Agent Call API              -> http://localhost:${port}/api/trees`);
  });
}
