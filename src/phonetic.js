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
 * Letters map to their keypad digit (A/B/C->2 ... W/X/Y/Z->9) ONLY when
 * `letterMode` is "keypad"; in "reject" mode (default) throw RangeError on
 * letters, because most payer IVRs cannot take alphanumerics via DTMF and
 * silently mis-keying them is worse than failing loudly.
 * @param {string} identifier e.g. "ZZT0001234" or "061520260"
 * @param {{letterMode?:"reject"|"keypad", terminator?:string}} [opts]
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
