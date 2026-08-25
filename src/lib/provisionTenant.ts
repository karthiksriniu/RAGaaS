import Anthropic from "@anthropic-ai/sdk";
import { pool } from "@/lib/db";
import { createTenant } from "@/lib/tenants";
import { ingestText } from "@/lib/ingestText";
import { normalizeWebsite } from "@/lib/websiteUrl";
import { DEFAULT_ANSWER_STYLE_MD } from "@/lib/answerStyle";

// Everything that happens after a business "pays": create its tenant, give it a
// number, and make its agent useful on day one.

const RESERVED = new Set(["www", "admin", "api", "staging", "app", "mail", "support", "help"]);

/** Slugified business name, deduped. The tenant id is permanent and appears in
 * the business's subdomain, so it is derived once at signup and never edited -
 * changing it later would orphan a live URL and every chunk keyed to it. */
export async function deriveTenantId(businessName: string): Promise<string> {
  const base =
    businessName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32) || "business";

  for (let i = 0; i < 50; i++) {
    const candidate = i === 0 ? base : `${base}-${i + 1}`;
    if (RESERVED.has(candidate)) continue;
    const taken = await pool.query("SELECT 1 FROM tenants WHERE id = $1 OR subdomain = $1", [
      candidate,
    ]);
    if (taken.rows.length === 0) return candidate;
  }
  throw new Error(`Could not derive a free tenant id from "${businessName}"`);
}

/** DEMO ONLY. When the pool has no free number, hand the new tenant the
 * longest-held one, taking it away from whoever has it.
 *
 * This exists because numbers cost real money and the demo phase needs more
 * signups than numbers. It is destructive: the previous tenant's phone line
 * stops working with no warning to them, and their callers reach a different
 * business. That is acceptable for prospect demos and NEVER acceptable once
 * signups are real, so it is off unless explicitly switched on. */
function recyclingEnabled(): boolean {
  return process.env.NUMBER_POOL_RECYCLE === "true";
}

/** Claims a free number from the pre-bought pool.
 *
 * The UPDATE ... WHERE tenant_id IS NULL is what makes this safe: two
 * simultaneous signups cannot be handed the same number, because only one
 * update can match a given row. Returns null when the pool is empty, which the
 * caller surfaces rather than failing the whole signup - the business still
 * gets a working account, just no number until the pool is topped up. */
export async function claimPooledNumber(tenantId: string): Promise<string | null> {
  const res = await pool.query<{ e164: string }>(
    `UPDATE phone_number_pool
        SET tenant_id = $1, claimed_at = now()
      WHERE e164 = (
        SELECT e164 FROM phone_number_pool
         WHERE tenant_id IS NULL
         ORDER BY created_at
         FOR UPDATE SKIP LOCKED
         LIMIT 1)
      RETURNING e164`,
    [tenantId]
  );
  const e164 = res.rows[0]?.e164 ?? null;
  if (e164) {
    await pool.query("UPDATE tenants SET voice_phone_number = $2 WHERE id = $1", [tenantId, e164]);
    return e164;
  }

  if (!recyclingEnabled()) return null;
  return recycleOldestNumber(tenantId);
}

/** Takes the least-recently-claimed number from its current holder.
 *
 * One transaction start to finish: the row is locked with FOR UPDATE before it
 * is read, so two simultaneous signups cannot both reclaim the same number and
 * leave one tenant silently without a line. Least-recently-claimed rather than
 * random so the rotation is predictable - the two most recent signups always
 * hold the numbers, which is exactly what a demo needs. */
async function recycleOldestNumber(tenantId: string): Promise<string | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const picked = await client.query<{ e164: string; tenant_id: string | null }>(
      `SELECT e164, tenant_id FROM phone_number_pool
        WHERE tenant_id IS NOT NULL AND tenant_id <> $1
        ORDER BY claimed_at NULLS FIRST
        FOR UPDATE SKIP LOCKED
        LIMIT 1`,
      [tenantId]
    );
    const row = picked.rows[0];
    if (!row) {
      await client.query("ROLLBACK");
      return null;
    }

    // Clear the old holder FIRST. If anything below fails, the transaction
    // rolls back whole - a number is never left pointing at two tenants, which
    // would route one business's callers to another.
    if (row.tenant_id) {
      await client.query("UPDATE tenants SET voice_phone_number = NULL WHERE id = $1", [row.tenant_id]);
    }
    await client.query(
      "UPDATE phone_number_pool SET tenant_id = $2, claimed_at = now() WHERE e164 = $1",
      [row.e164, tenantId]
    );
    await client.query("UPDATE tenants SET voice_phone_number = $2 WHERE id = $1", [tenantId, row.e164]);
    await client.query("COMMIT");

    // Loud on purpose: someone lost their phone line.
    console.warn(
      `[number-pool] RECYCLED ${row.e164} from tenant "${row.tenant_id}" to "${tenantId}" - ` +
        `the previous tenant no longer has a working number.`
    );
    return row.e164;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

