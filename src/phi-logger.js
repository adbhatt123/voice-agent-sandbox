// @ts-check
/**
 * PHI-style masking logger + leak scanner.
 * Everything in this sandbox is synthetic, but it gets logged AS IF it were
 * real PHI: masked identifiers, no raw values in any sink. Build the habit
 * here so production code inherits it.
 */

const SENSITIVE_FIELDS = new Set(["memberId", "dob", "dos", "npi", "taxId", "claimId", "icn", "authRef"]);

/** Mask an identifier, keeping the last 4 characters. "ZZT0001234X" -> "*******234X" */
export function maskId(value) {
  const s = String(value ?? "");
  if (s.length <= 4) return "*".repeat(s.length);
  return "*".repeat(s.length - 4) + s.slice(-4);
}

/**
 * Create a logger that auto-masks known sensitive fields.
 * @param {{sink?: (line:string)=>void}} [opts] default sink: console.log
 */
export function createLogger(opts = {}) {
  const sink = opts.sink ?? ((l) => console.log(l));
  const lines = [];
  function log(level, msg, fields = {}) {
    const safe = {};
    for (const [k, v] of Object.entries(fields)) {
      safe[k] = SENSITIVE_FIELDS.has(k) ? maskId(v) : v;
    }
    const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...safe });
    lines.push(line);
    sink(line);
    return line;
  }
  return {
    info: (m, f) => log("info", m, f),
    warn: (m, f) => log("warn", m, f),
    error: (m, f) => log("error", m, f),
    dump: () => lines.join("\n"),
  };
}

/**
 * Scan any text (logs, transcripts) for unmasked identifiers.
 * @param {string} text
 * @param {string[]} identifiers raw sensitive values that must NOT appear
 * @returns {string[]} the identifiers that leaked
 */
export function scanForLeaks(text, identifiers) {
  const leaks = [];
  for (const id of identifiers) {
    const s = String(id ?? "");
    if (!s || s.length <= 4) continue;
    if (text.includes(s)) leaks.push(s);
  }
  return leaks;
}
