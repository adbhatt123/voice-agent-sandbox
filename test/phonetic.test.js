// Golden test suite for the phonetic library (YOUR deliverable).
// Tests skip while a function throws NotImplementedError and activate as you
// implement. Definition of done: zero skips, zero failures.
import { test } from "node:test";
import assert from "node:assert/strict";
import { toDtmf, toNatoSpeech, toPacedDigits, dateToPacedSpeech, NotImplementedError } from "../src/phonetic.js";

function golden(name, fn) {
  test(name, (t) => {
    try { fn(); } catch (e) {
      if (e instanceof NotImplementedError) return t.skip("pending implementation");
      throw e;
    }
  });
}

// ---- toDtmf ----
golden("toDtmf: digits pass through with default # terminator", () => {
  assert.equal(toDtmf("061520260"), "061520260#");
});
golden("toDtmf: custom terminator and none", () => {
  assert.equal(toDtmf("12345", { terminator: "" }), "12345");
  assert.equal(toDtmf("12345", { terminator: "*" }), "12345*");
});
golden("toDtmf: rejects letters by default (fail loudly, never mis-key)", () => {
  toDtmf("0");
  assert.throws(() => toDtmf("ZZT0001234X"), RangeError);
});
golden("toDtmf: keypad letterMode maps letters to digits", () => {
  assert.equal(toDtmf("ADGJMPTW", { letterMode: "keypad", terminator: "" }), "23456789");
  assert.equal(toDtmf("Z", { letterMode: "keypad", terminator: "" }), "9");
});
golden("toDtmf: strips separators, rejects anything else", () => {
  assert.equal(toDtmf("061-52-0260", { terminator: "" }), "061520260");
  toDtmf("0");
  assert.throws(() => toDtmf("12!45"), RangeError);
});

golden("toDtmf: multitap letterMode (press 2 three times for C)", () => {
  assert.equal(toDtmf("C", { letterMode: "multitap", terminator: "" }), "222");
  assert.equal(toDtmf("AB2", { letterMode: "multitap", terminator: "" }), "2w22w2222");
});
golden("toDtmf: multitap round-trips a Granite Medicare PTAN", () => {
  assert.equal(toDtmf("P01234", { letterMode: "multitap", terminator: "" }), "7w0w1w2222w3333w4444");
});

// ---- toNatoSpeech ----
golden("toNatoSpeech: alphanumerics", () => {
  assert.equal(toNatoSpeech("A1B2"), "Alpha One Bravo Two");
});
golden("toNatoSpeech: full member id", () => {
  assert.equal(
    toNatoSpeech("ZZT0001234X"),
    "Zulu Zulu Tango Zero Zero Zero One Two Three Four Xray"
  );
});

// ---- toPacedDigits ----
golden("toPacedDigits: one digit per token with pause markers", () => {
  assert.equal(toPacedDigits("150"), "one. five. zero.");
});
golden("toPacedDigits: never produces multi-digit words", () => {
  const out = toPacedDigits("1550");
  assert.ok(!/fifteen|fifty/i.test(out));
  assert.equal(out, "one. five. five. zero.");
});

// ---- dateToPacedSpeech ----
golden("dateToPacedSpeech: MMDDYYYY paced digits", () => {
  assert.equal(dateToPacedSpeech("2026-06-15"), "zero six. one five. two zero two six.");
});
golden("dateToPacedSpeech: rejects invalid dates", () => {
  dateToPacedSpeech("2026-06-15");
  assert.throws(() => dateToPacedSpeech("2026-13-40"), RangeError);
  assert.throws(() => dateToPacedSpeech("June 15"), RangeError);
});
