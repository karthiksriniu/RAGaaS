import { lookup } from "dns/promises";

// Reading a business's website, ourselves.
//
// This replaces handing the URL to Anthropic's server-side web_fetch. That was
// chosen for a good reason - a user-supplied URL fetched on Anthropic's
// infrastructure can never probe ours - but measured against a real site it
// took 200s and 275,100 input tokens for one signup, because the _20260209
// web_fetch variant carries a code-execution sandbox with it: the model wrote
// Python to slice the page text, called sleep, shelled out, and finally saved
// the document to a file inside the sandbox instead of returning it. See the
// note in provisionTenant.generateStarterKb.
//
// Fetching two levels ourselves is a few hundred milliseconds and a few
// thousand tokens. The cost is that SSRF is now our problem, which is what
// most of this file is about.

/** Everything past the homepage is chosen from links the homepage itself
 * carries - one hop, no deeper. Enough to pick up About / Services / Pricing /
 * FAQ, which is where a small business actually describes itself. */
export const MAX_PAGES = 6;
const PER_PAGE_TIMEOUT_MS = 8000;
const MAX_BYTES = 2_000_000;
const MAX_REDIRECTS = 3;
/** Per page, and across all of them. A single category page on a marketplace
 * site measured 38,580 characters on its own - without the total budget, one
 * site could put 60k tokens into a prompt that needs about 8k. */
const MAX_TEXT_CHARS = 15_000;
const MAX_TOTAL_CHARS = 50_000;

/** Path fragments worth a second hop, best first. A business says what it does
 * on these pages; everything else is usually a shop, a blog or a login.
 *
 * AT MOST ONE PAGE PER ENTRY. Without that rule an online shop spends every
 * slot on individual product pages - measured on two real sites, one returned
 * four separate tea SKUs and the other a single pair of spectacles, none of
 * which tells a customer-service agent anything general. One per kind buys
 * breadth (about + services + pricing + FAQ) instead of depth into a catalogue. */
const WORTH_FETCHING = [
  /\babout\b/i,
  /\bservices?\b/i,
  /\b(pricing|prices|rates|plans|packages|tariff)\b/i,
  /\bfaq/i,
  /\b(contact|locations?|branches?|hours)\b/i,
  // Last: a catalogue landing page is worth something, one product page is not.
  /\b(treatments?|menu|courses?|categor(y|ies)|collections?)\b/i,
];

/** Never worth a hop: transactional, legal or endlessly paginated. */
const NOT_WORTH_FETCHING =
  /\b(login|signin|sign-in|register|signup|cart|checkout|account|privacy|terms|policy|sitemap|blog|news|careers?|jobs)\b/i;

const NON_HTML_EXTENSION = /\.(pdf|jpe?g|png|gif|svg|webp|ico|css|js|zip|mp4|mp3|docx?|xlsx?)$/i;

/** Is this address one we must never let a user-supplied URL reach?
 *
 * Everything not routable on the public internet: loopback, RFC1918, the
 * link-local range that fronts cloud metadata services (169.254.169.254 is the
 * one that matters), carrier NAT, multicast, and the IPv6 equivalents. Exported
 * for its own tests - this is the function that has to be right. */
export function isPrivateAddress(ip: string): boolean {
  // IPv4-mapped IPv6 ("::ffff:169.254.169.254") is the same address wearing a
  // different hat, and must be judged as the IPv4 one it embeds.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return isPrivateAddress(mapped[1]);

  if (ip.includes(":")) {
    const v6 = ip.toLowerCase();
    if (v6 === "::" || v6 === "::1") return true;
    if (/^f[cd][0-9a-f]{2}:/.test(v6)) return true; // fc00::/7 unique local
    if (/^fe[89ab][0-9a-f]:/.test(v6)) return true; // fe80::/10 link local
    if (/^ff[0-9a-f]{2}:/.test(v6)) return true; // multicast
    return false;
  }

  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true; // Unparseable is not provably public, so treat it as private.
  }
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 CGNAT
  if (a === 169 && b === 254) return true; // link-local / cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0 && parts[2] === 0) return true;
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a >= 224) return true; // multicast + reserved
  return false;
}

