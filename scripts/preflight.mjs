// Checks that an environment is actually able to serve traffic, rather than
// merely looking deployed.
//
// Written because every expensive failure on this project so far has been of
// one shape: the environment looks correct, and is silently missing one thing.
// The app_runtime role existed but had no grants on the new signup tables, so
// every business route 500'd. The SIP hostname resolved and had the right ports
// open, but belonged to a different LiveKit project, so every call rang
// forever. Neither showed up as an error anywhere until a human hit it.
//
// Usage:
//   node scripts/preflight.mjs
//   node scripts/preflight.mjs --db SUPABASE_DB_URL_PROD --url https://app.mybizcare.com
//
// --db takes the NAME of an environment variable, not a connection string, so
// no credential ever lands in a shell history or a terminal transcript.
//
// Exits non-zero if anything fails, so it can gate a promotion.

import { Client } from "pg";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import dotenv from "dotenv";

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, "..", ".env.local") });

const args = process.argv.slice(2);
const argOf = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i === -1 ? fallback : args[i + 1];
};

const DB_VAR = argOf("--db", "SUPABASE_DB_URL_APP");
const BASE_URL = argOf("--url", null);

// Same public Supabase root CA the app and migrate.mjs use.
const SUPABASE_ROOT_CA =
  readFileSync(join(__dirname, "migrate.mjs"), "utf-8").match(
    /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/
  )[0] + "\n";

/** Every table the running app touches, with the privileges it ACTUALLY uses.
 *
 * Derived from the SQL in src/, not assumed: an earlier version of this script
 * demanded all four privileges everywhere and reported two failures against a
 * perfectly healthy staging database. A preflight that cries wolf gets ignored,
 * which makes it worse than no preflight at all.
 *
 * Keep this in step when a route starts using a new verb - the symptom of
 * getting it wrong is a 500 in production, not a failure here. */
const TABLES = {
  tenants:            ["SELECT", "INSERT", "UPDATE"],
  chunks:             ["SELECT", "INSERT", "DELETE"],
  kb_files:           ["SELECT", "INSERT", "DELETE"],
  business_accounts:  ["SELECT", "INSERT"],
  otp_challenges:     ["SELECT", "INSERT", "UPDATE", "DELETE"],
  phone_number_pool:  ["SELECT", "INSERT", "UPDATE"],
  rate_limit_events:  ["SELECT", "INSERT", "DELETE"],
  processed_messages: ["SELECT", "INSERT"],
  voice_replies:      ["SELECT", "INSERT"],
};

let failures = 0;
let warnings = 0;

const pass = (m) => console.log(`  \x1b[32mPASS\x1b[0m  ${m}`);
const fail = (m) => { failures++; console.log(`  \x1b[31mFAIL\x1b[0m  ${m}`); };
const warn = (m) => { warnings++; console.log(`  \x1b[33mWARN\x1b[0m  ${m}`); };
const info = (m) => console.log(`  \x1b[90m----\x1b[0m  ${m}`);
const section = (m) => console.log(`\n\x1b[1m${m}\x1b[0m`);

