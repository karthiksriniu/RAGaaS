// Creates the production schema and its own database role, inside the SAME
// Supabase project that serves staging.
//
// WHY A SCHEMA AND NOT A DATABASE: Supabase's pooler, dashboard, backups and
// extensions all target the `postgres` database specifically. A second database
// would be invisible to the dashboard and probably outside the backups. A
// schema is the supported unit of separation here.
//
// WHAT ACTUALLY ENFORCES THE BOUNDARY: grants, not search_path. The production
// role is granted on prod_app only and nothing in public; the staging role is
// granted on public only and nothing in prod_app. So even if a search_path were
// wrong, the query gets "permission denied" rather than silently reading the
// other environment's tenants. That is the difference between a boundary and a
// convention, and this script verifies it in both directions before finishing.
//
// The generated password is written straight into app/.env.local and is never
// printed, so it does not end up in a terminal transcript.
//
// Usage:  node scripts/setup-prod-schema.mjs

import { Client } from "pg";
import { readFileSync, appendFileSync, writeFileSync } from "fs";
import { randomBytes } from "crypto";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import dotenv from "dotenv";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENV_PATH = join(__dirname, "..", ".env.local");
dotenv.config({ path: ENV_PATH });

const SCHEMA = "prod_app";
const PROD_ROLE = "app_runtime_prod";
const STAGING_ROLE = "app_runtime";

const CA =
  readFileSync(join(__dirname, "migrate.mjs"), "utf-8").match(
    /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/
  )[0] + "\n";

const owner = process.env.SUPABASE_DB_URL_OWNER;
if (!owner) {
  console.error("SUPABASE_DB_URL_OWNER is not set in app/.env.local");
  process.exit(1);
}

/** Alphanumeric only: this password has to survive both a SQL literal and a
 * URL, and every escaping bug in that path is silent until a connection fails. */
function newPassword() {
  return randomBytes(24).toString("base64").replace(/[^A-Za-z0-9]/g, "").slice(0, 28);
}

const connect = async (url) => {
  const c = new Client({ connectionString: url, ssl: { ca: CA } });
  await c.connect();
  return c;
};

const step = (m) => console.log(`\n\x1b[1m${m}\x1b[0m`);
const ok = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const bad = (m) => console.log(`  \x1b[31m✗\x1b[0m ${m}`);

const password = newPassword();
const projectRef = owner.match(/postgres\.([a-z0-9]+):/)?.[1];
if (!projectRef) {
  console.error("Could not read the project ref from SUPABASE_DB_URL_OWNER");
  process.exit(1);
}
// Supavisor addresses a custom role as "<role>.<project-ref>", the same shape
// the staging app role already uses.
const prodAppUrl = owner
  .replace(`postgres.${projectRef}:`, `${PROD_ROLE}.${projectRef}:`)
  .replace(/:\/\/([^:]+):[^@]+@/, `://$1:${password}@`);

const db = await connect(owner);
let failures = 0;

try {
  step("1. Role and schema");
  await db.query(`
    do $$ begin
      if exists (select 1 from pg_roles where rolname = '${PROD_ROLE}') then
        alter role ${PROD_ROLE} with login password '${password}';
      else
        create role ${PROD_ROLE} login password '${password}';
      end if;
    end $$;`);
  ok(`role ${PROD_ROLE} ready`);

  await db.query(`create schema if not exists ${SCHEMA} authorization postgres`);
  ok(`schema ${SCHEMA} ready`);

  // public is needed on the path because the `vector` TYPE lives there - the
  // extension is installed in public on this project and is shared. Table
  // grants, not the path, are what stop this role reading staging's data.
  await db.query(`alter role ${PROD_ROLE} set search_path = ${SCHEMA}, public`);
  await db.query(`grant usage on schema ${SCHEMA} to ${PROD_ROLE}`);
  ok(`search_path pinned to "${SCHEMA}, public"`);

  step("2. Schema objects");
  for (const file of ["schema.sql", "migrations/003-enable-rls.sql"]) {
    const sql = readFileSync(join(__dirname, file), "utf-8");
    // Everything in these files is unqualified, so the search_path decides
    // where it lands. Set for this session only.
    await db.query(`set search_path = ${SCHEMA}, public`);
    await db.query(sql);
    ok(`applied ${file}`);
  }
  await db.query(`reset search_path`);

  step("3. Grants");
  // schema.sql hardcodes "grant ... to app_runtime" - the STAGING role. Left
  // alone, staging would hold read/write on production's tables.
  await db.query(`revoke all on all tables in schema ${SCHEMA} from ${STAGING_ROLE}`);
  await db.query(`revoke all on all sequences in schema ${SCHEMA} from ${STAGING_ROLE}`);
  await db.query(`revoke all on schema ${SCHEMA} from ${STAGING_ROLE}`);
  ok(`revoked ${STAGING_ROLE} from ${SCHEMA}`);

  await db.query(`grant select, insert, update, delete on all tables in schema ${SCHEMA} to ${PROD_ROLE}`);
  await db.query(`grant usage, select on all sequences in schema ${SCHEMA} to ${PROD_ROLE}`);
  ok(`granted ${PROD_ROLE} on ${SCHEMA}`);

  step("4. Isolation, verified in both directions");
  const prod = await connect(prodAppUrl);
  try {
    const path = (await prod.query("show search_path")).rows[0].search_path;
    ok(`prod role connects; search_path = ${path}`);

    const seesOwn = await prod.query("select count(*)::int as n from tenants");
    ok(`prod role reads its own tenants (${seesOwn.rows[0].n} rows)`);

    try {
      await prod.query("select 1 from public.tenants limit 1");
      bad("prod role CAN read staging's tenants - the boundary does not hold");
      failures++;
    } catch {
      ok("prod role is refused on public.tenants");
    }
  } finally {
    await prod.end().catch(() => {});
  }

  const staging = await connect(process.env.SUPABASE_DB_URL_APP);
  try {
    try {
      await staging.query(`select 1 from ${SCHEMA}.tenants limit 1`);
      bad(`staging role CAN read ${SCHEMA}.tenants - the boundary does not hold`);
      failures++;
    } catch {
      ok(`staging role is refused on ${SCHEMA}.tenants`);
    }
    const s = await staging.query("select count(*)::int as n from tenants");
    ok(`staging still reads its own tenants (${s.rows[0].n} rows) - unaffected`);
  } finally {
    await staging.end().catch(() => {});
  }

  step("5. Credentials");
  const existing = readFileSync(ENV_PATH, "utf-8");
  const line = `SUPABASE_DB_URL_APP_PROD=${prodAppUrl}`;
  if (existing.includes("SUPABASE_DB_URL_APP_PROD=")) {
    writeFileSync(ENV_PATH, existing.replace(/^SUPABASE_DB_URL_APP_PROD=.*$/m, line));
    ok("updated SUPABASE_DB_URL_APP_PROD in app/.env.local");
  } else {
    appendFileSync(ENV_PATH, `${existing.endsWith("\n") ? "" : "\n"}${line}\n`);
    ok("wrote SUPABASE_DB_URL_APP_PROD to app/.env.local");
  }
  console.log("  (the password is only in that file - it was never printed here)");
} finally {
  await db.end().catch(() => {});
}

console.log(
  failures
    ? `\n\x1b[31m${failures} isolation check(s) failed.\x1b[0m\n`
    : "\n\x1b[32mProduction schema ready and isolated.\x1b[0m\n"
);
process.exit(failures ? 1 : 0);
