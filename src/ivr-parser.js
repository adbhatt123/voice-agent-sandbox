// Extracts a DTMF digit from an IVR speech transcript.
// Returns the digit string ("0"-"9", "*", "#") or null if no instruction found.
export function parseIVRDigit(transcript) {
  const t = transcript.toLowerCase().trim();

  const wordToDigit = {
    zero: "0", one: "1", two: "2", three: "3", four: "4",
    five: "5", six: "6", seven: "7", eight: "8", nine: "9",
    star: "*", asterisk: "*", pound: "#", hash: "#",
  };

  // "press 1" / "dial 1" / "enter 1" / "say 1"
  let m = t.match(/(?:press|dial|enter|say)\s+(\d)/);
  if (m) return m[1];

  // "press one" / "dial two" / "enter star" etc.
  const words = Object.keys(wordToDigit).join("|");
  m = t.match(new RegExp(`(?:press|dial|enter|say)\\s+(${words})`));
  if (m) return wordToDigit[m[1]];

  return null;
}