/** Resolves a hostname and refuses it unless EVERY address it answers with is
 * public.
 *
 * Every address, not the first: a hostname that returns one public and one
 * private address is a rebinding attempt, and which one the eventual connection
 * uses is not ours to choose. */
async function assertPublicHost(hostname: string): Promise<void> {
  // An IP literal never needs resolving and is never a business's website.
  if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname) || hostname.includes(":")) {
    throw new BlockedUrlError(`${hostname} is an IP address, not a website`);
  }
  let addresses: { address: string }[];
  try {
    addresses = await lookup(hostname, { all: true });
  } catch {
    throw new BlockedUrlError(`${hostname} does not resolve`);
  }
  if (addresses.length === 0) throw new BlockedUrlError(`${hostname} does not resolve`);
  for (const { address } of addresses) {
    if (isPrivateAddress(address)) {
      throw new BlockedUrlError(`${hostname} resolves to a private address`);
    }
  }
}

export class BlockedUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BlockedUrlError";
  }
}

/** Fetches one page, checking the destination at every redirect hop.
 *
 * Redirects are followed by hand rather than by fetch itself, because a
 * validated public URL that 302s to http://169.254.169.254/ is exactly the
 * attack this is guarding against, and fetch's own redirect handling would
 * never give us a chance to look. */
async function fetchPage(rawUrl: string, timeoutMs: number): Promise<{ url: string; html: string }> {
  let url = new URL(rawUrl);

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new BlockedUrlError(`${url.protocol} is not a web address`);
    }
    await assertPublicHost(url.hostname);

    const res = await fetch(url.toString(), {
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        // Honest about who we are, and what we can use. Some sites serve a
        // JS-only shell to unknown agents; nothing we can do about that here.
        "User-Agent": "MyBizCareBot/1.0 (+https://mybizcare.com; reads your site to set up your own AI agent)",
        Accept: "text/html,application/xhtml+xml",
      },
    });

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) throw new Error(`${res.status} with no destination`);
      url = new URL(location, url);
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const type = res.headers.get("content-type") || "";
    if (!/text\/html|application\/xhtml/i.test(type)) {
      throw new Error(`not a web page (${type.split(";")[0] || "unknown type"})`);
    }

    // Read with a ceiling rather than res.text(): a multi-megabyte page is
    // either a mistake or a deliberate one, and neither deserves the memory.
    const buffer = await res.arrayBuffer();
    const html = new TextDecoder("utf-8").decode(buffer.slice(0, MAX_BYTES));
    return { url: url.toString(), html };
  }
  throw new Error("too many redirects");
}

/** Readable text from an HTML page.
 *
 * Deliberately crude. The consumer is an LLM writing a summary, not a parser -
 * it needs the words in roughly the right order, and none of the markup. Script
 * and style content is dropped outright: leaving it in was the difference
 * between a page of prose and a page of minified JavaScript. */
export function htmlToText(html: string): string {
  const text = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|iframe)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    // Block-level tags become line breaks so headings and list items don't run
    // into the sentence after them.
    .replace(/<\/?(p|div|section|article|h[1-6]|li|tr|br|hr|ul|ol|table|header|footer|nav)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/[ \t ]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
  return text.slice(0, MAX_TEXT_CHARS);
}

export function pageTitle(html: string): string {
  const m = /<title[^>]*>([\s\S]{0,300}?)<\/title>/i.exec(html);
  return m ? m[1].replace(/\s+/g, " ").trim() : "";
}

/** The second level: which of the homepage's own links are worth a fetch.
 *
 * Same host only. A business's About page is on its own domain; an off-domain
 * link is a payment provider, a social profile or an ad, and following one
 * would put someone else's copy into this business's knowledge base. */
