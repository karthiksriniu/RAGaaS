import Anthropic from "@anthropic-ai/sdk";
import { pool } from "@/lib/db";
import { createTenant } from "@/lib/tenants";
import { ingestText } from "@/lib/ingestText";

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
  }
  return e164;
}

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

/** Writes a starter knowledge base from the business description, so the agent
 * can answer plausibly before the business has uploaded anything.
 *
 * This content is INVENTED from general knowledge, not verified by the
 * business. It is therefore ingested under a clearly-labelled source name so
 * it is obvious in the Knowledge Sources list and can be deleted in one click
 * once real documents exist. */
export async function generateStarterKb(
  businessName: string,
  description: string
): Promise<string> {
  const msg = await anthropic.messages.create({
    model: "claude-sonnet-5",
    max_tokens: 2000,
    system:
      "You write starter knowledge-base documents for a business's customer-service AI agent. " +
      "Output GitHub-flavoured Markdown only: a short '## Section' per topic, with plain " +
      "paragraphs or '- ' bullets underneath. No preamble, no closing remarks, no code fences.\n\n" +
      "Cover only what is genuinely generic for this kind of business: what it does, the " +
      "services or products customers ask about, common questions and their usual answers, and " +
      "typical next steps. NEVER invent specifics you cannot know - no prices, phone numbers, " +
      "addresses, opening hours, staff names, policies, or delivery times. If a topic needs " +
      "such a specific, write the guidance and say the customer will be told the detail by the " +
      "business.",
    messages: [
      {
        role: "user",
        content: `Business name: ${businessName}\nWhat they do: ${description}\n\nWrite the starter knowledge base.`,
      },
    ],
  });

  const block = msg.content.find((b): b is Anthropic.TextBlock => b.type === "text");
  return block?.text?.trim() || "";
}

export interface ProvisionResult {
  tenantId: string;
  phoneNumber: string | null;
  starterKbChunks: number;
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
  description: string
): Promise<ProvisionResult> {
  const tenantId = await deriveTenantId(businessName);

  await createTenant({
    id: tenantId,
    name: businessName,
    subdomain: tenantId,
    licenseExpiresAt: null,
  });

  // The description shapes how the agent introduces itself and what it treats
  // as in-scope. Stored as the tenant's answer-style config, which the voice
  // prompt already appends after its safety rules.
  const trimmed = description.trim();
  if (trimmed) {
    await pool.query(
      "UPDATE tenants SET business_description = $2, answer_config_md = $3 WHERE id = $1",
      [
        tenantId,
        trimmed,
        `# About this business\n${trimmed}\n\n## Answer style\n- Keep answers short and practical; callers cannot skim.\n- Stay within what this business actually does. If asked about something unrelated, say so and offer to connect them to a person.`,
      ]
    );
  } else {
    await pool.query("UPDATE tenants SET business_description = $2 WHERE id = $1", [tenantId, null]);
  }

  const phoneNumber = await claimPooledNumber(tenantId);

  let starterKbChunks = 0;
  if (trimmed) {
    try {
      const md = await generateStarterKb(businessName, trimmed);
      if (md) {
        const r = await ingestText(
          tenantId,
          "Starter knowledge (auto-generated)",
          md,
          "generated"
        );
        starterKbChunks = r.chunksIngested;
      }
    } catch (err) {
      // Best-effort by design - see the docstring above.
      console.error(`starter KB generation failed for ${tenantId}:`, err);
    }
  }

  return { tenantId, phoneNumber, starterKbChunks };
}
