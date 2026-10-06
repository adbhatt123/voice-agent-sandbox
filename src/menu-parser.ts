/**
 * Menu option parser.
 *
 * Turns an IVR menu transcript into a list of { key, label } options, handling
 * both phrasings:
 *   - "press 1 for general information"     (label after the key)
 *   - "general information, press 1"        (label before the key)
 *
 * This is what lets the planner choose a digit by matching the LABEL to the
 * caller's goal, instead of blindly pressing the first "press N" it hears (the
 * old bug: "press star for satisfaction survey" -> pressed star).
 */

export type MenuOption = { key: string; label: string };

const WORD_KEY: Record<string, string> = {
  zero: "0", one: "1", two: "2", three: "3", four: "4",
  five: "5", six: "6", seven: "7", eight: "8", nine: "9",
  star: "*", asterisk: "*", pound: "#", hash: "#",
};

function normKey(tok: string): string | null {
  const t = tok.toLowerCase();
  if (/^[0-9*#]$/.test(t)) return t;
  return WORD_KEY[t] ?? null;
}

type Anchor = { key: string; start: number; end: number };

/** Parse selectable options out of a menu transcript. */
export function parseMenuOptions(transcript: string): MenuOption[] {
  const t = ` ${transcript.toLowerCase().replace(/[’']/g, "")} `;
  const anchorRe = /\b(?:press|say|enter|dial|select)\s+(?:the\s+)?(\d|\*|#|star|asterisk|pound|hash|zero|one|two|three|four|five|six|seven|eight|nine)(?![a-z])/gi;

  const anchors: Anchor[] = [];
  let m: RegExpExecArray | null;
  while ((m = anchorRe.exec(t)) !== null) {
    const key = normKey(m[1]!);
    if (key) anchors.push({ key, start: m.index, end: anchorRe.lastIndex });
  }

  const options: MenuOption[] = [];
  for (let i = 0; i < anchors.length; i++) {
    const a = anchors[i]!;
    const nextStart = i + 1 < anchors.length ? anchors[i + 1]!.start : t.length;

    // Prefer a label that follows the key: "press 1 for X" / "press 1 to hear X".
    const after = t.slice(a.end, nextStart);
    const afterMatch = after.match(
      /^\s*(?:key\s*)?[,:]?\s*(?:for|to(?:\s+(?:hear|reach|request|check|file|speak(?:\s+(?:to|with))?))?)\s+(.+)$/i,
    );

    let label: string;
    if (afterMatch) {
      label = afterMatch[1]!;
    } else {
      // Otherwise the label precedes the key: "X, press 1".
      const prevEnd = i > 0 ? anchors[i - 1]!.end : 0;
      label = t.slice(prevEnd, a.start);
    }

    options.push({ key: a.key, label: cleanLabel(label) });
  }
  return options;
}

function cleanLabel(raw: string): string {
  return raw
    .replace(/[.;:]/g, " ")
    .replace(/\b(or|then|and|otherwise|please)\b/gi, " ")
    .replace(/^\s*(for|to)\b/i, " ")
    .replace(/\s+/g, " ")
    .trim();
}
