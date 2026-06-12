// Deliberately naive example agent: shows the engine API by navigating
// coral-health end to end. It hardcodes the path; a real agent reads the
// prompt text and decides. It will NOT survive meridian-blue or sundial.
import { readFileSync } from "node:fs";
import { IVRCall } from "./ivr-engine.js";
import { createLogger, scanForLeaks } from "./phi-logger.js";

const tree = JSON.parse(readFileSync(new URL("./trees/coral-health.json", import.meta.url)));
const log = createLogger();

const SYNTHETIC_CLAIM = { payer: "Coral Health", memberId: "555000123" };

const call = new IVRCall(tree, { seed: 42, holdScale: 0.002 });

let ev = call.start();
log.info("call started", { payer: SYNTHETIC_CLAIM.payer, node: ev.node });

ev = call.input({ type: "dtmf", value: "1" });
log.info("selected claims menu", { node: ev.node });

ev = call.input({ type: "dtmf", value: SYNTHETIC_CLAIM.memberId + "#" });
log.info("entered member id via DTMF", { memberId: SYNTHETIC_CLAIM.memberId, node: ev.node });

if (ev.kind === "hold") {
  log.info("on hold, bot waits so the biller does not", {});
  ev = await call.waitForRep();
}

if (ev.kind === "rep") {
  log.info("rep answered: WARM TRANSFER NOW", { holdMs: call.holdTimeMs() });
  console.log("\n>>> bridge the biller here, with claim context on screen <<<");
}

const leaks = scanForLeaks(log.dump(), [SYNTHETIC_CLAIM.memberId]);
console.log(leaks.length === 0
  ? "\nleak scan: clean (member id never logged raw)"
  : `\nleak scan: FAILED, leaked: ${leaks}`);
