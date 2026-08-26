import { pool } from "@/lib/db";
import { PROVISIONAL_DAYS } from "@/lib/upi";

export interface Tenant {
  id: string;
  name: string;
  subdomain: string;
  twilioWhatsappNumber: string | null;
  /** The subaccount's Account SID, if this tenant has its own Twilio
   * credentials - not a secret (Twilio numbers/SIDs appear in webhook
   * payloads and logs anyway), so safe to return from the admin API. */
  twilioAccountSid: string | null;
  /** Whether a custom auth token is configured - the token itself is never
   * returned by any API response, only this derived boolean, so the admin
   * UI can show "custom credentials configured" without ever exposing the
   * live secret back to the browser. */
  hasCustomTwilioAuthToken: boolean;
  /** Freeform admin-authored guidance blended into the system prompt for
   * this tenant's answers (tone/format + how to weigh its KB content).
   * Not a secret, safe to return from the admin API unlike the Twilio
   * auth token above. */
  answerConfigMd: string | null;
  /** E.164 number customers dial to reach this tenant's voice agent. */
  voicePhoneNumber: string | null;
  /** Named voice preset id; null uses the default. See voicePresets.ts. */
  voicePreset: string | null;
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
  twilio_account_sid: string | null;
  twilio_auth_token: string | null;
  answer_config_md: string | null;
  voice_phone_number: string | null;
  voice_preset: string | null;
  license_expires_at: string | null;
  archived_at: string | null;
  created_at: string;
}

