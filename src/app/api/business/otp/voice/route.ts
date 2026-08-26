import { NextRequest } from "next/server";
import { decodeOtpVoiceToken, spokenDigits } from "@/lib/otpVoiceToken";

export const runtime = "nodejs";

// What the caller hears. Vobiz fetches this the instant they pick up, and
// speaks whatever XML comes back.
//
// UNAUTHENTICATED by necessity - Vobiz calls it, and cannot present a session.
// The token is the whole access control: encrypted, authenticated and expiring
// in five minutes, so a URL captured from a log is worthless. It is also why
// nothing here touches the database: there is no lookup to abuse.

function xml(body: string): Response {
  return new Response(`<?xml version="1.0" encoding="UTF-8"?>\n<Response>${body}</Response>`, {
    // text/xml, not application/xml: Vobiz's parser is Plivo-shaped and this is
    // the content type that dialect has always used.
    headers: { "Content-Type": "text/xml; charset=utf-8" },
  });
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("t") || "";
  const payload = decodeOtpVoiceToken(token);

  if (!payload) {
    // Expired or tampered. Say something a person can act on - a caller who
    // hears silence and a hangup assumes the service is broken.
    return xml(
      `<Speak>Sorry, this verification call has expired. Please request a new code. Goodbye.</Speak><Hangup/>`
    );
  }

  const digits = escapeXml(spokenDigits(payload.code));

  // Said twice on purpose, with the lead-in only the first time. Almost nobody
  // is holding a pen when they answer, and a code heard once and missed means
  // the whole call was wasted.
  return xml(
    `<Speak>Hello. Your MyBizCare verification code is. ${digits}</Speak>` +
      `<Speak>Once more. ${digits}</Speak>` +
      `<Speak>Thank you. Goodbye.</Speak>` +
      `<Hangup/>`
  );
}
