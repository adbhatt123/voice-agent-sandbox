import { test } from "node:test";
import assert from "node:assert/strict";
import { maskId, createLogger, scanForLeaks } from "../src/phi-logger.js";

test("maskId keeps last 4 only", () => {
  assert.equal(maskId("ZZT0001234X"), "*******234X");
  assert.equal(maskId("1234"), "****");
  assert.equal(maskId(""), "");
});

test("logger masks sensitive fields, passes others", () => {
  const out = [];
  const log = createLogger({ sink: (l) => out.push(l) });
  log.info("entered member id", { memberId: "ZZT0001234X", payer: "Coral Health", node: "claims-id" });
  const line = out[0];
  assert.ok(!line.includes("ZZT0001234X"));
  assert.ok(line.includes("234X"));
  assert.ok(line.includes("Coral Health"));
});

test("scanForLeaks catches raw identifiers anywhere in text", () => {
  const ids = ["ZZT0001234X", "555000123"];
  const dirty = "IVR heard ZZT0001234X at node claims-id";
  const clean = "IVR heard *******234X at node claims-id";
  assert.deepEqual(scanForLeaks(dirty, ids), ["ZZT0001234X"]);
  assert.deepEqual(scanForLeaks(clean, ids), []);
});

test("end-to-end habit: agent log dump stays leak-free", () => {
  const log = createLogger({ sink: () => {} });
  const memberId = "ABC1234567Z";
  log.info("capture", { memberId });
  log.warn("retry", { memberId, attempt: 2 });
  assert.deepEqual(scanForLeaks(log.dump(), [memberId]), []);
});
