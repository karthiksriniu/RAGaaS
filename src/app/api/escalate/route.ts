import { NextRequest, NextResponse } from "next/server";
import twilio from "twilio";

export const runtime = "nodejs";

const E164 = /^\+[1-9]\d{7,14}$/;

export async function POST(req: NextRequest) {
  try {
    const { question, farmerPhone } = await req.json();

    if (!farmerPhone || typeof farmerPhone !== "string" || !E164.test(farmerPhone.trim())) {
      return NextResponse.json(
        { error: "Enter a valid phone number in international format, e.g. +919840000000" },
        { status: 400 }
      );
    }
    if (!question || typeof question !== "string") {
      return NextResponse.json({ error: "question is required" }, { status: 400 });
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
      client.calls.create({ to: farmerPhone.trim(), from: twilioNumber, url: farmerUrl }),
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
