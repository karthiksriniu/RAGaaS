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
