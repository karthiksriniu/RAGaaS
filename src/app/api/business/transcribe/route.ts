import { NextRequest, NextResponse } from "next/server";
import { transcribeAudio } from "@/lib/sarvam";
import { checkRateLimit, getClientIp } from "@/lib/rateLimit";

export const runtime = "nodejs";
// A minute of speech transcribes in a few seconds, but a cold start plus a
// slow mobile upload can stack up.
export const maxDuration = 60;

// Speech-to-text for the "describe your business out loud" button at signup.
//
// UNAUTHENTICATED by necessity: it is used before an account exists. That makes
// it the one route on this service a stranger can make spend money, so it is
// rate limited by IP and capped by size, and it does nothing but return text -
// no writes, no tenant lookup, nothing reachable by changing a field.
//
// Sarvam is called in translate mode (see transcribeAudio), so an owner who
// describes their business in Tamil or Hindi gets usable English back. That is
// what the knowledge-base generator downstream needs, and it means the voice
// option is not quietly English-only.

/** ~2 minutes of Opus at typical browser bitrates. Long enough for anyone
 * describing their business; short enough that the request cannot be used to
 * push large payloads through us. */
const MAX_AUDIO_BYTES = 5_000_000;

const RATE_WINDOW_MS = 60 * 60 * 1000;
const RATE_MAX = 20;

export async function POST(req: NextRequest) {
  const ip = getClientIp(req);
  if (!(await checkRateLimit(`transcribe:${ip}`, RATE_WINDOW_MS, RATE_MAX))) {
    return NextResponse.json(
      { error: "Too many recordings from this connection. Try again later, or type it instead." },
      { status: 429 }
    );
  }

  const formData = await req.formData().catch(() => null);
  const file = formData?.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "No audio received" }, { status: 400 });
  }
  if (file.size === 0) {
    return NextResponse.json({ error: "That recording was empty. Try again." }, { status: 400 });
  }
  if (file.size > MAX_AUDIO_BYTES) {
    return NextResponse.json(
      { error: "That recording is too long. Keep it under about two minutes." },
      { status: 413 }
    );
  }

  try {
    const { transcript, language } = await transcribeAudio(file, file.name || "recording.webm");
    if (!transcript.trim()) {
      return NextResponse.json(
        { error: "We couldn't make out any speech there. Try again somewhere quieter." },
        { status: 422 }
      );
    }
    return NextResponse.json({ transcript: transcript.trim(), language });
  } catch (err) {
    // The upstream message can carry the API key's error body; log it, don't
    // return it. The caller gets something they can act on instead.
    console.error("[transcribe] failed:", err);
    return NextResponse.json(
      { error: "We couldn't transcribe that. Try again, or type your description instead." },
      { status: 502 }
    );
  }
}
