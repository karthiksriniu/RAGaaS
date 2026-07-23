import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

const SARVAM_URL = "https://api.sarvam.ai/speech-to-text";

const LANGUAGE_LABELS: Record<string, "English" | "Tamil" | "Malayalam"> = {
  "en-IN": "English",
  "ta-IN": "Tamil",
  "ml-IN": "Malayalam",
};

export async function POST(req: NextRequest) {
  try {
    const incoming = await req.formData();
    const audio = incoming.get("audio");

    if (!audio || !(audio instanceof Blob)) {
      return NextResponse.json({ error: "No audio provided" }, { status: 400 });
    }

    const sarvamForm = new FormData();
    sarvamForm.append("file", audio, "recording.webm");
    sarvamForm.append("model", "saaras:v3");
    sarvamForm.append("mode", "translate"); // always returns English text, regardless of spoken language

    const res = await fetch(SARVAM_URL, {
      method: "POST",
      headers: { "api-subscription-key": process.env.SARVAM_API_KEY || "" },
      body: sarvamForm,
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Sarvam speech-to-text request failed (${res.status}): ${body}`);
    }

    const data = await res.json();
    const languageCode: string | null = data.language_code || null;
    const language = languageCode ? LANGUAGE_LABELS[languageCode] || languageCode : null;

    return NextResponse.json({
      transcript: data.transcript || "",
      languageCode,
      language,
    });
  } catch (err) {
    console.error("/api/voice/transcribe failed:", err);
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
