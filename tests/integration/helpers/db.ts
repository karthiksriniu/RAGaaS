import { Client } from "pg";
import { SUPABASE_ROOT_CA } from "@/lib/supabaseCa";

/** Owner-privileged connection to the STAGING database only, for seeding
 * test fixtures and cleanup. Never used against production - see the
 * project-ref guard below. */
export function getTestDbClient(): Client {
  const connectionString = process.env.TEST_SUPABASE_DB_URL_OWNER;
  const expectedRef = process.env.TEST_STAGING_PROJECT_REF;

  if (!connectionString) {
    throw new Error("TEST_SUPABASE_DB_URL_OWNER is not configured (.env.test)");
  }
  if (!expectedRef) {
    throw new Error("TEST_STAGING_PROJECT_REF is not configured (.env.test)");
  }

  // Hard safety guard: the connection string must reference the known
  // staging project ref (postgres.<project-ref>@...). This runs DELETEs
  // for test cleanup - a misconfigured .env.test pointing at production
  // must never be able to delete production rows.
  if (!connectionString.includes(`.${expectedRef}:`)) {
    throw new Error(
      `Refusing to connect: TEST_SUPABASE_DB_URL_OWNER does not reference the expected staging project ref "${expectedRef}". This guard exists specifically to prevent test cleanup from ever running against production.`
    );
  }

  return new Client({ connectionString, ssl: { ca: SUPABASE_ROOT_CA } });
}
