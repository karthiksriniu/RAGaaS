import { describe, it, expect } from "vitest";
import { Client } from "pg";
import { requireEnv } from "./helpers/adminSession";
import { SUPABASE_ROOT_CA } from "@/lib/supabaseCa";

/** Connects as the app's own less-privileged runtime role (not the owner
 * connection used elsewhere for seeding/cleanup) - this is the same role
 * the deployed app itself uses, so this test proves what production code
 * actually experiences under RLS. */
function getAppRuntimeClient(): Client {
  const connectionString = requireEnv("TEST_SUPABASE_DB_URL_APP_RUNTIME");
  return new Client({ connectionString, ssl: { ca: SUPABASE_ROOT_CA } });
}

describe("Postgres RLS fail-closed proof", () => {
  it("returns zero rows when app.tenant_id is never set", async () => {
    const client = getAppRuntimeClient();
    await client.connect();
    try {
      const result = await client.query("SELECT count(*) FROM chunks");
      expect(Number(result.rows[0].count)).toBe(0);
    } finally {
      await client.end();
    }
  });

  it("returns only the scoped tenant's rows when app.tenant_id is set", async () => {
    const client = getAppRuntimeClient();
    await client.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.tenant_id', 'default', true)");
      const defaultResult = await client.query("SELECT DISTINCT tenant_id FROM chunks");
      await client.query("COMMIT");

      for (const row of defaultResult.rows) {
        expect(row.tenant_id).toBe("default");
      }
    } finally {
      await client.end();
    }
  });

  it("switching app.tenant_id between transactions never leaks the previous tenant's rows", async () => {
    const client = getAppRuntimeClient();
    await client.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.tenant_id', 'testinsuranceco', true)");
      const first = await client.query("SELECT DISTINCT tenant_id FROM chunks");
      await client.query("COMMIT");
      for (const row of first.rows) expect(row.tenant_id).toBe("testinsuranceco");

      // A bare SET (no transaction) would risk leaking onto the next pooled
      // connection reuse under Supavisor's transaction-pooling mode - this
      // is exactly why withTenant() always wraps set_config in BEGIN/COMMIT.
      // Confirm a fresh transaction on the SAME client connection correctly
      // has no leftover tenant context.
      await client.query("BEGIN");
      const leaked = await client.query("SELECT count(*) FROM chunks");
      await client.query("COMMIT");
      expect(Number(leaked.rows[0].count)).toBe(0);
    } finally {
      await client.end();
    }
  });
});
