// Normalising Indian mobile numbers to E.164.
//
// Its own dependency-free module, like voicePresets.ts and answerStyle.ts, so
// both the signup path and the telephony path can share ONE implementation.
// They were about to have two: businessAuth normalised what the owner typed,
// while the Vobiz caller number was passed through raw from an environment
// variable - so "+91 80715 80725" typed into a Vercel field was rejected by
// the carrier with an error nobody could see.

/** Indian mobile numbers, normalised to E.164 so one person cannot end up with
 * two accounts by typing the same number two ways.
 *
 * Returns null for anything that is not a plausible Indian mobile. */
export function normalizeMobile(raw: string): string | null {
  const digits = (raw || "").replace(/[^\d+]/g, "");
  let n = digits;
  if (n.startsWith("+")) n = n.slice(1);
  if (n.startsWith("00")) n = n.slice(2);
  if (n.startsWith("91") && n.length === 12) n = n.slice(2);
  if (n.startsWith("0") && n.length === 11) n = n.slice(1);
  if (!/^[6-9]\d{9}$/.test(n)) return null; // Indian mobiles start 6-9
  return `+91${n}`;
}
