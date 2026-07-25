import twilio from "twilio";
import { requireEnv } from "./adminSession";

/** Builds a validly-signed synthetic Twilio webhook request against the
 * staging deployment's actual webhook URL and auth token - the same
 * technique used for manual verification earlier in this project. */
export function signWebhookParams(params: Record<string, string>): {
  url: string;
  signature: string;
  body: string;
} {
  const baseUrl = requireEnv("TEST_BASE_URL");
  const authToken = requireEnv("TEST_TWILIO_AUTH_TOKEN");
  const url = `${baseUrl}/api/whatsapp/webhook`;

  const signature = twilio.getExpectedTwilioSignature(authToken, url, params);
  const body = new URLSearchParams(params).toString();
  return { url, signature, body };
}

export async function postSignedWebhook(
  params: Record<string, string>,
  signatureOverride?: string
): Promise<Response> {
  const { url, signature, body } = signWebhookParams(params);
  return fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "X-Twilio-Signature": signatureOverride ?? signature,
    },
    body,
  });
}

export function uniqueMessageSid(): string {
  return `SMtest_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}
