import { NextRequest, NextResponse } from "next/server";
import { isAdminSession } from "@/lib/adminAuth";
import {
  updateTenantLicense,
  updateTenantWhatsappNumber,
  updateTenantTwilioCredentials,
  TenantNotFoundError,
  DefaultTenantProtectedError,
} from "@/lib/tenants";

export const runtime = "nodejs";

const E164 = /^\+[1-9]\d{7,14}$/;

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!isAdminSession(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;

  try {
    const { licenseExpiresAt, whatsappNumber, twilioAccountSid, twilioAuthToken } = await req.json();

    if (
      licenseExpiresAt === undefined &&
      whatsappNumber === undefined &&
      twilioAccountSid === undefined &&
      twilioAuthToken === undefined
    ) {
      return NextResponse.json(
        { error: "licenseExpiresAt, whatsappNumber, or twilioAccountSid/twilioAuthToken is required" },
        { status: 400 }
      );
    }

    let tenant;
    if (licenseExpiresAt !== undefined) {
      if (licenseExpiresAt !== null && isNaN(Date.parse(licenseExpiresAt))) {
        return NextResponse.json({ error: "licenseExpiresAt must be a valid date" }, { status: 400 });
      }
      tenant = await updateTenantLicense(id, licenseExpiresAt);
    }

    if (whatsappNumber !== undefined) {
      if (whatsappNumber !== null && !E164.test(String(whatsappNumber).trim())) {
        return NextResponse.json(
          { error: "whatsappNumber must be in international format, e.g. +14155238886" },
          { status: 400 }
        );
      }
      const normalized = whatsappNumber ? `whatsapp:${String(whatsappNumber).trim()}` : null;
      tenant = await updateTenantWhatsappNumber(id, normalized);
    }

    if (twilioAccountSid !== undefined || twilioAuthToken !== undefined) {
      const sid = twilioAccountSid ? String(twilioAccountSid).trim() : null;
      const token = twilioAuthToken ? String(twilioAuthToken).trim() : null;
      if ((sid && !token) || (!sid && token)) {
        return NextResponse.json(
          { error: "twilioAccountSid and twilioAuthToken must be provided together (or both cleared)" },
          { status: 400 }
        );
      }
      tenant = await updateTenantTwilioCredentials(id, sid, token);
    }

    return NextResponse.json({ tenant });
  } catch (err) {
    if (err instanceof TenantNotFoundError) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    if (err instanceof DefaultTenantProtectedError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    const pgErr = err as { code?: string; constraint?: string };
    if (pgErr.code === "23505") {
      return NextResponse.json(
        { error: "That WhatsApp number is already assigned to another tenant" },
        { status: 409 }
      );
    }
    console.error("/api/admin/tenants/[id] PATCH failed:", err);
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
