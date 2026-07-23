import { NextRequest, NextResponse } from "next/server";
import { transcribeAudio } from "@/lib/sarvam";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    const incoming = await req.formData();
    const audio = incoming.get("audio");

    if (!audio || !(audio instanceof Blob)) {
      return NextResponse.json({ error: "No audio provided" }, { status: 400 });
    }

    const { transcript, languageCode, language } = await transcribeAudio(audio);

    return NextResponse.json({ transcript, languageCode, language });
  } catch (err) {
    console.error("/api/voice/transcribe failed:", err);
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
