import { NextRequest, NextResponse } from "next/server";
import { pool } from "@/lib/db";
import { businessTenantId } from "@/lib/businessAuth";
import {
  assertTenantExists,
  isLicenseExpired,
  TenantNotFoundError,
  updateTenantAnswerConfig,
} from "@/lib/tenants";
import { getBillingConfig, latestOrderForTenant } from "@/lib/billing";
import { tenantChatUrl } from "@/lib/tenantHost";
import { VOICE_PRESETS, resolveVoicePreset } from "@/lib/voicePresets";

export const runtime = "nodejs";

/** The signed-in business's own tenant. Everything is scoped by the tenant id
 * inside the session cookie - never by anything in the request - so a business
 * cannot read or write another's data by changing a payload field. */
export async function GET(req: NextRequest) {
  const tenantId = businessTenantId(req);
  if (!tenantId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const tenant = await assertTenantExists(tenantId);
    const acct = await pool.query<{ mobile: string }>(
      "SELECT mobile FROM business_accounts WHERE tenant_id = $1",
      [tenantId]
    );
    const desc = await pool.query<{
      business_description: string | null;
      website_url: string | null;
      kb_enhancement_status: string | null;
      kb_enhancement_error: string | null;
    }>(
      "SELECT business_description, website_url, kb_enhancement_status, kb_enhancement_error FROM tenants WHERE id = $1",
      [tenantId]
    );
    // Checked on every dashboard load, which is what makes an expired plan
    // impossible to walk past: the dashboard blocks on it and offers renewal.
    const expired = isLicenseExpired(tenant.licenseExpiresAt);
    const lastOrder = await latestOrderForTenant(tenant.id);
    const awaitingConfirmation = lastOrder?.status === "claimed";

    return NextResponse.json({
      tenantId: tenant.id,
      businessName: tenant.name,
      licenseExpiresAt: tenant.licenseExpiresAt,
      // 'provisional' is the honest state between "you said you paid" and "we
      // saw the money": full access, and three days for it to be confirmed.
      licenseState: expired ? "expired" : awaitingConfirmation ? "provisional" : "active",
      planPriceInr: (await getBillingConfig()).priceInr,
      subdomain: tenant.subdomain,
      // Composed server-side: only this process knows the root domain.
      chatUrl: tenantChatUrl(tenant.subdomain),
      mobile: acct.rows[0]?.mobile ?? null,
      description: desc.rows[0]?.business_description ?? null,
      website: desc.rows[0]?.website_url ?? null,
      kbEnhancementStatus: desc.rows[0]?.kb_enhancement_status ?? null,
      kbEnhancementError: desc.rows[0]?.kb_enhancement_error ?? null,
      voicePhoneNumber: tenant.voicePhoneNumber,
      expertPhoneNumber: tenant.expertPhoneNumber,
      answerConfigMd: tenant.answerConfigMd,
      // Resolved rather than raw: a tenant still holding a retired preset id
      // would otherwise match none of the options below and the dashboard would
      // show no voice selected at all, while a real voice answers its calls.
      voicePreset: resolveVoicePreset(tenant.voicePreset).id,
      voicePresets: VOICE_PRESETS.map((p) => ({ id: p.id, label: p.label, description: p.description })),
    });
  } catch (err) {
    if (err instanceof TenantNotFoundError) return NextResponse.json({ error: err.message }, { status: 404 });
    throw err;
  }
}

/** Business name and answer style are editable. Mobile and tenant id are not,
 * per the product spec - the tenant id is in a live URL and every stored chunk. */
export async function PATCH(req: NextRequest) {
  const tenantId = businessTenantId(req);
  if (!tenantId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));

  if (typeof body.businessName === "string") {
    const name = body.businessName.trim();
    if (name.length < 2 || name.length > 80) {
      return NextResponse.json({ error: "Business name must be 2-80 characters" }, { status: 400 });
    }
    await pool.query("UPDATE tenants SET name = $2 WHERE id = $1", [tenantId, name]);
  }

  if (typeof body.voicePreset === "string") {
    // Reject unknown ids rather than storing them: resolveVoicePreset would
    // silently fall back, leaving the dashboard showing a voice the caller
    // never hears.
    if (!VOICE_PRESETS.some((p) => p.id === body.voicePreset)) {
      return NextResponse.json({ error: "Unknown voice preset" }, { status: 400 });
    }
    await pool.query("UPDATE tenants SET voice_preset = $2 WHERE id = $1", [tenantId, body.voicePreset]);
  }

  if (body.answerConfigMd !== undefined) {
    const md = typeof body.answerConfigMd === "string" ? body.answerConfigMd.trim() : "";
    await updateTenantAnswerConfig(tenantId, md || null);
  }

  return NextResponse.json({ ok: true });
}
