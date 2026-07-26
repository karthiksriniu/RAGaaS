import { pool } from "@/lib/db";

export interface Tenant {
  id: string;
  name: string;
  subdomain: string;
  twilioWhatsappNumber: string | null;
  licenseExpiresAt: string | null;
  archivedAt: string | null;
  createdAt: string;
}

export class TenantNotFoundError extends Error {
  constructor(tenantId: string) {
    super(`Tenant not found: ${tenantId}`);
    this.name = "TenantNotFoundError";
  }
}

export class TenantExpiredError extends Error {
  constructor(tenantId: string) {
    super(`Tenant license has expired: ${tenantId}`);
    this.name = "TenantExpiredError";
  }
}

/** 'default' is the standing UAT/QA tenant admins and the demo web chat
 * fall back to - an accidental past-dated expiry on it would 403 every
 * farmer-facing and admin-facing check that runs through
 * assertTenantLicensed, with no other tenant to fall back to. Guarded here
 * (not just in the UI) so it can't happen via a direct API call either. */
export class DefaultTenantProtectedError extends Error {
  constructor() {
    super("The default tenant's license can't be set to expire.");
    this.name = "DefaultTenantProtectedError";
  }
}

const PROTECTED_TENANT_ID = "default";

interface TenantRow {
  id: string;
  name: string;
  subdomain: string;
  twilio_whatsapp_number: string | null;
  license_expires_at: string | null;
  archived_at: string | null;
  created_at: string;
}

function mapRow(row: TenantRow): Tenant {
  return {
    id: row.id,
    name: row.name,
    subdomain: row.subdomain,
    twilioWhatsappNumber: row.twilio_whatsapp_number,
    licenseExpiresAt: row.license_expires_at,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
  };
}

/** tenants isn't RLS-scoped (it's the registry itself), so these use the
 * bare pool - no withTenant needed. */

export async function assertTenantExists(tenantId: string): Promise<Tenant> {
  const result = await pool.query<TenantRow>(
    "SELECT * FROM tenants WHERE id = $1 AND archived_at IS NULL",
    [tenantId]
  );
  if (result.rows.length === 0) throw new TenantNotFoundError(tenantId);
  return mapRow(result.rows[0]);
}

export async function assertTenantLicensed(tenantId: string): Promise<Tenant> {
  const tenant = await assertTenantExists(tenantId);
  if (tenant.licenseExpiresAt && new Date(tenant.licenseExpiresAt) <= new Date()) {
    throw new TenantExpiredError(tenantId);
  }
  return tenant;
}

/** Looked up by subdomain (the DNS-facing label), not id - used by the
 * Server Component resolving a hostname. Returns null for missing or
 * archived tenants; license state is checked separately by the caller so it
 * can render a distinct "expired" vs. "not found" landing state. */
export async function getTenant(subdomain: string): Promise<Tenant | null> {
  if (!subdomain) return null;
  const result = await pool.query<TenantRow>(
    "SELECT * FROM tenants WHERE subdomain = $1 AND archived_at IS NULL",
    [subdomain]
  );
  return result.rows.length > 0 ? mapRow(result.rows[0]) : null;
}

/** Looked up by Twilio's wire-format WhatsApp number (e.g.
 * "whatsapp:+14155238886", exactly what params.get("To") delivers) - used
 * by the webhook to route an inbound message to its owning tenant. */
export async function getTenantByWhatsappNumber(
  whatsappNumber: string
): Promise<Tenant | null> {
  if (!whatsappNumber) return null;
  const result = await pool.query<TenantRow>(
    "SELECT * FROM tenants WHERE twilio_whatsapp_number = $1 AND archived_at IS NULL",
    [whatsappNumber]
  );
  return result.rows.length > 0 ? mapRow(result.rows[0]) : null;
}

export async function listTenants(): Promise<Tenant[]> {
  const result = await pool.query<TenantRow>(
    "SELECT * FROM tenants WHERE archived_at IS NULL ORDER BY name ASC"
  );
  return result.rows.map(mapRow);
}

export async function createTenant(input: {
  id: string;
  name: string;
  subdomain: string;
  licenseExpiresAt: string | null;
  twilioWhatsappNumber?: string | null;
}): Promise<Tenant> {
  const result = await pool.query<TenantRow>(
    `INSERT INTO tenants (id, name, subdomain, license_expires_at, twilio_whatsapp_number)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [input.id, input.name, input.subdomain, input.licenseExpiresAt, input.twilioWhatsappNumber ?? null]
  );
  return mapRow(result.rows[0]);
}

export async function updateTenantLicense(
  id: string,
  licenseExpiresAt: string | null
): Promise<Tenant> {
  if (id === PROTECTED_TENANT_ID && licenseExpiresAt !== null) {
    throw new DefaultTenantProtectedError();
  }
  const result = await pool.query<TenantRow>(
    `UPDATE tenants SET license_expires_at = $2 WHERE id = $1 AND archived_at IS NULL RETURNING *`,
    [id, licenseExpiresAt]
  );
  if (result.rows.length === 0) throw new TenantNotFoundError(id);
  return mapRow(result.rows[0]);
}

export async function updateTenantWhatsappNumber(
  id: string,
  twilioWhatsappNumber: string | null
): Promise<Tenant> {
  const result = await pool.query<TenantRow>(
    `UPDATE tenants SET twilio_whatsapp_number = $2 WHERE id = $1 AND archived_at IS NULL RETURNING *`,
    [id, twilioWhatsappNumber]
  );
  if (result.rows.length === 0) throw new TenantNotFoundError(id);
  return mapRow(result.rows[0]);
}
