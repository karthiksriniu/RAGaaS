import { NextRequest } from "next/server";
import { pool } from "@/lib/db";

/** Sliding-window rate limiter backed by Postgres so limits hold across
 * concurrent/cold-started serverless instances - an in-memory counter
 * wouldn't survive a cold start or be shared across instances. Not
 * RLS-scoped: this is request bookkeeping, not tenant content. */
export async function checkRateLimit(
  bucketKey: string,
  windowMs: number,
  maxRequests: number
): Promise<boolean> {
  const client = await pool.connect();
  try {
    // Opportunistic cleanup keeps the table small without a separate cron -
    // every window currently in use is well under an hour.
    await client.query(
      "DELETE FROM rate_limit_events WHERE created_at < now() - interval '1 hour'"
    );
    const windowStart = new Date(Date.now() - windowMs);
    const result = await client.query(
      "SELECT count(*)::int AS count FROM rate_limit_events WHERE bucket_key = $1 AND created_at >= $2",
      [bucketKey, windowStart]
    );
    if (result.rows[0].count >= maxRequests) {
      return false;
    }
    await client.query("INSERT INTO rate_limit_events (bucket_key) VALUES ($1)", [bucketKey]);
    return true;
  } finally {
    client.release();
  }
}

export function getClientIp(req: NextRequest): string {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return "unknown";
}
