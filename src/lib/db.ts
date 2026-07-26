import { Pool, PoolClient } from "pg";
import { SUPABASE_ROOT_CA } from "@/lib/supabaseCa";

declare global {
  // eslint-disable-next-line no-var
  var _pgPool: Pool | undefined;
}

const connectionString = process.env.SUPABASE_DB_URL_APP;
if (!connectionString) {
  throw new Error("SUPABASE_DB_URL_APP is not configured");
}

export const pool =
  global._pgPool ??
  new Pool({
    connectionString,
    ssl: { ca: SUPABASE_ROOT_CA },
  });

if (process.env.NODE_ENV !== "production") global._pgPool = pool;

/** Runs fn() inside a transaction with app.tenant_id set for Postgres RLS to
 * consult. Must be a real transaction, not a bare SET: the pooler runs in
 * transaction-pooling mode, where a connection can be handed to a different
 * backend on the very next statement outside an explicit BEGIN/COMMIT. */
export async function withTenant<T>(
  tenantId: string,
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  if (!tenantId) throw new Error("withTenant: tenantId is required");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
