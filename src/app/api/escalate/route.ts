import { NextRequest, NextResponse } from "next/server";
import twilio from "twilio";
import { assertTenantLicensed, TenantNotFoundError, TenantExpiredError } from "@/lib/tenants";
import { checkRateLimit, getClientIp } from "@/lib/rateLimit";

export const runtime = "nodejs";

const E164 = /^\+[1-9]\d{7,14}$/;

export async function POST(req: NextRequest) {
  try {
    const { question, farmerPhone, tenantId } = await req.json();

    if (!farmerPhone || typeof farmerPhone !== "string" || !E164.test(farmerPhone.trim())) {
      return NextResponse.json(
        { error: "Enter a valid phone number in international format, e.g. +919840000000" },
        { status: 400 }
      );
    }
    if (!question || typeof question !== "string") {
      return NextResponse.json({ error: "question is required" }, { status: 400 });
    }
    if (!tenantId || typeof tenantId !== "string") {
      return NextResponse.json({ error: "tenantId is required" }, { status: 400 });
    }

    const trimmedPhone = farmerPhone.trim();
    const ip = getClientIp(req);

    // This endpoint places a real, billed phone call to an arbitrary number
    // supplied by the caller - it's the one public endpoint where a missing
    // rate limit is a direct real-world harassment/cost vector, not just a
    // resource-exhaustion concern. Two independent caps: per-IP (general
    // abuse) and per-phone-number (stops repeated calls to one victim number
    // even from a rotating/distributed set of IPs).
    const ipWithinLimit = await checkRateLimit(`escalate:ip:${ip}`, 60_000, 5);
    if (!ipWithinLimit) {
      return NextResponse.json(
        { error: "Too many requests. Please try again in a minute." },
        { status: 429 }
      );
    }
    const phoneWithinLimit = await checkRateLimit(`escalate:phone:${trimmedPhone}`, 60 * 60_000, 3);
    if (!phoneWithinLimit) {
      return NextResponse.json(
        { error: "This number has reached the limit of escalation calls for now. Please try again later." },
        { status: 429 }
      );
    }

    try {
      await assertTenantLicensed(tenantId);
    } catch (err) {
      if (err instanceof TenantNotFoundError || err instanceof TenantExpiredError) {
        return NextResponse.json({ error: err.message }, { status: 403 });
      }
      throw err;
    }

    const baseUrl = process.env.APP_BASE_URL;
    const expertPhone = process.env.EXPERT_PHONE_NUMBER;
    const twilioNumber = process.env.TWILIO_PHONE_NUMBER;
    if (!baseUrl || !expertPhone || !twilioNumber) {
      return NextResponse.json(
        { error: "Escalation is not configured on this deployment." },
        { status: 500 }
      );
    }

    const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

    const room = `agriadvisor-esc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const truncatedQuestion = question.slice(0, 300);

    const farmerUrl = `${baseUrl}/api/voice/conference?room=${encodeURIComponent(room)}&role=farmer`;
    const expertUrl = `${baseUrl}/api/voice/conference?room=${encodeURIComponent(room)}&role=expert&question=${encodeURIComponent(truncatedQuestion)}`;

    const [farmerCall, expertCall] = await Promise.all([
      client.calls.create({ to: trimmedPhone, from: twilioNumber, url: farmerUrl }),
      client.calls.create({ to: expertPhone, from: twilioNumber, url: expertUrl }),
    ]);

    return NextResponse.json({
      ok: true,
      room,
      farmerCallSid: farmerCall.sid,
      expertCallSid: expertCall.sid,
    });
  } catch (err) {
    console.error("/api/escalate failed:", err);
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
