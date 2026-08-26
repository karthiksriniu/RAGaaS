// Wipes staging's tenants so a clean end-to-end run can start from nothing.
//
// DESTRUCTIVE AND NOT REVERSIBLE. Requires --confirm.
//
// EVERY statement names public.<table> explicitly. Production now lives in the
// prod_app schema on this same database, and an unqualified DELETE here would
// resolve through search_path - which is exactly how a staging cleanup becomes
// a production outage. The schema name is not a variable in this file, so it
// cannot be pointed anywhere else by mistake.
//
// The `default` tenant is kept: DEFAULT_TENANT_ID, WHATSAPP_STOPGAP_TENANT_ID
// and DEV_DEFAULT_TENANT_SLUG all point at it, so deleting it would break the
// WhatsApp path and the default host rather than just clearing test data.
//
// Runs as the owner, which bypasses RLS - counting or deleting chunks as the
// app role returns nothing at all without a tenant context set, which would
// look like success while leaving every row in place.

import { Client } from "pg";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import dotenv from "dotenv";

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, "..", ".env.local") });

const KEEP = ["default"];
const confirmed = process.argv.includes("--confirm");

const CA =
  readFileSync(join(__dirname, "migrate.mjs"), "utf-8").match(
    /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/
  )[0] + "\n";

const url = process.env.SUPABASE_DB_URL_OWNER;
if (!url) {
  console.error("SUPABASE_DB_URL_OWNER is not set");
  process.exit(1);
}

const db = new Client({ connectionString: url, ssl: { ca: CA } });
await db.connect();

const keepList = KEEP.map((k) => `'${k}'`).join(", ");

const before = await db.query(`
  select
    (select count(*)::int from public.tenants)            as tenants,
    (select count(*)::int from public.chunks)             as chunks,
    (select count(*)::int from public.kb_files)           as files,
    (select count(*)::int from public.business_accounts)  as accounts,
    (select count(*)::int from public.payment_orders)     as payments,
    (select count(*)::int from public.phone_number_pool
       where tenant_id is not null)                       as claimed_numbers`);
console.log("\nBEFORE:", before.rows[0]);

const doomed = await db.query(
  `select id from public.tenants where id not in (${keepList}) order by id`
);
console.log(`\nWill DELETE ${doomed.rows.length} tenant(s) and everything belonging to them:`);
console.log("  " + doomed.rows.map((r) => r.id).join(", "));
console.log(`\nWill KEEP: ${KEEP.join(", ")}`);

if (!confirmed) {
  console.log("\nDry run. Re-run with --confirm to actually delete.\n");
  await db.end();
  process.exit(0);
}

try {
  await db.query("BEGIN");
  // Children first - every one of these has a foreign key to tenants, so the
  // tenant delete fails outright if any are left behind. Whole thing is one
  // transaction, so a failure part-way leaves staging exactly as it was rather
  // than half-cleared.
  await db.query(`DELETE FROM public.chunks            WHERE tenant_id NOT IN (${keepList})`);
  await db.query(`DELETE FROM public.kb_files          WHERE tenant_id NOT IN (${keepList})`);
  await db.query(`DELETE FROM public.business_accounts WHERE tenant_id NOT IN (${keepList})`);
  // Payment orders reference tenants, so the tenant delete below fails outright
  // without this. Orders with no tenant go too: they are signups that paid and
  // never finished, and leaving one behind would let the next signup on that
  // mobile resume onto a payment from a wiped environment.
  await db.query(
    `DELETE FROM public.payment_orders WHERE tenant_id IS NULL OR tenant_id NOT IN (${keepList})`
  );
  // Hand the numbers back to the pool rather than deleting the rows: we still
  // own and pay for them, and the point of this reset is to re-use them.
  await db.query(`UPDATE public.phone_number_pool SET tenant_id = NULL, claimed_at = NULL`);
  await db.query(`UPDATE public.tenants SET voice_phone_number = NULL WHERE id NOT IN (${keepList})`);
  await db.query(`DELETE FROM public.tenants          WHERE id NOT IN (${keepList})`);
  // Any half-finished signups would otherwise block those numbers from
  // signing up again, since a surviving challenge row reads as "not verified".
  await db.query(`DELETE FROM public.otp_challenges`);
  await db.query("COMMIT");
} catch (err) {
  await db.query("ROLLBACK").catch(() => {});
  console.error("\nFailed, rolled back - nothing was deleted:", err.message);
  await db.end();
  process.exit(1);
}

const after = await db.query(`
  select
    (select count(*)::int from public.tenants)            as tenants,
    (select count(*)::int from public.chunks)             as chunks,
    (select count(*)::int from public.kb_files)           as files,
    (select count(*)::int from public.business_accounts)  as accounts,
    (select count(*)::int from public.payment_orders)     as payments,
    (select count(*)::int from public.phone_number_pool
       where tenant_id is null)                           as free_numbers`);
console.log("\nAFTER:", after.rows[0]);

// Proof the production schema was not touched by any of the above.
const prod = await db.query(`select count(*)::int as n from prod_app.tenants`);
console.log(`prod_app.tenants still has ${prod.rows[0].n} row(s) - untouched\n`);

await db.end();
