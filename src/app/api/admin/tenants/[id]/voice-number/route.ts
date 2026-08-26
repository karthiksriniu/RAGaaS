import { NextRequest, NextResponse } from "next/server";
import { isAdminSession } from "@/lib/adminAuth";
import {
  assertTenantExists,
  updateTenantVoiceNumber,
  TenantNotFoundError,
} from "@/lib/tenants";
import {
  listInventoryNumbers,
  provisionNumber,
  VobizError,
  VobizNotConfiguredError,
} from "@/lib/vobiz";
import { addNumberToPool, assignNumberToTenant, releaseNumber } from "@/lib/numberPool";

export const runtime = "nodejs";

// Provisions a phone number for a tenant: buys it from Vobiz, points it at the
// shared LiveKit trunk, and records it against the tenant so the voice worker
// can resolve calls to that number.
//
// Admin-gated today because onboarding is still manual. The same two functions
// are what a self-service signup flow will call - which is the entire reason
// the LiveKit path was chosen: no step here needs a human in any dashboard.

/** GET — available numbers to choose from. */
export async function GET(req: NextRequest) {
  if (!isAdminSession(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const country = req.nextUrl.searchParams.get("country") || "IN";
  const search = req.nextUrl.searchParams.get("search") || undefined;

  try {
    return NextResponse.json({ numbers: await listInventoryNumbers(country, search) });
  } catch (err) {
    if (err instanceof VobizNotConfiguredError) {
      return NextResponse.json({ error: err.message }, { status: 503 });
    }
    if (err instanceof VobizError) {
      return NextResponse.json({ error: err.message, detail: err.body }, { status: 502 });
    }
    throw err;
  }
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  if (!isAdminSession(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await ctx.params;
  let body: { e164?: string; alreadyOwned?: boolean };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const e164 = typeof body.e164 === "string" ? body.e164.trim() : "";
  if (!/^\+[1-9]\d{7,14}$/.test(e164)) {
    return NextResponse.json(
      { error: "e164 must be a phone number in international format, e.g. +918071582575" },
      { status: 400 }
    );
  }

  try {
    const tenant = await assertTenantExists(id);

    // Refuse rather than silently buying a second number and stranding the
    // first, which would keep billing with nothing routing to it.
    if (tenant.voicePhoneNumber && tenant.voicePhoneNumber !== e164) {
      return NextResponse.json(
        {
          error: `Tenant already has voice number ${tenant.voicePhoneNumber}. Clear it before provisioning another.`,
        },
        { status: 409 }
      );
    }

    // alreadyOwned covers numbers obtained outside this flow - the existing
    // Sarvam-rented number, or one bought directly in the Vobiz console. It
    // only records the mapping, and deliberately skips purchase and trunk
    // assignment so we can't be billed twice for the same number.
    if (!body.alreadyOwned) {
      await provisionNumber(e164);
    }

    // Record it in the pool as well as on the tenant. This route predates the
    // pool and used to write only tenants.voice_phone_number, so a number
    // bought here was invisible to signup - which could then hand the SAME
    // number to a second business while calls still routed to the first.
    await addNumberToPool(e164);
    await assignNumberToTenant(e164, id);

    const updated = await assertTenantExists(id);
    return NextResponse.json({
      tenant: updated,
      provisioned: !body.alreadyOwned,
    });
  } catch (err) {
    if (err instanceof TenantNotFoundError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    if (err instanceof VobizNotConfiguredError) {
      return NextResponse.json({ error: err.message }, { status: 503 });
    }
    if (err instanceof VobizError) {
      // 502: the failure is upstream at the carrier, not the caller's fault.
      // The body is passed through because Vobiz's messages are specific
      // (insufficient balance, number already taken) and an admin needs them.
      return NextResponse.json({ error: err.message, detail: err.body }, { status: 502 });
    }
    // Unique-constraint violation: another tenant already claims this number.
    if (typeof err === "object" && err !== null && (err as { code?: string }).code === "23505") {
      return NextResponse.json(
        { error: "That number is already assigned to another tenant" },
        { status: 409 }
      );
    }
    throw err;
  }
}

/** DELETE — unassigns the number from the tenant. Deliberately does NOT release
 * it at Vobiz: releasing is irreversible and the number may need to keep
 * routing while a business is migrated. Release from the Vobiz console. */
export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  if (!isAdminSession(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await ctx.params;
  try {
    const tenant = await assertTenantExists(id);
    // Release in the pool too, or the number stays marked as held and signup
    // will never hand it out again.
    if (tenant.voicePhoneNumber) {
      await releaseNumber(tenant.voicePhoneNumber).catch(() => {});
    }
    return NextResponse.json({ tenant: await updateTenantVoiceNumber(id, null) });
  } catch (err) {
    if (err instanceof TenantNotFoundError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    throw err;
  }
}