/** Writes a starter knowledge base, from the business description and - when
 * one is given - the business's own website.
 *
 * The website is read via Anthropic's SERVER-SIDE web_fetch/web_search tools
 * rather than fetching it ourselves. That matters for two reasons: the fetch
 * happens on Anthropic's infrastructure, so a user-supplied URL can never be
 * used to probe our own network (SSRF), and we get extraction and redirect
 * handling for free instead of hand-rolling an HTML parser.
 *
 * This content is INVENTED or SUMMARISED, not verified by the business. It is
 * ingested under a clearly-labelled source name so it is obvious in the
 * Knowledge Sources list and deletable in one click. */
export async function generateStarterKb(
  businessName: string,
  description: string,
  websiteUrl?: string | null
): Promise<string> {
  const site = normalizeWebsite(websiteUrl);

  const rules = [
    "You write starter knowledge-base documents for a business's customer-service AI agent.",
    "Output GitHub-flavoured Markdown only: a short '## Section' per topic, with plain paragraphs or '- ' bullets underneath. No preamble, no closing remarks, no code fences.",
    "",
    "Everything you write will be spoken to real customers by an AI agent that treats it as fact. So:",
    "- Anything taken from the business's own website - services, pricing, hours, policies, locations, guarantees - is good material. Prefer it over anything you infer.",
    "- NEVER invent a specific you cannot support: no made-up prices, phone numbers, addresses, opening hours, staff names, or delivery times. If a topic needs such a specific and the site does not give it, write the guidance and say the customer will be told the detail by the business.",
    "- Write what makes this business distinctive in ITS OWN terms - what it emphasises about itself, who it serves, what it is known for.",
    "- Do NOT name, compare against, or make claims about competitors. An agent repeating an unverified claim about another company to a caller is a real liability, and you cannot verify one. Positioning is fine; comparison is not.",
    "- Do not describe the business as best, cheapest, or number one unless the site says so and you attribute it to the business.",
    "",
    "ALWAYS open with a '## What we do' section: two or three plain sentences answering \"what does this business do?\" in the words a customer would use, not marketing language. Callers ask this more than anything else, and a document that only covers specific topics fails to answer it.",
  ].join("\n");

  const ask = site
    ? `Business name: ${businessName}\nWhat they do: ${description || "(not given)"}\nWebsite: ${site}\n\nFetch the homepage, then at most three more pages - whichever of services, pricing, about or FAQ exist. Do not crawl further; work with what those give you. Then write the starter knowledge base, covering what they offer, what makes them distinctive, pricing if the site states it, how customers get started, and the questions customers most commonly ask.`
    : `Business name: ${businessName}\nWhat they do: ${description}\n\nWrite the starter knowledge base.`;

  const msg = await anthropic.messages.create({
    model: "claude-sonnet-5",
    max_tokens: 5000,
    system: rules,
    // Only offered when there is a site to read; without one the tools are
    // just latency and a chance to wander onto pages about other companies.
    // web_fetch ONLY, and a tight budget. Two reasons: reading a large site
    // with 8 fetches plus search took 237s, which is far too long to hold a
    // signup screen; and web_search is what pulls in third-party pages about
    // OTHER companies, which is exactly the content we do not want the agent
    // repeating to callers. The business's own site is the source of truth.
    ...(site
      ? { tools: [{ type: "web_fetch_20260209" as const, name: "web_fetch", max_uses: 4 }] }
      : {}),
    messages: [{ role: "user", content: ask }],
  });

  // With server tools the reply interleaves text and tool-result blocks, and
  // the text BETWEEN fetches is the model talking to itself - "I have enough
  // content now... Let me write the knowledge base now." Taking every text
  // block swept that narration into the knowledge base, where it became a
  // retrievable chunk that outscored real content on pricing questions.
  //
  // The document is what comes after the LAST tool use, so only those blocks
  // are kept. Falls back to all text when no tool ran (the no-website path),
  // where there is no narration to strip.
  const lastToolUse = msg.content.reduce(
    (last, block, i) => (block.type === "text" ? last : i),
    -1
  );
  const documentBlocks = lastToolUse === -1 ? msg.content : msg.content.slice(lastToolUse + 1);

  return documentBlocks
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n\n")
    .trim();
}

