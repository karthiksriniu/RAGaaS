import { Pool } from "pg";

declare global {
  // eslint-disable-next-line no-var
  var _pgPool: Pool | undefined;
}

export const pool =
  global._pgPool ??
  new Pool({
    connectionString: process.env.SUPABASE_DB_URL,
    ssl: { rejectUnauthorized: false },
  });

if (process.env.NODE_ENV !== "production") global._pgPool = pool;