async function checkDatabase() {
  section(`Database  (from $${DB_VAR})`);

  const conn = process.env[DB_VAR];
  if (!conn) {
    fail(`$${DB_VAR} is not set. Add it to app/.env.local.`);
    return;
  }

  const client = new Client({ connectionString: conn, ssl: { ca: SUPABASE_ROOT_CA } });
  try {
    await client.connect();
  } catch (err) {
    fail(`cannot connect: ${err.message}`);
    return;
  }

  try {
    const who = await client.query("select current_user, current_database()");
    const role = who.rows[0].current_user;
    info(`connected as "${role}"`);
    // Connecting as the owner works, but is not what the app does - so it
    // would not catch a missing grant, which is the failure this exists for.
    if (role === "postgres" || role.startsWith("supabase")) {
      warn(
        `this is an owner/superuser role, so the grant checks below prove nothing ` +
          `about how the app will connect. Point --db at the app_runtime URL to test that.`
      );
    }

    const ext = await client.query("select 1 from pg_extension where extname = 'vector'");
    ext.rows.length
      ? pass("pgvector extension installed")
      : fail("pgvector extension missing - every embedding write will fail");

    // Tables and grants together: a table that exists but is unreadable by this
    // role is exactly as broken as one that does not exist.
    for (const [t, needed] of Object.entries(TABLES)) {
      const exists = await client.query("select to_regclass($1) as t", [`public.${t}`]);
      if (!exists.rows[0].t) {
        fail(`table "${t}" missing - apply scripts/schema.sql`);
        continue;
      }
      const missing = [];
      for (const priv of needed) {
        const r = await client.query("select has_table_privilege(current_user, $1, $2) as ok", [t, priv]);
        if (!r.rows[0].ok) missing.push(priv);
      }
      missing.length
        ? fail(`table "${t}": no ${missing.join("/")} for this role - routes touching it will 500`)
        : pass(`table "${t}" present, with ${needed.join("/")}`);
    }

    // RLS is the whole tenant boundary. Enabled without a policy denies
    // everything; a policy without RLS enabled protects nothing.
    const rls = await client.query(
      `select c.relrowsecurity as enabled,
              (select count(*) from pg_policies p
                where p.tablename = 'chunks' and p.schemaname = 'public') as policies
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where c.relname = 'chunks' and n.nspname = 'public'`
    );
    const r = rls.rows[0];
    if (!r) fail("chunks table not found, so RLS could not be checked");
    else if (!r.enabled) fail("row level security is OFF on chunks - tenants are not isolated");
    else if (Number(r.policies) === 0) fail("RLS is on for chunks but no policy exists - all reads return nothing");
    else pass(`row level security active on chunks (${r.policies} policy/policies)`);

    section("Content");
    const t = await client.query("select count(*)::int as n from tenants");
    info(`${t.rows[0].n} tenant(s)`);

    const pool = await client.query(
      `select count(*) filter (where tenant_id is null)::int as free,
              count(*) filter (where tenant_id is not null)::int as claimed,
              count(*)::int as total from phone_number_pool`
    );
    const p = pool.rows[0];
    if (p.total === 0) warn("phone number pool is EMPTY - signups will complete with no number assigned");
    else info(`phone numbers: ${p.total} total, ${p.free} free, ${p.claimed} claimed`);

    // The one that matters: somebody paid, we took the money, and they have no
    // phone line. Checked as an OUTCOME rather than by inspecting configuration
    // because this is the only form of the question preflight can answer
    // honestly - it reads .env.local on whoever's machine runs it, not the
    // environment variables of the deployment being checked, so a
    // NUMBER_LIVE_PROCUREMENT set correctly on Vercel and absent locally would
    // read as broken, and the reverse would read as fine.
    //
    // This exact state sat unnoticed in production: pool empty, live
    // procurement off, and the buy path additionally unable to see Vobiz's
    // inventory at all - so the business was shown "your number is being
    // assigned" indefinitely with a confirmed payment behind it.
    const owed = await client.query(
      `select t.id, t.name
         from tenants t
         join payment_orders o on o.tenant_id = t.id and o.status = 'confirmed'
        where t.voice_phone_number is null
          and t.archived_at is null
        group by t.id, t.name
        order by t.id`
    );
    if (owed.rows.length === 0) {
      pass("every tenant with a confirmed payment has a phone number");
    } else {
      fail(
        `${owed.rows.length} tenant(s) PAID AND CONFIRMED but hold no number: ` +
          `${owed.rows.map((r) => `"${r.id}"`).join(", ")} - they see "being assigned" forever. ` +
          `Assign from /admin/numbers, or check NUMBER_LIVE_PROCUREMENT and LIVEKIT_SIP_URI on the deployment.`
      );
    }

    // Both of these are things migration 004 was supposed to have finished.
    const stale = await client.query(
      `select count(*)::int as n from tenants where answer_config_md ilike '%About this business%'`
    );
    stale.rows[0].n === 0
      ? pass("no tenant carries the retired \"About this business\" block")
      : fail(`${stale.rows[0].n} tenant(s) still carry the "About this business" block - apply migration 004`);

    const retired = await client.query(
      `select count(*)::int as n from tenants
        where voice_preset in ('male-warm','male-measured','male-chirpy','female-warm','female-measured')`
    );
    retired.rows[0].n === 0
      ? pass("no tenant is on a retired voice preset")
      : fail(`${retired.rows[0].n} tenant(s) on a retired voice preset - apply migration 004`);
  } finally {
    await client.end().catch(() => {});
  }
}

