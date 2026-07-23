import { NextRequest, NextResponse } from "next/server";
import { after } from "next/server";
import twilio from "twilio";
import { pool } from "@/lib/db";
import { transcribeAudio, translateText, textToSpeech } from "@/lib/sarvam";
import { answerQuestion } from "@/lib/answerQuestion";

export const runtime = "nodejs";
export const maxDuration = 60;

const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// WhatsApp uses single asterisks for bold, not markdown's double asterisks.
function formatForWhatsApp(markdown: string): string {
  return markdown.replace(/\*\*(.+?)\*\*/g, "*$1*");
}

async function downloadTwilioMedia(mediaUrl: string): Promise<Blob> {
  const accountSid = process.env.TWILIO_ACCOUNT_SID || "";
  const authToken = process.env.TWILIO_AUTH_TOKEN || "";
  const auth = Buffer.from(`${accountSid}:${authToken}`).toString("base64");

  const res = await fetch(mediaUrl, {
    headers: { Authorization: `Basic ${auth}` },
  });
  if (!res.ok) {
    throw new Error(`Failed to download WhatsApp media (${res.status})`);
  }
  const contentType = res.headers.get("content-type") || "audio/ogg";
  const buf = await res.arrayBuffer();
  return new Blob([buf], { type: contentType });
}

async function storeAudioAndGetUrl(audioBase64: string, contentType: string): Promise<string> {
  const audioBuffer = Buffer.from(audioBase64, "base64");
  const result = await pool.query<{ id: string }>(
    "INSERT INTO voice_replies (content_type, audio_data) VALUES ($1, $2) RETURNING id",
    [contentType, audioBuffer]
  );
  const id = result.rows[0].id;
  const baseUrl = process.env.APP_BASE_URL;
  return `${baseUrl}/api/whatsapp/audio/${id}`;
}

/** Twilio/WhatsApp can redeliver the same inbound message (retry on a slow
 * ack, or their own at-least-once delivery). Atomically claim the
 * MessageSid so a redelivered message is only ever processed once. */
async function claimMessage(messageSid: string): Promise<boolean> {
  if (!messageSid) return true; // no SID to dedupe on - process it anyway
  const result = await pool.query(
    "INSERT INTO processed_messages (message_sid) VALUES ($1) ON CONFLICT DO NOTHING RETURNING message_sid",
    [messageSid]
  );
  return (result.rowCount ?? 0) > 0;
}

async function handleIncomingMessage(params: URLSearchParams) {
  const from = params.get("From") || ""; // e.g. "whatsapp:+919876543210"
  const numMedia = parseInt(params.get("NumMedia") || "0", 10);
  const mediaUrl = params.get("MediaUrl0");
  const mediaContentType = params.get("MediaContentType0") || "";
  const textBody = params.get("Body")?.trim();
  const messageSid = params.get("MessageSid") || params.get("SmsMessageSid") || "";

  const twilioNumber = process.env.TWILIO_PHONE_NUMBER_WHATSAPP || "whatsapp:+14155238886";

  const claimed = await claimMessage(messageSid);
  if (!claimed) {
    console.warn(`Skipping duplicate delivery of message ${messageSid}`);
    return;
  }

  try {
    let question: string;
    let farmerLanguageCode = "en-IN";

    if (numMedia > 0 && mediaUrl && mediaContentType.startsWith("audio")) {
      const audioBlob = await downloadTwilioMedia(mediaUrl);
      const transcription = await transcribeAudio(audioBlob, "voice-note.ogg");
      question = transcription.transcript;
      farmerLanguageCode = transcription.languageCode || "en-IN";

      if (!question) {
        await twilioClient.messages.create({
          from: twilioNumber,
          to: from,
          body: "Sorry, I couldn't make out that voice note. Could you try again, speaking clearly?",
        });
        return;
      }
    } else if (textBody) {
      question = textBody;
    } else {
      await twilioClient.messages.create({
        from: twilioNumber,
        to: from,
        body: "Send a voice note or a text message with your question about crops, pests, or diseases.",
      });
      return;
    }

    const result = await answerQuestion(question);

    // Translate the short voice summary back to the farmer's spoken language, then synthesize it.
    const translatedSummary = await translateText(result.voiceSummary, farmerLanguageCode);
    const speech = await textToSpeech(translatedSummary, farmerLanguageCode);
    const audioUrl = await storeAudioAndGetUrl(speech.audioBase64, speech.contentType);

    await twilioClient.messages.create({
      from: twilioNumber,
      to: from,
      mediaUrl: [audioUrl],
    });

    let detailText = `*${result.confidenceLabel}*\n\n${formatForWhatsApp(result.answer)}`;
    if (result.escalation.show) {
      const expertPhone = process.env.EXPERT_PHONE_NUMBER;
      detailText += `\n\n⚠️ This needs expert confirmation before you act. Call an agronomist now: ${expertPhone}`;
    }

    await twilioClient.messages.create({
      from: twilioNumber,
      to: from,
      body: detailText,
    });
  } catch (err) {
    console.error("/api/whatsapp/webhook processing failed:", err);
    try {
      await twilioClient.messages.create({
        from: twilioNumber,
        to: from,
        body: "Sorry, something went wrong answering that. Please try again in a moment.",
      });
    } catch (notifyErr) {
      console.error("Failed to notify farmer of processing error:", notifyErr);
    }
  }
}

export async function POST(req: NextRequest) {
  const rawBody = await req.text();
  const params = new URLSearchParams(rawBody);

  const signature = req.headers.get("x-twilio-signature") || "";
  const url = `${process.env.APP_BASE_URL}/api/whatsapp/webhook`;
  const paramsObject = Object.fromEntries(params.entries());

  const isValid = twilio.validateRequest(
    process.env.TWILIO_AUTH_TOKEN || "",
    signature,
    url,
    paramsObject
  );

  if (!isValid) {
    console.warn("Rejected WhatsApp webhook with invalid Twilio signature");
    return new NextResponse("Forbidden", { status: 403 });
  }

  // Ack Twilio immediately; do the actual STT/RAG/TTS/reply pipeline after
  // the response is sent so we're not racing Twilio's webhook timeout.
  after(() => handleIncomingMessage(params));

  return new NextResponse("<Response></Response>", {
    status: 200,
    headers: { "Content-Type": "text/xml" },
  });
}