export function pickLinks(html: string, baseUrl: string, limit: number): string[] {
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    return [];
  }

  const seen = new Set<string>([normalizeForDedupe(base)]);
  const ranked: { url: string; rank: number }[] = [];

  for (const m of html.matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"']+)["']/gi)) {
    // An href in the markup is HTML-escaped, so a query string arrives as
    // "?a=1&amp;b=2". Fetching that literally asks for a parameter named
    // "amp;b" - harmless on some sites, a 404 on others.
    const href = decodeHtmlEntities(m[1].trim());
    if (!href || href.startsWith("#") || /^(mailto|tel|javascript|data):/i.test(href)) continue;

    let u: URL;
    try {
      u = new URL(href, base);
    } catch {
      continue;
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") continue;
    if (u.hostname !== base.hostname) continue;
    if (NON_HTML_EXTENSION.test(u.pathname)) continue;
    if (NOT_WORTH_FETCHING.test(u.pathname)) continue;

    const key = normalizeForDedupe(u);
    if (seen.has(key)) continue;

    const rank = WORTH_FETCHING.findIndex((p) => p.test(u.pathname));
    if (rank === -1) continue; // Only pages we have a reason to want.

    seen.add(key);
    u.hash = "";
    ranked.push({ url: u.toString(), rank });
  }

  // By usefulness, not by where they happened to sit in the markup; then one
  // per kind, so a catalogue cannot crowd out the pages that describe the
  // business.
  ranked.sort((a, b) => a.rank - b.rank);
  const takenRanks = new Set<number>();
  const picked: string[] = [];
  for (const r of ranked) {
    if (takenRanks.has(r.rank)) continue;
    takenRanks.add(r.rank);
    picked.push(r.url);
    if (picked.length === limit) break;
  }
  return picked;
}

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/gi, "&")
    .replace(/&#38;/g, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
}

/** Trailing slashes and fragments are not different pages. */
function normalizeForDedupe(u: URL): string {
  return `${u.hostname}${u.pathname.replace(/\/+$/, "")}${u.search}`;
}

export interface ScrapedPage {
  url: string;
  title: string;
  text: string;
}

export interface ScrapeResult {
  pages: ScrapedPage[];
  /** Pages that could not be read, for the log. Never fatal on its own - a
   * homepage alone is still a usable knowledge base. */
  failures: string[];
}

/** Two levels: the homepage, then the pages it links to that look like they
 * describe the business.
 *
 * Throws only when the homepage itself cannot be read - with nothing at all,
 * there is no knowledge base to write and the caller needs to say so. */
export async function scrapeSite(
  websiteUrl: string,
  options: { maxPages?: number; timeoutMs?: number } = {}
): Promise<ScrapeResult> {
  const maxPages = options.maxPages ?? MAX_PAGES;
  const timeoutMs = options.timeoutMs ?? PER_PAGE_TIMEOUT_MS;

  const home = await fetchPage(websiteUrl, timeoutMs);
  const pages: ScrapedPage[] = [
    { url: home.url, title: pageTitle(home.html), text: htmlToText(home.html) },
  ];
  const failures: string[] = [];

  const links = pickLinks(home.html, home.url, maxPages - 1);
  // All at once. Sequentially this is 5 round trips of latency for no reason,
  // and the whole point of doing the fetching ourselves is that it is fast.
  const results = await Promise.allSettled(links.map((l) => fetchPage(l, timeoutMs)));

  let budget = MAX_TOTAL_CHARS - pages[0].text.length;
  results.forEach((r, i) => {
    if (r.status === "fulfilled") {
      const text = htmlToText(r.value.html).slice(0, Math.max(0, budget));
      // A page that renders to nothing is a JS shell; including it would spend
      // tokens on a URL and a title.
      if (text.length > 200) {
        budget -= text.length;
        pages.push({ url: r.value.url, title: pageTitle(r.value.html), text });
        return;
      }
      failures.push(`${links[i]}: no readable text`);
      return;
    }
    failures.push(`${links[i]}: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`);
  });

  return { pages, failures };
}
