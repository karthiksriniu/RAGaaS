import { Client } from "pg";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import dotenv from "dotenv";

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, "..", ".env.local") });

// Usage:
//   node scripts/migrate.mjs [file]           - staging (the public schema)
//   node scripts/migrate.mjs [file] --prod    - production (the prod_app schema)
//
// Production lives in a SEPARATE SCHEMA of the same Supabase project, reached
// by a different role - see scripts/setup-prod-schema.mjs for why. A migration
// file is unqualified, so the search_path decides where its tables land, and
// the grants inside it name the staging role. --prod handles both: it pins the
// path to prod_app and re-runs the same grant/revoke step setup-prod-schema
// does, so a new table is not left readable by staging or unreadable by prod.
const args = process.argv.slice(2);
const toProd = args.includes("--prod");
const target = args.find((a) => !a.startsWith("--")) || "schema.sql";
const sql = readFileSync(join(__dirname, target), "utf-8");

const PROD_SCHEMA = "prod_app";
const PROD_ROLE = "app_runtime_prod";
const STAGING_ROLE = "app_runtime";

// Supabase's own root CA (public, not project-specific - same cert used in
// src/lib/supabaseCa.ts). Duplicated here rather than imported since this
// is a plain Node script, not part of the TS build.
const SUPABASE_ROOT_CA = `-----BEGIN CERTIFICATE-----
MIIDxDCCAqygAwIBAgIUbLxMod62P2ktCiAkxnKJwtE9VPYwDQYJKoZIhvcNAQEL
BQAwazELMAkGA1UEBhMCVVMxEDAOBgNVBAgMB0RlbHdhcmUxEzARBgNVBAcMCk5l
dyBDYXN0bGUxFTATBgNVBAoMDFN1cGFiYXNlIEluYzEeMBwGA1UEAwwVU3VwYWJh
c2UgUm9vdCAyMDIxIENBMB4XDTIxMDQyODEwNTY1M1oXDTMxMDQyNjEwNTY1M1ow
azELMAkGA1UEBhMCVVMxEDAOBgNVBAgMB0RlbHdhcmUxEzARBgNVBAcMCk5ldyBD
YXN0bGUxFTATBgNVBAoMDFN1cGFiYXNlIEluYzEeMBwGA1UEAwwVU3VwYWJhc2Ug
Um9vdCAyMDIxIENBMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAqQXW
QyHOB+qR2GJobCq/CBmQ40G0oDmCC3mzVnn8sv4XNeWtE5XcEL0uVih7Jo4Dkx1Q
DmGHBH1zDfgs2qXiLb6xpw/CKQPypZW1JssOTMIfQppNQ87K75Ya0p25Y3ePS2t2
GtvHxNjUV6kjOZjEn2yWEcBdpOVCUYBVFBNMB4YBHkNRDa/+S4uywAoaTWnCJLUi
cvTlHmMw6xSQQn1UfRQHk50DMCEJ7Cy1RxrZJrkXXRP3LqQL2ijJ6F4yMfh+Gyb4
O4XajoVj/+R4GwywKYrrS8PrSNtwxr5StlQO8zIQUSMiq26wM8mgELFlS/32Uclt
NaQ1xBRizkzpZct9DwIDAQABo2AwXjALBgNVHQ8EBAMCAQYwHQYDVR0OBBYEFKjX
uXY32CztkhImng4yJNUtaUYsMB8GA1UdIwQYMBaAFKjXuXY32CztkhImng4yJNUt
aUYsMA8GA1UdEwEB/wQFMAMBAf8wDQYJKoZIhvcNAQELBQADggEBAB8spzNn+4VU
tVxbdMaX+39Z50sc7uATmus16jmmHjhIHz+l/9GlJ5KqAMOx26mPZgfzG7oneL2b
VW+WgYUkTT3XEPFWnTp2RJwQao8/tYPXWEJDc0WVQHrpmnWOFKU/d3MqBgBm5y+6
jB81TU/RG2rVerPDWP+1MMcNNy0491CTL5XQZ7JfDJJ9CCmXSdtTl4uUQnSuv/Qx
Cea13BX2ZgJc7Au30vihLhub52De4P/4gonKsNHYdbWjg7OWKwNv/zitGDVDB9Y2
CMTyZKG3XEu5Ghl1LEnI3QmEKsqaCLv12BnVjbkSeZsMnevJPs1Ye6TjjJwdik5P
o/bKiIz+Fq8=
-----END CERTIFICATE-----
`;

// SUPABASE_DB_URL_OWNER, not SUPABASE_DB_URL. Both name a "postgres" superuser
// and both connect happily, but they are two DIFFERENT Supabase projects -
// SUPABASE_DB_URL still points at the original ap-southeast-2 project this
// started on, while the app, the owner connection and setup-prod-schema.mjs all
// use ap-northeast-1. A migration run through the old one succeeds, prints
// "applied", and changes nothing the running app can see. Confirmed the hard
// way: 005 created its tables there, and app_runtime then reported
// "relation platform_settings does not exist".
//
// SUPABASE_DB_URL is kept only as a fallback for an environment that has not
// been given the owner URL.
const connectionString = process.env.SUPABASE_DB_URL_OWNER || process.env.SUPABASE_DB_URL;

if (!connectionString) {
  console.error("SUPABASE_DB_URL_OWNER is not set in app/.env.local");
  process.exit(1);
}

const client = new Client({ connectionString, ssl: { ca: SUPABASE_ROOT_CA } });

async function main() {
  await client.connect();

  if (toProd) {
    await client.query(`set search_path = ${PROD_SCHEMA}, public`);
    await client.query(sql);
    // schema.sql and the migrations grant to the STAGING role by name, because
    // that is who they were written for. Left as-is, staging would hold
    // read/write on a production table and production would hold none.
    await client.query(`revoke all on all tables in schema ${PROD_SCHEMA} from ${STAGING_ROLE}`);
    await client.query(`revoke all on all sequences in schema ${PROD_SCHEMA} from ${STAGING_ROLE}`);
    await client.query(`grant select, insert, update, delete on all tables in schema ${PROD_SCHEMA} to ${PROD_ROLE}`);
    await client.query(`grant usage, select on all sequences in schema ${PROD_SCHEMA} to ${PROD_ROLE}`);
    await client.query("reset search_path");
    console.log(`Migration applied to ${PROD_SCHEMA} (production): ${target}`);
  } else {
    await client.query(sql);
    console.log(`Migration applied successfully: ${target}`);
  }

  await client.end();
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
