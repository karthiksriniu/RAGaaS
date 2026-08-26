import { pool } from "@/lib/db";
import { allowNumberOnInboundTrunk, isLiveKitConfigured } from "@/lib/livekitSip";

// Every operation that changes who owns a phone number.
//
// Two tables have to agree: phone_number_pool records ownership, and
// tenants.voice_phone_number is what /api/voice/session reads to route an
// incoming call. If they drift, the pool can hand a number to a second
// business while calls still route to the first - so every mutation here runs
// in ONE transaction that touches both.

export interface PooledNumber {
  e164: string;
  tenantId: string | null;
  businessName: string | null;
  claimedAt: string | null;
}

/** Every number we own, with whoever currently holds it. */
export async function listPool(): Promise<PooledNumber[]> {
  const res = await pool.query<{
    e164: string;
    tenant_id: string | null;
    business_name: string | null;
    claimed_at: Date | null;
  }>(
    `SELECT p.e164, p.tenant_id, t.name AS business_name, p.claimed_at
       FROM phone_number_pool p
       LEFT JOIN tenants t ON t.id = p.tenant_id
      ORDER BY p.claimed_at NULLS FIRST, p.created_at`
  );
  return res.rows.map((r) => ({
    e164: r.e164,
    tenantId: r.tenant_id,
    businessName: r.business_name,
    claimedAt: r.claimed_at ? r.claimed_at.toISOString() : null,
  }));
}

export class NumberNotInPoolError extends Error {
  constructor(e164: string) {
    super(`${e164} is not one of our numbers. Add it to the pool first.`);
    this.name = "NumberNotInPoolError";
  }
}

export interface AssignResult {
  e164: string;
  /** Set when the number was taken from someone - the caller should say so. */
  previousTenantId: string | null;
}

/** Gives `e164` to `tenantId`, taking it from whoever holds it now.
 *
 * One transaction, and the row is locked with FOR UPDATE before it is read, so
 * two admins assigning the same number at once cannot both succeed and leave a
 * tenant silently without a line. The previous holder is cleared BEFORE the new
 * one is set: a failure part-way rolls the whole thing back rather than leaving
 * one number pointing at two businesses, which would route one company's
 * callers to another. */
export async function assignNumberToTenant(
  e164: string,
  tenantId: string
): Promise<AssignResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const row = (
      await client.query<{ tenant_id: string | null }>(
        "SELECT tenant_id FROM phone_number_pool WHERE e164 = $1 FOR UPDATE",
        [e164]
      )
    ).rows[0];
    if (!row) {
      await client.query("ROLLBACK");
      throw new NumberNotInPoolError(e164);
    }

    const previousTenantId = row.tenant_id;
    if (previousTenantId === tenantId) {
      await client.query("ROLLBACK");
      return { e164, previousTenantId: null };
    }

    if (previousTenantId) {
      await client.query("UPDATE tenants SET voice_phone_number = NULL WHERE id = $1", [
        previousTenantId,
      ]);
    }
    // The target may already hold a DIFFERENT number; release it, or the tenant
    // would appear to own two while only one routes.
    await client.query(
      "UPDATE phone_number_pool SET tenant_id = NULL, claimed_at = NULL WHERE tenant_id = $1 AND e164 <> $2",
      [tenantId, e164]
    );
    await client.query(
      "UPDATE phone_number_pool SET tenant_id = $2, claimed_at = now() WHERE e164 = $1",
      [e164, tenantId]
    );
    await client.query("UPDATE tenants SET voice_phone_number = $2 WHERE id = $1", [
      tenantId,
      e164,
    ]);

    await client.query("COMMIT");
    if (previousTenantId) {
      console.warn(
        `[number-pool] ${e164} reassigned from "${previousTenantId}" to "${tenantId}" by an admin - ` +
          `the previous tenant no longer has a working number.`
      );
    }
    return { e164, previousTenantId };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Returns `e164` to the free pool. The number stays ours at the carrier -
 * releasing it there is irreversible and is done from the Vobiz console. */
export async function releaseNumber(e164: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const row = (
      await client.query<{ tenant_id: string | null }>(
        "SELECT tenant_id FROM phone_number_pool WHERE e164 = $1 FOR UPDATE",
        [e164]
      )
    ).rows[0];
    if (!row) {
      await client.query("ROLLBACK");
      throw new NumberNotInPoolError(e164);
    }
    if (row.tenant_id) {
      await client.query("UPDATE tenants SET voice_phone_number = NULL WHERE id = $1", [
        row.tenant_id,
      ]);
    }
    await client.query(
      "UPDATE phone_number_pool SET tenant_id = NULL, claimed_at = NULL WHERE e164 = $1",
      [e164]
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Adds a number we have bought at the carrier to the pool, so signup can hand
 * it out. Idempotent: re-adding an existing number leaves its holder alone.
 *
 * Also tells LiveKit to accept calls for it. Owning a number at the carrier is
 * only half of making it ring: without the inbound-trunk allowlist entry the
 * number is handed to a business at signup and then silently refuses every
 * call, with nothing logged. Doing it here means a number is answerable from
 * the moment it enters the pool rather than from whenever someone remembers. */
export async function addNumberToPool(e164: string): Promise<void> {
  await pool.query(
    "INSERT INTO phone_number_pool (e164) VALUES ($1) ON CONFLICT (e164) DO NOTHING",
    [e164]
  );
  if (!isLiveKitConfigured()) {
    console.error(`[number-pool] ${e164} added but LiveKit is not configured - it will NOT answer calls`);
    return;
  }
  // Best-effort: the number is in the pool either way, and claimPooledNumber
  // tries again when it is handed out.
  try {
    await allowNumberOnInboundTrunk(e164);
  } catch (err) {
    console.error(`[number-pool] ${e164} added but LiveKit would not accept it:`, err);
  }
}
