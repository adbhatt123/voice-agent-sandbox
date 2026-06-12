// @ts-check
/**
 * Phonetic / dialing library — Layer 2 of the brief. THIS IS YOUR DELIVERABLE.
 * Implement these as pure functions (no I/O, no state). The golden test suite
 * in test/phonetic.test.js defines exact expected behavior; tests currently
 * report as skipped and will activate as you implement each function.
 *
 * PHI rule that motivates this module: prefer DTMF whenever the IVR accepts
 * it (reliable, keeps identifiers out of speech logs); fall back to phonetic
 * speech only when a tree demands voice.
 */

export class NotImplementedError extends Error {
  constructor(fn) { super(`${fn} not implemented yet`); this.name = "NotImplementedError"; }
}

/**
 * Identifier -> DTMF keypress string.
 * letterMode controls letters:
 *  - "reject" (default): throw RangeError on letters. Most payer IVRs cannot
 *    take alphanumerics via DTMF; silently mis-keying is worse than failing.
 *  - "keypad": letter -> its key, one press (A/B/C->2 ... W/X/Y/Z->9).
 *  - "multitap": phone-keypad letter entry, "for C press 2 three times".
 *    Each character becomes the key pressed N times (N = letter position;
 *    digits on lettered keys take letters+1 presses, so "2" -> "2222"),
 *    characters joined with "w" (a pause, telephony SDK notation).
 *    "P01234" -> "7w0w1w2222w3333w4444". Granite Medicare's PTAN node
 *    accepts exactly this format; the engine's decodeMultitap() reverses it.
 * @param {string} identifier e.g. "ZZT0001234" or "061520260"
 * @param {{letterMode?:"reject"|"keypad"|"multitap", terminator?:string}} [opts]
 * @returns {string} e.g. "061520260#"
 */
export function toDtmf(identifier, opts = {}) {
  throw new NotImplementedError("toDtmf");
}

/**
 * Identifier -> unambiguous NATO spelling for voice entry.
 * "A1B2" -> "Alpha One Bravo Two"
 * @param {string} identifier
 * @returns {string}
 */
export function toNatoSpeech(identifier) {
  throw new NotImplementedError("toNatoSpeech");
}

/**
 * Digit string -> controlled-pace digit speech, one digit per token,
 * never multi-digit words (no "fifteen"/"fifty" ambiguity).
 * "150" -> "one. five. zero."  (the period marks a pause for the TTS layer)
 * @param {string} digits
 * @returns {string}
 */
export function toPacedDigits(digits) {
  throw new NotImplementedError("toPacedDigits");
}

/**
 * Date -> spoken form that no IVR can mis-bucket.
 * ("2026-06-15") -> "June fifteenth, two thousand twenty six" is AMBIGUOUS
 * for "fifteenth/fiftieth" under bad ASR, so required output is paced digits
 * in MMDDYYYY: "zero six. one five. two zero two six."
 * @param {string} isoDate "YYYY-MM-DD"
 * @returns {string}
 */
export function dateToPacedSpeech(isoDate) {
  throw new NotImplementedError("dateToPacedSpeech");
}
