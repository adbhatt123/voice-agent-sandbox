// Interactive caller: YOU navigate the fake payer IVR.
// Usage: node src/cli.js [coral-health|meridian-blue|sundial-medicare|granite-medicare]
//   (via npm: npm run call -- granite-medicare)
// Inputs:  plain digits = DTMF  |  s <words> = speech  |  t = transcript  |  q = quit
import { createInterface } from "node:readline/promises";
import { readFileSync } from "node:fs";
import { IVRCall } from "./ivr-engine.js";

const name = process.argv[2] ?? "coral-health";
const tree = JSON.parse(readFileSync(new URL(`./trees/${name}.json`, import.meta.url)));
const call = new IVRCall(tree, { seed: Date.now() % 100000, holdScale: 0.005 });
const rl = createInterface({ input: process.stdin, output: process.stdout });
const closed = new Promise((res) => rl.once("close", () => res("q")));

console.log(`\n=== Dialing ${tree.payer} at ${tree.phone} (simulated) ===`);
console.log(`(plain digits = DTMF, "s one five zero" = speech, "t" = transcript, "q" = quit)\n`);

let ev = call.start();
render(ev);

while (!(ev.kind === "ended" || ev.kind === "rep" || (ev.kind === "readout" && !ev.followup))) {
  if (ev.kind === "hold") {
    process.stdout.write("  [on hold");
    const tick = setInterval(() => process.stdout.write("."), 200);
    ev = await call.waitForRep();
    clearInterval(tick);
    console.log("]");
    render(ev);
    break;
  }
  const raw = (await Promise.race([rl.question("> "), closed])).trim();
  if (raw === "q") break;
  if (raw === "t") { console.log("\n--- transcript ---\n" + call.transcript() + "\n"); continue; }
  const inp = raw.startsWith("s ")
    ? { type: "speech", value: raw.slice(2) }
    : { type: "dtmf", value: raw };
  ev = call.input(inp);
  render(ev);
}

if (ev.kind === "rep") {
  console.log(`\n*** WARM TRANSFER POINT: a human rep is live after ${Math.round(call.holdTimeMs() / 1000)}s (scaled) on hold. ***`);
  console.log("In production, this is the moment the biller is bridged in with a screen-pop.");
}
rl.close();

function render(e) {
  const tag = { prompt: "IVR", reprompt: "IVR!", confirm: "IVR?", hold: "IVR~", rep: "REP", readout: "IVR=", ended: "END" }[e.kind] ?? e.kind;
  console.log(`[${tag}] ${e.text}`);
  if (e.followup) console.log(`[IVR] ${e.followup}`);
}
