// Normalises a user-typed business website.
//
// Its own module, dependency-free, for the same reason as voicePrompt.ts and
// voicePresets.ts: provisionTenant.ts imports the database, so anything living
// there cannot be unit-tested without a live connection string.

/** A fetchable https URL, or null when the input isn't a usable public site.
 *
 * The value is handed to Anthropic's SERVER-SIDE web_fetch, so a hostile URL
 * cannot be used to probe our own network - the request never originates from
 * our infrastructure. This filter exists so that obvious junk ("localhost",
 * a file:// path, a typo) is dropped rather than burning a tool call and
 * confusing the model. */
export function normalizeWebsite(raw: string | null | undefined): string | null {
  const t = (raw || "").trim();
  if (!t) return null;

  let u: URL;
  try {
    u = new URL(/^https?:\/\//i.test(t) ? t : `https://${t}`);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  // Must look like a real public domain: rules out localhost, bare hostnames
  // and raw IPs, none of which are a business's website.
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/i.test(u.hostname)) return null;
  return u.toString();
}