/** One source name for both passes, so the website-informed document replaces
 * the quick one instead of duplicating it. */
export const STARTER_KB_SOURCE = "Starter knowledge (auto-generated)";

export interface ProvisionResult {
  tenantId: string;
  phoneNumber: string | null;
  starterKbChunks: number;
  /** Set when a website was given and still needs reading in the background. */
  websiteToRead: string | null;
}

/** Creates the tenant, claims a number, seeds the agent's answer-style config
 * from the description, and generates a starter KB.
 *
 * Ordering: the tenant and number come first because they are what the business
 * needs to exist. KB generation is best-effort - it calls an LLM and could fail
 * or be slow, and a business with a working account and an empty KB is a far
 * better outcome than a failed signup. */
export async function provisionTenant(
  businessName: string,
  description: string,
  websiteUrl?: string | null
): Promise<ProvisionResult> {
  const website = normalizeWebsite(websiteUrl);
  const tenantId = await deriveTenantId(businessName);

  await createTenant({
    id: tenantId,
    name: businessName,
    subdomain: tenantId,
    licenseExpiresAt: null,
  });

  // The description is stored, but ONLY as raw material for generating the
  // knowledge base below - it is deliberately NOT copied into the answer-style
  // config. See answerStyle.ts: a business summary sitting in the prompt
  // competes with retrieved knowledge and wins often enough to matter.
  //
  // Every tenant gets the same starting answer style, which they can then edit.
  const trimmed = description.trim();
  await pool.query(
    "UPDATE tenants SET business_description = $2, answer_config_md = $3, website_url = $4 WHERE id = $1",
    [tenantId, trimmed || null, DEFAULT_ANSWER_STYLE_MD, website]
  );

  const phoneNumber = await claimPooledNumber(tenantId);

  // The FAST pass only: name and description, no website. Reading a site takes
  // 60-80s, which is far too long to hold someone on the provisioning screen,
  // so it runs afterwards - see enhanceKbFromWebsite().
  let starterKbChunks = 0;
  if (trimmed) {
    try {
      const md = await generateStarterKb(businessName, trimmed, null);
      if (md) {
        const r = await ingestText(tenantId, STARTER_KB_SOURCE, md, "generated");
        starterKbChunks = r.chunksIngested;
      }
    } catch (err) {
      // Best-effort by design - see the docstring above.
      console.error(`starter KB generation failed for ${tenantId}:`, err);
    }
  }

  // Only mark work pending when there is actually a site to read, so the
  // dashboard doesn't show "reading your website" to someone who gave none.
  if (website) {
    await pool.query("UPDATE tenants SET kb_enhancement_status = 'pending' WHERE id = $1", [tenantId]);
  }

  return { tenantId, phoneNumber, starterKbChunks, websiteToRead: website };
}

/** The SLOW pass: re-generate the starter KB from the business's own website.
 *
 * Runs after the signup response via after(), so the business is never held
 * waiting on it. Writes to the SAME source name as the fast pass, so the
 * richer document replaces the thin one rather than sitting alongside it -
 * two overlapping documents about one business would compete in retrieval.
 *
 * Records its outcome on the tenant. A background failure is otherwise
 * completely silent: the business would simply never receive the better KB and
 * have no way to know, or to ask for it again. */
export async function enhanceKbFromWebsite(
  tenantId: string,
  businessName: string,
  description: string,
  websiteUrl: string
): Promise<void> {
  try {
    const md = await generateStarterKb(businessName, description, websiteUrl);
    if (!md) throw new Error("the model returned nothing for this website");

    const r = await ingestText(tenantId, STARTER_KB_SOURCE, md, "generated");
    await pool.query(
      "UPDATE tenants SET kb_enhancement_status = 'done', kb_enhancement_error = NULL WHERE id = $1",
      [tenantId]
    );
    console.log(`[kb-enhance] ${tenantId}: ${r.chunksIngested} chunks from ${websiteUrl}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[kb-enhance] ${tenantId} FAILED:`, message);
    // The fast-pass KB is untouched, so the agent still works - just with the
    // thinner document.
    await pool
      .query(
        "UPDATE tenants SET kb_enhancement_status = 'failed', kb_enhancement_error = $2 WHERE id = $1",
        [tenantId, message.slice(0, 500)]
      )
      .catch(() => {});
  }
}