/** Probes the deployed app the way a stranger would.
 *
 * Each expected status is chosen to distinguish "deployed and working" from
 * "deployed and broken" - a 500 where a 401 belongs means the route is live but
 * its database or environment is not. */
async function checkDeployment() {
  if (!BASE_URL) return;
  section(`Deployment  (${BASE_URL})`);

  const probes = [
    { path: "/signup", method: "GET", want: [200], why: "signup page renders" },
    { path: "/login", method: "GET", want: [200], why: "login page renders" },
    {
      path: "/api/business/me",
      method: "GET",
      want: [401],
      why: "business API rejects an unauthenticated caller (a 500 here means the DB is unreachable)",
    },
    {
      path: "/api/business/transcribe",
      method: "POST",
      want: [400, 429],
      why: "voice-input endpoint is deployed",
    },
  ];

  // Delivery channel, checked separately because it is the one thing that
  // looks fine right up until a real person cannot sign up.
  try {
    const res = await fetch(`${BASE_URL}/api/business/otp`);
    const { channel } = await res.json();
    if (channel === "none") {
      const staging = BASE_URL.includes("staging.");
      (staging ? warn : fail)(
        staging
          ? "no OTP delivery channel - codes are shown on screen (fine for staging)"
          : "NO OTP DELIVERY CHANNEL - nobody can sign up or log in on this deployment"
      );
    } else {
      pass(`OTP codes deliver via ${channel}`);
    }
  } catch (err) {
    fail(`could not read the OTP delivery channel: ${err.message}`);
  }

  for (const probe of probes) {
    try {
      const res = await fetch(`${BASE_URL}${probe.path}`, { method: probe.method });
      probe.want.includes(res.status)
        ? pass(`${probe.path} -> ${res.status} : ${probe.why}`)
        : fail(`${probe.path} -> ${res.status}, expected ${probe.want.join(" or ")} : ${probe.why}`);
    } catch (err) {
      fail(`${probe.path} unreachable: ${err.message}`);
    }
  }
}

/** The two variables that decide whether a paid signup gets a number bought
 * for it. Both are read only by server code, appear in no other script, and
 * were undocumented until a confirmed payment in production produced no number
 * and no explanation - so listing them here is half the point of this section.
 *
 * SCOPE, and it matters: this reads the environment of whoever runs the
 * script, NOT the environment of the deployment named by --url. Nothing here
 * can prove what Vercel has set. Treated as warnings for that reason; the
 * authoritative check is the paid-but-numberless query above, which reads the
 * deployment's own database and fails hard. */
function checkNumberProvisioning() {
  section("Number provisioning  (this shell's environment, NOT the deployment's)");

  if (process.env.NUMBER_LIVE_PROCUREMENT === "true") {
    pass('NUMBER_LIVE_PROCUREMENT="true" - a confirmed payment buys a number when the pool is empty');
  } else {
    warn(
      'NUMBER_LIVE_PROCUREMENT is not "true" - no number will ever be bought. ' +
        "With an empty pool, a confirmed payment leaves the business with no phone line."
    );
  }

  if (process.env.LIVEKIT_SIP_URI) {
    // Cannot be verified from here, and getting it wrong is silent and
    // expensive: the trunk is created once, per environment, pointing wherever
    // this says. A staging URI on production means paying customers' calls are
    // answered by the staging worker off the staging knowledge base.
    info(`LIVEKIT_SIP_URI=${process.env.LIVEKIT_SIP_URI} - confirm this is the RIGHT environment's`);
  } else {
    warn(
      "LIVEKIT_SIP_URI is unset - provisionNumber() throws before buying anything, " +
        "so procurement fails even with NUMBER_LIVE_PROCUREMENT on."
    );
  }
}

console.log("\n\x1b[1mMyBizCare preflight\x1b[0m");
await checkDatabase();
await checkDeployment();
checkNumberProvisioning();

section("Result");
if (failures) {
  console.log(`  \x1b[31m${failures} check(s) failed\x1b[0m${warnings ? `, ${warnings} warning(s)` : ""}. Do not promote.\n`);
  process.exit(1);
}
console.log(`  \x1b[32mAll checks passed\x1b[0m${warnings ? ` (${warnings} warning(s) - read them)` : ""}.\n`);