// mapRow is used everywhere, including responses returned to the browser -
// twilio_auth_token deliberately never appears in its output. The one place
// that needs the real token (the webhook, to validate/send as the tenant's
// own subaccount) uses getTwilioCredentials() below instead, which never
// serializes its result anywhere.
function mapRow(row: TenantRow): Tenant {
  return {
    id: row.id,
    name: row.name,
    subdomain: row.subdomain,
    twilioWhatsappNumber: row.twilio_whatsapp_number,
    twilioAccountSid: row.twilio_account_sid,
    hasCustomTwilioAuthToken: !!row.twilio_auth_token,
    answerConfigMd: row.answer_config_md,
    voicePhoneNumber: row.voice_phone_number,
    voicePreset: row.voice_preset,
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

export interface TwilioCredentials {
  accountSid: string;
  authToken: string;
}

/** Internal use only (the WhatsApp webhook) - never return this anywhere an
 * HTTP response could expose authToken. Falls back to the platform's global
 * TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN env vars when the tenant has no
 * credentials of its own (the common case) or when tenantId is null (an
 * unrecognized number, which can only ever have been signed with the
 * global token anyway). */
export async function getTwilioCredentials(tenantId: string | null): Promise<TwilioCredentials> {
  const globalCredentials: TwilioCredentials = {
    accountSid: process.env.TWILIO_ACCOUNT_SID || "",
    authToken: process.env.TWILIO_AUTH_TOKEN || "",
  };
  if (!tenantId) return globalCredentials;

  const result = await pool.query<Pick<TenantRow, "twilio_account_sid" | "twilio_auth_token">>(
    "SELECT twilio_account_sid, twilio_auth_token FROM tenants WHERE id = $1",
    [tenantId]
  );
  const row = result.rows[0];
  if (row?.twilio_account_sid && row?.twilio_auth_token) {
    return { accountSid: row.twilio_account_sid, authToken: row.twilio_auth_token };
  }
  return globalCredentials;
}

/** A small standalone query (mirrors getTwilioCredentials's shape) so
 * answerQuestion.ts fetches only this one field rather than the full
 * tenant row on every question. */
export async function getTenantAnswerConfig(tenantId: string): Promise<string | null> {
  const result = await pool.query<Pick<TenantRow, "answer_config_md">>(
    "SELECT answer_config_md FROM tenants WHERE id = $1",
    [tenantId]
  );
  return result.rows[0]?.answer_config_md ?? null;
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
  twilioAccountSid?: string | null;
  twilioAuthToken?: string | null;
  answerConfigMd?: string | null;
}): Promise<Tenant> {
  const result = await pool.query<TenantRow>(
    `INSERT INTO tenants (id, name, subdomain, license_expires_at, twilio_whatsapp_number, twilio_account_sid, twilio_auth_token, answer_config_md)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [
      input.id,
      input.name,
      input.subdomain,
      input.licenseExpiresAt,
      input.twilioWhatsappNumber ?? null,
      input.twilioAccountSid ?? null,
      input.twilioAuthToken ?? null,
      input.answerConfigMd ?? null,
    ]
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

export type LicenseKind = "provisional" | "full";

/** Extends a tenant's licence off the back of a payment.
 *
 * `base` is the moment the payment was made (the order's claim time), NOT the
 * moment confirmation happened. Confirmation can take up to three days, and
 * measuring from it would hand out 30-33 days depending on how quickly someone
 * got to the admin queue. Anchored to the payment, every tenant's month is the
 * same length and the provisional days are absorbed rather than added on top.
 *
 * The arithmetic is Postgres's `interval '1 month'`, which is calendar-correct
 * where JavaScript's setMonth is not: 31 January + 1 month is 28 February here,
 * and 3 March in JS.
 *
 * greatest() makes this monotonic - a grant can only ever push the expiry
 * further out. That is what keeps the two-step claim-then-confirm path honest:
 * the 3-day provisional grant lands first, the full month replaces it, and a
 * replayed or out-of-order confirmation cannot shorten a live licence. */
export async function grantLicense(
  tenantId: string,
  kind: LicenseKind,
  base: Date
): Promise<string> {
  if (tenantId === PROTECTED_TENANT_ID) throw new DefaultTenantProtectedError();
  const interval = kind === "full" ? "1 month" : `${PROVISIONAL_DAYS} days`;
  const result = await pool.query<{ license_expires_at: string }>(
    `UPDATE tenants
        SET license_expires_at = greatest($2::timestamptz + $3::interval, license_expires_at)
      WHERE id = $1 AND archived_at IS NULL
      RETURNING license_expires_at`,
    [tenantId, base.toISOString(), interval]
  );
  if (result.rows.length === 0) throw new TenantNotFoundError(tenantId);
  return result.rows[0].license_expires_at;
}

/** Ends a tenant's licence now. Used when a payment is confirmed NOT to have
 * arrived, so a rejected claim stops the agent immediately instead of running
 * out the rest of its provisional days. */
export async function expireLicenseNow(tenantId: string): Promise<void> {
  if (tenantId === PROTECTED_TENANT_ID) throw new DefaultTenantProtectedError();
  await pool.query(
    "UPDATE tenants SET license_expires_at = now() WHERE id = $1 AND archived_at IS NULL",
    [tenantId]
  );
}

export function isLicenseExpired(licenseExpiresAt: string | null): boolean {
  return !!licenseExpiresAt && new Date(licenseExpiresAt) <= new Date();
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

export async function updateTenantAnswerConfig(
  id: string,
  answerConfigMd: string | null
): Promise<Tenant> {
  const result = await pool.query<TenantRow>(
    `UPDATE tenants SET answer_config_md = $2 WHERE id = $1 AND archived_at IS NULL RETURNING *`,
    [id, answerConfigMd]
  );
  if (result.rows.length === 0) throw new TenantNotFoundError(id);
  return mapRow(result.rows[0]);
}

/** Resolves the tenant whose voice agent owns a dialed number. This is what
 * makes one voice worker serve every tenant - it is the same lookup pattern as
 * getTenantByWhatsappNumber, just for the voice channel and without a wire
 * prefix. Archived tenants are excluded so a decommissioned number stops
 * answering rather than serving a dead tenant's knowledge base. */
export async function getTenantByVoiceNumber(voicePhoneNumber: string): Promise<Tenant | null> {
  if (!voicePhoneNumber) return null;
  const result = await pool.query<TenantRow>(
    "SELECT * FROM tenants WHERE voice_phone_number = $1 AND archived_at IS NULL",
    [voicePhoneNumber]
  );
  return result.rows.length > 0 ? mapRow(result.rows[0]) : null;
}

/** Null clears the number, freeing it for another tenant. */
export async function updateTenantVoiceNumber(
  id: string,
  voicePhoneNumber: string | null
): Promise<Tenant> {
  const result = await pool.query<TenantRow>(
    `UPDATE tenants SET voice_phone_number = $2 WHERE id = $1 AND archived_at IS NULL RETURNING *`,
    [id, voicePhoneNumber]
  );
  if (result.rows.length === 0) throw new TenantNotFoundError(id);
  return mapRow(result.rows[0]);
}

/** Both null clears back to "use the platform's global Twilio account";
 * both-or-neither is enforced by the caller (the route handler), since a
 * lone Account SID with no Auth Token (or vice versa) can't validate or
 * send anything. */
export async function updateTenantTwilioCredentials(
  id: string,
  accountSid: string | null,
  authToken: string | null
): Promise<Tenant> {
  const result = await pool.query<TenantRow>(
    `UPDATE tenants SET twilio_account_sid = $2, twilio_auth_token = $3 WHERE id = $1 AND archived_at IS NULL RETURNING *`,
    [id, accountSid, authToken]
  );
  if (result.rows.length === 0) throw new TenantNotFoundError(id);
  return mapRow(result.rows[0]);
}
